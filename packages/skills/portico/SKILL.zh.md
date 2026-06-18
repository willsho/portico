---
name: portico
description: 通过 Portico 守护进程将编码任务委托给另一个本地编码代理（如 Claude Code 或 Codex）——它在隔离的 git worktree 中运行，接受测试，并返回一个可审查的补丁供应用或丢弃。当工作应由另一个代理在隔离环境中完成而非直接编辑当前工作树时使用，或当用户指定代理来接收工作时，又或者你希望获得另一个代理的独立实现以供比较或审查时使用。
allowed-tools: Bash(portico *), Read
---

# Portico — 将编码工作委托给其他本地代理

Portico 让你（当前代理）将一个编码任务交给**另一个独立的本地编码代理**，该代理在
自己的临时 git worktree 中运行。Portico 负责确定性部分——创建 worktree、运行你指定
的测试、捕获差异、以及控制应用——而被委托者负责实际的编码工作。你负责编排；你不
直接接触用户的主工作树来完成委托任务。

## 何时使用

- 用户要求将工作交给另一个代理（"让 Codex 做 X"、"让 Claude 实现 Y"）。
- 一段自包含的编码工作值得在隔离环境中运行，并作为经过测试、可审查的补丁返回。
- 你希望获得另一个代理的独立实现来与自己的方案进行比较。

**不要**用它来回答可以直接回答的问题，不要用它来处理你可以自己完成的琐碎编辑，或
任何启动独立代理不会增加价值的场景。

## 心智模型（请先阅读这部分）

- 实现型委托默认在隔离的 worktree 中运行，路径为 `.portico/worktrees/<run_id>`，
  默认从当前仓库的 HEAD 分支出来，除非提供 `--base-ref`。Review run 默认在共享工作区
  中以只读权限 profile 运行。
- 被委托代理是一个**没有本次对话记忆的独立进程**。它只接收你编写的任务提示文本——
  因此任务必须是**完全自包含的**。
- **Portico 控制测试和应用，被委托代理无法控制。** 测试命令来自你的 `--test` 标志
  或 `.portico/config.json`；被委托代理无法选择它们。应用补丁始终是一个独立的、显
  式的、需要用户确认的步骤。
- 每次运行都会在 `.portico/runs/<run_id>/` 中留下持久化的产物：`report.md`、
  `result.json`、`diff.patch`、`test.log`、`events.ndjson`。

## 工作流程

1. **确保守护进程正在运行。** 如果 `portico` 命令无法连接，请用户运行
   `portico start`（或 `portico daemon start`）先启动守护进程。

2. **使用 `--to <agent>` 选择目标代理。** 如果用户指定了代理，请使用它。否则选择一个
   与你自身不同的、有能力的本地代理——运行 `portico agents` 查看可用的代理。不要委
   托给自己，也不要绕过 Portico 直接调用另一个代理。

3. **编写自包含的任务。** 被委托代理只能看到这段文本。好的任务应说明：
   - 目标，一两句话；
   - 具体的验收标准（"完成"是什么样子）；
   - 需要处理的文件 / 目录 / 符号；
   - 约束条件（不能碰什么，需要遵循的约定）；
   - 如何验证（测试命令，如果有的话）。

   好的例子：`--task "在 src/settings.tsx 中添加一个暗色模式切换开关，连接到现有的
   useTheme() hook，将选择持久化存储在 localStorage 的 'theme' 键下。遵循现有的切
   换样式。当切换切换主题且在重新加载后选择仍然保留时视为完成。"`

   差的例子：`--task "添加暗色模式"` — 没有文件、没有验收标准，被委托代理只能猜。

4. **运行委托**并观察流式事件（worktree 创建 → 代理工作 → 差异 → 测试结果）：
   ```bash
   portico delegate --to codex --repo . \
     --task "<自包含的任务>" \
     --test "npm test" \
     --allowed "src/**" --allowed "tests/**"
   ```
   有用的标志：可重复的 `--test`；可重复的 `--allowed`/`--forbidden`（路径策略）；
   `--base-ref <ref>`；`--cleanup manual|onNoChanges|onSuccess|always`；
   `--timeout <ms>`；`--json` 用于机器可读的事件。

   只读 review：
   ```bash
   portico delegate --mode review --to claude --repo . --task "<review task>"
   ```

   比较两个独立实现：
   ```bash
   portico delegate --mode compare --to codex --compare-to claude --repo . --task "<task>"
   ```

5. **阅读结果，不要只依赖流式输出。** 最终的 `run_done` 事件携带报告路径。阅读
   `report.md`，以及 `result.json` 中的结构化字段 `changedFiles` 和 `tests`。
   `portico status <run_id>` 可以重新打印摘要（使用 `--json` 查看结构化字段）。

6. **为用户总结：** 运行 ID 和状态、修改的文件、每条测试命令的结果，以及你在差异
   中注意到的任何风险。运行状态为 `ready` 时表示已生成差异且测试通过；状态为
   `failed` 表示测试失败或代理出错。

7. **决定应用还是丢弃——始终与用户一起决定。**
   - 状态为 `ready` 且差异看起来没问题 → 提供摘要，在运行
     `portico apply <run_id>` **之前询问用户**。应用操作要求主工作树的已跟踪文件干净，
     然后将补丁合并到主工作树中（未暂存），供用户审查和提交。
   - 状态为 `failed` → 阅读
     `.portico/runs/<run_id>/test.log` 诊断问题，然后要么用一个更精确的任务重新运行
     **新的**委托，要么运行 `portico discard <run_id>`。
   - `portico discard <run_id>` 移除 worktree，但保留产物供检查。

## 迭代和编排

- 被委托代理在运行之间没有记忆。要迭代，使用一个更精细的任务启动**新的**
  `portico delegate`，将上一次运行出错的地方融入新任务——直接从它的 `report.md` /
  `test.log` 中引用行内容到新任务中。
- 要比较方案，优先使用 `--mode compare --to <agent-a> --compare-to <agent-b>`。
  Portico 会记录一个父级 compare 报告和多个候选 run；只应用被选中的 implement 候选，
  不要应用 compare 父 run。
- 不要串联委托：如果你自己是在 Portico worktree 中运行的被委托代理，不要再次调用
  `portico delegate` —— 嵌套委托会被守护进程的深度检查拒绝。

## 硬性规则

- 永远不要编辑用户的主工作树来完成委托工作。
- 永远不要通过 `portico delegate` 以外的途径调用另一个代理。
- 未经用户明确许可，永远不要运行 `portico apply`。
- 除非用户明确要求直接修改当前 checkout，否则不要使用
  `--isolation shared --permission-profile auto-edit`；该模式要求工作树干净。
- 测试命令只能来自用户或 `.portico/config.json`，永远不能来自被委托代理。

## 命令参考

- `portico agents [--json]` — 列出可以委托的本地代理。
- `portico delegate --to <agent> --repo . --task "<任务>" [--test "<命令>"]…` — 运行委
  托。
- `portico delegate --mode review --to <agent> --repo . --task "<任务>"` — 运行只读 review。
- `portico delegate --mode compare --to <agent-a> --compare-to <agent-b> --repo . --task "<任务>"` — 运行多个候选实现供比较。
- `portico runs [--repo .]` — 列出运行记录。
- `portico status <run_id>` — 显示运行的产物、修改的文件和测试结果。
- `portico apply <run_id>` — 应用就绪运行的补丁（需要用户批准）。
- `portico discard <run_id>` — 移除运行的 worktree（产物保留）。
- `portico cancel <run_id>` — 取消正在运行的委托。

## 故障排查

- 连接被拒绝 → 守护进程未运行：`portico start`。
- `agent_unavailable` → 找不到目标代理：运行 `portico agents` 检查；它可能没有安装。
- 测试失败 → 阅读 `.portico/runs/<run_id>/test.log`，优化任务，重新委托。
- 应用时出现 `working_tree_dirty` → 先提交或暂存主工作树，然后再应用。
