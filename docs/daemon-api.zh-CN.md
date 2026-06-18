# Daemon API

Portico daemon 暴露一个本地 HTTP API。JSON 端点返回 JSON 响应。流式端点返回换行分隔的 JSON。

默认基础 URL：

```text
http://127.0.0.1:8787
```

## 认证

如果 daemon 配置了 token，每个请求必须包含：

```http
Authorization: Bearer <token>
```

未配置 token 时，请求无需认证即可接受。除非配置了 token，否则 LAN 暴露会被拒绝。

## 错误格式

JSON 错误响应使用：

```json
{
  "error": "Human-readable message.",
  "code": "machine_code"
}
```

流式端点可能在流开始前返回普通 JSON 错误，或者在 NDJSON 流中发出终止性的 `error` 事件。

## `GET /health`

返回 daemon 健康状态和版本。

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

返回已发现的 Agent。

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

重新运行 Agent 发现并返回新的 Agent 列表。

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

运行一次 Agent turn，并将 `RuntimeEvent` 对象以 NDJSON 格式流式输出。

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

请求格式：

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

流式事件示例：

```json
{"type":"start","sessionId":"...","provider":"claude"}
{"type":"content","delta":"..."}
{"type":"reasoning","delta":"..."}
{"type":"tool_call","name":"Read","input":{"file_path":"README.md"}}
{"type":"tool_result","name":"Read","output":"..."}
{"type":"done","message":"..."}
```

响应还包含：

```http
X-Portico-Session: <session_id>
```

在后续请求中发送该 session id 以继续会话（当 provider 支持 resume 且 `cwd` 匹配时）。

## `GET /sessions`

列出内存中的 session。

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

从内存存储中删除一个 session 句柄。

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

启动一个委派 run，并将 `DelegationEvent` 对象以 NDJSON 格式流式输出。

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

请求格式：

```ts
interface DelegateRequest {
  from?: string;
  to: string;
  compareTargets?: string[];
  repo: string;
  task: string;
  mode?: "implement" | "review" | "compare";
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

## `GET /runs?repo=<path>`

列出某个仓库的委派 run。

```bash
curl -s "http://127.0.0.1:8787/runs?repo=$(pwd)"
```

响应：

```json
{
  "runs": []
}
```

## `GET /runs/:id?repo=<path>`

返回 run 详细信息。

```bash
curl -s "http://127.0.0.1:8787/runs/<run_id>?repo=$(pwd)"
```

响应格式：

```ts
interface RunDetails {
  run: Run;
  artifacts: RunArtifact;
  result?: RunResult;
}
```

## `GET /runs/:id/events?repo=<path>`

以 NDJSON 格式返回存储的委派事件日志。

```bash
curl -N "http://127.0.0.1:8787/runs/<run_id>/events?repo=$(pwd)"
```

## `POST /runs/:id/apply?repo=<path>`

应用一个就绪的实现型 run。

```bash
curl -s -X POST "http://127.0.0.1:8787/runs/<run_id>/apply?repo=$(pwd)"
```

只有 `implement` run 可以被应用。

## `POST /runs/:id/discard?repo=<path>`

移除 run worktree 并保留工件。

```bash
curl -s -X POST "http://127.0.0.1:8787/runs/<run_id>/discard?repo=$(pwd)"
```

## `POST /runs/:id/cancel?repo=<path>`

取消一个活跃的 run。

```bash
curl -s -X POST "http://127.0.0.1:8787/runs/<run_id>/cancel?repo=$(pwd)"
```

## CORS

不带 `Origin` 头的请求被允许。来自 `localhost`、`127.0.0.1` 和 `[::1]` 的浏览器 origin 默认允许。额外的 origin 来自配置或 `--allow-origin`。
