# Portico

> Portico 是一个本地 Agent 运行时桥接器和委派路由器，适用于 Web、桌面、CLI 和本地编码 Agent 工作流。

Portico 允许 Web 应用、Electron 应用、桌面工具或 CLI 连接到用户**已经在其机器上安装的** AI Agent——例如 Codex、Claude Code 等等——通过一个统一的接口。它发现已安装的 Agent CLI，检测版本和能力，在适配器后面规范化它们截然不同的调用方式，并将它们的输出（文本、推理和工具调用）流式传输为一种统一的事件类型。

Portico 还允许本地编码 Agent 通过一个受控的 localhost 守护进程将任务委派给彼此。委派的工作在一个隔离的 git worktree 中运行，生成持久化产物（`diff.patch`、`report.md`、`result.json`、`events.ndjson`），可以运行配置的测试，并且需要显式的用户操作才能将补丁应用回主工作树。

这个名字来源于建筑学术语：portico（门廊）是外部世界和建筑物内部之间的入口。Portico 是你的应用和用户本地 Agent 之间的入口。它**不是**宿主应用，也**不是** Agent——它是它们之间的门。

## Portico 是什么，不是什么

**它是**以下方面的基础设施：发现本地 Agent，抽象它们的调用，暴露 localhost 守护进程以便浏览器可以访问它们，提供用于快速集成的小型 SDK，以及用于生成可审查补丁的本地委派工作流。

**它不是**（至少在第一阶段不是）：任务平台、项目/问题/PR 系统、云编排器、多租户权限系统、Agent 市场，并且它不绑定于任何一个宿主应用的数据模型。

它解决的第一个问题：

> 宿主应用提供上下文和用户消息；Portico 找到合适的本地 Agent，启动它，并将输出流式返回。

它现在也解决的委派问题：

> 一个本地编码 Agent 将一个有界任务委派给另一个本地编码 Agent；Portico 在一个独立的 worktree 中运行它，并返回一个经过测试的、可审查的补丁。

## 包 (Packages)

| 包 (Package)       | 适用对象 (For)          | 角色 (Role)                                                 |
| ------------------ | ----------------------- | ----------------------------------------------------------- |
| `@portico/core`    | Node / Electron / CLI   | 进程内发现、子进程运行器、统一事件 (In-process discovery, child-process runner, unified events)  |
| `@portico/adapters`| 供应商作者 (Provider authors)        | 单个供应商适配器（generic-cli、codex、claude，…） (Per-provider adapters)       |
| `@portico/orchestrator` | 本地委派 (Local delegation)  | 运行存储、worktrees、产物、测试、应用/丢弃流程 (Run store, worktrees, artifacts, tests, apply/discard flow)   |
| `@portico/daemon`  | Web 应用 / 浏览器 (Web apps / browsers)     | 位于 core 前面的 Localhost HTTP/NDJSON 服务器 (Localhost HTTP/NDJSON server in front of core)               |
| `@portico/client`  | Web / Electron / Node   | `health` / `listAgents` / 流式 `chat`、错误处理 (`health` / `listAgents` / streaming `chat`, error handling)  |
| `@portico/cli`     | 所有人 (Everyone)                | 守护进程、发现、委派、运行、应用/丢弃 (daemon, discovery, delegation, runs, apply/discard)          |

## 要求与设置

- **Node.js 20+**（在 Node 24 上开发）。Portico 的 TypeScript 直接通过 Node 的原生类型剥离（native type stripping）运行——**没有构建步骤**。唯一的开发依赖是 `typescript`（用于类型检查）和 `@types/node`。

```bash
npm install        # 链接工作区包
npm test           # 跨所有包的 65 个测试
npm run typecheck  # 在 monorepo 上运行 tsc --noEmit
```

## 快速入门（无需真实的 Agent）

一个伪造的 Agent 二进制文件打包在 `test/fixtures/fake-agent.mjs` 中，因此你可以立即测试整个链路。将任何供应商的 env 路径指向它：

```bash
export PORTICO_CODEX_PATH="$PWD/test/fixtures/fake-agent.mjs"

# 查看 Portico 发现了什么
npm run portico -- agents

# 启动守护进程
npm run portico -- start --port 8799
```

然后，在另一个终端：

```bash
curl -s http://127.0.0.1:8799/agents
curl -s -X POST http://127.0.0.1:8799/chat \
  -H 'Content-Type: application/json' \
  -d '{"provider":"codex","messages":[{"role":"user","content":"hello"}]}'
```

你将看到 `RuntimeEvent` 的 NDJSON 流：`start` → `content` deltas → `done`。

## CLI

```bash
portico init
portico start [--host h] [--port p] [--lan --token T] [--allow-origin o] [--config path]
portico stop
portico daemon start
portico daemon stop
portico agents [--json]
portico delegate --to <agent> --repo . (--task "<task>" | --task-file <path>) [--test "npm test"]
portico delegate --mode review --to <agent> --repo . --task "<review task>"
portico delegate --mode compare --to <agent-a> --compare-to <agent-b> --repo . --task "<task>" --judge-to <agent-c>
portico delegate --mode split --to <agent-a> --repo . --task "<task>" \
  --child '{"to":"codex","task":"backend","allowedPaths":["src/server/**"]}' \
  --child '{"to":"claude","task":"frontend","allowedPaths":["src/web/**"]}'
portico delegate --to <agent-a> --repo . --task "<task>" \
  --child '{"to":"codex","permissionProfile":"auto-edit"}' \
  --child '{"to":"claude","model":"sonnet"}'
portico delegate --resume <child_id> (--task "fix the failing tests" | --task-file feedback.txt)
portico delegate --to <agent> --repo . --task "<task>" --allowed "src/**" --apply-on-ready  # 如果所有检查通过则自动应用
portico delegate --to <agent> --repo . --task "<task>" --detach   # 在 run_start 退出，在后台继续运行
portico delegate --to <agent> --repo . --task "<task>" --detach --notify  # 在终端状态时通过 OS 通知
portico delegate --to <agent> --repo . --task "<task>" --name dark-mode   # 人类可读的运行名称
portico delegate --to <agent> --repo . --task "<task>" --auto-start  # 如果守护进程未运行则启动 loopback 守护进程
portico delegate --follow <run_id>           # 重新附加到一个已分离的运行事件日志
portico runs [--repo .] [--flat] [--status failed,cancelled] [--since 2h] [--watch]
portico watch [--repo .] [--needs-review] [--to <agent>] [--status s1,s2] [--once] [--json]
portico status <run_id> [--repo .]
portico logs <run_id> [--repo .] [--follow]
portico review <group_id> [--ready-only] [--open-diff] [--json]
portico integrate <group_id> [--repo .]      # 将一个组的 ready 子运行合并为一个补丁
portico cancel <run_id> [--repo .]
portico apply <run_id> [--repo .]            # 单个运行
portico apply <group_id> --child <child_id>  # compare 模式：选择一个候选项
portico apply <group_id> --all               # split/integrated 模式：应用合并的补丁
portico discard <run_id> [--repo .]
portico cleanup [--repo .] [--failed] [--older-than 7d] [--purge]  # 回收已完成的 worktree
portico doctor [--config path]
```

`portico doctor` 报告 Node/平台信息、配置来源、登录 shell 的 PATH 恢复、每个供应商的发现情况（路径、版本、状态、不可用原因）、端口可用性以及 CORS/LAN 安全态势。

`portico init` 会创建 `.portico/config.json`、`.portico/runs`、`.portico/worktrees`，以及适用于 Claude Code 和兼容 Codex 的 Agent 运行时的本地 Portico Skill 文件。重新运行它会从规范的捆绑 Skill 刷新那些 Portico 管理的 Skill 文件，而不会覆盖现有的 `.portico/config.json` 或修改其他项目级别的技能。

## 委派 (Delegation)

委派是本地 Agent 路由路径：Claude Code、Codex 或其他配置的 Agent 要求 Portico 将编码任务移交给另一个本地 Agent。Portico 创建一个专用的 git worktree，在其中运行目标 Agent，捕获日志和事件，生成 diff，运行配置的测试，检查代表是否修改了 worktree 之外的文件，记录遥测数据，并将最终决定权留给用户。

初始化仓库：

```bash
portico init
```

启动守护进程：

```bash
portico daemon start
```

委派工作：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Add a dark mode toggle to settings" \
  --test "npm test"
```

检查并决定：

```bash
portico runs
portico runs --flat
portico runs --status failed,cancelled --since 2h
portico status run_20260617143454_65d33c76
portico logs run_20260617143454_65d33c76 --follow
portico apply run_20260617143454_65d33c76
portico apply <group_id> --child <child_id>
portico integrate <group_id>
portico discard run_20260617143454_65d33c76
portico cleanup --failed --older-than 7d
```

每次运行会在 `.portico/runs/<run_id>/` 下写入产物：

- `task.json` — 原始委派请求
- `events.ndjson` — 完整的委派事件日志
- `agent.ndjson` — 目标 Agent 运行时事件
- `test.log` — 配置的测试命令输出
- `diff.patch` — 从隔离的 worktree 生成的补丁
- `report.md` — 人类可读的摘要、警告、遥测数据和后续行动
- `result.json` — 稳定的机器可读运行结果，包括修改的文件、树外修改、门控警告和遥测数据

Worktree 存放在 `.portico/worktrees/<run_id>/` 目录下。Portico 会在仓库的本地 git exclude 文件中排除 `.portico/`，这样产物和 worktree 就不会作为普通的项目修改出现。

MVP 中的委派控制：

- 默认最大委派深度为 1；嵌套委派被阻止。
- 默认禁止路径（forbidden paths）包括 `.env`、`.ssh/**`、`node_modules/**`、`dist/**` 和 `build/**`。
- `--allowed` 和 `--forbidden` 限制在一个运行变为 ready 之前可以修改的路径。
- `--isolation worktree|shared` 控制工作区隔离。implement 运行默认为 `worktree`；review 运行默认为 `shared` 加上 read-only 权限配置文件。
- `--base-ref <ref>` 选择用于隔离 worktree 的 git ref。使用 `--base-ref defaultBranch` 可以从仓库的默认分支（如果可用）拉取分支。
- `--cleanup manual|onNoChanges|onSuccess|always` 控制自动 worktree 清理。
- `--permission-profile default|read-only|auto-edit` 控制 Portico 是否向提供商适配器请求自主编辑权限。共享的 auto-edit 运行需要一个干净的工作树，以便 Portico 可以归属生成的 diff。
- `--mode compare --compare-to <agent>` 并行运行隔离的**竞争**候选实现（受 `maxConcurrentAgentProcesses` 限制，默认为 4），并记录一个包含每个候选运行链接的父组报告。使用 `portico apply <group_id> --child <child_id>` 应用其中一个候选实现。
- `--mode split` 将一个任务划分为**互补**的子任务（每个子任务必须声明自己的 `task`），并行运行它们，然后在集成 worktree 中合并它们的补丁。使用 `portico apply <group_id> --all` 应用合并的补丁。重叠的编辑会将该组移至 `conflict` 状态（记录在 `conflicts.json` 中，从不强制合并）；继续（resuming）一个子任务来缩小其范围将自动重新合并。
- `--merge none|sequential|integration` 设置扇入合并策略（默认值：compare → `none`，split → `integration`）。
- `--judge-to <agent> [--judge-instruction "..."]` 添加一个可选的只读评委：对于 compare，它对候选项进行排名并记录一个 `recommendedChildId`；对于 split，它使用 `approve` / `needs_attention` 结论来审查合并结果。评委永远不会改变 apply 的语义——你仍然是决定者。
- `--child '{"to":"agent","permissionProfile":"auto-edit","label":"c1"}'`（可重复使用）定义包含每个子任务自己的 agent、任务、权限配置文件、模型、工作量和路径策略的异构子规范。旧的 `--compare-to` 语法已被标准化为子任务。
- `--resume <child_id> (--task "new task" | --task-file <path>)` 在现有的 worktree 中重新运行子任务以迭代修复，重新生成 diff 并重新计算组状态（对于 split 组，重新运行扇入合并）。
- 测试命令来自重复的 `--test` 标志或 `.portico/config.json` 中的 `testCommands`。
- Worktree 运行在 Agent 运行前后对调用者的主检出进行快照。如果 Portico 观察到树外修改，它会将该运行标记为 failed，发出一个 `sandbox_escape_detected` 事件，并在 `result.json` 中记录 `sandboxEscaped` / `outOfTreeChanges`。
- 运行结果包含 `telemetry`（总时长、Agent 时长和测试时长）。当目标 Agent 报告用量时，Portico 会保留原始用量有效负载并提取常见的 token 和费用字段。
- `apply` 需要明确的命令，仅应用 implement 运行，并在主工作树中有被追踪的脏文件时拒绝运行。
- `integrate <group_id>` 会根据需要将一个 implement/split 组的 **ready** 子任务合并为一个补丁——这对于那些没有自动合并的 `partial` 组（某些子任务 failed，某些 ready）很有用。如果发生冲突，它会记录冲突的文件、它们的来源子任务以及建议的审查顺序；使用 `apply <group_id> --all` 应用合并结果。Compare 组被拒绝执行此操作（它们的子任务是竞争实现——使用 `--child` 选择一个）。
- `--apply-on-ready`（delegate）仅在所有安全保护都成立时自动应用单个 ready 的运行：明确的 `--allowed` 边界、干净的追踪树、路径策略通过、没有沙箱逃逸，并且所有测试 + verify 检查均为绿色。否则，它会打印未满足的保护措施和审查摘要，并且不应用任何内容。
- `--detach`（delegate）在运行注册后立即返回，并打印其 ID；该运行在守护进程上继续执行。使用 `portico delegate --follow <run_id>`（或 `portico logs <run_id> --follow`）重新附加。
- `--name <slug>`（delegate）设置在 `runs` / `watch` 中显示的人类可读的运行名称（默认为任务的 slug）。子任务保留它们的 `--child` 标签。
- `--notify`（delegate）在运行达到终端状态（`ready` / `partial` / `conflict` / `failed`）时触发操作系统的通知。与 `--detach` 配合使用——脱机的后台监听器会在前台进程退出后投递通知。目前仅支持 macOS；在其他系统上无操作。
- `--auto-start`（delegate）启动一个 loopback 守护进程，如果未运行则重试一次。仅限 loopback——局域网/远程守护进程绝不会自动启动。
- `runs --status <s1,s2>` 和 `runs --since <dur>` 在服务器端过滤列表；有活动 Agent 的运行标记为 `[active]`，并且组行显示 `children <ready>/<total> ready`。`status` 还会报告实时进度（阶段、Agent 是否仍在运行以及最后记录的事件）。
- `watch`（或 `runs --watch`）是一个实时状态面板：它定期轮询运行列表并按状态对运行进行分组——需要决定的（`ready`/`partial`/`conflict`）在顶部，然后是正在处理的，然后是已完成的（较旧的已完成运行折叠到 `… N more` 行；失败的保持可见）。选择一行并按键进行内联操作（`a` 应用，`d` 丢弃，`c` 取消，`f` 跟踪，`r` 审查，`i` 集成，`enter` 状态）；`apply` 首先显示一行保护检查并要求确认。`--needs-review` / `--to <agent>` / `--status` / `--since` 过滤面板。在没有 TTY 的情况下（或使用 `--once` / `--json`），它仅打印一个快照，因此它仍然可以被脚本化。该面板是一个手工编写的 ANSI TUI，没有额外的依赖，并将每个操作委托给现有的命令——它从不放宽门控条件（`apply` 仍然需要干净的追踪树）。
- `cleanup` 回收已完成的运行：默认情况下它只移除 worktree 并保留产物（`report.md` / `diff.patch` / `events.ndjson`）；`--purge` 也会删除产物。默认情况下它针对 failed + cancelled 运行（使用 `--status` 覆盖，使用 `--older-than <dur>` 按年龄限制），并且从不接触 `ready` / `applied` 或进行中的运行。

## 技能 (Skills)

有一个规范的 Skill，[`packages/skills/portico/SKILL.md`](packages/skills/portico/SKILL.md)。`portico init` 从中派生出各个 Agent 的变体，因此只需维护一个主体：

- `.claude/skills/portico/SKILL.md` — 规范的 Skill，包含 Claude Code `allowed-tools` frontmatter。
- `.agents/skills/portico/SKILL.md` — 去掉了 `allowed-tools` 行的同一个 Skill，适用于 Codex 样式的加载器。

重新运行 `portico init` 会从规范的 Skill 刷新这两个由 Portico 管理的输出文件。请将项目特定的指南保留在单独的项目级别技能中，而不是直接编辑生成的 Portico 文件。

该 Skill 没有硬编码单一方向，例如 Claude → Codex。它告诉当前 Agent 如何编写自包含的委派任务，选择明确的 `--to <agent>` 目标（遵循用户命名的目标，否则选择不同的可用本地 Agent），阅读运行的报告和结果，并与用户一起决定应用还是丢弃。

## HTTP API (守护进程)

| 方法和路径 (Method & path) | 请求体 (Body)                | 响应 (Response)                          |
| ------------- | ------------------- | --------------------------------- |
| `GET /health` | –                   | `{ ok, name, version }`           |
| `GET /agents` | –                   | `{ agents: AgentEntry[] }`        |
| `POST /chat`  | `ChatRequest` JSON  | `application/x-ndjson` 事件流 (event stream) |
| `POST /delegate` | `DelegateRequest` JSON | `application/x-ndjson` 委派流 (delegation stream) |
| `GET /runs?repo=/path&flat=true` | – | `{ runs: Run[] }` （默认折叠 / folded by default） |
| `GET /runs/:id?repo=/path` | –      | `RunDetails` （组：+ children / group: + children）  |
| `GET /runs/:id/events?repo=/path` | – | `application/x-ndjson` 事件历史 (event history) |
| `POST /runs/:id/cancel?repo=/path` | – | `RunDetails` （级联取消组 / cascades for groups） |
| `POST /runs/:id/apply?repo=/path` | `{ child? }` | `RunDetails` （组需要 child id / child id for groups） |
| `POST /runs/:id/discard?repo=/path` | – | `RunDetails` （级联丢弃组 / cascades for groups） |
| `POST /runs/:id/resume?repo=/path` | `{ task }` | `application/x-ndjson` 委派流 (delegation stream) |
| `POST /reload`| –                   | `{ agents: AgentEntry[] }` （重新发现 / re-discover） |
| `GET /sessions` | –                 | `{ sessions: SessionRecord[] }`   |
| `DELETE /sessions/:id` | –          | `{ ok }` （或 `404` / or `404`）               |

`POST /chat` 每行流式传输一个 JSON 对象。使用结构化协议的 Agent（例如 Claude Code）会将推理和工具使用作为自己的事件展示：

```json
{"type":"start","sessionId":"…","provider":"claude"}
{"type":"reasoning","delta":"Let me check the file…"}
{"type":"tool_call","name":"Read","input":{"file_path":"package.json"}}
{"type":"tool_result","name":"Read","output":"…"}
{"type":"content","delta":"The answer is…"}
{"type":"done","message":"…full answer…"}
```

`start` 事件的 `sessionId`（也作为 `X-Portico-Session` 响应头返回）是一个延续句柄（continuation handle）——将其作为 `ChatRequest.sessionId` 发回即可恢复同一对话。请参阅 [会话 (Sessions)](#会话-sessions)。

## Client SDK

浏览器 / 同构（isomorphic）（与守护进程通信）：

```ts
import { createPorticoClient } from "@portico/client";

const client = createPorticoClient({ endpoint: "http://127.0.0.1:8787" });
const agents = await client.listAgents();

for await (const event of client.chat({
  provider: "codex",
  context,
  messages: [{ role: "user", content: "Summarize the key risks." }],
})) {
  render(event); // start | content | reasoning | tool_* | error | done
}
```

`chat()` 在传输失败时绝不会抛出异常——它会产生一个最终的 `error` 事件，这样当 Portico 未运行时 UI 可以**优雅地降级**。`health()` / `listAgents()` 会抛出带类型的 `PorticoClientError`（`code: "unreachable" | "http_error" | "bad_response"`）。

Node，进程内（无守护进程）：

```ts
import { createInProcessClient } from "@portico/client/node";
// 或使用更底层的方式：
import { discoverAgents, runAgent } from "@portico/core";

const agents = await discoverAgents();
for await (const event of runAgent({ provider: "codex", context, messages })) {
  console.log(event);
}
```

## 会话 (Sessions)

**会话 (session)** 是在一个工作目录中与一个 Agent 进行的可延续对话。Portico 默认是无状态的；传递一个 `sessionId` 可以继续上一轮对话：

- 没有 `sessionId` 的 `/chat` 请求会生成一个句柄，在 `start` 事件和 `X-Portico-Session` 请求头中返回。
- 将该句柄作为 `ChatRequest.sessionId` 发回，Portico 会恢复 Agent 自身的会话（例如 `claude --resume`）——它保留了完整的上下文，因此你无需重新发送历史记录。
- 恢复由 `(session, cwd)` 键标识，并且当上一轮失败时会被跳过（下一轮从头开始）。一个会话一次只能有一次运行——并发的 `/chat` 会收到 `409`。
- `GET /sessions` 列出记录；`DELETE /sessions/:id` 遗忘一个记录。

记录存在于守护进程生命周期的内存中（支持文件持久化是计划中的切换项；Codex resume 尚未连接）。详见 [`docs/session-management-plan.md`](docs/session-management-plan.md)。

## 发现 (Discovery)

`discoverAgents()` 分层进行探测，反映了成熟的本地运行时如何在剥离了 GUI 的 `PATH` 环境中生存：

1. 显式的 env 路径（`PORTICO_CODEX_PATH`、`PORTICO_GEMINI_PATH`、`PORTICO_ANTIGRAVITY_PATH` 等）
2. `PATH` 查找
3. 登录 shell 降级方案——`$SHELL -lc 'command -v <bin>'`（恢复 Homebrew / fnm / nvm / volta 环境）
4. `<bin> --version` → semver 解析 → 注册表功能

无法解析的版本不会阻止使用：Agent 仍然是 `available` 的，其 `versionStatus: "unknown"`。

## 适配器 (Adapters)

每个提供商实现一个接口；generic-cli 引擎存在于 core 中，所以每个提供商都有可用的降级方案。

```ts
export interface AgentAdapter {
  provider: AgentProvider;
  detect?(entry: AgentEntry): Promise<AgentEntry>;
  buildPrompt(request: ChatRequest): Promise<string>;
  run(request: ChatRequest, entry: AgentEntry, context?: RunContext): AsyncIterable<RuntimeEvent>;
}
```

- **generic-cli** — 生成二进制文件，通过 stdin 或 argv 传递渲染后的提示词，并将 stdout 视为 `content` 流式传输。通用的降级方案；目前驱动 `codex`（`codex exec`）、`gemini`（`gemini --prompt <prompt>`）、`antigravity`（带 stdin 的 `agy -p -`）以及 `opencode`（`opencode run <prompt>`）。
- **stream-json** — 解析 Claude Code 的 `claude -p --output-format stream-json --include-partial-messages`：词元级 `content` / `reasoning` deltas，`tool_call` / `tool_result` 事件，以及基于 `--resume` 的会话连续性。驱动 `claude`。
- **codex** — 通过 generic-cli 驱动；其结构化协议和恢复功能在非交互式契约确认稳定之前被推迟。
- **gemini / antigravity / opencode** — 通过 generic-cli 非交互模式驱动。Antigravity 首先被发现为 `agy`，然后是 `antigravity`；`PORTICO_ANTIGRAVITY_PATH` 可以固定一个显式的二进制文件。它的持久 CLI 设置位于 `~/.gemini/antigravity-cli/settings.json` 下，而委派 auto-edit 模式将 `--dangerously-skip-permissions` 作为启动覆盖传递。
- **openclaw / hermes** — 仅发现和功能显示；运行将以明确的 `adapter_unsupported` 错误结束，而不是挂起在交互式 CLI 上。

使用 `registerAdapter(myAdapter)` 注册你自己的适配器。

## 安全模型 (Security model)

- 默认绑定到 `127.0.0.1`。除非设置了 `--token`，否则**拒绝局域网暴露**（`--lan` 或非环回 `--host`）。
- 默认情况下 CORS 允许任何端口的 `localhost`/`127.0.0.1`；生产环境的 origins 需要通过 `--allow-origin` 显式允许。
- 子进程运行器强制执行超时看门狗、最大输出上限、通过 `AbortSignal` 取消以及保证的进程清理。
- 委派运行在隔离的 git worktree 中执行，并在将补丁应用到主工作树之前生成产物。Portico 还检查观察到的树外修改，如果委派者修改了调用者的检出，它会使运行失败。
- 委派 `apply` 永远不是自动的；它必须由用户触发，并且需要干净的被追踪工作树。
- Portico 不持有任何宿主应用的秘密，也从不读取宿主数据——它仅处理每个请求传递给它的 `context`（或生命周期短的 `contextUrl`）。

完整的架构设计、里程碑和路线图，请参阅 [`docs/agent-runtime-library-plan.md`](docs/agent-runtime-library-plan.md)。

## 示例 (Examples)

- [`examples/web`](examples/web) — 粘贴一篇文章，选择一个本地 Agent，然后在浏览器中实时流式传输答案、推理过程、工具活动面板以及多轮跟进对话。运行 `node examples/web/serve.mjs`，然后打开 `http://localhost:5173`。
- [`examples/node-cli`](examples/node-cli) — `node examples/node-cli ask --provider codex --file context.md`。

## 项目布局 (Project layout)

```
packages/{core,adapters,orchestrator,daemon,client,cli} # 运行时和委派包 (runtime and delegation packages)
packages/skills/portico/SKILL.md                        # 统一的 Portico Skill (unified Portico Skill)
examples/{web,node-cli}                                  # 可运行的集成 (runnable integrations)
test/fixtures/{fake,edit,escape,split,judge}-agent.mjs   # 测试用 Agent 替身 (Agent stand-ins for tests)
docs/agent-runtime-library-plan.md                       # 运行时计划 (runtime plan)
docs/portico-delegation-mvp-plan.md                      # 委派 MVP 计划 (delegation MVP plan)
```

## 状态 (Status)

这包括运行时桥接器 MVP 加上第一个委派 MVP：核心 (core) + 适配器 (adapters) + 编排器 (orchestrator) + 守护进程 (daemon) + 客户端 (client) + 命令行接口 (cli)，generic-cli + stream-json 引擎，结构化的 Claude 流式传输（推理 / 工具事件 / 词元增量），内存会话恢复，隔离的委派 worktree，运行产物，测试日志，补丁应用/丢弃，并行 compare 扇出（受限的 Agent 并发数，串行化的 worktree 簿记），具有谱系角色和聚合状态的分组运行模型，按子任务的异构扇出配置，独立的子任务恢复/迭代，折叠的运行列表显示，组的级联取消/丢弃，以及具有扇入合并功能的任务拆分（集成 worktree 三向合并，`conflict` 状态，apply-all 以及可选的无关于 Agent 的 judge）。目前尚未包括的内容：Web UI、MCP 服务器、云 worker、自动 PR、局域网配对、持久化的会话存储、Codex 恢复支持、Electron 自动安装程序以及云中继。

MIT 许可。
