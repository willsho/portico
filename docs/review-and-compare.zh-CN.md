# Review 与 Compare

Portico 支持两种非默认的委派模式，用于获取另一个 Agent 的判断而不立即应用 patch：`review` 和 `compare`。

## Review 模式

Review 模式要求目标 Agent 检查仓库并报告发现。

```bash
portico delegate \
  --mode review \
  --to claude \
  --repo . \
  --task "Review the parser changes for regressions and missing tests"
```

默认值：

| 设置 | 值 |
| --- | --- |
| `isolation` | `shared` |
| `permissionProfile` | `read-only` |
| `diff.patch` | 空 |
| `apply` | 被拒绝 |

Review 模式适用于：

- 你希望获得对某个 diff 或代码路径的第二意见；
- 任务不应产生 patch；
- 当前 checkout 已包含需要检查的工作；
- 你希望将 review 输出保留在 Portico 工件中。

当 Agent 完成且未修改共享工作树时，run 被标记为 `ready`。如果只读 review 更改了文件，Portico 会使 run 以 `read_only_modified` 失败。

## 编写 Review 任务

明确说明审查者应关注什么：

```text
Review the changes around packages/orchestrator/src/orchestrator.ts.
Focus on workspace isolation, apply/discard lifecycle, and test coverage.
Return findings ordered by severity with file references. Do not edit files.
```

良好的 review 任务会指明：

- 要检查的文件或目录；
- 风险类别；
- 期望的输出格式；
- 是否应考虑测试或文档。

Review 模式不运行配置的测试命令。它用于 Agent 分析，而非验证。

## Compare 模式

Compare 模式要求多个 Agent 生成独立的候选实现。

```bash
portico delegate \
  --mode compare \
  --to codex \
  --compare-to claude \
  --repo . \
  --task "Add project-level isolation settings to delegation runs" \
  --test "npm test"
```

第一个候选来自 `--to`。额外的候选来自重复的 `--compare-to` 标志：

```bash
portico delegate \
  --mode compare \
  --to codex \
  --compare-to claude \
  --compare-to gemini \
  --repo . \
  --task "Try three approaches to X"
```

Compare 模式当前按顺序逐个运行候选。每个候选都是启用了 `auto-edit` 的隔离 worktree 中的普通 `implement` run。

## Compare 工件

Compare 模式创建：

1. 一个父级 compare run；
2. 每个候选对应一个子级 implement run。

父级 run 在 `result.json` 中记录 `compareResults`，并在 `report.md` 中包含"Compare Candidates"部分。

父级 compare run 不可 apply：

```bash
portico apply <compare_parent_run_id>
# 被拒绝：only implement runs can be applied
```

要应用某个候选：

1. 打开父级报告；
2. 检查每个候选报告和 patch；
3. 选择一个候选 implement run；
4. 应用该候选的 run id。

```bash
portico status <candidate_run_id>
portico apply <candidate_run_id>
```

## Compare 搭配 Base Ref 和 Cleanup

Compare 候选继承父请求的 base ref 和清理策略：

```bash
portico delegate \
  --mode compare \
  --to codex \
  --compare-to claude \
  --repo . \
  --task "Implement X from main" \
  --base-ref main \
  --cleanup onNoChanges
```

每个候选获得自己独立的隔离 worktree 和分支。

## 在候选之间选择

比较候选时，检查：

- 变更的文件；
- diff 的大小和清晰度；
- 测试结果；
- 实现是否遵循现有模式；
- 某个候选是否解决得过少或过多；
- 依赖、配置或生成文件引入的任何新风险。

最佳候选不总是最大的 patch 或解释最多的那一个。优先选择满足任务要求且符合代码库的最简洁实现。

## 常见模式

让两个 Agent 分别独立实现：

```bash
portico delegate \
  --mode compare \
  --to codex \
  --compare-to claude \
  --repo . \
  --task "Implement the new CLI flag and tests" \
  --test "npm run typecheck" \
  --test "npm test"
```

Compare 后审查候选：

```bash
portico delegate \
  --mode review \
  --to claude \
  --repo . \
  --task "Review candidate run <run_id>; focus on correctness and missing tests"
```

丢弃落选候选：

```bash
portico discard <candidate_run_id>
```

保留父级 compare run 工件。即使在候选 worktree 被丢弃后，它们也是有用的历史上下文。
