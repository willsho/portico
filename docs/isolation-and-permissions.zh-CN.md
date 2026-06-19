# 隔离与权限

Portico 将工作区隔离和代理编辑权限视为独立的决定。这反映了 Claude Code 子代理（subagent）隔离的有用部分，同时保持了 Portico 补丁审查和应用门控的明确性。

## 心智模型

有两个独立的问题：

1. 目标代理在哪里运行？
2. 目标代理是否允许自主编辑？

Portico 使用 `isolation`（隔离）回答第一个问题，使用 `permissionProfile`（权限配置）回答第二个问题。

## 工作区隔离

`--isolation` 控制执行工作区：

| 值 | 含义 |
| --- | --- |
| `worktree` | 在 `.portico/worktrees/<run_id>` 下创建隔离的 git 工作树 |
| `shared` | 在调用者的仓库检出（checkout）中运行 |

实现（Implementation）运行默认为 `worktree`：

```bash
portico delegate --to codex --repo . --task "Implement X"
```

审查（Review）运行默认为 `shared`：

```bash
portico delegate --mode review --to claude --repo . --task "Review the current code"
```

您可以明确地覆盖工作区：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Implement X" \
  --isolation worktree
```

支持共享（shared）实现运行，但它们被有意设计为高级路径：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Make this direct edit in the current checkout" \
  --isolation shared \
  --permission-profile auto-edit
```

对于共享的 auto-edit（自动编辑）运行，Portico 要求工作树在运行前是干净的。这让 Portico 能够将生成的差异归属于受委派的代理。

对于 `worktree` 运行，Portico 在创建隔离的工作树后对调用者的主检出进行快照，并在目标代理退出后再次检查。如果主检出发生了更改，Portico 会将运行标记为 failed，发出 `sandbox_escape_detected`，并在 `result.json` 中记录 `sandboxEscaped: true` 以及 `outOfTreeChanges`。

## 基础引用 (Base Ref)

`--base-ref` 控制创建隔离工作树时使用的 git 引用（ref）：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Implement X" \
  --base-ref main
```

默认值为 `HEAD`。

当 Portico 能够解析时，使用 `defaultBranch` 让它从仓库的默认分支派生：

```bash
portico delegate \
  --to claude \
  --repo . \
  --task "Try this from the default branch" \
  --base-ref defaultBranch
```

`defaultBranch` 的解析顺序为：

1. `refs/remotes/origin/HEAD`;
2. 当前分支；
3. `HEAD`。

`baseRef` 仅对 `worktree` 隔离有意义。

## 清理策略

`--cleanup` 控制 Portico 何时可以自动移除隔离的工作树：

| 值 | 行为 |
| --- | --- |
| `manual` | 保留工作树直到执行 `portico discard <run_id>` |
| `onNoChanges` | 当运行没有产生更改的文件时移除工作树 |
| `onSuccess` | 当运行变为 `ready`（就绪）状态时移除工作树 |
| `always` | 在完成或失败后移除工作树 |

示例：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Check whether this change is needed" \
  --cleanup onNoChanges
```

即使移除了工作树，运行产物仍保留在 `.portico/runs/<run_id>/` 下。清理发生时，报告会记录 `Worktree Removed At`。

小心使用 `onSuccess`：补丁产物会保留，因此 `apply` 仍然可以工作，但实际的工作树已经不存在了。

## 权限配置

`--permission-profile` 控制 Portico 是否要求提供商适配器进行自主编辑：

| 配置 | 含义 |
| --- | --- |
| `default` | 不请求特定于提供商的自动编辑标志 |
| `read-only` | 将运行视为只读；审查（review）模式需要此配置 |
| `auto-edit` | 请求特定于提供商的编辑权限，例如 Codex `--full-auto` 或 Claude `acceptEdits` |

默认值：

| 模式 | 默认配置 |
| --- | --- |
| `implement` + `worktree` | `auto-edit` |
| `implement` + `shared` | `default` |
| `review` | `read-only` |
| `compare` 候选者 | `auto-edit` |

只读（Read-only）的共享（shared）运行在代理运行之前和之后对 `git status --porcelain` 进行快照。如果代理更改了共享工作树，则运行失败并显示 `read_only_modified`。

## 沙箱逃逸检测

工作树隔离是一个审查和归属边界，而不是操作系统级别的文件系统沙箱。某些提供商 CLI 可能会忽略其进程的 cwd 或将路径解析回调用者检出（checkout）。Portico 通过比较代理运行前后的 git 状态快照来检测观察到的对主检出的写入。

检测到树外更改时：

- 运行状态变为 `failed`；
- `events.ndjson` 包含 `sandbox_escape_detected` 事件；
- `result.json` 包含 `sandboxEscaped`、`outOfTreeChanges` 和门控警告；
- `report.md` 将 `Worktree Changes`（工作树更改）与 `Out-of-Tree Changes`（树外更改）分开。

Portico 不会自动删除或还原树外文件。报告会告诉调用者更改了什么，以便他们可以进行检查和刻意地清理。

## 推荐的默认设置

除非您有不使用的特定原因，否则请使用这些设置：

| 任务 | 推荐设置 |
| --- | --- |
| 正常的实现任务 | `--isolation worktree --permission-profile auto-edit` |
| 只读审查 | `--mode review` |
| 独立实验 | `--mode compare` |
| 从 main/默认分支尝试 | `--base-ref main` 或 `--base-ref defaultBranch` |
| 快速的无操作（no-op）调查 | `--cleanup onNoChanges` |

除非用户明确希望目标代理直接修改当前检出，否则请避免使用共享的自动编辑（shared auto-edit）。

## 隔离“不”做什么

工作区隔离为 Portico 提供了一个独立的补丁工作区，并让它能够检测观察到的树外写入。它**不**：

- 提供操作系统级别的写入沙箱；
- 沙箱化网络访问；
- 对子进程隐藏环境变量；
- 阻止提供商 CLI 使用其自己的本地配置；
- 取代路径策略、测试或人工审查。

Portico 的安全模型是分层的：隔离的工作区、权限配置、路径策略、测试、产物和明确的应用（apply）。
