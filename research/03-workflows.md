# 03 · 日常工作流挖掘：可集成功能目录、竞品模式与统一模型验证

> **本文件范围**：为「软件工程师日常工作中台」（DeepSeek Harness 整页大面板插件）挖掘**尽可能广而实用**的工作流，回答三件事：
> ① 别人（GitHub / Linear / Jira / GitLab / VS Code / Raycast / Slack / GitKraken）已经把「工程师的一天」抽象成什么交互；
> ② 我们能接多少条工作流（≥30 项，本文件给 44 项，逐项打价值/频次/成本/优先级）；
> ③ 用 `WorkItem + SourceAdapter + Action + Skill/Prompt` 这套统一抽象能否套住它们，套不住的部分需要什么专用视图与 UI 构件。
>
> **不做**：不安装插件、不改 profile、不写实现代码、不做接口级契约取证（那是 01/02 的职责）。
> **与 `research/05-ai-review.md` 的关系**：05 定义了 AI 代劳层的 DSH 侧落地（`ReviewPipeline` / `PromptTemplateStore` / `SkillBridge` / `ActionRegistry` / `ActionCard`）。
> 本文件站在**产品与工作流**一侧，输出「需要被这套抽象承载的对象清单与视图清单」，命名与 05 保持一致；冲突时以 05 的 DSH 契约为准。

> **取证方式**：`web_fetch` 抓取一手文档/产品页，逐条标注来源 ID（见附录 A），并显式标注**证据强度**（正文 / 结构 / 标题）。
> 少数页面在本机环境被导航栏截断或 404（Jira 文档、Linear 正文、GitKraken 文档），已在 §0.2 与附录 A 如实标注，**不用二手印象冒充一手事实**。

---

## 0. 摘要与采集说明

### 0.1 十条结论（先看这里）

| # | 结论 | 依据 |
|---|---|---|
| C1 | 竞品的核心不是「更好的列表」，而是**一个带状态机的收件箱**：条目有 `reason`（为什么找你）、有 `done/snooze/saved` 三态、有「远端状态变化 → 本地自动收口」。 | [S1][S2] |
| C2 | **`reason` 应当是第一等字段**，而不是标签装饰。GitHub 直接按 `reason:review-requested` 建过滤视图，GitLab 把「谁触发」写进 to-do 生成规则 —— 这正是我们「待我审 / 要我改 / 我提的」分组的产品学来源。 | [S1][S2] |
| C3 | 收件箱必须能**在不动鼠标的情况下清空**：GitLab 的批量勾选 + Snooze 预设（1h / 4h / 明早 8 点）、GitHub 的批量下拉 + 键盘快捷键，都是为「15 分钟清零」设计的。 | [S1][S2] |
| C4 | **Saved View（自定义过滤）是留存的关键**：GitHub 允许最多 15 个自定义过滤器；VS Code 用 `githubPullRequests.queries` 直接吃 GitHub 搜索语法。我们应把「视图」做成数据而不是代码。 | [S2][S3] |
| C5 | **代码审查必须在同一个界面完成「读 diff → 写评论 → 提交结论」**。VS Code 的 Review Mode（checkout PR 分支、Changes 视图、逐文件 diff + 评论、退出即回原分支）是桌面端的黄金标准。 | [S3] |
| C6 | **AI 的价值密度最高处是「把长内容压成决策」**：PR 标题/描述生成（VS Code sparkle）、AI 审查、Slack 工作流里的 `Generate AI response` 步骤、Raycast 的「AI Commands = 提示词绑定快捷键」。 | [S3][S4][S5] |
| C7 | **提示词本身就是 UI**：Raycast 把 prompt 变成可绑定快捷键的命令；Slack 把 prompt 变成工作流里的一个步骤。我们要做的是「模板库 + 变量 + 绑定到条目上的动作」。 | [S4][S5] |
| C8 | **定时 + 阈值是「AI 主动找我」的唯一安全形态**：Raycast Automations 定时跑 agent 产出周报；GitLab/GitHub 的轮询产生 todo/notification。AI 不应实时打断，只应在「收件箱刷新」时给出增量结论。 | [S4][S1] |
| C9 | **统一列表能吃掉约 70% 的工作流**（44 项里 31 项适配 A 级），但**双栏 diff、燃尽图、日志流、指标时序**这四类必须专用面板，压进卡片会变成「什么都看不了」。 | 本文件 §3.5/§3.6 |
| C10 | **P0 的边界应当是「审查闭环 + 收件箱骨架 + 本地 Git 卫生 + 提示词/技能管理」**，而不是「接满 8 个数据源」。后者的边际价值在 P0 阶段低于「把 1 条链路打磨到 30 秒完成」。 | 本文件 §5 |

### 0.2 取证说明（哪些是硬证据，哪些只有结构）

| 来源 ID | 页面 | 抓取结果 | 证据强度 | 我们实际用了它证明什么 |
|---|---|---|---|---|
| S1 | GitLab To-Do List 文档 | ✅ 完整正文 | **正文** | 收件箱状态机、snooze 预设、分组视图、批量编辑、自动收口规则、排序策略 |
| S2 | GitHub Notifications（概念 + 收件箱用法） | ✅ 完整正文 | **正文** | `reason` 标签与过滤、Saved/Done/Unsubscribe、批量 triage、最多 15 个自定义过滤器、保留期 |
| S3 | VS Code "Work with GitHub in VS Code"（`.md` 版） | ✅ 完整正文 | **正文** | PR 视图、Review Mode、逐文件 diff 评论、`githubPullRequests.queries` 自定义查询、issue→分支→PR、AI 生成描述、AI 代码审查 |
| S4 | Raycast AI 产品页 | ✅ 完整正文 | **正文** | AI Commands（提示词→快捷键）、Projects（项目级指令+记忆）、Automations（定时跑 agent）、Quick AI、多模型 |
| S5 | Slack Lists + Workflow Builder 产品页 | ✅ 完整正文 | **正文** | 列表式工作项（负责人/截止）、工作流内嵌列表、AI 生成工作流、`Generate AI response` 步骤、条件分支（上限 15 条件）、连接器 |
| S6 | Linear 文档站（Inbox / Triage 等） | ⚠️ 仅侧边导航结构，正文被截断 | **结构** | Linear 的信息架构：Inbox、Triage、Notifications、My Issues、Custom Views、Favorites、Reviews（diffs）、Triage Intelligence、Loops、Linear Asks |
| S7 | Jira 产品页 + Atlassian "evolving Jira for AI-native SDLC" 博客 | ⚠️ 仅标题级（页面 JS 渲染），文档站多次 404 | **标题** | 仅能确认产品方向（AI 原生 SDLC），**Jira "我的工作" 的具体交互不作断言**，列入 §6 待核实 |
| S8 | GitKraken 首页 + Kepler 产品页 | ⚠️ 首页仅导航，Kepler 取到标题 "Mission Control for Agent-driven Development" | **标题** | GitKraken 正在做「agent 会话的指挥台」这一方向信号 |

> 结论：**C1–C8 全部有正文级证据**；涉及 Linear / Jira / GitKraken 的具体交互细节，本文件只做「方向判断」不做「机制断言」。

---

## 1. 竞品与既有模式研究

### 1.1 八家产品的机制对照

| 产品 | 它的「入口」长什么样 | 关键机制（逐条可复用） | 来源 |
|---|---|---|---|
| **GitLab To-Do** | 右上角 To-do 计数器 → 列表页 | ① 条目由**他人动作**自动生成（指派、请求审查、@提及、我 MR 的流水线失败、冲突、merge train 移除）；② 三 Tab：`To Do / Snoozed / Done`；③ Snooze 预设：1 小时 / 今天晚些（4h）/ 明天 8 点，或指定时间，到点自动回到主列表；④ 「Recommended / Updated / Label priority」三种排序；⑤ 可按 issue/MR **分组**并显示组内条数；⑥ 批量勾选 → 批量 done/snooze；⑦ **自动收口**：评论、加标签、改指派人、关闭、合并 MR 都会把相关 todo 标 done；⑧ 权限丢失后一小时内删除相关 todo | [S1] |
| **GitHub Notifications/Inbox** | 顶栏铃铛 → github.com/notifications | ① `reason` 是第一等标签（`mention` / `subscribed` / `review requested` / `participating` / `assigned`），可 `reason:review-requested` 直接过滤；② 五动作：Save / Done / Unsubscribe / Read / Unread，各有 `is:` 查询；③ 批量选择 + 下拉统一处理；④ **最多 15 个自定义过滤器**（`repo:foo reason:participating`）；⑤ 保留策略：未 Save 的 3 个月清理，Saved 永久；⑥ 文档明确指向键盘快捷键 | [S2] |
| **VS Code GitHub PR（+Issues）** | 活动栏 GitHub 图标 → Pull Requests / Issues 视图 | ① **Review Mode**：checkout PR 分支 → "Changes in Pull Request" 列文件与 commit → 打开文件加评论 → 退出 Review Mode 回原分支；② `githubPullRequests.queries` 用 GitHub 搜索语法自定义「Assigned To Me」等条目；③ Issue → "Start Working on Issue" **自动建分支**，状态栏显示当前 issue 并可一键建 PR；④ `TODO/FIXME` 注释 → Code Action 直接建 issue；⑤ PR 标题/描述由 AI 生成（sparkle 按钮，走 utility model）；⑥ 可调用 AI 代码审查 | [S3] |
| **Raycast** | 全局热键 → 搜索框 | ① **AI Commands**：把常用提示词绑成快捷键命令；② **Projects**：项目级指令 + 记忆；③ **Automations**：定时让 agent 跑重复任务（官方举例：准备每周更新）；④ Quick AI（选中即问）；⑤ AI Extensions 连接 Linear/GitHub/Slack/Mail/Calendar；⑥ 自带模型或 BYOK | [S4] |
| **Slack Lists + Workflow Builder** | 频道内列表 / 工作流 | ① 列表承载任务：负责人、截止日期、跟进人；② **工作流可以内嵌在列表、Canvas、频道书签**里；③ 由 AI 直接生成工作流；④ `Generate AI response` 步骤（自然语言 prompt + 知识源）；⑤ 条件分支上限 15 个条件；⑥ 连接 70+ 应用 | [S5] |
| **Linear**（结构级证据） | 侧边栏 | 架构层面给出四条可复用信号：`Inbox`（收件箱）、`Triage`（**分诊队列**：先进 triage 再进 backlog）、`Custom Views`（保存视图）、`My Issues`、`Favorites`；另有 `Reviews (diffs)`、`Triage Intelligence`（AI 分诊）、`Loops`（循环式自动化）、`Linear Asks`（请求入口） | [S6] |
| **Jira**（标题级证据） | — | 本环境未能取到「我的工作 / Your work」的一手交互文档，**不做机制断言**；仅确认 Atlassian 公开方向为「面向 AI 原生软件开发的 Jira 演进」。待核实项见 §6 | [S7] |
| **GitKraken**（标题级证据） | — | Kepler 定位 "Mission Control for Agent-driven Development"：把「多个 agent 会话」当作战区来指挥，说明「工程师的看板」正在从「我的任务」扩展到「我的 agent」 | [S8] |

### 1.2 十条可复用交互模式（M1–M10）

> 每条给：定义 → 一手证据 → 我们面板怎么落地 → 风险。

| ID | 模式 | 定义 | 证据 | 在我们的面板中如何落地 | 风险 |
|---|---|---|---|---|---|
| **M1** | **收件箱（Inbox）** | 一切「需要我动作」的东西先落到一个统一队列，按「为什么找我」排序，而不是按来源分栏 | GitHub Inbox、GitLab To-Do、Linear Inbox [S1][S2][S6] | 主面板首页 = `Inbox`；每条 = 一个 `WorkItem`（§3.2）；顶部常驻「今天还剩 N 条 / 已 snooze N 条」 | 变成通知中心后没人清理 → 必须配 M4/M5 的收口手段 |
| **M2** | **按 reason 分组** | `待我审 / 要我改 / 我提的 / 提及我 / 分配给我 / CI 失败` 是最小分组集 | GitHub `reason` 标签 + `reason:` 过滤 [S2]；GitLab 的 todo 生成规则 [S1] | 收件箱默认按 `reason` 分组（可切「按项目 / 按时间 / 平铺」），组头显示计数与最老等待时长 | 分组过细会让「15 分钟清空」失效 → 默认 6 组封顶 |
| **M3** | **Snooze（稍后）** | 现在不处理但也不想丢：1h / 4h / 明早 8 点 / 指定时间，到点自动回主列表并标注「原本何时创建」 | GitLab 三种预设 + 指定时间 + Snoozed Tab + 到点标注 [S1] | `s` 起手 → 三个预设 + 自定义；Snoozed 独立 Tab；到点回列表时显示原始创建时间 | 与远端不一致（GitLab 自己也有 snooze）→ 需决定「以谁为准」 |
| **M4** | **Saved View（保存视图）** | 把一组过滤条件命名保存，作为左侧导航项常驻 | GitHub 最多 15 个自定义过滤器 [S2]；VS Code `githubPullRequests.queries` 吃搜索语法 [S3]；Linear Custom Views [S6] | `SavedView = {id,name,filter,groupBy,sort,icon}`，新建视图 = 「当前过滤 → 另存为」；内置 4 个：待我审 / 我的 MR 有动静 / 今天到期 / 需要我回复 | 视图 DSL 过早复杂化 → P0 用固定字段 + 简单 AND 条件 |
| **M5** | **批量操作** | 勾选多条 → 统一 done / snooze / 加入今日计划 / 批量 AI 预审 | 两者都有批量选择 + 下拉动作 [S1][S2] | 列表左侧 checkbox + `x` 全选本页；底部浮动 ActionBar；**批量 AI 预审**是我们相对竞品的差异点 | 批量写操作（评论/approve）必须逐条确认，不能批量写 |
| **M6** | **键盘优先 / 命令面板** | 清空收件箱不该用鼠标 | GitHub 明确提供 notifications 快捷键 [S2]；Raycast 整个产品就是键盘 [S4] | `j/k` 移动、`Enter` 打开、`s` snooze、`e` done、`r` 回复、`a` AI 审查、`/` 搜索、`Cmd+K` 命令面板（跳条目/切视图/执行动作） | 快捷键与 DSH 既有键位冲突需先做一次冲突表 |
| **M7** | **AI 摘要（压缩长内容）** | 把 diff / 长线程 / 长日志压成「3 句结论 + 待办」 | VS Code PR 描述生成 + AI 审查 [S3]；Slack `Generate AI response` 步骤 [S5]；Raycast AI Commands [S4] | 卡片右侧默认显示「AI 一句话 + 风险徽章」；详细结论进详情页的 AI 抽屉（与 05 的 `ActionCard` 对齐） | 摘要过期问题：head 变更后必须重新计算并标 `stale` |
| **M8** | **一键跳转（Open in …）** | 任何条目都能一键回原系统做「只有那里能做」的事 | VS Code 状态栏跳 GitHub 页面 [S3]；GitKraken/主流工具通用做法 | 每条 `WorkItem` 有 `externalUrl`，`o` 直接开浏览器；详情页有「在 GitLab 打开 / 在本地打开 / 复制链接」 | 跳转后本地状态不同步 → 需要 M9 |
| **M9** | **自动收口（auto-resolve）** | 远端状态变化自动把本地条目置 done，减少「手动清零」成本 | GitLab：评论/关闭/合并/加标签都会自动 done，甚至 MR 合并会清掉失败流水线的 todo [S1] | `SourceAdapter.reconcile()`：每次轮询比对 `updatedAt` 与远端状态，规则表驱动（§3.3） | **误收口是最危险的 bug**（会在你没看时把条目吞掉）→ 必须「收口可撤销 + 收口日志」 |
| **M10** | **定时 + 阈值驱动的主动推送** | 不是实时打扰，而是「到点刷新出结论」 | Raycast Automations 定时跑 agent [S4]；GitHub/GitLab 的轮询产 todo [S1][S2] | 默认 5–10 分钟轮询 + 每日两次「晨报/晚报」聚合；AI 只在刷新时给增量 | 通知疲劳 → 默认**零桌面通知**，只有角标 |

### 1.3 反模式（我们从竞品身上学到的「不要做」）

| 反模式 | 谁踩过 | 我们的对策 |
|---|---|---|
| 把收件箱做成**通知流水**（每条 comment 一条） | GitHub 通知量大时的主要抱怨，官方用 reason 过滤缓解 [S2] | 以「对象 × 原因」聚合：一个 MR 只出现一条卡片，新事件累加计数 |
| **无法批量清理**，只能逐条点 done | GitLab 专门为此加了批量编辑 [S1] | 批量从 P0 就有 |
| **snooze 到点无声回来** | GitLab 到点回列表并标注原始创建时间 [S1] | 到点条目回到列表顶部并带 `snoozed-ago` 徽章 |
| AI 只给「总结」不给「下一步动作」 | 通用 AI 摘要工具的普遍问题 | 每条 AI 结论必须带 ≥1 个可执行 Action（§3.4），否则不上卡片 |
| 把 diff / 图表硬塞进窄卡片 | — | §3.6 的专用视图清单：四类内容不进卡片 |

---

## 2. 功能目录（44 项）

### 2.0 总览

| 域 | 编号区间 | 数量 | P0 | P1 | P2 |
|---|---|---|---|---|---|
| A 代码协作 | F01–F10 | 10 | 7 | 3 | 0 |
| B 质量与安全 | F11–F16 | 6 | 0 | 3 | 3 |
| C 需求与迭代 | F17–F22 | 6 | 0 | 3 | 3 |
| D 协作沟通 | F23–F27 | 5 | 0 | 0 | 5 |
| E 发布与运维 | F28–F33 | 6 | 0 | 2 | 4 |
| F 个人效能 | F34–F40 | 7 | 2 | 3 | 2 |
| G 平台能力（提示词/技能/运行） | F41–F44 | 4 | 2 | 2 | 0 |
| **合计** | | **44** | **11** | **16** | **17** |

> 评分口径：**价值**＝做完这件事少掉多少「真正的工程判断成本」；**频次**＝目标用户每周触发次数（5≈每天多次，1≈每月）；**成本**＝实现成本（5≈需要新数据源+新写接口+新视图）。
> 优先级判据：`价值×频次 / 成本` 为主，另叠加「是否 P0 审查闭环的必经环节」与「是否有写操作风险」。

### 2.1 A 代码协作（F01–F10）

依据：[S1][S2][S3]，以及团队 P0 目标（GitLab MR/Issue 轮询、审查队列、一键 AI 审查）。

| 编号 | 名称 | 触发信号 | 数据源 | 用户动作 | AI 可代劳 | 价值 | 频次 | 成本 | 优先级 |
|---|---|---|---|---|---|---|---|---|---|
| F01 | 待我审的 MR | `reviewer=me` 且 opened（GitLab 亦会生成 to-do） | `GET /merge_requests?reviewer_username=me&state=opened` | 打开→看结论→提交 review | 预审摘要 + findings + 风险徽章 | 5 | 5 | 3 | **P0** |
| F02 | 要求我改的 MR（我的改动被 request changes） | 我的 MR 存在 `unresolved discussions` 或 reviewer 要求修改 | MR discussions + approvals | 逐条回复 / 改代码 / 标记已解决 | 意见聚类→改法建议→回复草稿 | 5 | 4 | 3 | **P0** |
| F03 | 我提的 MR 收到新反馈 | 新 note / approval / change request | MR notes + approvals | 阅读、回应、推进 | 线程摘要 + 待办清单 | 4 | 4 | 3 | **P0** |
| F04 | 我的 MR 冲突 / 需 rebase | `merge_status=cannot_be_merged` / `has_conflicts` | MR detail | rebase / 解决冲突 / 通知作者 | 冲突文件定位 + 解决步骤建议 | 5 | 3 | 3 | **P0** |
| F05 | 我的 MR 流水线失败 | pipeline `failed`（GitLab 会生成 to-do） | pipelines + jobs | 看失败 job → 修 → 重跑 | 失败归因（测试/编译/环境）+ 修复建议 | 5 | 4 | 4 | **P0** |
| F06 | review 评论待回复 | 我参与的 MR 中有 @我 且未回复的 thread | discussions | 回复 | 回复草稿 | 4 | 4 | 4 | P1 |
| F07 | 合并后收尾 | MR `merged` | MR events + issue 关联 | 删分支 / 关 issue / 补 changelog / 通知 | 生成收尾清单 + changelog 条目 | 3 | 3 | 3 | P1 |
| F08 | 指派给我的 issue（代码类） | `assignee=me` 且 opened 且无关联 MR | issues API | 澄清→建分支→实现 | 澄清问题 + 任务拆解 + 分支命名 | 4 | 3 | 3 | P1 |
| F09 | 审查队列排序 | 队列非空 | 聚合：等待时长 + diff 规模 + 高风险路径 + CI 状态 | 决定先审哪个 | 风险打分 + 一句话理由 | 5 | 5 | 2 | **P0** |
| F10 | 一键 AI 审查（单 MR） | 用户显式点击 / 快捷键 `a` | diff + 全文 + 项目约定 | 发起→读结论→采纳/忽略→发布草稿 | 全流程（详见 05 §2） | 5 | 5 | 5 | **P0** |

> 说明：F09 是本域最被低估的一项。竞品都没有做「审查顺序的推荐」——它们只给列表，排序靠 `updated` 或手工 star。而审查者真正的痛点是「8 个 MR，我先看哪个」。

### 2.2 B 质量与安全（F11–F16）

依据：[S1]（GitLab「流水线失败进 to-do」印证「质量信号入收件箱」合理）、[S3]（PR 视图内嵌 checks 状态）。

| 编号 | 名称 | 触发信号 | 数据源 | 用户动作 | AI 可代劳 | 价值 | 频次 | 成本 | 优先级 |
|---|---|---|---|---|---|---|---|---|---|
| F11 | 流水线失败（我负责的项目/主干） | default branch 或我负责项目 pipeline failed | pipelines API | 归因→修→重跑→验证 | 失败聚类（同因合并）+ 影响面 | 4 | 3 | 4 | P1 |
| F12 | 依赖漏洞 / 待升级 | 新增漏洞 / Renovate·Dependabot 提 MR | dependency scanning / 升级 MR | 评估影响→升级或忽略（带理由） | 影响评估 + 升级 diff 摘要 + 破坏性变更提示 | 4 | 2 | 4 | P1 |
| F13 | 静态扫描新增告警 | SAST / CodeQL / Sonar 新增 issue | 扫描报告 API | 判真伪→修或标误报 | 真伪预判 + 修复建议 | 4 | 3 | 4 | P1 |
| F14 | 覆盖率下降 | 覆盖率 delta < 阈值（如 -2%） | CI coverage artifact | 看报告→补测试 | 未覆盖函数定位 + 测试草稿 | 3 | 2 | 4 | P2 |
| F15 | 安全审批阻塞 | 缺少 security approval | MR approvals | 找人 / 补证据 | 证据清单摘要 | 3 | 2 | 3 | P2 |
| F16 | 质量趋势（周对比） | 每周一 | 多源聚合 | 看趋势→定改进项 | 生成质量简报 | 3 | 1 | 4 | P2 |

### 2.3 C 需求与迭代（F17–F22）

依据：[S1]（issue 指派生成 to-do）、[S6]（Linear `Triage` = 先分诊再入 backlog 的架构信号）、[S3]（issue→分支→PR 的闭环）。

| 编号 | 名称 | 触发信号 | 数据源 | 用户动作 | AI 可代劳 | 价值 | 频次 | 成本 | 优先级 |
|---|---|---|---|---|---|---|---|---|---|
| F17 | 分派给我但未开始 | `assignee=me` & opened & 无进行中 MR | issues API | 排期 / 开始 / 退回 | 优先级建议 + 粗估工时 | 4 | 3 | 3 | P1 |
| F18 | issue 逾期 / 临期 | `due_date` 距今 ≤ 2 天或已过期 | issues API | 推进 / 改期 / 说明原因 | 风险提示 + 催促草稿 | 4 | 3 | 2 | P1 |
| F19 | 里程碑燃尽 / 迭代进度 | 迭代周期内 | milestones + issues 状态 | 看燃尽→调范围 | 进度摘要 + 风险项 | 3 | 1 | 4 | P2 |
| F20 | 需求澄清（描述不全） | 描述缺验收标准 / 缺复现 / 无影响面 | issue body | 提问 / 补 AC | 生成澄清问题 + AC 草案 | 5 | 3 | 2 | P1 |
| F21 | 验收清单未勾选 | DoD checklist 有未完成项 | issue body | 勾选 / 补做 | 校验完成度 | 3 | 2 | 3 | P2 |
| F22 | 迭代评审准备 | 迭代结束前 2 天 | issues + milestones | 汇总完成项 | 评审材料草稿 | 3 | 1 | 3 | P2 |

### 2.4 D 协作沟通（F23–F27）

依据：[S5]（Slack 列表/工作流把沟通变成可指派工作项）、[S4]（Raycast 把 Linear/GitHub/Slack/Mail/Calendar 连成一个入口）。本域**全部 P2**：数据源成本高、隐私敏感、且与 P0 审查闭环无耦合。

| 编号 | 名称 | 触发信号 | 数据源 | 用户动作 | AI 可代劳 | 价值 | 频次 | 成本 | 优先级 |
|---|---|---|---|---|---|---|---|---|---|
| F23 | IM 待办（@我未处理） | Slack/Teams 中 @我 且未回应/未加表情 | IM API | 回复 / 转为工作项 | 线程摘要 + 建议动作 | 3 | 4 | 5 | P2 |
| F24 | 邮件待办 | 未读且需要我动作 | 邮件 API | 回复 / 归档 / 转任务 | 分类 + 草稿 | 2 | 3 | 5 | P2 |
| F25 | 会议纪要→行动项 | 会议结束 / 纪要文档更新 | 纪要文本 | 确认行动项 → 建 issue | 抽取行动项 + 建 issue 草稿 | 3 | 2 | 4 | P2 |
| F26 | 日程冲突 / 专注时间保护 | 日历重叠 / 无空块 | 日历 API | 改期 / 拒绝 | 建议改期方案 | 2 | 3 | 4 | P2 |
| F27 | 有人问我问题未答 | IM/MR 中提问且未回 | IM / discussions | 回答 | 基于代码与历史的回答草稿 | 3 | 4 | 4 | P2 |

### 2.5 E 发布与运维（F28–F33）

依据：[S5]（工作流把「检查清单/审批/分诊」变成可执行步骤）、[S1]（merge train 移除等发布态事件会生成 to-do）。

| 编号 | 名称 | 触发信号 | 数据源 | 用户动作 | AI 可代劳 | 价值 | 频次 | 成本 | 优先级 |
|---|---|---|---|---|---|---|---|---|---|
| F28 | 发布单检查 | 进入发布窗口 / 打 tag 前 | release checklist（仓库文件）+ CI | 逐项确认 | 生成 checklist 核对报告（缺项高亮） | 3 | 2 | 3 | P1 |
| F29 | changelog / Release notes | 版本发布前 | 已合并 MR 列表 + commit | 审阅后发布 | 生成分类 changelog（feat/fix/breaking） | 4 | 2 | 3 | P1 |
| F30 | 告警值班 / 交接 | on-call 轮值、未关闭告警 | PagerDuty / 告警 API | 接管 / 升级 / 交接 | 告警摘要 + 相似历史事故 | 3 | 2 | 5 | P2 |
| F31 | 错误率 / 性能异常 | SLO 越界（错误率、P95） | 指标 API（Prometheus） | 定位 → 回滚 | **关联近期 MR** 的异常归因 | 3 | 2 | 5 | P2 |
| F32 | 日志 / 异常排查 | 错误日志 spike | 日志平台 API | 查询 / 过滤 | 日志聚类 + 根因假设 | 3 | 2 | 5 | P2 |
| F33 | 部署后验证 | 部署完成 | CI/CD + 健康检查 | 验证 / 回滚 | 验证清单 + canary 对比 | 3 | 2 | 4 | P2 |

### 2.6 F 个人效能（F34–F40）

依据：[S4]（Raycast Automations = 定时产出周报类成果；AI Commands = 提示词变快捷键）、[S3]（issue→分支→PR 的本地闭环）。

| 编号 | 名称 | 触发信号 | 数据源 | 用户动作 | AI 可代劳 | 价值 | 频次 | 成本 | 优先级 |
|---|---|---|---|---|---|---|---|---|---|
| F34 | 今日计划（Top3） | 每日首次打开面板 | 收件箱 + 已排期项 | 选定 3 项 + 时间块 | 推荐 Top3 + 理由（等待时长/阻塞他人/风险） | 4 | 5 | 2 | P1 |
| F35 | 日报 / 周报草稿 | 周五 17:00 / 每日 18:00 | 本周收件箱处理记录 + 已合并 MR | 审阅、编辑、导出 | 生成草稿（按项目/按价值排序） | 5 | 2 | 3 | P1 |
| F36 | 知识沉淀（ADR / wiki） | 决策发生 / 问题解决 | MR 讨论 + AI 会话 | 写文档 | 结构化沉淀草稿 | 3 | 2 | 3 | P2 |
| F37 | 技术雷达 | 每周 | 依赖升级 + 新版本公告 | 阅读评估 | 摘要 + 影响判断 | 2 | 1 | 4 | P2 |
| F38 | 本地 Git 卫生 | 本地存在未提交/未推送/陈旧分支 | 本地 git（worktree） | 提交 / 推送 / 删分支 / 开 MR | 建议清理方案 + 生成 commit message | 5 | 5 | 2 | P1 |
| F39 | 待办收口（inbox zero） | 每日结束 | 收件箱状态 | 批量 done / snooze | 建议批量处理（低价值项一键 snooze） | 4 | 5 | 1 | P1 |
| F40 | 专注模式 | 工作时段开始 | 设置 | 一键静音 + 暂停轮询 | — | 3 | 3 | 1 | P2 |

> F38 是本文件最推荐的「低成本高感知」项：只需读本地 git 状态（DSH 已有 `worktree` 能力），却直接消灭「改完没提交、提交没推送、分支忘删」这三类真实焦虑。竞品中只有 IDE 侧零散提示，没有统一面板。

### 2.7 G 平台能力（F41–F44，提示词与技能管理）

依据：团队 P0 目标明确要求「提示词与技能管理」；[S4] 证明「提示词绑定快捷键」是可用产品形态；与 05 的 `PromptTemplateStore` / `SkillBridge` 对齐。

| 编号 | 名称 | 触发信号 | 数据源 | 用户动作 | AI 可代劳 | 价值 | 频次 | 成本 | 优先级 |
|---|---|---|---|---|---|---|---|---|---|
| F41 | 提示词库管理 | 用户新建/编辑/试跑 | 插件自有存储 | 编辑、变量填写、试跑、版本化 | 由自然语言生成模板草稿 | 4 | 3 | 4 | **P0** |
| F42 | 技能（Skill）绑定 | 用户为某类 MR 绑定审查方法 | DSH skills | 启用/禁用/绑定到模板 | 从现有 skill 生成模板要点 | 3 | 2 | 4 | **P0** |
| F43 | AI 运行历史与结果复用 | 审查完成 | 插件自有存储 | 回看、对比两轮、增量重审 | 复用结论 + 只审新增 commit | 4 | 3 | 3 | P1 |
| F44 | 命令面板 / 统一搜索 | `Cmd+K` | 全源索引 | 跳条目、切视图、执行动作 | 自然语言 → 过滤条件 | 4 | 5 | 2 | P1 |

---

## 3. 统一模型验证

### 3.1 四个抽象

| 抽象 | 一句话定义 | 它负责「不变的东西」 | 它**不**负责 |
|---|---|---|---|
| **WorkItem** | 一条「需要我动作」的事，无论来自 MR、pipeline、issue、日志告警还是本地 git | 收件箱状态机（open / snoozed / done）、`reason`、优先级、去重键、AI 结论挂载 | 源系统特有字段的**语义**（放在 `payload`，按 `kind` 解释） |
| **SourceAdapter** | 一个数据源的采集与回写适配器 | 轮询/增量游标、原始对象 → WorkItem 映射、reconcile 收口规则、能提供的 Action 列表 | 视图渲染、AI 提示词内容 |
| **Action** | 一个可对 WorkItem 执行的动作（含 AI 生成类） | 输入参数 schema、是否需要确认、是否写远端、幂等键、结果落地方式 | 具体 UI 排版 |
| **Skill/Prompt** | 可复用的「怎么做」——提示词模板 + 技能绑定 | 变量、检查清单、输出格式、模型参数、适用范围 | 数据采集（那是 Adapter） |

### 3.2 WorkItem 字段（可直接作为存储结构讨论稿）

```jsonc
{
  "id": "gitlab:mr:group/app!1234",       // 全局稳定 ID = source:kind:externalKey
  "source": "gitlab",                      // adapter id
  "kind": "mr",                            // mr | pipeline | issue | alert | log | local-git
  "externalKey": "group/app!1234",
  "externalUrl": "https://gitlab.../-/merge_requests/1234",
  "title": "feat: 支持批量导出",
  "subtitle": "alice → main · +312/-88 · 3 个文件待复核",
  "reason": "review_requested",            // 触发原因（第一等字段，见 M2）
  "reasonDetail": { "requestedBy": "alice", "at": "..." },
  "state": "open",                         // open | snoozed | done（本地状态机）
  "snoozedUntil": null,
  "lifecycle": "opened",                   // 远端原状态：opened/merged/closed/failed/succeeded
  "project": { "path": "group/app", "name": "app" },
  "actors": [{ "role": "author", "name": "alice" }],
  "labels": ["backend", "needs-review"],
  "priority": { "score": 82, "band": "high", "why": "等 2 天 + 触及 auth 目录 + 无测试" },
  "timestamps": { "createdAt": "...", "updatedAt": "...", "waitingSince": "...", "dueAt": null },
  "payload": { "iid": 1234, "headSha": "abc123", "checksRollup": "failed", "unresolvedThreads": 2 },
  "capabilities": ["review.ai", "review.comment", "review.approve", "mr.rebase", "open.external"],
  "ai": { "summary": "…", "verdict": "comment", "confidence": 0.72, "computedForHead": "abc123", "computedAt": "..." },
  "dedupeKey": "gitlab:mr:group/app!1234:review_requested:alice",
  "cursor": { "etag": "W/\"…\"", "lastSeenAt": "..." }
}
```

**关键设计决策**

| 决策 | 理由 | 反面 |
|---|---|---|
| `state` 与 `lifecycle` 分离 | 本地 done/snooze 与远端 merged/closed 是两个正交维度；GitLab 的 to-do 正是「本地 todo 状态 + 远端对象状态」双轨 [S1] | 合成一个字段 → 无法表达「已 snooze 但已被合并」 |
| `reason` 必填且枚举 | 分组、排序、动作白名单都依赖它 | 自由文本 reason → 无法分组 |
| `payload` 只做**惰性读取** | 列表页只需要 10 个字段；diff / 日志 / 讨论要进详情才拉 | 把 diff 塞进列表项 → 首屏卡死 |
| `ai` 带 `computedForHead` | head 一变结论即失效，必须能判 `stale`（05 §2.7.2 同款语义） | 复用旧结论 → 错误 approve 风险 |
| `capabilities` 存在条目上 | 不同 kind 能做的动作不同（MR 可 approve，pipeline 不能）；UI 只渲染条目声明的动作 | 全局动作表 → 点进去一堆不可用按钮 |

### 3.3 SourceAdapter 契约（设计态）

```ts
interface SourceAdapter {
  id: string                       // 'gitlab' | 'github' | 'local-git' | ...
  displayName: string
  configSchema: ObjectJsonSchema   // 连接配置（host/token/projects）
  capabilities: {
    poll: boolean                  // 是否支持轮询（P0 基本都靠轮询）
    webhook?: boolean              // 可选加速
    detail: boolean                // 是否能拉详情
    writeBack: boolean             // 是否有写接口（评论/approve/标记 done）
  }
  // 采集：增量优先，游标必须可持久化
  poll(ctx: PollContext, cursor: Cursor | null): Promise<{ items: RawItem[]; nextCursor: Cursor }>
  // 映射：纯函数，禁止 IO（便于单测与回放）
  toWorkItems(raw: RawItem): WorkItem[]
  // 详情：按需拉取（diff / 讨论 / 日志）
  detail?(item: WorkItem, signal: AbortSignal): Promise<DetailPayload>
  // 动作：返回该条目当前可用的动作（含禁用原因）
  actions?(item: WorkItem): ActionDescriptor[]
  // 回写：一律经过确认闸门（05 的 actionCards verb writes:true）
  apply?(action: ActionInvocation, signal: AbortSignal): Promise<ActionResult>
  // 收口：远端快照 vs 本地条目 → upsert/close 建议（M9）
  reconcile?(snapshot: RawItem[], local: WorkItem[]): ReconcilePlan
}
```

**reconcile 的规则表（防「误收口」的核心）**

| 远端变化 | 本地动作 | 是否可撤销 |
|---|---|---|
| MR 被合并 / 关闭 | `state=done`，`lifecycle=merged/closed` | 是（Done Tab 可 restore，学 GitLab [S1]） |
| review 已被我提交 | 相关 `review_requested` 条目 done | 是 |
| 我的评论已回复（thread 有我的 note） | 「待回复」条目 done | 是 |
| pipeline 重跑成功 | 失败条目 done，附「已恢复」记录 | 是 |
| 条目从远端消失（无权限/删除） | 软删除 + 标记 `sourceVanished` | 是（保留 30 天） |
| **仅因 `updatedAt` 变化** | **不做任何收口** | —（最易误判的一条，禁止） |

### 3.4 Action 契约（与 05 的 `ActionRegistry` 对齐）

```jsonc
{
  "id": "review.ai",
  "label": "AI 审查",
  "appliesTo": ["mr"],
  "input": { "type": "object", "properties": { "templateId": {"type":"string"}, "depth": {"enum":["quick","full"]} } },
  "confirm": false,               // 只读/生成类不需确认
  "writes": false,                // 不写远端
  "idempotencyKey": "{{item.id}}:{{item.payload.headSha}}:{{input.templateId}}",
  "outputKind": "review-result",  // 落地为 ActionCard（05 §2.8）
  "batchable": true,              // 可批量执行（M5 的批量 AI 预审）
  "costHint": "medium"
}
```

| Action 族 | 例子 | `writes` | 批量 | 备注 |
|---|---|---|---|---|
| 只读生成 | `review.ai`、`summarize.thread`、`explain.ci-failure`、`draft.changelog` | false | ✅ | 结果进 ActionCard，人决定是否落地 |
| 本地写 | `git.commit`、`git.push`、`branch.delete`、`worktree.create` | true（本地） | ⚠️ 单条 | 在沙箱/worktree 内，仍要确认 |
| 远端写 | `review.comment`、`review.approve`、`mr.rebase`、`todo.done(remote)` | true | ❌ **禁止批量** | 必须逐条确认，且 approve 永不自动（05 D6） |
| 状态写（本地） | `item.done`、`item.snooze`、`view.save` | false（本地状态） | ✅ | 收件箱清空的主力 |

### 3.5 44 项适配分级（A  snug / B  轻量专用 / C  必须专用面板）

**A 级（snug：一张卡片 + 通用详情抽屉 + 通用 Action 即可）—— 31 项**

| 编号 | 为什么 snug |
|---|---|
| F01 F03 F06 F07 F08 F09 F17 F18 F20 F21 F22 F23 F24 F25 F26 F27 F28 F30 F34 F35 F36 F37 F39 F40 F41 F42 F43 F44 | 这些项的本质是「一个对象 + 一句结论 + 2–4 个动作」。GitHub/GitLab 用纯列表就承载了同类需求 [S1][S2]，说明抽象足够 |
| F12 F13 | 需要的是「影响评估 + 升级/忽略」两个决策，diff 细节可跳外链 |
| F02（前半） | 「意见聚类 + 逐条回复」可先在卡片里做清单，只有展开讨论树时才需要 B 级视图 |

**B 级（套用统一模型，但详情区需要 1 个轻量嵌入构件）—— 9 项**

| 编号 | 需要的构件 | 为什么不能纯列表 |
|---|---|---|
| F02（后半） | 讨论树（thread + 折叠 + resolved 态） | 回复的动作依赖上下文位置 |
| F04 | 冲突文件列表 + 侧并 diff 摘要 | 冲突必须看代码 |
| F05 F11 | job 列表 + 日志**摘要**（首尾 + 错误行） | 需要「失败在哪一行」才敢重跑 |
| F14 F16 | 覆盖率 delta 迷你条形/趋势线 | 单个数字无意义，需要对比 |
| F19 | 燃尽图（小尺寸也必须是图） | 折线形态本身就是信息 |
| F29 | 分组式 diff 摘要（feat/fix/breaking 分栏） | 要审阅分类正确性 |
| F33 | 部署步骤时间线（步骤 + 状态 + 耗时） | 顺序与耗时是判断依据 |

**C 级（必须专用面板，不能塞进卡片或抽屉）—— 4 项**

| 编号 | 专用视图 | 硬需求 |
|---|---|---|
| F10（+F01 的深审） | **双栏 diff 审查器**：文件树 + 双栏 diff + 行级评论 + findings 定位 + AI 抽屉 | 同屏比对、逐行落评论，宽度与高度都要占满；VS Code 的 Review Mode 就是这种形态 [S3] |
| F31 | **指标时序面板**：多指标折线 + 时间窗 + 事件标注（部署/MR 合并） | 需要对齐时间轴与事件 |
| F32 | **日志流面板**：虚拟滚动 + 高亮 + 过滤 + 跟随模式 | 数据量级与交互形态完全不同于列表 |
| F19（完整版） | **燃尽/迭代面板**：燃尽线 + 范围变更 + 未完成项下钻 | 需要图 + 下钻联动 |

> 印证 C9：**31/44 ≈ 70% 可用统一抽象承载**；剩下的 13 项里，9 项只是「详情区换构件」，只有 4 项必须独立面板。这直接决定 §5 的分批。

### 3.6 需要新增的 UI 构件清单

| # | 构件 | 用途 | 服务哪些功能 | 复杂度 | 批次 |
|---|---|---|---|---|---|
| U1 | `InboxList` + `WorkItemCard` | 收件箱主体：分组头、计数、最老等待时长、reason 徽章、AI 一句话、风险徽章 | 全部 A 级 | 3 | **P0** |
| U2 | `ReasonBadge` + `PriorityPill` | `待我审/要我改/我提的/失败/逾期` 的稳定配色与文案 | F01–F05、F17–F18 | 1 | **P0** |
| U3 | `SnoozeMenu` | 1h / 4h / 明早 8 点 / 自定义；Snoozed Tab；到点回列表标注原始时间（学 GitLab [S1]） | 全部 | 2 | **P0** |
| U4 | `FilterBar` + `SavedViewChips` | 过滤条件可视化 + 「另存为视图」；内置 4 个视图（学 GitHub 15 个自定义过滤器 [S2]） | 全部 | 3 | **P0** |
| U5 | `BulkActionBar` | 勾选后浮出：done / snooze / 加入今日 / 批量 AI 预审（学 [S1][S2]） | 全部 | 2 | **P0** |
| U6 | `CommandPalette`（Cmd+K） | 跳条目、切视图、执行动作、自然语言转过滤 | F44 | 3 | P1 |
| U7 | `DetailSplitPane` | 列表右侧（或整页）详情：头部元信息 + 动作条 + 内容区 | A/B 级 | 3 | **P0** |
| U8 | `AIDrawer` | AI 结论抽屉：结论 / findings 列表 / 覆盖度 / 采纳与忽略 / 追问入口（与 05 的 ActionCard 一致） | F01–F03、F10、F35 | 4 | **P0** |
| U9 | `DiffViewer`（双栏 + 行级评论） | 审查专用：文件树、并排 diff、逐行评论、findings 跳转、折叠未变更 | F10、F02、F04 | 5 | **P0** |
| U10 | `CommentComposer` | 评论/回复编辑：模板插入、@人、草稿保存、「发布需确认」闸门 | F02、F06、F10 | 3 | **P0** |
| U11 | `PromptLibraryEditor` | 提示词模板：变量高亮、检查清单开关、试跑、版本对比 | F41 | 4 | **P0** |
| U12 | `SkillBinder` | 技能列表 + 绑定到模板/视图 + 生效范围说明 | F42 | 3 | **P0** |
| U13 | `RunHistoryPanel` | AI 运行历史：按 MR 聚合、两轮对比、增量重审入口 | F43 | 3 | P1 |
| U14 | `DiscussionTree` | 讨论树：thread 折叠、resolved 态、我是否已回复 | F02、F06 | 3 | P1 |
| U15 | `MiniTrend` / `Sparkline` | 覆盖率、错误率的小型趋势 | F14、F16 | 2 | P1 |
| U16 | `JobList` + `LogDigest` | CI job 列表 + 日志首尾与错误行摘要 | F05、F11 | 3 | P1 |
| U17 | `ReportComposer` | 日报/周报：结构化草稿 + 逐段编辑 + 导出（markdown/剪贴板） | F35 | 3 | P1 |
| U18 | `GitHealthPanel` | 本地 git 卫生：未提交/未推送/陈旧分支 + 一键处置 | F38 | 2 | P1 |
| U19 | `BurnDownChart` | 燃尽图 + 范围变更标记 | F19 | 4 | P2 |
| U20 | `LogStreamViewer` | 日志流：虚拟滚动、过滤、跟随 | F32 | 5 | P2 |
| U21 | `MetricTimeline` | 多指标时序 + 事件标注 | F31 | 5 | P2 |
| U22 | `ConnectorStatus` | 连接健康：上次轮询时间、配额、失败原因、重试 | 全部（运维必需） | 2 | **P0** |
| U23 | `ToastUndo` | 收口/批量操作后的「撤销」（M9 的安全网） | 全部 | 2 | **P0** |
| U24 | `KeyboardHelp` | 快捷键速查（`?` 呼出） | M6 | 1 | P1 |

---

## 4. 场景走查（3 个）

### 4.1 场景 A：早晨 15 分钟清空收件箱

**设定**：09:00，昨日累计 37 条（含 6 条 snooze 到点回归）。目标：15 分钟内把队列降到「可解释的 5 条以内」。

| 时间 | 动作 | UI / 键 | AI 参与 | 验收 |
|---|---|---|---|---|
| 0–1 min | 打开面板看角标与分组 | 首页默认 `SavedView=今天`，按 reason 分组，组头显示「6 条待我审 · 最老 2.1 天」 | 顶部「晨报」一句：`今天 3 件会阻塞别人` | 3 秒内判断「今天大概什么节奏」 |
| 1–3 min | 先处理「阻塞他人」组（F01） | `j/k` 浏览，`a` 触发批量 AI 预审（6 条并行，只出摘要） | 每张卡显示 verdict + 风险徽章 + 一句话 | 6 条全部有结论，无需开浏览器 |
| 3–6 min | 快速分流 | `s` snooze 低优先（2 条到「明天 8 点」）；`e` 直接 done（3 条已过时）；`x` 全选 → 批量 done | 建议器提示「2 条 CI 已恢复，可一键收口」 | 队列 37 → 22 |
| 6–11 min | 深审 2 个高风险 MR | `Enter` 进双栏 diff（U9），`f` 在 finding 间跳转；`c` 针对行评论（草稿） | AI findings 逐条定位到行；`Tab` 采纳→插入评论草稿 | 2 个 MR 各留 1–3 条评论草稿，全部**待确认** |
| 11–13 min | 处理「我提的 MR」（F03/F04/F05） | 冲突条目显示「rebase 建议」；CI 失败条目打开日志摘要（U16） | 失败归因一句话 + 修复建议 | 3 条转成「今日要做」，进 F34 |
| 13–15 min | 收尾 | 选定 Top3（F34）；剩余条目批量 snooze（F39） | 推荐 Top3 + 理由 | 队列 ≤ 5 条且有明确下次时间 |

**失败与降级**：轮询失败 → 顶部黄条「数据可能过期 12 分钟」+ `ConnectorStatus`（U22）给出原因；AI 超时 → 卡片保留「重试」按钮，不阻塞清空流程（**清空收件箱不能依赖 AI 成功**）。

### 4.2 场景 B：审查高峰 1 小时（4 个 MR）

| 阶段 | 时长 | 动作 | UI | 关键设计点 |
|---|---|---|---|---|
| 排序 | 3 min | 打开 `待我审` 队列，按 F09 的风险分排序 | 队列卡显示「等待 2 天 / 312 行 / 触及 auth / 无测试」 | 排序理由必须**可见**，否则用户不信 |
| 预审 | 6 min | 4 条并行 `review.ai`（quick 模式） | AIDrawer 顶部结论 + 覆盖度 + findings 计数 | 并行上限 3–4，超出排队（05 §6.2） |
| 深审 1 | 15 min | MR#1 进双栏 diff | U9：文件树 + 折叠已审 + 行级评论 | 已审文件自动置灰，返回时高亮下一未审文件 |
| 深审 2 | 12 min | MR#2 只审 AI 标红的 3 处 | `f` 跳转 findings | 人只做「判断 AI 对不对」，不做全量遍历 |
| 评论 | 10 min | 采纳 findings → 编辑草稿 → 逐条确认发布 | U10 + 确认闸门（05 `writes:true`） | **永不一键发布全部**；每条可编辑 |
| 结论 | 6 min | 对 2 个低风险 MR 走「AI 建议通过 → 我确认 approve」 | 按钮文案必须是「以我的名义提交 approve」 | 人在回路，AI 不代签 |
| 收尾 | 8 min | 剩余 2 个 MR：request changes + 说明；snooze 到下午 | — | 每个 MR 关闭时问一句「是否需要我通知作者」（默认否） |

**量化目标**：4 个 MR 从「平均 25 分钟/个」压到「15 分钟/个」，其中 AI 贡献主要在**定位**（找哪儿值得看），人贡献在**判断**。

### 4.3 场景 C：周五出周报

| 步骤 | 时长 | 动作 | 数据 | AI | 风险控制 |
|---|---|---|---|---|---|
| 1 收集 | 自动 | 周五 16:30 定时任务聚合本周 | 已合并 MR / 已关闭 issue / 处理过的收件箱条目 / snooze 记录 | — | 只读收集，不改任何远端状态 |
| 2 生成 | 1 min | `draft.weekly` Action（F35） | 同上 + 我写的 review 评论（体现「我做了什么判断」） | 按项目分组、按价值排序、标出「未完成项与原因」 | 必须**引用真实条目 ID**，不许编造；无法归类的进「其他」 |
| 3 校对 | 5 min | `ReportComposer`（U17）逐段编辑 | — | 「这段是否夸大？」自检提示 | 每个数字可点回原条目 |
| 4 导出 | 1 min | 复制为 IM 消息 / markdown 文件 | — | 生成两个版本：详版（含链接）/ 简版（3 条要点） | 导出前显示「将包含 N 个链接」 |
| 5 收尾 | 2 min | 未完成项转入下周 Top3 | 收件箱 | 推荐下周 Top3 | 用户确认后才写入 |

> 关键：周报的价值不在「生成文本」，而在**它逼迫系统把「我这周到底做了什么」沉淀成可核对的结构**。这也反向要求 `WorkItem` 要记录 **done 的原因与时间**（M9 的副产品）。

---

## 5. 分批与优先级

### 5.1 P0 / MVP（11 项功能 + 12 个构件）

| 项 | 内容 | 为什么必须是 P0 |
|---|---|---|
| 功能 | F01 待我审、F02 要我改、F03 我提的反馈、F04 冲突、F05 CI 失败、F09 队列排序、F10 一键 AI 审查、F34 今日计划、F38 本地 Git 卫生、F41 提示词库、F42 技能绑定 | 前 7 项构成**一条完整闭环**：进来 → 排序 → 预审 → 深审 → 写评论 → 收口。少任何一环，闭环就断在浏览器里。F34/F38 是「每天都用」的钩子，F41/F42 是团队既定 P0 |
| 构件 | U1 U2 U3 U4 U5 U7 U8 U9 U10 U11 U12 U22 U23 | U9（双栏 diff）是唯一的高复杂度必需项；U22（连接健康）+ U23（撤销）是「敢用」的前提 |
| 不做 | 任何**自动** approve / merge；任何 webhook；任何第二数据源 | 05 的 D6 + 本文件 C10 |

### 5.2 P1（16 项）

| 项 | 内容 | 理由 |
|---|---|---|
| 功能 | F06 评论待回复、F07 合并后收尾、F08 指派 issue、F11 流水线失败、F12 依赖漏洞、F13 静态扫描、F15 安全审批、F17 issue 未开始、F18 issue 逾期、F20 需求澄清、F28 发布单、F29 changelog、F35 周报、F43 运行历史、F44 命令面板 | 共同特征：**数据源已在 P0 接通或只差一个 API**，且能显著稀释「只做 MR 审查」的产品印象。F35 是留存关键（周五必用） |
| 构件 | U6 U13 U14 U15 U16 U17 U18 U24 | 都是「详情区换构件」，不改变信息架构 |
| 顺序建议 | F35 → F06 → F11 → F17/F18 → F12/F13 → 其余 | 先做「每周必用」和「每天必看」 |

### 5.3 P2（17 项）

| 项 | 内容 | 理由 |
|---|---|---|
| 功能 | F14 覆盖率、F16 质量趋势、F19 燃尽、F21 验收清单、F22 评审准备、F23 IM、F24 邮件、F25 会议纪要、F26 日程、F27 待回答、F30 值班、F31 指标异常、F32 日志、F33 部署验证、F36 知识沉淀、F37 技术雷达、F40 专注模式 | 每一项都**需要新数据源**或**新专有视图**（U19/U20/U21），且与审查闭环无耦合。C 级 4 项里 3 项落在这里 |
| 触发条件 | 只有当 P0/P1 的周活跃 ≥ 某阈值、且用户明确要求某域时才做 | 避免做成「8 个数据源的半成品」 |

### 5.4 通用列表 vs 专用面板（判定表）

| 判据 | 走通用列表（A） | 走详情嵌入（B） | 必须专用面板（C） |
|---|---|---|---|
| 内容形态 | 文本 + 徽章 + 计数 | 小图 / 短日志 / 树 | 双栏 diff / 时序 / 流式日志 / 坐标图 |
| 决策粒度 | 「做 / 不做 / 稍后」 | 「看哪一处」 | 「逐行判断」 |
| 同屏要求 | 单条即可 | 2 个对象对照 | 3+ 对象同屏（文件树 + diff + 评论） |
| 面积需求 | ≤ 1/3 宽 | 1/2 宽 | 全宽或全页 |
| 我们的实例 | F01/F09/F17/F35 等 31 项 | F02/F04/F05/F14/F19/F29/F33 | F10、F31、F32、F19 完整版 |

### 5.5 依赖与实施顺序

```
P0 基建：WorkItem 存储 + SourceAdapter(gitlab) + 收件箱三态 + Action 闸门
   ↓
P0 闭环：F01/F02/F03/F09 → F10（含 U9 双栏 + U8 AI 抽屉）→ U10 评论草稿 → 收口
   ↓
P0 钩子：F34 今日计划 / F38 本地 Git 卫生 / F41·F42 提示词技能
   ↓
P1 扩容：F35 周报 → F06/F11 → F17/F18 → F12/F13 …
   ↓
P2 专用视图：U19/U20/U21（燃尽/日志/指标）
```

---

## 6. 风险与开放问题

| # | 风险 / 开放问题 | 影响 | 建议 |
|---|---|---|---|
| R1 | **误收口**：`reconcile` 规则写宽了会在用户没看时把条目吞掉 | 高（信任崩塌） | 规则表白名单化（§3.3），只认显式远端状态；所有收口可撤销 + 记日志（U23） |
| R2 | **轮询配额**：MR + pipeline + issue + 讨论多路轮询，GitLab 有速率限制 | 高 | 分层轮询（收件箱 5–10 min，详情按需，历史 24h）；`ConnectorStatus` 暴露配额 |
| R3 | **写操作越权**：评论 / approve / rebase 都需要写权限与二次确认 | 高 | 一律走确认闸门；approve 永不自动（05 D6）；权限不足时禁用按钮并说明原因 |
| R4 | **AI 结论过期**：head 变了但结论还在 | 中高 | `computedForHead` + 卡片显式「结论基于旧 commit，点击重审」 |
| R5 | **AI 误报污染信任** | 中高 | 05 的 suppression 机制 + 「标误报」反馈闭环；卡片上显示 FP 率 |
| R6 | **通知疲劳** | 中 | 零桌面通知，只做角标；晨报/晚报两次聚合 |
| R7 | **多源 ID 冲突与去重**：同一件事（MR 评论）可能同时触发「待回复」与「我提的反馈」 | 中 | `dedupeKey = source+kind+externalKey+reason`，同 key 累加计数不新增卡片 |
| R8 | **隐私**：日志、邮件、IM 内容进入 AI 上下文 | 高（若做 P2） | P2 域默认关闭；日志只发「摘要 + 首尾行」；提供「本地模型」选项（Raycast 的 local model 思路 [S4]） |
| R9 | **DSH 键位冲突**：`Cmd+K`、`j/k` 等可能与宿主快捷键冲突 | 中 | 先做一次冲突表，冲突项可重绑定 |
| R10 | **Jira 域取证不足**（本轮仅标题级 [S7]） | 低（当前不接 Jira） | 若要接 Jira，需先补一手文档：`Your work` 页、JQL 保存过滤器、订阅式摘要的准确行为 |
| R11 | **Linear 机制仅结构级** [S6] | 低 | 若要抄 Linear 的 Triage 队列，需补 `Triage` / `Triage Intelligence` 正文 |
| R12 | **「我的 agent」维度未被覆盖**：GitKraken Kepler 指向「多个 agent 会话的指挥台」[S8] | 中（未来） | 建议单列一条 P2 愿景：`AgentRun` 作为一种 WorkItem（kind=`agent-run`），复用同一收件箱与状态机 |

---

## 附录 A · 来源清单（本轮 `web_fetch` 实测）

| ID | URL | 抓取状态 | 备注 |
|---|---|---|---|
| S1 | https://docs.gitlab.com/user/todos/ | 200，完整正文 | To-Do List：生成规则、Snooze 预设、分组、批量、自动 done、排序、权限回收删除 |
| S2 | https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications | 200，完整正文 | reason 标签、Saved/Done/Unsubscribe、保留策略、自定义过滤器入口 |
| S2b | https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/managing-notifications-from-your-inbox | 200，完整正文 | 五种 triage 动作表、批量 triage、默认过滤器、**最多 15 个自定义过滤器**、`is:` 查询 |
| S3 | https://code.visualstudio.com/docs/sourcecontrol/github | 200，完整正文（`.md` 版） | Pull Requests/Issues 视图、Review Mode、`githubPullRequests.queries`、issue→分支→PR、AI 生成描述、AI 代码审查 |
| S4 | https://www.raycast.com/core-features/ai | 200，完整正文 | AI Commands（提示词→快捷键）、Projects、Automations、Quick AI、BYOK/本地模型 |
| S5 | https://slack.com/features/task-list | 200，完整正文 | Lists：负责人、截止日期、工作流内嵌、Slack Connect 共享 |
| S5b | https://slack.com/features/workflow-automation | 200，完整正文 | AI 生成工作流、`Generate AI response` 步骤、条件分支上限 15、70+ 连接器 |
| S6 | https://linear.app/docs/inbox · https://linear.app/docs/triage | 200，**正文被导航截断** | 仅取到文档侧边结构：Inbox / Triage / Notifications / My Issues / Custom Views / Favorites / Reviews(diffs) / Triage Intelligence / Loops / Linear Asks |
| S7 | https://www.atlassian.com/software/jira/features · https://www.atlassian.com/blog/company-news/ai-sdlc | 200，**仅标题** | Jira "Your work" 一手文档在本环境多次 404（尝试路径见 §0.2），不作机制断言 |
| S8 | https://www.gitkraken.com/ · https://www.gitkraken.com/kepler | 200，仅导航/标题 | Kepler：`Mission Control for Agent-driven Development` |

> 抓取失败/受限：`r.jina.ai`（代理不可用）、DuckDuckGo/Bing 搜索页（不可用）、`support.atlassian.com` 多个 Jira 文档 slug（404）。这些**没有被用来支撑任何结论**。

## 附录 B · 与其他研究文档的接口约定

| 对接方 | 本文件提供 | 期望对方提供 |
|---|---|---|
| `research/05-ai-review.md`（AI 代劳层） | 需要被 AI 承载的**对象清单**（44 项 + 各自「AI 可代劳」）、Action 族划分（§3.4）、AI 结论的 UI 落点（U8/U9） | `ActionRegistry` 的最终 Action 列表与 `writes` 语义；`ReviewResult` schema 与本文件的 `ai` 字段对齐 |
| 平台可行性（01） | 轮询分层与配额诉求（R2）、`ConnectorStatus` 的运维面（U22）、通知/角标机制 | `schedule` / `timer` 的可用粒度；宿主快捷键冲突表 |
| GitLab 集成（02） | 每个 P0 条目所需的最小字段集（§3.2 的 payload 示例）与写接口清单（评论/approve/rebase） | `GET /merge_requests?reviewer_username=me` 等端点的分页与 etag 语义；讨论（discussions）的 resolved 字段 |
| UX（04） | 交互模式 M1–M10、场景走查的时间预算、构件清单 U1–U24 | 信息架构落位（哪些是 Tab、哪些是抽屉）、线框与状态规范 |

---

*本文件为研究与设计产出，不含实现承诺；所有数值评分是可讨论的初值，用于排序而非精确度量。*