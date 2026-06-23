<!-- Portico delegation enhancements informed by Claude Code subagent system. -->
<!-- Input: Claude Code subagent docs (definitions/hooks/memory/routing/nesting), current Portico delegation surface. -->
<!-- Output: phased plan for delegate profiles, lifecycle hooks, capability routing, delegation memory, controlled nesting. -->
<!-- Pos: 把 subagent 系统的"声明式可复用"思想借到 Portico，同时守住 Portico 的非交互/产-patch/worktree 隔离边界。 -->

# Portico 借鉴 Subagent 系统的委派增强 开发计划

Status: **planned**

> Claude Code 的 subagent 系统把"派活给另一个 agent"做成了**声明式、可复用、分层、带生命周期**
> 的能力（命名定义文件 + 工具/模型/权限/记忆/hooks + description 自动路由 + 受限嵌套）。Portico
> 的委派今天是**命令式、一次性、扁平**的（每次 `delegate` 在命令行/`--child` JSON 里重报一遍
> target/model/权限/路径/test）。本计划把 subagent 里**真正契合 Portico 的那几条**借过来：委派
> 配置档、生命周期 hooks、能力路由、委派记忆、受控嵌套——同时明确**不借**会破坏 Portico 边界的
> 部分（fork、交互式授权提示）。

## 1. 背景

### 1.1 两套系统的对位

| Subagent 系统（Claude Code） | Portico 当前（委派） | 落差 |
| --- | --- | --- |
| 命名定义文件 `.claude/agents/*.md`：name/description/tools/model/permissionMode/skills/hooks/memory | 无"命名可复用档"。每次 `delegate` 用 flags 或 `--child '{...}'` 现报 | **可复用性 = 0**：reviewer / backend-codex 这类常用组合无法存盘复用、无法进版本库共享 |
| 分层作用域 managed > CLI > project > user > plugin，文档化优先级 | `~/.portico/config.json`（全局）+ env + CLI（`config.ts` 优先级链 CLI>env>file>default），但**只覆盖 daemon/limits，不覆盖"一次委派的画像"** | 缺 user/project 两层"委派画像"的合并 |
| description 驱动**自动委派**（Claude 按描述选 subagent） | `--to <agent>` **必填**；Skill 仅口头提示"选一个不同的有能力的 agent" | 无能力/描述路由，目标全靠人/调用方硬指定 |
| 生命周期 hooks：PreToolUse / PostToolUse / Stop / SubagentStart / SubagentStop（可 exit 2 拦截） | 有**隐式**闸门：apply 守卫、path policy、`sandbox_escape_detected`、`--apply-on-ready` 的 guard 链 | 闸门**写死在代码里**，用户无法插入自定义 preApply/postRun 校验或副作用 |
| `memory:` 持久目录，跨会话累积仓库模式/常见坑 | 仅 `--iterate-from <run_id>` 一次性把上一轮失败摘要塞进 `## Context`；session resume 限单会话 | 无跨 run 的持久"委派记忆" |
| 嵌套 subagent，深度上限 5，最深层移除 Agent 工具 | **默认 max delegation depth = 1，嵌套被直接 block**（README §Delegation） | 委派 agent 无法再分治；lineage（`groupId`/`parentRunId`）已具备但深度被一刀切 |
| `tools` / `disallowedTools` / MCP scoping 细粒度 | 限制面是 path policy + permissionProfile（default/read-only/auto-edit） | 工具级 allow/deny、MCP scoping 未下传给支持的 adapter（如 claude `--disallowedTools`） |
| fork（继承全上下文的旁支） | 无；委派一律 fresh 上下文 + worktree 隔离 | **故意不对齐**（见 §3 非目标） |

### 1.2 现状锚点

- 委派请求/子规格：`DelegateRequest`（`packages/orchestrator/src/types.ts:70`）、`ChildSpec`
  （`types.ts:36`，已含 `permissionProfile`/`model`/`effort`/`allowedPaths`/`forbiddenPaths`）、
  `Run`（`types.ts:115`，已含 `role`/`groupId`/`parentRunId` lineage）。
- 配置与优先级：`DaemonConfig`/`AgentOverride`/`DaemonLimits`（`packages/daemon/src/config.ts`），
  优先级链 **CLI > env > config file > defaults**；`AgentOverride` 现仅 `path`/`enabled`/`idleTimeoutMs`。
- 委派 CLI 入口：`packages/cli/src/commands/delegate.ts`；apply 守卫与 `--apply-on-ready` guard 链、
  judge（`packages/orchestrator/src/verdict.ts`）。
- 已有的"近亲"能力（避免重复造轮子）：`--child '{...}'` 内联异构规格 ≈ subagent 的 `--agents` 内联
  JSON；`--resume`/`--continue` ≈ resume/SendMessage；compare/split fan-out ≈ 并行研究/agent teams；
  `--detach`/`--notify` ≈ background 任务。**这些不在本计划范围**——本计划只补"声明式可复用 + 治理"这一层。

### 1.3 核心判断

Portico 已经有 subagent 系统**运行时**侧的大部分能力（隔离、并行、resume、judge、模型选择）。真正缺的是
**定义层与治理层**：把"一次委派该长什么样"从命令行的瞬时输入，提升为**命名、分层、可版本化、可被 hook
拦截、可累积记忆**的一等对象。这正是 subagent 定义文件 + hooks + memory 的价值，且与 Portico 既有的
worktree/产-patch/非交互边界**正交叠加**，不冲突。

## 2. 目标 / 非目标

**目标**

1. **委派配置档（Delegate Profile）**：命名、分层（user `~/.portico/agents/` + project `.portico/agents/`）、
   可版本化的委派预设，打包 `{to, model, effort, permissionProfile, allowed/forbidden, testCommands,
   idleTimeout, 任务前导/系统提示}`；`delegate --profile <name>` 与 `--child '{"profile":"backend"}'`。
2. **生命周期 hooks**：把隐式闸门变成可声明的 `preLaunch` / `preApply` / `postRun` / `onReady|onFailed`
   命令 hooks；preApply 退出码 2 可**拦截 apply**（复用 subagent 的 stdin-JSON + exit-2 约定）。
3. **能力/描述路由**：`--to auto`（或省略）时，按 agent 能力 + profile 的 `description/when` 自动选目标；
   显式 `--to` 永远是 override。
4. **委派记忆**：`.portico/memory/`（project/local 两 scope）跨 run 累积仓库约定/常见失败，开跑前注入
   `## Context`，把一次性的 `--iterate-from` 泛化成持久知识。
5. **受控嵌套委派**：把深度上限从写死的 1 改为**可配置**（默认仍 1，保守），最深层用 Skill/权限禁止再委派
   （对应 subagent "最深层移除 Agent 工具"）。

**非目标**

- 不做 **fork**：Portico 的隔离价值正来自 fresh 上下文 + worktree；继承全上下文与之相悖。
- 不做**交互式授权提示透传**：Portico 委派是非交互的，授权用 permissionProfile 表达，不引入运行中弹窗。
- 不做 subagent 的 `/agents` 全功能 TUI：`portico watch` 已覆盖 run 侧；profile 侧只需一个薄的
  `portico profiles list/show`。
- 不改 fan-out（compare/split）语义；不动 session 模型。

## 3. 设计约束

1. **无 build step**：Node 原生 type stripping，新增代码须是 erasable-TS。
2. **零新增运行时依赖**：profile 用 JSON/Markdown-frontmatter 解析（已有 init 写 Skill 的 frontmatter 处理可复用）；hooks 用 `child_process` + stdin JSON。
3. **向后兼容**：不传 `--profile`/无 hooks/无 memory/深度仍 1 时，行为与今天**逐字节一致**。
4. **守住边界**：profile/hook **不能放宽**既有 gate——preApply hook 只能**额外拦**，不能让脏树 apply 通过。
5. **adapter-agnostic**：工具级 allow/deny、MCP scoping 仅对**声明支持的 adapter**（claude）下传，其余忽略而非报错。
6. **companion 同步**：凡动 CLI/行为/报告，**同 PR** 更新 `packages/skills/portico/SKILL.md` 与 `docs/` + `README.md`（英文），见 AGENTS.md。

## 4. 分阶段设计

### P1 — 委派配置档（最高杠杆，先做）

- **格式**：`*.md`（YAML frontmatter + 可选 Markdown body 作"系统前导/任务模板"），对位 subagent 定义文件。
  frontmatter 字段：`name`、`description`、`to`、`model`、`effort`、`permissionProfile`、`allowed`、
  `forbidden`、`testCommands`、`idleTimeoutMs`、`disallowedTools?`、`mcpServers?`、`maxDepth?`。
- **分层与优先级**：project `.portico/agents/` 覆盖 user `~/.portico/agents/`；最终生效值仍走既有
  precedence——**CLI flag > profile > config(limits/agent overrides) > default**。新增解析层只在 default
  之上、CLI 之下插入 profile。
- **入口**：`delegate --profile <name>`；`--child '{"profile":"backend","model":"opus"}'`（子级 flag
  覆盖 profile，沿用 ChildSpec 现有覆盖语义）。
- **管理命令**：`portico profiles list`（来源+生效值）、`portico profiles show <name>`；`portico init`
  顺带写 1~2 个示例 profile（如 `reviewer.md` 只读、`implementer.md` auto-edit）。
- **触点**：新增 `packages/core/src/profiles.ts`（发现+合并+校验）；`DelegateRequest`/`ChildSpec` 增可选
  `profile?: string`；`delegate.ts` 在构造请求前解析 profile 注入；`doctor` 增 profile 来源体检。
- **验收**：两个 profile 文件 + 集成测试证明"`--profile reviewer` 等价于一长串 flags"，且 CLI flag 能逐项覆盖。

### P2 — 生命周期 hooks

- **事件**：`preLaunch`（worktree 建好、agent 启动前）、`preApply`（apply 前，**退出码 2 拦截**）、
  `postRun`（终态后，拿 result.json）、`onReady`/`onFailed`（终态分支副作用，如自定义通知）。
- **约定**：hook 命令收 stdin JSON（`run_id`、`repo`、`changedFiles`、`outOfTreeChanges`、`result` 摘要），
  **复用 subagent 文档的 PreToolUse stdin + exit-2 拦截**范式，最低学习成本。
- **配置位置**：`.portico/config.json` 的 `hooks` 段 + profile frontmatter `hooks`（profile 内仅作用于用该
  profile 的 run，对应 subagent frontmatter hooks）。
- **与现有 gate 关系**：preApply hook **追加**在既有 apply 守卫**之后**（约束 §3.4）；把"自定义 lint/安全
  扫描必须过"这类策略从外部插入，而非改 orchestrator 代码。
- **触点**：`packages/orchestrator/src/orchestrator.ts` apply 路径 + run 终态处；新增 `hooks.ts` 执行器
  （超时、stderr 透传、exit-code 语义）。
- **验收**：一个 `preApply` 只读 SQL/敏感词风格的脚本能挡掉 apply（对位文档里的 validate-readonly-query 例子）。

### P3 — 能力/描述路由

- **行为**：`--to auto` 或省略 `--to` 时，router 用 (discovery 能力 + profile `description/when`) 给候选 agent
  打分选一个；命中 0 个则报错列出原因（沿用 doctor 的 why-unavailable 风格）。显式 `--to` / `--child.to` override。
- **范围克制**：先做**规则式**评分（能力标志 + 关键词匹配 + 用户 named 优先），**不**引入 LLM 路由；judge 已是
  独立可选阶段，不耦合进路由。
- **触点**：`packages/core/src/discovery.ts` 暴露能力；新增 `router.ts`；`delegate.ts` 在 `--to` 缺省时调用。
- **验收**：给定一个写测试 + 一个只读审查 profile，router 在 fixture agent 集上稳定选对，且可被 `--to` 覆盖。

### P4 — 委派记忆

- **存储**：`.portico/memory/`（`project` 入库共享）+ `.portico/memory-local/`（`local` 不入库），对位
  subagent `memory: project|local`；每文件一条"仓库约定/常见失败/坑"。
- **注入**：开跑前把相关记忆拼进任务 `## Context`（泛化现有 `--iterate-from` 的一次性摘要拼接）；
  可由 `postRun` hook（P2）在失败后追写一条"lesson"。
- **触点**：`packages/orchestrator` 任务组装处增记忆读取；写侧走 hook 或新增 `portico memory add`（可选，后置）。
- **验收**：连续两次 delegate，第二次的任务 `## Context` 含第一次写入的记忆条目。

### P5 — 受控嵌套委派

- **改动**：`maxDepth` 从写死 1 → 可配置（`config.limits` / profile，**默认仍 1**）；用既有 lineage
  （`parentRunId`/`groupId`）记深度；达 `maxDepth` 时，下发给被委派 agent 的 Portico Skill/权限**禁止再委派**
  （对应 subagent 最深层移除 Agent 工具）。
- **安全**：默认不变（深度 1，嵌套仍 block）；放开是**显式 opt-in**，且每加一层照旧 worktree 隔离 + sandbox-escape 检测。
- **触点**：orchestrator 深度计数与守卫；SKILL.md 增"是否允许再委派"的条件说明。
- **验收**：`maxDepth: 2` 下子 run 能再派一层并各自隔离；`maxDepth: 1`（默认）下嵌套被拒，行为同今天。

## 5. 落地顺序与 companion 同步

1. **P1 先行**（独立、最高 ROI，解锁后续都靠 profile 承载声明）。
2. **P2 hooks**（治理层，preApply 立刻有价值）。
3. **P4 记忆** 与 **P3 路由** 并行（都依赖 P1 的 profile 字段，互不依赖）。
4. **P5 嵌套** 最后（风险最高，默认关，靠 P1/P2 的 maxDepth/守卫兜底）。

每个 PR 内同步：`packages/skills/portico/SKILL.md`（canonical，唯一可编辑源，见
[[portico-skill-single-source]]）、`docs/`（英文：可能新增 `docs/profiles.md`、扩 `docs/delegation.md` /
`isolation-and-permissions.md`）、`README.md`、`portico doctor` 体检项。

## 6. 未解决问题

1. **profile 文件格式**：跟随 subagent 用 `*.md` + YAML frontmatter（与 SKILL.md 解析复用），还是更克制地用纯
   `*.json`？前者亲和 subagent 心智、可带 body 作任务模板；后者无需新 frontmatter 解析。倾向 `*.md`，待确认。
2. **路由要不要进 P 范围**：能力路由（P3）是"锦上添花"还是核心？若团队委派习惯总是显式 `--to`，P3 可降级为 backlog。
3. **记忆注入的隐私/体积边界**：记忆拼进 `## Context` 受现有 40k 字符上限约束吗？是否需要 per-run `--no-memory` 开关？
4. **hooks 失败语义**：`preLaunch`/`postRun`（非 preApply）hook 失败应"硬失败该 run"还是"仅告警继续"？倾向告警继续，preApply 例外（exit 2 = 拦截）。
5. **嵌套深度默认**：放开后默认仍保持 1，靠 profile/flag opt-in 到 2；是否需要全局硬上限（如 subagent 的固定 5）兜底防失控？
