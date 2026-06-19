# Web 阅读器示例

一个纯 HTML/JS 页面，它可以检测运行中的 Portico 守护进程，列出本地代理，将文章作为 `ContextBundle` 发送，并流式传输回答——包含实时的**推理（reasoning）**面板、**工具活动（tool-activity）**日志以及恢复相同会话的多轮**后续对话（follow-ups）**。无构建步骤，无框架。

## 运行

```bash
# 1. 启动守护进程。如果没有真实的代理，可以指向假代理——它使用 Claude 的
#    stream-json，因此可以在页面中选择 "Claude Code" 来测试推理、工具活动
#    和可恢复的后续对话。（PORTICO_CODEX_PATH 也可以，但 generic-cli 仅
#    流式传输纯 `content`。）
export PORTICO_CLAUDE_PATH="$PWD/test/fixtures/fake-agent.mjs"
npm run portico -- start

# 2. 在 http://localhost 上提供页面服务（以便浏览器 Origin 通过守护进程的 CORS）
node examples/web/serve.mjs
# 打开 http://localhost:5173
```

如果 Portico 未运行，页面会显示一个 **offline**（离线）标识和解释，而不是静默失败——这是每个 Portico Web 应用都应具备的优雅降级路径。

## 注意事项

- `app.js` 内联了一个微型客户端（fetch + NDJSON 读取器），因此该示例无依赖。在真实的应用程序中，您应该使用 `import { createPorticoClient } from "@portico/client"`——它实现了相同的功能，并支持类型化错误和 `AbortController`。
- **推理/工具面板** 仅对使用结构化协议的代理（例如 Claude Code）填充数据。generic-cli 代理（例如 Codex）仅流式传输纯 `content`，因此这些面板保持为空——这是符合预期的。
- **会话（Sessions）**：页面保留第一个 `start` 事件中的 `sessionId`，并在每一轮中重新发送，因此后续对话将恢复相同的对话。**新建对话（New chat）**（或切换代理）会丢弃该句柄并重新开始。
- 通过 `file://` 提供服务会发送一个不透明的（`null`）Origin，会被守护进程的默认 CORS 拒绝。这就是为什么需要 `serve.mjs` 从 `http://localhost` 提供服务的原因。
