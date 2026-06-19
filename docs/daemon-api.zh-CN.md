# 守护进程 API (Daemon API)

Portico 守护进程暴露了一个本地 HTTP API。JSON 端点返回 JSON 响应。流式端点返回以换行符分隔的 JSON（NDJSON）。

默认基础 URL：

```text
http://127.0.0.1:8787
```

## 身份验证

如果守护进程配置了令牌，则每个请求都必须包含：

```http
Authorization: Bearer <token>
```

如果没有配置令牌，请求将在没有身份验证的情况下被接受。除非配置了令牌，否则将拒绝 LAN 暴露。

## 错误格式

JSON 错误响应使用：

```json
{
  "error": "Human-readable message.",
  "code": "machine_code"
}
```

流式端点可以在流开始前返回普通的 JSON 错误，或者在 NDJSON 流中发出终端 `error` 事件。

## `GET /health`

返回守护进程健康状态和版本。

```bash
curl -s http://127.0.0.1:8787/health
```

响应：

```json
{
  "ok": true,
  "name": "portico",
  "version": "0.1.0"
}
```

## `GET /agents`

返回已发现的代理。

```bash
curl -s http://127.0.0.1:8787/agents
```

响应：

```json
{
  "agents": [
    {
      "provider": "codex",
      "displayName": "Codex",
      "available": true,
      "path": "/usr/local/bin/codex",
      "version": "1.0.0",
      "versionStatus": "ok",
      "protocols": ["app-server", "json-stream", "generic-cli"],
      "source": "path"
    }
  ]
}
```

## `POST /reload`

重新运行代理发现过程并返回新的代理列表。

```bash
curl -s -X POST http://127.0.0.1:8787/reload
```

响应：

```json
{
  "agents": []
}
```

## `POST /chat`

运行一个代理轮次，并将 `RuntimeEvent` 对象作为 NDJSON 流式传输。

```bash
curl -N http://127.0.0.1:8787/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "claude",
    "messages": [
      { "role": "user", "content": "Summarize this repo" }
    ],
    "options": {
      "cwd": ".",
      "timeoutMs": 120000
    }
  }'
```

请求结构：

```ts
interface ChatRequest {
  provider: string;
  context?: ContextBundle;
  contextUrl?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  options?: {
    cwd?: string;
    timeoutMs?: number;
    stream?: boolean;
    model?: string;
    maxContextChars?: number;
    maxOutputChars?: number;
    autoEdit?: boolean;
  };
  sessionId?: string;
}
```

流事件示例：

```json
{"type":"start","sessionId":"...","provider":"claude"}
{"type":"content","delta":"..."}
{"type":"reasoning","delta":"..."}
{"type":"tool_call","name":"Read","input":{"file_path":"README.md"}}
{"type":"tool_result","name":"Read","output":"..."}
{"type":"done","message":"..."}
```

响应还包括：

```http
X-Portico-Session: <session_id>
```

在后续请求中发送该 session id 以继续会话（当提供商支持恢复且 `cwd` 匹配时）。

## `GET /sessions`

列出内存中的会话。

```bash
curl -s http://127.0.0.1:8787/sessions
```

响应：

```json
{
  "sessions": [
    {
      "id": "...",
      "provider": "claude",
      "cwd": "/path/to/repo",
      "agentSessionId": "...",
      "status": "active",
      "turns": 1,
      "createdAt": 1760000000000,
      "updatedAt": 1760000000000
    }
  ]
}
```

## `DELETE /sessions/:id`

从内存存储中删除一个会话句柄。

```bash
curl -s -X DELETE http://127.0.0.1:8787/sessions/<session_id>
```

响应：

```json
{
  "ok": true
}
```

## `POST /delegate`

启动委派运行并将 `DelegationEvent` 对象作为 NDJSON 流式传输。

```bash
curl -N http://127.0.0.1:8787/delegate \
  -H 'Content-Type: application/json' \
  -d '{
    "to": "codex",
    "repo": ".",
    "task": "Create delegated.txt",
    "testCommands": ["test -f delegated.txt"]
  }'
```

请求结构：

```ts
interface DelegateRequest {
  from?: string;
  to: string;
  compareTargets?: string[];
  children?: ChildSpec[];
  maxParallel?: number;
  fanIn?: FanInPolicy;
  repo: string;
  task: string;
  mode?: "implement" | "review" | "compare" | "split";
  isolation?: "worktree" | "shared" | {
    workspace: "worktree" | "shared";
    baseRef?: string;
    cleanup?: "manual" | "onNoChanges" | "onSuccess" | "always";
  };
  baseRef?: string;
  cleanup?: "manual" | "onNoChanges" | "onSuccess" | "always";
  permissionProfile?: "default" | "read-only" | "auto-edit";
  testCommands?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  timeoutMs?: number;
  depth?: number;
}

interface ChildSpec {
  to: string;
  task?: string;        // split 模式下必需（互补子任务）
  permissionProfile?: "default" | "read-only" | "auto-edit";
  model?: string;
  effort?: string;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  label?: string;
}

interface FanInPolicy {
  // 补丁合并策略。按模式默认：compare → "none"，split → "integration"。
  merge?: "none" | "sequential" | "integration";
  // 可选裁判：一个只读审查运行，评估候选者/合并的差异。
  judge?: { to: string; instruction?: string };
}
```

split 请求提供 `mode: "split"`，并为 `children` 提供每个对应的 `task`：

```json
{
  "to": "claude",
  "repo": ".",
  "task": "Add OAuth login end-to-end",
  "mode": "split",
  "children": [
    { "to": "claude", "task": "Backend OAuth routes", "allowedPaths": ["src/server/**"] },
    { "to": "codex", "task": "Login UI", "allowedPaths": ["src/web/**"] }
  ],
  "fanIn": { "merge": "integration", "judge": { "to": "gemini" } }
}
```

事件示例：

```json
{"type":"run_start","runId":"run_...","status":"created"}
{"type":"worktree_created","runId":"run_...","path":".portico/worktrees/run_...","branch":"portico/run_..."}
{"type":"agent_start","runId":"run_...","agent":"codex"}
{"type":"agent_event","runId":"run_...","event":{"type":"content","delta":"..."}}
{"type":"diff_ready","runId":"run_...","path":".portico/runs/run_.../diff.patch","changedFiles":["delegated.txt"]}
{"type":"test_start","runId":"run_...","command":"npm test"}
{"type":"test_done","runId":"run_...","command":"npm test","status":"passed","exitCode":0}
{"type":"run_done","runId":"run_...","status":"ready","reportPath":"...","resultPath":"..."}
```

仅当工作树隔离的运行更改了调用者的主检出时，才会发出 `sandbox_escape_detected`。这样的运行被标记为 `failed`；工作树的差异与树外更改保持分离。

```json
{"type":"sandbox_escape_detected","runId":"run_...","changes":[{"path":"docs/generated.md","status":"??","raw":"?? docs/generated.md"}]}
{"type":"run_done","runId":"run_...","status":"failed","reportPath":"...","resultPath":"..."}
```

对于扇出（fan-out）组，扇入（fan-in）阶段在子项完成（drain）之后且在该组的 `run_done` 之前（`runId` 为组 id），会在该组 id 上发出自己的事件：

```json
{"type":"fanin_start","runId":"<group_id>","strategy":"merge"}
{"type":"merge_done","runId":"<group_id>","status":"ready"}
{"type":"fanin_start","runId":"<group_id>","strategy":"judge"}
{"type":"judge_done","runId":"<group_id>","recommendedChildId":"run_...","verdict":"approve"}
{"type":"run_done","runId":"<group_id>","status":"ready","reportPath":"...","resultPath":"..."}
```

在合并冲突时，组的 `run_done` 携带 `status: "conflict"`：

```json
{"type":"merge_done","runId":"<group_id>","status":"conflict","conflicts":["src/auth.ts"]}
{"type":"run_done","runId":"<group_id>","status":"conflict","reportPath":"...","resultPath":"..."}
```

## `GET /runs?repo=<path>&flat=true`

列出仓库的委派运行。默认返回折叠视图（子项嵌套在其组下）。使用 `?flat=true` 获取旧版的扁平列表。

```bash
curl -s "http://127.0.0.1:8787/runs?repo=$(pwd)"
curl -s "http://127.0.0.1:8787/runs?repo=$(pwd)&flat=true"
```

响应：

```json
{
  "runs": []
}
```

## `GET /runs/:id?repo=<path>`

返回运行详情。对于组运行，在运行对象中包含 `childRunIds`，并在结果中包含 `childResults` / `groupSummary`。

```bash
curl -s "http://127.0.0.1:8787/runs/<run_id>?repo=$(pwd)"
```

响应结构：

```ts
interface RunDetails {
  run: Run;
  artifacts: RunArtifact;
  result?: RunResult;
}
```

相关的结果结构：

```ts
interface RunResult {
  run: Run;
  artifacts: RunArtifact;
  changedFiles: string[];
  tests: TestResult[];
  agentEvents: RuntimeEvent[];
  childResults?: RunResult[];      // 规范（Phase 2）
  compareResults?: RunResult[];    // 旧版别名
  groupSummary?: {
    total: number;
    ready: number;
    failed: number;
    cancelled: number;
  };
  // Split 组（Phase 3）— 扇入结果。
  merge?: {
    strategy: "sequential" | "integration";
    status: "ready" | "conflict";
    integrationWorktree?: string;
  };
  conflicts?: Array<{ file: string; child: string }>;
  judge?: {
    to: string;
    runId?: string;
    recommendedChildId?: string;                                 // compare
    ranking?: Array<{ childId: string; score?: number; note: string }>;
    verdict?: "approve" | "needs_attention";                     // split
  };
  sandboxEscaped?: boolean;
  outOfTreeChanges?: OutOfTreeChange[];
  agentGateMismatch?: boolean;
  gateWarnings?: string[];
  telemetry?: RunTelemetry;
  error?: string;
}

interface TestResult {
  command: string;
  status: "passed" | "failed";
  exitCode: number | null;
  output: string;
  durationMs?: number;
}

interface OutOfTreeChange {
  path: string;
  status: string;
  raw: string;
}

interface RunTelemetry {
  totalDurationMs: number;
  agentDurationMs?: number;
  testDurationMs: number;
  usage: UsageTelemetry;
}

interface UsageTelemetry {
  available: boolean;
  raw?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  unavailableReason?: string;
}
```

`usage.raw` 是终端代理事件中提供商报告的使用负载。当存在时，Portico 会提取常见的 token 和成本字段，但它不会估算缺失的成本。

## `GET /runs/:id/events?repo=<path>`

返回存储的委派事件日志（NDJSON 格式）。

```bash
curl -N "http://127.0.0.1:8787/runs/<run_id>/events?repo=$(pwd)"
```

## `POST /runs/:id/apply?repo=<path>`

应用就绪的运行。对于 compare 组，发送 `{ "child": "<child_id>" }` 以应用一个候选者；对于 split 组，发送 `{ "all": true }` 以应用合并的补丁。

```bash
# 应用单次运行
curl -s -X POST "http://127.0.0.1:8787/runs/<run_id>/apply?repo=$(pwd)"

# 应用 compare 组中的一个子项
curl -s -X POST "http://127.0.0.1:8787/runs/<group_id>/apply?repo=$(pwd)" \
  -H 'Content-Type: application/json' \
  -d '{"child": "<child_id>"}'

# 应用 split 组的合并补丁
curl -s -X POST "http://127.0.0.1:8787/runs/<group_id>/apply?repo=$(pwd)" \
  -H 'Content-Type: application/json' \
  -d '{"all": true}'
```

单次运行必须是 `implement`。没有 `child` 的 compare 组 apply 会返回错误；针对非 split 组，或者仍然处于 `conflict` 的 split 组的 `all` apply 会被拒绝。

## `POST /runs/:id/discard?repo=<path>`

移除运行的工作树并保留产物。对于组运行，级联以移除所有子工作树。

```bash
curl -s -X POST "http://127.0.0.1:8787/runs/<run_id>/discard?repo=$(pwd)"
```

## `POST /runs/:id/cancel?repo=<path>`

取消活动运行。对于组运行，级联以取消所有活动的子项。

```bash
curl -s -X POST "http://127.0.0.1:8787/runs/<run_id>/cancel?repo=$(pwd)"
```

## `POST /runs/:id/resume?repo=<path>`

在子项现有的工作树中使用新任务重新运行。要求子项具有存储的 `agentSessionId` 并且工作树仍然存在。

```bash
curl -N "http://127.0.0.1:8787/runs/<child_id>/resume?repo=$(pwd)" \
  -H 'Content-Type: application/json' \
  -d '{"task": "fix the failing test: the assertion at line 42 needs to be updated"}'
```

流式传输 `DelegationEvent` NDJSON。重新生成差异，重新运行测试，刷新 `report.md` / `result.json`，并重新计算父组的状态。对于 split 组，它还会重新运行扇入合并，因此缩小一个子项范围可以清除之前的 `conflict`。

## CORS

允许没有 `Origin` 头的请求。默认允许来自 `localhost`、`127.0.0.1` 和 `[::1]` 的浏览器来源。额外的来源来自配置或 `--allow-origin`。
