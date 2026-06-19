# Portico

> Portico 是一个本地代理（Agent）运行时桥接器和委派路由器，适用于 Web、桌面、CLI 以及本地编码代理的工作流。

Portico 允许 Web 应用、Electron 应用、桌面工具或 CLI 通过一个统一接口连接到用户**已经在其机器上安装的** AI 代理（如 Codex、Claude Code 等）。它能发现已安装的代理 CLI，检测版本和能力，通过适配器（adapters）将它们截然不同的调用方式标准化，并将其输出（文本、推理和工具调用）作为一种统一的事件类型进行流式传输。

Portico 还允许本地编码代理通过受控的 localhost 守护进程将任务委派给彼此。委派的工作在隔离的 git 工作树（worktree）中运行，生成持久化的产物（`diff.patch`、`report.md`、`result.json`、`events.ndjson`），可以运行配置的测试，并且在补丁应用回主工作树之前需要用户明确的操作。

这个名字源于建筑学术语：portico（门廊）是外部世界与建筑物内部之间的通道。Portico 就是你的应用与用户的本地代理之间的通道。它**不是**宿主应用，也**不是**代理——它是它们之间的门。

## Portico 是什么，不是什么

**它是**以下方面的基础设施：发现本地代理、抽象其调用、暴露 localhost 守护进程以便浏览器可以访问它们、用于快速集成的小型 SDK，以及用于生成可审查补丁的本地委派工作流。

**它不是**（至少在第一阶段不是）：任务平台、项目/Issue/PR 系统、云编排器、多租户权限系统、代理市场，并且它不绑定任何一个宿主应用的数据模型。

它解决的第一个问题：

> 宿主应用提供上下文和用户消息；Portico 找到合适的本地代理，启动它，并将输出流式传输回来。

它现在还解决的委派问题：

> 一个本地编码代理将有限的任务委派给另一个本地编码代理；Portico 在独立的工作树中运行它，并返回经过测试的可审查补丁。

## 包（Packages）

| 包名 | 适用对象 | 角色 |
| --- | --- | --- |
| `@portico/core` | Node / Electron / CLI | 进程内发现，子进程运行器，统一事件 |
| `@portico/adapters`| 提供商作者 | 各提供商的适配器（generic-cli, codex, claude 等）|
| `@portico/orchestrator` | 本地委派 | 运行存储，工作树，产物，测试，应用/丢弃流程 |
| `@portico/daemon` | Web 应用 / 浏览器 | core 前端的 Localhost HTTP/NDJSON 服务器 |
| `@portico/client` | Web / Electron / Node | `health` / `listAgents` / 流式传输 `chat`，错误处理 |
| `@portico/cli` | 所有人 | 守护进程，发现，委派，运行，应用/丢弃 |

## 要求与设置

- **Node.js 20+**（在 Node 24 上开发）。Portico 的 TypeScript 通过 Node 的原生类型剥离（type stripping）直接运行——**没有构建步骤**。唯一的开发依赖是 `typescript`（类型检查）和 `@types/node`。

```bash
npm install        # links the workspace packages
npm test           # 65 tests across all packages
npm run typecheck  # tsc --noEmit over the monorepo
```

## 快速开始（无需真实的代理）

在 `test/fixtures/fake-agent.mjs` 中提供了一个假代理二进制文件，以便您可以立即测试整个链路。将任何提供商的环境路径指向它：

```bash
export PORTICO_CODEX_PATH="$PWD/test/fixtures/fake-agent.mjs"

# 查看 Portico 发现了什么
npm run portico -- agents

# 启动守护进程
npm run portico -- start --port 8799
```

然后，在另一个终端中：

```bash
curl -s http://127.0.0.1:8799/agents
curl -s -X POST http://127.0.0.1:8799/chat \
  -H 'Content-Type: application/json' \
  -d '{"provider":"codex","messages":[{"role":"user","content":"hello"}]}'
```

您将看到 NDJSON `RuntimeEvent` 的流：`start` → `content` 增量 → `done`。

## CLI

```bash
portico init
portico start [--host h] [--port p] [--lan --token T] [--allow-origin o] [--config path]
portico stop
portico daemon start
portico daemon stop
portico agents [--json]
portico delegate --to <agent> --repo . --task "<task>" [--test "npm test"]
portico delegate --mode review --to <agent> --repo . --task "<review task>"
portico delegate --mode compare --to <agent-a> --compare-to <agent-b> --repo . --task "<task>" --judge-to <agent-c>
portico delegate --mode split --to <agent-a> --repo . --task "<task>" \
  --child '{"to":"codex","task":"backend","allowedPaths":["src/server/**"]}' \
  --child '{"to":"claude","task":"frontend","allowedPaths":["src/web/**"]}'
portico delegate --to <agent-a> --repo . --task "<task>" \
  --child '{"to":"codex","permissionProfile":"auto-edit"}' \
  --child '{"to":"claude","model":"sonnet"}'
portico delegate --resume <child_id> --task "fix the failing tests"
portico runs [--repo .]
portico status <run_id> [--repo .]
portico cancel <run_id> [--repo .]
portico apply <run_id> [--repo .]            # single run (单次运行)
portico apply <group_id> --child <child_id>  # compare: pick one candidate (比较：选择一个候选方案)
portico apply <group_id> --all               # split: apply the merged patch (拆分：应用合并的补丁)
portico discard <run_id> [--repo .]
portico doctor [--config path]
```

`portico doctor` 报告 Node/平台、配置源、登录 shell PATH 恢复、每个提供商的发现情况（路径、版本、状态、不可用原因）、端口可用性以及 CORS/LAN 安全态势。

`portico init` 会创建 `.portico/config.json`、`.portico/runs`、`.portico/worktrees`，以及为 Claude Code 和兼容 Codex 的代理运行时创建本地的 Portico Skill 文件。

## 委派（Delegation）

委派是本地代理路由器路径：Claude Code、Codex 或其他配置的代理要求 Portico 将编码任务交给不同的本地代理。Portico 会创建一个专用的 git 工作树，在那里运行目标代理，捕获日志和事件，生成差异（diff），运行配置的测试，检查受委派者是否更改了工作树外部的文件，记录遥测数据，并将最终决定权留给用户。

初始化一个仓库：

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
portico status run_20260617143454_65d33c76
portico apply run_20260617143454_65d33c76
portico apply <group_id> --child <child_id>
portico discard run_20260617143454_65d33c76
```

每次运行都会在 `.portico/runs/<run_id>/` 下写入产物：

- `task.json` — 原始委派请求
- `events.ndjson` — 完整的委派事件日志
- `agent.ndjson` — 目标代理运行时事件
- `test.log` — 配置的测试命令输出
- `diff.patch` — 从隔离工作树生成的补丁
- `report.md` — 人类可读的摘要、警告、遥测和下一步操作
- `result.json` — 稳定的机器可读运行结果，包括更改的文件、树外更改、门控警告和遥测

工作树位于 `.portico/worktrees/<run_id>/` 下。Portico 会将 `.portico/` 从仓库的本地 git 排除文件中排除，因此产物和工作树不会作为普通项目更改出现。

MVP 中的委派控制：

- 默认最大委派深度为 1；阻止嵌套委派。
- 默认禁止路径包括 `.env`、`.ssh/**`、`node_modules/**`、`dist/**` 和 `build/**`。
- `--allowed` 和 `--forbidden` 在运行准备就绪前约束更改的路径。
- `--isolation worktree|shared` 控制工作区隔离。实现（implement）运行默认为 `worktree`；审查（review）运行默认为 `shared` 加上只读权限配置。
- `--base-ref <ref>` 选择用于隔离工作树的 git 引用（ref）。在可用时，使用 `--base-ref defaultBranch` 从仓库的默认分支派生。
- `--cleanup manual|onNoChanges|onSuccess|always` 控制自动工作树清理。
- `--permission-profile default|read-only|auto-edit` 控制 Portico 是否要求提供商适配器进行自主编辑。共享（shared）的 auto-edit 运行需要干净的工作树，以便 Portico 可以归属生成的差异。
- `--mode compare --compare-to <agent>` 并行运行隔离的**竞争**候选实现（受 `maxConcurrentAgentProcesses` 限制，默认为 4），并记录包含每个候选运行链接的父组报告。使用 `portico apply <group_id> --child <child_id>` 应用其中一个候选方案。
- `--mode split` 将一个任务划分为**互补**的子任务（每个子项必须声明自己的 `task`），并行运行它们，然后将它们的补丁合并到集成工作树中。使用 `portico apply <group_id> --all` 应用合并的补丁。重叠的编辑会将组状态移动到 `conflict`（记录在 `conflicts.json` 中，绝不强制合并）；恢复一个子项以缩小其范围将自动重新合并。
- `--merge none|sequential|integration` 设置扇入合并策略（默认值：compare → `none`，split → `integration`）。
- `--judge-to <agent> [--judge-instruction "..."]` 添加一个可选的只读裁判：对于 compare 模式，它会对候选方案进行排序并记录 `recommendedChildId`；对于 split 模式，它会通过 `approve` / `needs_attention` 结论审查合并结果。裁判永远不会改变应用的语义——依然由您决定。
- `--child '{"to":"agent","permissionProfile":"auto-edit","label":"c1"}'`（可重复）定义异构的子规范，包含每个子项的代理、任务、权限配置、模型、工作量（effort）和路径策略。旧的 `--compare-to` 语法已被规范化为子项。
- `--resume <child_id> --task "new task"` 在其现有工作树中重新运行一个子项以迭代修复，重新生成差异并重新计算组状态（并且，对于 split 组，重新运行扇入合并）。
- 测试命令来自重复的 `--test` 标志或 `.portico/config.json` 中的 `testCommands`。
- 工作树运行在代理运行之前和之后对调用者的主检出（checkout）进行快照。如果 Portico 观察到树外更改，它将标记运行失败，发出 `sandbox_escape_detected` 事件，并在 `result.json` 中记录 `sandboxEscaped` / `outOfTreeChanges`。
- 运行结果包含 `telemetry`，其中包含总耗时、代理耗时和测试耗时。当目标代理报告使用情况时，Portico 会保留原始使用负载，并提取常见的 token 和成本字段。
- `apply` 需要明确的命令，仅应用实现（implement）运行，并在主工作树中被跟踪的文件处于脏状态时拒绝运行。

## 技能（Skills）

这里只有一个规范的技能（Skill），即 [`packages/skills/portico/SKILL.md`](packages/skills/portico/SKILL.md)。
`portico init` 会从中派生出每个代理的变体，因此只需要维护一个主体：

- `.claude/skills/portico/SKILL.md` — 规范的技能，包含 Claude Code 的 `allowed-tools` frontmatter。
- `.agents/skills/portico/SKILL.md` — 相同的技能，但为兼容 Codex 风格的加载器移除了 `allowed-tools` 行。

该技能并未硬编码单一的方向（例如 Claude → Codex）。它告诉当前代理如何编写一个自包含的委派任务，选择明确的 `--to <agent>` 目标（尊重用户指定的代理，否则选择另一个有能力的本地代理），读取运行报告和结果，并与用户一起决定是应用还是丢弃。

## HTTP API（守护进程）

| 方法及路径 | 请求体 | 响应 |
| ------------- | ------------------- | --------------------------------- |
| `GET /health` | – | `{ ok, name, version }` |
| `GET /agents` | – | `{ agents: AgentEntry[] }` |
| `POST /chat` | `ChatRequest` JSON | `application/x-ndjson` 事件流 |
| `POST /delegate` | `DelegateRequest` JSON | `application/x-ndjson` 委派流 |
| `GET /runs?repo=/path&flat=true` | – | `{ runs: Run[] }` (默认折叠) |
| `GET /runs/:id?repo=/path` | – | `RunDetails` (组: + 子项) |
| `GET /runs/:id/events?repo=/path` | – | `application/x-ndjson` 事件历史 |
| `POST /runs/:id/cancel?repo=/path` | – | `RunDetails` (组级联) |
| `POST /runs/:id/apply?repo=/path` | `{ child? }` | `RunDetails` (组需要子项 id) |
| `POST /runs/:id/discard?repo=/path` | – | `RunDetails` (组级联) |
| `POST /runs/:id/resume?repo=/path` | `{ task }` | `application/x-ndjson` 委派流 |
| `POST /reload`| – | `{ agents: AgentEntry[] }` (重新发现) |
| `GET /sessions` | – | `{ sessions: SessionRecord[] }` |
| `DELETE /sessions/:id` | – | `{ ok }` (或 `404`) |

`POST /chat` 每行流式传输一个 JSON 对象。使用结构化协议（例如 Claude Code）的代理会将推理和工具使用作为它们自己的事件呈现：

```json
{"type":"start","sessionId":"…","provider":"claude"}
{"type":"reasoning","delta":"Let me check the file…"}
{"type":"tool_call","name":"Read","input":{"file_path":"package.json"}}
{"type":"tool_result","name":"Read","output":"…"}
{"type":"content","delta":"The answer is…"}
{"type":"done","message":"…full answer…"}
```

`start` 事件的 `sessionId`（也作为 `X-Portico-Session` 响应头返回）是一个延续句柄——将其作为 `ChatRequest.sessionId` 发回以恢复同一对话。请参阅[会话（Sessions）](#会话sessions)。

## 客户端 SDK

浏览器 / 同构（与守护进程通信）：

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

`chat()` 在传输失败时从不抛出异常——它会产生一个终端 `error` 事件，因此当 Portico 未运行时，UI 可以**优雅降级**。`health()` / `listAgents()` 会抛出带类型的 `PorticoClientError`（`code: "unreachable" | "http_error" | "bad_response"`）。

Node，进程内（无守护进程）：

```ts
import { createInProcessClient } from "@portico/client/node";
// or go lower level:
import { discoverAgents, runAgent } from "@portico/core";

const agents = await discoverAgents();
for await (const event of runAgent({ provider: "codex", context, messages })) {
  console.log(event);
}
```

## 会话（Sessions）

**会话**是指与一个代理在一个工作目录中可继续的对话。Portico 默认是无状态的；传递 `sessionId` 可以继续上一轮对话：

- 不带 `sessionId` 的 `/chat` 请求会生成一个句柄，通过 `start` 事件和 `X-Portico-Session` 请求头返回。
- 将该句柄作为 `ChatRequest.sessionId` 发送回去，Portico 将恢复代理自己的会话（例如 `claude --resume`）——它保留了完整的上下文，因此您无需重新发送历史记录。
- 恢复以 `(session, cwd)` 为键，如果上一轮失败则跳过（下一轮将重新开始）。每个会话一次只能运行一次——并发的 `/chat` 将收到 `409`。
- `GET /sessions` 列出记录；`DELETE /sessions/:id` 忘记一条记录。

记录在守护进程的生命周期内存在于内存中（计划中会切换为基于文件的持久化；Codex 恢复尚未接入）。详细信息请参见 [`docs/session-management-plan.md`](docs/session-management-plan.md)。

## 发现（Discovery）

`discoverAgents()` 分层探测，反映了成熟的本地运行时如何在剥离了 GUI 的 `PATH` 中存活：

1. 显式的环境变量路径（`PORTICO_CODEX_PATH`、`PORTICO_GEMINI_PATH`、`PORTICO_ANTIGRAVITY_PATH` 等）
2. `PATH` 查找
3. 登录 shell 回退（fallback）——`$SHELL -lc 'command -v <bin>'`（恢复 Homebrew / fnm / nvm / volta）
4. `<bin> --version` → semver 解析 → 能力注册表

无法解析的版本不会阻止使用：该代理仍为 `available`，并且 `versionStatus: "unknown"`。

## 适配器（Adapters）

每个提供商都实现一个接口；generic-cli 引擎存在于 core 中，因此每个提供商都有一个可用的回退方案。

```ts
export interface AgentAdapter {
  provider: AgentProvider;
  detect?(entry: AgentEntry): Promise<AgentEntry>;
  buildPrompt(request: ChatRequest): Promise<string>;
  run(request: ChatRequest, entry: AgentEntry, context?: RunContext): AsyncIterable<RuntimeEvent>;
}
```

- **generic-cli** — 生成二进制文件，通过 stdin 或 argv 传递渲染的提示，并将 stdout 作为 `content` 进行流式传输。通用的回退方案；目前驱动 `codex`（`codex exec`）、`gemini`（`gemini --prompt <prompt>`）、`antigravity`（`agy -p -`，prompt 走 stdin）和 `opencode`（`opencode run <prompt>`）。
- **stream-json** — 解析 Claude Code 的 `claude -p --output-format stream-json --include-partial-messages`：token 级别的 `content` / `reasoning` 增量、`tool_call` / `tool_result` 事件，以及基于 `--resume` 的会话连续性。驱动 `claude`。
- **codex** — 通过 generic-cli 驱动；其结构化协议和恢复功能在非交互式契约确认稳定之前被推迟。
- **gemini / antigravity / opencode** — 通过 generic-cli 非交互模式驱动。Antigravity 首先作为 `agy` 被发现，然后是 `antigravity`；`PORTICO_ANTIGRAVITY_PATH` 可以固定一个显式的二进制文件。其持久化的 CLI 设置位于 `~/.gemini/antigravity-cli/settings.json` 下，而委派的 auto-edit 模式会传递 `--dangerously-skip-permissions` 作为启动覆盖。
- **openclaw / hermes** — 仅支持发现 + 能力显示；运行以明确的 `adapter_unsupported` 错误结束，而不是挂起在交互式 CLI 上。

使用 `registerAdapter(myAdapter)` 注册您自己的适配器。

## 安全模型（Security model）

- 默认绑定到 `127.0.0.1`。LAN 暴露（`--lan` 或非环回 `--host`）被**拒绝，除非设置了 `--token`**。
- 默认情况下，CORS 允许任意端口上的 `localhost`/`127.0.0.1`；生产源通过 `--allow-origin` 选择加入。
- 子进程运行器强制执行超时看门狗、最大输出上限、通过 `AbortSignal` 取消以及保证进程清理。
- 委派运行在隔离的 git 工作树中执行并在将任何补丁应用到主工作树之前生成产物。Portico 还会检查是否观察到树外写入，如果受委派者修改了调用者的检出，则使该运行失败。
- 委派的 `apply` 永远不会是自动的；它必须由用户触发，并且需要干净的且被跟踪的主工作树。
- Portico 不保存任何宿主应用的机密，也从不读取宿主数据——它仅处理每个请求传递给它的 `context`（或短暂的 `contextUrl`）。

请参阅 [`docs/agent-runtime-library-plan.md`](docs/agent-runtime-library-plan.md) 以获取完整的设计、里程碑和路线图。

## 示例（Examples）

- [`examples/web`](examples/web) — 粘贴一篇文章，选择一个本地代理，并在浏览器中流式传输回答，其中包含实时的推理、工具活动面板和多轮后续对话。运行 `node examples/web/serve.mjs`，然后打开 `http://localhost:5173`。
- [`examples/node-cli`](examples/node-cli) — 运行 `node examples/node-cli ask --provider codex --file context.md`。

## 项目结构（Project layout）

```
packages/{core,adapters,orchestrator,daemon,client,cli} # runtime and delegation packages
packages/skills/portico/SKILL.md                        # unified Portico Skill
examples/{web,node-cli}                                  # runnable integrations
test/fixtures/{fake,edit,escape,split,judge}-agent.mjs   # Agent stand-ins for tests
docs/agent-runtime-library-plan.md                       # runtime plan
docs/portico-delegation-mvp-plan.md                      # delegation MVP plan
```

## 状态（Status）

这包括运行时桥接器 MVP 以及第一个委派 MVP：core + adapters + orchestrator + daemon + client + cli，generic-cli + stream-json 引擎，结构化的 Claude 流式传输（推理 / 工具事件 / token 增量），内存中的会话恢复，隔离的委派工作树，运行产物，测试日志，补丁应用/丢弃，并行的 compare 扇出（有界的代理并发，序列化的工作树簿记），具有沿袭（lineage）角色和聚合状态的组运行模型，每个子项异构的扇出配置，单个子项的恢复/迭代，折叠的运行列表，组的级联取消/丢弃，以及带有扇入合并的拆分任务（集成工作树三方合并，`conflict` 状态，全部应用（apply-all），以及一个可选的与代理无关的裁判）。尚未包括：Web UI，MCP 服务器，云 workers，自动 PR，LAN 配对，基于文件的会话持久化，Codex 恢复，Electron 自动安装程序以及云中继。

MIT 许可证。
