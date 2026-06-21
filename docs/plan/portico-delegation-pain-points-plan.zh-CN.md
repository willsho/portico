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

## 进度快照（截至 PR #14）

图例：✅ 已完成 · 🟡 部分完成 · ⬜ 未开始

**P0-a（正确性）+ P0-b（判读）+ P1（判读）基本完成**；仅余 P2（多 run 组合审查、coverage manifest、`--expected-touch`）未做：

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 痛点 1 · repo 透传（delegate/runs/review/watch/notify） | ✅ | `resolveRepoArg` |
| 痛点 1 · resume 透传 `?repo=` | ✅ | |
| 痛点 1 · fanout preflight 回显 + 确认 + `-y` | ✅ | repo/base/worktree/daemon 回显;base/worktree 早已在 report |
| 痛点 1 · daemon 连接错误分类（P1） | 🟡 | 已有 `classifyFetchError`（未运行/沙箱/超时/DNS）;端口不匹配、repo 不可写、复用 doctor 未做 |
| 痛点 4 · 抓 stderr + 区分 overlap/apply_failure | ✅ | |
| 痛点 4 · 解析首个失败 hunk + conflicts.json 富字段 | ✅ | kind/failingChild/reason/base refs/`file:line`;「建议最小重跑范围」未单列字段 |
| 痛点 4 · `review` 增加 `applyCheck`（P1） | ✅ | finalizeGroup 用 `git apply --check` 逐 child 对 group base 检查;`RunResult.applyCheck`;review/report 展示 `apply ok/FAILS` |
| **P0-b** 痛点 5 · 报告弱化 agent 自述 | ✅ | report 新增 `## Portico Observations`（changed files/diff check/tests/verify/policy/sandbox/review decision）+ 「agent.ndjson 非权威」提示 |
| **P0-b** 痛点 6 · no-change → `needs_attention`（用 mode） | ✅ | `reviewDecision` 结构化字段；implement no-change → `needs_attention`；`--expect-no-changes` 豁免；Review/Next Actions 不再误导 apply |
| 痛点 2 · telemetry 补桶 / watch 阶段 / 重试成本（全 P1） | ✅ | telemetry 补桶 ✅ + 重试成本 ✅ + watch 阶段 ✅（active 行显示 `idle <ago>` 距上次事件;listRuns 透传 `_lastEventAt`;status 早已显示 phase/last event） |
| 痛点 3 · Ready-to-review vs apply / 已检查·未检查 / verify 一等（全 P1） | ✅ | report `## Review` 加 `Readiness`（review-only vs apply）;Observations 重述为「已检查边界、非质量保证」;verify 在 Observations + `## Verify Checks` 一等 |
| 痛点 5 · agent log artifact / no-change warning 提显著度（P1） | ✅ | agent.ndjson 列入报告 Artifacts（标注「非权威」）;no-change 经 P0-b 的 `reviewDecision`/Readiness 已显著 |
| 痛点 6 · 无改动结构化理由 / group 分组（P1） | ✅ | no-change run 报告加 `## Agent's Stated Reason (unverified)`;review 把 no-change child 单独 callout + 显示每 child `decision` |
| 痛点 7 · coverage（`--expected-*` / coverage 段 / manifest） | 🟡 | `--expected-change` + `## Coverage`（expected/touched/untouched/unexpected）+ gap→needs_attention ✅;`--expected-touch`（读取不可观测）与 manifest（P2）未做 |
| 痛点 8 · group 采用标记 / patch-stack / apply 前提示 | ⬜ | |

下一步建议：P0/P1 已落地，余下为 **P2**（痛点 8 多 run 组合审查 / patch-stack、痛点 7 coverage manifest、
`--expected-touch`）——组合类需求，优先级低于已完成的正确性与判读改进，按需再做。

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

- ✅ **P0**：CLI 侧在发送前把 `--repo` 解析为绝对路径（约 1 行），不再把相对路径交给 daemon。
- ✅ **P0**：resume URL 透传 `?repo=`，与 status / apply 一致（约 1 行）。**注意不要**按原计划做「child id 的
  repo 内全局解析」——那是过度设计；正确修法只是把 repo 传过去。
- ✅ **P0（旗舰）**：fanout 注册 child **之前**打印并（fanout 时）要求确认 resolved repo 绝对路径、base ref、
  worktree root、daemon URL。这是全计划性价比最高的一条——5 行的 preflight，能在 N 个 agent 启动前
  拦下「错仓库」这个最贵的级联失败。（base ref / worktree 早已在 run report;preflight 额外回显绝对 repo + daemon URL。）
- 🟡 **P1**：daemon 连接错误分类（未运行 / 端口不匹配 / 权限沙箱 / repo 不可写）。复用 `portico doctor`
  已有的端口可用性与 discovery 输出，不要另造诊断面。
  （现状：`classifyFetchError` 已分未运行 / 沙箱 / 超时 / DNS;端口不匹配、repo 不可写、doctor 复用未做。）

### 回归测试（验收）

- ✅ `--repo .` 在 daemon cwd ≠ 调用方 cwd 时仍解析到调用方仓库。（`resolveRepoArg` 单测 + preflight echo 测试）
- ✅ resume 在 daemon cwd ≠ 调用方 cwd 时仍命中正确 run store。（透传 `?repo=`）

## 痛点 2（判读）：fanout 的时间花费不透明

### 现象

- 三路 fanout 的墙钟时间和各 child agent 时间差异大，用户只能从散落事件流和 report 里拼。
- agent 很久没输出时，不清楚是在启动、等权限、读大文件、内部调度还是卡住。

### 现状

- `RunTelemetry` **已有** total / agent / test 三段耗时（[types.ts:196](../../packages/orchestrator/src/types.ts#L196)），
  report **已有** `## Telemetry` 段。所以这条不是从零做，而是**在现有 telemetry 上补桶**。

### 计划

- ✅ **P1**：在现有 telemetry 上补齐缺的阶段：worktree setup、diff generation、verify（从 testDurationMs 拆出）、
  fan-in（group merge+judge 墙钟）。`RunTelemetry` 新增 `worktreeSetupMs` / `diffMs` / `verifyMs` / `fanInMs`，
  report `## Telemetry` 按存在的桶渲染。
- ✅ **P1**：`watch/status` 显示 child 当前阶段和最后事件时间，避免长时间静默。status 早已显示 phase + last event;
  watch 现在 active 行显示 `idle <ago>`（距上次事件），listRuns 对 in-flight run 透传 `_lastEventAt`（events.ndjson mtime）。
- ✅ **P1**：group report 增加「重试成本」摘要：总 wall time（telemetry 已有）、各 child agent duration（Compare
  Candidates / Split Contributions 列表每行附 `<ms> ms agent`）、no-change 运行数（children 摘要行附 `N no-change`）。

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

- ✅ **P1**：report 明确区分 `Ready to review` 与 `Ready to apply`（`## Review` 新增 `Readiness` 行：review-only
  vs apply;review/check 模式与 needs_attention 一律标 review-only）。
- ✅ **P1**：把现有分段归并成「已检查 / 未检查」语义——`## Portico Observations` 收尾改述为「这些是 Portico 跑的
  检查（边界，非质量保证）：不判断语义正确性/文案质量/链接有效性，用 `--verify` 覆盖」。
- ✅ **P1**：verify 提为一等信息——Observations 单列 Verify 行 + 独立 `## Verify Checks` 段（乱码/链接/冲突标记
  扫描可作为 `--verify` 命令接入）。

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

- ✅ **P0**：捕获并保存 `git apply` 的 stderr；据此区分两类——overlap 三方合并冲突（有 unmerged 条目）
  vs 纯 patch apply failure（无 unmerged 条目）。
- ✅ **P0**：apply failure 时解析首个 `error: patch failed: <file>:<line>`，而不是 dump 整个 child 文件集；
  conflicts.json 记录失败文件、失败 child、首个失败 hunk、各 child diff 的生成 base ref。
  （「建议最小重跑范围」未单列字段——由 `failingChild` + report Next Actions 间接给出。）
- ✅ **P1**：`portico review` 在 overlap 之外增加 `applyCheck` 状态，提前暴露 child patch 是否可应用到 group base。
  finalizeGroup 在 fan-in 时建一个 group base 的临时 worktree，对每个 child 独立跑 `git apply --check`，结果写入
  `RunResult.applyCheck`（applies/reason/failures）。review 显示 `apply ok/FAILS` + 失败原因，group report 候选列表
  附 `apply: ok/FAILS`。与 overlap 互补：child 无文件重叠但 patch 漂移仍会 `apply FAILS`。

## 痛点 5（判读）：agent 日志噪声和最终文件状态脱节

### 现象

- antigravity 流式日志多次出现乱码显示，但最终文件可能没有乱码。
- agent 会报告内部子代理、权限申请、超时等，不一定对应 Portico 产物状态。
- 用户必须区分「agent 日志里有问题」和「磁盘文件真的有问题」。

### 计划

- ✅ **P0（P0-b）**：final report 弱化 agent 自述，突出 Portico 自己观察到的事实：changed files、diff check、verify、
  policy、apply check。report 在 Summary 之后新增 `## Portico Observations` 段（单运行/子运行），汇总 Portico 自测的
  changed files / diff check / tests / verify / path policy / sandbox / review decision，并附「agent.ndjson 是日志、
  非权威状态源」提示（[orchestrator.ts `formatObservations`]）。
- ✅ **P1**：agent log 非结构化内容保留为 artifact（agent.ndjson 一直是 artifact），报告 Artifacts 段现在显式列出它
  并标注「raw agent log — narration, not an authoritative status source」;默认摘要引用 `## Portico Observations`
  的结构化状态。
- ✅ **P1**：对「agent completed but produced no file changes」提升为显著信号——经 P0-b 的 `reviewDecision: needs_attention`
  + `Readiness: Ready to review only` + Next Actions 不引导 apply，已远比单条 gate warning 显著。

## 痛点 6（判读）：无改动 ready 容易造成误判

### 现象

- 后续全量单运行和窄范围运行都出现 ready、verify passed、changed files none。
- 对「检查类任务」可能合理；对「更新文档」通常代表没有推进。

### 现状

- 无改动**已**触发 gate warning（[orchestrator.ts:1757](../../packages/orchestrator/src/orchestrator.ts#L1757)），
  但 review summary 仍显示 apply 命令。`needs_attention` 这个非二元状态 judge **已在用**
  （[orchestrator.ts:1037](../../packages/orchestrator/src/orchestrator.ts#L1037)），复用即可，别另造。

### 计划

- ✅ **P0（P0-b）**：no-change 升为 `needs_attention`。新增结构化 `RunResult.reviewDecision`（`approve` | `needs_attention`），
  由 Portico 观察到的事实推导，不依赖 agent 自述。**判定依据用已结构化的 `mode`，未 parse 任务动词**——
  implement 模式 no-change 默认 `needs_attention`；review/check 模式或显式 `--expect-no-changes`（新增 CLI flag +
  `DelegateRequest.expectNoChanges` + `Run.expectNoChanges`）不报。report 的 `## Review` Decision、`## Portico Observations`
  的 Review Decision、单运行 Next Actions、CLI `--review-summary` 均改用 `reviewDecision`，不再把 no-change ready 误导为 apply。
- ✅ **P1**：无改动 run 单独展示 agent 的理由——报告加 `## Agent's Stated Reason (unverified — for a no-change run)`，
  取 agent 最终消息（截断、明确标注未经核实）。（agent 输出是自由文本，按「自述、非权威」呈现，不强行结构化。）
- ✅ **P1**：group review 中无改动 child 单独分组——`portico review` 给 no-change child 加 `⚠ no file changes` 标记、
  单列「No-change (ready, but produced no file changes …)」callout、摘要行计 `N no-change`，并显示每 child 的 `decision`。

## 痛点 7（判读）：path policy 保证边界，不保证覆盖

### 现象

- path policy passed 只说明没改越界文件，不说明所有目标文件都被检查/同步/正确修改。
- 「同步所有中文文档」任务里 allowed paths 正确但 coverage 仍需人工确认。

### 计划

- ✅ **P1**：delegate 支持 `--expected-change`（可重复），声明预期改动路径集合（`DelegateRequest.expectedChangePaths`
  + `Run.expectedChangePaths`）。`--expected-touch`（声明「读取/考虑」）**未做**——Portico 只能观测 diff，读取不可观测，
  按计划不内建文档引擎。枚举工作仍在委派方（对 docs sync 可由调用方脚本推导路径集合）。
- ✅ **P1**：report 增加 `## Coverage` 段：expected / touched / untouched(gaps) / unexpected。untouched gap 在
  ready implement run 触发 gate warning + `needs_attention`（`evaluateCoverage`，path policy 守边界、coverage 守完整性）。
- ⬜ **P2**：对 docs sync 这类任务提供轻量 manifest，能表达覆盖预期，但不做专门文档引擎。

## 痛点 8（判读）：group 产物修补和组合不方便

### 现象

- 第一组 group 可 apply 但有瑕疵；第二组质量更好但 fan-in conflict。
- 单独修复 child 的 patch 基于 HEAD，不能直接替换 group 中的 child 产物。

### 计划

- ⬜ **P1**：group review 支持标记 child 或文件级别的采用状态，第一阶段只做展示，不自动合成复杂补丁。
- ⬜ **P2**：提供 `portico patch-stack` 类只读摘要，展示多个 ready run 的文件重叠和应用顺序风险。
- ⬜ **P2**：apply 前提示「建议先 apply group，再运行/应用小修」这类可审查路径。

## 分期

P0 拆成两档，正确性优先于判读：

| 阶段 | 状态 | 类别 | 重点 | 目标 |
| --- | --- | --- | --- | --- |
| P0-a | ✅ 已完成 | 正确性 | repo 透传(痛点1) + fanout preflight 回显/校验(痛点1) + fan-in 抓 stderr 并区分两类冲突(痛点4) | 不再白跑、不再整组重跑 |
| P0-b | ✅ 已完成 | 判读 | agent 自述降权(痛点5，`## Portico Observations`) + no-change→needs_attention(痛点6，`reviewDecision` 用 mode + `--expect-no-changes`) | ready 不被误读 |
| P1 | ✅ 基本完成 | 判读 | review 信息结构化(applyCheck/no-change 分组/decision)、telemetry 补桶、coverage/verify 强化、watch idle | 减少人工补查和 patch 拆解 |
| P2 | ⬜ 未开始 | 组合 | 多 run 组合审查、复杂任务覆盖声明 | 让大任务和小修复更稳地协作 |

## 非目标

- 不把所有文档质量问题都做成 Portico 内建规则。
- 不让 `ready` 承诺语义正确，只让它更清楚地表达检查边界。
- 不绕过用户确认自动 apply 复杂 group。
- 不把 agent 非结构化日志当作可信状态源。
- 不为了 fanout 引入新的长期运行调度平台。
- 不为 no-change 判定去 parse 任务自然语言动词（用结构化 `mode`）。

## 验收标准

- ✅ `--repo .` 不再因 daemon cwd 被解析到意外仓库（有回归测试）。
- 🟡 `resume` 在 daemon cwd ≠ 调用方 cwd 时命中正确 run store（已透传，有回归测试）；**失败时打印查找的 run store** 尚未做。
- ✅ 非重叠 child 的 fan-in conflict 能定位到具体 child patch apply failure，并附 `git apply` 真实原因。
- ✅ 用户能从一个 group report 中看出时间主要花在 agent、verify 还是 fan-in（telemetry 按阶段补桶：worktree setup /
  diff / test / verify / fan-in;group 列表附各 child agent duration）。watch/status 的实时阶段显示仍 ⬜。
- ✅ 无改动 ready 不再和有实质 diff 的 ready 混在一起（implement no-change → `reviewDecision: needs_attention`，report/Next Actions/review-summary 不再误导 apply；`--expect-no-changes` 可豁免）。
- ✅ 文档类任务能通过 verify/coverage 明确展示「检查了什么」和「没检查什么」（`--expected-change` + `## Coverage` 段
  展示 touched/untouched/unexpected;Observations 收尾说明「已检查边界、非质量保证」;`--verify` 提一等）。
