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
portico review <run_id> [options]
portico integrate <group_id> [options]
portico logs <run_id> [options]
portico apply <run_id> [options]
portico cancel <run_id> [options]
portico discard <run_id> [options]
portico cleanup [options]
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

`init` 必须在 git 仓库内运行。现有的 `.portico/config.json` 文件不会被覆盖。上述路径中由 Portico 管理的 skill 文件会在每次运行时从规范的捆绑 Skill 中刷新；其他项目级别的 skill 不会被触碰。

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

在绑定之前，`start` 会运行预检（preflight），以便及早暴露沙箱/权限问题，而不是让第一次 `delegate` 失败。如果 pidfile 位置不可写，守护进程仍然会启动并处理请求，但 `portico stop` 和发现功能会受限（它会打印警告说明这一点）。如果当前仓库的 `.portico` / `.git` 目录不可写，它会警告在那里进行委派将无法创建工作树，并提示授予写入访问权限或在沙箱外运行。

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
| `--name <slug>` | 在 `runs` / `watch` 中显示的人类可读运行名称（默认为任务的 slug） |
| `--test <cmd>` | 测试命令；可重复 |
| `--verify <cmd>` | 验证检查，在报告中与测试分开展示（如文档/策略检查）；可重复 |
| `--allowed <pattern>` | 允许更改的路径模式；可重复 |
| `--forbidden <pattern>` | 禁止更改的路径模式；可重复 |
| `--timeout <ms>` | 代理/测试超时时间 |
| `--json` | 以 JSON 行的形式打印委派事件 |
| `--review-summary` | 运行结束后打印一键 apply 命令及风险摘要 |
| `--apply-on-ready` | 当所有安全检查通过时，自动应用单个就绪的运行（选择性加入；见下文） |
| `--auto-start` | 如果环回守护进程未运行，则启动它并重试请求一次 |
| `--detach` | 运行注册后立即退出并打印其 ID；运行会在守护进程上继续执行 |
| `--notify` | 当运行达到终点状态（`ready`/`partial`/`conflict`/`failed`）时触发系统通知；与 `--detach` 配合使用。目前仅支持 macOS |
| `--follow <run_id>` | 重新附加到运行的事件日志（等同于 `logs --follow`）；忽略其他运行标志 |
| `--url <url>` | 守护进程 URL 覆盖 |
| `--token <token>` | Bearer 令牌 |

`--apply-on-ready` 仅应用**单个**就绪的运行，且仅当所有条件满足时：你传递了 `--allowed`（路径边界），主工作树的已跟踪文件是干净的，路径策略通过，未检测到沙箱逃逸，并且所有测试和验证检查通过。如果任何条件未满足，它不会应用任何内容，并打印未满足的项以及审查摘要。`--auto-start` 仅限环回——永远不会自动启动 LAN/远程守护进程。

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
portico runs --status failed,cancelled
portico runs --since 2h
portico runs --watch
```

默认情况下，`runs` 显示一个折叠视图，其中嵌套了组运行及其子项。运行的名称（来自 `--name`，否则是任务的 slug）在每行的开头，组行显示 `children <ready>/<total> ready`：

```text
run_abc_group  fan-out  compare  partial  (children 2/3 ready, 1 failed)
  ├─ run_def_a  claude  ready    a-label
  ├─ run_ghi_b  codex   ready    b-label
  └─ run_jkl_c  gemini  failed
```

单个（非组）行包含：

```text
run_id    name    status    target_agent    created_at    task
```

`--flat` 返回旧版扁平列表，每个运行（组和子项）占一行。

| 选项 | 含义 |
| --- | --- |
| `--status <s1,s2>` | 仅保留状态在此逗号分隔集中的运行 |
| `--since <dur>` | 仅保留在时间窗口内创建的运行（`90s`, `30m`, `2h`, `1d`；纯数字表示秒） |
| `--watch` | 打开实时状态面板（等同于 `portico watch`，共享这些过滤器） |

具有活动代理进程的运行在人类可读输出中会被标记为 `[active]`。

## `portico watch`

运行状态的实时面板——`runs` 的多运行配套工具。它定期轮询运行列表，按状态将运行分组，并将需要决定的运行显示在顶部：

```bash
portico watch
portico watch --needs-review        # 仅 ready / partial / conflict
portico watch --to codex            # 仅显示针对一个代理的运行
portico watch --once                # 打印一次快照，然后退出
```

```text
portico watch   3 ready · 1 conflict · 2 active

Needs decision
    ready     dark-mode      codex      add a dark mode toggle             2m
  ● partial   fan-out        codex,…    split · 2/3 ready · 1 failed       1m
    └ ready   backend        codex      implement the API                  1m

Working
  ● running   flaky-test     claude     investigate the flaky checkout…    30s

Done
    applied   sound-effects  codex      export the SFX                     4h
    … 6 more done
```

分组：需要决定的（`ready`/`partial`/`conflict`）在顶部，然后是工作中的，最后是已完成的。较旧的已完成运行折叠到 `… N more done` 行中；失败的运行始终保持可见。

使用 `↑`/`↓` 选择一行并内联操作它——面板委托给现有的命令，并且绝不放宽任何门控条件：

| 按键 | 动作 |
| --- | --- |
| `a` | 应用（先显示单行检查守卫，然后要求确认） |
| `d` / `c` | 丢弃 / 取消（需要确认） |
| `f` | 跟随运行的事件日志 |
| `r` / `i` | 审查 / 集成（组运行） |
| `enter` | 显示运行状态（查看） |
| `q` / `esc` | 退出 |

| 选项 | 含义 |
| --- | --- |
| `--needs-review` | `--status ready,partial,conflict` 的简写 |
| `--to <agent>` | 仅限目标为此代理的运行（保留包含匹配子项的组） |
| `--status <s1,s2>` / `--since <dur>` | 与 `runs` 相同的服务端过滤器 |
| `--interval <ms>` | 轮询间隔（默认 `2000`） |
| `--notify` | 当运行转换到需要决定或失败的状态时触发系统通知 |
| `--once` / `--json` | 打印单个快照并退出（当 stdout 不是 TTY 时的默认行为） |

面板是一个手写的 ANSI TUI，没有额外的依赖项。当 stdout 不是 TTY（管道或重定向），或使用 `--once` / `--json` 时，它打印一个快照并退出，因此它保持可编写脚本性。

## `portico status`

显示运行的详细信息：

```bash
portico status <run_id>
portico status <run_id> --json
portico status <run_id> --json --summary
portico status <run_id> --json --fields status,changedFiles,telemetry
```

人类可读输出包含状态、实时进度（当前阶段，代理是否仍在运行，以及最后记录的事件及其时间）、目标、分支、工作树、报告/事件/差异路径、更改的文件、沙箱逃逸警告、门控警告、遥测以及测试摘要。

`--json` 返回删除了重复嵌套的 `result.run` 和 `result.artifacts` 的 `RunDetails`（包含 `progress` 对象）。`--summary` 为脚本和 LLM 调用者返回一个紧凑的顶级对象。`--fields` 从摘要视图中选择以逗号分隔的字段。

## `portico review`

把一个组运行的所有子项（或单个运行）汇聚成一个审查视图，免去逐个打开子项的 status、报告和 diff：

```bash
portico review <run_id>
portico review <run_id> --ready-only
portico review <run_id> --json
portico review <run_id> --open-diff
```

每个子项显示 label、状态、改动文件数、测试/验证/策略结果，以及报告和 diff 路径，并给出每个子项的下一步动作（ready 时 `apply --child`，failed 时 `delegate --resume`）。同时高亮**被多个子项同时改动的重叠文件**——这些是需要人工仔细合并的地方。

| 选项 | 说明 |
| --- | --- |
| `--ready-only` | 仅显示就绪、可应用的子项 |
| `--json` | 输出结构化汇总（子项 + 重叠） |
| `--open-diff` | 额外内联打印每个所示子项的完整差异 |

## `portico integrate`

按需合并组中**就绪**的子项为一个补丁：

```bash
portico integrate <group_id>
portico integrate <group_id> --json
```

与自动的 split 扇入不同，`integrate` 不需要每个子项都准备就绪，所以它可以组合一个 `partial` 组（一些子项失败/取消，一些恢复到就绪状态）或使用 `--merge none` 创建的组。它复用 split 三方合并到一个全新的集成工作树中：

- 在干净合并时，它会写入合并后的组 `diff.patch` 并报告应用顺序；使用 `portico apply <group_id> --all` 应用它。
- 在发生冲突时，它会列出冲突的文件、其源子项以及建议的审查顺序，并不会留下可应用的合并补丁。使用 `delegate --resume` 缩小范围，然后再次运行 `integrate`。

比较组被拒绝（`integrate_unsupported`）——其子项是相同任务的竞争实现，所以使用 `apply <group_id> --child <child_id>` 选择一个。

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

单次运行必须是 `implement`。compare 组需要 `--child`；split 组或已集成组使用 `--all`（当组处于 `conflict` 状态或没有合并补丁时拒绝——请先运行 `portico integrate <group_id>`）。`apply` 需要主工作树的已跟踪文件处于干净状态。

## `portico discard`

移除运行工作树并保留产物：

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

## `portico cleanup`

回收已完成的运行：

```bash
portico cleanup --failed
portico cleanup --failed --older-than 7d
portico cleanup --status failed,cancelled --purge
```

默认情况下 `cleanup` 只移除工作树，并**保留**每次运行的产物（`report.md` / `diff.patch` / `events.ndjson`）用于事后检查。`ready` / `applied` 的运行以及任何正在进行中的运行都不会被触碰。

| 选项 | 含义 |
| --- | --- |
| `--failed` | 目标为 failed + cancelled 的运行（未给出 `--status` 时的默认行为） |
| `--status <s1,s2>` | 要回收的显式状态；覆盖 `--failed`（ready/applied 仍然受保护） |
| `--older-than <dur>` | 仅清理在这段时间之前完成的运行（`1h`, `7d`；纯数字表示秒） |
| `--purge` | 同时删除产物，不仅是工作树 |
| `--json` | 输出结构化的 `{ cleaned, skipped }` 结果 |

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
