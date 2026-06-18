# Portico Delegation MVP 开发计划

## 1. 项目背景

Portico 当前已经具备本地 Agent runtime bridge 的基础能力，包括本地 Agent discovery、统一 adapter、daemon、client、CLI 和事件流。这次 MVP 的目标是在 Portico 现有能力之上，增加 Agent delegation 能力，让 Claude Code、Codex 和未来的 BYOK worker 可以通过 Portico daemon 互相委派 coding task，并在本地隔离 worktree 中产出可审查的 patch。

本方案不把 MCP 放进第一版核心路径。第一版采用 HTTP、NDJSON、CLI 和 Skill 作为主要集成方式。

## 2. MVP 核心目标

第一版只验证一个闭环：

Claude Code 或 Codex 通过 Skill 调用 Portico CLI，Portico CLI 请求本地 daemon，daemon 创建独立 worktree，调用另一个 Agent 执行任务，运行测试，生成 diff 和报告，最后由用户决定 apply 或 discard。

最小目标包括：

1. Claude Code 可以调用 Codex 执行代码任务。
2. Codex 可以调用 Claude 执行代码任务或 review 任务。
3. 每次 delegation 都在独立 git worktree 中执行。
4. daemon 统一管理 run 状态、日志、测试结果、diff 和 artifacts。
5. 用户可以通过 CLI 查看状态、应用 patch 或丢弃 run。
6. 第一版不依赖 MCP。
7. 第一版不做 Web UI、云端 worker、多人协作、自动 PR 和插件市场。

## 3. 产品定位

Portico Delegation MVP 的定位是：

给 Claude Code 和 Codex 使用的本地 Agent Router。

它是一个本地 daemon，负责把多个 coding agent 连接起来，并提供确定性的 worktree、日志、测试、diff 和审批能力。

推荐对外描述：

Portico lets local coding agents delegate tasks to each other through a controlled local daemon, producing isolated, tested, and reviewable patches.

中文描述：

Portico 让 Claude Code、Codex 和 BYOK worker 可以通过本地 daemon 互相委派 coding task，并产出隔离、可测试、可审查的 patch。

## 4. 第一版范围

### 4.1 必须支持

1. 复用现有 Portico daemon。
2. 新增 delegation run 模型。
3. 新增 worktree 管理能力。
4. 新增 run artifact 存储。
5. 新增 `portico delegate` 命令。
6. 新增 `portico runs` 命令。
7. 新增 `portico status` 命令。
8. 新增 `portico apply` 命令。
9. 新增 `portico discard` 命令。
10. 新增 Claude Code Skill。
11. 新增 Codex Skill。
12. 支持 Claude 调 Codex。
13. 支持 Codex 调 Claude。
14. 支持配置测试命令。
15. 支持生成 diff.patch、report.md、result.json、events.ndjson。
16. 支持 delegation depth 限制，第一版默认 depth 为 1。
17. 支持人工确认 apply。
18. 支持本地 daemon token，避免任意本机进程直接调用。

### 4.2 暂不支持

1. Web UI。
2. MCP server。
3. ACP。
4. 云端 worker。
5. 多人协作。
6. 自动创建 GitHub PR。
7. 自动合并主分支。
8. 插件市场。
9. 复杂权限 UI。
10. Agent 多轮无限自动修复。
11. 跨机器分布式调度。
12. 复杂长期 memory。
13. 任意第三方 package 扩展。

## 5. 总体架构

```text
Claude Code Skill
        |
        v
Portico CLI
        |
        v
Portico Daemon
        |
        +---- Claude Adapter
        |
        +---- Codex Adapter
        |
        +---- Future Pi BYOK Adapter
        |
        v
Worktree Manager
        |
        v
Test Runner
        |
        v
Artifact Store
        |
        v
Patch Apply or Discard
```

Codex 侧的路径相同：

```text
Codex Skill
        |
        v
Portico CLI
        |
        v
Portico Daemon
        |
        +---- Claude Adapter
        |
        +---- Codex Adapter
        |
        +---- Future Pi BYOK Adapter
```

第一版的核心原则是：

1. Skill 只负责告诉 Claude Code 或 Codex 如何调用 Portico。
2. CLI 只负责本地命令入口和结果展示。
3. Daemon 负责状态、调度、日志、worktree、测试和产物。
4. Adapter 只负责把统一任务转换成具体 Agent 调用。
5. Orchestrator 负责 delegation workflow。
6. Apply 必须由用户显式触发。

## 6. 推荐包结构

```text
packages/
  core/
  adapters/
  daemon/
  client/
  cli/
  orchestrator/
  skills/
    claude/
      portico/
        SKILL.md
    codex/
      portico/
        SKILL.md
```

### 6.1 core

继续保持轻量，负责 Agent discovery、Adapter interface、RuntimeEvent 定义、Child process runner 和基础事件标准化。

### 6.2 adapters

继续负责具体 Agent 的接入，包括 Claude adapter、Codex adapter、Generic CLI adapter，后续新增 Pi adapter、Gemini CLI adapter 和 Kimi Code adapter。

### 6.3 daemon

负责本地服务，包括 HTTP server、NDJSON event stream、Run API、Delegate API、本地鉴权、状态查询、Artifact 查询、Cancel、apply 和 discard API。

### 6.4 orchestrator

新增模块，负责 RunStore、WorktreeManager、DelegationGuard、TestRunner、ArtifactStore、PatchManager、ReviewFlow、Agent delegation workflow、Repo lock、超时和取消。

### 6.5 cli

新增命令：

1. `portico delegate`
2. `portico runs`
3. `portico status`
4. `portico apply`
5. `portico discard`
6. `portico daemon start`
7. `portico daemon stop`

### 6.6 skills

提供 Claude Code 和 Codex 的 Skill 文件。

Skill 的职责：

1. 判断什么时候使用 Portico。
2. 把用户任务转成 `portico delegate` 命令。
3. 读取 CLI 返回的 report path。
4. 总结 diff、测试结果和 review 结论。
5. 引导用户执行 apply 或 discard。
6. 不直接修改主分支。
7. 不绕过 Portico 直接调用另一个 Agent。

## 7. 核心数据模型

### 7.1 Run

```ts
type Run = {
  id: string
  repoPath: string
  worktreePath: string
  branchName: string
  rootAgent: string
  targetAgent: string
  task: string
  mode: "implement" | "review" | "compare"
  status:
    | "created"
    | "planning"
    | "running"
    | "testing"
    | "reviewing"
    | "ready"
    | "failed"
    | "cancelled"
    | "applied"
    | "discarded"
  depth: number
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
}
```

### 7.2 DelegateRequest

```ts
type DelegateRequest = {
  from?: string
  to: string
  repo: string
  task: string
  mode?: "implement" | "review"
  testCommands?: string[]
  allowedPaths?: string[]
  forbiddenPaths?: string[]
  timeoutMs?: number
  maxAutoFixAttempts?: number
}
```

### 7.3 RunArtifact

```ts
type RunArtifact = {
  runId: string
  taskPath: string
  eventsPath: string
  agentLogPath: string
  testLogPath?: string
  diffPath?: string
  reportPath: string
  resultPath: string
}
```

## 8. Daemon API 设计

### 8.1 健康检查

```http
GET /health
```

返回：

```json
{
  "ok": true,
  "version": "0.1.0"
}
```

### 8.2 Agent 列表

```http
GET /agents
```

返回当前已发现的本地 Agent。

### 8.3 创建 delegation run

```http
POST /delegate
```

请求：

```json
{
  "from": "claude",
  "to": "codex",
  "repo": "/path/to/repo",
  "task": "Add dark mode toggle to settings page",
  "mode": "implement",
  "testCommands": ["pnpm test"],
  "allowedPaths": ["src/**", "tests/**"],
  "forbiddenPaths": [".env", "node_modules/**"]
}
```

返回 NDJSON stream：

```json
{"type":"run_start","runId":"run_001"}
{"type":"worktree_created","path":".portico/worktrees/run_001","branch":"portico/run_001"}
{"type":"agent_start","agent":"codex"}
{"type":"agent_message","text":"Planning implementation..."}
{"type":"test_start","command":"pnpm test"}
{"type":"test_done","status":"passed","exitCode":0}
{"type":"diff_ready","path":".portico/runs/run_001/diff.patch","changedFiles":["src/settings.tsx"]}
{"type":"run_done","status":"ready"}
```

### 8.4 查询 run

```http
GET /runs/:id
```

返回 run 状态和 artifacts。

### 8.5 查询 run 事件

```http
GET /runs/:id/events
```

返回历史 NDJSON 事件，也可以支持持续 stream。

### 8.6 取消 run

```http
POST /runs/:id/cancel
```

### 8.7 应用 patch

```http
POST /runs/:id/apply
```

第一版要求：

1. run 状态必须为 ready。
2. diff.patch 必须存在。
3. apply 前检查当前 working tree 是否干净。
4. apply 失败时保留 artifacts。
5. apply 成功后状态变为 applied。

### 8.8 丢弃 run

```http
POST /runs/:id/discard
```

第一版要求：

1. 删除 worktree。
2. artifacts 默认保留。
3. 状态变为 discarded。

## 9. CLI 设计

### 9.1 初始化

```bash
portico init
```

行为：

1. 检查是否在 git repo 中。
2. 创建 `.portico/config.json`。
3. 创建 `.portico/runs`。
4. 创建 `.portico/worktrees`。
5. 可选生成 Claude Code Skill。
6. 可选生成 Codex Skill。

### 9.2 启动 daemon

```bash
portico daemon start
```

行为：

1. 启动本地 daemon。
2. 监听 `127.0.0.1`。
3. 生成或读取本地 token。
4. 打印 daemon URL。

### 9.3 查看 Agent

```bash
portico agents
```

行为：

1. 调用 daemon `/agents`。
2. 展示 Claude、Codex、Generic CLI 等状态。
3. 显示版本、路径、可用能力。

### 9.4 委派任务

```bash
portico delegate --to codex --repo . --task "Add dark mode toggle" --test "pnpm test"
```

关键参数：

1. `--to`
2. `--from`
3. `--repo`
4. `--task`
5. `--mode`
6. `--test`
7. `--allowed`
8. `--forbidden`
9. `--timeout`
10. `--json`

行为：

1. 如果 daemon 未启动，提示用户启动或自动启动。
2. 请求 `/delegate`。
3. 实时打印事件。
4. 最后打印 report 路径和 next actions。
5. `--json` 模式输出结构化结果。

### 9.5 查看 run 列表

```bash
portico runs
```

### 9.6 查看 run 状态

```bash
portico status run_001
```

### 9.7 应用 patch

```bash
portico apply run_001
```

### 9.8 丢弃 run

```bash
portico discard run_001
```

## 10. Skill 设计

### 10.1 Claude Code Skill

路径建议：

```text
.claude/skills/portico/SKILL.md
```

内容：

```markdown
---
name: portico
description: Use Portico when the user wants Claude Code to delegate coding work to Codex or another local agent, run the work in an isolated worktree, test it, and return a reviewable patch.
allowed-tools: Bash(portico *)
---

# Portico

Use Portico for coding tasks that should be delegated to another local coding agent.

When invoked:

1. Convert the user request into a concise task.
2. Prefer `portico delegate --to codex --repo . --task "<task>"`.
3. Include test commands when known.
4. Do not manually modify the main working tree for delegated work.
5. Read the generated report path from Portico output.
6. Summarize changed files, test result, risks, and next actions.
7. Ask the user before running `portico apply`.
```

### 10.2 Codex Skill

路径建议：

```text
.agents/skills/portico/SKILL.md
```

内容：

```markdown
---
name: portico
description: Use Portico when the user wants Codex to delegate coding work to Claude Code or another local agent, run the work in an isolated worktree, test it, and return a reviewable patch.
---

# Portico

Use Portico for coding tasks that should be delegated to another local coding agent.

When invoked:

1. Convert the user request into a concise task.
2. Prefer `portico delegate --to claude --repo . --task "<task>"`.
3. Include test commands when known.
4. Do not manually modify the main working tree for delegated work.
5. Read the generated report path from Portico output.
6. Summarize changed files, test result, risks, and next actions.
7. Ask the user before running `portico apply`.
```

## 11. Orchestrator 工作流

### 11.1 delegate implement 流程

1. 接收 DelegateRequest。
2. 验证 repo。
3. 验证 target agent 可用。
4. 检查 delegation depth。
5. 获取 repo lock。
6. 创建 run。
7. 创建 git worktree。
8. 构造 task prompt。
9. 调用 target agent adapter。
10. 收集 agent events。
11. 生成 diff。
12. 执行 test commands。
13. 如果测试失败，第一版最多允许一次 auto fix。
14. 生成 report.md。
15. 写 result.json。
16. 释放 repo lock。
17. 返回 run_done。

### 11.2 delegate review 流程

1. 接收 review task。
2. 读取目标 diff。
3. 读取 task、test log、changed files。
4. 调用 reviewer agent。
5. 生成 review.md。
6. 输出 approve、request_changes 或 reject。
7. 更新 result.json。

### 11.3 apply 流程

1. 检查 run 状态。
2. 检查 diff.patch 是否存在。
3. 检查当前工作区是否干净。
4. 尝试应用 patch。
5. 成功后状态变为 applied。
6. 失败则输出冲突说明。
7. worktree 默认保留，方便排查。

### 11.4 discard 流程

1. 检查 run 是否存在。
2. 删除对应 worktree。
3. artifacts 保留。
4. 状态变为 discarded。

## 12. 安全和控制策略

第一版必须内置以下限制：

1. Daemon 只监听 `127.0.0.1`。
2. Daemon 使用本地 token。
3. 默认不允许远程访问。
4. 默认 delegation depth 为 1。
5. 默认禁止 nested delegation。
6. 每个 repo 默认最多 2 个并发 run。
7. 每个 run 默认最多 1 次自动修复。
8. Apply 必须人工触发。
9. 默认禁止修改 `.env`、`.ssh`、`node_modules`、`dist`、`build`。
10. 测试命令来自配置或 CLI 参数，不允许 Agent 随意决定 apply 命令。
11. 每个 Agent 必须在独立 worktree 里执行。
12. 日志中尽量避免打印环境变量值。
13. 第一版不处理云端多租户。
14. 第一版不承诺强 sandbox，后续再加 Docker 或 micro VM。

## 13. Report 格式

每个 run 生成 `report.md`：

```markdown
# Portico Run Report

## Summary

Task: Add dark mode toggle to settings page

Status: ready

Target Agent: codex

Branch: portico/run_001

Worktree: .portico/worktrees/run_001

## Changed Files

1. src/settings.tsx
2. src/theme.ts

## Test Result

Command: pnpm test

Status: passed

## Review

Decision: approve

Summary: The implementation meets the task requirements.

## Artifacts

1. diff.patch
2. test.log
3. events.ndjson
4. result.json

## Next Actions

1. Apply: `portico apply run_001`
2. Discard: `portico discard run_001`
```

## 14. 里程碑计划

### Milestone 1: Orchestrator 骨架

目标：

1. 新增 `packages/orchestrator`。
2. 定义 Run、DelegateRequest、Artifact、RuntimeEvent。
3. 实现 RunStore。
4. 实现 ArtifactStore。
5. 实现基础状态机。

验收标准：

1. 可以创建 run。
2. 可以更新 run 状态。
3. 可以写入 events.ndjson。
4. 可以生成 result.json。

### Milestone 2: Worktree 和 Diff

目标：

1. 实现 WorktreeManager。
2. 实现 repo 检测。
3. 实现 branch 命名。
4. 实现 diff 生成。
5. 实现 discard 清理 worktree。

验收标准：

1. `portico delegate` 可以为每个 run 创建独立 worktree。
2. 修改 worktree 后可以生成 diff.patch。
3. `portico discard` 可以删除 worktree。

### Milestone 3: Daemon API

目标：

1. 新增 `/delegate`。
2. 新增 `/runs/:id`。
3. 新增 `/runs/:id/events`。
4. 新增 `/runs/:id/apply`。
5. 新增 `/runs/:id/discard`。
6. 新增本地 token 校验。

验收标准：

1. CLI 可以通过 HTTP 请求 daemon。
2. `/delegate` 可以返回 NDJSON stream。
3. run 状态可以查询。
4. apply 和 discard 可以调用。

### Milestone 4: CLI

目标：

1. 实现 `portico delegate`。
2. 实现 `portico runs`。
3. 实现 `portico status`。
4. 实现 `portico apply`。
5. 实现 `portico discard`。

验收标准：

1. 用户可以从 CLI 发起 delegation。
2. 用户可以实时看到事件。
3. 用户可以查看 report。
4. 用户可以 apply 或 discard。

### Milestone 5: Claude 和 Codex 互调

目标：

1. 复用 Claude adapter。
2. 复用 Codex adapter。
3. 实现 `delegate --to codex`。
4. 实现 `delegate --to claude`。
5. 增加 delegation depth guard。

验收标准：

1. Claude Code 通过 CLI 可以调用 Codex 执行任务。
2. Codex 通过 CLI 可以调用 Claude 执行任务。
3. 被调用 Agent 默认不能再次 delegation。
4. 循环调用会被 daemon 拦截。

### Milestone 6: Test Runner 和 Report

目标：

1. 支持 `--test` 参数。
2. 支持 config 中默认测试命令。
3. 保存 test.log。
4. 根据 diff、测试结果、agent 输出生成 report.md。
5. 输出 result.json。

验收标准：

1. 测试通过时 run 状态为 ready。
2. 测试失败时 run 状态为 failed 或 needs_fix。
3. report.md 可读。
4. result.json 可被 Skill 稳定解析。

### Milestone 7: Skills

目标：

1. 新增 Claude Code Skill。
2. 新增 Codex Skill。
3. `portico init` 可安装 Skill。
4. Skill 能正确调用 `portico delegate`。

验收标准：

1. 在 Claude Code 中可以通过 Portico Skill 委派给 Codex。
2. 在 Codex 中可以通过 Portico Skill 委派给 Claude。
3. Skill 会总结 changed files、test status、report path 和 next actions。
4. Skill 不会自动 apply patch。

### Milestone 8: MVP Polish

目标：

1. 完善错误信息。
2. 完善 `portico doctor`。
3. 增加常见失败场景处理。
4. 增加 README。
5. 增加示例 repo 或 demo script。
6. 增加端到端测试。

验收标准：

1. 新用户可以按 README 在一个本地 repo 中跑通。
2. Claude Code 到 Codex 的路径可复现。
3. Codex 到 Claude 的路径可复现。
4. 失败时能给出明确下一步。

## 15. MVP 验收标准

MVP 完成时，必须能稳定跑通以下流程：

1. 用户在一个 git repo 中运行 `portico init`。
2. 用户运行 `portico daemon start`。
3. 用户运行 `portico agents` 可以看到 Claude 和 Codex。
4. 用户在 Claude Code 中通过 Skill 调用 Codex。
5. Portico 创建独立 worktree。
6. Codex 在 worktree 中完成修改。
7. Portico 生成 diff.patch。
8. Portico 运行测试命令。
9. Portico 生成 report.md 和 result.json。
10. Claude Code 总结结果。
11. 用户运行 `portico apply run_id` 可以应用 patch。
12. 用户运行 `portico discard run_id` 可以丢弃 worktree。
13. Codex 也可以通过 Skill 反向调用 Claude。
14. daemon 能阻止 nested delegation。
15. 失败场景有清晰错误信息和 artifacts 可追溯。

## 16. 后续版本方向

### 16.1 BYOK Worker

新增 Pi adapter：

1. 支持 OpenRouter。
2. 支持 Google Gemini。
3. 支持 Kimi。
4. 支持 OpenAI compatible endpoint。
5. 支持 Ollama。
6. 支持本地模型。

### 16.2 Reviewer Flow

新增独立 review 阶段：

1. Implementer 产出 diff。
2. Reviewer 只读 diff。
3. Reviewer 输出 approve、request_changes 或 reject。
4. 支持一次 auto fix。

### 16.3 Parallel Compare

支持同一任务生成多版实现：

1. Claude 实现方案 A。
2. Codex 实现方案 B。
3. Portico 跑测试。
4. Reviewer 对比两个 diff。
5. 用户选择一版 apply。

### 16.4 Web UI

在 daemon 之上加一个轻量 Web UI：

1. Run 列表。
2. Event timeline。
3. Diff viewer。
4. Test log。
5. Apply 和 discard 按钮。

### 16.5 Stronger Sandbox

新增执行隔离：

1. Docker sandbox。
2. Micro VM。
3. 命令白名单。
4. 网络开关。
5. Secret redaction。

## 17. 开发原则

1. 先跑通 Claude Code 到 Codex 的单向闭环。
2. 再跑通 Codex 到 Claude 的反向闭环。
3. 每个 Agent 都必须在独立 worktree 中执行。
4. 所有产物都必须落盘。
5. 所有关键行为都必须有事件记录。
6. Apply 永远需要用户显式确认。
7. Daemon 只做本地 trusted mode。
8. 不在第一版引入 MCP。
9. 不把 orchestration 逻辑塞进 adapter。
10. 不把 Agent 输出当作可信控制指令。
11. Runtime 做确定性控制，Agent 只做智能执行。
12. 优先构建可调试、可追溯、可中断的闭环。
