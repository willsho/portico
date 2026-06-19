<!-- Portico agent adapter evolution plan informed by mature local runtime adapter practices. -->
<!-- Input: existing local runtime adapter patterns, current Portico core/adapters. -->
<!-- Output: phased plan for provider metadata, discovery, probes, Codex JSON, probe cwd, and prompt transport. -->
<!-- Pos: 借鉴成熟 Agent adapter 实践，但保持 Portico 作为通用 runtime bridge 的轻量边界。 -->

# Agent Adapter 演进计划

Status: **planned**

## 0. 评审修订摘要（2026-06-19）

原始草案大量照搬某成熟产品 daemon 的 `runtimes/*` 结构。但 Portico 的 `AgentEntry`
当前只有三个真实消费者（`portico agents` 只渲染 4 列、`doctor`、daemon `/agents`），
很多字段**没有任何读取方**。按 YAGNI 削减后，本计划只保留「现在就有消费者」或「修正
真实 bug」的项：

**保留（近期有价值）：**

- Phase 5.1 probe cwd → tmpdir：修正只读 probe 在用户 repo 写文件的真实风险。
- Phase 2.1 discovery fault isolation：低成本安全网。
- Phase 3.1 Claude capability probe：避免向老版本/fork CLI 传未知 flag 导致启动失败。
- Phase 4 Codex `exec --json` 结构化解析：真实可见的输出质量提升。
- Phase 1 `versionArgs`：低成本，少数 CLI 不用 `--version`。

**削减 / 推迟到出现消费者再做：**

- `discoverAgentsStream()`：零消费者，7 个 provider 的短探测不需要完成序流式。
- model probe + `AgentEntry.models`：无 UI/校验读取方。
- auth probe + `authStatus`：无读取方，且明确不改变 `available`，纯信息字段。
- 结构化 `AgentDiagnostic`：复用现有 `reason: string` 即可。
- `promptTransport` 平行字段 + 优先级规则：与现有 `promptMode` 语义重复；`"file"`
  无 provider 需要。需要时直接给 `promptMode` 加 `"file"`，不引入第二字段。
- `resumesSessionViaCli` 布尔：`resumeArgs` 是否存在已经表达了同一信息。
- 共享 `json-event-stream.ts` engine：为「OpenCode 也许会复用」做的预先泛化；先在
  `codex.ts` 内实现，第二个真实消费者出现再抽取。
- Codex native launch resolver：未观测到失败前不预先实现。
- 每 provider 的 `maxPromptArgBytes`：用单个保守常量即可。

## 1. 背景

成熟本地 runtime adapter 设计通常已经覆盖了大量真实 CLI 兼容性问题：模型列表探测、auth 状态、help flag 能力探测、Codex native binary 解析、prompt 走 stdin 或文件、CLI 自带 session 恢复等。

Portico 当前的边界更干净：

- `@portico/core` 定义通用 `AgentProvider` / `AgentAdapter` / `RuntimeEvent`。
- `@portico/adapters` 注册 Codex、Claude、Gemini、OpenCode 等 provider。
- `discovery.ts` 做 env path / PATH / login shell / version probe。
- `runner.ts` 集中处理 timeout、output cap、AbortSignal 和 child cleanup。

这个计划的目标不是复制某个产品 daemon，而是提炼其中 5 个通用能力，逐步增强 Portico 的 adapter 层。

## 2. 目标

1. 让 provider metadata 能声明更多通用能力，但不绑定具体宿主产品。
2. 让 agent discovery 更稳：单个 provider probe 失败不拖垮整体列表，并支持流式探测。
3. 让 adapter 在传新 CLI flag 前先探测兼容性，减少老版本或 forked CLI 的启动失败。
4. 把 Codex 从 generic-cli 提升到结构化 JSON stream adapter。
5. 防止只读 probe 在用户 repo 里写入 lockfile、cache 或 node_modules。

## 3. 非目标

- 不引入产品级 UI 诊断文案、模型选择 UI、Langfuse、analytics、media、design-system 或产品路由概念。
- 不把 MCP 注入策略一次性塞进 `@portico/core`。MCP 可以后续独立设计。
- 不要求所有 provider 都实现模型列表、auth 探测或结构化协议。
- 不破坏现有 `createGenericCliAdapter()` 的低门槛接入路径。
- 不把 `AgentProvider` 做成一个承载所有产品行为的巨型对象。
- **不为尚无消费者的能力预先搭基础设施**。每个新字段/新 probe 必须先有读取它的代码
  （CLI 渲染、doctor、adapter 决策），否则推迟。参考产品有 UI 才需要 model/auth 列表，
  Portico 现在没有。

## 4. 借鉴来源

重点参考成熟本地 runtime adapter 中的这些模块形态：

- `apps/daemon/src/runtimes/types.ts`：厚 provider definition，包括 model/auth/capability/prompt/session 字段。
- `apps/daemon/src/runtimes/detection.ts`：fault isolation、并发 probe、streaming detection。
- `apps/daemon/src/runtimes/invocation.ts`：probe 默认 cwd 到 `os.tmpdir()`。
- `apps/daemon/src/runtimes/executables.ts` 和 `launch.ts`：GUI PATH、toolchain dir、Codex native binary 解析。
- `apps/daemon/src/runtimes/defs/{codex,claude,opencode}.ts`：真实 provider args、stdin prompt、模型列表、auth probe、capability probe。

Portico 对照文件：

- `packages/core/src/types.ts`
- `packages/core/src/discovery.ts`
- `packages/core/src/registry.ts`
- `packages/core/src/runner.ts`
- `packages/core/src/generic.ts`
- `packages/core/src/stream-json.ts`
- `packages/adapters/src/{codex,claude,opencode}.ts`

## 5. 设计原则

1. **小步扩展 contract**：优先增加可选字段，避免一次性重写 adapter 架构。
2. **core 保持宿主无关**：字段描述 runtime 能力，不描述 UI 展示或产品策略。
3. **探测和运行分离**：discovery 收集 facts，adapter run 使用 facts，但不让 probe 副作用污染用户 repo。
4. **可降级**：专用 probe 失败时保持 provider 可用，回退到已有 generic behavior。
5. **测试先覆盖风险点**：每个阶段至少有 fake-agent 或 pure parser 单测。

## 6. 总体架构变化

当前：

```text
AgentProvider
  - id/displayName
  - commandNames/envPathNames
  - protocols/defaultArgs/promptMode/autoEditArgs/resumeArgs

discoverAgent()
  -> AgentEntry

adapter.run(request, entry)
  -> RuntimeEvent stream
```

目标：

```text
AgentProvider
  - static identity and launch metadata
  - optional versionArgs（本轮）
  - optional capabilityProbe（本轮，Claude）
  - optional model/auth probe（推迟：无消费者）

discoverAgent()
  -> AgentEntry
      - availability / version（已有）
      - capabilities（本轮，仅 capabilityProbe 写入）
      - models / authStatus（推迟：无消费者）
      - reason: string（沿用，承载 fault-isolation 失败说明）

adapter.run(request, entry)
  -> chooses safe args from provider + entry facts
  -> RuntimeEvent stream
```

`AgentEntry` 可以扩展为运行时探测结果的载体，但仍然保持 JSON-serializable。
标注「推迟」的字段在出现读取方之前不实现，避免空字段污染 contract。

## 7. Phase 1：Provider Metadata 最小扩展

### 7.1 新增类型

在 `packages/core/src/types.ts` 增加可选字段：

本轮只加两个字段，其余字段等对应 probe（及其消费者）真正落地时再加，避免 contract
里出现没人写、没人读的占位字段。

```ts
export interface AgentProvider {
  id: string;
  displayName: string;
  commandNames: string[];
  envPathNames: string[];
  minVersion?: string;
  protocols: AgentProtocol[];
  defaultArgs?: string[];
  promptMode?: "stdin" | "argument";
  autoEditArgs?: string[];
  resumeArgs?: (agentSessionId: string) => string[];

  // 本轮新增：少数 CLI 不接受 `--version`（用 `version` / `-v`）。
  versionArgs?: string[];
  // 本轮新增（Phase 3）：仅 Claude 声明，探测 CLI 支持哪些 flag。
  capabilityProbe?: AgentCapabilityProbe;
}

export interface AgentCapabilityProbe {
  args: string[];
  timeoutMs?: number;
  /** flag 字符串 → capability key，命中即视为支持。 */
  flags: Record<string, string>;
}
```

**已从草案移除的字段及理由：**

- `promptTransport?: "stdin" | "argument" | "file"` —— 与现有 `promptMode` 语义重复，
  草案还要再定义一条「`promptTransport` 优先级高于 `promptMode`」的规则，纯属增负。真有
  provider 需要文件传 prompt 时，直接给 `promptMode` 加 `"file"` 成员即可。
- `resumesSessionViaCli?: boolean` —— `resumeArgs` 是否定义已经表达了「能否 CLI 恢复」，
  布尔字段是冗余真相源。
- `listModels` / `authProbe` 及其 `AgentModelProbe` / `AgentAuthProbe` 类型 —— 推迟到
  Phase 3，且只在出现读取 `models` / `authStatus` 的代码（doctor 列、UI）后才加。

扩展 `AgentEntry`（同样只加本轮会被写入+读取的字段）：

```ts
export interface AgentEntry {
  provider: string;
  displayName: string;
  available: boolean;
  path?: string;
  version?: string;
  versionStatus?: "ok" | "too_old" | "unknown";
  protocols: AgentProtocol[];
  reason?: string;
  source?: "env" | "path" | "login-shell" | "config";
  // 本轮新增（Phase 3）：capabilityProbe 的结果，adapter 据此挑安全 args。
  capabilities?: Record<string, boolean>;
}
```

`models` / `modelsSource` / `authStatus` 推迟到对应 probe 落地。fault-isolation 的失败
说明直接写进现有 `reason: string`，不引入结构化 `AgentDiagnostic`（4 列表格和 doctor
都只需要一句人读文本，结构化 code/detail 暂无消费者）。

### 7.2 迁移策略

- `versionArgs` 缺省为 `["--version"]`，保持现有行为。
- `capabilityProbe` 是可选增强，不声明的 provider（除 Claude 外全部）行为不变。
- `AgentEntry` 新字段只增不删，client/daemon 可忽略。

### 7.3 测试

- `types` 不需要运行时测试。
- 更新 discovery tests，断言 provider 没有 probe 字段时行为不变。
- 增加 fake provider，覆盖 `versionArgs` 非默认值。

## 8. Phase 2：Discovery 稳定性和流式探测

### 8.1 Fault isolation

当前 `discoverAgents()` 对所有 provider 做 `Promise.all()`。需要保证任一 provider 的同步 throw 或异步 reject 都返回 unavailable entry，而不是让整体 discovery 失败。

新增内部 helper：

```ts
async function safeDiscoverAgent(
  provider: AgentProvider,
  options: DiscoverOptions,
): Promise<AgentEntry> {
  try {
    return await discoverAgent(provider, options);
  } catch (err) {
    return {
      provider: provider.id,
      displayName: provider.displayName,
      available: false,
      protocols: provider.protocols,
      reason: `Discovery probe failed: ${errorMessage(err)}`,
    };
  }
}
```

`discoverAgents()` 改为调用 `safeDiscoverAgent()`。

### 8.2 Streaming discovery（推迟，本轮不做）

草案的 `discoverAgentsStream()`（按完成顺序 yield）当前**零消费者**：CLI `agents` 一次
性打印表格、daemon 一次性返回 `/agents`、没有 web/electron host。7 个 provider 的探测都
是亚秒级只读 spawn，「边探测边展示」省不下有意义的时间。等真有增量 UI host 时再加，签名
也应由那个 host 的需求决定，而不是现在猜。

`discoverAgents()` 维持「`Promise.all` + fault isolation」即可。

### 8.3 并发和超时

- 保持 provider 之间并发。
- 每个 probe 使用已有 `versionTimeoutMs` / provider-specific timeout。
- 不新增全局并发池；agent discovery 是短命只读 probe，复杂度暂时不需要。

### 8.4 测试

- 一个 fake provider 的 detect/probe 故意 throw，断言其他 provider 仍返回，且故障 entry
  带 `available: false` 和 `reason`。

## 9. Phase 3：Capability Probe（model/auth probe 推迟）

本轮只做 capability probe，因为它有真实的 adapter 决策消费者。model/auth probe 推迟，
理由见 §9.2 / §9.3。

注意成本：每个声明了 probe 的 provider 在 discovery 时会多 spawn 一次。因此只给真正需要
的 provider（Claude）声明，不对全表开启；并复用 `versionTimeoutMs` 级别的短超时。

### 9.1 Capability probe

实现 `capabilityProbe`：

```ts
capabilityProbe: {
  args: ["-p", "--help"],
  flags: {
    "--include-partial-messages": "partialMessages",
    "--add-dir": "addDir",
  },
}
```

Discovery 执行后写入：

```ts
entry.capabilities = {
  partialMessages: true,
  addDir: true,
};
```

Claude adapter 读取 `entry.capabilities`：

- 只有 `partialMessages === true` 才传 `--include-partial-messages`。
- `addDir === false` 时不传 `--add-dir`。
- capability probe 失败时返回 `{}`，adapter 使用保守 args。

### 9.2 Model probe（推迟）

草案要 `codex debug models` / `opencode models` 填 `AgentEntry.models`，但：

- 当前**没有读取 `models` 的代码**。`portico agents` 不显示 model，没有模型选择 UI，
  adapter 也不校验 model（`ChatRequestOptions.model` 直接透传给 CLI）。
- 每个 provider 多一次 spawn，换来一个没人读的数组。

**结论：推迟。** 等出现「doctor 显示可用 model」或「host UI 选 model」这类消费者时再做，
届时再决定 probe 接口形状。

### 9.3 Auth probe（推迟）

同理。草案自己也写明「probe 失败不改变 `available`，只标 `authStatus`」——即纯信息字段，
而当前没有任何代码读 `authStatus`。`codex login status` / `claude auth status` 这类子命令
还可能不存在或较慢。真实 run 失败时给出的错误已经足够 actionable。

**结论：推迟**，直到 doctor 或 host UI 真的要展示登录态。

### 9.4 测试

- fake agent 支持 `--help`，stdout 包含/不包含 flag，断言 `entry.capabilities`。
- Claude adapter 单测：capability absent 时不传 partial flag；capability present 时传。
- capability probe 失败（非零退出 / 超时）时 `capabilities` 为 `{}`，adapter 用保守 args，
  provider 仍 `available`。

## 10. Phase 4：Codex JSON Stream Adapter

### 10.1 动机

Portico 当前 Codex adapter 走 generic-cli：

```ts
defaultArgs: ["exec"]
autoEditArgs: ["--full-auto"]
```

这能工作，但无法稳定区分：

- assistant content
- reasoning
- tool_call
- tool_result
- usage
- native session id
- structured error

成熟 Codex adapter 实践中常用 `codex exec --json`，可以成为 Portico 专用 Codex adapter 的方向。

### 10.2 新增 engine 或 adapter

选择 A：新增 `json-event-stream.ts` engine（通用 NDJSON 框架 + provider translator）。

选择 B：只在 `packages/adapters/src/codex.ts` 内实现 Codex parser。

**推荐 B。** 草案推荐 A 的理由是「OpenCode 也可能复用」——但这是为一个假设的第二消费者
做的预先泛化。OpenCode 当前走 generic-cli 的 argument 模式，并没有确认要 JSON 协议。先在
`codex.ts` 里把 Codex 的 NDJSON → RuntimeEvent 翻译写成**纯函数**（便于单测），等真有第二个
provider 需要逐行 JSON 时，再把共同的「按 `\n` 切行 + 逐行翻译」骨架抽到 core（届时已有
`stream-json.ts` 的 `handleLine` 切行逻辑可直接借鉴）。

命名注意：core 已有 `stream-json.ts`（Claude 协议）和 `AgentProtocol` 里的 `json-stream`、
`stream-json` 两个枚举。再加一个 `json-event-stream` 会让三者难以区分。若将来确需抽取，复用
现有命名空间，别再造近义名。

### 10.3 Codex args

初始 args：

```ts
[
  "exec",
  "--json",
  "--skip-git-repo-check",
]
```

auto-edit 时再追加 workspace 写权限相关参数。不要默认给普通 chat 写权限。

需要保留 Portico 的原则：

- 普通 chat 默认不授予 autonomous editing。
- delegation 或明确 `options.autoEdit` 才追加 edit args。
- `cwd` 由 caller 明确传入。

### 10.4 Codex native launch（推迟，依赖实测）

参考产品有 launch resolver 处理「npm wrapper 找不到正确 native binary」。但 Portico 是否
真遇到这个问题尚未观测到——现有 discovery 已能解析到 `codex` 可执行路径。在没有复现的启动
失败前不预先实现 `resolveProviderLaunch`，否则是为臆想的故障写代码。

若 `codex exec --json` 上线后出现 wrapper/native binary 的真实启动失败，再作为 Codex
provider-specific 的解析步骤补上，且不要塞进通用 PATH resolver 主流程。

### 10.5 测试

- fake Codex agent 输出 NDJSON：content/reasoning/tool/done/usage。
- parser pure tests：未知 JSON shape 被忽略或降级，不 throw。
- run tests：`codexAdapter` 产生 `RuntimeEvent` 序列。
- autoEdit tests：普通请求不包含 edit args，`autoEdit` 请求包含。

## 11. Phase 5：Probe CWD 和 Prompt Transport

### 11.1 Probe cwd

所有只读 probe 默认不应继承当前 repo cwd。新增：

```ts
export async function captureProbe(
  command: string,
  args: string[],
  options: SpawnStreamOptions = {},
): Promise<CaptureResult> {
  return capture(command, args, {
    cwd: options.cwd ?? tmpdir(),
    ...options,
  });
}
```

Discovery 的 version/model/auth/help probe 使用 `captureProbe()`。

真实 agent run 继续使用 `request.options?.cwd`。

### 11.2 Prompt transport（不引入新字段）

草案要把 `promptMode` 演进为平行字段 `PromptTransport` 并定义优先级规则——这是凭空多一个
真相源。当前没有任何 provider 需要文件传 prompt（`"file"`）。

**结论：保持现有 `promptMode: "stdin" | "argument"`。** 将来真有 provider 必须用临时文件
传 prompt 时，直接给这个联合类型加 `"file"` 成员、在 generic engine 里实现该分支即可，不需
要第二个字段和优先级逻辑。

### 11.3 长 prompt 保护

对 argument 模式（gemini / opencode）的 prompt 增加 argv 长度保护：

- 用 core 里一个保守常量（如 128 KiB）作上限，超限返回 `RuntimeEvent.error`，提示改用
  stdin 模式的 provider。
- 不引入每 provider 的 `maxPromptArgBytes` 字段——平台 `ARG_MAX` 差异远小于一个保守常量
  的安全余量，逐 provider 调参属过度配置。
- 不自动切换 stdin（会改变 provider 行为契约）。

### 11.4 测试

- fake probe 会在 cwd 写文件；断言 discovery 后 workspace 没有被写，临时目录写入不影响 repo。
- argument prompt 超过常量上限时返回明确 error。
- stdin prompt 不受 argv 长度限制。

## 12. 里程碑

### M1：Contract 和 Discovery 基础

范围：

- 扩展 `AgentProvider`（`versionArgs`、`capabilityProbe`）/ `AgentEntry`（`capabilities`）。
- `discoverAgents()` fault isolation。
- probe 默认 cwd 到 temp dir。

验收：

- 现有 discovery tests 通过。
- 新增 fault isolation test 和 probe-cwd test。
- 文档更新 provider adapter 指南。

### M2：Capability Probe

范围：

- capability probe（仅 Claude 声明）。
- Claude adapter 根据 `entry.capabilities` 控制 args（如 `--include-partial-messages`）。

验收：

- fake provider 单测覆盖 capability probe（命中/未命中/probe 失败）。
- Claude 老版本兼容测试：不支持 partial flag 时仍能 run。

### M3：Codex JSON Adapter

范围：

- 在 `codex.ts` 内实现 Codex NDJSON → RuntimeEvent 纯函数 translator。
- Codex adapter 使用 `codex exec --json`，generic-cli 作为可降级 fallback。

验收：

- fake Codex NDJSON tests（content/reasoning/tool/usage）。
- 未知 JSON shape 被忽略/降级，不 throw。
- autoEdit 请求才含 edit args。

### M4：长 prompt 保护

范围：

- argument prompt 的 argv 长度 guard（core 保守常量）。

验收：

- argument prompt 超限返回明确 error；stdin 不受限。
- docs/configuration 更新（若有用户可见行为变化）。

## 13. 风险和缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| `AgentProvider` 变复杂 | Portico 失去轻量边界 | 新增字段必须可选；无消费者的字段一律推迟（见 §0/§3）|
| capability probe 增加 discovery 时间 | `portico agents` 变慢 | 仅 Claude 声明 probe；复用短超时 |
| Codex JSON event shape 变化 | parser 失效 | parser 对未知 shape 容忍；保留 generic fallback |
| probe 在 repo 写文件 | 污染用户 workspace | probe cwd 默认 temp dir，并加测试覆盖 |

## 14. 推荐实施顺序

本计划一次性落地（单 PR 或一组连续提交），但按依赖顺序内部分层，便于 review 和回滚：

1. M1（含 probe cwd → tmpdir）：契约扩展 + fault isolation，是后续基础，先合。
2. M2 Claude capability probe：依赖 M1 的 `capabilityProbe` / `capabilities` 字段。
3. M3 Codex `exec --json`：行为变化最大的一块，translator 纯函数 + fake NDJSON tests
   独立成 commit，便于单独定位回归。
4. M4 长 prompt guard：与上面解耦，最后补。

落地后用一次 `npm test` + 三场景 `portico agents`（无 agent / fake agent / 部分 broken）
统一验收。Codex JSON 即便和其余项同 PR，也务必保留 generic-cli 可降级路径，确保 `--json`
契约出问题时能快速回退。

model/auth probe、streaming discovery、native launch resolver 等不在本计划范围，等出现
真实消费者或实测故障后另立计划（见 §0）。

## 15. 完成定义

- `npm test` 通过。
- `portico agents` 在无真实 agent、fake agent、部分 broken provider 三种场景下都有稳定输出。
- 普通 chat 不获得 auto-edit 权限。
- Claude/Codex adapter 行为有 provider-specific 单测。
- 新增字段在 README 或 `docs/configuration*.md` 中有说明。
- 不引入 telemetry、analytics、云服务或 host-product 专属概念。
