# Portico Watch 视图计划（借鉴 Claude Code agent view）

来源：Claude Code「Manage multiple agents with agent view」（`claude agents`）。两者同构——
都是「并行跑多个 agent、各自隔离在 worktree、人只在需决策时介入」。agent view 的杀手锏是
**一块实时聚合屏**；Portico 当前只有一次性快照（`runs`/`status`/`logs`）。fan-out（compare/split）
越多，缺这块屏越痛。本计划把可借鉴点收敛为 **1 个核心命令 + 4 项小增强**，不逐条造功能。

## 状态映射（直接复用现有 `RunStatus`）

| agent view 分组 | Portico `RunStatus` | watch 分组 |
| --- | --- | --- |
| Ready for review / Needs input（置顶） | `ready` `partial` `conflict` | **需决策**（置顶） |
| Working | `created` `planning` `running` `testing` `reviewing` | **进行中**（标 `[active]`） |
| Completed / Failed / Stopped（折叠） | `applied` `discarded` `failed` `cancelled` | **已结束**（折叠 `… N more`） |

---

## 设计原则（避免冗余）

- **零依赖、无构建是硬约束**：仓库只有 `typescript` + `@types/node` 两个 dev 依赖、Node 原生跑 TS。
  watch 的 TUI **必须手写**（裸 ANSI + `readline` keypress + 定时清屏重绘），**不引入 ink/blessed/blessed-contrib**。
- **不造新数据面**：watch 只读现有 `GET /runs` 折叠列表 + artifacts，操作键复用现有命令 handler，不重写
  apply/discard/cancel/integrate 逻辑。
- **复用现有动作语义**：`apply` 仍要求 tracked tree clean、仍区分单 run / `--child` / `--all`；watch 不放宽 gate。
- **非 TTY 即降级**：stdout 非 TTY（CI/管道）时 watch 退化为一次性快照（等价 `runs`，或 `--json` 数组），保持可脚本化。
- **`watch` 与 `follow` 分工清晰**：`follow`=单 run 事件流（已存在），`watch`=全 run 状态板（新增）。

---

## P0 — `portico watch`（实时状态板）

**命名**：顶层 `portico watch`（动词优先，贴合现有 CLI；`dashboard` 是名词、且暗示重型 UI，过度承诺）。
同时提供 `portico runs --watch` 作复用过滤参数的等价别名，共用同一渲染器。

**命令面**
```
portico watch [--repo .] [--status s1,s2] [--to <agent>] [--since <dur>] \
              [--needs-review] [--interval <ms>] [--once] [--json]
```
- `--needs-review`：等价 `--status ready,partial,conflict`（对应 agent view 的 `s:blocked` 快捷过滤）。
- `--to <agent>`：按目标 agent 过滤（对应 `a:<name>`）。
- `--interval`：轮询间隔，默认 2000ms。`--once` / 非 TTY：渲染一帧后退出。

**数据来源**
- 轮询 `GET /runs?repo=&flat=false`（折叠分组），间隔 `--interval`。
- v1 容忍「选中行再拉 `GET /runs/:id`」的 N+1；见下「服务端最小改动」用于消除。

**渲染**
- 三段分组（见状态映射），**需决策置顶**；每段内按最近事件时间倒序。
- 行内容：`name`（P1，缺省回退短 id）· 目标 agent · 彩色 status 徽章 · 改动文件数 · test/verify 结果 · age（复用
  `packages/cli/src/duration.ts`）；group 行附 `children <ready>/<total>`（P1 增强）。
- 顶部汇总行：`3 ready · 1 conflict · 2 active`（对应 agent view 的「N awaiting input」）。
- 已结束段折叠为 `… N more`，`failed` 始终可见（不折叠）。

**操作键**（全部复用现有命令 handler）
| 键 | 动作 | 复用 |
| --- | --- | --- |
| `↑/↓` | 选行 | — |
| `a` | apply（自动按 single/`--child`/`--all` 选语义） | `apply` |
| `d` | discard | `discard` |
| `c` | cancel | `cancel` |
| `f` | follow（切入单 run 事件流） | `logs --follow` |
| `r` | review（group） | `review` |
| `i` | integrate（group） | `integrate` |
| `enter` | peek：状态 + 末事件 + diffstat + 未满足 guard | `status` / `review --summary` |
| `q`/`esc` | 退出 | — |
- 危险动作（`a`/`d`/`c`）二次确认：apply 确认环节**只显示一行 guard 校验**（clean tree / policy / tests 是否满足），
  确认即 apply，不展开完整 review summary（要看完整摘要走 `enter` peek）。`apply` 失败（tree 不 clean 等）就地回显
  既有可粘贴命令，不静默吞。

**实现落点**
- 新增 `packages/cli/src/commands/watch.ts` + `packages/cli/src/tui/`（裸 ANSI 渲染 + keypress 派发）。
- `index.ts` 注册 `case "watch"`；`runs.ts` 识别 `--watch` 转发到同一渲染器。

---

## P1 — run 命名（`--name` / 自动 slug）

`run_20260617143454_65d33c76` 无法扫读。agent view 从 prompt 自动起名并允许 `Ctrl+R` 改名。
- `delegate --name "<slug>"`；写入 run 记录 / `task.json`；`runs`/`watch`/`status` 优先显示。
- 无 `--name` 时**纯截断 task** 派生短 kebab slug（取前 N 词，零模型调用、零延迟）。child 已有 `label`，顶层新增
  `name?` 字段对齐语义。
- 落点：`packages/orchestrator/src/types.ts` run 记录加 `name?`；delegate 请求 + flag；各列表渲染。

## P1 — group `done/total` 进度

对应 agent view 并行工作的 `2/5`。`runs`（折叠）与 `watch` 的 group 行显示 `children <ready>/<total>`。
数据已在 `RunDetails.group.children`，零额外成本。

## P0 — 状态变更通知（纳入 P0 验收）

detached run 翻到 `ready`/`failed`/`conflict` 时发 OS 通知，让 detach 工作流一次到位。
- `delegate --detach --notify`，或 `watch --notify` 在状态迁移时推送。
- 零依赖：darwin `osascript`（首期仅 darwin），缺工具即静默跳过。
- 验收点：detached run 到终态触发一次系统通知，标题含 run name + 新状态。

## P2 — 顶部待审汇总 / detach 退出提示

- `runs` header + `watch` header 输出 `3 ready · 1 conflict · 2 active`。
- `delegate --detach` 退出时打印同一行（衔接 feedback-improvements 的 2.1 SIGINT 提示）。

---

## 服务端最小改动（消除 watch 的 N+1，可选）

`GET /runs` 每行附：`phase`（= `run.status`）、`lastEvent { type, ts }`（读 events 末行，`status` 已有此逻辑）、
group 的 `childrenReady` / `childrenTotal`。让状态板一次轮询即可成屏，无需逐行再拉 `status`。
v1 可先不做、容忍 N+1。

---

## 优先级与分期

| 期 | 项 | 理由 |
| --- | --- | --- |
| **P0** | `portico watch` 状态板（分组/汇总行/操作键，apply 仅一行 guard 校验）、`--detach --notify` | agent view 精华 + detach 一次到位 |
| **P1** | `--name`/截断 slug、group `done/total` | 让状态板可扫读、群进度可见 |
| **P2** | 顶部汇总行、detach 退出提示、`--to`/`--needs-review` 过滤、服务端 `GET /runs` 富化（消 N+1） | 自动化摩擦与性能优化 |
| **P3** | sessions 与 runs 合一视图 | 见下「明确不做（本期）」 |

## 明确不做

- **不引入 TUI 框架**（ink/blessed/...）——破坏「零依赖、无构建」原则。
- **不做远程/云面板**——phase-one 边界外。
- **watch 不引入新持久状态**——纯读 daemon + artifacts。
- **不放宽 apply gate**——watch 里 apply 仍要求 clean tracked tree。
- **sessions（`/chat`）与 runs（`/delegate`）合并为一张表**——概念有意思但属 phase-two，本期 watch 只覆盖 runs。

## 已定决策

1. **命名**：`portico watch`（顶层动词命令）+ `runs --watch`（复用过滤的等价别名），共用渲染器；不用 `dashboard`。
2. **TUI 技术**：手写裸 ANSI + readline keypress，零新依赖；非 TTY 降级为一次性快照 / `--json`。
3. **刷新与数据来源**：**轮询（默认 2s）GET /runs，选中行才 N+1 拉 `status`**；先把状态板跑起来。SSE 不做；
   服务端 `GET /runs` 富化（lastEvent/进度，消 N+1）推后到 P2，非阻塞。
4. **操作键 / apply 确认**：全部委派现有命令 handler，watch 不重写动作逻辑、不放宽 gate；apply 确认**只显示一行
   guard 校验**，不展开完整 review summary。
5. **run 命名**：无 `--name` 时**纯截断 task** 生成 slug，零模型调用。
6. **通知**：`--detach --notify` **纳入 P0 验收**；opt-in、首期仅 darwin（`osascript`）、缺工具即静默。

> 上一轮的 5 个待解问题已全部定稿，并入上表（刷新机制→轮询+N+1；apply 确认→一行 guard；slug→纯截断；
> 通知→进 P0；服务端富化→推后 P2）。
