# Node CLI 示例

通过 `@portico/core` **在进程内**调用本地代理（Agent）——无需守护进程（daemon），无需 HTTP。

## 运行

```bash
# 列出发现的代理
node examples/node-cli list

# 提问，并将文件作为上下文
node examples/node-cli ask --provider codex --file examples/node-cli/context.md -m "What is the key risk?"
```

没有安装真正的代理？将提供商（provider）指向假代理（fake agent）：

```bash
PORTICO_CODEX_PATH="$PWD/test/fixtures/fake-agent.mjs" \
  node examples/node-cli ask --provider codex -m "hello"
```

## 功能展示

- `installBuiltinAdapters()` 用于注册 codex/claude/openclaw/hermes。
- `discoverAgents()` 用于获取代理列表。
- `runAgent()` 流式传输 `RuntimeEvent` 事件，将 `content` 渲染到 stdout，并将 `reasoning` 变暗后渲染到 stderr。
