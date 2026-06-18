# 快速入门

本指南将 Portico 在本地运行起来，验证 Agent 发现，并带你完成第一次委派 run。

## 环境要求

Portico 当前直接从仓库运行，使用 Node 的原生 type stripping。

- Node.js 20 或更新版本
- npm
- git
- 至少安装了一个受支持的本地编码 Agent，或使用随附的 fake agent fixture

受支持的内置 provider 包括：

| Provider id | 搜索的 CLI |
| --- | --- |
| `codex` | `codex` |
| `claude` | `claude` |
| `gemini` | `gemini` |
| `antigravity` | `agy`, `antigravity` |
| `opencode` | `opencode` |
| `openclaw` | `openclaw` |
| `hermes` | `hermes` |

某些 provider 在其非交互式契约稳定之前可能仅支持发现。

## 安装依赖

在仓库根目录下：

```bash
npm install
```

运行检查：

```bash
npm run typecheck
npm test
```

## 使用 Fake Agent

如果你没有安装真实 Agent，可以将某个 provider 指向 fixture：

```bash
export PORTICO_CODEX_PATH="$PWD/test/fixtures/fake-agent.mjs"
```

对于需要文件编辑的委派流程，使用编辑 fixture：

```bash
export PORTICO_CODEX_PATH="$PWD/test/fixtures/edit-agent.mjs"
```

## 初始化仓库

在 git 仓库内运行：

```bash
npm run portico -- init
```

这将创建：

```text
.portico/config.json
.portico/runs/
.portico/worktrees/
.claude/skills/portico/SKILL.md
.agents/skills/portico/SKILL.md
```

生成的 `.portico/config.json` 初始内容为：

```json
{
  "testCommands": []
}
```

## 启动 Daemon

```bash
npm run portico -- daemon start
```

默认情况下 daemon 监听：

```text
http://127.0.0.1:8787
```

在另一个终端中检查健康状态：

```bash
curl -s http://127.0.0.1:8787/health
```

## 列出 Agent

```bash
npm run portico -- agents
```

或请求 JSON 格式：

```bash
npm run portico -- agents --json
```

如果没有找到 Agent，运行：

```bash
npm run portico -- doctor
```

`doctor` 报告配置来源、PATH 恢复、provider 发现、端口状态、CORS 以及 LAN/token 安全状态。

## 运行 Chat 请求

Daemon 的 `/chat` 端点流式输出 NDJSON 运行时事件：

```bash
curl -N http://127.0.0.1:8787/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "codex",
    "messages": [
      { "role": "user", "content": "Say hello from Portico" }
    ]
  }'
```

预期事件格式：

```json
{"type":"start","sessionId":"...","provider":"codex"}
{"type":"content","delta":"..."}
{"type":"done","message":"..."}
```

## 运行委派

使用编辑 fixture 或真实编码 Agent：

```bash
npm run portico -- delegate \
  --to codex \
  --repo . \
  --task "Create delegated.txt with a short message" \
  --test "test -f delegated.txt"
```

Portico 创建一个 run，执行目标 Agent，生成 diff，运行测试，并在 `.portico/runs/<run_id>/` 下写入工件。

检查 run：

```bash
npm run portico -- runs
npm run portico -- status <run_id>
```

审查后应用：

```bash
npm run portico -- apply <run_id>
```

完成后丢弃 run worktree：

```bash
npm run portico -- discard <run_id>
```

## 下一步阅读

- [CLI 参考](cli.zh-CN.md)
- [委派](delegation.zh-CN.md)
- [隔离与权限](isolation-and-permissions.zh-CN.md)
- [Review 与 Compare](review-and-compare.zh-CN.md)
- [Daemon API](daemon-api.zh-CN.md)
- [配置](configuration.zh-CN.md)
- [Skills](skills.zh-CN.md)
- [安全模型](security-model.zh-CN.md)
