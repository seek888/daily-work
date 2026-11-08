# 05 · AI 代劳层：代码审查流水线 / 提示词与技能管理 / 通用 Action 抽象

> 范围：面向软件开发者的日常工作中台（DeepSeek Harness 整页大面板插件）的「AI 代劳」层设计。
> 本文件只做研究与设计，不含插件实现、不安装、不改 profile。
> 取证方式：`cordis_inspect_list` + `cordis_inspect_query`（Host `Service` / `Tool`）、`skill` 工具加载 `cordis-plugin-development`。
> 结论中的每条外部契约都标注了来源服务与方法签名，便于最终方案直接落地时复核。

---

## 速览（Lead 取用，11 行）

1. **边界**：本层只做编排，不重建 skill / forge 轮询 / session 日志 / 审批 / 卡片；五部件 = `ReviewPipeline`、`PromptTemplateStore`、`SkillBridge`、`ActionRegistry`、`ReviewCard(kind)`。
2. **一次审查 = 一次 Session**（`agents.create` + 一次 turn）：可回看、可追问、可审计；分段用 `subagents.startActivation` + `outputSchema` 拿已校验的 `structured`（D1/D2）。
3. **取数全只读**：`forge.watch/latest` + `forgePanel.changeRequestDiff/changeRequestText`；三个硬缺口——无评论写接口、无 Issue、无 commit-range diff（§1.3 G1–G3）→ 需插件自有 GitLab 客户端。
4. **裁剪**：输入预算取上下文 80%，优先级 核心逻辑 > 配置 > 测试 > 生成代码，大 diff 四档（整文件/hunk/骨架/仅摘要），按目录分段 ≤6 段，**绝不静默丢弃**（未覆盖清单必须露出）。
5. **提示**：9 段固定结构 + 9 类检查清单 + 严格 JSON 输出 + 输出前自检，中文模板全文见 §2.4.2（可直接落地）。
6. **schema**：`ReviewResult v1` 严格收在 `ObjectJsonSchema` 窄子集内（无 `$ref/pattern/minimum`）；范围、路径、证据逐字、verdict 一致性由**代码后校验**兜底（§2.6.3）。
7. **后处理是确定性的、0 token**：去重键、`fixed` vs `stale` 区分、误报抑制（带原因 + 过期）、`confidence × coverage` 惩罚。
8. **安全**：默认只读（`tools.restrict` + `guard`）；评论默认只出**草稿**；写操作走 `approval` + `actionCards.verb(writes:true)` + 二次确认；**AI 永不自动 approve/merge**（D6）。
9. **成本**：给出估算公式与样例（500 行 / 2 段 ≈ 18.8k in、1.8k out、~32s、~$0.007）；三层缓存（diff 复用 `forgePanel` 内置）；增量走 compare；5 级降级阶梯（模型不可用 → 只给静态检查）。
10. **质量**：recall / fpRate / acceptRate / coverage / cost 五指标 + ≥60 条冻结离线评测集 + 卡片反馈闭环（不自动注入 few-shot、不训练权重）。
11. **落地**：P0 十项见 §10.1；待确认 T1–T6（`plugin:*` 事件、只读 sandbox、`outputSchema` 能力、`SKILL.md` 字段、面板 Slot、forge 写接口）。

---

## 0. 结论摘要

**一句话**：AI 代劳层不是「一套新的 Agent」，而是**在 DSH 既有能力之上编排出的 5 个可复用部件**：
① `ReviewPipeline`（一次审查 = 一次 Session，产出结构化 findings）；
② `PromptTemplateStore`（提示词模板，带版本/变量/统计）；
③ `SkillBridge`（模板 ↔ DSH skill 双向互操作，不另造技能体系）；
④ `ActionRegistry`（`ActionDefinition` 通用抽象，覆盖审查之外的 7 类高频动作）；
⑤ `ActionCard` kind（结果落地 + 人工确认 + 采纳/忽略反馈闭环）。

**12 条关键决策（均标注了契约依据）**

| # | 决策 | 依据 / 理由 |
|---|---|---|
| D1 | 一次审查 = **一次 Session**，而不是一次裸模型调用 | 可回看、可追问、可审计；`agents.create({sessionId, meta, agentOptions, setup})` / `agents.resume` |
| D2 | 结构化输出优先用 **subagent `outputSchema`**，不回退到「解析模型自由文本」 | `SubagentStartRequest.outputSchema?: ObjectJsonSchema` + `SubagentResult.structured`；能力由 `SubagentCapabilities.outputSchema` 声明 |
| D3 | 大 diff **分段（segment）并行**审查，再确定性聚合 | 分段是纯工程问题；聚合尽量不花 token（见 §2.7） |
| D4 | 审查的「取数」复用 `ctx.forge` / `ctx.forgePanel`，不自己写轮询 | `forge.watch(ref, listener)` 已实现「一个 change request 共享单轮询循环、每个 forge 最多一个 in-flight 批次」 |
| D5 | **不新增** Issue 轮询服务；Issue 走插件自带的 GitLab REST 客户端 | `forge`/`forgeSession` 只覆盖 change request（MR/PR），无 Issue 读接口（§1.3 缺口 G2） |
| D6 | **禁止任何自动 approve / 自动 merge**；AI 只产出「建议 + 评论草稿」 | `forge.merge(ref,{method,headSha})` 存在，但误批准的代价不可逆；请见 §5.5 |
| D7 | 评论/审查意见的写接口由插件自有 GitLab 客户端承担，且**默认只生成草稿** | `forge` 无 comment / review 写方法（§1.3 缺口 G1） |
| D8 | 提示词模板**不注册为 systemPrompt 变量**，只在发消息前本地渲染 | `systemPrompt.variable` 是系统提示词装配作用域，注册 `{{mr.title}}` 会污染每个模型步（§1.4） |
| D9 | 模板 ↔ skill：**模板可导出为 skill 文件**，模板也可**引用现有 skill 作为审查方法** | `skills.register` / `skills.get(name,{cwd,scope})`；`SkillSummary.whenToUse` |
| D10 | 结果落地用 **`actionCards` kind + verbs**，`writes: true` 的 verb 强制人工确认 | `ActionCardKind.verbs: Record<string, {writes?: true}>`、`ActionCardResult.status: 'unconfirmed'` |
| D11 | 审查会话在**只读工具集**下运行（`tools.restrict` / `tools.guard`），写操作分离到「采纳」verb | `tools.restrict({deny})`、`tools.guard(exec => reason)` |
| D12 | 成本核算读 **`assistant/message.usage`（`TokenUsage`）**，预算预估用 `tokenMeter.estimateMessage` | `SessionEventMap['assistant/message'].usage`、`tokenMeter` |

---

## 1. 契约事实（本轮取证）

### 1.1 直接依赖的 Host 服务与关键签名

| 用途 | 服务 | 精确签名（节选，逐字来自 inspection） |
|---|---|---|
| 技能注册（把模板变成运行时技能） | `skills` | `register(skill: SkillRegistration): () => void`；`registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void`；`async list(options?: SkillViewOptions): Promise<SkillSummary[]>`；`async get(name: string, options?: SkillViewOptions): Promise<SkillDefinition \| undefined>`；`async snapshot(...)` |
| 某 Session 可见技能 | `sessionSkillCatalog` | `@Remote async list(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue>`（`SkillListRequest = {sessionId}`，`SkillEntry = {path?, name, description, whenToUse?, modelInvocable}`） |
| 系统提示词装配 | `systemPrompt` | `section(section: PromptSection): () => void`；`context(context: PromptContext): () => void`；`tools(provider: (context: AssembleContext) => ToolProviderResult): () => void`；`variable(name: string, provider): () => void`；`async assemble(context?: AssembleContext): Promise<PromptAssembly>` |
| 斜杠命令（手动触发入口之一） | `commands` | `register(definition: CommandDefinition): () => void`；`@Remote list(agent: Agent): readonly CommandDescriptor[]`；`@Remote async execute(agent, line, submittedAttachments, signal): Promise<CommandExecution \| undefined>` |
| 会话/Agent 生命周期 | `agents` | `async create(options: CreateAgentOptions): Promise<AgentHandle>`；`async resume(options: ResumeAgentOptions)`；`withInitiator<T>(agent, operation)`；`list()/roots()/get(id)` |
| 子 Agent（分段并行 / 结构化输出） | `subagents` | `startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>`；`registerProvider(provider: SubagentProvider)`；`listChildren/listDescendants`；`interrupt(...)`；`@Remote async prompt(request, signal)` |
| 模型注册与直连 | `llm` | `@Remote listProviders(): LlmProviderInfo[]`；`async listModels(provider): Promise<LlmModelInfo[]>`；`async resolveModelInfo(provider, model, signal?)`；`async resolveCallConfig(config, signal?)`；`stream(options: GenerateOptions): AsyncIterable<StreamChunk>` |
| 工具注册（模型可调用的审查入口） | `tools` | `register(definition: ToolDefinition, options?: ToolRegistrationOptions): () => void`；`restrict(filter: ToolRestriction): () => void`；`guard(guard: ToolGuard): () => void`；`checkGuards(exec)`；`schemas(scope?, toolSet?)` |
| change request 轮询与读取 | `forge` | `watch(ref: ChangeRequestRef, listener: ChangeRequestListener): () => void`；`latest(ref)`；`refresh(ref): void`；`async diff(ref, signal): Promise<string \| ForgeFailure>`；`async fileText(ref, commit, path, signal)`；`async readiness(repository, signal)`；`async markReady(ref, signal)`；`async merge(ref, request: MergeRequest, signal)`；`async findByHead(repository, branch, signal)`；`changeRequestFromUrl(url)` / `changeRequestUrl(ref)` |
| MR 视图数据（面板） | `forgePanel` | `@Remote({mode:'stream'}) async *follow(session, signal): AsyncIterable<ForgePanelState>`；`@Remote changeRequestDiff(session, url, signal): Promise<ForgeChangeRequestDiff>`；`@Remote changeRequestText(session, url, commit, path, signal)`；`@Remote localDiff/localText`；`@Remote async merge(session, url, method, headSha, signal)`；`@Remote markReady`；worktree 系列 |
| MR 绑定 | `forgeSession` | `changeRequests(session): SessionChangeRequest[]`；`track(session, url): void`；`discoverBranch(session, remote, branch)`；`watch(session, listener): () => void`；`dismiss(session, url)` |
| 结果卡与人工动作 | `actionCards` | `register<Details>(kind: ActionCardKind<Details>): () => void`；`record(agent, decision: ActionCardDecision): void`；`view(session): ActionCardView`；`@Remote act(agent, callId, verb, payload?): Promise<ActionCardResult>` |
| 审批闸门 | `approval` | `setPolicy(agent, policy: ApprovalPolicy): void`；`async request(req: ApprovalRequest): Promise<ApprovalOutcome>`；`overrideOf(session)` |
| 凭据（PAT / 模型 key） | `credentials` | `abstract resolve(ref: CredentialRef): Promise<ResolvedCredential \| undefined>`；`set/unset/describe/listRecords` |
| 定时触发 | `schedule` | `async create(sessionId: SessionId, request: ScheduleCreateRequest, signal?)`；`@Remote list/catalog/history/delete/update` |
| 计时器（轮询节流） | `timer` | `interval(callback, delay)`；`timeout`；`debounce/throttle` |
| token 估算 | `tokenMeter` | `measure(session, requestHeader?): TokenMeasurement`；`estimateMessage(message): number`；`contextPressure(session)` |
| 会话查询/持久化 | `sessionController` / `sessions` / `sessionQuery` / `sessionPersistence` / `sessionProjections` | `@Remote create(request: SessionCreateRequest)`；`@Remote list/search`；`@Remote selectModel`；`@Remote modelCatalog()`（`sessionController`） |
| 工作区/写入隔离 | `worktrees` / `workingDirectory` / `sandbox` | `async create(agent, request?, signal?, onPhase?): Promise<CreatedWorktree>`；`async set(agent, path, signal?)` |

### 1.2 必须尊重的结构约束（比"能调什么"更重要）

1. **`ObjectJsonSchema` 是窄子集**：`JsonSchemaNode` 只有
   `type / oneOf / properties / required / additionalProperties / items / enum / const / description / title / default / examples`。
   → **不能用 `$ref`、`format`、`minimum`、`pattern`、`maxLength`、`additionalProperties: false` 之外的复杂约束**（`additionalProperties` 布尔可用）。
   本方案的输出 schema 严格限制在该子集内，**超出部分放到模型后校验**（§2.6.3）。
2. **`SessionEventMap` 是封闭枚举**：`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`developer/message`、`system/message`、`assistant/message`、`assistant/attempt`、`tool/call`、`tool/result`、`request/header`、`request/context`、`session/end-seed`（截断）……
   → 审查流水线的阶段事件**不能**自定义 session 事件类型；应通过 ① 工具的 `presentCall/presentResult` + `meta`、② `tool/result.meta`（`JsonValue`）、③ `actionCards.record`、④ 插件自有存储来落盘。
3. **`forgeSession` 已有 `plugin:` 记录先例**：其说明提到绑定来自 `plugin:forge-session/binding` 记录。说明存在插件命名空间事件的落地路径，但**本层不依赖它**（契约未在 inspection 中完整暴露，属"待确认"项 T1）。
4. **`skills` 的分层与优先级**：`register` 注册到**调用上下文的 layer**（scoped 上下文 → preset layer；非 scoped → 全局）；同层同名 runtime 条目 **first-wins** 且重复只告警；层内优先级 **project > runtime > user**；跨层「最近层同名条目直接胜出」。→ 模板导出成 skill 时**命名前缀**必须能避让（§3.5）。
5. **`actionCards` 的 verb 语义**：`ActionCardVerb = { global?: true; writes?: true }`；`act()` 的 `dismiss` 由框架记录，其他 verb 交给 kind；返回 `'unconfirmed'` 表示需要确认但未确认。→ 这正是"评论前人工确认"的现成闸门。
6. **`forgePanel.changeRequestDiff` 已带 headSha 缓存**：同一 head commit + base branch 的 patch 跨 Session 内存复用，`maxCachedDiffBytes` 淘汰。→ 我们**不要**再实现一层 diff 缓存，只做「审查结果」缓存。
7. **`forge.merge`/`forgePanel.merge` 都要求 `headSha`**（`forgePanel/merge` 会报 `forgePanel/stale-head`）。→ 任何合并动作必须绑定用户看到的那次 head。

### 1.3 能力缺口（决定本层"必须自己做什么"）

| 缺口 | 事实 | 影响与本方案对策 |
|---|---|---|
| **G1 无 MR 评论/审查写接口** | `ForgeProvider` 方法集只有 `fetch/findByHead/readiness/markReady/merge/diff/fileText/fileUrl`；`forgePanel` 只多 `localDiff/localText` 与 worktree。**没有** `comment`、`createReview`、`approve`、`requestChanges` | 评论草稿 → 发布、Approve / Request changes 必须由**插件自有 GitLab REST 客户端**（`POST .../merge_requests/:iid/discussions`、`.../notes`、`.../approve`）完成；凭据取 `credentials`，动作走 `approval` + `actionCards.verb(writes:true)`。P0 只做「评论草稿 + 一键复制/发布」，**不提供 AI 自动 approve** |
| **G2 Issue 不在 forge 覆盖范围** | `forge` 只有 `ChangeRequestRef`（`repository + number`）；无 Issue 类型、无 Issue 列表/评论接口 | P0 的 Issue 轮询由插件自有 GitLab 客户端实现（`GET /issues?scope=assigned_to_me&state=opened`、`GET /projects/:id/issues`），复用 `credentials` + `timer` + 插件存储；**不要**冒充 forge 轮询 |
| **G3 无"提交范围"diff** | `forge.diff(ref)` 只返回整 MR patch；`forgePanel.localDiff` 只覆盖本地工作区 | 增量审查需要 commit-range diff：走自有 GitLab `GET /projects/:id/repository/compare?from=&to=`，或在只读 sandbox 里 `subprocess` 跑 `git diff A..B`（`forgePanel.localText` 可补全文）。见 §2.2 / §6.4 |
| **G4 无 CI 日志接口** | `ChangeRequestSnapshot.checks` 只有 `name/state/url/workflow/startedAt/completedAt`，无日志正文 | 降级策略里"静态检查"用本地 lint/typecheck/test（`subprocess`）而非拉 CI 日志；CI 只作为**信号**（`checksRollup`）进入提示 |
| **G5 无历史评论接口** | `forge` 无 notes/discussions 读取 | 「历史评论/上一轮 AI 结论」由插件自己持久化（§2.9），首次接入无法读取既有讨论 —— 记为 P1（自有 API 补充） |
| **G6 无"项目约定"接口** | 无 conventions 服务 | 约定来自工作区文件（`CONTRIBUTING.md`、`.editorconfig`、`.cursor/rules`、`AGENTS.md`、模板自带 `conventions` 字段），由 `workspaceFiles`/`fs` 读取 |

### 1.4 与 DSH 既有机制的分工（**本设计不得重复/冲突**）

| DSH 已有 | 我们**不**做什么 | 我们**做什么** |
|---|---|---|
| skill 机制（`skills` + `sessionSkillCatalog` + `skill` 工具） | 不新建"技能库"、不自己解析 skill 目录、不复制 `SKILL.md` 语义 | 只做**模板 ↔ skill 的转换与引用**（§3.5），模板存自己的结构，skill 是它的一个导出视图 |
| `forge` / `forgeSession` / `forgePanel` 轮询 | 不自己轮询 MR、不自己维护 MR 状态、不自己缓存 diff | 订阅 `forge.watch` / `forgeSession.watch`，读 `forgePanel.changeRequestDiff` |
| `systemPrompt` 装配 | 不把业务变量注册成全局 prompt variable；不在全局加审查用 section | 仅在**审查专用 preset 作用域**内注册 section/context（`agentPresets` scoped layer） |
| Session 日志/回放 | 不自造会话存储、不自造事件类型 | 审查跑在 Session 里，用既有日志 + 工具 `meta` 审计 |
| `approval` 服务 | 不自造审批 UI/策略 | `approval.request` + `actionCards` verb 组合出"评论前确认" |
| `actionCards` | 不自造卡片渲染/决策记录 | 注册 1 个 review kind + 若干 action kind |
| `commands` | 不再造命令注册表 | 注册 `/review`、`/summarize` 等斜杠命令 |
| `tokenMeter` | 不自造 tokenizer | 预算预估用 `estimateMessage`，实际用量读 `usage` |

---

## 2. 审查流水线（S0 → S8）

```
                     ┌──────────── 触发层 ────────────┐
 手动(面板/命令) ─┐   │ 规则(head 变更·ready·标签)      │  定时(schedule/timer)
                  ├──▶│ 事件(P1: webhook)              │──┐
                  │   └────────────────────────────────┘  │
                  ▼                                       ▼
 S0 触发 → S1 取数 → S2 裁剪分段 → S3 提示 → S4 模型 → S5 结构化输出
                                                              │
                                              S6 后处理 ◀─────┘
                                                │
                              S7 落地(面板/评论草稿/建议) → S8 审计(会话日志)
```

### 2.1 S0 触发（Trigger）

| 触发方式 | 落地机制 | 说明 |
|---|---|---|
| 手动·面板按钮「一键 AI 审查」 | 面板 Remote → `reviewController.startRun(input)` | 主入口；返回 `runId`，进度靠 `@Remote({mode:'stream'})` 流 |
| 手动·斜杠命令 | `commands.register({name:'review', input:{hint:'MR URL 或编号'}, handler})` | 命令生命周期自带 `command/run` / `command/done` 日志（契约已声明），天然可审计 |
| 手动·聊天里让 Agent 审查 | `tools.register` 的 `review_change_request` 工具（`when` 条件：当前 Session 绑定了 MR） | 模型可自取；`output.schema` 保证结构化 |
| 规则·head 变更 | `forgeSession.watch(session, listener)` 收 `ChangeRequestUpdate`；比较 `snapshot.headSha` 与已审记录 | `watch` 是 effect，随 fiber 释放；同一 MR 多 watcher 共享轮询 |
| 规则·转正式（draft→ready） | `snapshot.draft === false` 的**边沿变化** | 避免每轮都跑：只在 `draft` 由 true→false 触发一次 |
| 规则·标签/路径匹配 | 面板维护的 per-repo 规则：`labels 含 ai-review`、`baseBranch 匹配 release/*`、`changedPaths 命中高敏目录` | 规则命中后仍需过 §5 的"预算/并发"闸门 |
| 定时·兜底扫描 | `schedule.create(sessionId, {every/daily/cron...})` 向"看板会话"投递固定提示词；或插件内 `timer.interval` + 自有队列 | 建议用 `schedule`（自带 `history` 与"停机后只补最近一次"语义），避免自造 cron；**不要**高频（≥5min） |
| 事件（P1） | `webServer.register(route)` + `webhookRuntime.register/dispatch` 做 GitLab webhook | P1：需要公网可达/隧道，P0 不做 |

**幂等与去重**：触发键 `triggerKey = sha256(repo + mrIid + headSha + templateId + templateVersion + model + schemaVersion)`。
命中已有 running/成功记录 → 直接复用（§6.3）。**同一 headSha 不存在两次并发审查。**

### 2.2 S1 取数（Collect）

一次 `ReviewInput` 由 6 类数据组成，全部标注**来源**与**降级值**：

| 数据 | 来源（契约） | 失败/缺失时 |
|---|---|---|
| MR 元数据 | `forge.latest(ref).snapshot`（`ChangeRequestSnapshot`：`title/state/draft/author/headBranch/headSha/baseBranch/additions/deletions/mergeability/mergeReady/mergeMethods/reviewDecision/checks/checksRollup/unresolvedThreads/updatedAt`） | `ForgeFailure{code:'unauthenticated'}` → 终止并提示重新授权；`unavailable` → 重试 §6.5 |
| diff（结构化） | `forgePanel.changeRequestDiff(session, url, signal)` → `ForgeDiffFile[]{path, previousPath, status, binary, oversized, untracked, additions, deletions, hunks[]}`；hunk = `{oldStart, oldLines, newStart, newLines, lines[]}` | `forgePanel/diff-too-large` → 切"骨架模式"（§2.3.3）；`forgePanel/diff-failed` → 用 `forge.diff(ref)` 的原始 patch 自己解析 |
| 变更文件全文（补上下文） | `forgePanel.changeRequestText(session, url, commit=headSha, path, signal)` | 单文件失败 → 该文件只按 hunk 审，`confidence` 上限 0.7 |
| 项目约定 | 工作区文件：`AGENTS.md` / `CONTRIBUTING.md` / `.editorconfig` / 模板 `conventions` 字段 / 目录 `ARCHITECTURE.md` | 缺失 → 用模板默认约定（模板自带） |
| CI 信号 | `snapshot.checks` / `checksRollup`（**只有状态，无日志** — G4） | `none` → 提示词说明"无 CI 信息，不臆测测试结果" |
| 历史评论 / 上一轮结果 | 插件自有存储（同一 MR 的上次 `ReviewRun`，含 findings 与 headSha） — G5 | 首轮为空 → 提示词走"首轮模式"（不写"对比上一轮"） |
| 增量范围（可选） | 自有 GitLab `compare`（from=lastReviewedSha, to=headSha）或只读 sandbox `git diff`（G3） | 不可用 → 回退全量重审 |

> **读取权限最小化**：S1 全程只读。`forgePanel.changeRequestDiff` 本身要求 Session 持有该 URL 的可见绑定（`forgePanel/not-bound`），这天然限定了"只能读我跟踪的 MR"。

### 2.3 S2 上下文裁剪与分段（Context packing）

#### 2.3.1 预算模型

```
budget_ctx      = contextWindow(model) - reserve_output(maxTokens) - reserve_system(prompt_section+skills)
budget_input    = floor(budget_ctx * 0.80)          // 20% 安全余量（估算误差/模板膨胀）
per_segment_cap = min(budget_input, cfg.segmentMaxInputTokens)   // 默认 24k
```

#### 2.3.2 文件优先级（核心逻辑 > 配置 > 测试 > 生成代码）

按 `path` 分类打分（**可配置、按仓库覆盖**），排序后按分数装箱：

| 优先级 | 匹配规则（默认） | 权重 | 理由 |
|---|---|---|---|
| P0 核心逻辑 | `src/**` `app/**` `lib/**` `pkg/**` `internal/**` `cmd/**`，语言扩展 `.ts/.tsx/.js/.go/.py/.rs/.java/.kt/.cs/.rb/.php` | 100 | bug/安全/并发风险集中地 |
| P1 公共/接口层 | `**/api/**` `**/proto/**` `**/schema/**` `**/migrations/**`（**升级为 P0**，见注） | 95 | 契约变更影响面大 |
| P2 配置 | `*.yml/*.yaml/*.toml/*.json`（非 lock）、`Dockerfile`、`*.env*`、CI 配置 | 60 | 误配是高频事故源 |
| P3 测试 | `**/test/**` `**/tests/**` `*_test.go` `*.spec.ts` `*.test.ts` | 40 | 需要"测试覆盖"检查但不优先占预算 |
| P4 生成/产物 | `dist/**` `build/**` `vendor/**` `node_modules/**` `*.min.js` `*.lock` `*.pb.go` `*_generated.*`、`binary` | 5（默认**丢弃**） | 噪声；仅保留其**存在性与体积**作为信号 |

> 注：数据库迁移/协议 schema 默认按 P1 处理并**实际按 P0 预算**，因为回滚代价最高。生成代码默认不进提示词，但在 summary 里列出"被跳过的生成文件"。

#### 2.3.3 大 diff 的 4 档策略（按单文件/整体规模升级）

1. **整文件审（`size ≤ 8k tokens`）**：hunk + 前/后各 3 行上下文，必要时用 `changeRequestText` 补足 hunk 之间的空档，使模型看到完整函数。
2. **仅 hunk 审（`8k < size ≤ per_segment_cap`）**：只发 `hunks`，每 hunk 保留 `oldStart/newStart/lines`，**去掉未变更的行**（`lines` 里以 `' '` 开头的行按策略保留前后各 2 行）。
3. **骨架 + hunk（`size > per_segment_cap`）**：用 `changeRequestText` 抽取"声明骨架"（函数/类签名行、`export`/`func`/`class`/`def` 行、类型定义），发骨架 + 全部 hunk，并显式声明 `"fileMode": "skeleton"`，要求模型**不得**对未见实现下结论（`confidence ≤ 0.6`）。
4. **只报摘要（`oversized || binary`）**：`ForgeDiffFile.oversized/binary` → 不发内容，只记一条 `skippedFiles` 条目（`reason: 'oversized' | 'binary'`），并在结论里说明"未覆盖"。

#### 2.3.4 分段（segment）

- **切分单位**：文件；**分组键**：`dirname` 的 top-2 级（如 `src/server/auth`），使同模块文件同段（跨文件 bug 常在同目录）。
- **约束**：单段 ≤ `per_segment_cap`；单段文件数 ≤ `cfg.maxFilesPerSegment`（默认 12）；单段 hunk 数 ≤ 80。
- **超限处理**：单文件超 `per_segment_cap` → 该文件独占一段并升级到策略 3；仍超 → 按 hunk 二分（保 `newStart` 顺序），每片声明 `"hunkRange": [i, j]`。
- **段间共享**：MR 元数据 + 项目约定 + 检查清单**每段都发**（体积小、强约束）；`diff` 只发本段。
- **段数上限**：`cfg.maxSegments`（默认 6）。超了按优先级截断并在 summary 里明示"未审查文件清单"（**绝不静默丢弃**）。

#### 2.3.5 提示词体积的硬约束

模板全文（§2.4.2）约 **1.6k tokens**；`skills` 引用内容按需注入（≤ 1.2k tokens 每 skill，超了只注入 `whenToUse`）。因此**每段固定开销 ≈ 3k tokens**，是 §6.1 估算公式的常数项。

### 2.4 S3 提示（Prompt）

#### 2.4.1 模板结构（固定 9 段，顺序不可变）

```
[0] 角色与目标        role
[1] 输入事实          mr / files / diff / ci
[2] 项目约定          conventions
[3] 检查清单          9 类（按 severity 定义顺序）
[4] 审查方法（可选 skill）  skillRefs 注入内容
[5] 边界与禁忌        只审改动及直接影响 / 不臆测 / 不编造行号 / 不确定降置信
[6] 输出格式（强约束）  JSON only + schema 摘要 + 字段语义
[7] 分段信息          segment.index/total、fileMode、hunkRange
[8] 输出自检清单      输出前逐条自查
```

#### 2.4.2 中文提示词模板全文（可直接落地）

```text
# 角色
你是一名资深代码审查者，正在审查一个 Merge Request 的一个分段（segment）。
你的产出会被机器解析并展示给人类审查者，因此必须严格遵守本模板的全部格式要求。

# 输入事实
- 项目：{{project.path}}
- MR：!{{mr.iid}} {{mr.title}}
- 作者：{{mr.author}}｜源分支：{{mr.head_branch}} → 目标分支：{{mr.base_branch}}
- 变更规模：+{{mr.additions}} / -{{mr.deletions}}，文件 {{files.count}} 个
- 本分段：第 {{segment.index}}/{{segment.total}} 段，覆盖 {{segment.file_count}} 个文件
- CI 状态：{{ci.rollup}}（{{ci.summary}}）   ← 若为 none，写「无 CI 信息」，不要臆测测试是否通过
- 增量模式：{{mode}}（full=全量；incremental=仅新提交，范围为 {{incremental.range}}）
- 历史轮次：{{history.summary}}   ← 首轮写「无上一轮」

# 项目约定
{{project.conventions}}

# 变更文件
{{files.list}}
（每个文件给出：路径 / 状态（added|modified|deleted|renamed）/ 增删行数 / 模式（full|hunks|skeleton）/ 分片范围）

# 变更内容（unified diff）
{{diff}}

# 检查清单（按此顺序逐项检查，每类最多 3 条发现）
1. 正确性 correctness：逻辑是否符合意图？边界值、空值、off-by-one、类型收窄、返回值契约。
2. 边界与输入边界 boundary：空集合、极值、超长输入、时区/编码/精度、分页与截断。
3. 并发与共享状态 concurrency：竞态、锁粒度、死锁、可见性、幂等、重入、异步取消与泄漏。
4. 错误处理 error_handling：错误是否被吞掉/过度捕获？失败路径是否有资源释放？错误是否可诊断（含上下文）？
5. 安全 security：注入（SQL/命令/模板/XSS）、越权与 IDOR、鉴权缺失、密钥/令牌泄漏、SSRF、不安全反序列化、日志中的敏感信息。
6. 性能 performance：N+1、无界循环/递归、缺索引的全表扫描、大对象复制、阻塞主线程、缓存击穿/雪崩。
7. 可读性与可维护性 readability：命名、函数过长、重复代码、隐式耦合、注释与实现不一致、魔法值。
8. 测试覆盖 tests：改动是否配套测试？测试是否覆盖失败路径与边界？是否存在被删除的有效断言？
9. 兼容性 compatibility：API/DB/配置/schema 破坏性变更、语义化版本、迁移可回滚、旧数据兼容、客户端与协议兼容。

# 审查方法（如提供）
{{skills.content}}

# 边界与禁忌（违反即视为无效产出）
- 只审查**本次改动**以及它们**直接影响**的代码。不要对未出现在输入中的文件、未变更的既有实现发表意见。
- 不得编造文件路径、行号、函数名或证据。每条发现必须能引用输入中**逐字存在**的代码片段。
- 不确定时降低 confidence，并在 why 中写明不确定的原因；宁可少报，不可臆测。
- 纯格式/风格偏好（空格、引号、导入顺序）除非项目约定明确禁止，否则不要报。
- 生成的代码（dist、vendor、*.min.js、*_generated.*、lock 文件）不要审。
- 不要输出 JSON 以外的任何字符：没有 Markdown、没有代码围栏、没有前言后语、没有注释。

# 输出格式（严格 JSON）
仅输出一个 JSON 对象，字段如下（未列出的字段一律不要输出）：
{
  "summary": "整体结论，中文，2-5 句；说明本分段最主要的风险与是否建议阻塞合并",
  "verdict": "approve | comment | request_changes",
  "findings": [
    {
      "severity": "blocker | high | medium | low | info",
      "category": "correctness | boundary | concurrency | error_handling | security | performance | readability | tests | compatibility",
      "file": "相对仓库根的路径，必须与输入完全一致",
      "line": 123,                        // 新文件侧行号（new 侧），整数；无法定位时省略该字段
      "title": "一句话说明问题（≤ 60 字）",
      "evidence": "从输入中逐字复制的 1-5 行代码（含 diff 前缀也可），不得改写",
      "why": "为什么这是问题：触发条件 + 后果（含受影响对象/数据）",
      "fix": "具体修复建议（可执行，不含敷衍措辞）",
      "patch": "可选：可直接应用的 unified diff 片段（同一文件的 new 侧上下文），无把握则省略",
      "confidence": 0.0-1.0
    }
  ],
  "confidence": 0.0-1.0
}

字段语义：
- verdict=request_changes 仅当存在至少 1 条 blocker 或 ≥2 条 high；verdict=approve 要求 findings 中没有 medium 及以上；
  其余为 comment。若本分段没有发现，findings 输出 []，verdict=comment，summary 写明「本分段未发现需要修改的问题」。
- 每个 severity 的含义：blocker=会导致数据损坏/安全漏洞/线上故障，必须改；high=明确的功能错误或高风险；
  medium=可能出错或有明显维护成本；low=小问题；info=观察或建议，不阻塞。
- 每条 finding 必须独立；同一根因在多处出现时只报 1 条并在 why 中列出其他位置。
- 若 files 中某文件 mode=skeleton，则该文件相关发现 confidence 不得高于 0.6；
  若某文件被标注 skipped，不得对其产出任何发现。

# 输出前自检（逐条确认后再输出）
1. 输出是**单个**合法 JSON 对象，无围栏、无尾随逗号、无注释。
2. findings 中每条都有 severity/category/file/title/evidence/why/fix/confidence。
3. evidence 均能在输入中逐字找到；file 路径与输入完全一致。
4. 没有对未出现在输入中的文件发表意见。
5. verdict 与 findings 的 severity 分布一致（按上面的规则重算一遍）。
```

**变量与渲染约定**：`{{...}}` 单层、无逻辑、无嵌套；缺失变量渲染为空串并记录一条 `renderWarning`（**不中断**，但会降低 `confidence` 上限）。变量表见 §3.2。

#### 2.4.3 检查清单分类映射（模板 ↔ 存储 ↔ 统计）

| 模板序号 | `category` 枚举 | 默认严重度上限 | 是否可关（per-repo） | 统计口径 |
|---|---|---|---|---|
| 1 | `correctness` | blocker | 否 | 采纳率按 category 聚合 |
| 2 | `boundary` | high | 否 | 同上 |
| 3 | `concurrency` | blocker | 否（可降为 high） | 同上 |
| 4 | `error_handling` | high | 否 | 同上 |
| 5 | `security` | blocker | 否 | 单独看板（高敏） |
| 6 | `performance` | medium | 是 | 同上 |
| 7 | `readability` | low | 是（默认关） | 同上 |
| 8 | `tests` | medium | 是 | 同上 |
| 9 | `compatibility` | high | 否 | 同上 |

§2.7.4 的「严重度上限」按此表与 per-repo 配置取交集。

### 2.5 S4 模型与参数

| 场景 | 模型选择 | `agentOptions` / `LlmCallControls` |
|---|---|---|
| 单段审查（默认） | `cfg.modelReview`（默认主力推理模型） | `temperature: 0.1`，`maxTokens: 2048`，`reasoningEffort: 'medium'`（若模型支持） |
| 安全敏感段（命中 `**/auth/**`、`**/crypto/**`） | `cfg.modelSecurity`（可配更强模型） | `temperature: 0`，`maxTokens: 2048` |
| 汇总/聚合（若用模型） | `cfg.modelAggregate`（可配轻量模型） | `temperature: 0`，`maxTokens: 1024` |
| 变更摘要 / 生成测试等 Action | 各自 `ActionDefinition.model` 覆盖 | 见 §4.3 |

- **模型必须走 `agentOptions.provider + agentOptions.model`**（`AgentOptions{provider?, model?, reasoningEffort?, maxTokens?}`），由 `agents.create`/`subagents.startActivation` 传入；不要在提示词里"命令"模型。
- **参数可被 Action 覆盖**，但温度硬上限 `0.2`（审查类）——高于 0.2 的配置在保存时被拒（§3.1 校验规则）。
- 模型可用性：启动前 `llm.listModels(provider)`（缓存 10min）校验 `cfg.model` 是否仍在；不在则按 §6.5 降级。
- **不使用** `temperature` 去"增加创造力"；重复性由 `schema` + 自检清单保证。

### 2.6 S5 结构化输出 schema

#### 2.6.1 设计要点

1. **只使用 `ObjectJsonSchema` 子集**（§1.2-1）→ 无 `$ref`、无 `pattern`、无 `minimum`。
2. `additionalProperties: false` 可用（布尔），用于禁止臆造字段。
3. 每个 `enum` 必须与模板、UI、统计三处共用同一常量（单一事实来源：`ReviewEnums`）。
4. `confidence` 用 `number`，**范围校验放在后校验**（§2.6.3），因为 schema 无法表达 `minimum/maximum`。
5. `findings` 的 `required` 包含 `file/title/evidence/why/fix/confidence`，`line/patch` 可选。

#### 2.6.2 JSON Schema 示例（`ReviewResult` v1，直供 `outputSchema`）

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["summary", "verdict", "findings", "confidence"],
  "properties": {
    "summary": {
      "type": "string",
      "description": "2-5 句中文整体结论，说明主要风险与是否建议阻塞合并"
    },
    "verdict": {
      "type": "string",
      "enum": ["approve", "comment", "request_changes"],
      "description": "建议结论。approve 仅为建议，永不自动提交到代码托管平台"
    },
    "confidence": {
      "type": "number",
      "description": "本分段整体置信度 0..1"
    },
    "findings": {
      "type": "array",
      "description": "发现列表，按 severity 降序",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "severity", "category", "file", "title", "evidence", "why", "fix", "confidence"
        ],
        "properties": {
          "severity": {
            "type": "string",
            "enum": ["blocker", "high", "medium", "low", "info"]
          },
          "category": {
            "type": "string",
            "enum": [
              "correctness", "boundary", "concurrency", "error_handling",
              "security", "performance", "readability", "tests", "compatibility"
            ]
          },
          "file": { "type": "string", "description": "相对仓库根路径，必须与输入一致" },
          "line": { "type": "integer", "description": "新文件侧行号（new），无法定位时省略" },
          "title": { "type": "string", "description": "一句话问题描述，≤60 字" },
          "evidence": { "type": "string", "description": "逐字复制的代码片段（1-5 行）" },
          "why": { "type": "string", "description": "触发条件 + 后果" },
          "fix": { "type": "string", "description": "可执行的修复建议" },
          "patch": { "type": "string", "description": "可选：可应用的 unified diff 片段" },
          "confidence": { "type": "number", "description": "单条置信度 0..1" }
        }
      }
    }
  }
}
```

#### 2.6.3 后校验（schema 表达不了的部分，必须用代码验）

| 校验 | 规则 | 违规处理 |
|---|---|---|
| 数值范围 | `0 ≤ confidence ≤ 1`；`line ≥ 1` | 越界 → `clamp` 并记 `validationWarning` |
| 文件存在性 | `finding.file` ∈ 输入 `files[].path` 集合 | 不在 → **丢弃**该 finding（记 `hallucinatedPath`） |
| 证据可核验 | `evidence` 的最长行（trim 后）能在该文件的 diff/全文里找到 | 找不到 → `evidenceUnverified=true`，`confidence *= 0.7`，UI 打"待核验"标 |
| 行号合法性 | `line` 落在该文件任一 hunk 的 new 侧范围内 | 越界 → 置 `line=null` 并保留 finding（不丢信息） |
| verdict 一致性 | 按 §2.4.2 规则由 findings 重算；不一致以**重算值**为准 | 覆盖并记 `verdictAdjusted` |
| 条款上限 | 每 `category` 最多 3 条 | 超出按 severity+confidence 截断 |
| 全局条数 | 单段 ≤ 12 条（`cfg.maxFindingsPerSegment`） | 同 |
| 空产出 | `findings: []` 且 `verdict: approve` 且 `confidence > 0.8` 且无任何说明 | 视为可疑 → 重试一次（§6.5） |

> **`structured` 的读取路径**：`subagents.startActivation` 返回 `SubagentResult{output, structured?, diagnostic?, stopReason}`。
> `structured` 存在 → 直接用（框架已按 `outputSchema` 校验）；不存在（provider 不声明 `outputSchema` 能力）→ 从 `output` 文本里取第一个 `{...}` 平衡片段做 `JSON.parse`，失败则该段**标记失败**并按 §6.5 降级；**绝不**用正则"猜"字段。

### 2.7 S6 后处理（Post-process）

#### 2.7.1 去重（dedupe）

```
dedupeKey = sha256(
  normalizePath(file) + '|' +
  category + '|' +
  (line == null ? '' : String(Math.floor(line / 3) * 3)) + '|' +   // 3 行窗口
  normalizeTitle(title)                                            // 去标点/数字/空白
)
```
- 跨段与跨轮一律先按 `dedupeKey` 收敛，再对"标题归一化后 Jaccard ≥ 0.7 且同文件同 category"的条目合并（保留 severity 高者、confidence 取 max、`why` 取更长、`evidence` 取更完整）。
- `patch` 只有一条时保留；多条冲突 → 全部降为"建议"（`patch` 置空），避免拼接出错误代码。

#### 2.7.2 与上一轮比较（round diff）

| 状态 | 判定 | UI 表现 |
|---|---|---|
| `new` | 本轮有、上轮无 | 高亮"新增" |
| `persisting` | 两轮都有（`dedupeKey` 命中） | 标"仍未解决"，显示跨轮次数 |
| `fixed` | 上轮有、本轮无，且该文件在新 head 里确实改了 | 标"已修复"（自动，不计入负面统计） |
| `stale` | 上轮有、本轮无，但 headSha 变更未触及该位置 | 标"本轮未覆盖"（不是已修复） |
| `obsolete` | 该文件已删除或该 MR 已关闭/合并 | 归档 |

> 关键区分：`fixed` vs `stale` 必须靠"head 变更是否触及该文件/该 hunk"判定，否则会把"没审到"误报成"已修复"，污染统计。

#### 2.7.3 已知误报抑制（suppression）

```jsonc
// 存储：per-repo suppression 列表
{
  "id": "sup_7f3a",
  "repo": "group/app",
  "match": { "category": "performance", "pathGlob": "src/legacy/**", "titleContains": "N+1" },
  "reason": "该模块为离线批处理，无并发请求",
  "createdBy": "alice",
  "createdAt": "2026-10-02T10:00:00+08:00",
  "expiresAt": "2027-01-01T00:00:00+08:00",
  "hitCount": 14
}
```
- 抑制命中不丢弃，标 `suppressed: true` 并折叠（**可展开**），防止"沉默的错误的自信"。
- 抑制必须带 `reason` + 过期时间；过期自动失效，避免永久性盲区。
- 误报抑制的来源：卡片 verb `mark_false_positive`（§4.5）。

#### 2.7.4 严重度与结论的最终裁决（确定性，不花 token）

```
final = sortBySeverity(merged)
final = applyCategoryCaps(final, cfg.categoryCaps)          // §2.4.3
final = applyRepoPolicy(final, repoPolicy)                  // 例如 security 不得低于 high
verdict = request_changes if any(blocker) or count(high) >= 2
        | comment          if any(medium)
        | approve          if only low/info or none
if anySegmentFailed or anySkippedFile then verdict = min(verdict, comment)  // 有未覆盖就不能给 approve
confidence = weightedMean(findings.confidence, weight=severityWeight) * coverage
coverage = 已审文件数 / (已审 + skipped + truncated)
```
> `confidence` 必须乘 `coverage`：**没审完就不许高置信**。

### 2.8 S7 落地（Landing）

| 出口 | 机制 | 约束 |
|---|---|---|
| 面板展示 | `actionCards.register` 的 review kind + 面板自有区块（列表/详情/文件树/Badges） | 仅展示，零写操作 |
| GitLab 评论草稿 | 插件自渲染 Markdown（每条 finding → `file:line` + title + evidence + fix；`patch` 折叠进 `<details>`） | **只生成草稿文本**，落在面板"草稿箱" |
| 发布评论 | 自有 GitLab 客户端 `POST /projects/:id/merge_requests/:iid/discussions`（带 `position` = base/start/new_sha/new_line） | `approval.request` + `actionCards.verb(writes:true)` 双闸门；逐条或汇总二选一 |
| 建议通过（Approve） | **不提供 AI 自动提交**；面板展示"AI 建议通过"，人是唯一执行者 | §5.5 |
| 要求修改（Request changes） | 同上：生成评论草稿 + "建议 request changes"标签；提交动作由人确认 | §5.5 |
| 合并 | 复用 `forgePanel.merge(session, url, method, headSha)` | 必须人工、必须带 `headSha`（服务端会 `stale-head` 拒绝） |
| 落地为本地修改 | `ActionDefinition.outputKind='patch'` → 写进 session 工作区（沙箱内）或 `worktrees.create` 隔离 | 见 §4.3 / §5.6 |

**评论草稿的 Markdown 模板（片段）**

```markdown
## 🤖 AI 审查（{{template.name}} v{{template.version}} · {{model}}）

**结论**：{{verdictLabel}}（置信度 {{confidence}}）
{{summary}}

> 覆盖：{{reviewedFiles}}/{{totalFiles}} 个文件；未覆盖：{{skippedNote}}
> 本轮对比上一轮：新增 {{new}} / 未解决 {{persisting}} / 已修复 {{fixed}}

<details><summary><b>{{severityLabel}}</b> {{title}} — <code>{{file}}:{{line}}</code></summary>
**证据**

    {{evidence}}

**原因**
{{why}}

**建议**
{{fix}}
</details>
```

> 敏感信息在渲染前已脱敏（§5.4）；`patch` 默认不进评论（避免误复制），只在面板提供"复制 patch"。

### 2.9 S8 审计（Audit）

**原则：一切可回溯，且不新增会话事件类型。**

| 记录点 | 载体（契约） | 内容 |
|---|---|---|
| 谁触发 | Session `user/message`（`commands.execute` 或面板投递的提示词） | 触发者、触发方式、模板变量快照（脱敏后） |
| 用了什么输入 | 首个 `tool/call`（如 `review_change_request`）+ `arguments` | repo/mrIid/headSha/templateId/model/budget |
| 模型看到什么 | `request/header`（`EpochHeader{config, tools}`）+ `system/message` | 模型/参数/工具集 —— 框架自带 |
| 产出了什么 | `tool/result` 的 `meta`（`JsonValue`） | 完整 `ReviewResult` + 校验警告 + usage |
| 人的决定 | `actionCards.record(agent, decision)` | 「采纳/忽略/误报/发布评论/要求修改」及其理由 |
| 跨轮索引 | 插件自有存储（`storage`/`storageDomain` 或 JSON 文件） | `runId → {repo, mrIid, headSha, templateVersion, model, usage, verdict, createdAt, sessionId}` |

**追问与回溯**：审查 Session 可被 `agents.resume({resumeSessionId})` 冷恢复；`sessionQuery`/`sessionProjections` 提供列表与检索；面板"历史"页按 `repo+mrIid` 聚合 `runId` 列表，点开跳转原 Session（**审计的第一性来源是 Session 日志，插件存储在其次**）。

> 待确认 T1：插件命名空间事件（`plugin:*`，`forgeSession` 有先例）是否可作为正式 appender。若可用，S8 可多一个**不可被模型改写**的审计事件；否则用 `tool/result.meta` + 自有存储双写。

### 2.10 流水线伪代码

```ts
// ---------- 类型（设计态，非实现） ----------
type Severity = 'blocker' | 'high' | 'medium' | 'low' | 'info'
type Verdict  = 'approve' | 'comment' | 'request_changes'
type Category = 'correctness' | 'boundary' | 'concurrency' | 'error_handling'
             | 'security' | 'performance' | 'readability' | 'tests' | 'compatibility'

interface ReviewInput {
  repo: ForgeRepository
  mr: { iid: number; url: string; title: string; author: string | null
        headBranch: string; headSha: string; baseBranch: string
        additions: number; deletions: number; draft: boolean }
  ci: { rollup: ChecksRollup; checks: ChangeRequestCheck[] }
  files: ForgeDiffFile[]
  texts: Map<string, string>            // path -> 全文（按需）
  conventions: string
  history: ReviewRunSummary | null
  mode: 'full' | 'incremental'
  incrementalRange?: { from: string; to: string }
}

interface Segment {
  index: number; total: number
  files: Array<{ path: string; mode: 'full' | 'hunks' | 'skeleton'
                 hunkRange?: [number, number]; diffText: string }>
  estimatedInputTokens: number
  securitySensitive: boolean
}

// ---------- 主流程 ----------
async function runReview(ctx, req: ReviewStartRequest): Promise<ReviewRun> {
  const run = beginRun(req)                        // runId, startedAt, trigger

  // S0 ─ 闸门：预算 / 并发 / 幂等
  if (!(await budgetGate(ctx, req))) return finish(run, 'blocked', 'budget-exhausted')
  const cached = await cacheLookup(reviewCacheKey(req))
  if (cached) return finish(run, 'completed', { fromCache: true, ...cached })

  // S1 ─ 取数（只读；见 §2.2 的降级表）
  const input = await collectInput(ctx, req, run)   // 每步 emit(stageEvent)
  // S2 ─ 裁剪 + 分段（§2.3）
  const segments = packSegments(input, policyFor(input.repo))
  run.emit({ stage: 'packed', segments: segments.length,
             reviewedFiles: countFiles(segments), skipped: input.skippedFiles })

  // S3+S4+S5 ─ 每段：渲染 → 模型 → 结构化 → 后校验（有限并发，§6.2）
  const results = await mapLimit(segments, cfg.concurrencySegments, async (seg) => {
    const prompt = renderTemplate(template, buildVars(input, seg))       // §2.4
    const activation = await ctx.subagents.startActivation({
      provider: cfg.subagentProvider,          // 需 capabilities.outputSchema === true
      label: `review !${input.mr.iid} seg ${seg.index}/${seg.total}`,
      childId: newSessionId(),
      request: {
        cwd: input.repoPath,
        prompt: [{ type: 'text', text: prompt }],
        parent: run.agent,
        signal: run.signal,
        agentOptions: { provider: cfg.provider, model: modelFor(seg), maxTokens: 2048,
                        reasoningEffort: cfg.reasoningEffort },
        outputSchema: REVIEW_RESULT_SCHEMA,     // §2.6.2
      },
      signal: run.signal,
      delivery: 'caller',
    })
    try {
      const r = await activation.result
      if (r.structured) return validateSegment(r.structured, seg, input)  // §2.6.3
      return salvageJson(r.output) ?? failedSegment(seg, 'no-structured-output')
    } finally {
      await activation.dispose()
    }
  })

  // S6 ─ 去重 / 比上一轮 / 抑制 / 裁决（确定性，$0）
  const merged   = dedupe(flatten(results))
  const compared = diffAgainstPrevious(merged, input.history, input.mr.headSha)
  const filtered = applySuppression(compared, await suppressions(input.repo))
  const verdict  = adjudicate(filtered, results, input)                   // §2.7.4

  // S7 ─ 落地（只读默认；写操作走人工闸门）
  const card = await ctx.actionCards.propose({                          // 概念调用
    kind: 'daily-work/ai-review', title: `AI 审查 !${input.mr.iid}`,
    details: { summary: verdict.summary, verdict: verdict.decision,
               findings: filtered, coverage: verdict.coverage,
               draftComment: renderComment(verdict, filtered) },
  })

  // S8 ─ 审计（会话日志 + 自有索引）
  await auditRecord(ctx, { run, input, results, verdict, usage: run.usage })
  await cacheStore(reviewCacheKey(req), verdict)
  return finish(run, 'completed', { cardId: card.callId, verdict })
}

// ---------- 失败与降级（§6.5） ----------
async function segmentWithFallback(ctx, seg, input, run) {
  for (const step of ['primary', 'retry', 'alt-model']) {
    try { return await runSegment(ctx, seg, input, modelFor(seg, step)) }
    catch (e) {
      if (e.stopReason === 'max-tokens') shrinkSegment(seg, 0.6)    // 缩段重试一次
      if (!retryable(e)) break                                      // 鉴权/配额耗尽 → 直接降级
    }
  }
  run.degraded = true
  return runStaticChecks(ctx, input, seg)      // lint / typecheck / tests（只读 sandbox）
  // 静态检查也失败 → segment.status = 'failed'，最终 verdict 不得为 approve
}
```

---

## 3. 提示词与技能管理

### 3.1 数据结构（`PromptTemplate`）

```jsonc
{
  "id": "tmpl_review_core",                 // 稳定标识（slug），仓库内唯一
  "name": "核心代码审查（默认）",
  "role": "资深代码审查者",                   // 角色段
  "version": "1.3.0",                        // semver
  "contentHash": "sha256:9f2c…",             // 渲染前模板文本的哈希（缓存键之一）
  "body": "# 角色\n…{{mr.title}}…",           // 模板全文（§2.4.2 的形态）
  "checklists": [                            // 与 category 一一对应；可关可调
    { "category": "correctness",     "enabled": true,  "maxPerCategory": 3, "extraRules": "" },
    { "category": "security",        "enabled": true,  "maxPerCategory": 3,
      "extraRules": "必须检查密钥硬编码、越权访问、日志泄漏" },
    { "category": "readability",     "enabled": false, "maxPerCategory": 1, "extraRules": "" }
  ],
  "outputSchemaId": "review-result@1",       // 指向 §2.6.2
  "outputFormat": {
    "kind": "json",                          // json | markdown | patch | text
    "forbidFences": true,                    // 禁止 ``` 围栏
    "selfCheck": ["verdict 与 findings 一致", "evidence 可逐字核验"]
  },
  "variables": ["mr.title", "mr.iid", "diff", "files.list", "project.conventions", "ci.rollup"],
  "scope": {                                 // 适用范围（决定什么时候默认选中）
    "projects": ["group/app", "group/app-*"],           // 支持通配
    "paths": ["src/**", "app/**"],                      // 命中才启用；空=全部
    "excludePaths": ["docs/**", "**/*.md"]
  },
  "model": { "provider": "deepseek", "model": "…", "temperature": 0.1,
             "reasoningEffort": "medium", "maxTokens": 2048 },
  "skillRefs": ["repo-conventions-check"],   // 引用的 DSH skill（作为审查方法），§3.5
  "budget": { "segmentMaxInputTokens": 24000, "maxSegments": 6,
              "maxFindingsPerSegment": 12, "maxCostUsdPerRun": 0.35 },
  "enabled": true,
  "visibility": "team",                      // private | team | org
  "abTest": { "enabled": false, "challengerVersion": "1.4.0", "splitBy": "mr-url-hash" },
  "stats": {                                 // 只读聚合（由反馈闭环写入）
    "runs": 128, "findings": 402, "accepted": 231, "dismissed": 61,
    "falsePositive": 24, "avgLatencyMs": 41200, "avgCostUsd": 0.21,
    "acceptRate": 0.575, "fpRate": 0.060, "lastRunAt": "2026-11-08T21:12:00+08:00"
  },
  "createdBy": "alice", "createdAt": "…", "updatedBy": "bob", "updatedAt": "…"
}
```

**保存期校验（硬规则）**

| 规则 | 说明 |
|---|---|
| `id` 唯一且 slug 化 | 冲突 → 拒绝；导入时冲突 → 生成 `id@2` 并提示合并 |
| `version` 必须 semver 且单调递增 | 已发布版本不可原地改（改则 version+1，并保留旧版可回滚） |
| `temperature ≤ 0.2` | 审查类 Action 强制；非审查类（如"起草回复"）上限 0.4 |
| `outputSchemaId` 必须存在且可解析 | 加载时按 §2.6.3 做一次 dry-validate（用一条样例数据跑后校验器） |
| 模板里出现的 `{{var}}` 必须在 `variables` 内 | 渲染期缺失变量 → 该 run 记 `renderWarning`（不阻断） |
| `checklists` 的 category 不得重复 | — |

### 3.2 变量字典（渲染上下文）

| 变量 | 类型 | 来源 | 示例值 | 脱敏 |
|---|---|---|---|---|
| `{{mr.iid}}` | number | `ChangeRequestSnapshot.ref.number` | `1284` | — |
| `{{mr.title}}` | string | `snapshot.title` | `fix(auth): 修复刷新令牌并发失效` | — |
| `{{mr.url}}` | string | `snapshot.url` | `https://gitlab.example.com/g/app/-/merge_requests/1284` | — |
| `{{mr.author}}` | string | `snapshot.author` | `alice` | — |
| `{{mr.head_branch}}` / `{{mr.base_branch}}` | string | `snapshot.headBranch/baseBranch` | `feat/auth-refresh` / `main` | — |
| `{{mr.head_sha}}` | string | `snapshot.headSha` | `3f9a1c2` | — |
| `{{mr.additions}}` / `{{mr.deletions}}` | number | `snapshot` | `312` / `88` | — |
| `{{mr.draft}}` | boolean | `snapshot.draft` | `false` | — |
| `{{diff}}` | string | `forgePanel.changeRequestDiff` 渲染 | `diff --git a/src/auth.ts b/src/auth.ts …` | ✅ |
| `{{files.list}}` | string | `ForgeDiffFile[]` 汇总 | `src/auth.ts (modified, +120/-30, full)` | — |
| `{{files.count}}` | number | 同上 | `7` | — |
| `{{files.skipped}}` | string | `oversized/binary/generated` | `dist/app.js (generated, skipped)` | — |
| `{{project.path}}` | string | `workingDirectory.get(session)` 相对化 | `D:\repo\app` 或 `group/app` | ✅ |
| `{{project.conventions}}` | string | `AGENTS.md`/`CONTRIBUTING.md`/模板默认 | `- 一律显式返回错误- 公共 API 必须带 JSDoc` | ✅ |
| `{{ci.rollup}}` | enum | `snapshot.checksRollup` | `failure` | — |
| `{{ci.summary}}` | string | `snapshot.checks` 摘要 | `3 passed, 1 failed(lint)` | — |
| `{{segment.index}}` / `{{segment.total}}` | number | 分段器 | `2` / `4` | — |
| `{{segment.file_count}}` | number | 分段器 | `5` | — |
| `{{mode}}` | enum | 触发器 | `incremental` | — |
| `{{incremental.range}}` | string | compare API | `3f9a1c2..7d2e0b1` | — |
| `{{history.summary}}` | string | 插件存储 | `上一轮 2026-11-07：3 条未解决` | — |
| `{{skills.content}}` | string | `skills.get(name,{cwd,scope})` 的 `content` | （skill 正文） | ✅ |
| `{{user.note}}` | string | 面板"本次审查重点"输入 | `重点看 token 刷新竞态` | ✅ |

**渲染规则**：单层 `{{name}}`；未定义变量渲染为 `""` 并记 `renderWarning`；**不做模板逻辑**（无 `if/for`），条件性内容由"渲染前拼装"完成（例如首轮不出现"上一轮"段落）。对 `{{diff}}` / `{{skills.content}}` 这类大块，允许 `{{#truncate:...}}` 之外的**唯一**后缀写法 `{{diff|max=24000}}` 表示超限截断并追加 `……(截断)`（实现为一个预处理器，不是模板语言）。

### 3.3 版本与 A/B

- **不可变版本**：`(id, version)` 一经运行即冻结；`contentHash` 参与缓存键与审计。
- **兼容性**：`outputSchemaId` 变更视为 **major**（旧结果无法并表统计）；仅文案/检查清单调整视为 minor；拼写修正 patch。
- **A/B**：
  - 分配：`bucket = int(sha256(mr.url + salt)) % 100`，`bucket < splitPercent` → challenger。**同一 MR 固定同一分支**（避免轮次间抖动），salt 每轮实验更换。
  - 护栏：challenger 的 `maxCostUsdPerRun` 不得高于 control；`fpRate` 高于 control + 5pp 自动熔断（停用 challenger）。
  - 观测：stats 按 `templateId+version` 分组；报告 acceptance、fpRate、latency、cost、findings/run 中位数。
- **回滚**：面板"回滚到 v1.2.0"= 把 `enabled` 指向旧版本（旧版记录保留，不删）。

### 3.4 导入导出

```jsonc
// 导出包（单文件 .ai-review-pack.json，UTF-8）
{
  "format": "dsh-daily-work/ai-review-pack@1",
  "exportedAt": "2026-11-08T22:00:00+08:00",
  "templates": [ /* PromptTemplate[] */ ],
  "actions":   [ /* ActionDefinition[] */ ],
  "suppressions": [ /* 可选，默认不含（含仓库路径，敏感） */ ],
  "skills":    [ { "name": "repo-conventions-check", "files": { "SKILL.md": "…" } } ],
  "requires":  { "capabilities": ["subagents.outputSchema", "actionCards", "forge.watch"] }
}
```

| 规则 | 说明 |
|---|---|
| 导入幂等 | 同 `(id, version, contentHash)` → 跳过；同 `id` 不同 hash 且版本已存在 → 冲突，需显式选择"覆盖为新版本/另存为副本" |
| 敏感内容 | 默认**不带**凭据、不带 suppression（含内部路径）、不带 stats（含个人信息） |
| 校验 | 导入前 dry-run：schema 校验 + 样例渲染 + 后校验器跑一遍，任一失败则整包拒绝并给出定位 |
| 体积 | 单包上限 512KB（模板是文本，不含二进制资源） |

### 3.5 与 DSH skill 的互操作（**双向，且不重复实现**）

#### 方向 A：模板 → skill（让人和 Agent 都能"加载"这份审查方法）

- 产物：标准化目录 `<workspace>/.dsh/skills/<slug>/SKILL.md`（对应 `SkillSource = 'project-dsh'`），`frontmatter` 至少给出 `name`、`description`、`whenToUse`（三个字段与 `SkillSummary` 契约一一对应，其余字段按当前解析器要求补齐）。
- 命名避让：`slug = "review-" + templateId`（**前缀强制**）。理由：`skills.register` 同层同名 first-wins 且跨层"最近层胜出"，加前缀可避免与用户既有 skill（如 `code-review`）冲突。注册失败（重复）时降级为"仅导出文件"，并在 UI 说明。
- 内容映射：`role` → `SKILL.md` 的 "何时使用/角色"；`checklists` → 正文的检查清单章节；`outputFormat` → 正文的"输出格式"章节；`variables` → 正文的"输入变量"表格（skill 是**给人/Agent 读的方法论**，不是可执行模板）。
- 反向同步：**不自动**回写。skill 文件被手工编辑后，模板与 skill 视为两条独立资产；面板提供"对比差异"与"以 skill 为准覆盖模板正文"的显式操作。

#### 方向 B：引用 DSH skill 作为审查方法（`skillRefs`）

```ts
// 运行期解析（伪代码）
for (const name of template.skillRefs) {
  const skill = await ctx.skills.get(name, { cwd: input.repoPath, scope: reviewScope })
  if (!skill) { run.warn(`skill-not-found:${name}`); continue }   // 缺失不阻断
  methods.push({ name, whenToUse: skill.whenToUse, content: clamp(skill.content, 1200) })
}
```
- `scope` 用审查会话的 scope（`agentPresets.acquireScope` / 审查 preset 的层），保证只看到该 preset 可见的 skill；面板"技能"页用 `sessionSkillCatalog.list({sessionId})` 列**用户可调用**的技能（`SkillEntry.modelInvocable` 区分模型可调用）。
- 注入位置固定为模板 `[4] 审查方法`，与检查清单**并列而非替换**：skill 提供"怎么做"，模板提供"必须输出什么"。

| 模板概念 | DSH skill 概念 | 映射方向 | 谁说了算 |
|---|---|---|---|
| `name` / `description` | `SkillSummary.name/description` | 双向 | 导出时由模板生成；引用时不改模板 |
| `role` + 检查清单 | skill `content` 正文 | 模板 → skill（单向导出） | 模板 |
| `skillRefs` | `skills.get()` 的 `content` | skill → 模板（运行期注入） | skill |
| `visibility: team` | `SkillSource` 分层（project/runtime/user） | 近似（不是同一维度） | 见 §3.6 |
| 版本/A-B/stats | skill 无对应概念 | 模板独有 | 模板 |

### 3.6 团队共享方案

| 层 | 载体 | 优先级（高→低） | 适用场景 |
|---|---|---|---|
| L1 仓库内（project-dsh） | `<repo>/.dsh/review/templates/*.json` + `.dsh/skills/review-*/SKILL.md` | 最高 | 团队对**这个仓库**的约定（含路径规则、检查清单裁剪） |
| L2 个人（user-dsh） | profile 用户目录（与 skill 的 `user-dsh` 同层语义） | 中 | 个人偏好（温度、模型、忽略 readability） |
| L3 组织（runtime/自定义 provider） | 插件通过 `skills.registerProvider` + 自有 `storage` 提供 | 低（可被上层覆盖） | 公司级模板集市；建议同时给 `source: 'custom'` 以便 UI 标注来源 |
| L4 内置（bundled） | 插件内置默认模板 | 最低 | 开箱可用 |

- **合并语义**：`id` 相同按层覆盖（L1 > L2 > L3 > L4），与 DSH skill 的"最近层胜出"一致；**不同 id 并列**，由 `scope.projects/paths` 决定默认选中。
- **共享动作**：面板"导出到仓库"生成 L1 文件（走一次 PR 流程，团队 review 后合入）→ 这是"团队共享"的主力路径；"推送组织集市"为 P2。
- **冲突提示**：同一 `id` 在多层同时存在时，UI 显示"被 L1 覆盖"，并在"以哪层为准"处给出一键对比。

### 3.7 统计与反馈闭环（落在模板上）

```
acceptRate  = accepted / findings                       // 卡片"采纳"
fpRate      = falsePositive / findings                  // 卡片"误报"
dismissRate = dismissed / findings                      // 卡片"忽略"
adoptRate   = appliedPatchOrFixed / accepted            // 采纳后真的改了
costPerAcceptedFinding = Σcost / accepted
```
- 反馈写入 `template.stats`（聚合，不含个人身份）；同时把"误报样本（finding + evidence + reason）"入库用于 §7.2 的 few-shot 与抑制候选。
- **不做在线学习**：模型权重不更新；只做"提示词/清单/抑制/阈值"的配置迭代，避免不可解释的漂移。

---

## 4. 通用 Action 抽象

### 4.1 `ActionDefinition`（JSON Schema 示例）

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "title", "inputs", "promptTemplate", "outputKind", "runAs"],
  "properties": {
    "id": { "type": "string", "description": "slug，唯一，如 review / summarize-mr" },
    "title": { "type": "string", "description": "面板显示名（中文）" },
    "icon": { "type": "string", "description": "图标名（面板图标注册表的 key），如 'shield-check'" },
    "description": { "type": "string" },
    "version": { "type": "string", "description": "semver" },
    "inputs": {
      "type": "array",
      "description": "输入项声明；类型枚举对应面板控件",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "type"],
        "properties": {
          "name": { "type": "string" },
          "label": { "type": "string" },
          "type": {
            "type": "string",
            "enum": ["mr", "issue", "files", "text", "select", "boolean", "number", "dateRange", "commitRange"]
          },
          "required": { "type": "boolean" },
          "default": {},
          "options": { "type": "array", "items": { "type": "string" } },
          "hint": { "type": "string" }
        }
      }
    },
    "promptTemplate": { "type": "string", "description": "模板 id 或内联模板（引用优先）" },
    "skillRefs": { "type": "array", "items": { "type": "string" } },
    "model": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "provider": { "type": "string" },
        "model": { "type": "string" },
        "temperature": { "type": "number" },
        "maxTokens": { "type": "integer" },
        "reasoningEffort": { "type": "string" }
      }
    },
    "outputKind": {
      "type": "string",
      "enum": ["findings", "markdown", "patch", "json", "text", "none"]
    },
    "outputSchemaId": { "type": "string", "description": "outputKind=json/findings 时必填" },
    "runAs": {
      "type": "string",
      "enum": ["session", "subagent", "command"],
      "description": "session=新建审查会话；subagent=当前会话内一次性子代理；command=斜杠命令"
    },
    "postActions": {
      "type": "array",
      "description": "产出之后的可选落地动作（全部需人工触发）",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "label"],
        "properties": {
          "kind": {
            "type": "string",
            "enum": ["gitlab-comment", "gitlab-approve", "gitlab-request-changes",
                     "local-apply", "open-worktree", "clipboard", "create-issue",
                     "publish-file", "schedule-followup"]
          },
          "label": { "type": "string" },
          "requiresConfirm": { "type": "boolean", "description": "默认 true；仅只读类可置 false" },
          "params": { "type": "object", "description": "如 { groupBy: 'file' } 或 { branchPrefix: 'ai-review/' }" }
        }
      }
    },
    "confirm": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "beforeRun": { "type": "boolean", "description": "消耗预算前是否二次确认" },
        "beforeWrite": { "type": "boolean", "description": "任何写操作前确认（默认 true 且不可关）" },
        "reasonField": { "type": "boolean", "description": "写操作是否要求填写理由（审计用）" }
      }
    },
    "readOnlyTools": {
      "type": "boolean",
      "description": "true=运行时 restrict 掉所有写工具（审查/摘要类默认 true）"
    },
    "budget": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "maxCostUsdPerRun": { "type": "number" },
        "maxInputTokens": { "type": "integer" },
        "concurrency": { "type": "integer" }
      }
    },
    "enabled": { "type": "boolean" },
    "scope": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "projects": { "type": "array", "items": { "type": "string" } },
        "paths": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}
```

### 4.2 执行模型（统一 6 步，所有 Action 复用）

```
input 解析/校验 → 权限与预算闸门 → 模板渲染 → 运行(session|subagent|command)
   → 输出校验 + 渲染器 → postActions（人工触发） → 审计 + 反馈
```

- **`runAs` 三态**：
  - `session`：为长/重任务（审查、周报、发布说明），产出可回看可追问 → `agents.create` + 一次 turn（§8.1）。
  - `subagent`：轻任务（解释代码、起草回复），挂在当前面板会话下 → `subagents.startActivation({delivery:'caller'})`。
  - `command`：`commands.register`，输入用 `input.hint`，日志自带 `command/run|done`（适合"选中 MR → `/review`"）。
- **`readOnlyTools: true`** → 运行期 `tools.restrict({ deny: [writeTools] })`，并 `tools.guard(exec => exec.name.startsWith('fs.write') ? 'read-only review run' : undefined)` 兜底。
- **统一 outputKind 渲染器**：`findings`→审查卡；`markdown`→带复制/发布按钮的富文本；`patch`→diff 卡片（复用 `ToolCallView` 的 `card:'diff'` 形态）；`json`→键值表；`text`→纯文本。
- **postActions 与 `actionCards.verbs` 同构**：每个 `postActions[].kind` 在 review kind 里对应一个 `verb`；`requiresConfirm` ↔ `ActionCardVerb.writes: true`；`act()` 返回 `'unconfirmed'` 时面板弹确认。

### 4.3 8 个示例 Action 表

| id | 标题 / 图标 | inputs | promptTemplate | skillRefs | model | outputKind | postActions（需人工） | runAs | 只读 |
|---|---|---|---|---|---|---|---|---|---|
| `review-mr` | AI 审查 / `shield-check` | `mr`(必), `text`(本次重点), `select`(深度：quick\|standard\|deep) | `tmpl_review_core` | `repo-conventions-check` | 主力推理模型, t=0.1 | `findings` | `gitlab-comment`(确认), `local-apply`(确认), `open-worktree`(确认), `clipboard`(免确认) | `session` | ✅ |
| `summarize-mr` | 变更摘要 / `list-tree` | `mr`(必), `select`(受众：dev\|pm\|release) | `tmpl_summary_mr` | `repo-conventions-check`(可选) | 轻量模型, t=0.2 | `markdown` | `clipboard`(免), `gitlab-comment`(确认), `publish-file`(确认) | `subagent` | ✅ |
| `gen-tests` | 生成测试 / `flask` | `files`(必，≤5 个), `select`(框架：jest\|vitest\|pytest\|go-test), `boolean`(含边界用例) | `tmpl_gen_tests` | `test-style` | 主力推理模型, t=0.2 | `patch` | `local-apply`(确认), `open-worktree`(确认), `create-issue`(确认) | `session` | ✅（产出 patch，由人应用） |
| `explain-code` | 解释代码 / `book-open` | `files`+`text`(问题), `number`(起始行) | `tmpl_explain` | `arch-notes` | 轻量模型, t=0.2 | `markdown` | `clipboard`(免), `publish-file`(确认) | `subagent` | ✅ |
| `draft-reply` | 起草回复评论 / `message-square` | `mr`(必), `text`(要回复的讨论摘要/链接), `select`(语气：中立\|坚定\|谦和) | `tmpl_draft_reply` | `team-voice` | 主力模型, t=0.35 | `markdown` | `gitlab-comment`(确认，且默认"作为讨论回复"), `clipboard`(免) | `subagent` | ✅ |
| `weekly-report` | 生成周报 / `calendar` | `dateRange`(必), `select`(范围：我\|我+参与评审), `boolean`(含数字指标) | `tmpl_weekly` | `work-report-style` | 轻量模型, t=0.2 | `markdown` | `clipboard`(免), `publish-file`(确认) | `session` | ✅ |
| `release-notes` | 写发布说明 / `tag` | `mr`(多选) 或 `commitRange`(必其一), `text`(版本号), `select`(受众：内部\|客户) | `tmpl_release_notes` | `release-style` | 主力模型, t=0.2 | `markdown` | `clipboard`(免), `publish-file`(确认), `create-issue`(确认) | `session` | ✅ |
| `apply-mr-locally` | 把 MR 改动落到本地 / `git-pull-request` | `mr`(必), `select`(方式：patch\|worktree), `text`(分支名前缀) | `tmpl_apply_mr`（极小，主要是"校验 headSha + 生成 patch"） | — | 轻量模型, t=0 | `patch` | `local-apply`(确认+理由), `open-worktree`(确认) | `subagent` | ❌（唯一允许写的一类，且必须 worktree 隔离 + 二次确认） |

**说明**
- `apply-mr-locally` 是唯一 `readOnlyTools: false` 的 Action：它必须先在 `worktrees.create(agent, {…})` 创建隔离工作树，再应用 patch；失败可整体丢弃工作树（§5.6 回滚）。
- 8 个 Action 里 6 个共用 `tmpl_review_core` 之外的独立小模板；模板体积小（≤ 600 tokens），成本可控。
- `icon` 用面板图标注册表的 key（不是 emoji），避免字体差异与深色模式问题。

### 4.4 `outputKind` 与渲染/校验矩阵

| outputKind | 校验 | 渲染 | 典型 postAction |
|---|---|---|---|
| `findings` | `ReviewResult` schema + §2.6.3 后校验 | 分组列表（按 severity/file），含 evidence 折叠、跳转文件行 | 评论草稿 / 应用 patch |
| `markdown` | 非空；长度上限；**必须**含标题行；禁 HTML 脚本 | 富文本 + 复制/编辑 | 复制 / 发评论 / 存文件 |
| `patch` | `git apply --check` 等价校验（在只读沙箱内 dry-run） | diff 卡（`card:'diff'`） | 应用到工作区 / 建分支 |
| `json` | 指定 `outputSchemaId` | 键值表 / 可复制 JSON | 存入文件 / 建 issue |
| `text` | 非空 | 纯文本 + 复制 | 复制 |
| `none` | — | 只更新卡片状态 | — |

### 4.5 `postActions` / verbs 一览

| verb | writes | 执行者 | 落地 | 失败可回滚 |
|---|---|---|---|---|
| `copy` | 否 | 面板 | 剪贴板 | — |
| `post_comment` | **是** | 人确认后 | 自有 GitLab API（`discussions`/`notes`） | 删除该 note（返回 id 已存） |
| `post_review_summary` | **是** | 人确认后 | 一条汇总 comment | 同上 |
| `approve` | **是** | **仅人**（AI 不触发） | GitLab `POST .../approve` | 撤销 approve（`POST .../unapprove`） |
| `request_changes` | **是** | 人确认后 | 评论 + 标记 | 撤回评论 |
| `apply_patch` | **是** | 人确认后 | 工作区 / worktree | `git checkout -- <paths>` 或丢弃 worktree |
| `mark_false_positive` | 否（写插件存储） | 面板 | 抑制候选池 | 从抑制列表移除 |
| `dismiss` | 否 | 面板（框架内置） | `actionCards` 记录 | 重新打开卡片 |
| `open_issue` | **是** | 人确认后 | GitLab Issue | 关闭/删除 issue |
| `schedule_followup` | 否（本会话） | 面板 | `schedule.create` | `schedule.delete` |

---

## 5. 人机协同与安全

### 5.1 默认只读（Least privilege by default）

| 层 | 只读手段 | 契约 |
|---|---|---|
| 工具层 | 审查运行期间 `tools.restrict({ deny: ['fs.write','fs.edit','subprocess.exec','terminal.*','forge.merge', …] })`；再挂 `tools.guard` 兜底（guard 是单调拒绝，不可被后续代码放开） | `tools.restrict` / `tools.guard` / `checkGuards` |
| Session 层 | 审查 Session 用只读 `sandbox`/`sandboxPolicy` 组合；工作目录只读挂载 | `sandboxPolicy`（目录中出现，契约待确认 T2） |
| 网络层 | 只读 Action 不注册任何 GitLab 写客户端；写客户端**按需注入**到"确认后"的执行器 | 插件内部结构 |
| 数据层 | S1 取数只用 `forge`/`forgePanel` 的读方法（`diff/fileText/localDiff/localText/latest`） | 见 §1.1 |
| 产出层 | 默认产出**草稿**（草稿箱），不是直接发布 | §2.8 |

**只读的"负向清单"必须显式**（不能靠"没注册"隐式保证）：面板在运行详情里展示"本次运行禁用了 N 个工具"，供人核对。

### 5.2 评论前必须人工确认

三段式闸门，缺一不可：

1. **卡片 verb 声明**：`post_comment` / `post_review_summary` / `approve` / `request_changes` 全部 `writes: true` → `actionCards` 拒绝静默执行，`act()` 返回 `'unconfirmed'` 直到人确认。
2. **`approval` 服务**：执行前 `approval.request({…})`；若 `ApprovalOutcome` 未批准 → 中止且**不留下半成品**（先构造 payload，后调用；失败只记录）。
3. **二次确认 UI**：展示**将要发布的完整 Markdown 文本** + 目标 MR + `headSha`（head 变了 → 提示"内容可能过期，请重新审查"）。

**幂等与防抖**：同一 `runId + verb` 在 30s 内重复点击只执行一次（`runId` 级互斥）；发布后按钮变"已发布（note #123）"并给"删除"入口。

### 5.3 token 最小权限与凭据

| 凭据 | 存放 | 权限 | 用途 | 轮换 |
|---|---|---|---|---|
| GitLab PAT（读） | `credentials`（`CredentialRef`：per-host，如 `gitlab:gitlab.example.com:read`） | `read_api` | Issue/MR 读、compare API | UI 可重设；`describe` 展示到期时间 |
| GitLab PAT（写） | 独立 `CredentialRef`（如 `…:write`），**默认未配置** | `api`（或 `write_repository` 之外的 `api` scope） | 发评论/approve | 仅在用户显式启用"允许发布"时可选 |
| 模型 key | 复用 Harness 既有 provider 配置 | — | — | 不落插件存储 |
| Webhook secret（P1） | `credentials` record | — | 校验 GitLab webhook | 可轮换 |

- **不把凭据写进模板/日志/导出包**；`credentialRef` 只允许"名字"，值只经 `credentials.resolve()` 取用。
- 凭据使用点**集中**：单文件 `gitlabClient`，其所有调用前检查"该 repo 是否有该 scope 的凭据"，缺失 → UI 明确提示（不是静默失败）。
- `credentials.describe(ref)` 展示掩码（`glpat-****abcd`），从不展示全文。

### 5.4 敏感信息脱敏（提示词之前，不是之后）

| 检测 | 规则 | 处理 |
|---|---|---|
| 常见令牌 | `glpat-[A-Za-z0-9_-]{20,}`、`ghp_`、`sk-[A-Za-z0-9]{20,}`、`AKIA[0-9A-Z]{16}`、`xox[baprs]-` | 替换为 `[[REDACTED:gitlab_pat]]`，并**在该 finding 里提示"疑似硬编码凭据"**（这是有价值的发现） |
| 私钥/证书 | `-----BEGIN [A-Z ]*PRIVATE KEY-----` 到 `-----END…` | 整块替换 |
| 连接串 | `://[^:@/\s]+:[^@/\s]+@`（含密码的 URL） | 密码段替换 |
| `.env` 值 | `^[A-Z0-9_]*(PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL)[A-Z0-9_]*\s*=\s*(.+)$` | 值替换（保留键名） |
| 高熵串 | `len ≥ 24` 且 `Shannon ≥ 4.0` 且非常见词 | 标记"疑似密钥"，替换为 `[[REDACTED:high_entropy]]` 并在 summary 提示 |
| 个人数据 | 邮箱、手机号、身份证号（按团队策略可关） | 部分掩码（`a***@corp.com`） |
| 二进制/lock/超大文件 | `ForgeDiffFile.binary/oversized`、`*.lock`、`dist/**` | 不发内容（§2.3.3 档 4） |

- **脱敏在渲染上下文构建时统一做**（`buildVars` 对 `diff/files/conventions/user.note` 全量过一遍），保证模板、skill 注入、评论草稿都不会二次泄漏。
- 脱敏后的占位符**保留类型**，让模型仍能判断风险（例如能看出"这里有硬编码 token"）；同时 `evidence` 里出现占位符 → `evidenceUnverified` 不成立（白名单占位符）。
- 审计日志同样脱敏；导出包不带原文。

### 5.5 避免误批准（最重要的一条）

1. **产品层**：AI **永不**自动 approve / request-changes / merge / resolve thread。`actionCards` 里不存在"AI 触发 approve"的路径：`approve` 只能由 UI 的人点击，并且**不绑在 finding 结论上**（即使 verdict=approve，按钮文案仍是"我确认通过"）。
2. **模型层**：模板明确"verdict 是建议"；`approve` 只在 `findings` 无 medium 及以上时允许（§2.6.3 强制重算，模型自评被覆盖）。
3. **状态层**：审批页面永远展示①本次审查的 `headSha` ②覆盖率 ③未覆盖清单 ④失败/降级标记。任一项异常（`coverage < 0.9`、`degraded=true`、`skipped > 0`）→ verdict 上限 `comment`，且 approve 按钮置灰并说明原因。
4. **并发层**：人在看结果时 head 变了（`forge.latest` 轮询到 `headSha` 变化）→ 卡片立刻打"过期"水印，所有写 verb 禁用（不是仅提示）。
5. **审计层**：每次 approve/merge 记录（人、时间、headSha、当时的 verdict、覆盖率）。若事后回滚（revert），面板把该次审查记为 `misjudged`，进入 §7 的评测集。

### 5.6 写操作的二次确认与回滚

| 写操作 | 确认 | 回滚 | 边界 |
|---|---|---|---|
| 发布评论 | 展示全文 + 目标 + headSha；`approval.request`；`reasonField` 可选 | 已存 `note/discussion id` → 一键删除 | 单次运行最多 N 条（默认 20），超限要求"汇总为 1 条" |
| approve | 双确认（勾选"我已阅读审查结果与未覆盖清单"） | `unapprove` | 只能对自己有权限的 MR |
| 应用 patch 到工作区 | 展示 `git apply --check` 结果 + 变更文件列表；确认 | `git checkout -- <paths>`（**只回滚本次涉及路径**，先记录原内容 hash） | 默认在 `worktrees.create` 的隔离树里做；直接在主干工作区应用需再确认一次 |
| 合并 | `forgePanel.merge(session,url,method,headSha)` | 无法回滚 → 因此必须人工 + `headSha` 校验（`stale-head` 会拒绝） | 建议 P1 才开放"面板内合并" |
| 建 Issue | 展示标题/正文/标签 | 关闭 issue | — |

**回滚的实现原则**：任何写操作执行前先落一条"意图记录"（`intent`），执行后落"结果记录"（`outcome`，含远端 id）。两者都进审计。崩溃/中断后，面板据 `intent` 无 `outcome` 的记录提示"上次操作状态未知，请到 GitLab 核对"——**不猜测、不自动重试写操作**。

---

## 6. 成本与性能

### 6.1 单次审查的 token / 时长估算方法

**公式（可做成面板里的"预估"按钮）**

```
input_tokens  ≈ 3,000                                   // 模板 + 清单 + 约定 + 分段头（固定开销，§2.3.5）
              + Σ_segments ( diff_chars(seg) / 2.6 )    // 中英混排代码的近似 chars→tokens
              + 1,200 * skillRefs.length                // skill 注入（截断后）
output_tokens ≈ 250 + 220 * E[findings/seg] * n_seg      // 每条 finding ≈ 220 tokens（含 evidence/why/fix）
latency_ms    ≈ n_seg_batches * ( TTFT + output_tokens/seg / TPS )
              + overhead(取数 0.8-2.5s + 后处理 0.1s)
```

**样例（500 行 diff / 7 文件 / 2 段 / 主力模型）**

| 项 | 估算 |
|---|---|
| diff 字符数 | ≈ 38,000（500 行 × 平均 76 字符） |
| input | `3,000 + 38,000/2.6 ≈ 17,600` tokens（含 1 个 skill 再 +1,200 ≈ 18,800） |
| output | 2 段 × (250 + 220×3) ≈ 1,820 tokens |
| 时长 | 2 段并发（concurrency=2）≈ `TTFT 2.5s + 910/35 ≈ 28s` + 取数 1.5s ≈ **32s** |
| 成本 | 按主力模型定价 `$0.28/M in, $1.10/M out` → `18.8k*0.28/1000 + 1.82k*1.10/1000 ≈ $0.0053 + $0.0020 ≈ $0.007/次` |

> 面板在**开始前**展示预估（input/output/时长/成本），超过 `maxCostUsdPerRun` 或当日预算 → `budgetGate` 拦截（可"仍要运行"覆盖，记审计）。
> 实际值一律以 `assistant/message.usage`（`TokenUsage{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}`）为准回填，并用实际值校准估算系数（滚动 100 次的中位数）。

### 6.2 并发上限与限流

| 维度 | 默认 | 说明 |
|---|---|---|
| 同一次审查内分段并发 | 2（可 3） | 受 provider 速率与上下文预算双重约束；并发过高会让 `usage` 抖动、失败率上升 |
| 全局同时审查数 | 2 | 超过则排队（FIFO + 优先级：用户手动 > 规则 > 定时） |
| 同 MR 并发 | 1 | 幂等键互斥（§2.1） |
| 同 provider 请求并发 | 4 | 由 `llm.providerRetryPolicy(provider)` 与 429/`providerRetryAfterMs` 动态降 |
| 轮询节流 | MR ≥30s，Issue ≥60s | 复用 `forge.watch` 自带节奏；Issue 用 `timer.interval` + 抖动（±20%）避免惊群 |
| 队列背压 | 队列 > 20 → 暂停规则/定时触发，仅保留手动 | 面板显示"已暂停自动审查（队列满）" |

### 6.3 缓存（三层，键各不相同）

| 层 | 键 | TTL | 说明 |
|---|---|---|---|
| diff 缓存 | 已由 `forgePanel.changeRequestDiff` 内部按 `headSha+baseBranch` 缓存 | 框架管理 | **不重复实现**（§1.2-6） |
| 审查结果缓存 | `sha256(repo, mrIid, headSha, templateId, templateVersion, contentHash, model, schemaVersion)` | 7 天 或 head 变更 | 命中 → 直接回放结果 + 标"来自缓存（head 未变）"；**不消耗 token** |
| 约定/骨架缓存 | `sha256(path, commit)` | 30 天 | `changeRequestText` 的骨架抽取结果（省一次文件读 + 省 token） |

**缓存失效**：模板版本升级、模型更换、schema 升级、suppression 变更（影响展示，不影响结论缓存——但 UI 需重算展示层）。

### 6.4 增量审查（只审新 commit）

```
last = store.lastReviewed(repo, mrIid)                  // {headSha, reviewedAt, findings[]}
if (!last || last.headSha === current.headSha) → 走缓存/跳过
range = compare(last.headSha, current.headSha)          // 自有 GitLab compare API（G3）
if (range.commits.length > cfg.maxIncrementalCommits /*默认 20*/) → 回退全量（避免"增量地狱"）
// 增量分支的三条硬规则：
// 1) 只发 range 的 diff，但**必须**附带 last.findings 作为"待验证项"，让模型回答 fixed/persisting
// 2) 受影响文件若同时出现在旧 findings 里，允许发送该文件**当前全文**（cheap，防"只看到增量而误判已修复"）
// 3) 合并/变基（merge/rebase commit）导致 range 无意义（commits 含 merge commit 或 base 变更）→ 回退全量
```
**"diff 基线失效"检测**：`snapshot.baseBranch` 变化、`range` 为空但 `additions/deletions` 变了、`force-push`（`headSha` 不在 compare 的祖先链上）→ 一律全量重审，并在 UI 说明原因（避免拿错基线得出"已修复"）。

### 6.5 失败重试与降级阶梯

```
L0 正常：primary model，分段并发 2
L1 重试：可重试错误（429/5xx/`unavailable`/超时）→ 指数退避 1s/2s/4s，最多 3 次；
        尊重 `LlmFailure.providerRetryAfterMs`（优先于退避）
L2 缩段重试：`stopReason === 'max-tokens'` → 该段输入×0.6 再试一次（只降一次）
L3 换模型：同 provider 的备用模型（cfg.modelFallback），参数不变
L4 纯静态检查：lint / typecheck / 单测（只读 sandbox，`subprocess`）→ 产出 `staticFindings`
        卡片明确标"AI 审查未完成，仅静态检查结果"，并把 verdict 锁为 comment
L5 完全失败：卡片标红"审查失败（原因）"，提供"重试"；写操作全部禁用
```
**不可重试**（直接 L4/L5）：`unauthenticated`（凭据失效）、`not-found`（MR 关闭/删除）、配额耗尽（`LlmFailure.status === 402/403` 且非限流）、schema 连续 2 次无法解析（说明模板/模型不匹配，需人工修模板）。

**降级必须"可见"**：`run.degraded = true` + `degradedReason` 存进结果与审计；面板、评论草稿、周报统计三处都展示，禁止静默降级。

### 6.6 预算护栏

| 护栏 | 默认 | 触发动作 |
|---|---|---|
| 每次运行成本上限 | `$0.35`（团队可调） | 预估超限 → 提示 + 需显式"仍要运行" |
| 每 MR 每日运行次数 | 6 | 超出 → 规则/定时触发暂停（手动仍可） |
| 团队每日总成本 | 可配 | 达 80% → 面板横幅警告；达 100% → 停自动触发 |
| 单次 diff 体积 | 5MB / 20k 行 | 超 → 强制骨架模式或拒绝并说明 |
| 缓存命中率（健康度） | ≥40% | 低于 → 面板提示"可能存在重复审查"（多为 headSha 抖动/模板版本频繁升级） |

---

## 7. 质量评估

### 7.1 指标定义

| 指标 | 定义 | 目标（P0 参考） | 采集 |
|---|---|---|---|
| **命中率 recall** | 在标注集中，AI 报出的 finding 命中"已知真问题"的比例 | ≥ 0.55 | 离线评测集 |
| **误报率 fpRate** | 被标 `falsePositive` 或被抑制的 finding / 全部 finding | ≤ 0.15 | 卡片反馈 |
| **采纳率 acceptRate** | `accepted` / 全部 finding | ≥ 0.45 | 卡片 verb |
| **采纳后落地率 adoptRate** | 采纳且确实改了（文件 hash 变化或对应行变更） / accepted | ≥ 0.70 | 与下一轮 `fixed` 交叉验证 |
| **忽略率 dismissRate** | `dismissed` / 全部 | ≤ 0.30 | 卡片 verb |
| **耗时 p50 / p95** | 从触发到结果可用 | p50 ≤ 45s，p95 ≤ 150s | `run` 记录 |
| **成本** | 每次运行 USD；每"被采纳 finding" USD | ≤ $0.35 / ≤ $0.9 | `TokenUsage` × 定价 |
| **覆盖率 coverage** | 已审文件 / 变更文件 | ≥ 0.90 | 分段器 |
| **降级率** | `degraded` run / 全部 run | ≤ 0.05 | run 记录 |
| **userVetoRate** | 人在 AI verdict=approve 时仍拒绝 / AI approve 次数 | 越低越好（>0.2 说明过于激进） | 卡片 + GitLab 状态 |
| **timeToFirstFinding** | 首条 finding 出现的时刻 | ≤ 25s | 流式帧 |

### 7.2 离线评测集

```jsonc
// evals/review-set.jsonl（每行一条用例）
{
  "id": "eval_0042",
  "repo": "group/app",
  "mr": { "iid": 1201, "title": "…", "headSha": "<frozen sha>", "baseSha": "<frozen sha>" },
  "fixture": { "diff": "fixtures/0042.diff", "conventions": "fixtures/0042.conv.md" },  // 冻结，不依赖网络
  "expected": [
    { "file": "src/auth/token.ts", "line": 88, "category": "concurrency",
      "mustMatch": ["竞态", "refresh"], "severityMin": "high", "note": "两请求同时刷新导致旧 token 覆盖新 token" }
  ],
  "allowed": [ { "file": "src/auth/token.ts", "category": "error_handling" } ],   // 报出来不算误报
  "forbidden": [ { "titleContains": "缺少 JSDoc" } ],                            // 报出来算误报
  "labels": { "labeledBy": ["alice", "bob"], "labeledAt": "…", "confidence": "high" }
}
```

**采集方式（三条腿）**
1. **生产回采**：卡片 `accepted` / `falsePositive` 的 run 自动进候选池（脱敏后），人工确认后入集。
2. **历史事故回填**：把"上线后出过 bug 的 MR"作为正样本（用 `revert`/hotfix 记录定位真问题），这是最有价值的样本。
3. **合成负例**：把"被标为误报"的 finding 反向构造成 `forbidden`。

**规模与配比（P0 目标）**：≥ 60 条用例；覆盖 9 个 category（每类 ≥ 4 条）；含 ≥ 10 条**空正例**（确实无问题，用于测 fpRate 与"敢于说没问题"）；含 ≥ 5 条 skeleton/oversized 用例测降级。

### 7.3 回归与门禁

- 每次改模板/schema/模型 → 跑评测集 → 产出对照表（recall / fpRate / cost / p50）。
- **门禁**：`recall` 下降 > 5pp 或 `fpRate` 上升 > 3pp → 阻止"设为默认模板"（仍可保存为实验版本）。
- 评测跑在**离线 fixture** 上（不依赖 GitLab 网络与当日 head），保证可重复；模型调用走同一 `agentOptions`。
- 评测结果与模板版本绑定存档（`evals/reports/<templateId>@<version>.json`），便于追责与 A/B 对照。

### 7.4 反馈闭环（人 → 模板 → 下次结果）

```
卡片 verb（采纳/忽略/误报/已修复/发布评论）
   │
   ├─▶ stats 聚合（acceptRate/fpRate/…）──────▶ 模板详情页趋势图
   ├─▶ 误报样本池 ──▶ ① 抑制候选（§2.7.3）② few-shot 负例（提示词"以下是本项目已知的误报类型…"）
   ├─▶ 采纳样本池 ──▶ few-shot 正例（"这类问题请这样表述"）
   └─▶ misjudged（AI approve 但事后 revert）──▶ 评测集 + 高危复盘
```
**闭环的克制**：只允许人把样本"提升"为 few-shot（不自动注入，避免提示词膨胀）；few-shot 上限 3 条（正/负各 3），超出按最近使用淘汰。每条 few-shot 计入模板版本（改 few-shot = version+1）。

---

## 8. 与 DSH 会话结合

### 8.1 一次审查 = 一次 Session（两种变体）

**变体 A（推荐，P0）：单会话 + 分段子代理**

```ts
// 1) 建审查会话（可持久化、可回看、可追问）
const handle = await ctx.agents.create({
  sessionId: newSessionId(),
  parentAgent: panelAgent,                       // 面板所属根 Agent（因果归属，非授权）
  meta: { cwd: repoPath, agentPreset: 'daily-work-review', origin: 'subagent', delegationDepth: 1 },
  agentOptions: { provider, model, reasoningEffort, maxTokens },
  setup: (agentCtx, agent) => {
    // 2) 只读化 + 审查专用提示词 section（仅本 preset scope 生效）
    agentCtx.effect(() => agentCtx.tools.restrict({ deny: WRITE_TOOLS }))
    agentCtx.effect(() => agentCtx.systemPrompt.section({
      name: 'daily-work:review-protocol', order: /* 见 getSectionOrder */ 0,
      text: '你处于只读审查模式……（输出必须符合 review-result@1）',
    }))
  },
})
// 3) 把渲染好的模板作为一条 user/message 投递（一次 turn 完成审查）
await ctx.subagents.startActivation({ /* 分段并行，见 §2.10 */ })
// 4) 结束后：Session 保留，面板可"继续追问"（再投递一条 user/message 即可）
```

- 为什么用 Session 而不是纯 `llm.stream`：**审计、追问、复现**三件事只有 Session 能给（`request/header` 记录模型与工具集，`tool/result.meta` 记录结构化结果，日志可导出）。
- 为什么分段用 subagent：`SubagentActivation` 有独立的 `childId`，每段一个可回看的子会话，且 `result.structured` 天然是校验后的对象；失败可精确 `interrupt`/重试。

**变体 B（轻量）：单会话单轮，不分段**（diff < 8k tokens）：直接一次 turn，成本最低；面板逻辑不变（`segments=1`）。

**追问（Follow-up）**：面板"追问"输入框 → `subagents.sendMessage`/`subagents.prompt`（面向子会话）或直接向审查会话投递 `user/message`（面向主会话）。追问继承完整上下文（含 diff 与 findings），因此**不需要**重新取数 → 追问成本 ≈ 仅新增 token。

**追问的边界**：追问不产生新的 findings（除非用户显式"重新审查"）；追问的产出是对话气泡 + 可选"升级为 finding"（人工点击 → 进结果集并重算 verdict）。

### 8.2 面板如何流式展示进度与结果

**服务侧**：一个 `@Remote({ mode: 'stream' })` 的 `follow(runId | sessionId)`，推送帧：

```ts
type ReviewFrame =
  | { type: 'stage';  stage: 'queued'|'collecting'|'packing'|'reviewing'|'post'|'done'|'failed'
      detail?: { segments?: number; file?: string; segmentIndex?: number
                 degraded?: boolean; reason?: string } }
  | { type: 'usage';  inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'delta';  segmentIndex: number; textDelta: string }        // 可选：模型正文流
  | { type: 'finding'; segmentIndex: number; finding: ReviewFinding }  // 逐条出现
  | { type: 'result'; review: ReviewResult; cardId: string }
  | { type: 'error';  code: string; message: string; retryable: boolean }
```
- 采用与 `forgePanel.follow` 相同的语义：**先当前态，再增量态；慢读者可跳过中间态**（不要假设"不丢帧"）。
- 取消：帧流 `signal` abort → 服务侧 abort 该 run（`SubagentActivation` 与模型请求随之取消），并保留已完成段的结果（部分结果也展示，标"已取消"）。

**UI 帧 → 面板区块映射**

| 区块 | 内容 | 数据 |
|---|---|---|
| 顶部状态条 | 阶段 + 进度（`第 2/4 段`）+ 用时 + 实时成本 | `stage`/`usage` |
| 结论卡 | verdict 徽标 + summary + confidence + **覆盖率与未覆盖清单** | `result` |
| 发现列表 | 按 severity 分组；每条折叠 evidence/why/fix；行号可点击 | 逐条 `finding` 增量追加 |
| 文件视图 | 变更文件树 + 每文件"已审/跳过/骨架"标记 | `packing` 帧 |
| 草稿箱 | 评论草稿（可编辑）+ 「复制」「发布（确认）」「作为回复发到讨论」 | `result.cardId` + `actionCards.view` |
| 动作条 | 采纳 / 忽略 / 误报 / 应用 patch / 打开 worktree / 重新审查（换模板/换模型） | `actionCards.act(verb)` |
| 审计抽屉 | 模板版本、模型、token、耗时、降级原因、本次禁用的工具、跳转原 Session | run 记录 |
| 追问框 | 输入 → 投递到该审查 Session | `subagents.sendMessage` |

**渐进式呈现的三条规则**
1. **不展示半成品结论**：`verdict` 只在 `post` 阶段后出现；此前只显示"审查中（已发现 N 条）"。
2. **发现可先出现**（最有价值的反馈），但**标注"未完成裁决"**，避免用户拿"部分结论"去审批。
3. **失败不静默**：任何 `error` 帧都要有可见的卡片状态 + 可操作的重试按钮。

### 8.3 回看与检索

- 面板"审查历史"读 `sessionController.list/search` + 插件索引（`repo+mrIid → runId/sessionId`）。
- 点开某次运行 → `agents.resume({resumeSessionId})` 冷恢复该会话（**只在需要时激活**，避免常驻开销）；恢复后所有历史消息与工具结果都可见。
- 跨 MR 的"这个文件最近被 AI 提过什么"：查插件索引（`file → findings`），不加载会话。

### 8.4 与面板其余部分的关系

- **输入**：MR 看板（`forgePanel.follow` 的 `ForgePanelState`）提供 `changeRequests`，审查层只消费，不复制其状态机。
- **输出**：审查结果作为一种"信号"反哺看板：MR 卡片显示 `AI: blocker×1 / high×2`、`上次审查 3 分钟前`、`head 已变更（结果过期）`。
- **与 `forgeSession` 绑定**：审查会话若由某 MR 触发，用 `forgeSession.track(session, url)` 把 MR 绑到该审查会话，从而 `forgePanel.follow(session)` 也能在这个会话里工作（面板内"边看 diff 边问 AI"）。

---

## 9. 数据落盘与配置

| 数据 | 载体 | 位置（相对工作区 / profile） | 备注 |
|---|---|---|---|
| 模板 | JSON 文件 | `<repo>/.dsh/review/templates/*.json`（L1）、profile 用户目录（L2） | 人可编辑、可 review、可 git 共享 |
| Action | JSON 文件 | `<repo>/.dsh/review/actions/*.json`、profile（L2） | 与模板同机制 |
| 仓库策略 | JSON | `<repo>/.dsh/review/policy.json`：优先级规则、categoryCaps、并发/预算、触发规则 | 面板"设置"页编辑 |
| 运行索引 | `storage`/`storageDomain` 或 JSON | `~/.dsh/daily-work/review-runs.jsonl`（append-only） | 索引即可，全文在 Session 日志 |
| 抑制列表 | JSON | `<repo>/.dsh/review/suppressions.json` | 团队共享，需 review |
| 反馈样本 | JSONL | `~/.dsh/daily-work/review-feedback.jsonl` | 脱敏后 |
| 评测集/报告 | JSON/JSONL | `<repo>/.dsh/review/evals/`（或独立评测仓） | 冻结 fixture |
| 凭据 | `credentials` | 系统凭据存储（**不在仓库**） | 只存 `CredentialRef` 名字 |

**配置校验**：所有 JSON 落盘前过 schema；非法配置**不生效**且面板标红（不能因为配置错就悄悄用默认值）。

**迁移**：`policy.json` / 模板带 `schemaVersion`；插件升级时按版本迁移，迁移前备份 `.bak`；不可迁移 → 保留原文件并停用（不删除用户数据）。

---

## 10. 落地清单与待确认项

### 10.1 P0（本阶段方案必须覆盖）

| # | 项 | 依赖契约 | 说明 |
|---|---|---|---|
| 1 | ReviewPipeline S0-S8 | `forge.watch/latest/diff`, `forgePanel.changeRequestDiff/changeRequestText`, `subagents.startActivation(outputSchema)`, `actionCards` | §2 全量 |
| 2 | 审查会话（变体 A/B） | `agents.create/resume`, `tools.restrict/guard`, `systemPrompt.section`(scoped) | §8.1 |
| 3 | 模板存储 + 渲染 + 版本 | 自有存储 + `outputSchemaId` 校验 | §3.1-3.4 |
| 4 | skill 互操作（导出/引用） | `skills.register/get`, `sessionSkillCatalog.list` | §3.5 |
| 5 | ActionRegistry + 8 个 Action | 模板 + `commands.register` + `actionCards` | §4.3 |
| 6 | 只读 + 确认 + 脱敏 | `tools.restrict/guard`, `approval.request`, `credentials` | §5 |
| 7 | 结果缓存 / 预算 / 降级 | `TokenUsage`、`tokenMeter`、`timer` | §6 |
| 8 | 面板流式帧 + 卡片落地 | `@Remote({mode:'stream'})`（与 `forgePanel.follow` 同范式） | §8.2 |
| 9 | Issue 轮询（自有客户端） | `credentials` + `timer` + 插件存储 | 缺口 G2 |
| 10 | 评论草稿（不发布即可用） | 自有 GitLab 客户端（只读渲染） | 缺口 G1 |

### 10.2 P1

- GitLab 评论**发布**与 review 提交（写 scope 凭据、`approval` + 双闸门）；
- commit-range 增量审查（自有 compare API）；
- webhook 触发（`webServer.register` + `webhookRuntime`）；
- 历史讨论读取（补齐 G5）、CI 失败摘要（补齐 G4）；
- 组织级模板集市（`skills.registerProvider` + 共享存储）；
- 离线评测自动化（CI 里跑 recall/fpRate 门禁）。

### 10.3 待确认项（本层已按最小假设设计，落地前需复核）

| id | 问题 | 当前假设 | 影响 |
|---|---|---|---|
| T1 | 插件能否 append `plugin:*` 命名空间 Session 事件（`forgeSession` 有先例） | 不能正式依赖 → 用 `tool/result.meta` + 自有存储 | 审计强度（仅影响"不可被模型改写"的强保证） |
| T2 | `sandboxPolicy` / `sandbox` 的只读配置形态 | 用 `tools.restrict` + 只读目录组合近似 | 只读强度 |
| T3 | `subagents` 默认 provider 是否声明 `outputSchema` 能力 | 声明 → 用 `structured`；否则 JSON salvage + 后校验 | 结构化输出可靠性 |
| T4 | `.dsh/skills/<name>/SKILL.md` 的 frontmatter 精确字段集 | 只依赖 `SkillSummary.{name,description,whenToUse}` | 导出格式 |
| T5 | 面板（Client）可用 Slot 与 `actionCards` 的渲染落点 | 由前端设计文档确定；本层只约定帧与 verb | UI 集成 |
| T6 | `forge` 是否会在后续版本加入 comment/review 写接口 | 视为不会 → 自有客户端 | G1 的长期维护成本 |

### 10.4 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 误报过多导致用户关掉功能 | 高 | fpRate 门禁 + 抑制列表 + 默认只显示 medium 以上（low/info 折叠） |
| 大 MR 成本失控 | 中 | 分段上限 + 骨架模式 + 预算闸门 + 缓存 |
| 模型编造行号/证据 | 中 | `evidence` 逐字核验（§2.6.3）+ 置信度惩罚 + UI"待核验"标 |
| 评论发布造成团队噪音 | 中 | P0 只出草稿；发布需确认；默认"汇总 1 条"而非逐条 |
| 凭据泄漏 | 高 | `credentials` 单向读取 + 日志脱敏 + 只存 ref |
| 依赖 forge 私有行为（head 缓存等） | 低 | 只依赖已文档化的方法与错误码 |
| 增量审查基线错乱 | 中 | 三条硬规则 + force-push/merge commit 检测（§6.4） |

---

## 附录 A · 枚举与常量（单一事实来源）

```ts
export const SEVERITIES = ['blocker','high','medium','low','info'] as const
export const CATEGORIES = ['correctness','boundary','concurrency','error_handling',
  'security','performance','readability','tests','compatibility'] as const
export const VERDICTS   = ['approve','comment','request_changes'] as const
export const OUTPUT_KINDS = ['findings','markdown','patch','json','text','none'] as const
export const POST_ACTIONS = ['gitlab-comment','gitlab-approve','gitlab-request-changes',
  'local-apply','open-worktree','clipboard','create-issue','publish-file','schedule-followup'] as const
export const VERB_WRITES = { copy:false, dismiss:false, mark_false_positive:false,
  schedule_followup:false, post_comment:true, post_review_summary:true,
  approve:true, request_changes:true, apply_patch:true, open_issue:true } as const
```

## 附录 B · 关键错误码与 UI 文案

| 来源 | 错误 | UI 展示 | 动作 |
|---|---|---|---|
| `forge` | `unauthenticated` | "无法访问 GitLab：凭据失效" | 跳凭据设置 |
| `forge` | `too-large` | "diff 过大，已切换为骨架模式" | 继续 |
| `forgePanel` | `diff-too-large` | 同上 | 继续 |
| `forgePanel` | `not-bound` | "该 MR 未绑定到当前会话" | 一键 `track` |
| `forgePanel` | `stale-head`（merge） | "head 已变更，请重新确认" | 刷新后重审 |
| `subagents` | `no-structured-output` | "模型未按格式输出（第 N 段）" | 重试该段 |
| `tools` | guard 拒绝 | "本次为只读审查，写操作被阻止" | 说明 |
| 预算 | `budget-exhausted` | "已达当日 AI 审查预算" | 提升额度 / 手动覆盖（记审计） |

## 附录 C · 与其他研究文档的接口

| 交给谁 | 内容 | 形式 |
|---|---|---|
| 面板/前端设计 | `ReviewFrame` 帧协议、卡片 details 结构、区块信息架构（§8.2） | 本文 §8 + 附录 A |
| 数据与轮询设计 | 审查调度所需的 MR 状态字段、`watch` 订阅点、Issue 轮询契约（§6.2、§10.1-9） | 本文 §1.1/§2.1/§6 |
| 最终整体方案 | 5 部件边界、契约表、缺口清单（§0/§1）、P0 清单（§10.1） | 本文全文 |
| Prompt/Skill 管理者 | 模板结构、变量表、skill 双向互操作（§3） | 本文 §3 |

## 附录 D · 与工作区参考实现（`research/refs/agent-autoloop`）的对照

> 该仓库是队友拉取的**参考实现**，不是本方案的依赖；此处只记录"互相验证"与"有意分歧"，供最终方案取舍。

**它验证了本方案的这些判断**

- 只读审查：其交付插件"只把裸 Git 对象变成文字快照"、审查在"保留快照只读沙箱"内执行 → 与 §5.1「默认只读」一致。
- 同一提交不重审：`examples/skills/ship-pr/SKILL.md` 写明"同一个提交不再审第二次；修复并推新提交后按新提交重审" → 与 §6.3 同 commit 缓存、§6.4 增量审查同构。
- head/main 变更即拒绝合并 → 与 §5.5-4「head 一变就禁用写操作」及 `forgePanel/merge` 的 `stale-head` 一致。
- 审查者独立性："只给它代码，不给作者的结论" → 与 §2.4.2 的「边界与禁忌」一致（只审改动、不采信作者自述）。
- `SKILL.md` frontmatter 实测只有 `name` + `description`（无 `whenToUse`）→ §10.3 的 T4 采用"只依赖 `SkillSummary.{name,description,whenToUse}`，缺失时降级为 `description`"，比依赖固定字段集更稳。

**有意分歧（及理由）**

| 点 | 参考实现 | 本方案 | 理由 |
|---|---|---|---|
| 审查排队 | "几个 PR 同时审，不排队" | 全局并发 2 + FIFO 队列（§6.2） | 本方案走用户自己的模型 token，成本与限流是真实约束；参考实现的审查后端是外部 Codex，成本不在中台 |
| 结论落地 | 写"审查状态"标签 + 回执 | 面板卡片 + 评论草稿（P0 不发布） | GitLab 侧没有统一的"审查状态"约定；草稿把"发不发"的决定权留给人 |
| 合并 | 交付插件按可信规则在检查通过后合并 | **AI 永不 approve/merge**（§5.5） | 规则驱动的合并与模型驱动的判断必须分开，模型结论只作为人的输入 |
| Issue 入口 | 标签 + `ask-owner` 问题卡片 | Issue 轮询 + 审查队列 | 复用面板形态；P1 再对齐"问题卡片"交互 |

**可直接借鉴的三条**：① "发现问题的提交不再审第二次"要写进 UI 文案与缓存提示；② 审查输入只给"代码快照 + 项目约定"，不给作者说明；③ 卡片回答必须核对"回答者 + 原消息"——与 `actionCards.act(agent, callId, verb, payload)` 的显式身份校验同构。

