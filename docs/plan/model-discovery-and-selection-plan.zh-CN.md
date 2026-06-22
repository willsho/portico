# Portico 模型发现与选择 开发计划

> 让用户（或编排 Agent）能为一次 delegation 选定目标 agent 的**模型**与**推理强度
> （effort）**，并把它翻译成目标 CLI 的原生参数。本文给出完整设计（发现 / 校验 / 执行
> 三层）与分期落地，第 1 期已随本计划一同实现。

## 1. 背景

Portico 把编码任务委派给本机的编码 agent（claude / codex / gemini / cursor …），在隔离
worktree 中执行并产出可审阅的 patch。目标 agent 用哪个**模型**跑，目前是不可控的：

- `ChatRequestOptions.model`（`packages/core/src/types.ts:99`）、`ChildSpec.model` /
  `ChildSpec.effort`（`packages/orchestrator/src/types.ts:43-46`）这些字段**已经声明**，
  注释也写着「adapter-supporting passthrough」。
- 但它们是**死占位**：orchestrator 构造 `ChatRequest.options` 时只塞了
  `cwd / timeoutMs / autoEdit`（`packages/orchestrator/src/orchestrator.ts:1862`、
  `:1480`），从没把 `model` / `effort` 拷进去；而且两个执行引擎
  （`packages/core/src/generic.ts`、`packages/core/src/stream-json.ts`）**根本没有**把
  `options.model` 注入到 CLI 参数里。

所以这是一次「接线 + 补齐」，不是改既有逻辑。终态目标：

```
portico delegate --to claude --model opus --effort high …
  → claude -p … --model opus --effort high
```

## 2. 设计参照与第一性原理

参照业界做法（一个带 Web 前端的 server）总结出三层协作：**模型发现（Discovery）→
选择校验（Validation）→ 执行注入（Execution）**。这个骨架适用于 Portico，但 Portico 的
本质不同，因此在 5 处刻意偏离参照方案：

| # | 参照方案 | Portico 的做法 | 理由 |
| --- | --- | --- | --- |
| 1 | 模型列表喂给前端下拉菜单 | 输出是 `--json` + skill 文字指引，消费方是**编排 Agent**或命令行用户 | Portico 无 GUI；选模型的是读 SKILL.md 调 CLI 的 agent，或终端里的人 |
| 2 | 按 provider 硬编码注入（`buildClaudeArgs`） | provider 声明 `modelArgs(m) => string[]`，引擎统一调用 | 与现有 `resumeArgs` / `autoEditArgs` 一致，引擎不长 provider 知识 |
| 3 | 入口总是列出全部模型（含探测） | 模型探测**惰性 + 按需**，绝不拖慢热路径 | 最高频路径（delegate 不带 `--model` → 用 CLI 默认）根本不需要模型列表 |
| 4 | 静态目录精确匹配，命中才放行 | 只对**权威静态目录**拒绝；探测目录 / 空目录一律放行 | 探测结果可能过时 / 不全，错杀比放行更糟 |
| 5 | 标记 `Default` 为默认选中并使用 | `default` 仅作展示，**绝不自动注入** | 省略 flag 让 CLI 用自己的默认，比 Portico 钉一个会漂移的默认更健壮 |

第 2、3 点是最关键的架构分歧。

## 3. 设计约束

1. **无 build step**：Portico 用 Node 原生 type stripping 直接跑 TS，新增代码必须是可擦除的
   TS（erasable-TS），不能引入 enum / 装饰器 / 带运行时语义的 namespace。
2. **零新增运行时依赖**：发现与探测都用标准库（复用已有的 `captureProbe`）。
3. **引擎保持 provider-agnostic**：模型注入逻辑不进引擎的 switch；引擎只调用 provider 声明的
   arg-builder。
4. **优雅降级**：发现 / 探测失败、未知 provider、无法解析的输出 → 返回空目录、放行透传，
   绝不报错或臆造，沿用 `discovery.ts` 既有哲学。
5. **companion 文件同步**（见 `AGENTS.md`）：触及 CLI surface 时，同一改动里更新
   `packages/skills/portico/SKILL.md` 与英文 `docs/` / `README.md`。

## 4. 三层设计

### 4.1 第一层：模型发现（静态目录 + 动态探测，声明式）

在 `AgentProvider` 上新增可选 `models` 字段，与现有 `capabilityProbe` 并列；两条路径都由
provider 声明，发现器 / 引擎只负责执行。

```ts
// packages/core/src/types.ts
export interface ModelDescriptor {
  id: string;              // 直接传给 CLI flag 的值
  label?: string;          // 给人 / Agent 看的名字
  default?: boolean;       // provider 的默认模型（仅展示，见分歧 #5）
  aliases?: string[];      // 接受用户简写，如 "sonnet" → "claude-sonnet-4-6"
  effortLevels?: string[]; // 该模型支持的 effort 档（可选；缺省取 provider 级）
}

export interface AgentProvider {
  // …现有字段…
  models?: {
    /** 稳定可控的 ID，硬编码（claude / codex / gemini）。 */
    static?: ModelDescriptor[];
    /** 向 CLI 询问实时目录（cursor / opencode …），复用 captureProbe。 */
    probe?: {
      args: string[];                                       // 如 ["--list-models"]
      timeoutMs?: number;
      parse: (stdout: string, stderr: string) => ModelDescriptor[];
    };
  };
  /** 把选定模型翻译成原生 flag（claude: m => ["--model", m]）。 */
  modelArgs?: (model: string) => string[];
  /** 把选定 effort 翻译成原生 flag（claude: e => ["--effort", e]）。 */
  effortArgs?: (effort: string) => string[];
}
```

发现结果挂到 `AgentEntry`（与现有 `capabilities` 一样）：

```ts
export interface AgentEntry {
  // …
  models?: ModelDescriptor[];
  /** 模型选择是否由 runtime 自管（即 provider 未声明 modelArgs）。 */
  modelSelection?: "supported" | "managed-by-runtime";
}
```

**关键决策——惰性探测（分歧 #3）**：`discoverAgents()` 维持现有快速二进制探测**不变**，
绝不在里面跑 N 个 `--list-models`。模型目录通过独立函数按需获取：

```ts
// packages/core/src/models.ts
export async function discoverModels(
  provider: AgentProvider,
  entry: AgentEntry,
  env?: NodeJS.ProcessEnv,
): Promise<ModelDescriptor[]>; // static 直接返回；probe 走 captureProbe + TTL 缓存
```

缓存沿用「TTL ~60s、key = provider.id + entry.path」，但**只在被调用时**才填充。理由：
`delegate` 不带 `--model` 是最高频路径，它只需「用 CLI 默认」，不必知道有哪些模型；只有
「列出模型」与「校验传入的 `--model`」两个场景才需要目录。未知 provider / 无法探测 → 空目录
（不报错）。

### 4.2 第二层：选择与校验（保守、前置）

三个纯函数，全部可单测：

```ts
// packages/core/src/models.ts
export function modelSelectionSupported(p: AgentProvider): boolean {
  return typeof p.modelArgs === "function";
}

/** 别名 / 简写归一到真实 ID（"opus" → "claude-opus-4-8"）。无法归一则原样返回。 */
export function resolveModel(models: ModelDescriptor[], input: string): string;

/** 仅当「有权威静态目录」且「归一后 ID 不在其中」时为 true；否则一律放行（分歧 #4）。 */
export function modelKnownIncompatible(
  p: AgentProvider,
  models: ModelDescriptor[],
  model: string,
): boolean;
```

**校验时机——前置到 delegate 请求受理时**（CLI `delegate.ts` 解析后、daemon route 受理
时），而非等 30 秒进了 worktree 才让 CLI 报一个晦涩的错。失败信息要可执行：

```
× claude 无法识别模型 "gpt-5"。
  已知：sonnet（默认）, opus, haiku, claude-opus-4-8, …
  （想强行透传自定义 ID，请加 --model-force）
```

`--model-force` 是逃生口（绕过 `modelKnownIncompatible`），因为静态目录可能滞后于新发布的
模型。若 provider `modelSelection === "managed-by-runtime"`（未声明 `modelArgs`，如
openclaw / hermes），传 `--model` 时 **warn 并忽略**，不阻断运行。

### 4.3 第三层：执行时注入（声明式 arg-builder，分歧 #2）

照搬现有 `resumeArgs: (id) => string[]` 的形态。两个引擎各加几行（`generic.ts` 与
`stream-json.ts` 的 args 拼接处）：

```ts
const modelArgs =
  request.options?.model && provider.modelArgs ? provider.modelArgs(request.options.model) : [];
const effortArgs =
  request.options?.effort && provider.effortArgs ? provider.effortArgs(request.options.effort) : [];
const args = [...baseArgs, ...editArgs, ...modelArgs, ...effortArgs, ...resumeArgs];
```

`options.model` 为空 → 不拼任何 flag → CLI 用自己的默认（精确对应分歧 #5）。不同协议各自
翻译：generic / stream-json 走 flag；将来 acp 走 `session/set_model` RPC——但数据流统一。

**已核实的 worked examples（对照各 CLI `--help`）**：

| provider | modelArgs | effortArgs | 备注 |
| --- | --- | --- | --- |
| claude | `m => ["--model", m]` | `e => ["--effort", e]` | `--effort` 档：low / medium / high / xhigh / max；别名 fable / opus / sonnet |
| codex | `m => ["--model", m]` | `e => ["-c", \`model_reasoning_effort=${e}\`]` | `-m` / `--model`；effort 走 config override |
| gemini | `m => ["--model", m]` | —（暂无） | 文档化 `-m` / `--model`；本机未安装，按文档声明 |

## 5. 数据流（统一闭环）

```
人 / 编排 Agent
  → portico delegate --to claude --model opus --effort high   （portico models 可先查目录）
  → [前置校验] resolveModel("opus") → claude-opus-4-8；modelKnownIncompatible? 否
  → DelegateRequest.model / effort（顶层；child 由 ChildSpec 覆盖）
  → orchestrator 拷进 ChatRequest.options
  → 引擎调 provider.modelArgs / effortArgs 翻译成原生 flag
  → claude -p … --model claude-opus-4-8 --effort high
```

## 6. 分期落地

### 第 1 期：核心类型 + 执行注入（本计划随附实现）

纯加法、风险最低，能立刻让 `--model` / `--effort` 对 claude / codex 生效（先通过编程接口 /
orchestrator 透传，CLI flag 在第 2 期暴露）。

1. `packages/core/src/types.ts`：新增 `ModelDescriptor`；`AgentProvider` 加 `models` /
   `modelArgs` / `effortArgs`；`ChatRequestOptions` 加 `effort?: string`。
2. `packages/core/src/generic.ts`、`stream-json.ts`：args 拼接处追加 `modelArgs` /
   `effortArgs`（空值不拼）。
3. adapter provider 声明模型元数据：claude（`adapters/src/claude.ts`）、codex
   （`adapters/src/codex.ts`）补 `models.static` + `modelArgs` + `effortArgs`；gemini
   （`adapters/src/gemini.ts`）补 `modelArgs`。
4. `packages/core/src/index.ts` 导出新增类型 `ModelDescriptor`。
5. 单测：注入逻辑（generic / stream-json 在 model / effort 下拼出正确 flag、空值不拼、
   provider 未声明 arg-builder 时安全跳过）。

非目标（留给后续）：模型发现 / 探测、校验、CLI flag、`portico models`、orchestrator 透传。

### 第 2 期：透传接线 + CLI flag

1. orchestrator 两处（`:1862` / `:1480`）把 `request.model` / `request.effort` 拷进
   `ChatRequest.options`。
2. `DelegateRequest` 加顶层 `model?` / `effort?`；fan-out 时 `ChildSpec` 覆盖 group。
3. CLI `delegate` 加 `--model` / `--effort` / `--model-force`，daemon route 透传。
4. 端到端：`portico delegate --to claude --model opus` 真能让 claude 换模型。

### 第 3 期：发现 + 校验

1. `packages/core/src/models.ts`：`discoverModels` / `resolveModel` /
   `modelSelectionSupported` / `modelKnownIncompatible` + TTL 缓存。
2. `AgentEntry.models` / `modelSelection` 字段填充。
3. `portico models [--to <agent>] [--json]`（按需触发探测）。
4. delegate 前置校验 + `--model-force` 逃生口。
5. `models.test.ts`。

### 第 4 期：探测型 provider + 文档同步

1. cursor / opencode 的 `models.probe`。
2. `managed-by-runtime` 提示（openclaw / hermes）。
3. 报告里记录实际生效的 model / effort（compare 模式区分候选）。
4. 同步 `packages/skills/portico/SKILL.md` 与英文 `docs/` / `README.md`。

## 7. 第 1 期测试计划

沿用 `node:test`，放在 `packages/adapters/tests/`（复用已有 fake-agent fixture）与
`packages/core/tests/`：

1. **generic-cli 注入**：构造带 `modelArgs` / `effortArgs` 的 provider，设
   `options.model` / `options.effort`，断言 spawn 收到的 argv 含对应 flag、顺序正确。
2. **空值不拼**：`options.model` / `effort` 缺省时，argv 不含 model / effort flag。
3. **provider 未声明 arg-builder**：即使传了 `options.model`，也安全跳过、不抛错。
4. **stream-json 注入**：同 1，针对 claude 风格的 stream-json 引擎。
5. **回归**：`npm test` 全绿、`npm run typecheck` 干净。

## 8. 风险与对策

| 风险 | 对策 |
| --- | --- |
| flag 名写错导致目标 CLI 报错 | 第 1 期所有 flag 已对照本机 `claude --help` / `codex exec --help` 核实；gemini 按官方文档并在表中标注未本机验证 |
| 探测拖慢 `portico agents` / daemon 启动 | 分歧 #3：探测惰性化，不进 `discoverAgents` 热路径（第 3 期） |
| 校验错杀新发布模型 | 分歧 #4：只对权威静态目录拒绝 + `--model-force` 逃生口（第 3 期） |
| Portico 钉的默认模型随 CLI 升级漂移 | 分歧 #5：`default` 仅展示，从不自动注入；缺省即让 CLI 自己决定 |
| 引擎被塞进 provider 专属逻辑 | 注入走声明式 arg-builder，引擎无 switch |

## 9. 完成定义（第 1 期 DoD）

1. `ModelDescriptor` 与 `AgentProvider.models` / `modelArgs` / `effortArgs` /
   `ChatRequestOptions.effort` 类型落地并导出。
2. 两个引擎在 `options.model` / `options.effort` 下注入正确原生 flag，空值不拼，未声明
   arg-builder 安全跳过。
3. claude / codex / gemini 的 provider 声明了模型元数据。
4. 新增注入单测通过；`npm test` 与 `npm run typecheck` 全绿。
