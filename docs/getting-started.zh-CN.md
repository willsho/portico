# 快速入门

本指南将引导您在本地运行 Portico，验证代理发现（agent discovery），并走通第一次委派运行。

## 运行要求

Portico 目前通过 Node 原生的类型剥离（type stripping）直接从仓库运行。

- Node.js 20 或更高版本
- npm
- git
- 至少安装了一个受支持的本地编码代理，或者使用内置的假代理测试用例（fixture）

受支持的内置提供商（providers）包括：

| 提供商 ID | 搜索的 CLI |
| --- | --- |
| `codex` | `codex` |
| `claude` | `claude` |
| `gemini` | `gemini` |
| `antigravity` | `agy`, `antigravity` |
| `opencode` | `opencode` |
| `openclaw` | `openclaw` |
| `hermes` | `hermes` |

在非交互式契约稳定之前，某些提供商可能仅支持发现（discovery-only）。

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

## 使用假代理

如果您没有安装真实的代理，请将提供商指向测试用例（fixture）：

```bash
export PORTICO_CODEX_PATH="$PWD/test/fixtures/fake-agent.mjs"
```

对于需要编辑文件的委派流程，使用编辑测试用例：

```bash
export PORTICO_CODEX_PATH="$PWD/test/fixtures/edit-agent.mjs"
```

## 初始化仓库

在 git 仓库内运行此命令：

```bash
npm run portico -- init
```

这会创建：

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

## 启动守护进程

```bash
npm run portico -- daemon start
```

默认情况下，守护进程监听在：

```text
http://127.0.0.1:8787
```

在另一个终端中，检查健康状态：

```bash
curl -s http://127.0.0.1:8787/health
```

## 列出代理

```bash
npm run portico -- agents
```

或者请求 JSON 格式：

```bash
npm run portico -- agents --json
```

如果未找到代理，请运行：

```bash
npm run portico -- doctor
```

`doctor` 会报告配置来源、PATH 恢复、提供商发现、端口状态、CORS 以及 LAN/令牌态势。

## 运行聊天请求

守护进程的 `/chat` 端点流式传输 NDJSON 运行时事件：

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

预期的事件结构：

```json
{"type":"start","sessionId":"...","provider":"codex"}
{"type":"content","delta":"..."}
{"type":"done","message":"..."}
```

## 运行委派

使用编辑测试用例或真实的编码代理：

```bash
npm run portico -- delegate \
  --to codex \
  --repo . \
  --task "Create delegated.txt with a short message" \
  --test "test -f delegated.txt"
```

Portico 创建一个运行，执行目标代理，生成差异（diff），运行测试，并将产物写入 `.portico/runs/<run_id>/` 下。

检查运行：

```bash
npm run portico -- runs
npm run portico -- status <run_id>
```

审查后应用：

```bash
npm run portico -- apply <run_id>
```

完成后丢弃运行工作树：

```bash
npm run portico -- discard <run_id>
```

## 进阶阅读

- [CLI 参考](cli.zh-CN.md)
- [委派](delegation.zh-CN.md)
- [隔离与权限](isolation-and-permissions.zh-CN.md)
- [审查与比较](review-and-compare.zh-CN.md)
- [守护进程 API](daemon-api.zh-CN.md)
- [配置](configuration.zh-CN.md)
- [技能](skills.zh-CN.md)
- [安全模型](security-model.zh-CN.md)
