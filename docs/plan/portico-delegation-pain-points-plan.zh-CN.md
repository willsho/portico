# Portico 委派痛点改进计划

来源：一次真实的中文文档同步任务。任务本身只是把 README、docs 和 Skill 的中文版对齐到英文版，
但实际耗时主要消耗在 Portico orchestration、agent 运行、fan-in、报告判读和补丁落地上。本计划优先记录
痛点和可观察信号，避免过早把所有问题都包装成新功能。

## 背景复盘

这次任务使用 `antigravity` 通过 Portico 执行 fanout。实际过程经历了：

1. `--auto-start` 未能连接 daemon，手动 `portico start` 后发现 daemon 在另一个端口。
2. 第一次使用 `--repo .` 被 daemon 解析到临时目录，agent 在错误仓库里工作。
3. 第二次使用绝对路径后，三路 fanout 真实执行并产出 ready group。
4. ready group 可合并，但人工扫描发现 `packages/skills/portico/SKILL.zh.md` 中有 Unicode 替换字符。
5. 尝试 `--resume` child 修复小问题时，CLI 仍去旧的临时 run store 查找 `run.json`。
6. 重新 clean fanout 后，三个 child 均 ready 且 verify 通过，但 group fan-in 报 conflict。
7. 单运行和更细拆分运行多次出现 ready 但无文件改动，或者 agent 内部超时。
8. 最终采用第一组 ready group apply，再手动修复一处乱码的方式落地。

这说明当前最大成本不在「agent 修改文件」，而在「确认 Portico 产物是否可信、可应用、可继续迭代」。

## 摩擦的两类根因（决定优先级）

代码核对后，本次任务的摩擦其实由两类问题主导，二者成本量级完全不同，必须分开排：

- **正确性（防白跑）**：会导致 agent 白跑或被迫整组重跑的缺陷——错仓库委派（痛点 1）、resume 跑错
  store（痛点 1）、fan-in 冲突无法归因（痛点 4）。一次 fanout 白跑就是 N 个 agent 的时间，是最贵的失败。
- **判读（防误读）**：不会浪费运行、但让人读错产物、被迫人工补查的缺陷——ready 语义、agent 日志噪声、
  无改动 ready、coverage（痛点 2/3/5/6/7/8）。这些多是在**已有报告字段上加标签**，便宜、低风险，
  但杠杆低于正确性类。

排序原则：**先消灭白跑，再降低误读。** 下面每个痛点标注它属于哪一类，并注明哪些能力已在代码中存在。

## 痛点 1（正确性，P0 旗舰）：`--repo` 解析让委派和 resume 跑错仓库

### 现象

- `--auto-start` 失败后，用户需要自己判断 daemon 是否在跑、在哪个端口、当前 CLI 是否连同一个 daemon。
- 使用 `--repo .` 时任务跑进临时目录；错误仓库里的 agent 仍正常运行、生成报告、消耗时间，只有看
  worktree 路径或报告时才发现偏离。fanout 一旦启动，错误被放大成多个 agent 同时白跑。
- resume 小修复时仍去旧的临时 run store 找 `run.json`。

### 根因（已用代码确认，二者同源）

- `resolveRepo` 在 **daemon 进程**里执行 `resolve(repo)`（[orchestrator.ts:2101](../../packages/orchestrator/src/orchestrator.ts#L2101)），
  所以 `--repo .` 这类相对路径按 **daemon 的 cwd** 解析——这就是「跑进临时目录」的全部原因。
- resume 更直接：CLI 构造的 resume URL **根本不带 `?repo=`**
  （[delegate.ts:116](../../packages/cli/src/commands/delegate.ts#L116)），而 status / apply 都带了。daemon 端
  `repoFromUrl` 回退到 `searchParams.get("repo") ?? process.cwd()`
  （[routes.ts:391](../../packages/daemon/src/routes.ts#L391)），于是 resume **永远**用 daemon 自己的 cwd。
  原计划「resume 忽略了传入的绝对 `--repo`」的说法不准确——resume 压根没把 repo 发给 daemon。

### 计划

- **P0**：CLI 侧在发送前把 `--repo` 解析为绝对路径（约 1 行），不再把相对路径交给 daemon。
- **P0**：resume URL 透传 `?repo=`，与 status / apply 一致（约 1 行）。**注意不要**按原计划做「child id 的
  repo 内全局解析」——那是过度设计；正确修法只是把 repo 传过去。
- **P0（旗舰）**：fanout 注册 child **之前**打印并（fanout 时）要求确认 resolved repo 绝对路径、base ref、
  worktree root、daemon URL。这是全计划性价比最高的一条——5 行的 preflight，能在 N 个 agent 启动前
  拦下「错仓库」这个最贵的级联失败。这些字段同时进入 run report。
- **P1**：daemon 连接错误分类（未运行 / 端口不匹配 / 权限沙箱 / repo 不可写）。复用 `portico doctor`
  已有的端口可用性与 discovery 输出，不要另造诊断面。

### 回归测试（验收）

- `--repo .` 在 daemon cwd ≠ 调用方 cwd 时仍解析到调用方仓库。
- resume 在 daemon cwd ≠ 调用方 cwd 时仍命中正确 run store。

## 痛点 2（判读）：fanout 的时间花费不透明

### 现象

- 三路 fanout 的墙钟时间和各 child agent 时间差异大，用户只能从散落事件流和 report 里拼。
- agent 很久没输出时，不清楚是在启动、等权限、读大文件、内部调度还是卡住。

### 现状

- `RunTelemetry` **已有** total / agent / test 三段耗时（[types.ts:196](../../packages/orchestrator/src/types.ts#L196)），
  report **已有** `## Telemetry` 段。所以这条不是从零做，而是**在现有 telemetry 上补桶**。

### 计划

- **P1**：在现有 telemetry 上补齐缺的阶段：worktree setup、diff generation、verify、fan-in。
- **P1**：`watch/status` 显示 child 当前阶段和最后事件时间，避免长时间静默。
- **P1**：group report 增加「重试成本」摘要：总 wall time、各 child agent duration、失败/取消/无改动运行数。

## 痛点 3（判读）：`ready` 不等于用户可以放心 apply

### 现象

- ready group 中仍可能包含文本乱码、语义质量问题或覆盖不完整。
- child ready + verify passed 不保证 group fan-in ready。
- report 的 `ready` 更像流程门禁通过，而不是产物质量可信。

### 现状

- report **已有** `## Gate Warnings` / `## Path Policy` / `## Worktree Changes` / `## Code Tests` /
  `## Verify Checks` 等分段（[orchestrator.ts:2417 起](../../packages/orchestrator/src/orchestrator.ts#L2417)）。
  素材基本齐全，这条主要是**重新标签/分组**，不是补数据。

### 计划

- **P1**：report 明确区分 `Ready to review` 与 `Ready to apply`（文档类任务尤其需要）。
- **P1**：把现有分段归并成「Portico 已检查」与「Portico 未检查」两块，避免 ready 语义被误读。
- **P1**：把 verify 结果提升为一等信息（乱码扫描、链接检查、冲突标记扫描对文档任务最有用）。

## 痛点 4（正确性，P0）：非重叠 child 的 fan-in conflict 无法归因

### 现象

- `portico review` 显示 `overlap: []`，但 fan-in 仍报多个文件 conflict，语义矛盾。
- 冲突列表说了哪些文件，却不能解释为什么一个 child 自己的 patch 不能应用。
- 后续必须手动拆 patch、跑 `git apply --check` / `--3way --check`、逐文件 include/exclude 才定位到 hunk。

### 根因（已用代码确认，是报告/标签缺陷，非 merge 机制 bug）

- `overlap` 与 `conflict` 是**两套定义，从不互相印证**：`overlap` 只按文件名算交集
  （[review.ts:120](../../packages/cli/src/commands/review.ts#L120)）；`conflict` 是 `git apply --3way` 退出码
  （[orchestrator.ts:711](../../packages/orchestrator/src/orchestrator.ts#L711)）。child 在自己独占文件上 apply
  失败时，`overlap` 仍是 `[]`——矛盾源于此。
- `git apply` 的 **stderr 被丢弃**（第 711 行只取 `code`），唯一能解释「为什么」的信息没留下。
- 纯 apply 失败（patch 贴不上）**不产生 unmerged 条目**，代码回退到把该 child 的**整个 `changedFiles`**
  列为 conflict（[orchestrator.ts:714](../../packages/orchestrator/src/orchestrator.ts#L714)）——这就是「非重叠 child
  却报多个文件 conflict」。
- 是否**还**藏着 base-mismatch 的真机制 bug（child patch 贴不回自己的 base），只有先抓 stderr 才能判定。

### 计划

- **P0**：捕获并保存 `git apply` 的 stderr；据此区分两类——overlap 三方合并冲突（有 unmerged 条目）
  vs 纯 patch apply failure（无 unmerged 条目）。
- **P0**：apply failure 时解析首个 `error: patch failed: <file>:<line>`，而不是 dump 整个 child 文件集；
  conflicts.json 记录失败文件、失败 child、首个失败 hunk、各 child diff 的生成 base ref、建议最小重跑范围。
- **P1**：`portico review` 在 overlap 之外增加 `applyCheck` 状态，提前暴露 child patch 是否可应用到 group base。

## 痛点 5（判读）：agent 日志噪声和最终文件状态脱节

### 现象

- antigravity 流式日志多次出现乱码显示，但最终文件可能没有乱码。
- agent 会报告内部子代理、权限申请、超时等，不一定对应 Portico 产物状态。
- 用户必须区分「agent 日志里有问题」和「磁盘文件真的有问题」。

### 计划

- **P0**：final report 弱化 agent 自述，突出 Portico 自己观察到的事实：changed files、diff check、verify、
  policy、apply check。
- **P1**：agent log 非结构化内容保留为 artifact，但默认摘要只引用结构化状态。
- **P1**：对「agent completed but produced no file changes」提升为显著 warning。
  （已实现：该 gate warning 文案已存在，见 [orchestrator.ts:1757](../../packages/orchestrator/src/orchestrator.ts#L1757)，
  此处只需提升其在摘要中的显著度。）

## 痛点 6（判读）：无改动 ready 容易造成误判

### 现象

- 后续全量单运行和窄范围运行都出现 ready、verify passed、changed files none。
- 对「检查类任务」可能合理；对「更新文档」通常代表没有推进。

### 现状

- 无改动**已**触发 gate warning（[orchestrator.ts:1757](../../packages/orchestrator/src/orchestrator.ts#L1757)），
  但 review summary 仍显示 apply 命令。`needs_attention` 这个非二元状态 judge **已在用**
  （[orchestrator.ts:1037](../../packages/orchestrator/src/orchestrator.ts#L1037)），复用即可，别另造。

### 计划

- **P0**：no-change 升为 `needs_attention`。**判定依据用已结构化的 `mode`，不要 parse 任务动词**——
  任务是自由文本、常多句、还经常是中文，动词嗅探太脆。implement 模式 no-change 默认 `needs_attention`；
  review/check 模式或显式 `--expect-no-changes` 不报。
- **P1**：无改动 run 要求 agent 给出「为何无需修改」的结构化理由，单独展示。
- **P1**：group review 中无改动 child 单独分组，避免被 ready child 淹没。

## 痛点 7（判读）：path policy 保证边界，不保证覆盖

### 现象

- path policy passed 只说明没改越界文件，不说明所有目标文件都被检查/同步/正确修改。
- 「同步所有中文文档」任务里 allowed paths 正确但 coverage 仍需人工确认。

### 计划

- **P1**：delegate 支持可选 `--expected-change` / `--expected-touch`，声明预期路径集合。
  （注意：这把枚举工作转嫁给委派方，本身也是摩擦；对 docs sync 可考虑由调用方脚本自动推导
  「有 `*.zh-CN.md` 兄弟的 `*.md`」这类集合，但 Portico 不内建文档引擎。）
- **P1**：report 增加 coverage 段：expected、touched、untouched、unexpected。
- **P2**：对 docs sync 这类任务提供轻量 manifest，能表达覆盖预期，但不做专门文档引擎。

## 痛点 8（判读）：group 产物修补和组合不方便

### 现象

- 第一组 group 可 apply 但有瑕疵；第二组质量更好但 fan-in conflict。
- 单独修复 child 的 patch 基于 HEAD，不能直接替换 group 中的 child 产物。

### 计划

- **P1**：group review 支持标记 child 或文件级别的采用状态，第一阶段只做展示，不自动合成复杂补丁。
- **P2**：提供 `portico patch-stack` 类只读摘要，展示多个 ready run 的文件重叠和应用顺序风险。
- **P2**：apply 前提示「建议先 apply group，再运行/应用小修」这类可审查路径。

## 分期

P0 拆成两档，正确性优先于判读：

| 阶段 | 类别 | 重点 | 目标 |
| --- | --- | --- | --- |
| P0-a | 正确性 | repo 透传(痛点1) + fanout preflight 回显/校验(痛点1) + fan-in 抓 stderr 并区分两类冲突(痛点4) | 不再白跑、不再整组重跑 |
| P0-b | 判读 | agent 自述降权(痛点5) + no-change→needs_attention(痛点6，用 mode) | ready 不被误读 |
| P1 | 判读 | review 信息结构化、telemetry 补桶、coverage/verify 强化 | 减少人工补查和 patch 拆解 |
| P2 | 组合 | 多 run 组合审查、复杂任务覆盖声明 | 让大任务和小修复更稳地协作 |

## 非目标

- 不把所有文档质量问题都做成 Portico 内建规则。
- 不让 `ready` 承诺语义正确，只让它更清楚地表达检查边界。
- 不绕过用户确认自动 apply 复杂 group。
- 不把 agent 非结构化日志当作可信状态源。
- 不为了 fanout 引入新的长期运行调度平台。
- 不为 no-change 判定去 parse 任务自然语言动词（用结构化 `mode`）。

## 验收标准

- `--repo .` 不再因 daemon cwd 被解析到意外仓库（有回归测试）。
- `resume` 在 daemon cwd ≠ 调用方 cwd 时命中正确 run store，失败时打印查找的 run store（有回归测试）。
- 非重叠 child 的 fan-in conflict 能定位到具体 child patch apply failure，并附 `git apply` 真实原因。
- 用户能从一个 group report 中看出时间主要花在 agent、verify 还是 fan-in。
- 无改动 ready 不再和有实质 diff 的 ready 混在一起。
- 文档类任务能通过 verify/coverage 明确展示「检查了什么」和「没检查什么」。
