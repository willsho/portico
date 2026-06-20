---
name: portico
description: Delegate a coding task to a separate local coding agent (e.g. Claude Code or Codex) through the Portico daemon — it runs in an isolated git worktree, gets tested, and comes back as a reviewable patch to apply or discard. Use when work should be done by another agent in isolation rather than by editing the current working tree directly, when the user names an agent to hand work to, or when you want a second agent's independent implementation to compare or review.
allowed-tools: Bash(portico *), Read
---

# Portico — 将编码工作委派给另一个本地代理

Portico 允许你（当前代理）将编码任务交给**另一个独立的本地编码代理**，该代理在自己的临时 git 工作树中运行。Portico 负责确定性的部分——创建工作树、运行你指定的测试、捕获差异（diff）并对应用（apply）进行门控——而受委派者（delegate）负责实际的编码工作。你负责编排；你绝不为了完成委派的工作去触碰用户的主工作树。

## 何时使用

- 用户要求将工作交给另一个代理（"让 Codex 做 X"、"让 Claude 实现 Y"）。
- 一个自包含的编码工作块值得在隔离环境中运行，并作为一个经过测试、可审查的补丁返回。
- 你希望有第二个代理的独立实现来与你自己的实现进行比较。

**不要**将其用于你可以直接回答的问题、你可以自己进行的微小编辑，或任何启动独立代理没有增加价值的情况。

## 心智模型（必读）

- 默认情况下，实现（Implement）的受委派者在 `.portico/worktrees/<run_id>` 的**隔离工作树**中运行，除非提供了 `--base-ref`，否则将从仓库的当前 HEAD 派生。审查（Review）运行默认使用共享工作区，并带有只读权限配置。
- 受委派者是一个**对当前对话没有记忆的新进程**。它只接收你编写的任务提示——因此任务必须是**完全自包含的**。
- **由 Portico 控制测试和应用，而不是受委派者。** 测试命令来自你的 `--test` 标志或 `.portico/config.json`；受委派者不能选择它们。应用补丁始终是一个独立的、明确的、需要用户批准的步骤。
- 每次运行都会在 `.portico/runs/<run_id>/` 中留下持久化的产物：`report.md`、`result.json`、`diff.patch`、`test.log`、`events.ndjson`。

## 工作流

1. **确保守护进程正在运行。** 如果 `portico` 命令无法连接，请告诉用户先运行 `portico start`（或 `portico daemon start`）。

2. **使用 `--to <agent>` 选择目标代理。** 如果用户指定了一个，则使用它。否则，选择一个与你*不同*的、有能力的本地代理——运行 `portico agents` 查看可用代理。永远不要委派给自己，也永远不要绕过 Portico 直接调用另一个代理。

3. **编写自包含的任务。** 受委派者只能看到这段文本。一个好的任务应当陈述：
   - 目标，用一两句话概括；
   - 具体的验收标准（什么样算“完成”）；
   - 开始的文件 / 目录 / 符号；
   - 约束（什么不能碰，要遵循的约定）；
   - 如何验证（测试命令，如果有）。

   好的示例：`--task "在 src/settings.tsx 中添加一个暗黑模式切换开关，将其连接到现有的 useTheme() hook 上，并将选择持久化在 localStorage 的 'theme' 下。匹配现有的切换开关样式。当切换开关翻转主题并且选择在重新加载后依然存在时即完成。"`

   差的示例：`--task "添加暗黑模式"` ——没有文件，没有验收标准，因此受委派者只能猜测。

4. **运行委派**并观察流式事件（工作树创建 → 代理工作 → 差异 → 测试结果）：
   ```bash
   portico delegate --to codex --repo . \
     --task "<self-contained task>" \
     --test "npm test" \
     --allowed "src/**" --allowed "tests/**"
   ```
   有用的标志：可重复的 `--test`；可重复的 `--verify`（与测试分开报告的检查——用于没有测试命令的文档/策略类任务）；可重复的 `--allowed`/`--forbidden`（路径策略）；`--base-ref <ref>`；`--cleanup manual|onNoChanges|onSuccess|always`；`--timeout <ms>`；`--review-summary`（运行结束后打印一键 apply 命令及风险摘要）；用于机器可读事件的 `--json`。

   用于只读审查：
   ```bash
   portico delegate --mode review --to claude --repo . --task "<review task>"
   ```

   比较两个独立的实现（可选配备一个只读裁判进行排序）：
   ```bash
   portico delegate --mode compare --to codex --compare-to claude --repo . --task "<task>" --judge-to gemini
   ```

   将一个大任务拆分为互补的子任务并合并结果（每个子项需要其自己的 `task`；使用 `allowedPaths` 限定作用域以保持干净的合并）：
   ```bash
   portico delegate --mode split --to claude --repo . --task "<overall task>" \
     --child '{"to":"claude","task":"backend part","allowedPaths":["src/server/**"]}' \
     --child '{"to":"codex","task":"frontend part","allowedPaths":["src/web/**"]}'
   ```

5. **阅读结果，不要仅仅信任流。** 最终的 `run_done` 事件包含报告路径。阅读 `report.md`，以及结构化的 `changedFiles` 和 `tests` 对应的 `result.json`。`portico status <run_id>` 重新打印摘要（`--json` 获取结构化字段）。对于 group（compare/split），`portico review <group_id>` 会汇聚每个子项（状态、更改文件、检查、报告/diff 路径、每个子项的下一步动作），并高亮被多个子项同时更改的文件——这些是需要人工仔细合并的地方。

6. **为用户总结：** 运行 ID 和状态，更改的文件，每个命令的测试结果，以及在差异中看到的任何风险。当运行产生了差异且测试通过时，状态为 `ready`；当测试失败或代理出错时，状态为 `failed`。

7. **决定应用或丢弃——始终与用户一起决定。**
   - `ready` 且差异看起来正确 → 提供摘要，并在运行 `portico apply <run_id>` **之前询问**。如果主工作树的被跟踪文件不干净，应用操作将被拒绝，然后将补丁放入主工作树（未暂存）中，供用户检查和提交。
   - `failed` → 阅读 `.portico/runs/<run_id>/test.log` 进行诊断，然后可以启动包含更明确任务的**新**运行，或者执行 `portico discard <run_id>`。
   - `portico discard <run_id>` 删除工作树但保留产物供检查。

## 迭代与编排

- 受委派者在多次运行之间没有记忆。如需迭代，启动包含细化任务的**新** `portico delegate`，该任务应当吸收上一轮运行中的错误——直接将 `report.md` / `test.log` 中的行引用到新任务中。
- 要迭代**组中的子项**而不必重新运行整个组，请使用 `portico delegate --resume <child_id> --task "<refinement>"`。它会在其现有工作树中重新运行该子项，重新生成差异，重新运行测试，并重新计算组状态（对于 split 组，它还会重新运行扇入合并）。这需要支持会话恢复（session resume）的适配器（如 Claude）以及工作树仍然存在。
- 要比较不同的方法，优先使用 `--mode compare --to <agent-a> --compare-to <agent-b>`。Portico 会记录一个父级别的比较报告以及单独的候选运行；只能通过 `portico apply <group_id> --child <child_id>` 应用所选的实现候选者，绝不能应用 compare 父项。
- 要拆分大任务，优先使用 `--mode split` 并为每个子任务设置一个 `--child`。Portico 合并子项的补丁；通过 `portico apply <group_id> --all` 应用合并结果。重叠的编辑会产生 `conflict`（冲突）组（不会被强制合并）——通过 `--resume` 缩小一个子项范围，Portico 会自动重新合并。
- 可选的 `--judge-to <agent>` 会添加一个只读裁判：它对 compare 的候选方案排序或审查 split 的合并结果，但从不改变应用的语义——依然由你和用户来决定。
- 不要链接（chain）委派：如果你自己就是一个在 Portico 工作树内部运行的受委派者，不要再次调用 `portico delegate`——守护进程的深度防护机制会拒绝嵌套委派。

## 铁律

- 永远不要修改用户的主工作树来自己完成委派工作。
- 除了通过 `portico delegate` 外，绝不接触其他代理。
- 在没有用户明确批准的情况下，绝不运行 `portico apply`。
- 除非用户明确要求在当前检出（checkout）中进行直接编辑，否则不要使用 `--isolation shared --permission-profile auto-edit`；Portico 对于这种模式需要干净的树。
- 测试命令仅来自用户或 `.portico/config.json`，绝不会来自受委派者。

## 命令参考

- `portico agents [--json]` — 列出您可以委派给它的本地代理。
- `portico delegate --to <agent> --repo . --task "<task>" [--test "<cmd>"]…` — 运行委派。
- `portico delegate --mode review --to <agent> --repo . --task "<task>"` — 运行只读审查。
- `portico delegate --mode compare --to <agent-a> --compare-to <agent-b> --repo . --task "<task>" [--judge-to <agent>]` — 运行候选实现以进行比较。
- `portico delegate --mode split --to <agent> --repo . --task "<task>" --child '{…,"task":"…"}' --child '{…}'` — 拆分为互补的子任务并合并。
- `portico delegate --resume <child_id> --task "<refinement>"` — 原地迭代一个子项。
- `portico runs [--repo .]` — 列出运行（折叠的；`--flat` 用于旧版扁平列表）。
- `portico status <run_id>` — 显示某个运行的产物、更改文件和测试。
- `portico review <group_id>` — 汇聚一个 group 的子项以供 review（`--ready-only` / `--json` / `--open-diff`）。
- `portico apply <run_id>` — 应用就绪的单次运行的补丁（仅在用户批准后）。
- `portico apply <group_id> --child <child_id>` — 应用一个 compare 候选者。
- `portico apply <group_id> --all` — 应用 split 组的合并补丁。
- `portico discard <run_id>` — 移除某运行的工作树（保留产物）。
- `portico cancel <run_id>` — 取消进行中的运行。

## 故障排除

- `daemon not running` → 启动它：`portico start`。若是 `permission denied` / 沙箱变体，表示 loopback 访问被阻止，而非守护进程未运行。
- `agent_unavailable` → 未找到目标：检查 `portico agents`；可能未安装该代理。
- 测试失败（Test failed）→ 阅读 `.portico/runs/<run_id>/test.log`，完善任务后重新委派。
- `path_not_allowed` → 运行更改了 `--allowed` 之外的文件；错误信息和报告会附带一个可直接粘贴的 retry，已预填缺失的 `--allowed` 标志。
- apply 时遇到 `working_tree_dirty` → 首先提交或贮藏（stash）主树，然后再执行 apply。
