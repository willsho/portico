# 安全模型

Portico 是一个本地 Agent 桥接层。其安全模型是分层的：本地绑定、可选的 token 认证、CORS 检查、子进程限制、工作区隔离、路径策略、测试、持久工件和显式 apply。

它不是针对任意代码的完整沙箱。

## 信任边界

Portico 运行用户机器上已安装的本地 Agent CLI。这些 CLI 可能读取本地配置、使用自己的凭据并执行 provider 特定的行为。

Portico 控制它们如何启动以及如何捕获它们的输出。它不会重写或完全沙箱化 provider 本身。

## 网络暴露

Daemon 默认绑定到 loopback：

```text
127.0.0.1:8787
```

未设置 token 时拒绝 LAN 暴露：

```bash
portico start --host 0.0.0.0 --lan
# 除非设置了 --token 或 PORTICO_TOKEN，否则被拒绝
```

安全的 LAN 示例：

```bash
portico start \
  --host 0.0.0.0 \
  --lan \
  --token "$PORTICO_TOKEN"
```

任何请求都必须包含：

```http
Authorization: Bearer <token>
```

## CORS

不带 `Origin` 头的请求被允许。浏览器请求允许来自：

- `localhost`；
- `127.0.0.1`；
- `[::1]`；
- 配置的 `allowOrigins`；
- 如果 `allowOrigins` 包含 `*`，则任何 origin。

显式添加生产 origin：

```bash
portico start --allow-origin https://example.internal
```

CORS 保护浏览器调用方。它不是认证；对暴露的 daemon 使用 token。

## 子进程控制

Portico 将 provider 作为子进程运行并应用：

- 超时看门狗；
- 最大输出上限；
- abort signal 取消；
- 当流被放弃时保证进程清理。

默认值：

```json
{
  "limits": {
    "defaultTimeoutMs": 120000,
    "maxContextChars": 120000,
    "maxOutputChars": 200000
  }
}
```

委派请求可以设置 `timeoutMs`。

## 工作区隔离

实现型委派默认使用隔离的 git worktree：

```text
.portico/worktrees/<run_id>
```

目标 Agent 编辑该 worktree。调用方的主 checkout 在用户运行以下命令之前不会被修改：

```bash
portico apply <run_id>
```

Review 委派默认使用共享工作区加只读权限 profile。Portico 检查 `git status --porcelain` 在 run 之后是否未发生变化。

共享 auto-edit run 是可能的，但刻意要求显式声明：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Directly edit this checkout" \
  --isolation shared \
  --permission-profile auto-edit
```

Portico 在共享 auto-edit run 之前要求工作树干净，以便生成的 diff 可以归因于被委派的 Agent。

## 权限 Profile

Portico 控制是否请求 provider 特定的自主编辑标志：

| Profile | 行为 |
| --- | --- |
| `default` | 不设置 provider 自动编辑标志 |
| `read-only` | 只读 run 语义；review 模式必需 |
| `auto-edit` | 在可用时追加 provider 自动编辑参数 |

示例：

| Provider | 自动编辑参数 |
| --- | --- |
| Codex | `--full-auto` |
| Claude Code | `--permission-mode acceptEdits` |
| Gemini | `--yolo` |
| Antigravity | `--dangerously-skip-permissions` |
| OpenCode | `--dangerously-skip-permissions` |

Provider 标志与版本相关，可能在执行工作区内产生更广泛的影响。对 auto-edit 优先使用隔离的 worktree。

## 路径策略

Portico 拒绝变更禁止路径或超出允许范围的路径的 run。

默认值：

```text
.env
.ssh/**
node_modules/**
dist/**
build/**
```

请求级控制：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Update the settings UI" \
  --allowed "src/**" \
  --allowed "tests/**" \
  --forbidden "src/secrets/**"
```

路径策略在 diff 生成之后执行。它不阻止子进程尝试更改，但阻止被禁止的 patch 变为 ready。

## Apply 关卡

`apply` 从不会自动执行。它必须显式请求：

```bash
portico apply <run_id>
```

Portico 在以下情况拒绝应用：

- run 不是 `ready` 状态；
- run 不是 `implement` 模式；
- patch 缺失；
- 主 worktree 有已跟踪的更改；
- `git apply` 失败。

应用的更改是未暂存的。用户仍需负责最终审查和提交。

## 工件与可审计性

每个 run 都会写入持久工件：

```text
.portico/runs/<run_id>/task.json
.portico/runs/<run_id>/events.ndjson
.portico/runs/<run_id>/agent.ndjson
.portico/runs/<run_id>/diff.patch
.portico/runs/<run_id>/test.log
.portico/runs/<run_id>/report.md
.portico/runs/<run_id>/result.json
```

报告记录工作区隔离、base ref、清理策略、权限 profile、目标 Agent、变更文件、测试及后续操作。

## Portico 不保证什么

Portico 当前不保证：

- OS 级沙箱化；
- provider CLI 的网络隔离；
- 从 provider 输出中脱敏 secrets；
- 阻止 provider 进行所有文件系统读取；
- daemon 重启后持久化 session；
- 对生成的 patch 进行自动安全审查。

将 Portico 用作受控的本地编排层，而非恶意代码沙箱。
