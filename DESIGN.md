# 日常工作台 · DeepSeek Harness 插件整体功能设计方案

> 版本 v0.2（2026-11-08）：新增 §9「任务与自动化（可重复作业）」——定时 / 手动按钮 / 并行 / after 链；原 §9–§13 顺延为 §10–§14｜ 研究底稿：`research/01-platform.md`、`02-gitlab.md`、`03-workflows.md`、`05-ai-review.md`、`06-autoloop.md`｜ UX 规格：`research/04-ux.md` + 高保真线框 `design/panel-mockup.html`
> 本文是**设计方案**，不含实现代码，面向决策、排期与后续开发。

---

## 0. 一页结论

这个插件不是「再做一个 GitLab 客户端」，而是把「日常巡检 → 判断 → 处理 → 复盘」收进宿主里的一整页工作台：

- **后台按规则轮询**（GitLab 的待我审 MR、指派给我的 Issue、我提的 MR 的反馈/冲突/CI 失败；后续扩展到 CI、质量、需求、运维域），把结果收敛成**收件箱里的工作项**。
- 每条工作项都带 `reason`（为什么找我）与一组可执行动作：点一下可以「跳到 GitLab 处理」，也可以「就地让 AI 审查 / 起草评论 / 生成摘要」。
- **AI 动作跑成真实 Session**：左侧会话区可见、可回看、可追问；产出结构化 findings 与评论草稿；**任何写操作（发评论、批准、合并）都必须人工确认**，AI 只产出建议。
- **可重复作业也是一等公民**：定时（cron）、手动按一下、并行（fan-out + 并发上限）、以及「某个作业或事件完成后再跑」的 after 链，都在「任务与自动化」页里配置与运行（见 §9）。GitLab 审查只是其中一个 Job。
- **提示词与技能在面板里可视化管理**：模板带变量、版本、适用范围与统计，并可导出为宿主 skill / 引用宿主 skill，不另造技能体系。
- **调度语义借鉴 agent-autoloop**：事件 → 规则 → 一轮 → 卡片 → 回执，带幂等去重、同事项合并、并发上限、跳数熔断与只追加审计。

三条硬结论（来自平台与契约取证，决定架构走向）：

1. **整页大面板是官方路径**：`sidebar.panellist`（侧栏图标槽）+ keyed `main`（整页面板槽，key 任意字符串）+ `ctx.layout.selectPanel(id)`。面板 id 建议 `daily-work-hub`（同时用作 `main` 的 key 与 `sidebar.panellist` 的 id，与包名一致），图标工厂能拿到 `{size, active}`，可自绘未读徽标。
2. **宿主 forge 不够用**：它只有 MR 的 `diff / fileText / markReady / merge`，**没有**「列出待我审的 MR」、**没有** Issue、**没有** 评论/批准/审查写接口，也**没有** commit-range diff；且当前安装里没有任何 forge provider 包。所以 **P0 必须自带 GitLab REST 客户端**，注册 ForgeProvider 放到 Phase 2 作为「让宿主 forge 面板也能用」的增强。
3. **客户端是 plain-JS bundle**：`@Remote`/typert 需要构建期生成，**不可用**；Host↔Client 走插件自注册的 HTTP 路由（`webServer.register` / `connection.fetch.register`），刷新首选 2–5s 轮询 + ETag，SSE 作为可选优化。

---

## 1. 背景、目标与非目标

### 1.1 用户现状（要解决的问题）

用户是软件开发者，日常在 GitLab / CI / 需求系统之间手工巡检：先看有没有人提交了需要自己审的 MR、有没有指派给自己的 Issue、自己提的 MR 有没有反馈或 CI 挂了；判断「这事归不归我」；然后开网页、读 diff、写评论；需要更细的检查时，自己复制上下文去问大模型。整个过程是**多次切换 + 重复劳动**，且容易漏。

### 1.2 目标（P0 可验收）

| # | 目标 | 验收方式 |
|---|---|---|
| G1 | 配置一次 GitLab（实例地址 + PAT + 范围）后，**定时自动发现**待办：待我审的 MR、指派给我的 Issue、我提的 MR 的新反馈/冲突/CI 失败 | 面板收件箱出现新条目；断网/无效 token 有明确报错 |
| G2 | 收件箱**一眼看懂优先级**：按 `reason` 分组、未读点、状态徽标、CI/审批摘要 | 15 分钟内可清空一轮收件箱 |
| G3 | 点一条能**看到 MR 全貌**：描述、分支、合并状态、CI、审批、双栏 diff、讨论线程 | 不用离开面板即可判断「要不要审」 |
| G4 | **一键 AI 审查**：起一个真实 Session，流式产出结构化 findings（文件/行号/严重度/证据/建议） | 会话区可回看、可追问；结果带 `computedForHead` |
| G5 | **一键跳转处理**：跳到 GitLab 对应页面，或就地起草评论/回复；写操作前必须确认 | 第 1 次使用即可完成「审完并评论」 |
| G6 | 提示词/技能**可视化管理**：新增、编辑、变量、版本、启用、绑定到动作 | 改完模板立即在下一次审查生效 |
| G7 | 工作项**状态机**：未读/已读/忽略/snooze/归档，远端状态变化可自动收口且可撤销 | 误收口可一键恢复 |

### 1.3 非目标（P0 明确不做）

- 不做 GitLab 的完整替代客户端（不做出题、不写 issue 详情编辑、不做 CI 配置管理）。
- **不做 AI 自动 approve / 自动 merge**（误批准不可逆；只产出建议与评论草稿）。
- 不做公网 webhook 接入（本机场景没有可达公网地址；P0 用轮询，webhook 为 P2 可选）。
- 不接第二个数据源（GitHub/Jira/监控等）——先把 GitLab 一条链路打磨到「4 个 MR / 1 小时」。
- 不改宿主既有 UI（不动会话区、不改设置页结构），只在 `sidebar.panellist` 与 `main` 里增加自己的面板。
- 不自建技能体系、不自造会话存储、不自造审批 UI（复用宿主 `skills` / Session 日志 / `approval` / `actionCards`）。

### 1.4 成功标准（三个月视角）

1. 每天早上第一条动作是打开这个面板，而不是 GitLab 右上角。
2. 收件箱条目 **0 漏**（与 GitLab To-Do 对账一致），且**误收口率 < 1%**。
3. AI 审查的 findings **采纳率 ≥ 30%**（人工点「加入评论」或按建议修改），单次审查 P95 ≤ 90s。
4. 面板常驻内存增量可忽略（空闲 < 5MB RSS），轮询不造成明显抖动。

---

## 2. 核心概念模型

借鉴 agent-autoloop 的「三张门 + 一份只追加日志」，但按「有面板」的形态补链条：**来源推进来 → 规则决定怎么处理 → 一轮交给 AI → 卡片请人拍板 → 回执落账**。

### 2.1 实体

| 实体 | 定义 | 谁产生 | 生命周期 |
|---|---|---|---|
| **Source** | 一个外部数据源实例（`gitlab:gp`），带凭据引用、范围与轮询游标 | 用户在设置页添加 | 配置级；游标持久化 |
| **Event** | 世界发生的一件事实：`id / type / subject / summary / detail / link`，**不含** `cwd / agent / access` | Source 适配器 | 去重后入库，保留 30 天 |
| **WorkItem** | 面板上的「一条待办」，由 `(source, subject)` 聚合并带本地状态机 | 规则归并 Event | `unread → read → snoozed / done / archived`，可撤销 |
| **Rule** | 「什么事件 → 归到哪类工作项 → 是否派 AI → 提醒谁」 | 用户在内置规则库/面板里维护 | 版本化，改动写审计 |
| **Turn** | 一次实际执行（一次 AI 审查、一次批量摘要），对应一个 DSH Session | 面板动作或规则触发 | 一轮会结束，WorkItem 继续 |
| **Card** | 需要人拍板的最小单元：`ask`（带选项）/ `notice`（通知）/ `resolve` / `later`（约复查） | Turn 的回执 | 未决 → 已决；回答必须核对「谁答的、答的哪条」 |
| **Receipt** | Turn 的最后一条结论，结构化 payload（findings 数组等），一个事务里一次生效 | Turn | 不可变；重写只允许改写结论，不重做业务 |
| **Audit** | 只追加事实日志：派发、执行、确认、写操作、失败原因 | 内核式服务 | 只增不改；`why(turnId)` 可回放 |
| **Action** | 对 WorkItem 可执行的一次操作（审查、摘要、起草评论、跳转、忽略…） | 面板与规则共用 | 无状态；由 `ActionDefinition` 描述 |
| **Template** | 提示词模板：角色、检查清单、变量、输出格式、适用项目/路径、模型参数、版本 | 用户 | 版本化；可导出为 skill |
| **SkillRef** | 对宿主 skill 的引用（名称 + 作用域），用于「用现成技能作为审查方法」 | 用户选择 | 跟宿主 skill 生命周期 |
| **Job** | 可重复作业的定义：Trigger × Executor × Output × Policy（见 §9） | 用户在「任务与自动化」新建 | 版本化；可单独停用 |
| **Run** | Job 的一次实际执行（= 一个 Turn），带参数、状态、耗时、token、产物 | 手动 / cron / 事件 / 上游 Job | `queued → running → succeeded / failed / interrupted / cancelled` |
| **Trigger** | 「什么时候跑」的声明：`manual / cron / event / after / webhook` | Job 或 Rule 持有 | 跟随所属对象 |

### 2.2 三条不变量（比功能更重要）

1. **文字是资料，规则才是指令。** MR 标题/描述/diff/评论、Issue 正文都是**资料**：进入 Session 时只作为资料文件（如 `context.json` / 附件）与**校验过的字段**（`subject` 只允许 `[A-Za-z0-9#._:/@-]`，`link` 只允许纯 ASCII URL）出现；**不得**拼进提示词正文，**不得**影响派给哪个 Agent、在哪个目录、用什么权限。事件结构里没有这三个字段，带了直接拒收。
2. **一轮一个 capability。** 每个 Turn 有自己的、只对本次执行有效的令牌（面板内部用 HMAC 派生即可），不复用面板会话凭据；Token 不跨轮次。
3. **状态可重建。** 面板只读「投影」，投影全部由只追加的 Audit 日志算出；崩溃/升级后从日志重建，不做数据迁移。

### 2.3 与宿主概念的映射（不重复造轮子）

| 我们 | 宿主对应 | 关系 |
|---|---|---|
| Turn（一次审查） | `agents.create()` 出的真实 Session | 一一对应；面板绑 `sessionId`，可跳到会话区追问 |
| Card（拍板） | `actionCards` 的 kind + `verb`（`writes: true` 强制确认） | 卡片渲染与决策记录复用宿主；我们只注册 kind 与 verbs |
| Action（工具侧） | `tools.register()` 的同名工具 + `commands.register()` 的斜杠命令 | **一个操作、三种调用方**（面板 / 工具 / 命令）共用同一 Host 方法 |
| Template / SkillRef | `skills` + `sessionSkillCatalog` | 模板是结构化数据，skill 是它的导出视图；也可反向引用现有 skill |
| 定时 | `ctx.timer`（后台轮询）+ 面板内的「静默时段」 | **不用** `schedule`（它绑定真实会话、把提醒投进 inbox，不适合全局多来源轮询） |
| 凭据 | `credentials` + `credentialsController` | PAT 只进凭据服务，日志与会话里一律脱敏 |
| 审计 | 我们自己的只追加日志 + Session 日志 | 业务审计在插件；模型可见的过程在 Session 日志 |

---

## 3. 整体架构

### 3.1 分层

```
┌──────────────────────────── Client（plain-JS bundle，main 槽整页）────────────────────────────┐
│  sidebar.panellist 图标(含未读徽标)   →  ctx.layout.selectPanel('daily-work')                │
│  main['daily-work']：收件箱 / 详情 / 提示词管理 / 设置    ← 轮询 /api/daily-work/*（ETag）      │
└───────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                            │ HTTP（自注册路由，PeerScope 鉴权）
┌───────────────────────────────────────────▼──────────────────────────────────────────────────┐
│ Host 插件（apply(ctx, config)）                                                               │
│  ① GitLabAdapter    REST 客户端：采集(list MR/Issue) + 读取(diff/discussions) + 写入(notes/approve)│
│  ② Poller           ctx.timer 调度；每源游标、退避(5min→1h)、并发上限、失败计数                 │
│  ③ WorkItemStore    事件去重 / 同 subject 合并 / 状态机 / 投影 / 只追加审计（storageDomain）      │
│  ④ ReviewRunner     取数→裁剪分段→渲染模板→起 Session(或 subagent 分段)→后校验→落卡片          │
│  ⑤ Tools/Commands   dailywork.list / .review / .comment / .snooze …（与面板共用同一实现）        │
└───────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                            │
        ┌───────────────────────────────────┼───────────────────────────────────┐
        ▼                                   ▼                                   ▼
   ctx.agents.create                    ctx.tools.register                ctx.storageDomain
   （真实 Session 审查，可追问）           （Agent 也能操作同一批工作项）         （工作项/模板/审计）
```

### 3.2 Host 侧职责边界

- **GitLabAdapter**：只做「说什么」——端点、字段、分页、限流、错误码归一。**不做**调度与状态。
- **Poller**：只做「什么时候问」——按源与数据类分配预算，带 `updated_after`/ETag 增量、指数退避、连续失败 10 次停手并出卡片告警。**游标只在上交成功后推进**（否则会漏事件）。
- **WorkItemStore**：只做「这算不算一件事、归谁」——事件去重（`source + id`）、同 `subject` 合并成一轮、`reason` 计算、状态机与投影、审计追加。
- **ReviewRunner**：只做「怎么让 AI 干这一轮」——组装上下文（资料文件，非提示词正文）、分段、起 Session / 分段用 subagent 并行、后校验、把结果写成 Card。
- **JobScheduler**：只做「什么时候跑」——`ctx.timer` 30s tick、`nextRunAt`、事务加锁、幂等键、`catchUp`、重启恢复。**不碰业务逻辑**。
- **JobRunner**：只做「这一次怎么跑」——解析 Job → 校验参数 → 并发/lane 排队 → 起 Session/headless/command → 收产物 → 落 Artifact/Card → 记审计。
- **Tools/Commands**：只做「让 Agent 也能用」——与面板调用同一个 Host 方法，返回同一套错误码。

### 3.3 Client 侧（面板）

- 一个 bundle 里注册两处：`sidebar.panellist`（图标 + 未读徽标，工厂收 `{size, active}`，徽标由组件自绘）与 `main`（`key: 'daily-work-hub'`，整页）。
- 面板内部**自管三个视图**（收件箱 / 详情 / 提示词与设置），不引入 router；用 URL hash 或面板内状态记忆上次位置（`localStorage`）。
- 样式只用 `--dsw-alias-*` 主题 token；不 import 任何 Harness Client 包；不写 `document.body`。

### 3.4 数据通道

| 路由 | 方法 | 用途 | 刷新策略 |
|---|---|---|---|
| `/api/daily-work/state` | GET | 面板首屏：源状态、未读数、分组计数、视图定义、版本号 | 打开面板时 + 30s |
| `/api/daily-work/items` | GET | 列表分页（`reason`/项目/状态/游标参数） | 2–5s 轮询 + `ETag`/`If-None-Match` |
| `/api/daily-work/item/:key` | GET | 详情：MR 元信息、diff 摘要、讨论、历史 findings | 进入详情时 + 手动刷新 |
| `/api/daily-work/actions` | POST | 执行一个 Action（`review` / `comment-draft` / `snooze` / `archive` / `confirm-write`） | 即时；长任务返回 `turnId` 后由前端订阅进度 |
| `/api/daily-work/turn/:id` | GET | 轮次进度与结果（可选 SSE 替代） | 1s 轮询或 SSE |
| `/api/daily-work/templates` | GET/POST | 模板 CRUD | 即时 |
| `/api/daily-work/jobs` | GET/POST/PATCH | Job 库 CRUD、启停、试跑（dry-run） | 即时 |
| `/api/daily-work/runs` | GET/POST | 起一次 Run（手动/带参数）、取消 | 即时；`POST` 返回 `runId` |
| `/api/daily-work/runs/:id` | GET | 运行进度、日志尾、产物、token | 1s 轮询（运行中） |

约定：所有响应带 `etag` 与 `revision`；写请求必须带 `X-DW-Confirm: <cardVersion>`（写操作人工确认的服务端二次校验）。

**挂载与鉴权（契约已核）**：Host 侧用 `ctx.connection.fetch.register({ path, methods, requestBody, fetch })` 注册精确路由（方法限于 `GET/HEAD/POST`，`requestBody: 'buffered' | 'streaming'`），由 `connection.createSharedFetchHandler('/api')` 组装到 `/api` 通道；也可以 `webServer.register` 自建路由，在入口调 `connection.requestRejection(request)` 拿 `401/403` 判定，再用 `connection.admit(...)` / `connection.browserPeer` 取 `PeerScope` 做「谁在点」。客户端侧**不能**用 `ctx.remote.*`，直接 `fetch('/api/daily-work/...')`（同源、带浏览器凭据）。?待实测：Desktop 宿主下 `dsh-app://` 页面与该路由是否共享凭据/cookie。

### 3.5 存储与凭据

| 数据 | 位置 | 理由 |
|---|---|---|
| PAT / 多实例凭据 | `credentials`（`gitlab:<instance>`） | 只在 Host 侧解析，不落面板、不进日志 |
| 实例地址、范围（组/项目）、轮询间隔、静默时段、模型与并发 | 插件 `Config`（`cordis.patch.yml`） | 设置页自动出表单；用户 patch 层在升级中保留 |
| 工作项、模板、审计、游标 | `storageDomain`（`daily-work` 域） | 事务化、可重建；不写宿主 Session 事件类型 |
| UI 偏好（上次视图、列宽、折叠） | 客户端 `localStorage` | 纯展示态，不需要跨设备 |

### 3.6 AI 执行通道（两条，主备）

1. **主：进程内真实 Session** —— `ctx.agents.create({ sessionId, meta:{cwd?}, agentOptions, setup })`，`setup` 里注入审查指令与工具白名单，然后 `agent.followup()` 唤醒；面板订阅 `turn/:id` 拿流式进度。优点：会话区可见、可追问、审计天然落在 Session 日志。
2. **备：`dsh headless --json` 子进程**（借鉴 agent-autoloop 的 `plugins/dsh`）——`--permission-mode read-only --approval-policy never --session-id <id>`，按行解析 `session / status.step_end / final`，用它做「批量、互相隔离、不占面板会话」的重活。仅在进程内路径不够（如需要独立权限域/独立重试域）时启用。

### 3.7 工具化：一个操作，三种调用方

| 操作 | 面板 | Agent 工具 | 斜杠命令 |
|---|---|---|---|
| 列出工作项 | 收件箱 | `dailywork_list` | `/dw list` |
| 审查一条 | 详情「AI 审查」 | `dailywork_action{action:review,key}` | `/dw review <key>` |
| 起草/发布评论 | 详情「加入评论」 | `dailywork_action{action:comment}` | `/dw comment <key>` |
| 状态变更 | 已读/忽略/snooze/归档 | `dailywork_action{action:state}` | `/dw snooze <key> 1h` |

实现上三者都调用**同一个 Host 方法**，返回同一套 `{ok, code, message, data}`；写操作在工具侧同样需要人工确认（`approval` / `actionCards.verb.writes`），不能绕过。

---

## 4. 大面板设计

面板是整页（占满 `main`），不是浮层；视觉与宿主一致（同一套 token、字号、圆角、行高）。线框见 `design/panel-mockup.html`（4 个 1440×900 画板：收件箱+详情+AI 抽屉 / 审查队列批量 / 提示词与技能 / 设置）与 `design/panel-jobs.html`（第 5 画板，2 屏：任务库+运行历史 / 新建任务表单）。默认深色，跟随宿主主题切换。

### 4.1 一级导航与布局

- **左窄栏（220px）**：七个入口 —— 收件箱、审查队列、我的工作、项目、**任务与自动化**、提示词与技能、设置。带计数徽标（未读 / 待我审 / 运行中任务 / 失败的轮次）。
- **主区三栏**：列表（380px，可折叠）＋ 详情（自适应）＋ **AI 抽屉**（右侧 404px，可整屏）。
- **两栏模式**（<1240px）：列表占满、详情以整列覆盖并带返回；<900px 导航折为顶部下拉。AI 抽屉变全屏 sheet。
- 顶部工具条：面包屑、过滤器 chips、视图切换（列表/看板）、刷新与「暂停轮询」。

### 4.2 收件箱（列表）

每条工作项一行，信息层级固定（缺数据留空位，不重排）：

```
[☐] ● [MR] feat: 订单幂等校验                     gp/order-service
        review_requested · 作者 zhang · +128 −42 · CI ✓ · 待审批 0/2 · 2h
```

- **`reason` 是第一等字段**，直接决定分组与可用动作：`review_requested`（待我审）/ `assigned`（指派给我）/ `authored`（我提的）/ `mention`（@我）/ `conflict` / `ci_failed` / `changes_requested`（要我改）。
- **状态与生命周期分离**：`localState ∈ {unread, read, snoozed, done, archived}` 与 `remoteState ∈ {open, merged, closed}` 独立；远端已合并/关闭 → 自动收口（可撤销），但「只有 `updatedAt` 变了」**不许收口**（白名单化）。
- 过滤器：来源、项目、类型（MR/Issue）、reason、仅需我审、我提的、CI 失败、已 snooze；可**保存为视图**（数据不是代码，最多 15 个）。
- 分组：按项目 / 按 reason / 按优先级（`reason` 权重 × CI 状态 × 等待时长）；组头显示条数并可折叠。
- 批量：勾选后统一 已读 / 忽略 / snooze / 归档；**永不提供「批量发布评论 / 批量 approve」**。
- 排序默认「Recommended」：待我审 > 要我改 > 冲突 > CI 失败 > 指派 > @我 > 我提的；同权重按等待时长。

### 4.3 详情视图

- **概览区**：标题、作者、分支 → 目标分支、`+adds/−dels`、合并状态、审批进度、CI 汇总（点击跳该 pipeline）、标签、里程碑、`headSha`（短）。
- **diff 区**：左文件树（190px，含变更类型与增删行数）＋ 右双栏 hunk；行号可点；支持「仅看未读文件」「隐藏生成代码」（`*.lock`、`dist/**`、`*.min.js`）。超大 diff 降级为「文件清单 + 单文件按需加载」。
- **讨论区**：讨论线程按文件/行号归位；未解决线程置顶并计数；可折叠 resolved。
- **AI 审查抽屉**：
  - 顶部状态：`idle / running / done / failed`，显示 `computedForHead`（与当前 head 不一致则整体标 `stale` 并禁用写操作）。
  - 结论卡：`verdict`（`approve-suggested / comments-only / request-changes-suggested`）+ 风险分级（blocker/high/medium/low 计数）+ 置信度。
  - findings 列表：`severity`、`file:line`、一句话结论、**证据**（引用 diff 片段）、建议修法；每条可「加入评论」「忽略（记入误报）」「跳转到文件」。
  - 追问输入框：直接续在当前 Session 里问（不新起 Session）。
  - 底部：「生成评论草稿」→ 预览 → 「发布到 GitLab」（需确认）。
- **一键动作层级**（明确三种「跳」）：
  1. `打开 GitLab 页面`：客户端 `window.open(url)`（无系统浏览器 Host 服务；失败时复制链接并提示）。
  2. `在面板内处理`：切到详情 / diff / 起草评论。
  3. `起一个 AI 会话`：新 Session，或续在当前会话（默认新 Session，避免污染）。

### 4.4 提示词与技能管理

- 列表：名称、适用范围（全局/项目/路径 glob）、版本、最近使用、采纳率、启用开关。
- 编辑器：分段结构（角色 / 检查清单 / 上下文装配 / 输出格式 / 自检），变量插入（`{{mr.title}} {{mr.diff}} {{files}} {{project.conventions}}`）与高亮，右侧「预览渲染结果（脱敏）」。
- 试跑：选一条历史 MR（只读上下文）跑一次干跑，产出 findings 但不发任何写请求。
- 版本：每次保存生成新版本，可对比、可回滚；历史轮次记录 `templateVersion`，便于回溯「为什么这次审得不一样」。
- 技能互操作：「导出为 skill」（生成 `SKILL.md` 到工作区/技能目录）、「引用现有 skill」（作为审查方法或检查清单来源）。**不复制**宿主技能体系。

### 4.5 设置与首次引导

- 设置页四块：**GitLab 连接**（实例地址、PAT 输入即验、作用域说明、测试连接）、**采集范围**（组/项目多选、增量窗口）、**节奏**（轮询间隔、静默时段、并发上限、失败告警阈值）、**AI**（默认模型、审查并发、只读/可写边界、评论前确认开关——默认开）。
- 首次引导 3 步：填连接 → 选范围 → 看到「第一屏收件箱」（含 1 条示例/真实条目）。

### 4.6 交互与快捷键

`j/k` 上下移动 · `Enter` 打开 · `Esc` 返回/关抽屉 · `e` 归档 · `s` snooze（1h/4h/明早） · `a` AI 审查 · `c` 起草评论 · `r` 刷新 · `⌘K` 命令面板（切视图、跳项目、执行动作）。
未读规则：新条目 → 未读点 + 面板图标徽标 + 可选桌面通知（默认关，避免打断）。

### 4.7 视觉、可访问性与降级

- 只用 `--dsw-alias-*`（状态色、diff 增删底色、边框层级）；字号 12/13/14，行高 20–22；圆角 8/12；密度可切「紧凑/舒适」。
- 键盘可达、`:focus-visible` 环；语义化 `role="list"/"listitem"`、`aria-checked` 开关；对比度遵循宿主。
- 降级：轮询失败 → 顶部黄条「上次成功 3 分钟前」；token 失效 → 红条 + 「去设置」；远端 404/权限不足 → 条目级错误态，不整页报错。

---

## 5. P0 主链路：GitLab MR 审查闭环

这条链路是全插件的「标准件」。P0 只把它打磨到「4 个 MR / 1 小时」，其余功能都按同一套抽象挂上来。

### 5.1 采集：最小端点集（12 条）

| 用途 | 端点 | 关键参数 / 字段 | 备注 |
|---|---|---|---|
| 身份 | `GET /user` | `id / username / name` | reviewer 过滤与「是否我作者」的基准 |
| 令牌自检 | `GET /personal_access_tokens/self` | `scopes / expires_at / active` | 启动时做健康检查，过期前 7 天告警 |
| 范围 | `GET /projects?membership=true&simple=true` | `per_page=100` + `X-Next-Page` | 设置页的项目多选来源 |
| **待我审 MR** | `GET /merge_requests?scope=reviews_for_me&state=opened` | `order_by=updated_at&sort=desc` | **主查询**；不要用 `reviewer_username=me`（文档无 `me` 别名） |
| 收件箱补充 | `GET /todos?state=pending` | `action_name ∈ {review_requested, approval_required, directly_addressed, assigned, unmergeable}` | 补齐 CE 拿不到审批规则的缺口 |
| MR 详情 | `GET /projects/:id/merge_requests/:iid` | `detailed_merge_status / draft / prepared_at / blocking_discussions_resolved / diff_refs` | `merge_status` 已弃用，优先读 `detailed_merge_status` |
| 变更 | `GET .../diffs?page=&per_page=` | `diff / new_path / old_path / new_line / generated_file / collapsed / too_large` | `/changes` 已弃用（15.7），一律用 `/diffs` |
| 版本 | `GET .../versions` | 版本序列 | 用来判断「这轮审查之后 head 是否又变」 |
| 审批 | `GET .../approvals` | `approved / approved_by / user_can_approve / approvals_left` | CE 字段少，缺失即降级为二值 |
| 讨论 | `GET .../discussions` | `notes[].position{new_path,new_line}`、`resolvable`、`resolved` | 未解决线程数与行内定位来源 |
| CI | `GET .../pipelines` | `status / sha` | CI 只作**信号**（不拉日志） |
| 文件原文 | `GET /projects/:id/repository/files/:path/raw?ref=` | — | 补 diff 之外的上下文（如被截断文件） |

**增量策略**：GitLab REST **没有 ETag/If-None-Match**，所以用「`updated_after` + 每源 `updated_at` 水位 + head SHA 指纹」三重判断；`GET /events` **不能**用于 MR 收件箱（文档明确不返回 MR 事件）。

**能力探测优于版本判断**（同一版本因 CE/EE/feature flag 表现不同）：先试 `scope=reviews_for_me`，失败回退 `reviewer_username=<我的 username>`，再失败回退「我参与过的 MR」；`approval_state`（Premium/Ultimate）404 就关闭 code-owner 识别；`detailed_merge_status` 缺失就用 `merge_status + has_conflicts + draft` 自行推导。

### 5.2 归并、去重与状态机

- **事件去重**：`source + id`（GitLab 侧优先用 `idempotency-key`，没有就用 `sha256(关键字段)`）只记一次。
- **工作项聚合**：`(source, subject)` 唯一，`subject = <项目路径>#<iid>`；同一事项在排队期又来新事件 → **合并成一轮**，不新建 Turn。
- **`reason` 计算**（第一等字段，决定分组与动作白名单）：

| reason | 判定 | 默认动作 |
|---|---|---|
| `review_requested` | `reviewers` 含我，或 todo `review_requested` | 审查 / 忽略 / snooze |
| `approval_required` | `approvals_left` 含我，或 `approval_state` 规则命中我 | 审查 / 批准（需确认） |
| `changes_requested` | 我提的 MR 被要求修改 | 查看评论 / 起草回复 |
| `conflict` | `detailed_merge_status ∈ {conflict, cannot_be_merged}` | 查看冲突 / 起草解决建议 |
| `ci_failed` | `pipelines` 最新状态 failed | 看失败摘要 / 起 AI 定位 |
| `mentioned` | 讨论里 `@我` | 回复草稿 |
| `authored_feedback` | 我提的 MR 有新评论/新审批 | 查看 / 回复 |

- **状态机**：`localState ∈ {unread, read, snoozed, done, archived}` 与 `remoteState ∈ {open, merged, closed}` **分离**。
- **自动收口白名单**（误收口是最高信任风险）：仅当**显式**远端状态变化才自动 `done` —— MR `merged/closed`、我 approve 过、我评论过且线程已 resolve、todo 被 GitLab 自身清掉。**「只有 `updatedAt` 变了」禁止收口**。收口带 `undo`（保留 7 天）。

### 5.3 一键 AI 审查：12 步时序

| # | 步骤 | 实现 | 备注 |
|---|---|---|---|
| 1 | 面板点「AI 审查」 | `POST /api/daily-work/actions {action:review, key}` | 前端立即置 `running` |
| 2 | 校验 | 取工作项与 `headSha`；若已有本轮结果且 head 未变 → 直接展示 | 幂等 |
| 3 | 取数 | Adapter 拉详情 + `/diffs`（分页）+ approvals + discussions + pipelines | 失败按 5.5 降级 |
| 4 | 组装资料 | 写「资料文件」：`mr.json`、`diff.patch`、`discussions.json`、`conventions.md` | **文字只进资料，不进提示词正文** |
| 5 | 裁剪分段 | 按 `tokenMeter` 预算切段；优先级：核心逻辑 > 配置 > 测试 > 生成代码；超大 diff 走「文件清单 + 单文件按需」 | 分段可并行 |
| 6 | 渲染模板 | `Template` + 变量（只校验过的字段与资料**文件路径**） | 模板版本记入审计 |
| 7 | 起 Session | `ctx.agents.create({ sessionId, meta, agentOptions, setup })` 注入审查指令与只读工具白名单，`agent.followup()` 唤醒 | 主通道；`meta.cwd` 缺省行为 ?待实测 |
| 8 | 分段并行（可选） | `subagents` + `outputSchema`（窄 JSON Schema 子集）逐段产出 | 只读、隔离 |
| 9 | 结构化 | 模型产出 `ReviewResult`；schema 表达不了的（行号范围、路径存在性、证据逐字可核验、verdict 与 findings 一致）**代码后校验**，不合格重试一次 | 见 6.2 |
| 10 | 聚合去重 | 合并分段结论、压制历史误报、与上一轮 diff 比较 | 纯工程，不花 token |
| 11 | 落卡片 | `actionCards` kind `daily-work/review`，verbs：`add-comment`（writes）/ `approve`（writes）/ `dismiss` / `ask` | 写 verb 强制确认 |
| 12 | 审计 | 追加 Audit：模板版本、模型、分段数、usage、耗时、`computedForHead` | `why(turnId)` 可回放 |

### 5.4 写操作（默认只出草稿，人工确认才发）

| 动作 | 端点 | 要点 |
|---|---|---|
| 发表评论 | `POST /projects/:id/merge_requests/:iid/notes` | 正文 Markdown；**先出草稿**，确认后发 |
| 行内评论 | `POST .../discussions` + `position` | `position = {base_sha, start_sha, head_sha, position_type: text, new_path, new_line}`（`old_line` 用于删除行） |
| 解决线程 | `PUT .../discussions/:id?resolved=true` | 只解决自己发起的线程，默认不碰他人线程 |
| 批准 | `POST .../approve` | **仅人工**；AI 不得调用；`headSha` 变了就禁用 |
| 要求修改 | 发表评论 + 不给 approve | 用评论表达，不伪造审批状态 |

- **限流**：note/discussion 创建在 GitLab.com 是 **60 次/分钟**，且**不出现在 `RateLimit-*` 头里** → 本地令牌桶（保守 30/min）+ 批量发布拆批。
- **双令牌策略（推荐正式版）**：只读 token（`read_api + read_user + read_repository`）负责轮询与渲染；写 token（`api`）**只在确认写操作的那一刻才取出**。这样即使插件被诱导，也不会在后台静默写入。
- **确认协议**：写请求必须带 `X-DW-Confirm: <cardVersion>`，服务端校验「同一卡片、同一 head、由本人触发」，否则 409。

### 5.5 失败与降级

| 场景 | 表现 | 对策 |
|---|---|---|
| `prepared_at == null` | diff/CI 是半成品 | 本轮跳过，下轮再取 |
| diff 过大 / `too_large` | 单文件无法取 | 降级「文件清单 + 摘要」，审查只覆盖可取部分并**明示覆盖范围** |
| CE / 免费版 | 无 `approval_state`、无 `approvals_left` | 关 code-owner 识别，用 reviewer + todos |
| 429 / 限流 | 写操作 429 或 `/todos` 限流 | 指数退避（5min → 1h 封顶），连续 10 次停手并出卡片 |
| 令牌过期 / 403 | 启动自检失败 | 红条 + 去设置；不静默重试 |
| 网络不可达 | 列表空但游标未推进 | 顶部黄条；**游标只在上交成功后推进** |

### 5.6 对账与指标（可验收）

- **漏项对账**：面板条目数 vs GitLab To-Do 数，每日一次比对，差异 > 0 就要解释（这是「0 漏」的唯一硬证据）。
- **误收口率**：自动收口中被人「撤销」的比例，目标 < 1%。
- **审查指标**：单次 P50/P95 耗时、token 成本、findings 采纳率、误报率（被点「忽略」）。

---

## 6. AI 代劳层

不是「再养一个 Agent」，而是在宿主能力上编排 **5 个可复用部件**：

| 部件 | 职责 | 落点 |
|---|---|---|
| `ReviewPipeline` | 一次审查 = 一次 Session：取数 → 分段 → 渲染 → 执行 → 后校验 → 落卡片 | `agents.create` + `subagents` |
| `PromptTemplateStore` | 模板 CRUD、变量、版本、适用范围、统计 | 插件 `storageDomain` |
| `SkillBridge` | 模板 ↔ 宿主 skill 的双向互操作 | `skills` / `sessionSkillCatalog` |
| `ActionRegistry` | `ActionDefinition` 通用抽象，覆盖审查之外的 8 类动作 | 插件服务 + 工具/命令 |
| `ActionCard kind` | 结果落地 + 人工确认 + 采纳/忽略闭环 | `actionCards.register` + verbs |

### 6.1 结构化输出：只能走 subagent `outputSchema`，且必须后校验

- 可用 schema 是**窄子集**：`type / oneOf / properties / required / additionalProperties / items / enum / const / description / title / default / examples`。**没有** `$ref / pattern / minimum / maxLength`。
- 因此 `file:line` 必须是**字符串**再解析；「行号在 diff 里存在」「路径真实存在」「evidence 能在 diff 中逐字找到」「verdict 与 findings 一致」这四类判断**放到代码后校验**，不通过就重试一次，仍不通过则降级为「文字结论 + 未校验标记」。
- 失败策略：**只重写结论，不重做业务**（借鉴 autoloop 的回执语义），避免把「已评论」再发一遍。

### 6.2 大 diff：分段 + 确定性聚合

1. 按 token 预算切段（文件级优先，超长文件按 hunk 切）。
2. 优先级：核心逻辑（非测试、非生成、非 lock）> 配置 > 测试 > 生成代码。
3. 每段一个只读 subagent（`outputSchema`），并行度上限 = `Config.reviewConcurrency`（默认 3）。
4. 聚合：按 `file:line` 去重、合并同级问题、压制历史误报、与上一轮 findings 做 diff（只显示新增/未解决）。
5. 覆盖范围必须显式：`covered / skipped / oversized` 三段清单，避免「没审却像审过」。

### 6.3 成本、增量与降级

- **同 head 复用**：`(project, iid, headSha, templateVersion, model)` 命中历史结果直接展示；head 变则整体标 `stale`。
- **增量审查**：只审 `lastReviewedSha..headSha`（用 `/repository/compare`），并对未变文件沿用上轮结论。
- **预算**：单次审查默认上限（如 120k input / 8k output）；预估用 `tokenMeter.estimateMessage`，实际读 `assistant/message.usage`。
- **降级**：模型不可用 → 只跑本地静态检查（lint/typecheck/test，经 `subprocess` 在只读沙箱）+ 明确告知「本轮未做语义审查」。

### 6.4 质量闭环

- 每条 finding 记录 `adopted / ignored / resolved`；「忽略」必须选原因（误报 / 不适用于本项目 / 已知问题）。
- 面板顶部显示「近 30 天：采纳率 / 误报率 / 平均耗时 / 平均成本」；模板列表按采纳率排序。
- 离线评测集：把历史 MR 的「人工确认过的真实问题」固化为回归用例，模板改动前后跑一遍。

---

## 7. 提示词与技能管理

### 7.1 模板结构（可直接落库）

```jsonc
{
  "id": "tpl-review-default",
  "name": "默认代码审查",
  "version": 7,
  "scope": { "projects": ["gp/*"], "paths": ["src/**"], "exclude": ["**/*.lock", "dist/**"] },
  "role": "资深工程师，只做审查，不改代码",
  "checklist": ["正确性", "边界与空值", "并发与幂等", "错误处理", "安全", "性能", "可读性", "测试覆盖", "兼容性"],
  "context": ["mr.meta", "diff", "discussions.unresolved", "ci.summary", "project.conventions"],
  "variables": ["{{mr.title}}", "{{mr.description}}", "{{files}}", "{{conventions}}"],
  "outputSchema": "ReviewResult@1",
  "model": { "provider": "qianfan", "model": "deepseek-v4.1-flash", "temperature": 0.2 },
  "enabled": true,
  "stats": { "used": 42, "adopted": 17, "ignored": 6 }
}
```

**变量只允许三类**：① 白名单内的结构化字段（`mr.title` 这类**文本**字段会作为资料文件内容被引用，而不是原样拼进模板）；② 资料文件路径；③ 模板自身的常量。**禁止**把 `summary/detail/comment` 直接插进提示词正文。

### 7.2 与宿主 skills 的关系

| 方向 | 做法 | 好处 |
|---|---|---|
| 模板 → skill | 导出 `SKILL.md`（frontmatter 只依赖 `name/description/whenToUse`） | 同一个审查方法可被任意 Agent 用 `skill` 工具调用 |
| skill → 模板 | 选择现有 skill 作为「审查方法/检查清单来源」 | 不重复维护，团队共享走宿主已有机制 |
| 命名 | 模板导出时用 `dailywork-<slug>` 前缀 | 避免与用户已有 skill 冲突（宿主同层 first-wins） |

### 7.3 ActionRegistry：8 个动作覆盖审查之外的日常

| Action | 输入 | 产出 | 写操作 |
|---|---|---|---|
| `review-mr` | MR key | `ReviewResult` + 卡片 | 否（评论需确认） |
| `summarize-mr` | MR key | 一段变更摘要（给人看） | 否 |
| `gen-tests` | MR key / 文件 | 测试补丁草稿 | 否（落地需确认） |
| `explain-code` | 文件+行号 | 解释 + 上下文 | 否 |
| `draft-reply` | 讨论线程 | 回复草稿 | 确认后发 |
| `weekly-report` | 时间窗 + 项目范围 | 周报（本地 Markdown） | 否 |
| `release-notes` | 里程碑 / tag 区间 | 发布说明草稿 | 否 |
| `apply-mr-locally` | MR key | 生成 worktree + 应用改动 | 仅工作区 |

动作与模板解耦：`Action` 决定「做什么」，`Template` 决定「怎么提示」，两者多对多。

---

## 8. 从 agent-autoloop 借鉴什么、不借鉴什么

它是「没有界面的自动化中台」：三张门（事件 / 领活 / 卡片）+ 一份只追加日志，内核零依赖、不主动连接、不知道产品名。约七成机制与「有没有界面」无关，可以直接当我们的后台协议。

### 8.1 七条机制（照抄语义，换成 DSH 实现）

| 它的机制 | 我们怎么用 | 为什么值得抄 |
|---|---|---|
| **规则化调度**（`when / to / cwd / skill / prompt / group / parallel / resume`） | `Rule` 对象存 `storageDomain`，面板可视化编辑；派发只管「哪条规则接哪类事件」 | 加工作流不用写代码；用户自助扩展 |
| **一轮不等人**（要问人就结束这一轮） | 审查结束就落卡片；等待期间**没有** Agent 进程、不烧 token；回答后用同一 `sessionId` 续上 | 「挂起零消耗」是省钱与不打扰的关键 |
| **卡片四件事**（`ask / notice / resolve / later` + `events`） | `actionCards` kind 承载；`later` = 定时复查（新 head、CI 转绿、被回复） | 人机协同的最小完备集合 |
| **会话接续**（接不上才开新会话；断了回原会话重试） | Turn 记 `sessionId`；重试用同 Session，不重做业务 | 避免「重复审查 + 重复评论」 |
| **幂等 + 同事项合并**（同 `id` 只记一次；排队期新事件并进本轮） | 事件去重键 + `(source, subject)` 聚合 + 「重试期间新事件合并」 | 轮询重叠、来源重发、失败重试都会撞上 |
| **指令数据分离**（事件文字不进提示词；事件字段白名单） | 资料文件 + 校验字段；`Event` 无 `cwd/agent/access` | 面板展示 MR 文本不能成为注入面 |
| **跳数熔断**（回执事件继承 `hops`，超 8 层只记录） | AI 产出「建议动作」再触发工作项时累加 `hops`，超限只记审计 | 防止 AI 自触发无限循环 |

### 8.2 三条**不抄**

1. **「没有界面」**——我们就是要大面板；但把它的「总览页是客户端」思想反过来用：面板只是这套协议的一个客户端，CLI/工具也是客户端，协议本身不依赖 UI。
2. **Webhook 为主的事件入口**——它的 GitLab 插件是 webhook + token 校验；我们本机不可达公网，P0 用轮询（webhook 留 P2）。
3. **全自动合并交付**（`deliver` 标签 → 审查 → 合并 → Ship）——我们**不做** AI 自动 approve/merge，只出草稿与建议，人工确认后才写。

### 8.3 一处真实冲突与我们的取舍

它的 SECURITY 明确写了：规则配 `resume: true` 时，**上一轮读到的资料（含他人写的文字）会留在会话里**，与「数据不进上下文」冲突。我们的处理：

- 默认**不复用**跨轮上下文：每次审查新起 Session，资料以文件形式注入。
- 「追问」允许续在同一 Session（用户显式行为），但追问轮**禁止**任何写操作 verb。
- 复查（`later`）若命中「同一 head 且只补 CI 结果」，用增量会话；否则新起 Session。

---

## 9. 任务与自动化（可重复作业）

GitLab 审查只是「事件驱动」的一类。真实的一天里还有大量**可重复作业**：周五周报、每日早报、依赖巡检、测试巡检、发布说明、日志巡检、批量审查、代码清理、会议纪要整理。用户要的四件事必须都成立：

1. **手动跑**——面板上一个按钮，点了就执行；
2. **定时跑**——每天/每周/每 N 分钟，某个时刻自动执行；
3. **并行跑**——同一个作业起多份，或一次展开一批（5 个 MR、10 个仓库）；
4. **接着跑**——某个作业或某个事件完成之后，再执行下一个。

### 9.1 统一抽象：Trigger × Executor × Output × Policy

一个可重复作业（`Job`）就是四段配置，不需要写胶水代码：

| 段 | 取值 | 说明 |
|---|---|---|
| **Trigger** | `manual` / `cron` / `event` / `after`（事件后或作业后）/ `webhook`(P2) | 什么时候跑 |
| **Executor** | `session`（进程内真实 Session，可追问）/ `headless`（`dsh headless --json` 隔离子进程）/ `command`（任意 CLI） | 谁来跑 |
| **Output** | `artifact`（文件）/ `card`(需拍板) / `notification` / `workitem`（产出新工作项）/ `none` | 产出什么 |
| **Policy** | 并发数、lane 键、超时、重试与退避、静默时段、每日上限、成本预算 | 怎么跑才安全 |

```jsonc
{
  "id": "job-weekly-report",
  "name": "周五周报",
  "trigger": { "kind": "cron", "cron": "0 18 * * 5", "tz": "Asia/Shanghai", "catchUp": "skip" },
  "executor": { "kind": "session", "template": "tpl-weekly", "cwd": "~/notes", "access": "read-only" },
  "params": [{ "key": "range", "type": "enum", "values": ["this-week", "last-week"], "default": "this-week" }],
  "inputs": ["gitlab.commits", "gitlab.mergedMRs"],
  "output": { "kind": "artifact", "path": "reports/weekly-{{date}}.md", "notify": "card" },
  "policy": { "concurrency": 1, "timeoutMin": 10, "retry": { "max": 2, "backoff": "5m" }, "quietHours": [] }
}
```

**关键约束**：`cwd` / `access` / `executor` **只能**来自用户在面板里保存的 Job 定义，事件与外部文字不得覆盖（同 §2.2 不变量 1）。

### 9.2 并行与编排

| 形态 | 说明 | 例子 |
|---|---|---|
| **同 Job 多实例** | `policy.concurrency = N`；同 `laneKey` 串行、不同 lane 并行 | 按项目分 lane：`gp/order-service` 串行，跨项目 3 路并行 |
| **fan-out / fan-in** | 对一个集合展开成 N 个 Run，父 Run 等全部完成再聚合 | 「批量审查 5 个 MR」→ 5 个审查 Run → 汇总一张卡 |
| **线性 after 链（P0）** | A 成功后跑 B（`trigger.kind = after`, `after: { jobId, status: 'success' }`） | 合并 MR → 生成发布说明草稿 |
| **DAG（P1）** | 节点=Job，边=after；`A → (B, C) → D`，支持 fan-in | 周报 = 拉提交 ∥ 拉 MR → 合并写稿 |

**熔断**：after 链继承 `hops`（借 agent-autoloop），**最多 8 跳**；超限只记审计并出卡片，不再派活。这防止「任务→事件→任务」自激。

**隔离**：写工作区的任务默认用独立 worktree（`ctx.worktrees`）创建，避免并行互相污染；只读任务可共享目录。

### 9.3 调度器（必须自己实现，**不能**用宿主 `schedule`）

宿主 `schedule` 是「会话绑定的提醒」——把消息投进某个 Session 的 inbox，不是全局 cron。所以：

- **tick**：`ctx.timer` 每 30s 一次，查 `nextRunAt ≤ now` 的 Job；
- **加锁**：在 `storageDomain` 单事务里「取到期 → 置 running → 推进 nextRunAt」，避免多窗口/重启重复触发；
- **幂等键**：`jobId + scheduledAt`，同一次到期只产生一个 Run（至少一次语义）；
- **补跑策略** `catchUp`：`skip`（默认，错过就跳过）或 `run-once`（错过多期只补一次）；
- **重启恢复**：启动时读 `nextRunAt` 与未完成 Run，把 `running` 但无进程的标记为 `interrupted` 并按 `retry` 处理；
- **静默时段**：`quietHours` 内不通知（任务照跑，产出延后推送）。

### 9.4 面板上的「任务与自动化」

一级导航第 5 项由「规则与自动化」升级为 **「任务与自动化」**，三个 tab：

1. **任务库**：卡片列表——名称、触发（cron 的可视化摘要）、上次运行、成功率、平均耗时、开关、`▶ 立即运行`、`⋯`（编辑/复制/停用/删除）。
2. **运行历史**：时间、触发源（手动/定时/事件/上游 Job）、状态、耗时、token、产物链接；可**重跑**、**取消**、看 `why`（审计回放）。
3. **触发器**：事件 → 动作（生成工作项 / 直接跑某个 Job），带命中统计与暂停开关。

**点按钮的完整交互**：`▶` →（若 Job 有参数）弹参数表单（默认值预填）→ 起 Run → 顶部进度条 + 历史插入一条 `running` → 完成时出卡片/通知/产物链接；失败给「重试 / 看日志 / 去设置」。**长任务不阻塞面板**：切走再回来仍在跑，进度来自 `GET /api/daily-work/runs/:id`。

### 9.5 自定义任务的表单（写配置，不写代码）

| 分区 | 字段 | 校验 |
|---|---|---|
| 基本 | 名称、描述、图标、启用 | 必填、唯一名 |
| 触发 | 手动 / cron（5 段 + 时区 + 补跑策略）/ 事件（类型多选）/ 上游 Job | cron 语法、时区合法 |
| 执行 | 执行器（session / headless / command）、模板或技能、自由提示词、目录、权限（只读 / 可写） | 目录存在、模板存在 |
| 参数 | 键、类型（string/number/enum/bool）、默认值、是否必填 | 类型与默认值匹配 |
| 产出 | 类型、路径模板（`{{date}}`）、通知方式 | 路径在工作区内 |
| 策略 | 并发、lane 键、超时、重试、静默时段、每日上限 | 数值范围 |

**试跑**：所有任务支持「干跑」（只读上下文、不写任何外部系统），先看渲染后的提示词与预期产出，再启用定时。

### 9.6 与既有概念的关系（不要混淆）

| 概念 | 回答什么问题 | 例子 |
|---|---|---|
| **WorkItem** | 「有件事要我看/做」 | 待我审的 MR #482 |
| **Job** | 「有一件可重复的事该跑」 | 周五 18:00 出周报 |
| **Rule** | 「什么事件变成什么」 | MR 被请求审查 → 生成 `review_requested` 工作项 |
| **Run / Turn** | 「这一次实际执行」 | 周报这一次跑了 38s、花了 12k token |
| **Card** | 「要人拍板的那一下」 | 周报里「要不要发给团队？」 |
| **Artifact** | 「跑完留下的东西」 | `reports/weekly-2026-11-07.md` |

一条 MR 审查 = Job `review-mr` 的一次 Run（可由事件触发，也可手动）；周报 = Job `weekly-report`（cron）；批量审查 = Job `review-batch`（manual + fan-out）。**同一个执行器、同一套卡片、同一份审计**。

### 9.7 安全边界（与 §11 一致，任务不例外）

- 任务定义的 `access/cwd/executor` 只能由用户保存，事件文字不得影响；
- 写操作类任务默认 **dry-run**：真正发评论/合并必须走 `verb.writes` 人工确认；
- after 链 8 跳熔断；每 Job 每日运行上限 + 成本预算，防止「定时任务把自己跑穷」；
- 任务可被**单独停用**，停用后不再定时、不再接事件，已排队的 Run 不补跑。

---

## 10. 功能路线图

44 项候选功能按「价值 / 频次 / 成本」排序后，收敛成三批（完整目录见 `research/03-workflows.md`）。

### P0（MVP，先做 14 项）

1. GitLab 连接与自检（实例、PAT、作用域、测试连接）
2. 定时轮询 + 增量水位 + 失败退避
3. 收件箱（reason 分组、未读、snooze/忽略/归档、保存视图）
4. MR 详情（概览 + 双栏 diff + 讨论 + CI 摘要）
5. 一键 AI 审查（Session + 结构化 findings + 卡片）
6. 评论草稿与人工确认发布
7. 提示词模板管理（列表/编辑/变量/版本/启用）
8. 动作：摘要、起草回复
9. 手动刷新与「上次成功」状态
10. 审计与 `why(turnId)`
11. 本地 Git 卫生（未提交 / 未推送 / 陈旧分支）——成本 2、价值 5，性价比最高，顺手纳入
12. **任务库：手动跑 + cron 定时**（Job 定义、参数表单、`▶ 立即运行`）
13. **运行历史**（进度、耗时/token、重跑、取消、`why` 回放）
14. **after 链**（某 Job 成功后跑下一个）+ 并发上限与 lane 串行

### P1（留存与扩展）

15. Issue 收件箱（指派/逾期/@我）
16. 周报与日报生成（基于本周 MR/Issue/提交）——第一个真正的定时 Job
17. 发布说明草稿（里程碑区间，由「合并 MR」事件 after 触发）
18. 任务与自动化页完整版：Job 编辑器、DAG 画布、触发器规则、静默时段与通知
19. 审查模板 A/B 与采纳率看板
20. CI 失败定位（对失败 job 起 AI）
21. 保存视图共享 / 导出
22. 注册 GitLab ForgeProvider（让宿主 forge 面板也能看 MR）

### P2（更多来源与自动化）

23. GitHub / Gitee 适配器
24. 依赖漏洞与升级提醒（定时 Job）
25. 告警/值班接入
26. Webhook 入口（本地反向代理）
27. 团队共享（模板包 / Job 包导出与分发）
28. 看板视图与燃尽图（专用面板）

---

## 11. 安全、隐私与边界

| 项 | 规则 |
|---|---|
| 凭据 | PAT 只进 `credentials`；日志、面板响应、Session 上下文一律脱敏（`glpat-****`） |
| 权限最小化 | 默认只读 token；写 token 仅在用户确认写操作的那一刻取出 |
| 写操作 | 三重要求：人工点击 + 卡片版本匹配 + `headSha` 未变；服务端二次校验，否则 409 |
| 数据外发 | 默认只把**必要上下文**送模型；支持「项目级屏蔽路径」（如 `secrets/**`、`.env*`） |
| 审计 | 谁在什么时候对哪个 MR 做了什么（含 AI 建议与人工决定），只追加 |
| 卸载 | 面板图标、路由、工具、定时器全部随 `ctx.effect` 清理；不残留监听与定时任务 |

---

## 12. 风险与待实测项

| # | 风险 / 未知 | 影响 | 处理 |
|---|---|---|---|
| R1 | Desktop 宿主下自定义 HTTP 路由的可达性（`dsh-app://` 与 `http://127.0.0.1` 不同） | 面板拿不到数据 | M0 第一个里程碑就用最小插件实测（`connection.fetch.register` 与 `webServer.register` 各试一条） |
| R2 | 新建的审查 Session 是否会出现在左侧会话区 | 「可回看」体验 | M0 实测；不行则改为「面板内嵌会话视图 + 提供跳转」 |
| R3 | 没有 ETag，轮询只能靠水位 | 漏事件或重复拉 | 用 `updated_at` 水位 + head SHA 指纹双判；每日对账 |
| R4 | 写评论 60 次/分硬限流且不在响应头 | 批量发布被 429 | 本地令牌桶 30/min + 拆批 + 失败重试队列 |
| R5 | 大 diff / `too_large` | 审查覆盖不全 | 显式标注覆盖范围，绝不假装审过 |
| R6 | 模板导出与宿主 skill 命名冲突 | 覆盖用户技能 | 统一 `dailywork-` 前缀；同层 first-wins 已在设计里避让 |
| R7 | 轮询放大（多项目 × 多数据类） | 被 GitLab 限流 | 每源预算表；默认 60s；按项目数线性下调 |
| R8 | 自研 Job 调度器与宿主 `schedule` 混淆 | 定时任务不触发、或重复触发 | 两条路彻底分开：Job 调度器自持 `nextRunAt` + 事务加锁 + 幂等键；`schedule` 只用于「会话内提醒」 |
| R9 | 错过运行窗口（休眠 / 关机 / 重启） | 周报缺一期、或补跑洪峰 | `catchUp` 显式可选（默认 `skip`），面板常驻「上次运行 / 下次运行」 |
| R10 | 并行任务互相污染工作区 | 产物错乱或提交串台 | 写任务默认独立 worktree；同 `laneKey` 串行；并发上限硬约束 |

---

## 13. 里程碑与验收

| 里程碑 | 内容 | 预估 | 验收 |
|---|---|---|---|
| **M0 骨架**（2–3 天） | 最小插件：`sidebar.panellist` 图标 + `main` 面板 + 一条自定义路由 + 一次 `agents.create` 起会话 | 2–3 天 | 面板能打开、能拿到 Host 数据、能起一个审查会话（先不接 GitLab） |
| **M1 只读闭环**（5–7 天） | GitLab 连接 + 轮询 + 收件箱 + MR 详情 + 双栏 diff | 5–7 天 | 待我审 MR 自动出现，详情与 GitLab 页面一致 |
| **M2 AI 闭环**（4–6 天） | 审查流水线 + 结构化 findings + 卡片 + 评论草稿确认发布 | 4–6 天 | 一条 MR 从发现到评论完成，全程不离开面板 |
| **M3 管理与打磨**（3–5 天） | 模板管理、设置页、快捷键、空态/错误态、对账 | 3–5 天 | 连续使用一周，漏项 0、误收口 < 1% |
| **M4 任务与自动化**（4–6 天） | Job 库（手动 + cron）、运行历史、after 链、并发与 lane、参数表单 | 4–6 天 | 点「▶」跑通周报；到点自动触发；A 成功自动跑 B；3 路并行不串产物 |

---

## 14. 验证状态（交付前自查）

独立审查员因网关限流未能完成，以下为 Lead 自查结果。**读者应按「级别」区分可信度**：`已核` = 本次 inspect 契约或宿主源码；`文档级` = 只按官方文档核对，未连真实实例；`待实测` = 需要装最小插件或连 GitLab 才能定论。

| 断言 | 级别 | 依据 |
|---|---|---|
| `sidebar.panellist` / keyed `main` / `ctx.layout.selectPanel` 可做整页面板 | 已核 | 宿主 `dsh-client-ui-layout`、`dsh-client-ui-sidebar` 源码 + `dshmarket` 真实注册 |
| plain-JS 客户端不能用 `@Remote`/typert | 已核 | 无构建期生成；`dsh.client` 只声明 module 入口 |
| `connection.fetch.register` 与 `requestRejection` 存在 | 已核 | 本次 `Service.listService('connection')` 精确签名 |
| `agents.create` + `followup` 起审查会话 | 已核（签名） | `Service.listService('agents')`；会话是否显示在左栏 `待实测` |
| `tools.register` / `restrict` / `guard` 与 `actionCards` verbs | 已核（签名） | 05 取证；`verb.writes` 的强制确认行为 `文档级` |
| `scope=reviews_for_me` 是待我审主查询 | 文档级 | docs.gitlab.com master 源文件；**未连真实实例** |
| `reviewer_username` 不接受 `me` | 文档级 | 同上 |
| `/events` 不含 MR 事件、`/changes` 已弃用 | 文档级 | 同上 |
| REST 无 ETag/If-None-Match | 文档级（按「不支持」设计） | 文档未提及；需实测确认 |
| note/discussion 60 次/分且不在 `RateLimit-*` 头 | 文档级 | GitLab.com 应用层限流说明 |
| Desktop 下自定义路由与页面共享凭据 | 待实测 | `dshmarket` 源码注释也标注未测 |
| 插件可安装、Host 行激活 | **已核（本次实测）** | `install_bundle` 返回 `application: applied`、`warnings: []`；`Config.listConfigs` 出现 `include:daily-work-hub` 且 `status: schema`，默认 `instance=default`、`pollIntervalSec=60` |
| 客户端槽位注册（`main` + `sidebar.panellist`） | 待实测（需刷新页面） | 安装后即时查询仍为 `plugins/conversation/desktop-workbenches/schedules` 与 `plugins/schedules`，**未见** `daily-work-hub` —— 判定为新 bundle 未走 HMR，刷新后复测 |
| `meta.cwd` 缺省时的会话目录 | 待实测 | `CreateAgentOptions` 未展开 |
| 宿主 `schedule` 是「会话绑定提醒」，不能当全局 cron | 已核（语义） | `Service.listService('schedule')`：`create(sessionId, ...)` 参数即绑定会话；02/01 一致 |
| `ctx.timer.interval` 可用于后台 tick（不持久，重启需自恢复） | 已核（签名） | `Service.listService('timer')`：`interval(callback, delay): () => void` |
| `ctx.worktrees.create` 可为并行写任务提供隔离目录 | 已核（签名） | `Service.listService('worktrees')`；实际行为 `待实测` |
| `agents.create` 并发多路是否互相影响 | 待实测 | 需 M4 并行跑 3 路验证 |

> 建议：M0 的第一个动作就是「最小插件 + 一条路由 + 起一个会话」，把上表 4 个 `待实测` 一次性打掉；在此之前不要写正式 UI。

---

## 附录 A · 数据模型示例

```jsonc
// Event：外部世界进来的一条事实（无派发控制字段）
{ "id": "gl:1234:98745", "type": "merge_request.review_requested",
  "source": "gitlab:gp", "subject": "gp/order-service#482",
  "summary": "feat: 订单幂等校验", "detailRef": "ctx/482/detail.md",
  "link": "https://gitlab.example.com/gp/order-service/-/merge_requests/482",
  "at": "2026-11-08T09:12:00Z", "hops": 0 }

// WorkItem：面板上的一条待办
{ "key": "gitlab:gp|gp/order-service#482",
  "kind": "mr", "reason": "review_requested",
  "localState": "unread", "remoteState": "open",
  "headSha": "9f2c1ab", "ci": "success", "approvals": { "left": 1, "of": 2 },
  "unreadComments": 3, "labels": ["backend"], "project": "gp/order-service",
  "lastTurn": { "id": "turn-77", "verdict": "comments-only", "templateVersion": 7,
                "computedForHead": "9f2c1ab", "finishedAt": "2026-11-08T09:20:11Z" } }

// Card：需要人拍板
{ "id": "card-88", "turnId": "turn-77", "kind": "daily-work/review",
  "verbs": { "add-comment": { "writes": true }, "approve": { "writes": true },
             "dismiss": { "global": true } },
  "details": { "findings": 6, "blockers": 1, "computedForHead": "9f2c1ab" } }

// Job：可重复作业（§9.1）
{ "id": "job-weekly-report", "name": "周五周报", "version": 3, "enabled": true,
  "trigger": { "kind": "cron", "cron": "0 18 * * 5", "tz": "Asia/Shanghai", "catchUp": "skip" },
  "executor": { "kind": "session", "template": "tpl-weekly", "cwd": "~/notes", "access": "read-only" },
  "output": { "kind": "artifact", "path": "reports/weekly-{{date}}.md", "notify": "card" },
  "policy": { "concurrency": 1, "timeoutMin": 10, "maxRunsPerDay": 2 } }

// Run：一次实际执行
{ "id": "run-312", "jobId": "job-weekly-report", "triggerSource": "manual",
  "params": { "range": "this-week" }, "state": "running",
  "startedAt": "2026-11-08T10:02:11Z", "sessionId": "sess-9f3a",
  "usage": { "input": 41200, "output": 6100 }, "hops": 0,
  "artifacts": [], "cardId": null }
```

## 附录 B · 插件目录结构（建议）

```
daily-work-hub/
  package.json          # dsh.bundle.patch + dsh.client + exports(locale/icon)
  cordis.patch.yml      # 一行：id: daily-work-hub
  index.js              # Host：apply(ctx, config)，注册服务/路由/工具/定时器
  lib/
    adapter-gitlab.js   # REST 客户端（采集/读取/写入）
    poller.js           # 调度、游标、退避、预算
    store.js            # 事件去重、工作项聚合、状态机、审计
    review.js           # 取数→分段→模板→Session→后校验
    jobs.js             # Job 库 CRUD、参数校验、试跑
    scheduler.js        # tick、nextRunAt、事务加锁、catchUp、重启恢复
    runs.js             # Run 生命周期、并发/lane、重试、取消、产出
    routes.js           # /api/daily-work/*（含 /jobs、/runs）
    tools.js            # dailywork_* 工具与斜杠命令
  client/
    client.js           # 面板：sidebar.panellist + main['daily-work']
  locale/{zh.json,en.json}
  icon.svg
```

## 附录 C · 研究索引

| 主题 | 文件 | 关键结论 |
|---|---|---|
| 平台可行性 | `research/01-platform.md` | 面板槽位、数据通道、持久化、AI 会话、工具、风险 |
| GitLab API | `research/02-gitlab.md` | 12 端点、`scope=reviews_for_me`、无 ETag、写限流、双 token |
| 工作流目录 | `research/03-workflows.md` | 44 项功能、M1–M10 模式、U1–U24 构件、P0/P1/P2 |
| AI 审查层 | `research/05-ai-review.md` | 5 部件、结构化后校验、分段聚合、Action 表、会话结合 |
| UX 规格 | `research/04-ux.md` | 7 项导航、三栏尺寸与断点、行高 58–64、AI 抽屉 5 态、40 个真实 token 表、14 条实现要点 |
| autoloop 借鉴 | `research/06-autoloop.md` | 7 机制映射、安全模型、MR 审查 12 步时序、10 条设计约束 |
| 高保真线框 | `design/panel-mockup.html` | 4 个 1440×900 画板，真实 `--dsw-alias-*` token |