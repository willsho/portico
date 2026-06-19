# CLI 参考

`portico` CLI 启动守护进程，发现本地代理，发送委派请求，并管理运行产物。

从仓库检出运行，示例使用：

```bash
npm run portico -- <command>
```

作为二进制文件安装时，使用：

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
portico delegate --to <agent> (--task <task> | --task-file <path>) [options]
portico runs [options]
portico status <run_id> [options]
portico logs <run_id> [options]
portico apply <run_id> [options]
portico cancel <run_id> [options]
portico discard <run_id> [options]
portico doctor [--config <path>] [options]
```

所有命令都支持使用 `-h` 或 `--help` 标志来打印其特定用法和可用选项。

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

`init` 必须在 git 仓库内运行。不会覆盖现有的 skill 文件。

## `portico start`

启动本地守护进程：

```bash
portico start
```

选项：

| 选项 | 含义 |
| --- | --- |
| `--host <host>` | 绑定主机，默认 `127.0.0.1` |
| `--port <port>` | 绑定端口，默认 `8787` |
| `--lan` | 将守护进程标记为有意暴露在环回（loopback）之外 |
| `--token <token>` | 请求所需的 Bearer 令牌 |
| `--allow-origin <origin>` | 额外允许的 CORS 来源；可重复 |
| `--config <path>` | 配置文件路径 |

别名：

```bash
portico daemon start
```

如果没有令牌，Portico 拒绝 LAN 暴露。

如果已记录守护进程且其仍在运行，`portico start` 将打印 `daemon already running (pid ..., port ..., ...)` 并成功退出。

## `portico stop`

停止由本地 pid 文件记录的守护进程：

```bash
portico stop
portico daemon stop
```

如果 pid 文件已过期，Portico 会将其移除。

## `portico agents`

列出已发现的代理：

```bash
portico agents
portico agents --json
```

发现过程使用提供商默认值、环境路径覆盖（如 `PORTICO_CODEX_PATH`）、PATH 查找、登录 shell PATH 恢复以及配置覆盖。

## `portico delegate`

启动委派运行：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Add the requested feature" \
  --test "npm test"
```

必需参数：

| 选项 | 含义 |
| --- | --- |
| `--to <agent>` | 目标提供商 ID |
| `--task <task>` | 自包含任务提示（需要明确提供 `--task` 或 `--task-file` 其中之一） |
| `--task-file <path>` | 从 UTF-8 文件或 stdin (`-`) 读取任务提示 |

常用选项：

| 选项 | 含义 |
| --- | --- |
| `--from <agent>` | 调用/根代理标签 |
| `--repo <path>` | 仓库路径；默认当前目录 |
| `--mode implement|review|compare|split` | 委派模式；默认 `implement` |
| `--compare-to <agent>` | 额外的 compare 候选者；可重复 |
| `--child <json>` | 子项规范（JSON）；可重复。split 模式下 `task` 是必需的 |
| `--merge none|sequential|integration` | 扇入合并策略（split → `integration`，compare → `none`） |
| `--judge-to <agent>` | 可选的只读裁判，针对候选者/合并结果 |
| `--judge-instruction <text>` | 覆盖裁判的默认审查指令 |
| `--resume <child_id>` | 在现有工作树中使用新任务重新运行子项（需要 `--task` 或 `--task-file`） |
| `--test <cmd>` | 测试命令；可重复 |
| `--allowed <pattern>` | 允许更改的路径模式；可重复 |
| `--forbidden <pattern>` | 禁止更改的路径模式；可重复 |
| `--timeout <ms>` | 代理/测试超时时间 |
| `--json` | 以 JSON 行的形式打印委派事件 |
| `--url <url>` | 守护进程 URL 覆盖 |
| `--token <token>` | Bearer 令牌 |

隔离选项：

| 选项 | 含义 |
| --- | --- |
| `--isolation worktree|shared` | 执行工作区 |
| `--base-ref <ref>` | 用于隔离工作树的 Git 引用（ref） |
| `--cleanup manual|onNoChanges|onSuccess|always` | 自动工作树清理策略 |
| `--permission-profile default|read-only|auto-edit` | 代理编辑权限配置 |

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
  --test "npm test" \
  --judge-to gemini
```

将一个任务拆分为互补的子任务并合并结果：

```bash
portico delegate \
  --mode split \
  --to claude \
  --repo . \
  --task "Add OAuth login end-to-end" \
  --child '{"to":"claude","task":"Backend routes","allowedPaths":["src/server/**"]}' \
  --child '{"to":"codex","task":"Login UI","allowedPaths":["src/web/**"]}'
```

原地迭代单次子运行（在其现有工作树中重新运行，重新生成差异，重新运行测试，并重新计算组）：

```bash
portico delegate --resume <child_id> --task "the test fails because X; fix only Y"
# 或者
cat feedback.md | portico delegate --resume <child_id> --task-file -
```

恢复操作需要子项的适配器支持原生会话恢复（Claude 支持；generic-CLI 适配器可能不支持）且工作树仍然存在。

如果工作树隔离的运行更改了调用者主检出中的文件，人类可读的输出将打印 `WARNING: sandbox escape detected` 块。JSON 输出包含带有更改路径的 `sandbox_escape_detected` 事件。当可用时，委派连接失败还会包含守护进程 URL 和更具体的连接、超时、DNS 或中止原因。

## `portico runs`

列出仓库的运行记录：

```bash
portico runs
portico runs --repo .
portico runs --json
portico runs --flat
```

默认情况下，`runs` 显示一个折叠视图，其中嵌套了组运行及其子项：

```text
run_abc_group  compare  partial  (3 children: 2 ready, 1 failed)
  ├─ run_def_a  claude  ready    a-label
  ├─ run_ghi_b  codex   ready    b-label
  └─ run_jkl_c  gemini  failed
```

单个（非组）行包含：

```text
run_id    status    target_agent    created_at    task
```

`--flat` 返回旧版扁平列表，每个运行（组和子项）占一行。

## `portico status`

显示运行的详细信息：

```bash
portico status <run_id>
portico status <run_id> --json
portico status <run_id> --json --summary
portico status <run_id> --json --fields status,changedFiles,telemetry
```

人类可读输出包含状态、目标、分支、工作树、报告路径、更改的文件、沙箱逃逸警告、门控警告、遥测以及测试摘要。

`--json` 返回删除了重复嵌套的 `result.run` 和 `result.artifacts` 的 `RunDetails`。`--summary` 为脚本和 LLM 调用者返回一个紧凑的顶级对象。`--fields` 从摘要视图中选择以逗号分隔的字段。

## `portico logs`

流式传输或跟随运行的事件日志：

```bash
portico logs <run_id>
portico logs <run_id> --follow
portico logs <run_id> --json
```

打印现有的委派事件和代理进度。如果指定了 `--follow`，它将继续轮询并打印新事件，直到运行完成（`run_done` 或 `run_error`）。`--json` 标志输出原始 NDJSON 事件，而不是格式化的人类可读输出。

## `portico apply`

应用就绪的运行：

```bash
portico apply <run_id>                 # single implement run (单次实现运行)
portico apply <group_id> --child <id>  # compare group: pick one candidate (比较组：选择一个候选者)
portico apply <group_id> --all         # split group: apply the merged patch (拆分组：应用合并补丁)
```

选项：

| 选项 | 含义 |
| --- | --- |
| `--repo <path>` | 仓库路径 |
| `--child <child_id>` | 应用 compare 组中的一个候选者 |
| `--all` | 应用 split 组的合并补丁 |
| `--json` | 以 JSON 格式打印 `RunDetails` |
| `--url <url>` | 守护进程 URL 覆盖 |
| `--token <token>` | Bearer 令牌 |

单次运行必须是 `implement`。compare 组需要 `--child`；split 组使用 `--all`（当组处于 `conflict` 状态时拒绝）。`apply` 需要主工作树的已跟踪文件处于干净状态。

## `portico discard`

移除运行的工作树并保留产物：

```bash
portico discard <run_id>
```

在应用、拒绝或完成对运行的检查后使用此命令。对于组运行，丢弃会级联删除每个子项的工作树（以及 split 组的集成工作树）；它是幂等的。

## `portico cancel`

取消进行中的运行：

```bash
portico cancel <run_id>
```

取消会中止处于活动状态的运行的受跟踪进程，并将运行标记为 `cancelled`。对于组运行，取消会级联到每个活动的子项；它是幂等的。

## `portico doctor`

打印诊断信息：

```bash
portico doctor
portico doctor --config ./path/to/config.json
```

报告包含：

- Node 和平台；
- 配置路径和加载状态；
- 应用的环境配置；
- 登录 shell PATH 恢复；
- 发现的代理；
- 端口可用性；
- CORS 和 LAN/令牌态势。
