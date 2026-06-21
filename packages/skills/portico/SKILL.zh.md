---
name: portico
description: Delegate a coding task to a separate local coding agent (e.g. Claude Code or Codex) through the Portico daemon — it runs in an isolated git worktree, gets tested, and comes back as a reviewable patch to apply or discard. Use when work should be done by another agent in isolation rather than by editing the current working tree directly, when the user names an agent to hand work to, or when you want a second agent's independent implementation to compare or review.
allowed-tools: Bash(portico *), Read
---

# Portico — 将编码工作委派给另一个本地 Agent

Portico 允许你（当前 Agent）将一个编码任务交给一个**独立的本地编码 Agent**，该 Agent 会在自己的一次性 git worktree 中运行。Portico 负责确定性的部分——创建 worktree、运行你指定的测试、捕获 diff，以及门控补丁应用——而由委派代理负责实际的编码。你负责编排；你永远不需要直接修改用户的主工作树来进行委派的工作。

## 何时使用

- 用户要求将工作移交给另一个 Agent（“让 Codex 做 X”、“让 Claude 实现 Y”）。
- 一个自包含的编码工作块值得在隔离环境中运行，并作为经过测试的、可审查的补丁返回。
- 你希望第二个 Agent 提供一个独立的实现，以便与你自己的实现进行比较。

对于你可以直接回答的问题、你可以自己进行的琐碎编辑，或者启动独立 Agent 没有任何附加价值的情况，请**不要**使用它。

## 心智模型（首先阅读此部分）

- 默认情况下，实现（Implement）的委派在位于 `.portico/worktrees/<run_id>` 的**独立 worktree** 中运行，除非提供 `--base-ref`，否则将从仓库当前的 HEAD 创建分支。审查（Review）运行默认使用拥有只读权限配置的共享工作区。
- 委派的 Agent 是一个**没有本次对话记忆的新进程**。它只会收到你编写的任务提示词——所以任务必须是**完全自包含的**。
- **由 Portico 控制测试和应用，而不是由被委派 Agent 控制。** 测试命令来自你的 `--test` 标志或 `.portico/config.json`；委派代理无法选择它们。应用补丁始终是一个独立的、明确的、需要用户批准的步骤。
- 每次运行都会在 `.portico/runs/<run_id>/` 中留下持久化产物：`report.md`、`result.json`、`diff.patch`、`test.log`、`events.ndjson`。

## 工作流

1. **确保守护进程正在运行。** 如果 `portico` 命令无法连接，告诉用户首先运行 `portico start`（或 `portico daemon start`）。

2. **使用 `--to <agent>` 选择目标 Agent。** 如果用户命名了一个 Agent，则使用它。否则，选择一个与你不同的**其他**可用本地 Agent——运行 `portico agents` 查看可用选项。永远不要委派给自己，也永远不要绕过 Portico 直接调用其他 Agent。

3. **编写一个自包含的任务。** 委派代理只能看到这段文字。一个好的任务应当说明：
   - 目标，用一两句话描述；
   - 具体的验收标准（“完成”是什么样子的）；
   - 从哪些文件 / 目录 / 符号开始；
   - 约束条件（不要碰什么，要遵循什么约定）；
   - 如何验证（如果有测试命令的话）。

   好的例子：`--task "In src/settings.tsx add a dark-mode toggle wired to the existing useTheme() hook, persisting the choice in localStorage under 'theme'. Match the existing toggle styling. Done when the toggle flips the theme and the choice survives a reload."`

   不好的例子：`--task "add dark mode"` —— 没有文件，没有验收标准，代理只能靠猜。

4. **运行委派**并观察流式事件（worktree 创建 → agent 工作 → diff → 测试结果）：
   ```bash
   portico delegate --to codex --repo . \
     --task "<自包含的任务>" \
     --test "npm test" \
     --allowed "src/**" --allowed "tests/**"
   ```
   有用的标志：`--name <slug>`（在 `runs`/`watch` 中显示的人类可读的运行名称；默认为任务的 slug）；可重复使用的 `--test`；可重复使用的 `--verify`（独立于测试报告的检查——用于没有测试命令的文档/策略任务）；可重复使用的 `--allowed`/`--forbidden`（路径策略）；`--base-ref <ref>`；`--cleanup manual|onNoChanges|onSuccess|always`；`--timeout <ms>`；`--review-summary`（运行结束后，打印一键式应用命令 + 风险摘要）；`--auto-start`（如果它没有运行则启动一个 loopback 守护进程并重试一次）；`--detach`（在运行注册后立即退出并打印它的 ID；运行在守护进程上继续——稍后使用 `portico delegate --follow <run_id>` 或 `portico logs <run_id> --follow` 重新附加）；`--notify`（在运行达到终端状态时触发操作系统的通知——与 `--detach` 配合使用；目前仅支持 macOS）；`--json`（用于获取机器可读的事件）。

   `--apply-on-ready` 是一个明确的选择加入标志（opt-in），它**仅在所有安全保护都成立时**自动应用单个 ready 运行——你传入了 `--allowed`（路径边界），追踪的树是干净的，路径策略通过了，没有沙箱逃逸，并且所有测试 + verify 检查均为绿色。如果任何一个保护条件不满足，它就**不会**应用；它会打印出未满足的项目和审查摘要。它仍然需要用户的同意才能使用；永远不要主动添加它。

   对于只读审查：
   ```bash
   portico delegate --mode review --to claude --repo . --task "<审查任务>"
   ```

   比较两个独立实现（可选地使用一个只读的评委来对它们进行排名）：
   ```bash
   portico delegate --mode compare --to codex --compare-to claude --repo . --task "<任务>" --judge-to gemini
   ```

   将一个大任务拆分为互补的子任务并合并结果（每个子任务都需要自己的 `task`；使用 `allowedPaths` 限定范围以保持合并清洁）：
   ```bash
   portico delegate --mode split --to claude --repo . --task "<整体任务>" \
     --child '{"to":"claude","task":"后端部分","allowedPaths":["src/server/**"]}' \
     --child '{"to":"codex","task":"前端部分","allowedPaths":["src/web/**"]}'
   ```

5. **阅读结果，不要只相信事件流。** 最终的 `run_done` 事件包含报告路径。阅读 `report.md`，以及用于结构化 `changedFiles` 和 `tests` 的 `result.json`。`portico status <run_id>` 会重新打印出摘要（`--json` 用于结构化字段）。对于一个组（compare/split），`portico review <group_id>` 会聚合每个子任务（状态、改变的文件、检查、报告/diff 路径、每个子任务的后续动作），并高亮显示被多个子任务修改过的文件——这些地方需要仔细的手工合并。

6. **为用户总结：** 运行 ID 和状态、改变的文件、每个命令的测试结果，以及你在 diff 中看到的任何风险。一个运行是 `ready` 当它产生了一个 diff 并且测试通过了；是 `failed` 当测试失败或 agent 出现错误。

7. **决定应用还是丢弃——始终与用户一起。**
   - `ready` 并且 diff 看起来没错 → 提供一份总结并**在运行前询问** `portico apply <run_id>`。应用（Apply）操作在主树中的追踪文件处于干净状态之前会拒绝运行，然后将补丁落地（landing）到主工作树（未暂存）以供用户检查并提交。
   - `failed` → 阅读 `.portico/runs/<run_id>/test.log` 来诊断问题，然后使用更精确的任务启动一个**新的**运行，或者执行 `portico discard <run_id>`。
   - `portico discard <run_id>` 会删除 worktree，但会保留产物以供检查。

## 迭代和编排

- 被委派的代理在两次运行之间没有记忆。若要进行迭代，请启动一个**新的** `portico delegate` 命令，并在任务中包含前一次运行做错的地方的修正说明——将 `report.md` / `test.log` 中的特定行直接引用到新任务中。
- 若要在**组中的某个子任务**上迭代而不需要重新运行整个组，请使用 `portico delegate --resume <child_id> --task "<改进说明>"`。这将在它现有的 worktree 中重新运行该子任务，重新生成 diff，重新运行测试并重新计算组状态（对于拆分（split）组，它还会重新运行扇入（fan-in）合并）。这需要适配器支持会话恢复（Claude 支持），并且 worktree 仍然存在。
- 若要比较不同的方法，请优先使用 `--mode compare --to <agent-a> --compare-to <agent-b>`。Portico 会记录一个父级别的 compare 报告以及单独的候选运行记录；只应用所选的候选实现，通过 `portico apply <group_id> --child <child_id>`，永远不要直接应用比较组父级。
- 要划分一个大任务，请首选 `--mode split` 并为每个子任务设置一个 `--child`。Portico 会合并子任务的补丁；使用 `portico apply <group_id> --all` 应用合并结果。重叠的修改会产生一个 `conflict` 组（永远不会强制合并）——使用 `--resume` 缩小一个子任务的范围，Portico 将自动重新合并。
- 对于 `partial` 拆分（split）组（有些子任务已准备好（ready），有些失败（failed）），`portico integrate <group_id>` 会根据需要仅将**已准备好**的子任务合并为一个补丁，您可以通过 `apply --all` 应用它。如果发生冲突，它会列出冲突文件、它们的源子任务以及建议的审查顺序；使用 `--resume` 缩小一个子任务，然后再次运行 `integrate`。比较（Compare）组不会进行整合——它们的子任务属于竞争实现，所以你需要通过 `apply --child` 来选择一个。
- 可选的 `--judge-to <agent>` 添加了一个只读的评判：它给比较（compare）候选项排序或者审查拆分（split）的合并结果，但从不改变应用（apply）的语义——仍由您和用户做决定。
- 不要链式委派：如果你本身是一个运行在 Portico worktree 内部的委派代表，不要再次调用 `portico delegate` ——嵌套委派会被守护进程的深度防护措施拒绝。

## 硬性规则

- 绝对不能修改用户主工作树来亲自完成委托的工作。
- 绝对不能通过除了 `portico delegate` 之外的途径联系其他 Agent。
- 在未经用户明确许可的情况下，绝对不能运行 `portico apply`。
- 除非用户明确要求在当前的检出中进行直接的编辑，否则不要使用 `--isolation shared --permission-profile auto-edit`；Portico 需要一个干净的树来进行这种模式。
- 测试命令仅由用户或 `.portico/config.json` 指定，绝不由被委派代理指定。

## 命令参考

- `portico init` — 创建 Portico 仓库元数据，并刷新位于 `.claude/skills/portico/` 和 `.agents/skills/portico/` 下的 Portico Skill 生成文件。
- `portico agents [--json]` — 列出你可以委派到的本地代理。
- `portico delegate --to <agent> --repo . --task "<task>" [--test "<cmd>"]…` — 运行一个委派。
- `portico delegate --mode review --to <agent> --repo . --task "<task>"` — 运行只读审查。
- `portico delegate --mode compare --to <agent-a> --compare-to <agent-b> --repo . --task "<task>" [--judge-to <agent>]` — 为比较（comparison）运行候选实现。
- `portico delegate --mode split --to <agent> --repo . --task "<task>" --child '{…,"task":"…"}' --child '{…}'` — 拆分为互补的子任务并合并。
- `portico delegate --resume <child_id> --task "<refinement>"` — 就地迭代一个子任务。
- `portico delegate --follow <run_id>` — 重新附加到某个运行的事件日志（例如在 `--detach` 之后）。
- `portico runs [--repo .]` — 列出运行（默认被折叠的； `--flat` 显示传统的平铺列表）。可通过 `--status <s1,s2>` 和 `--since <dur>`（例如 `30m`, `2h`, `1d`）过滤；激活状态的运行会带有 `[active]` 标记。组所在的行将展示 `children <ready>/<total> ready`。 `--watch` 开启实时状态面板。
- `portico watch [--repo .]` — 实时状态面板：将运行状态分组（需要做决定的在顶部，然后是运行中的，然后是已完成的），并根据间隔刷新，可使用内联快捷键对选中的运行采取操作：apply（应用）、discard（放弃）、cancel（取消）、follow（追踪）、review（审查）、integrate（整合）。可通过 `--status` / `--needs-review` / `--to <agent>` / `--since` 进行过滤。在非 TTY 模式（或者 `--once` / `--json`）将只打印一次快照，借此维持可用作脚本执行。在多个委托并行运行的情况下特别有用。
- `portico status <run_id>` — 显示一次运行产生的构件（artifacts）、更改的文件、测试以及实时进度（当前的阶段，agent 是否仍在运行中，最后事件）。
- `portico review <group_id>` — 聚合组里的子任务以供审查（`--ready-only` / `--json` / `--open-diff`）。
- `portico integrate <group_id>` — 将一个 implement/split 组内的 ready 状态的子任务合并为一个补丁（对 compare 组无效）。
- `portico apply <run_id>` — 应用单个 ready 的运行状态生成的补丁（仅在用户同意后进行）。
- `portico apply <group_id> --child <child_id>` — 应用比较的选项（compare candidate）之一。
- `portico apply <group_id> --all` — 应用拆分/合并组的合成补丁。
- `portico discard <run_id>` — 移除运行中产生的 worktree （保留 artifacts）。
- `portico cancel <run_id>` — 取消处于运行过程中的状态。
- `portico cleanup [--failed] [--older-than <dur>] [--purge]` — 收回完成后的运行状态中的 worktrees （默认保留 artifacts ；使用 `--purge` 则一同移除它们）。绝对不要移除 ready/applied 或是在运行过程当中的状态。

## 疑难解答

- `daemon not running` → 启动它： `portico start`，或者传入 `--auto-start` 给 `portico delegate` 来让它开启一个 loopback 守护进程，并在未运行时重试一次。`permission denied` / 沙箱相关的变种是指 loopback 访问权限遭到封锁，而不是守护进程中断掉线。若 `portico start` 报警告表示 pidfile 或者 `.portico`/`.git` 目录不可写，是说明此时处于一个拒绝进行写操作的沙箱环境中 —— 开启写操作许可，或是在沙箱外进行操作（守护进程仍有可能处于可用状态中，但是对 `stop`/discovery 以及委派的功能则将收到限制）。
- `agent_unavailable` → 没找到目标对象：可查看 `portico agents` ；也许这并没有处于安装好的情况。
- Stale generated Skill → 在仓库（repo）中重新执行 `portico init` 。这能在无伤其他项目级层技能的情况前提下，重新刷新 Portico 的生成的技能类文件。
- Test failed → 查看 `.portico/runs/<run_id>/test.log`，细化提纯（refine）任务指令，并且重走委派流程。
- `path_not_allowed` → 本次运行修改的范围位于 `--allowed` 外的文件部分；报错以及其产生的相关报错中将带一段复制-粘贴级别的重试，而里头预填好了缺失掉的相关 `--allowed` 标志类。
- `working_tree_dirty` （应用操作期间发生）→ 最先在主树上执行 commit 操作或进行 stash 操作，接着再执行 apply。
