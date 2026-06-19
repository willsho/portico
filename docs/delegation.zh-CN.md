# 委派 (Delegation)

Portico 委派允许一个本地编码代理通过 Portico 守护进程将一个有限的任务交给另一个本地编码代理。结果是一个包含日志、报告以及（对于实现工作）可审查补丁的持久化运行。

委派被有意设计为不是直接的代理到代理（agent-to-agent）的 shell 调用。Portico 拥有运行生命周期：工作区选择、路径策略、测试、产物以及应用/丢弃（apply/discard）。

## 快速开始

启动守护进程：

```bash
portico daemon start
```

委派一个实现任务：

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

## 运行生命周期

每次委派运行都经历相同的大致生命周期：

1. Portico 验证请求并找到目标代理。
2. Portico 解析仓库根目录。
3. Portico 准备工作区。
4. Portico 使用自包含的任务提示运行目标代理。
5. 对于工作树运行，Portico 检查调用者的主检出在代理运行期间是否发生了更改。
6. 对于实现运行，Portico 生成 `diff.patch`。
7. Portico 强制执行路径策略。
8. Portico 运行配置的测试。
9. Portico 写入 `result.json` 和 `report.md`。
10. 用户决定是应用还是丢弃。

目标代理被指示将实现更改留在运行工作区中。Portico 将这些更改转换为补丁。如果工作树隔离的运行更改了该工作区之外的文件，Portico 会将树外更改单独记录下来，将运行标记为 `failed`（失败），并发出 `sandbox_escape_detected` 事件。

## 模式 (Modes)

Portico 支持四种委派模式：

| 模式 | 目的 | 默认工作区 | 可以直接应用？ |
| --- | --- | --- | --- |
| `implement` | 为有限的编码任务生成补丁 | `worktree` | 是 |
| `review` | 要求另一个代理进行检查和报告 | `shared` | 否 |
| `compare` | 针对同一任务生成多个**相互竞争的**候选实现 | 候选工作树 | 否，通过 `--child` 应用所选候选者 |
| `split` | 将一个任务拆分为**互补的**子任务，然后合并结果 | 候选工作树 | 否，通过 `--all` 应用合并后的补丁 |

如果省略 `mode`，Portico 默认使用 `implement`。

`compare` 和 `split` 是两种扇出（fan-out）形式。它们共享相同的并行执行和组模型；它们在边缘有所不同：

- **compare**（比较）— 相同任务，N 个子项，**互斥的**补丁，通过选择一个（`apply --child`）来收敛。可选裁判对候选者进行排名。
- **split**（拆分）— N 个互补子任务，**互补的**补丁，通过将它们**合并**为一个补丁（`apply --all`）来收敛。可选裁判对合并结果进行审查。

## 组运行 (Group Runs, Fan-out)

当 Portico 接收到 `compareTargets` 或明确的 `children` 时，它会创建一个**组运行（group run）**来编排多个**子运行（child runs）**。每个子项在其自己的工作树中独立运行。组运行本身没有工作树；其状态派生自其子项。

组运行产物位于 `.portico/runs/<group_id>/` 下，包括：
- 包含 `childResults`（每个子项的 `RunResult` 列表）和 `groupSummary`（`{ total, ready, failed, cancelled }`）的 `result.json`
- 包含逐个候选者表格和每个候选者应用说明的 `report.md`

### 异构扇出 (Heterogeneous Fan-out)

每个子项可以独立配置：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Add a dark mode toggle" \
  --child '{"to":"codex","label":"codex-impl"}' \
  --child '{"to":"claude","model":"sonnet","permissionProfile":"auto-edit","label":"claude-impl"}'
```

`ChildSpec` 字段：`to`（必需），`task`（可选，继承组任务），`label`，`permissionProfile`，`model`，`effort`，`allowedPaths`，`forbiddenPaths`。

旧的 `--compare-to` 语法被保留，并在内部规范化为子项（children）。

### 应用组结果

组结果包含多个相互竞争的实现。您必须明确选择一个：

```bash
portico apply <group_id> --child <child_id>
```

在没有 `--child` 的情况下应用一个组将返回一个包含使用说明的错误。

### 取消 / 丢弃组

这两个操作都级联到所有子项：

```bash
portico cancel <group_id>   # 级联取消到每个子项
portico discard <group_id>  # 删除所有子工作树，保留产物
```

它们是幂等的——重新取消或重新丢弃一个已完成的组是安全的。

### 折叠运行列表

`portico runs` 显示一个折叠视图，子项嵌套在其组下：

```text
run_abc_group  compare  partial  (3 children: 2 ready, 1 failed)
  ├─ run_def_a  claude  ready    src/foo.ts, src/bar.ts
  ├─ run_ghi_b  codex   ready    src/foo.ts
  └─ run_jkl_c  gemini  failed   (test failed)
```

使用 `portico runs --flat` 查看旧版的扁平列表。

### 单个子项恢复

要对失败的子项进行迭代而不重新运行整个组：

```bash
portico delegate --resume <child_id> --task "the test is failing because of X"
```

这将在其现有工作树中重新运行该子项，捕获新的差异，重新运行测试，并重新计算父组的状态。仅当目标适配器支持原生会话恢复（Claude 支持；generic-CLI 适配器可能不支持）并且工作树仍然存在时才有效。

## 任务拆分和扇入 (Task Split and Fan-in)

`split` 模式将一个大任务转换为 N 个**互补的**子任务，像任何组一样并行运行它们，然后将生成的补丁**合并**为一个。每个子项声明自己的 `task`（在 split 模式下必需），并应使用 `allowedPaths` 限定其更改范围，以保持干净的合并。

```bash
portico delegate \
  --to claude \
  --repo . \
  --task "Add OAuth login end-to-end" \
  --mode split \
  --child '{"to":"claude","task":"Implement the OAuth backend routes and token exchange","allowedPaths":["src/server/**"]}' \
  --child '{"to":"codex","task":"Build the login UI and call the new routes","allowedPaths":["src/web/**"]}' \
  --child '{"to":"gemini","task":"Add integration tests for the OAuth flow","allowedPaths":["tests/**"]}'
```

### 扇入合并

在每个子项都 `ready`（就绪）后，Portico 将它们的补丁合并到一个从共享的 `baseRef` 派生的新**集成工作树（integration worktree）**中：

- 所有子项都派生自同一基础，因此不重叠的更改干净地堆叠，而重叠但不相交的编辑则进行三方合并。
- 合并后的补丁写入该组的 `diff.patch` 中；该组变为 `ready`。
- 集成工作树位于 `.portico/worktrees/<group_id>_integration`，并保留供检查（受组清理策略约束）。

合并策略由 `--merge`（或 API 中的 `fanIn.merge`）设置：`none`、`sequential` 或 `integration`。对于 split 模式，默认为 `integration`，对于 compare 模式，默认为 `none`。

### 合并冲突

当两个子项编辑同一区域时，Portico **从不强制合并**。它中止操作，将冲突的文件及其来源子项记录到 `conflicts.json` 中，在集成工作树中保留冲突标记，并将组状态移动到 `conflict`。当组处于 `conflict` 状态时，拒绝 `apply --all`。

要解决该问题，缩小一个子项范围，让 Portico 自动重新合并：

```bash
portico delegate --resume <child_id> --task "stop touching auth.ts; only change the route file"
```

成功的子项恢复会重新运行扇入合并；一旦它是干净的，组就会返回 `ready`。

### 应用 split 结果

```bash
portico apply <group_id> --all      # 应用合并后的补丁（每个子项的贡献）
```

`apply --all` 仅对 `ready` 的 split 组有效。对于 `compare` 组（使用 `--child`）和仍处于 `conflict` 状态的 split 组，它会被拒绝。您仍然可以使用 `--child <child_id>` 应用 split 组的单个贡献。

### 扇入裁判 (Fan-in judge)

这两种扇出形式都接受一个可选的**裁判（judge）**——一个只读的 `review` 运行，它评估候选者并将其结论写入组的 `result.json` 和报告中：

```bash
# compare: 对候选者排序并推荐一个
portico delegate --to codex --compare-to claude --mode compare \
  --task "Refactor the cache layer" --judge-to gemini

# split: 作为整体审查合并结果
portico delegate --to claude --mode split \
  --child '{"to":"claude","task":"...","allowedPaths":["src/a/**"]}' \
  --child '{"to":"codex","task":"...","allowedPaths":["src/b/**"]}' \
  --judge-to gemini
```

裁判与代理无关（任何支持 `review` 的代理都可以），始终是只读的，并且从不改变应用的语义——对于 compare，它突出显示 `recommendedChildId`，对于 split，它记录 `approve` / `needs_attention`（批准/需要注意）的结论。**最终决定权仍在您手中。**

## 产物 (Artifacts)

每次运行都会在 `.portico/runs/<run_id>/` 下写入产物：

| 产物 | 含义 |
| --- | --- |
| `task.json` | 原始请求加上规范化的执行设置 |
| `events.ndjson` | Portico 委派事件流 |
| `agent.ndjson` | 目标代理运行时事件 |
| `diff.patch` | 实现运行的补丁；只读审查运行则为空 |
| `test.log` | 配置的测试命令的输出 |
| `report.md` | 人类可读的摘要、警告、遥测和下一步操作 |
| `result.json` | 稳定的机器可读结果，包含更改的文件、警告和遥测 |
| `conflicts.json` | 仅限 split 组，在合并冲突时：冲突文件及其源子项 |

对于 split 组，`diff.patch` 包含**合并的**补丁（仅当合并干净时存在），并且 `result.json` 额外携带 `merge`（策略 + 状态）、`conflicts` 和 `judge`。最后的 `run_done` 事件包含 `reportPath` 和 `resultPath`。

## 门控警告和遥测

当 Portico 发现代理的终端声明与 Portico 自己的门控不匹配时，或者当工作树运行更改了隔离工作树之外的文件时，`result.json` 会记录门控警告。

`result.telemetry` 记录总运行耗时、代理耗时、测试耗时，以及当代理报告它时的提供商使用情况。使用情况数据保留提供商的原始负载，并提取常见的 token 和成本字段，如 `inputTokens`、`outputTokens`、`totalTokens` 和 `costUsd`。

## 路径策略

委派可以约束运行可能更改哪些文件：

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

路径策略在生成差异之后且运行准备就绪之前强制执行。

## 测试

测试命令来自重复的 `--test` 标志或 `.portico/config.json`：

```bash
portico delegate \
  --to claude \
  --repo . \
  --task "Fix the parser edge case" \
  --test "npm test" \
  --test "npm run typecheck"
```

测试在执行工作区中运行。如果测试失败，运行状态变为 `failed`，但产物仍然可供诊断。

## 应用 (Apply)

单次 `implement` 运行直接应用；组运行需要明确选择：

```bash
portico apply <run_id>                 # 单次实现运行
portico apply <group_id> --child <id>  # 比较组：选择一个候选者
portico apply <group_id> --all         # 拆分组：应用合并补丁
```

当出现以下情况时，`apply` 拒绝操作：

- 运行不是 `ready` 状态（处于 `conflict` 状态的 split 组对于 `--all` 是被拒绝的）；
- 单次运行的模式不是 `implement`；
- 运行没有 `diff.patch`（或 split 组没有合并补丁）；
- 在没有 `--child` 的情况下应用了 compare 组，或者 `--all` 目标是非 split 组；
- 主工作树有被跟踪的更改；
- `git apply` 失败。

应用的更改将作为普通的未暂存文件更改登陆主工作树。Portico 不会提交它们。`apply --all` 会将组以及每个贡献的子项都标记为 `applied`。

## 丢弃 (Discard)

丢弃（Discard）移除运行工作树并保留产物：

```bash
portico discard <run_id>
```

这在应用了补丁、拒绝了补丁或清理了您不再需要就地检查的失败运行之后很有用。

## 编写好的委派任务

受委派者获得一个新进程以及 Portico 发送给它的唯一任务提示。好的任务是自包含的：

- 陈述目标；
- 命名首先要检查的文件、目录或符号；
- 定义“完成”意味着什么；
- 提及约束以及不要碰的文件；
- 在相关时包含验证命令。

好的示例：

```text
In src/settings.tsx add a dark-mode toggle wired to the existing useTheme() hook.
Persist the choice in localStorage under "theme". Match existing toggle styling.
Done when the toggle flips the theme and the choice survives a reload.
```

差的示例：

```text
add dark mode
```
