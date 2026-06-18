# Portico

> Portico 是一个本地 Agent 运行时桥接层和委派路由器，面向 Web、桌面应用、CLI 和本地代码 Agent 工作流。

Portico 让 Web App、Electron 应用、桌面工具或 CLI 可以通过统一接口连接到用户已经安装在本机上的 AI Agents，例如 Codex、Claude Code 等。它会发现已安装的 Agent CLI，检测版本和能力，用适配器屏蔽不同 Agent 的调用方式，并把它们的输出统一流式转换为同一种事件类型，包括文本、推理内容和工具调用。

Portico 也允许本地代码 Agent 通过受控的 localhost daemon 互相委派任务。被委派的工作会在隔离的 git worktree 中运行，产出可持久保存的工件，例如 `diff.patch`、`report.md`、`result.json` 和 `events.ndjson`；它可以运行配置好的测试，并且只有在用户明确操作后，补丁才会应用回主工作树。

Portico 这个名字取自建筑里的门廊：连接建筑外部与内部的入口。Portico 是你的应用和用户本地 Agents 之间的入口。它不是宿主应用，也不是 Agent 本身，而是二者之间的门。

## Portico 是什么，不是什么

Portico 是一套基础设施，用于发现本地 Agents、抽象它们的调用方式、通过 localhost daemon 让浏览器访问本地 Agents、提供便于集成的小型 SDK，以及支持本地委派工作流来产出可审查补丁。

至少在第一阶段，Portico 不是任务平台、项目/Issue/PR 系统、云编排器、多租户权限系统、Agent 市场，也不绑定任何宿主应用的数据模型。

它首先解决的问题是：

> 宿主应用提供上下文和用户消息；Portico 找到合适的本地 Agent，启动它，并把输出流式传回。

它现在也解决委派问题：

> 一个本地代码 Agent 把有边界的任务委派给另一个本地代码 Agent；Portico 在独立 worktree 中执行任务，并返回经过测试、可审查的补丁。

## Packages

| Package | 适用对象 | 作用 |
| --- | --- | --- |
| `@portico/core` | Node / Electron / CLI | 进程内发现、本地子进程 runner、统一事件 |
| `@portico/adapters` | Provider 作者 | 各 provider 的适配器，例如 generic-cli、codex、claude 等 |
| `@portico/orchestrator` | 本地委派 | Run 存储、worktree、工件、测试、apply/discard 流程 |
| `@portico/daemon` | Web app / 浏览器 | 位于 core 前面的 localhost HTTP/NDJSON server |
| `@portico/client` | Web / Electron / Node | `health`、`listAgents`、流式 `chat` 和错误处理 |
| `@portico/cli` | 所有人 | daemon、发现、委派、runs、apply/discard |

## 环境要求与安装

- **Node.js 20+**，项目开发环境使用 Node 24。
- Portico 的 TypeScript 通过 Node 原生 type stripping 直接运行，**没有构建步骤**。
- 仅有的开发依赖是 `typescript` 和 `@types/node`。

```bash
npm install        # 链接 workspace packages
npm test           # 运行全部 packages 的 65 个测试
npm run typecheck  # 对 monorepo 执行 tsc --noEmit
```

## 快速开始：不需要真实 Agent

仓库中包含一个假的 Agent binary：`test/fixtures/fake-agent.mjs`，可以立即跑通完整链路。把任意 provider 的环境变量路径指向它即可：

```bash
export PORTICO_CODEX_PATH="$PWD/test/fixtures/fake-agent.mjs"

# 查看 Portico 发现了什么
npm run portico -- agents

# 启动 daemon
npm run portico -- start --port 8799
```

然后在另一个终端运行：

```bash
curl -s http://127.0.0.1:8799/agents
curl -s -X POST http://127.0.0.1:8799/chat \
  -H 'Content-Type: application/json' \
  -d '{"provider":"codex","messages":[{"role":"user","content":"hello"}]}'
```

你会看到一串 NDJSON `RuntimeEvent`：`start` → `content` 增量 → `done`。

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
portico delegate --mode compare --to <agent-a> --compare-to <agent-b> --repo . --task "<task>"
portico runs [--repo .]
portico status <run_id> [--repo .]
portico cancel <run_id> [--repo .]
portico apply <run_id> [--repo .]
portico discard <run_id> [--repo .]
portico doctor [--config path]
```

`portico doctor` 会报告 Node/平台、配置来源、login-shell PATH 恢复、每个 provider 的发现结果（路径、版本、状态、不可用原因）、端口可用性，以及 CORS/LAN 安全状态。

`portico init` 会创建 `.portico/config.json`、`.portico/runs`、`.portico/worktrees`，以及面向 Claude Code 和 Codex 兼容 Agent runtime 的本地 Portico Skill 文件。

## 委派

委派是本地 Agent 路由路径：Claude Code、Codex 或其他已配置的 Agent 可以请求 Portico 把一个代码任务交给另一个本地 Agent。Portico 会创建专用 git worktree，在其中运行目标 Agent，捕获日志和事件，生成 diff，运行配置好的测试，并把最终决策留给用户。

初始化仓库：

```bash
portico init
```

启动 daemon：

```bash
portico daemon start
```

委派任务：

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
portico status run_20260617143454_65d33c76
portico apply run_20260617143454_65d33c76
portico discard run_20260617143454_65d33c76
```

每次 run 都会在 `.portico/runs/<run_id>/` 下写入工件：

- `task.json`：原始委派请求
- `events.ndjson`：完整委派事件日志
- `agent.ndjson`：目标 Agent 运行时事件
- `test.log`：配置的测试命令输出
- `diff.patch`：隔离 worktree 生成的补丁
- `report.md`：面向人的摘要和后续动作
- `result.json`：稳定的机器可读运行结果

Worktrees 位于 `.portico/worktrees/<run_id>/`。Portico 会把 `.portico/` 加入仓库本地 git exclude 文件，使工件和 worktree 不会作为普通项目变更出现。

MVP 阶段的委派控制：

- 默认最大委派深度为 1，阻止嵌套委派。
- 默认禁止路径包括 `.env`、`.ssh/**`、`node_modules/**`、`dist/**` 和 `build/**`。
- `--allowed` 和 `--forbidden` 会在 run 进入 ready 前约束可变更路径。
- `--isolation worktree|shared` 控制工作区隔离。实现型 run 默认使用 `worktree`；
  review run 默认使用 `shared` 和只读权限 profile。
- `--base-ref <ref>` 控制隔离 worktree 从哪个 git ref 分支出来；可以用
  `--base-ref defaultBranch` 尽量从默认分支创建。
- `--cleanup manual|onNoChanges|onSuccess|always` 控制是否自动清理 worktree。
- `--permission-profile default|read-only|auto-edit` 控制 Portico 是否请求 provider
  adapter 开启自主编辑。共享工作区的 auto-edit run 要求工作树干净，这样 Portico
  才能归因生成的 diff。
- `--mode compare --compare-to <agent>` 会运行多个隔离候选实现，并生成一个父级比较报告，
  指向每个候选 run。
- 测试命令来自重复传入的 `--test` 参数，或 `.portico/config.json` 中的 `testCommands`。
- `apply` 必须由明确命令触发，只能应用 implement run，并且在主工作树存在 tracked dirty
  files 时会拒绝执行。

## Skills

仓库中有一个规范 Skill：[`packages/skills/portico/SKILL.md`](packages/skills/portico/SKILL.md)。`portico init` 会从它派生各 Agent 的变体，因此只需要维护一份正文：

- `.claude/skills/portico/SKILL.md`：规范 Skill，包含 Claude Code 的 `allowed-tools` frontmatter。
- `.agents/skills/portico/SKILL.md`：同一份 Skill，但移除了 `allowed-tools` 行，供 Codex 风格 loader 使用。

这个 Skill 不硬编码单一方向，例如 Claude → Codex。它会告诉当前 Agent 如何编写自包含的委派任务、选择明确的 `--to <agent>` 目标（优先遵循用户指定，否则选择另一个有能力的本地 Agent）、读取 run 的报告和结果，并和用户一起决定 apply 还是 discard。

## HTTP API（daemon）

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /health` | - | `{ ok, name, version }` |
| `GET /agents` | - | `{ agents: AgentEntry[] }` |
| `POST /chat` | `ChatRequest` JSON | `application/x-ndjson` event stream |
| `POST /delegate` | `DelegateRequest` JSON | `application/x-ndjson` delegation stream |
| `GET /runs?repo=/path` | - | `{ runs: Run[] }` |
| `GET /runs/:id?repo=/path` | - | `RunDetails` |
| `GET /runs/:id/events?repo=/path` | - | `application/x-ndjson` event history |
| `POST /runs/:id/cancel?repo=/path` | - | `RunDetails` |
| `POST /runs/:id/apply?repo=/path` | - | `RunDetails` |
| `POST /runs/:id/discard?repo=/path` | - | `RunDetails` |
| `POST /reload` | - | `{ agents: AgentEntry[] }`，重新发现 |
| `GET /sessions` | - | `{ sessions: SessionRecord[] }` |
| `DELETE /sessions/:id` | - | `{ ok }` 或 `404` |

`POST /chat` 每行流式输出一个 JSON 对象。支持结构化协议的 Agent（例如 Claude Code）会把推理和工具使用作为独立事件暴露出来：

```json
{"type":"start","sessionId":"...","provider":"claude"}
{"type":"reasoning","delta":"Let me check the file..."}
{"type":"tool_call","name":"Read","input":{"file_path":"package.json"}}
{"type":"tool_result","name":"Read","output":"..."}
{"type":"content","delta":"The answer is..."}
{"type":"done","message":"...full answer..."}
```

`start` 事件中的 `sessionId`，也会通过 `X-Portico-Session` 响应头返回，是继续会话的句柄。把它作为 `ChatRequest.sessionId` 发回即可恢复同一段对话。参见 [Sessions](#sessions)。

## Client SDK

浏览器 / 同构环境，通过 daemon 通信：

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

`chat()` 遇到传输失败时不会 throw，而是 yield 一个终止性的 `error` 事件，方便 UI 在 Portico 未运行时**优雅降级**。`health()` 和 `listAgents()` 会抛出 typed `PorticoClientError`，其 `code` 可能是 `"unreachable"`、`"http_error"` 或 `"bad_response"`。

Node 进程内用法，不需要 daemon：

```ts
import { createInProcessClient } from "@portico/client/node";
// 或使用更底层的 API：
import { discoverAgents, runAgent } from "@portico/core";

const agents = await discoverAgents();
for await (const event of runAgent({ provider: "codex", context, messages })) {
  console.log(event);
}
```

## Sessions

**Session** 是同一个工作目录中与同一个 Agent 的可继续对话。Portico 默认无状态；传入 `sessionId` 即可继续之前的 turn：

- 不带 `sessionId` 的 `/chat` 会创建一个句柄，并通过 `start` 事件和 `X-Portico-Session` 响应头返回。
- 把该句柄作为 `ChatRequest.sessionId` 发回，Portico 会恢复 Agent 自己的 session，例如 `claude --resume`。它保留完整上下文，因此不需要重新发送历史记录。
- Resume 以 `(session, cwd)` 为键；如果上一轮失败，则跳过恢复，下一轮重新开始。同一个 session 同时只允许一个 run，并发 `/chat` 会得到 `409`。
- `GET /sessions` 列出记录；`DELETE /sessions/:id` 忘记一条记录。

记录在 daemon 生命周期内保存在内存中。文件持久化是计划中的开关，Codex resume 尚未接入。详情见 [`docs/session-management-plan.md`](docs/session-management-plan.md)。

## 发现机制

`discoverAgents()` 会分层探测，模拟成熟本地 runtime 如何在 GUI 环境缺少完整 `PATH` 时仍然工作：

1. 显式环境变量路径，例如 `PORTICO_CODEX_PATH`、`PORTICO_GEMINI_PATH`、`PORTICO_ANTIGRAVITY_PATH`。
2. `PATH` 查找。
3. login-shell fallback：`$SHELL -lc 'command -v <bin>'`，用于恢复 Homebrew、fnm、nvm、volta 等环境。
4. `<bin> --version` → semver 解析 → capability registry。

无法解析的版本不会阻止使用：Agent 仍会被标记为 `available`，但 `versionStatus` 为 `"unknown"`。

## Adapters

每个 provider 实现同一个接口；`generic-cli` 引擎位于 core 中，因此每个 provider 都有一个可工作的 fallback。

```ts
export interface AgentAdapter {
  provider: AgentProvider;
  detect?(entry: AgentEntry): Promise<AgentEntry>;
  buildPrompt(request: ChatRequest): Promise<string>;
  run(request: ChatRequest, entry: AgentEntry, context?: RunContext): AsyncIterable<RuntimeEvent>;
}
```

- **generic-cli**：启动 binary，通过 stdin 或 argv 传入渲染后的 prompt，并把 stdout 流式转换为 `content`。这是通用 fallback；目前驱动 `codex`（`codex exec`）、`gemini`（`gemini --prompt <prompt>`）、`antigravity`（`agy run <prompt>`）和 `opencode`（`opencode run <prompt>`）。
- **stream-json**：解析 Claude Code 的 `claude -p --output-format stream-json --include-partial-messages`，输出 token 级 `content`/`reasoning` 增量、`tool_call`/`tool_result` 事件，并通过 `--resume` 支持 session continuity。用于驱动 `claude`。
- **codex**：通过 generic-cli 驱动；结构化协议和 resume 会等非交互式契约稳定后再接入。
- **gemini / antigravity / opencode**：通过 generic-cli 非交互模式驱动。Antigravity 优先发现为 `agy`，其次为 `antigravity`；`PORTICO_ANTIGRAVITY_PATH` 可以固定显式 binary。它的持久 CLI 设置位于 `~/.gemini/antigravity-cli/settings.json`，而委派自动编辑模式会通过启动参数传入 `--dangerously-skip-permissions`。
- **openclaw / hermes**：仅支持发现和能力展示；run 会以明确的 `adapter_unsupported` 错误结束，而不是挂在交互式 CLI 上。

可以使用 `registerAdapter(myAdapter)` 注册自己的适配器。

## 安全模型

- 默认绑定到 `127.0.0.1`。如果使用 LAN 暴露（`--lan` 或非 loopback 的 `--host`），必须设置 `--token`，否则会拒绝启动。
- CORS 默认允许任意端口上的 `localhost`/`127.0.0.1`；生产 origin 必须通过 `--allow-origin` 显式选择。
- 子进程 runner 会强制执行超时 watchdog、最大输出限制、通过 `AbortSignal` 取消，并保证进程清理。
- 委派 run 在隔离 git worktree 中执行，并在任何补丁应用到主工作树前生成工件。
- 委派 `apply` 永远不会自动执行；必须由用户触发，并要求 tracked working tree 干净。
- Portico 不保存宿主应用 secrets，也不读取宿主数据；它只处理每次请求传入的 `context` 或短生命周期 `contextUrl`。

完整设计、里程碑和路线图见 [`docs/agent-runtime-library-plan.md`](docs/agent-runtime-library-plan.md)。

## 示例

- [`examples/web`](examples/web)：在浏览器中粘贴文章、选择本地 Agent，并流式展示回答；包含 live reasoning、tool activity panel 和多轮 follow-up。运行 `node examples/web/serve.mjs`，然后打开 `http://localhost:5173`。
- [`examples/node-cli`](examples/node-cli)：运行 `node examples/node-cli ask --provider codex --file context.md`。

## 项目结构

```text
packages/{core,adapters,orchestrator,daemon,client,cli} # runtime 和委派 packages
packages/skills/portico/SKILL.md                        # 统一 Portico Skill
examples/{web,node-cli}                                  # 可运行集成示例
test/fixtures/{fake-agent,edit-agent}.mjs                # 测试用 Agent 替身
docs/agent-runtime-library-plan.md                       # runtime 计划
docs/portico-delegation-mvp-plan.md                      # 委派 MVP 计划
```

## 状态

当前版本包含 runtime bridge MVP 和第一版 delegation MVP：core、adapters、orchestrator、daemon、client、cli，generic-cli 和 stream-json 引擎，Claude 结构化流式输出（reasoning / tool events / token deltas）、内存 session resume、隔离委派 worktree、run 工件、测试日志、patch apply/discard，以及统一 Skill 指令。

尚未包含：Web UI、MCP server、cloud workers、自动 PR、LAN pairing、文件化 session 持久化、Codex resume、Electron 自动安装器和 cloud relay。

MIT licensed.
