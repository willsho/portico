# 审查、比较与拆分 (Review, Compare, and Split)

Portico 支持非默认的委派模式，以获取另一个代理的判断而无需立即应用补丁：`review`（审查）、`compare`（比较）和 `split`（拆分）。`compare` 和 `split` 是两种扇出形式——compare 针对一个任务生成相互竞争的实现，split 将一个任务分为互补的子任务并将它们合并。两者都接受一个可选的只读**裁判（judge）**来帮助您做出决定。

## Review 模式 (审查模式)

Review 模式要求目标代理检查仓库并报告发现。

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
| `apply` | 拒绝 |

Review 模式在以下情况下很有用：

- 您希望获得关于差异或代码路径的第二意见；
- 该任务不应创建补丁；
- 当前检出已经包含了要检查的工作；
- 您希望将审查输出保留在 Portico 产物中。

当代理在不修改共享工作树的情况下完成时，运行被标记为 `ready`。如果只读审查更改了文件，Portico 会将运行失败并显示 `read_only_modified`。

## 编写审查任务

明确告诉审查者应寻找什么：

```text
Review the changes around packages/orchestrator/src/orchestrator.ts.
Focus on workspace isolation, apply/discard lifecycle, and test coverage.
Return findings ordered by severity with file references. Do not edit files.
```

好的审查任务应指明：

- 要检查的文件或目录；
- 风险类别；
- 预期的输出格式；
- 是否应考虑测试或文档。

Review 模式不运行配置的测试命令。它用于代理分析，而不是验证。

## Compare 模式 (比较模式)

Compare 模式要求多个代理生成独立的候选实现。

```bash
portico delegate \
  --mode compare \
  --to codex \
  --compare-to claude \
  --repo . \
  --task "Add project-level isolation settings to delegation runs" \
  --test "npm test"
```

第一个候选者来自 `--to`。其他候选者来自重复的 `--compare-to` 标志：

```bash
portico delegate \
  --mode compare \
  --to codex \
  --compare-to claude \
  --compare-to gemini \
  --repo . \
  --task "Try three approaches to X"
```

Compare 模式并行运行候选者，每个候选者都是一个在其独立的隔离工作树中启用了 `auto-edit` 的普通 `implement` 运行。同时运行的数量受编排器的 `maxConcurrentAgentProcesses`（默认 4）限制；`git worktree` 的记账是序列化的，因此并发运行不会发生争用。候选者事件流交错输出，每个事件都标记有自己的 `runId`，并且父 compare 运行仅在每个候选者完成时才完成。

## 比较产物

Compare 模式创建：

1. 一个父 compare 运行；
2. 每个候选者一个子 implement 运行。

父运行在 `result.json` 中记录 `compareResults`，并在 `report.md` 中包含“比较候选者（Compare Candidates）”部分。

父 compare 运行是不可应用的：

```bash
portico apply <compare_parent_run_id>
# 拒绝：只有 implement 运行可以被应用
```

要应用一个候选者：

1. 打开父报告；
2. 检查每个候选报告和补丁；
3. 选择一个候选 implement 运行；
4. 应用该候选者的 run id。

```bash
portico status <candidate_run_id>
portico apply <candidate_run_id>
```

## 带有基础引用和清理策略的 Compare

Compare 候选者继承父请求的基础引用（base ref）和清理策略：

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

每个候选者获得自己的隔离工作树和分支。

## 在候选者之间选择

比较候选者时，请检查：

- 更改的文件；
- 差异的大小和清晰度；
- 测试结果；
- 实现是否遵循现有模式；
- 候选者解决的问题是少于还是多于请求的内容；
- 依赖、配置或生成文件引入的任何新风险。

最好的候选者并不总是最大的补丁或包含最多解释的补丁。优先选择满足任务要求且适合代码库的最小实现。

## 裁判 (可选)

裁判使这一选择的初步过程自动化。向 compare 运行添加 `--judge-to <agent>`，Portico 会在候选者完成后对候选差异进行只读 `review`，然后在组的 `result.json` 和报告中记录排名和 `recommendedChildId`：

```bash
portico delegate \
  --mode compare \
  --to codex \
  --compare-to claude \
  --repo . \
  --task "Refactor the cache layer" \
  --judge-to gemini
```

裁判与代理无关，并且始终是只读的。它**不会**改变应用语义——仍然需要 `apply --child <id>`，并且最终决定权仍在您手中。建议会显示在 `portico status` 和报告的“下一步操作（Next Actions）”中（标记为 `(recommended)`）。

## Split 模式 (拆分模式)

Split 模式将一个任务划分为互补的子任务，像 compare 组一样并行运行它们，然后将生成的补丁**合并**为一个可审查的补丁。

```bash
portico delegate \
  --mode split \
  --to claude \
  --repo . \
  --task "Add OAuth login end-to-end" \
  --child '{"to":"claude","task":"Backend OAuth routes","allowedPaths":["src/server/**"]}' \
  --child '{"to":"codex","task":"Login UI","allowedPaths":["src/web/**"]}' \
  --judge-to gemini
```

在 split 模式下，每个子项必须声明自己的 `task`，而 `allowedPaths` 使每个子项保持在自己的范围内，因此合并保持干净。在子项完成后，Portico 在从共享基础引用分支出来的集成工作树中将它们合并：

- 干净的合并 → 组变为 `ready`，`apply --all` 将合并的补丁登陆。
- 重叠的编辑 → Portico 记录 `conflicts.json`，将组移动到 `conflict`（冲突）状态，并拒绝 `apply --all`。使用 `--resume` 缩小一个子项范围，Portico 会自动重新合并。

使用 `--judge-to`，裁判审查**合并后的**结果，并记录 `approve` / `needs_attention`（批准/需要注意）的结论。完整的生命周期请参见 [委派 → 任务拆分和扇入](delegation.md)。

## 常见模式

让两个代理进行独立的实现：

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

比较后审查一个候选者：

```bash
portico delegate \
  --mode review \
  --to claude \
  --repo . \
  --task "Review candidate run <run_id>; focus on correctness and missing tests"
```

就地迭代一个失败的候选者（在其现有工作树中重新运行它并重新计算组状态，以便混合组可以收敛到全部就绪（all-ready））：

```bash
portico delegate --resume <candidate_run_id> --task "the typecheck fails at line 42; fix it"
```

丢弃失败的候选者：

```bash
portico discard <candidate_run_id>
```

保留父 compare 运行产物。即使候选工作树被丢弃后，它们也是有用的历史背景。
