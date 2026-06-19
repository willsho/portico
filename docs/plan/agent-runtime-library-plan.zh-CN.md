<!-- Portico reusable local Agent runtime development plan. -->
<!-- Input: host app context bundles, user messages, installed Agent CLIs, adapter config. -->
<!-- Output: standalone SDK, local daemon, Agent adapters, and integration recipes for web/Electron apps. -->
<!-- Pos: 可迁移到 Portico 新仓库的通用 Agent 连接层开发计划。 -->

# Portico 开发计划

## 1. 项目概述

**Portico** 是一个可复用的本地 Agent runtime bridge。它的目标是让 Web App、Electron App、桌面工具、浏览器扩展和 CLI 应用，都能用统一方式连接用户电脑上已经安装的 AI Agent。

很多现代 Agent 以 CLI 形式存在，例如 Codex、Claude Code、openclaw、Hermes，以及未来更多支持 JSON stream、ACP 或其他本地协议的工具。对应用开发者来说，逐个处理这些 Agent 的安装路径、版本检测、启动参数、流式输出、错误处理和安全边界，会很快变成重复劳动。

Portico 试图把这部分变成基础设施：

- 发现本机已安装的 Agent。
- 检测版本和能力。
- 用 adapter 抹平不同 Agent 的调用方式。
- 提供本地 daemon，让浏览器页面也能连接 Agent。
- 提供 SDK，让 Web/Electron/Node 应用快速集成。
- 用统一事件流返回 Agent 输出。

名字含义：Portico 是建筑里的门廊，连接外部世界与内部空间。这个项目也一样，它不是宿主应用，也不是 Agent 本体，而是应用进入本地 Agent 世界的入口。

## 2. 目标用户

Portico 面向三类开发者：

| 用户 | 需求 |
|---|---|
| Web App 开发者 | 希望网页能调用用户本机 Agent，而不是只能调用云端模型 |
| Electron/桌面 App 开发者 | 希望在主进程里安全地发现和调用本机 Agent |
| Agent 工具开发者 | 希望为自己的 Agent 提供标准 adapter，让其他应用能快速接入 |

典型场景：

- 阅读器应用把当前文章上下文交给本地 Agent 继续追问。
- 代码管理工具把当前仓库信息交给 Codex 或 Claude Code。
- 笔记应用把当前页面、引用和选中文本交给用户本机 Agent。
- Electron IDE 插件发现本机可用 Agent，并让用户选择执行者。
- 企业内网工具通过局域网 daemon 调用指定工作站上的 Agent。

## 3. 产品形态

Portico 提供三层能力：

| 形态 | 包名 | 面向对象 | 说明 |
|---|---|---|---|
| Core Library | `@portico/core` | Node/Electron/CLI | 进程内发现 Agent、启动子进程、读取事件流 |
| Local Daemon | `@portico/daemon` | Web App/浏览器页面 | 在本机监听 HTTP/SSE，让网页连接本机 Agent |
| Client SDK | `@portico/client` | Web/Electron/Node | 封装 health、agents、chat、流式读取和错误处理 |

命令行工具：

```bash
portico start
portico agents
portico doctor
```

一句话介绍：

```text
Portico is a local Agent runtime bridge for web and desktop apps.
```

## 4. 非目标

第一阶段 Portico 不做：

- 不做完整任务平台。
- 不做项目管理、issue 跟踪或 PR 自动化。
- 不做云端编排服务。
- 不做多租户权限系统。
- 不做 Agent Marketplace。
- 不绑定任何一个宿主应用的数据结构。
- 不要求所有 Agent 支持同一种底层协议。

Portico 只解决一个核心问题：

```text
宿主应用提供上下文和用户消息，Portico 找到合适的本地 Agent，启动它，并把输出流式返回。
```

## 5. 核心原则

1. **宿主无关**：Portico 不知道宿主应用是阅读器、IDE、笔记工具还是企业系统。
2. **上下文泛化**：所有业务上下文都转成通用 `ContextBundle`。
3. **Adapter 化**：每个 Agent provider 通过 adapter 接入。
4. **流式优先**：所有输出统一成 `RuntimeEvent` 事件流。
5. **安全默认值**：默认只监听 `127.0.0.1`；LAN 必须显式开启并配置 token。
6. **可降级**：provider 专用协议不可用时，回退到通用 CLI prompt 模式。
7. **开发者友好**：Web/Electron 接入应该清晰、短路径、可诊断。

## 6. 总体架构

```text
Host App
  |
  | Browser SDK / Node SDK / Electron IPC
  v
Portico Client
  |
  | HTTP NDJSON/SSE or in-process API
  v
Portico Core
  |
  +--> Discovery
  |      - env path
  |      - PATH lookup
  |      - login shell fallback
  |
  +--> Registry
  |      - provider metadata
  |      - versions
  |      - capabilities
  |
  +--> Adapters
  |      - generic-cli
  |      - codex
  |      - claude
  |      - openclaw
  |      - hermes
  |
  +--> Session Runner
         - spawn child process
         - stdin/stdout JSON or text stream
         - timeout/watchdog
         - cancellation
```

## 7. 新仓库结构

建议新仓库采用 TypeScript monorepo：

```text
portico/
  README.md
  LICENSE
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  docs/
    getting-started.md
    browser-web-app.md
    electron.md
    provider-adapters.md
    security.md
    protocol.md
  packages/
    core/
      package.json
      src/
        index.ts
        discovery.ts
        registry.ts
        version.ts
        shell.ts
        runner.ts
        events.ts
        errors.ts
        context.ts
      tests/
    daemon/
      package.json
      src/
        index.ts
        server.ts
        routes.ts
        auth.ts
        config.ts
      tests/
    client/
      package.json
      src/
        index.ts
        browser.ts
        node.ts
        stream.ts
      tests/
    adapters/
      package.json
      src/
        index.ts
        types.ts
        generic-cli.ts
        codex.ts
        claude.ts
        openclaw.ts
        hermes.ts
      tests/
    cli/
      package.json
      src/
        index.ts
        commands/
          start.ts
          agents.ts
          doctor.ts
  examples/
    web/
    electron/
    node-cli/
    article-reader/
```

建议使用：

- TypeScript
- Node.js 20+
- pnpm workspace
- Vitest 或 Node test runner
- tsup 或 unbuild 打包
- ESLint + Prettier

## 8. 公共数据结构

### 8.1 ContextBundle

`ContextBundle` 是宿主应用传给 Agent 的通用上下文。它不绑定任何业务。

```ts
export interface ContextBundle {
  schemaVersion: "1.0";
  kind: string;
  id?: string;
  title?: string;
  sourceUrl?: string;
  summary?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  attachments?: ContextAttachment[];
  createdAt?: string;
}
```

示例：文章阅读器

```ts
const context: ContextBundle = {
  schemaVersion: "1.0",
  kind: "article",
  id: "article_123",
  title: "How local-first AI tools are changing workflows",
  sourceUrl: "https://example.com/article",
  summary: "A short summary of the article.",
  content: "Full article text or markdown analysis.",
  metadata: {
    author: "Example Author",
    publishedAt: "2026-06-16"
  }
};
```

示例：代码工具

```ts
const context: ContextBundle = {
  schemaVersion: "1.0",
  kind: "code.change",
  title: "Review staged changes",
  content: gitDiff,
  metadata: {
    repo: "example/repo",
    branch: "feature/local-agent-runtime"
  }
};
```

### 8.2 ContextAttachment

```ts
export interface ContextAttachment {
  name: string;
  mediaType: string;
  content?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}
```

约束：

- `content` 适合小文本附件。
- 大文件优先使用短期 `url`。
- adapter 可以决定是否支持附件。

### 8.3 AgentProtocol

```ts
export type AgentProtocol =
  | "generic-cli"
  | "json-stream"
  | "stream-json"
  | "acp"
  | "app-server";
```

### 8.4 AgentProvider

```ts
export interface AgentProvider {
  id: string;
  displayName: string;
  commandNames: string[];
  envPathNames: string[];
  minVersion?: string;
  protocols: AgentProtocol[];
}
```

示例：

```ts
{
  id: "codex",
  displayName: "Codex",
  commandNames: ["codex"],
  envPathNames: ["PORTICO_CODEX_PATH"],
  minVersion: "0.100.0",
  protocols: ["app-server", "json-stream", "generic-cli"]
}
```

### 8.5 AgentEntry

```ts
export interface AgentEntry {
  provider: string;
  displayName: string;
  available: boolean;
  path?: string;
  version?: string;
  versionStatus?: "ok" | "too_old" | "unknown";
  protocols: AgentProtocol[];
  reason?: string;
}
```

### 8.6 ChatMessage

```ts
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
```

### 8.7 ChatRequest

```ts
export interface ChatRequest {
  provider: string;
  context?: ContextBundle;
  contextUrl?: string;
  messages: ChatMessage[];
  options?: {
    cwd?: string;
    timeoutMs?: number;
    stream?: boolean;
    model?: string;
    maxContextChars?: number;
  };
}
```

### 8.8 RuntimeEvent

统一输出事件：

```ts
export type RuntimeEvent =
  | { type: "start"; sessionId: string; provider: string }
  | { type: "content"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; name: string; input?: unknown }
  | { type: "tool_result"; name: string; output?: unknown }
  | { type: "error"; error: string; code?: string }
  | { type: "done"; message: string; usage?: unknown };
```

## 9. Agent 发现机制

发现机制参考成熟本地 runtime 的工程做法，核心是三层探测：

```text
discoverAgents()
  |
  +--> explicit env paths
  +--> PATH lookup
  +--> login shell fallback
  +--> --version
  +--> semver parse
  +--> capability registry
```

### 9.1 环境变量优先

支持：

```text
PORTICO_CODEX_PATH
PORTICO_CLAUDE_PATH
PORTICO_OPENCLAW_PATH
PORTICO_HERMES_PATH
```

如果用户设置了显式路径，优先使用，并在 `doctor` 中提示路径来源。

### 9.2 PATH 查找

Node 实现可以使用：

- 轻量 `which` 包。
- 或 `child_process.spawn` 执行 `command -v`。

Windows 后续支持：

- `where.exe`
- `.cmd`/`.exe` 扩展名处理。

### 9.3 登录 Shell 回退

macOS/Linux 上，GUI 启动的 app 或 daemon 经常拿不到用户交互式 shell 的 PATH。需要在 `PATH` 查找失败后回退：

```bash
$SHELL -lc 'command -v codex'
zsh -lc 'command -v codex'
bash -lc 'command -v codex'
```

这能覆盖 Homebrew、fnm、nvm、volta 等路径只在 shell rc 文件中注入的情况。

### 9.4 版本检测

对探测到的二进制执行：

```bash
<binary> --version
```

从 stdout/stderr 中提取 semver：

```text
0.100.0
codex 0.100.0
Claude Code 2.0.1
```

版本无法解析时：

- `available: true`
- `versionStatus: "unknown"`
- 不阻止使用，但在 UI 和 `doctor` 中提示。

## 10. Adapter 设计

每个 Agent provider 通过 adapter 实现统一接口：

```ts
export interface AgentAdapter {
  provider: AgentProvider;
  detect?(entry: AgentEntry): Promise<AgentEntry>;
  buildPrompt(request: ChatRequest): Promise<string>;
  run(request: ChatRequest, entry: AgentEntry): AsyncIterable<RuntimeEvent>;
}
```

### 10.1 Generic CLI Adapter

最小可用实现：

```text
spawn(agent.path, provider.defaultArgs)
write prompt to stdin
read stdout/stderr
emit content/error/done
```

优点：

- 快速支持新 Agent。
- 不依赖 provider 私有协议。
- 适合 MVP。

缺点：

- 会话保持能力弱。
- 工具调用和结构化事件可能丢失。
- 不一定适合强交互 CLI。

### 10.2 Codex Adapter

目标：

- 探测 `codex`。
- 支持基础 prompt 调用。
- 后续支持 Codex 稳定的结构化协议。

策略：

- MVP 先通过 generic-cli 跑通。
- 确认稳定非交互调用方式后再实现专用 adapter。

### 10.3 Claude Adapter

目标：

- 探测 `claude`。
- 支持 `--version`。
- 支持 stream-json 或稳定非交互模式。

策略：

- 优先使用官方稳定 CLI 参数。
- 如果无法可靠非交互，显示“已安装但当前 adapter 暂不支持自动调用”。

### 10.4 openclaw / Hermes Adapter

目标：

- 支持 ACP 或各自推荐协议。
- 支持本机和局域网 daemon 场景。

策略：

- 第一阶段只做探测和能力展示。
- 第二阶段实现 `/chat` 调用。

## 11. Daemon 设计

Daemon 是 Core Library 的 HTTP 封装，主要服务普通 Web App。

### 11.1 默认行为

```bash
portico start
```

默认：

- 监听 `127.0.0.1:8787`
- 不开启 LAN
- 启动时扫描 Agent
- 定期刷新 registry
- 支持 CORS origin 白名单
- 输出启动诊断信息

### 11.2 HTTP API

```http
GET /health
GET /agents
POST /chat
POST /reload
```

`GET /health`：

```json
{
  "ok": true,
  "name": "portico",
  "version": "0.1.0"
}
```

`GET /agents`：

```json
{
  "agents": [
    {
      "provider": "codex",
      "displayName": "Codex",
      "available": true,
      "version": "0.100.0",
      "versionStatus": "ok",
      "protocols": ["generic-cli"]
    }
  ]
}
```

`POST /chat`：

```json
{
  "provider": "codex",
  "context": {
    "schemaVersion": "1.0",
    "kind": "article",
    "title": "Article title",
    "content": "Article text or structured context"
  },
  "messages": [
    { "role": "user", "content": "What is the strongest counterargument?" }
  ]
}
```

响应：

```text
Content-Type: application/x-ndjson
```

```json
{"type":"start","sessionId":"...","provider":"codex"}
{"type":"content","delta":"The strongest counterargument is..."}
{"type":"done","message":"Full answer"}
```

### 11.3 LAN 模式

显式开启：

```bash
portico start --host 0.0.0.0 --port 8787 --lan --token xxx
```

要求：

- 必须设置 token。
- 默认拒绝无 `Authorization` 请求。
- 日志中明确提示当前暴露到局域网。
- `doctor` 中提示 LAN 安全风险。

## 12. Client SDK

### 12.1 Browser Client

```ts
import { createPorticoClient } from "@portico/client";

const client = createPorticoClient({
  endpoint: "http://127.0.0.1:8787"
});

const health = await client.health();
const agents = await client.listAgents();

for await (const event of client.chat({
  provider: "codex",
  context,
  messages: [{ role: "user", content: "Summarize the key risks." }]
})) {
  render(event);
}
```

能力：

- 检查 daemon 是否可达。
- 解析 NDJSON。
- 统一错误信息。
- 支持 AbortController 取消。
- 支持 token。

### 12.2 Node Client

Node 应用可以：

- 通过 daemon 调用。
- 或直接使用 `@portico/core` 进程内调用。

```ts
import { discoverAgents, runAgent } from "@portico/core";

const agents = await discoverAgents();

for await (const event of runAgent({
  provider: "codex",
  context,
  messages
})) {
  console.log(event);
}
```

### 12.3 Electron 集成

推荐模式：

```text
Electron Renderer
  -> ipcRenderer.invoke("portico:listAgents")
  -> Main Process
  -> @portico/core
```

这样可以避免：

- 浏览器 mixed content。
- CORS。
- Private Network Access 限制。
- 渲染进程直接启动子进程的安全风险。

## 13. Web App 兼容矩阵

普通浏览器页面访问本地服务会受浏览器安全策略影响。

| 场景 | 可行性 | 说明 |
|---|---|---|
| `http://localhost` 开发环境 | 高 | 最适合开发调试 |
| HTTPS 生产站访问 `127.0.0.1` | 中 | 取决于浏览器 Private Network Access 限制 |
| HTTPS 生产站访问 LAN HTTP | 低 | 可能被 mixed content/PNA 拦截 |
| Electron | 高 | 通过主进程或 IPC 最稳 |
| Browser extension | 高 | 可作为后续桥接方案 |

后续可探索：

- 本地 HTTPS daemon。
- Native helper。
- Browser extension bridge。
- 云端 relay，让 daemon 主动轮询任务。

## 14. 安全模型

### 14.1 默认安全边界

- 默认只监听 `127.0.0.1`。
- LAN 必须显式开启。
- LAN 必须 token。
- Portico 不持有宿主应用数据库密钥。
- Portico 不主动读取宿主应用数据。
- Portico 只处理请求传入的 `context` 或 `contextUrl`。

### 14.2 Context URL

云端宿主应用推荐传短期授权 URL：

```json
{
  "contextUrl": "https://example.com/api/context?token=short-lived-token"
}
```

要求：

- token 短期有效。
- 只授权当前上下文。
- 不包含数据库 service role。
- 可以撤销或过期。

### 14.3 子进程安全

必须实现：

- 超时。
- 最大输出大小。
- 最大 stderr 大小。
- 可取消。
- 退出码检查。
- 避免把 secret 写入 prompt。
- 子进程退出后清理资源。

### 14.4 CORS

默认允许：

```text
http://localhost:*
http://127.0.0.1:*
```

生产 Web App 需要用户显式加入 origin 白名单：

```bash
portico start --allow-origin https://example.com
```

## 15. 配置文件

默认配置位置：

```text
~/.portico/config.json
```

示例：

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "allowOrigins": ["http://localhost:3000"],
  "agents": {
    "codex": {
      "path": "/opt/homebrew/bin/codex",
      "enabled": true
    },
    "claude": {
      "enabled": true
    }
  },
  "limits": {
    "defaultTimeoutMs": 120000,
    "maxContextChars": 120000,
    "maxOutputChars": 200000
  }
}
```

优先级：

```text
CLI args > env vars > config file > defaults
```

## 16. CLI 设计

### 16.1 `portico start`

启动 daemon：

```bash
portico start
portico start --port 8788
portico start --lan --token xxx
```

### 16.2 `portico agents`

列出 Agent：

```bash
portico agents
```

输出：

```text
Provider   Available   Version   Path
codex      yes         0.100.0   /opt/homebrew/bin/codex
claude     yes         2.0.1     /usr/local/bin/claude
hermes     no          -         not found
```

### 16.3 `portico doctor`

诊断：

- PATH 来源。
- 登录 shell 回退结果。
- Agent 版本。
- 配置文件是否有效。
- daemon 端口是否被占用。
- CORS/LAN 安全提示。

## 17. 示例应用

新仓库需要提供最少三个示例：

### 17.1 Web Reader

一个普通网页示例：

- 用户粘贴文章。
- 页面检测本机 Portico。
- 选择 Agent。
- 发送文章上下文。
- 流式展示回答。

### 17.2 Electron Notes

一个 Electron 示例：

- 主进程使用 `@portico/core`。
- 渲染进程通过 IPC 触发。
- 避免浏览器访问本地 HTTP 限制。

### 17.3 Node CLI

一个 Node CLI 示例：

```bash
node examples/node-cli ask --provider codex --file context.md
```

## 18. 开发阶段

### M1：Core Library MVP

交付：

- Provider 类型定义。
- Agent discovery。
- PATH 查找。
- 登录 shell 回退。
- `--version` 检测。
- Generic CLI adapter。
- AsyncIterable 事件输出。

验收：

- 本机能发现 `codex`/`claude`。
- 能返回 Agent 列表。
- 能用 fake agent binary 发送 prompt 并拿到输出。

### M2：Daemon MVP

交付：

- `portico start`。
- `GET /health`。
- `GET /agents`。
- `POST /chat` NDJSON。
- CORS 配置。
- 超时和取消。

验收：

- Web 页面能从 `localhost` 获取 Agent 列表。
- Web 页面能发起一次流式对话。

### M3：Client SDK

交付：

- `createPorticoClient`。
- `health()`。
- `listAgents()`。
- `chat()` async iterator。
- AbortController 支持。
- 错误类型标准化。

验收：

- 示例 Web App 只用 SDK 即可完成本地 Agent 调用。
- SDK 不依赖任何宿主业务类型。

### M4：Provider Adapter 优化

交付：

- Codex adapter。
- Claude adapter。
- openclaw/Hermes adapter 探测。
- provider capability 展示。

验收：

- adapter 能识别 provider 支持的协议。
- 不支持自动调用的 Agent 也能清楚显示原因。

### M5：LAN 与安全增强

交付：

- `--lan` 模式。
- Bearer token 鉴权。
- allow origin。
- pairing code 初版。

验收：

- 局域网另一台机器可以通过 token 访问 `/agents` 和 `/chat`。
- 无 token 请求被拒绝。

### M6：公开发布

交付：

- npm 包。
- README。
- 文档站或 docs 目录。
- Web 示例。
- Electron 示例。
- Node CLI 示例。

验收：

- 新项目可以通过 npm 安装并在 15 分钟内接入本地 Agent。

## 19. 测试计划

### 19.1 单元测试

覆盖：

- env path 优先级。
- PATH 查找。
- 登录 shell 回退。
- semver 解析。
- min version 检查。
- ContextBundle prompt 渲染。
- NDJSON 事件序列。
- 配置优先级。

### 19.2 集成测试

覆盖：

- 启动 daemon。
- 调用 `/health`。
- 调用 `/agents`。
- 使用 fake agent binary 测试 `/chat`。
- 子进程超时。
- AbortController 取消。
- CORS origin 配置。
- token 鉴权。

### 19.3 手动测试

覆盖：

- macOS zsh + Homebrew。
- macOS GUI 启动。
- nvm/fnm/volta 管理 Node CLI 的 PATH。
- Electron 主进程集成。
- 普通 Web App 开发环境。
- HTTPS 页面访问 localhost。
- 局域网 token 模式。

## 20. 文档计划

需要提供：

```text
README.md
docs/getting-started.md
docs/browser-web-app.md
docs/electron.md
docs/provider-adapters.md
docs/security.md
docs/protocol.md
docs/troubleshooting.md
```

重点讲清：

- Portico 是什么，不是什么。
- 如何启动 daemon。
- Web App 如何检测本地 Portico。
- Electron 如何进程内使用 core library。
- 如何新增一个 Agent adapter。
- 为什么不要把宿主应用密钥交给 Portico。
- 浏览器访问 localhost/LAN 的限制。

## 21. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| Agent CLI 非交互协议不稳定 | 调用失败 | 先提供 generic-cli，provider adapter 分阶段增强 |
| 浏览器限制访问 localhost/LAN | Web App 体验受限 | Electron/extension/relay 作为后续方案 |
| Prompt 注入上下文过长 | 成本和延迟高 | maxContextChars、摘要化、分段 |
| LAN 暴露风险 | 安全问题 | 默认关闭 LAN，开启必须 token |
| 不同 Agent 输出格式差异大 | SDK 难统一 | 统一 RuntimeEvent，adapter 内部转换 |
| 宿主业务绑架核心库 | 复用性下降 | Core 只接受 ContextBundle，不引用业务类型 |
| 子进程失控或卡死 | 本机资源风险 | timeout、abort、watchdog、max output |

## 22. 推荐实施顺序

1. 创建 `portico` 新仓库。
2. 初始化 TypeScript monorepo。
3. 定义公共类型：`ContextBundle`、`AgentEntry`、`ChatRequest`、`RuntimeEvent`。
4. 实现 `@portico/core` 的 discovery 和 fake agent runner。
5. 实现 `@portico/daemon` 的 `/health`、`/agents`、`/chat`。
6. 实现 `@portico/client`。
7. 写 Web Reader 示例。
8. 接入真实 Codex/Claude 探测。
9. 优化 provider-specific adapter。
10. 写 Electron 示例。
11. 增加 LAN/token。
12. 发布 npm alpha。

## 23. 最小可行版本

MVP 只包含：

- `@portico/core`
- `@portico/daemon`
- `@portico/client`
- `@portico/adapters`
- `@portico/cli`
- `generic-cli` adapter
- `codex`/`claude` 探测，不承诺深度协议支持

MVP 不包含：

- LAN。
- pairing。
- session 持久化。
- provider 私有高级协议。
- Electron 自动安装器。
- 云端 relay。

MVP 验收标准：

```text
任意 Web App 能通过 localhost daemon：
1. 检测本机已安装 Agent。
2. 发送 ContextBundle 和用户问题。
3. 流式收到 Agent 回答。
4. 在 Portico 不可用时优雅降级。
```

## 24. 给接手开发者的第一周任务

第一周不要急着接真实 Agent。先把边界和协议打稳：

1. 新建仓库和 monorepo。
2. 建立 `@portico/core`、`@portico/daemon`、`@portico/client`、`@portico/cli` 包。
3. 定义公共类型并导出。
4. 做 fake agent binary，用来模拟流式输出。
5. 实现 discovery 的 env path 和 PATH lookup。
6. 实现 daemon `/health`、`/agents`、`/chat`。
7. 实现 client 的 async iterator。
8. 做一个最小 Web 示例。

第一周结束时，哪怕还没有真实 Codex/Claude adapter，也应该能演示：

```text
网页 -> localhost Portico -> fake agent -> 流式回答
```

这条链路跑通后，再接真实 Agent，项目就不会在早期被 provider 细节拖住。
