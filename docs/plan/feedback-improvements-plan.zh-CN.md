# Portico 使用痛点改进计划

来源：两位用户的实战反馈（用户1 #4–#10，用户2 #1–#7）。本计划把 17 条反馈收敛为 **5 条工作流**，
避免逐条造功能。许多反馈本质重叠，归并如下：

| 反馈聚类 | 涉及条目 |
| --- | --- |
| 错误/失败必须可操作（附可粘贴命令） | 用1 #4，用2 #1 #4 #6 |
| 报告作为 review 单一可信源 | 用1 #7 #8 #9 |
| 多 child review / 合流导航 | 用2 #3 #5 #6，用1 #10 |
| run 进度可见 + detach 语义 | 用1 #6，用2 #2 |
| daemon/沙箱摩擦 + 生命周期清理 | 用1 #5，用2 #1 #7 |

---

## 设计原则（避免冗余）

- **不做无 daemon 的 local mode**：用 `--auto-start` 覆盖沙箱摩擦的主要诉求，避免再造一套进程内执行路径。
- **不为文档任务造独立校验引擎**：`--verify` 复用现有 test 执行管线，只做分类 + 内建轻量 git 检查。
- **报告固化 review 动作**：把用户当前要手动双跑的 `git diff --name-status / --stat / --check` 写进 report，不再要求二次核验。
- **失败即给出路**：所有错误/失败/partial 一律附「可直接粘贴的下一步命令」。
- **早停按需开启**：路径越界实时中止默认关闭，避免 fs watch 复杂度。

---

## 工作流 1 — 错误与失败可操作性（P0/P2）

**1.1 统一 client 端错误**（用1 #4）
当前仅 `delegate`/`logs` 有 daemon 提示；`runs/status/apply/cancel/discard` 直接 `await fetch` 无兜底。
- `http.ts` 抽 `classifyFetchError(err, url) → { message, hint }`：
  - `ECONNREFUSED` → `daemon not running` + 提示 `portico start`（或 `--auto-start`）。
  - `EPERM/EACCES` → `sandbox/permission blocked accessing <url>`，区别于「未启动」。
- 所有走 daemon 的命令统一经 `requestJson` helper（try/catch + 统一退出码），消除散落的裸 `fetch`。

**1.2 路径策略失败 → 可重试命令**（用2 #4）
`enforcePathPolicy` 抛错时（`path_not_allowed`），在 `run_error` 与 report 中附：
```
retry: portico delegate --to <agent> --task-file <...> \
  --allowed <现有 allowed...> --allowed <检测到的越界路径...>
```
- 越界路径来自已计算的 `changedFiles`，零额外成本。
- 命中 `test/`、`**/fixtures/**` 等常见路径时，额外提示「测试类任务常需放开 fixture 路径」。

**1.3 `delegate --auto-start`**（用1 #5）
fetch 失败且 url 为 loopback 时：spawn `portico start` 后台 → 轮询 `/health` → 重试一次原请求。不做 local mode。

**1.4 生命周期清理**（用2 #7）
- `portico runs --status <s> --since <dur>`：按状态/时间过滤（`listRuns` 增加 server 端 query 参数）。
- `portico cleanup --failed --older-than <dur>`：**默认只删 worktree、保留 artifacts**（report/diff/events 供事后追溯），
  `--purge` 才连 artifacts 一起删；跳过 `ready`/`applied`。

---

## 工作流 2 — Run 进度与 detach 语义（P0/P2）

**2.1 客户端断开提示**（用1 #6）
注意：`handleDelegate` 不在 `req.close` 时 abort（与 `handleChat` 不同），断开后 daemon 端 run 继续。
- `delegate` 先从 `run_start` 事件拿到 `runId`；装 `SIGINT` handler，打印：
  `run <id> may still be running — track: portico status <id> | portico logs <id> --follow`。

**2.2 `--detach` / `--follow`**（用1 #6）
- `--detach`：收到 `run_start` 即退出并打印 id（不阻塞前台）。
- `--follow <run_id>`：复用现有 `logs --follow`。

**2.3 status 增加进度细节**（用2 #2）
`status` 输出补充：当前阶段（`run.status`）、最后事件类型 + 时间（读 events 末行）、agent 是否在跑（activeController 命中 / 未 completed）、artifact 路径。`runs` 列表标注 `running/active`。

---

## 工作流 3 — 报告作为单一可信源 + verify（P1）

**3.1 Worktree Changes 升级**（用1 #7）
`generateDiff` 当前只取 `--name-only`。扩展为：
- `git diff --name-status HEAD`：按 **modified / added(新文件) / deleted / renamed** 分组展示。
- `git diff --stat HEAD`：diffstat 写入 report。
- `git diff --check`：trailing whitespace / 冲突标记结果，进 report。

**3.2 路径策略结果显式化**（用1 #9）
result + report 增加 `Allowed Policy: passed | failed`，越界文件单列；新增文件同样纳入 allowed 检查。

**3.3 `--verify <cmd>` 与 `--test` 并列**（用1 #8）
- 复用 test 执行管线，但 report 分三段：**Code Tests** / **Verify Checks** / **Policy Checks**。
- Policy Checks 段内建：allowed policy 结果、`diff --check`（trailing whitespace）、untracked 是否被追踪。
- 消除文档型任务「No tests configured」却仍需手查的割裂感。

---

## 工作流 4 — 多 child review 与合流（P1/P2）

**4.1 `portico review <group_id>`**（用2 #5）
纯读，聚合各 child 的 `readRunDetails`，每 child 一行：`label / status / changed# / test / report / diff`。
- 跨 child 改同一文件 → **overlap 高亮**（用2 #3 提前暴露）。
- flags：`--ready-only`、`--json`、`--open-diff`。

**4.2 `partial` group 的具体 next actions**（用2 #6）
report + status 把泛化提示替换为：
- ready child ids → `portico apply <group> --child <id>`；
- failed child ids + reason → `portico delegate --resume <id> --task "..."`。

**4.3 `portico integrate <group_id>`**（用2 #3）— **范围：仅 implement 的 ready 集合**
把 implement/split group 的 ready children 合入 integration worktree（复用 split 模式已有的 `mergeChildDiffs`
三方合并），冲突时输出 conflict files + 来源 child + 建议 review 顺序。
- **不覆盖 compare group**：compare 是同一 task 的多版本实现，文件大量重叠、合并几乎必然冲突，收益低噪声高。
  compare group 仍走 4.1 review + 单 child apply / judge 推荐。

**4.4 apply gate — 两者都做，分期推进**（用1 #10）
- `--review-summary`（先做，P1）：ready 后输出一键 apply 命令 + 风险摘要，仍需人工粘贴执行。复用 4.1，最安全，不改默认 gate。
- `--apply-on-ready`（后做，P3，显式 opt-in）：仅当全部 guard 满足才自动 apply，否则退回正常 ready 等待：
  1. 显式传了 `--allowed`（必须有路径边界）；2. apply 前 tracked tree clean（复用 `assertTrackedTreeClean`）；
  3. tests **且** verify checks 全 pass；4. allowed policy passed、无 out-of-tree/sandbox escape。
  任一不满足 → 不自动 apply，打印未满足项 + `--review-summary` 输出。

---

## 工作流 5 — Daemon 启动预检（P3，可选）

**5.1 启动预检**（用2 #1）
`start` 时检查 `.portico/worktrees`、`.git/worktrees`、pidfile 可写性：
- pidfile 不可写但可监听 → 启动并打印 `usable, stop/discovery limited`。
- 写权限缺失 → 明确 sandbox/permission 修复建议，避免「以为启动成功，首次 delegate 才失败」。

---

## 优先级与分期

| 期 | 项 | 理由 |
| --- | --- | --- |
| **P0** | 1.1, 1.2, 2.1, 3.1 | 低成本、直击「错误不可操作 / 误判终止 / 双重核验」，立刻提升信任 |
| **P1** | 3.2, 3.3, 4.1, 4.2, 4.4(`--review-summary`) | 并行 review 体验与报告可信度 |
| **P2** | 1.3, 1.4, 2.2, 2.3, 4.3 | 自动化摩擦与合流 |
| **P3** | 4.4(`--apply-on-ready`), 5.1 | 增强/可选 |

## 明确不做

- 无 daemon 的 local mode（`--auto-start` 已覆盖）。
- 文档任务的独立校验引擎（`--verify` 复用 test 管线）。
- **路径越界实时早停**（`git status` 轮询 / fs watch）：本期不做，仅保留失败后的 retry 命令（1.2）。
- **integrate 不覆盖 compare group**：文件高度重叠、合并必冲突，走 4.1 review + 单 child apply。

---

## 已定决策（来自反馈收敛）

1. **apply gate**：两者都做 —— `--review-summary` 先行（P1），`--apply-on-ready` 作为显式 opt-in 后做（P3）。
2. **integrate 范围**：仅 implement 的 ready 集合；compare group 不做合并。
3. **路径越界**：仅失败后给可粘贴 retry 命令（1.2）；不做实时轮询早停。
4. **cleanup 默认**：只删 worktree、保留 artifacts；`--purge` 才删 artifacts。
5. **auto-start 范围**：仅对 loopback（`127.0.0.1`/`localhost`）生效；LAN/远程 daemon 一律不自动拉起，保持显式。
