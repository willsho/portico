# Skills

Portico 附带一个规范 Skill，用于教导本地编码 Agent 如何通过 Portico 委派工作，而不是直接调用另一个 Agent。

该 Skill 用于 Agent 到 Agent 的编排。它不替代 daemon、CLI、路径策略、测试或 apply 关卡。

## 生成的 Skill 文件

运行：

```bash
portico init
```

在当前 git 仓库内，Portico 写入：

```text
.claude/skills/portico/SKILL.md
.agents/skills/portico/SKILL.md
```

在这些确切路径下由 Portico 管理的 skill 文件会在每次运行 `init` 时从规范的捆绑 Skill 中刷新。其他项目级别的 skill 不会被触碰。

## 规范源文件

规范的来源是：

```text
packages/skills/portico/SKILL.md
```

CLI 渲染两种变体：

| 目标 | 输出 | 差异 |
| --- | --- | --- |
| Claude Code | `.claude/skills/portico/SKILL.md` | 保留 `allowed-tools` frontmatter |
| Codex 风格 loader | `.agents/skills/portico/SKILL.md` | 移除 `allowed-tools` 行 |

正文内容除此之外完全相同。

## Skill 教导什么

该 Skill 告诉当前 Agent：

- 当工作应交给另一个本地 Agent 时使用 Portico；
- 使用 `--to <agent>` 选择目标；
- 编写自包含的任务提示；
- 运行 `portico delegate`；
- 阅读 `report.md` 和 `result.json`；
- 总结变更文件、测试和风险；
- 在应用前询问；
- 绝不直接调用另一个 Agent；
- 避免嵌套委派。

该 Skill 也记录了 review 和 compare 流程：

```bash
portico delegate --mode review --to claude --repo . --task "<review task>"
```

```bash
portico delegate --mode compare --to codex --compare-to claude --repo . --task "<task>"
```

## 工具访问

Claude 变体包含：

```yaml
allowed-tools: Bash(portico *), Read
```

这意味着该 Skill 围绕 Portico CLI 和对产物的读取权限设计。它本身不授予广泛的 shell 访问权限。

Codex 风格变体移除此 frontmatter 行，因为并非所有 loader 都能理解 Claude 的 `allowed-tools` 字段。

## Agent 职责

使用该 Skill 时，当前 Agent 仍然是编排者。它应该：

- 使委派任务足够具体，以供全新的 worker 进程使用；
- 包含验收标准；
- 在用户提供测试命令时加以指定；
- 当路径边界很重要时使用 `--allowed` 和 `--forbidden`；
- 在 run 之后检查产物；
- 将结果呈现给用户；
- 在 `portico apply` 之前询问。

目标 Agent 是 worker。它应在执行工作区中完成任务并将更改保留在磁盘上。

## 自包含任务

被委派的 Agent 不会继承当前对话。一个良好的通过 Skill 完成的任务包含：

- 目标；
- 需要首先检查的文件或目录；
- 约束条件；
- 预期行为；
- 验证步骤；
- 不应触碰的内容。

示例：

```bash
portico delegate --to codex --repo . \
  --task "In packages/cli/src/commands/delegate.ts add a --dry-run flag that validates input but does not call /delegate. Add tests near packages/cli/tests. Done when npm test passes." \
  --test "npm test"
```

## Apply 纪律

该 Skill 对 apply 很严格：

- 未经用户明确许可，绝不运行 `portico apply`；
- 仅应用就绪的实现型 run；
- 在 compare 后应用选中的候选 run，而非 compare 父 run；
- 在不再需要时丢弃 worktree。

## 更新 Skill

编辑规范文件：

```text
packages/skills/portico/SKILL.md
```

然后在每个应接收更新后的生成 Skill 文件的仓库中重新运行 `portico init`。

因为 `init` 会刷新 Portico 管理的输出文件，请将项目特定的指南放在单独的项目级 skill 中，而不是直接编辑 `.claude/skills/portico/SKILL.md` 或 `.agents/skills/portico/SKILL.md`。

## 何时不使用该 Skill

不要对以下情况使用 Portico Skill：

- 当前 Agent 可以直接回答的问题；
- 当前 Agent 应该自己完成的微小编辑；
- 另一个 Agent 不会增加价值的工作流；
- 从 Portico worktree 内部串联委派。
