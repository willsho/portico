# 配置

Portico 有两个配置层：

1. 守护进程配置，默认从 `~/.portico/config.json` 加载；
2. 仓库委派配置，存储在 `.portico/config.json`。

命令行选项和环境变量可以覆盖守护进程配置。

## 守护进程配置优先级

守护进程设置按以下顺序解析：

1. CLI 标志；
2. 环境变量；
3. 守护进程配置文件；
4. 内置默认值。

使用 `portico doctor` 查看已加载的内容：

```bash
portico doctor
portico doctor --config ./daemon-config.json
```

## 默认守护进程配置

内置默认值：

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "allowOrigins": [],
  "lan": false,
  "agents": {},
  "limits": {
    "defaultTimeoutMs": 120000,
    "maxContextChars": 120000,
    "maxOutputChars": 200000
  },
  "reloadIntervalMs": 60000
}
```

默认未设置 `token`。

## 守护进程配置文件

默认路径：

```text
~/.portico/config.json
```

覆盖路径：

```bash
portico start --config ./portico-daemon.json
portico doctor --config ./portico-daemon.json
```

示例：

```json
{
  "host": "127.0.0.1",
  "port": 8799,
  "allowOrigins": ["http://localhost:3000"],
  "agents": {
    "codex": {
      "path": "/opt/bin/codex"
    },
    "gemini": {
      "enabled": false
    }
  },
  "limits": {
    "defaultTimeoutMs": 180000,
    "maxContextChars": 200000,
    "maxOutputChars": 400000
  },
  "reloadIntervalMs": 30000
}
```

## CLI 覆盖

`portico start` 支持：

```bash
portico start \
  --host 127.0.0.1 \
  --port 8799 \
  --allow-origin http://localhost:3000
```

LAN 暴露需要令牌：

```bash
portico start \
  --host 0.0.0.0 \
  --lan \
  --token "$PORTICO_TOKEN"
```

## 环境变量

守护进程配置环境变量：

| 变量 | 含义 |
| --- | --- |
| `PORTICO_CONFIG` | 配置文件路径 |
| `PORTICO_HOST` | 绑定主机 |
| `PORTICO_PORT` | 绑定端口 |
| `PORTICO_TOKEN` | Bearer 令牌 |
| `PORTICO_ALLOW_ORIGIN` | 以逗号分隔的额外 CORS 来源 |

代理路径覆盖：

| 提供商 | 环境变量 |
| --- | --- |
| Codex | `PORTICO_CODEX_PATH` |
| Claude Code | `PORTICO_CLAUDE_PATH` |
| Gemini CLI | `PORTICO_GEMINI_PATH` |
| Antigravity CLI | `PORTICO_ANTIGRAVITY_PATH` |
| OpenCode | `PORTICO_OPENCODE_PATH` |
| openclaw | `PORTICO_OPENCLAW_PATH` |
| Hermes | `PORTICO_HERMES_PATH` |

带有固定测试数据（fixtures）的示例：

```bash
export PORTICO_CODEX_PATH="$PWD/test/fixtures/fake-agent.mjs"
portico agents
```

## 代理覆盖

守护进程配置可以覆盖提供商发现过程：

```json
{
  "agents": {
    "codex": {
      "path": "/absolute/path/to/codex"
    },
    "claude": {
      "enabled": false
    }
  }
}
```

`path` 将代理标记为可用，并将其来源设置为 `config`。

`enabled: false` 将提供商标记为不可用，原因为“Disabled in config.”（在配置中禁用）。

## 限制（Limits）

限制适用于 `/chat` 默认值：

| 字段 | 含义 |
| --- | --- |
| `defaultTimeoutMs` | 默认代理超时时间 |
| `maxContextChars` | 默认上下文截断限制 |
| `maxOutputChars` | 默认子进程输出上限 |

单个聊天请求可以通过 `ChatRequest.options` 覆盖这些限制。

委派请求可以设置 `timeoutMs`；测试命令使用相同的超时时间。

## 重载间隔

`reloadIntervalMs` 控制后台代理重新发现。

```json
{
  "reloadIntervalMs": 0
}
```

将其设置为 `0` 可以禁用定期刷新。您仍然可以手动刷新：

```bash
curl -X POST http://127.0.0.1:8787/reload
```

## 仓库配置

`portico init` 创建：

```text
.portico/config.json
```

初始内容：

```json
{
  "testCommands": []
}
```

省略 `--test` 时，委派会使用这些命令：

```json
{
  "testCommands": [
    "npm run typecheck",
    "npm test"
  ]
}
```

命令行 `--test` 标志在该次运行中具有优先权。

## 发现故障排除

运行：

```bash
portico doctor
```

检查：

- 守护进程配置文件是否加载；
- 环境变量是否已应用；
- 登录 shell PATH 恢复是否找到了额外的目录；
- 提供商是否可用；
- 使用了哪个路径/来源；
- 配置的守护进程端口是否空闲。
