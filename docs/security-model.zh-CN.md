# 安全模型 (Security Model)

Portico 是一个本地代理桥接器。它的安全模型是分层的：本地绑定、可选的令牌认证、CORS 检查、子进程限制、工作区隔离、路径策略、测试、持久化产物和明确的应用（apply）。

它不是用于执行任意代码的完整沙箱。

## 信任边界

Portico 运行已经安装在用户机器上的本地代理 CLI。这些 CLI 可能会读取本地配置、使用其自己的凭据，并执行特定于提供商的行为。

Portico 控制它们的启动方式以及如何捕获它们的输出。它不会重写或完全沙箱化提供商本身。

## 网络暴露

守护进程默认绑定到回环地址（loopback）：

```text
127.0.0.1:8787
```

没有令牌将拒绝 LAN 暴露：

```bash
portico start --host 0.0.0.0 --lan
# 拒绝，除非设置了 --token 或 PORTICO_TOKEN
```

安全的 LAN 示例：

```bash
portico start \
  --host 0.0.0.0 \
  --lan \
  --token "$PORTICO_TOKEN"
```

之后的任何请求都必须包含：

```http
Authorization: Bearer <token>
```

## CORS

允许没有 `Origin` 头的请求。允许来自以下来源的浏览器请求：

- `localhost`;
- `127.0.0.1`;
- `[::1]`;
- 配置的 `allowOrigins`；
- 任何来源（如果 `allowOrigins` 包含 `*`）。

明确添加生产环境来源：

```bash
portico start --allow-origin https://example.internal
```

CORS 保护浏览器调用者。它不是身份验证；对于暴露的守护进程，请使用令牌。

## 子进程控制

Portico 将提供商作为子进程运行，并应用以下控制：

- 超时看门狗；
- 最大输出上限；
- 中止信号取消；
- 在流被放弃时保证清理。

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

实现（Implementation）委派默认使用隔离的 git 工作树：

```text
.portico/worktrees/<run_id>
```

目标代理在该工作树中启动。预期的路径是调用者的主检出（main checkout）不会被修改，直到用户运行：

```bash
portico apply <run_id>
```

审查（Review）委派默认使用共享工作区以及只读权限配置。Portico 会检查运行后 `git status --porcelain` 是否保持不变。

共享的自动编辑（Shared auto-edit）运行是可能的，但被有意设计为必须明确指定：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Directly edit this checkout" \
  --isolation shared \
  --permission-profile auto-edit
```

Portico 要求在共享自动编辑运行之前工作树是干净的，以便生成的差异可以归因于受委派的代理。

对于工作树运行，Portico 在创建隔离工作树后对调用者的主检出进行快照，并在目标代理退出后再次检查。如果受委派者写入了工作树之外的内容，运行将被标记为 `failed`，`events.ndjson` 记录 `sandbox_escape_detected`，并且 `result.json` 记录 `sandboxEscaped` 加上 `outOfTreeChanges`。Portico 会报告这些更改，但不会自动还原它们。

## 权限配置

Portico 控制是否请求特定于提供商的自主编辑标志：

| 配置 | 行为 |
| --- | --- |
| `default` | 没有提供商的自动编辑标志 |
| `read-only` | 只读运行语义；审查所需 |
| `auto-edit` | 附加提供商自动编辑参数（当可用时） |

示例：

| 提供商 | 自动编辑参数 |
| --- | --- |
| Codex | `--full-auto` |
| Claude Code | `--permission-mode acceptEdits` |
| Gemini | `--yolo` |
| Antigravity | `--dangerously-skip-permissions` |
| OpenCode | `--dangerously-skip-permissions` |

提供商标志对版本敏感，并可能在执行工作区内产生更广泛的影响。对于自动编辑，优先使用隔离的工作树。

## 路径策略

Portico 会拒绝更改被禁止的路径或允许集之外的路径的运行。

默认值：

```text
.env
.ssh/**
node_modules/**
dist/**
build/**
```

请求级别的控制：

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Update the settings UI" \
  --allowed "src/**" \
  --allowed "tests/**" \
  --forbidden "src/secrets/**"
```

路径策略在生成差异之后强制执行。它不会阻止子进程尝试更改，但它会阻止违禁的补丁变为就绪（ready）状态。

## 应用门控 (Apply Gate)

`apply` 从不自动执行。它必须被明确请求：

```bash
portico apply <run_id>
```

当出现以下情况时，Portico 拒绝应用：

- 运行不是 `ready` 状态；
- 运行不是 `implement` 模式；
- 补丁丢失；
- 主工作树有被跟踪的更改；
- `git apply` 失败。

应用的更改处于未暂存（unstaged）状态。用户仍然负责最终审查和提交。

## 产物与可审计性

每次运行都会写入持久化的产物：

```text
.portico/runs/<run_id>/task.json
.portico/runs/<run_id>/events.ndjson
.portico/runs/<run_id>/agent.ndjson
.portico/runs/<run_id>/diff.patch
.portico/runs/<run_id>/test.log
.portico/runs/<run_id>/report.md
.portico/runs/<run_id>/result.json
```

报告记录工作区隔离、基础引用、清理策略、权限配置、目标代理、工作树更改、树外更改、门控警告、遥测、测试以及下一步操作。

## Portico “不”保证什么

Portico 目前**不**保证：

- 操作系统级别的沙箱；
- 为提供商 CLI 提供网络隔离；
- 从提供商输出中对机密信息进行脱敏（redaction）；
- 阻止提供商的所有文件系统读取；
- 阻止提供商的所有文件系统写入；
- 跨守护进程重启的持久会话保存；
- 对生成的补丁进行自动安全审查。

将 Portico 用作受控的本地编排层，而不是用作敌对代码（hostile-code）的沙箱。
