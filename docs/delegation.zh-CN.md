# 委派

Portico 委派让一个本地编码 Agent 通过 Portico daemon 将一个有边界的任务交给另一个本地编码 Agent。结果是一个持久的 run，包含日志、报告，以及对于实现型工作来说一个可审查的 patch。

委派刻意不是直接的 Agent 到 Agent 的 shell 调用。Portico 控制 run 的整个生命周期：工作区选择、路径策略、测试、工件以及 apply/discard。

## 快速开始

启动 daemon：

```bash
portico daemon start
```

委派一个实现型任务：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Add a dark mode toggle to settings" \
  --test "npm test"
```

检查结果：

```bash
portico runs
portico status <run_id>
```

审查后应用或丢弃：

```bash
portico apply <run_id>
portico discard <run_id>
```

## Run 生命周期

每个委派 run 都经历相同的大致生命周期：

1. Portico 验证请求并查找目标 Agent。
2. Portico 解析仓库根目录。
3. Portico 准备工作区。
4. Portico 使用自包含的任务提示运行目标 Agent。
5. 对于实现型 run，Portico 生成 `diff.patch`。
6. Portico 强制执行路径策略。
7. Portico 运行配置的测试。
8. Portico 写入 `result.json` 和 `report.md`。
9. 用户决定 apply 还是 discard。

目标 Agent 绝不会将更改应用回调用方的主 checkout。对于隔离的实现型 run，它会在 run 工作区中留下磁盘上的更改；Portico 将这些更改转为 patch。

## 模式

Portico 支持三种委派模式：

| 模式 | 用途 | 默认工作区 | 可直接 apply？ |
| --- | --- | --- | --- |
| `implement` | 为有边界的编码任务生成 patch | `worktree` | 是 |
| `review` | 请求另一个 Agent 进行检查并报告 | `shared` | 否 |
| `compare` | 生成多个候选实现 | 候选 worktree | 否，apply 选中的候选 |

如果省略 `mode`，Portico 使用 `implement`。

## 工件

每个 run 在 `.portico/runs/<run_id>/` 下写入工件：

| 工件 | 含义 |
| --- | --- |
| `task.json` | 原始请求及规范化执行设置 |
| `events.ndjson` | Portico 委派事件流 |
| `agent.ndjson` | 目标 Agent 运行时事件 |
| `diff.patch` | 实现型 run 的 patch；只读 review run 为空 |
| `test.log` | 配置的测试命令输出 |
| `report.md` | 人类可读摘要 |
| `result.json` | 稳定的机器可读结果 |

最终的 `run_done` 事件包含 `reportPath` 和 `resultPath`。

## 路径策略

委派可以约束 run 可以更改哪些文件：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Update the settings panel" \
  --allowed "src/**" \
  --allowed "tests/**" \
  --forbidden "src/secrets/**"
```

默认禁止路径为：

```text
.env
.ssh/**
node_modules/**
dist/**
build/**
```

路径策略在 diff 生成之后、run 变为 ready 之前执行。

## 测试

测试命令来自重复传入的 `--test` 标志或 `.portico/config.json`：

```bash
portico delegate \
  --to claude \
  --repo . \
  --task "Fix the parser edge case" \
  --test "npm test" \
  --test "npm run typecheck"
```

测试在执行工作区中运行。如果测试失败，run 状态变为 `failed`，但工件仍可供诊断。

## Apply

只有 `implement` run 可以被应用：

```bash
portico apply <run_id>
```

`apply` 在以下情况拒绝执行：

- run 不是 `ready` 状态；
- run 模式不是 `implement`；
- run 没有 `diff.patch`；
- 主 worktree 有已跟踪的更改；
- `git apply` 失败。

应用的更改作为普通未暂存的文件更改落在主 worktree 中。Portico 不会提交它们。

## Discard

Discard 移除 run worktree 并保留工件：

```bash
portico discard <run_id>
```

这在应用 patch、拒绝 patch 或清理不再需要就地检查的失败 run 时很有用。

## 编写良好的委派任务

被委派方获得一个全新的进程，只接收 Portico 发送给它的任务提示。好的任务是自包含的：

- 陈述目标；
- 命名需要首先检查的文件、目录或符号；
- 定义"完成"的含义；
- 提及约束条件和不应触碰的文件；
- 在相关时包含验证命令。

好的示例：

```text
In src/settings.tsx add a dark-mode toggle wired to the existing useTheme() hook.
Persist the choice in localStorage under "theme". Match existing toggle styling.
Done when the toggle flips the theme and the choice survives a reload.
```

弱的示例：

```text
add dark mode
```
