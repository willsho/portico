# 隔离与权限

Portico 将工作区隔离和 Agent 编辑权限视为独立的决策。这借鉴了 Claude Code 子 Agent 隔离的有用部分，同时保持 Portico 的 patch 审查和 apply 关卡显式化。

## 心智模型

有两个独立的问题：

1. 目标 Agent 在哪里运行？
2. 目标 Agent 是否允许自主编辑？

Portico 用 `isolation` 回答第一个问题，用 `permissionProfile` 回答第二个。

## 工作区隔离

`--isolation` 控制执行工作区：

| 值 | 含义 |
| --- | --- |
| `worktree` | 在 `.portico/worktrees/<run_id>` 下创建隔离的 git worktree |
| `shared` | 在调用方的仓库 checkout 中运行 |

实现型 run 默认使用 `worktree`：

```bash
portico delegate --to codex --repo . --task "Implement X"
```

Review run 默认使用 `shared`：

```bash
portico delegate --mode review --to claude --repo . --task "Review the current code"
```

你可以显式覆盖工作区：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Implement X" \
  --isolation worktree
```

共享工作区的实现型 run 受支持，但刻意设计为高级路径：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Make this direct edit in the current checkout" \
  --isolation shared \
  --permission-profile auto-edit
```

对于共享 auto-edit run，Portico 要求工作树在 run 之前是干净的。这让 Portico 能够将生成的 diff 归因于被委派的 Agent。

## Base Ref

`--base-ref` 控制创建隔离 worktree 时使用的 git ref：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Implement X" \
  --base-ref main
```

默认值为 `HEAD`。

使用 `defaultBranch` 让 Portico 尽量从仓库的默认分支创建：

```bash
portico delegate \
  --to claude \
  --repo . \
  --task "Try this from the default branch" \
  --base-ref defaultBranch
```

`defaultBranch` 的解析顺序为：

1. `refs/remotes/origin/HEAD`；
2. 当前分支；
3. `HEAD`。

`baseRef` 仅对 `worktree` 隔离有意义。

## 清理策略

`--cleanup` 控制 Portico 何时自动移除隔离的 worktree：

| 值 | 行为 |
| --- | --- |
| `manual` | 保留 worktree 直到 `portico discard <run_id>` |
| `onNoChanges` | 当 run 没有产生变更文件时移除 worktree |
| `onSuccess` | 当 run 变为 `ready` 时移除 worktree |
| `always` | 在完成或失败后移除 worktree |

示例：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Check whether this change is needed" \
  --cleanup onNoChanges
```

即使 worktree 被移除，run 工件仍保留在 `.portico/runs/<run_id>/` 下。报告会在清理发生时记录 `Worktree Removed At`。

使用 `onSuccess` 时需注意：patch 工件仍然存在，因此 `apply` 仍然可以工作，但活跃的 worktree 已不存在。

## 权限 Profile

`--permission-profile` 控制 Portico 是否向 provider adapter 请求自主编辑：

| Profile | 含义 |
| --- | --- |
| `default` | 不请求 provider 特定的自动编辑标志 |
| `read-only` | 将 run 视为只读；review 模式要求此选项 |
| `auto-edit` | 请求 provider 特定的编辑权限，例如 Codex 的 `--full-auto` 或 Claude 的 `acceptEdits` |

默认值：

| 模式 | 默认 profile |
| --- | --- |
| `implement` + `worktree` | `auto-edit` |
| `implement` + `shared` | `default` |
| `review` | `read-only` |
| `compare` 候选 | `auto-edit` |

只读共享 run 会在 Agent 运行前后对 `git status --porcelain` 进行快照。如果 Agent 更改了共享工作树，run 会以 `read_only_modified` 失败。

## 推荐默认值

除非有特定原因，否则使用以下设置：

| 任务 | 推荐设置 |
| --- | --- |
| 普通实现 | `--isolation worktree --permission-profile auto-edit` |
| 只读审查 | `--mode review` |
| 独立实验 | `--mode compare` |
| 从 main/默认分支尝试 | `--base-ref main` 或 `--base-ref defaultBranch` |
| 快速无变更调查 | `--cleanup onNoChanges` |

除非用户明确希望目标 Agent 直接修改当前 checkout，否则避免共享 auto-edit。

## 隔离不做什么

工作区隔离保护调用方的 checkout 不受直接文件更改的影响。它不会：

- 沙箱化网络访问；
- 对子进程隐藏环境变量；
- 阻止 provider CLI 使用其自身的本地配置；
- 替代路径策略、测试或人工审查。

Portico 的安全模型是分层的：隔离工作区、权限 profile、路径策略、测试、工件和显式 apply。
