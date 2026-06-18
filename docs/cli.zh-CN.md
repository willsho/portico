# CLI 参考

`portico` CLI 用于启动 daemon、发现本地 Agent、发送委派请求以及管理 run 工件。

在仓库根目录下，示例使用：

```bash
npm run portico -- <command>
```

当作为二进制文件安装时，使用：

```bash
portico <command>
```

## 命令

```text
portico init
portico start [options]
portico stop
portico daemon start [options]
portico daemon stop
portico agents [--json]
portico delegate --to <agent> --task <task> [options]
portico runs [options]
portico status <run_id> [options]
portico apply <run_id> [options]
portico cancel <run_id> [options]
portico discard <run_id> [options]
portico doctor [--config <path>]
```

## `portico init`

在当前 git 仓库中初始化 Portico 元数据：

```bash
portico init
```

创建：

```text
.portico/config.json
.portico/runs/
.portico/worktrees/
.claude/skills/portico/SKILL.md
.agents/skills/portico/SKILL.md
```

`init` 必须在 git 仓库内运行。已有的 Skill 文件不会被覆盖。

## `portico start`

启动本地 daemon：

```bash
portico start
```

选项：

| 选项 | 含义 |
| --- | --- |
| `--host <host>` | 绑定主机，默认 `127.0.0.1` |
| `--port <port>` | 绑定端口，默认 `8787` |
| `--lan` | 标记 daemon 为有意暴露到 loopback 之外 |
| `--token <token>` | 请求所需的 Bearer token |
| `--allow-origin <origin>` | 额外的允许 CORS origin；可重复使用 |
| `--config <path>` | 配置文件路径 |

别名：

```bash
portico daemon start
```

Portico 在未设置 token 时拒绝 LAN 暴露。

## `portico stop`

停止由本地 pid 文件记录的 daemon：

```bash
portico stop
portico daemon stop
```

如果 pid 文件已过期，Portico 会将其删除。

## `portico agents`

列出已发现的 Agent：

```bash
portico agents
portico agents --json
```

发现机制使用 provider 默认值、环境变量路径覆盖（如 `PORTICO_CODEX_PATH`）、PATH 查找、login-shell PATH 恢复以及配置覆盖。

## `portico delegate`

启动一个委派 run：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Add the requested feature" \
  --test "npm test"
```

必选：

| 选项 | 含义 |
| --- | --- |
| `--to <agent>` | 目标 provider id |
| `--task <task>` | 自包含的任务提示 |

常用选项：

| 选项 | 含义 |
| --- | --- |
| `--from <agent>` | 调用方/根 Agent 标签 |
| `--repo <path>` | 仓库路径；默认为当前目录 |
| `--mode implement|review|compare` | 委派模式；默认 `implement` |
| `--compare-to <agent>` | 额外的 compare 候选；可重复使用 |
| `--test <cmd>` | 测试命令；可重复使用 |
| `--allowed <pattern>` | 允许变更的路径模式；可重复使用 |
| `--forbidden <pattern>` | 禁止变更的路径模式；可重复使用 |
| `--timeout <ms>` | Agent/测试超时 |
| `--json` | 以 JSON 行格式打印委派事件 |
| `--url <url>` | Daemon URL 覆盖 |
| `--token <token>` | Bearer token |

隔离选项：

| 选项 | 含义 |
| --- | --- |
| `--isolation worktree|shared` | 执行工作区 |
| `--base-ref <ref>` | 用于隔离 worktree 的 Git ref |
| `--cleanup manual|onNoChanges|onSuccess|always` | 自动 worktree 清理策略 |
| `--permission-profile default|read-only|auto-edit` | Agent 编辑权限 profile |

示例：

```bash
portico delegate --mode review --to claude --repo . --task "Review the auth flow"
```

```bash
portico delegate \
  --mode compare \
  --to codex \
  --compare-to claude \
  --repo . \
  --task "Implement the parser fix" \
  --test "npm test"
```

## `portico runs`

列出某个仓库的 run：

```bash
portico runs
portico runs --repo .
portico runs --json
```

每行包含：

```text
run_id    status    target_agent    created_at    task
```

## `portico status`

显示某个 run 的详细信息：

```bash
portico status <run_id>
portico status <run_id> --json
```

人类可读输出包括状态、目标、分支、worktree、报告路径、变更文件以及测试摘要。

## `portico apply`

应用一个就绪的实现型 run：

```bash
portico apply <run_id>
```

选项：

| 选项 | 含义 |
| --- | --- |
| `--repo <path>` | 仓库路径 |
| `--json` | 以 JSON 格式打印 `RunDetails` |
| `--url <url>` | Daemon URL 覆盖 |
| `--token <token>` | Bearer token |

`apply` 仅适用于 `implement` run，且要求主 worktree 的已跟踪文件保持干净。

## `portico discard`

移除 run worktree 并保留工件：

```bash
portico discard <run_id>
```

在应用、拒绝或完成 run 检查后使用。

## `portico cancel`

取消一个正在进行中的 run：

```bash
portico cancel <run_id>
```

当 run 仍处于活跃状态时，取消操作会中止受跟踪的进程，并将 run 标记为 `cancelled`。

## `portico doctor`

打印诊断信息：

```bash
portico doctor
portico doctor --config ./path/to/config.json
```

报告包括：

- Node 和平台；
- 配置路径及加载状态；
- 已应用的环境配置；
- login-shell PATH 恢复；
- 已发现的 Agent；
- 端口可用性；
- CORS 及 LAN/token 安全状态。
