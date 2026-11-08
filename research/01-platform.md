# 01 · DSH 平台可行性：整页大面板 + GitLab 工作中台

- 研究人：platform-architect（daily-work-hub-design / t1）
- 时间：2026-11-08
- 被研究的宿主：DSH Desktop 0.13.2（Electron 外壳）内嵌 `@deepseek-ai/dsh 0.2.2-alpha.2`；profile = `web`；Web GUI `http://127.0.0.1:43129`
- 证据等级：`✔已验证` = 本次通过 `cordis_inspect_query` 精确签名或 app.asar / profile 内真实源码片段确认；`?待验证` = 有间接证据、需装一个最小插件或点开页面才能定论
- 交付边界：本文件只做研究与方案，不安装插件、不写实现代码、不改 profile

## 0. 结论速览

| 项 | 结论 | 置信度 |
|---|---|---|
| A 面板接入 | 可行且是官方唯一"整页"路径：`sidebar.panellist`（list）+ `main`（keyed，key 任意字符串）+ `ctx.layout.selectPanel(id)` | ✔ |
| B 数据通道 | plain-JS 客户端 bundle **不能**用 `@Remote`/typert（无构建期生成）；走 `connection.fetch.register` 或 `webServer.register` + `connection.requestRejection`。SSE 可行，但首选 2–5s 轮询 + ETag | ✔（除 Desktop `dsh-app://` 场景） |
| C 持久化 | PAT → credentials；实例/范围/间隔 → plugin `Config`（settings 自动出表单）；提示词库/已读/归档/审计 → `storageDomain`；UI 偏好 → localStorage | ✔ |
| D 一键 AI 审查 | 面板 → Host 服务 → `ctx.agents.create()` 建真实 Session（`setup` 注入审查指令）→ `agent.followup()` 唤醒 → 面板绑 sessionId，用 `layout.selectPanel(null)` 看 conversation 流式输出 | ✔（会话在左栏的可见性 ?） |
| E 工具化 | `ctx.tools.register()` + `options.when`；全局层对所有 agent 可见，preset/`restrict()` 才能收窄；UI 与工具共用同一 Host 方法 | ✔ |
| F 打开 GitLab 页面 | 无"用系统浏览器打开 URL"的 Host 服务（`open-in-app` 是打开本地 IDE/终端的三个 webServer 路由）；首选客户端 `window.open`，兜底复制链接 + `ctx.shell.execute` | ✔ / ?（Desktop 拦截行为） |
| G 调度 | 后台轮询用 `ctx.timer`（不持久），**不要**用 `schedule`（绑定真实会话的提醒，投递进 inbox）；重启后靠 storageDomain 的游标立即补拉 | ✔ |
| H GitLab ForgeProvider | `ForgeProvider` 无"列出待我审"能力，且当前组合内**没有任何 forge provider 包**；结论：自建 GitLab 适配器为主，注册 provider 为辅（Phase 2） | ✔ |
| I 风险 | 轮询放大 / 多窗口 SSE / 面板卸载泄漏 / PAT 越界 / 卸载残留 五类，方案已给对策 | ✔ |

一句话判断：**A/B/C/D/E/G 都是"能做且路径清晰"；H 告诉我们不要指望宿主 forge 做 GitLab 的收件箱；F、以及 D 的"新会话是否出现在左栏"，是本阶段两个必须实测的点。**

## 1. 研究方法与已确认的环境事实

1. `cordis_inspect_list` → 9 个 provider（host: Service/Event/Config/Tool；client: Service/Event/Builtin/Slots/Theme）。
2. 逐个 `Service.listService` 取精确签名（connection / webServer / clientModules / tools / agents / sessions / storageDomain / credentials / schedule / shell / forge / forgePanel / settings / commands）。完整目录共 **106 个 Host 服务**、**77 个 Host 事件**。
3. `Config.listConfigs` 分页读完 **214 个 loader 条目**（含 `include:open-in-app`、`include:websocket?` 无、`include:dsh-market`、`include:agent-teams`、`include:openviking-memory-runtime` 等）。
4. 源码证据（这些文件能直接用 read 工具读）：
   - `D:/Program Files/DSH Desktop/resources/app.asar/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js`（738 行，含 `ctx.layout` 服务与 `main` 槽渲染）
   - `.../dsh-client-ui-sidebar/lib/client.js`（772 行，含 `sidebar.panellist` 列表与 `PanelRow` 工厂 props）
   - `.../dsh-client-ui-slots`、`.../dsh-client-modules`、`.../dsh-client-connection`、`.../dsh-cordis-client-runner` 的 `package.json`
   - profile 内真实第三方 bundle：`dshmarket`（`client/client.js` 18972 行、`lib/index.js`、`lib/routes.js` 7949 行、`lib/http.js`）、`@openviking/dsh-memory-plugin`（纯 `.mjs`，无反引号构建）、`@nanmicoder/dsh-agent-teams`、`dsh-windows-mcp`
5. **工具限制（真实影响结论的地方）**：asar 内文件只能用 read 工具按确切路径读，glob/grep/pwsh 读不到；`cordis_inspect_query` 的 **client** provider 全部 10s 超时（`Client inspect query ... timed out after 10000ms. Open or reconnect the Harness page`），因此**客户端 Slot 目录与 Client Service 列表本次没有实时快照**，A 段的客户端结论全部改由 app.asar 里的 layout/sidebar 源码 + dshmarket 真实注册代码交叉验证——这比 Inspect 更硬，因为它是实际执行路径。

> 环境判断：本次是 **Desktop 内嵌 host**（`dsh-desktop` 0.13.2 + `out/main/index.js`），但页面走 HTTP `http://127.0.0.1:43129`（不是 `dsh-app://`）。dshmarket 的源码注释明确区分了这两种宿主（`lib/routes.js:2376-2382`：`Not on a Desktop host yet. Its page loads from dsh-app:// ... whether those requests carry the session the host's gate checks has not been measured`）。**这意味着桌面端"自定义 HTTP 路由 + 浏览器登录栅栏"的可达性必须实测**（见 V3）。

## 2. A · 面板接入（整页大面板）

### A1 `sidebar.panellist` 是 list 槽，options = `{id, order, label, locale}` ✔

- `dsh-client-ui-sidebar/lib/client.js:731-734` 声明子槽：`"sidebar.panellist": { kind: "list", scope: "root" }`；同文件 `:663-682` 的 `syncPanels()` 只读三个字段：
  ```js
  const next = ctx.slots.entriesOfSlot("sidebar.panellist").map(({ options }) => ({
    id: options.id, order: options.order ?? 0,
    label: resolveSlotLabel(options.label) ?? id,
  })).sort((a, b) => a.order - b.order)
  ```
  结论：`order` 决定同排行序（缺省 0，按 id 兜底做 label），`label` 可以是字符串也可以是函数（`resolveSlotLabel`）。
- 真实注册例（dshmarket `client/client.js:18844-18850`）：
  ```js
  const offRow = ctx.slots.register({
    name: "sidebar.panellist", id: SIDEBAR_PANEL_ID, order: 1,
    label: () => t("nav"), locale: NS,
  }, (owner = {}) => createElement(MarketLogo, { size: owner.size ?? 16 }))
  ```
- **工厂收到的 owner props = `{ size, active }`**：`PanelRow`（同文件 `:207-232`）在激活态渲染
  ```js
  renderSlot("sidebar.panellist", { size: wide ? 16 : 18, active }, { only: id })
  ```
  所以我们的图标组件能拿到 `size`（16/18）和 `active`（是否当前面板），**自绘"未读小红点"完全可行**。

### A2 `main` 是 keyed 槽，key 可以是任意字符串 ✔（MainPanelId 不封闭）

- 声明：`dsh-client-ui-layout/lib/client.js:649-652` → `"main": { kind: "keyed", scope: "root" }`。
- 渲染：`client.js:118-120`
  ```js
  function MainPanel({ usePanelInfo, renderSlot }) {
    return renderSlot("main", {}, { entryKey: usePanelInfo((info) => info.activePanelId) ?? "conversation" })
  }
  ```
  ⇒ 注册 `{ name: "main", key: "<任意 id>" }` 即可成为"整页面板"；`"conversation"` 只是未选中面板时的默认 key，由 Conversation 包注册。
- 真实注册例：dshmarket `client.js:18838-18843` 用 `key: "dsh-market"` 注册 main 面板；`:18845` 用同一个字符串作为 `sidebar.panellist` 的 `id`。
- 面板工厂同样收 owner props（dshmarket 用 `ownerProps.preferredSubsectionId`、`surface`）。

**结论**：插件面板 id 建议 `daily-work`（同时用作 `main.key` 与 `sidebar.panellist.id`），是全页面板，不是装饰件。

### A3 面板切换：`ctx.layout.selectPanel(panelId)`，未注册会抛异常 ✔

- `LayoutController.selectPanel`（`client.js:467-472`）：
  ```js
  selectPanel(panelId) {
    if (panelId !== null && !this.hasMainPanel(panelId))
      throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
    this.navigation.abort(); this.panels.selectPanel(panelId)
  }
  ```
- `hasMainPanel` 的实现（`:635`）是查 `ctx.slots.entries("main").some(e => e.options.key === id)` ⇒ **报警顺序**：必须"先注册 main 面板，再调 selectPanel"。
- `ctx.layout` 由 `ctx.reflect.provide("layout", layout)`（`:640`）提供，`panelInfo` 通过 `provideRoot({hooks:{panelInfo}})`（`:639`）向下共享；`selectPanel(null)` 表示回到 Conversation。

### A4 面板是否在刷新后保留：**不保留** ✔

- 面板选择的初始值写死在 store：`client.js:394` → `init: () => ({ panelInfo: { activePanelId: null }, ... })`；全文件没有把 `activePanelId` 写入 localStorage / settings / sessionStorage；也没有 `layout` 服务的持久化分支。
- 反向证据：`retainMainPanels`（`:410-412`、`:632-634`）只在 main 槽条目变化时把"已失效的 activePanelId"重置为 `null` ⇒ 说明它按"进程内 UI 状态"设计。
- 结论：**刷新/重开窗口后回到 Conversation**。要"记住上次停在每日工作台"，得客户端自己把 `'daily-work'` 存 localStorage，并在**注册完成后**调 `ctx.layout.selectPanel('daily-work')`（顺序见 A3）。这是首版就该做的小体验项。

### A5 图标未读角标（badge）怎么做 ✔ / 部分 ?

- 宿主**没有**"给某个 panellist 行挂 badge"的插槽或 options：`PanelRow` 只渲染 `panelGlyph` 里的工厂输出，`label` 只用于 `wide` 态的标题文本（`client.js:226-236`）。`syncPanels` 只认 `id/order/label`（`:668-675`）——写别的字段会被忽略。
- 宿主自带的独立 badge 只有一个：`sidebar.toggle.badge`（single 槽，仅在**侧栏折叠成 rail** 时渲染，见 `:389` `!wide && renderSlot("sidebar.toggle.badge", {})`）。它适合"全局未读总数"，不适合每行。
- **推荐做法（低风险、零宿主依赖）**：在我们自己的 `sidebar.panellist` 工厂里画：一个 16/18px 图标 + 绝对定位的 6px 圆点/数字气泡，颜色用主题令牌（`--dsw-alias-*`、`--dsw-specific-*`），数据来自客户端 store（SSE/轮询），并让 `active === true` 时仍显示（或改为描边样式）。
- 次选：另注册一个 `sidebar.toggle.badge` 条目显示"未读 N"，覆盖"侧栏折叠、看不到行"的场景。二者可并存。
- ?待验证：未读计数在**多窗口**下的一致性（需 Host 单一事实源，见 G3）。

### A6 面板内多视图（收件箱 / 详情 / 设置）怎么自管状态 ✔

- main 是 keyed 槽：**只有当前选中的 entry 会被渲染**，切到 Conversation 时我们的面板组件被卸载（`renderSlot(...,{entryKey})` 语义）。因此：
  - 视图状态（当前 tab、当前选中 MR、筛选词）用组件内 `useState` 即可；**不要**引入路由（DSH Web 没有 path 路由，dshmarket 注释 `:2782-2786` 明确说 `location.pathname` 始终是 `/`，只有 `document.baseURI` 有意义）。
  - 需要跨"切走再切回"保留的少量偏好：`localStorage['daily-work:prefs'] = { tab, filters, lastItem }`；需要跨设备/多窗口一致的（已读、忽略、归档）放 Host（见 C）。
  - 详情页**不要**用 iframe 嵌 GitLab：`practices.md:33` 明确禁止（iframe 拿不到主题令牌/明暗切换/`ctx.locale`）。用 API 拉 diff/描述自己渲染。
- 结构建议（单 key 面板内的三段式）：左列列表（收件箱/审查队列/已忽略 分 tab）+ 中间详情（diff、描述、讨论）+ 右侧操作条（一键审查、打开、忽略/归档、提示词选择）。刷新按钮触发 `POST /api/daily-work/refresh`，**不要**在面板里做整页 reload。

### A7 我们还额外拿到一个"行内操作菜单"槽 ✔

- `sidebar.panellist.actions`（list，`client.js:735-738`）由"更多"按钮渲染，props = `{ entries, onOpen, onPinnedChange, onDismiss }`（`:280-285`），`entries` 是所有面板行 `{id,label,pinned,active}`。
- 用途有限但值得记：可以在这里加"仅显示未读""快速刷新"这类全局动作；不要把它当成我们的主界面。

### A8 面板生命周期与清理 ✔

- dshmarket 的范式（`client.js:18851-18855`）：
  ```js
  return () => {
    if (layout?.panelInfo.getSnapshot().activePanelId === "dsh-market") layout.selectPanel(null)
    if (typeof offRow === "function") offRow()
    if (typeof offPanel === "function") offPanel()
  }
  ```
  ⇒ **卸载前先把面板切回 Conversation**，否则 `LayoutController.hasMainPanel` 变假而 `activePanelId` 仍指向我们的 id，中央区会渲染空 key。这是插件禁用/热更时的必须动作。

## 3. B · Host↔Client 数据通道

### B1 客户端 half 的物理形态：`window.__ModuleLoader__.load({id, factory})` 的 plain JS ✔

- dshmarket `client/client.js:1`：
  ```js
  window.__ModuleLoader__.load({ id: "dshmarket", factory: (require) => { ... return module.exports } })
  ```
- 它 `require` 的只有：`"react"`、`"react/jsx-runtime"`、`"react-dom"`、`"@deepseek-ai/dsh-client-ui-primitives"`（`:29-33`）。宿主 layout/sidebar 还 require 了 `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/cordis`——说明**模块表（module table）在运行时装了若干已装载的 client 包**，`require(id)` 就是取模块表里的那一份。
- 但 `practices.md:35` 明确警告：不要 `require('@deepseek-ai/dsh-client-ui-primitives')` 或任何 Harness Client 包作为模块（版本会变、plain JS 无类型检查、组件一抛就整槽报 `slot entry crashed in '<slot>'`）。dshmarket 是"官方豁免 + 逐字段探测缺口"的写法（`:18703-18735` 的 `REQUIRED_PRIMITIVES`/`missingPrimitives` + `console.warn` 降级）。
  ⇒ **本插件的决策：不 require 任何 Harness Client 包，只 require `react`/`react/jsx-runtime`，其余控件自己写、样式只用 `--dsw-alias-*` 令牌。** 这样升级最稳。

### B2 `dsh.client` 清单字段：`platform / inject / immediately / external` ✔

- `WebBootEntry`（`clientModules` 服务 `graph()` 的元素类型）：
  ```ts
  export interface WebBootEntry { id: string; url: string; rev: string;
    inject?: string[]; immediately?: boolean; external?: string[] }
  ```
  ⇒ 清单里能声明"只排序激活"的 `inject`、立即加载的 `immediately`，以及**包级 external 模块 id 列表**（构建期外置依赖）。
- 实例对比：
  - `dshmarket/package.json` → `dsh.bundle.patch` + `dsh.client = { inject: ["@deepseek-ai/dsh-client-locale", "...ui-settings", "...ui-theme"], platform: "web" }`，`exports["./client"] = "./client/client.js"`；**没有 `external` 字段**，因为它把 ui-primitives 当成"模块表里必然存在"的依赖（并在运行时探测缺口）。
  - `@deepseek-ai/dsh-client-modules/package.json` → `dsh.client = { platform: "web", inject: [], immediately: true }`（它是模块表本体，必须最早）。
  - `@deepseek-ai/dsh-client-connection/package.json` → 同样 `immediately: true`（传输要最早）。
  - `dsh-windows-mcp/package.json` → `dsh.client = { platform: "web" }`（只有一个字段也能挂 client half）。
- 结论：**纯 JS 客户端 bundle 不需要构建步骤**；`external` 只在你真的外置了某个包时需要写（我们不需要，因为只外置 `react`，而 react 来自模块表基线）。

### B3 plain-JS 能不能用 `@Remote` / typert：**不能**（本阶段判死） ✔

三条独立证据：

1. **Host 侧 `@Remote` 是构建期 typert 生成的**：`typert` 服务的职责是 `register(contribution) / get(key) / resolve(key) / toJSONSchema(key)`（见 `Service.listService('typert')`），并且 `typertGattway`（gateway）负责 `invoke/stream` 与 `registerRemoteEvents`。`credentialsController` 的描述直接写"Host service backing the generated `ctx.remote.credentials` namespace" ⇒ 客户端命名空间是**生成物**，不是运行时反射。`dsh-api-remotes` 作为单独 client 包（`include:api-remotes`）承载生成后的客户端代理。
2. **dshmarket 全仓零 `ctx.remote`**：在 18972 行的 `client/client.js` 里 grep `ctx.remote|useRemote|remote\.` 只命中一处无关字符串（`nextcloud.example/remote.php/dav`）。它有 main 面板、有安装/卸载/重启等强交互，**全部**走 `fetch(api("/dsh-market/..."))`（`:18649`、`:18664`）⇒ 一个功能完整的 plain-JS 大面板插件的实际选择就是"自建 HTTP 路由"。
3. **skill 文档的定性**：`ui-plugin.md:9` — "For compiled sources, use the deployment's Client build tooling to emit this format; declare non-baseline runtime imports in `dsh.client.external`"；反过来说，没编译就没有 `@Remote` 生成的调用桩。

补充（值得写进方案）：`@deepseek-ai/dsh-cordis-client-runner` 的存在说明宿主**有**"动态双半插件"机制（`dsh.client.inject = [renderer, api-remotes, modules, theme]`，描述为"Browser half of dynamic dual-half plugin packages: event subscription, closure evaluation, guard facade, and loader entries"）。这是一条"不编译也能拿到 remote/事件"的潜在通道，但 `include:cordis-client-runner` 在本 profile 中状态为 `absent`（未装配），且其 API 无公开文档。**结论：P0 不用它；标注为 Phase 2 调研项（V8）。**

### B4 推荐通道：`connection.fetch.register(...)`（首选）/ `webServer.register(...)`（兜底） ✔

两条都能用，差别在"鉴权与请求体由谁负责"：

**（首选）`ctx.connection.fetch.register(route: ConnectionFetchRoute)`**
```ts
interface ConnectionFetchRoute {
  readonly path: string
  readonly methods: readonly ('GET'|'HEAD'|'POST')[]
  readonly requestBody: 'buffered' | 'streaming'
  readonly fetch: (request: Request) => Promise<Response>
}
HostConnectionFetch.register(route): () => Promise<void>
```
- 它挂在 **共享 `/api` 通道**上（`createSharedFetchHandler(channel: '/api')` 负责组合），因此**自带** `connection` 的 Host/Origin 校验与浏览器登录（`authorizeIndex` 铸的 cookie），body 模式由你声明（大 diff 用 `streaming`，JSON 用 `buffered`）。
- 拿到的是 WHATWG `Request`/`Response` ⇒ 返回 `ReadableStream` 就是 SSE/NDJSON，无需碰 node `res`。
- 访问路径 = `<页面 baseURI>` + `/api` + `path`。

**（兜底）`ctx.webServer.register({kind:'exact'|'prefix', path, handler(req,res)})`**
- 拿到 node `IncomingMessage`/`ServerResponse`，需要自己控 body（dshmarket 有现成的"限量 JSON body reader"+ `sendJson`，`lib/http.js:7-13`）。
- **exact 路由会绕开 `/api` 前缀栅栏**（dshmarket `lib/index.js:126-129`："The market's routes are `exact` registrations on the bare webServer, and exact matches win over that fence's prefix, so they never pass through it"）⇒ 必须自己调 `connection.requestRejection(request)`（`lib/index.js:163-169` + `lib/http.js:46-67` 的 `refuseUnadmitted`）。**不自己加栅栏 = 把 GitLab PAT 暴露给任意本机进程的网页请求。**

**路径前缀建议（避免撞车）**：
- fetch 路由：`/daily-work/api/v1/{items,refresh,review,settings,prompts}`；SSE：`/daily-work/api/v1/stream`。最终 URL ≈ `http://127.0.0.1:43129/api/daily-work/api/v1/...`（有点长，可去掉一层：`/daily-work/v1/...`）。
- webServer 路由（若走兜底）：`/daily-work/...`，`kind: 'prefix'` 一条吃掉全部子路径，自己按 pathname 分发（dshmarket 是逐条 `exact`，我们条目多，prefix 更省）。
- **不要**注册 `/api` 前缀（共享通道所有）；不要注册 `/`（fallback 位只有一个所有者）。

### B5 SSE 还是轮询 ✔

| | SSE（`text/event-stream`） | 轮询（2–5s，带 ETag/If-None-Match） |
|---|---|---|
| 未读/新增实时性 | 秒级，天然"推送" | 2–5s 延迟，可接受 |
| 多窗口成本 | N 窗口 = N 条长连接 + Host 端广播 | N 窗口 = N×1 请求/间隔；命中 304 时几乎零传输 |
| 实现风险 | 需要心跳、断线重连、代理 buffer 关闭（`X-Accel-Buffering: no`）、Desktop 协议未验证 | 最小，调试直观，天然幂等 |
| 与宿主机制的关系 | 绕开 `sessionProjections` 的增量机制（我们自己的数据源，可接受） | 同上 |

**建议**：P0 用**轮询为主**（`GET /items?since=<cursor>`，强 ETag），把 SSE 作为"面板可见时的加速通道"（可见才开，切走就 `close()`；参考 `practices.md:36` 的"订阅最小切片、卸载即清理"）。理由：轮询在多窗口与 Desktop 协议未知下更稳；SSE 只影响"新 MR 出现"的秒级感知，不是核心价值。

### B6 鉴权 / PeerScope 语义 ✔

- `PeerScope = { id, ctx, principal, signal, interactions, dispose() }`；`PrincipalMap` 目前只有 `{ kind: 'owner' }`；`connection.browserPeer` 是"所有已认证浏览器连接共享的 owner Peer"。
- `connection.requestRejection({headers})` → `401 | 403 | undefined`：Host/Origin 校验 + 浏览器登录。`connection.admit(...)` 更进一步返回 `PeerAdmission`（拿到 peer）。
- `authenticatedUrl(baseUrl)` 会把进程 token 加进 URL（首次登录用）；`authorizeIndex` 铸 cookie（TLS 时 `Secure`）。⇒ 同源 `fetch` 自动带 cookie，**这就是 dshmarket 客户端不加任何 token 也能调通自己路由的原因**。
- **本插件原则**：GitLab PAT 只存在 Host（credentials），任何路由的响应体里永不出现 token；错误信息里也不回显（对照 `log-redaction.js` 的做法）。

## 4. C · 持久化选型与 schema

### C1 存放位置总表 ✔

| 数据 | 位置 | 依据 |
|---|---|---|
| GitLab PAT（每实例一条） | `credentials`（`CredentialKey` + `GrantRecord` 或 `CredentialRef`） | `credentials.resolve/set/unset/modifyRecord`；`CredentialKey` 是"这个插件为这个 id 持有的凭据"，`modifyRecord` 是唯一写路径（token 轮换读-改-写在锁内） |
| 实例地址、轮询间隔、项目/组范围、并发上限 | 插件 `Config`（schemastery）+ 用户 patch 层；由 `settings` 自动投影成表单 | `settings.describe/update/replace/mutate`；`SettingsDescriptor { ns, schema, value, revision, secrets? }`；`configEditor.edit(entry, change)` 是底层写 patch 的口 |
| 提示词库（审查模板） | `storageDomain` domain 表 `prompts` | `DomainSpec.tables` + `KvTable.put/update/delete/entries` |
| 工作项已读/忽略/归档 | `storageDomain` 表 `items`（key = `host/project!iid`） | 同上；`domain/changed` 事件可用于广播 |
| 动作审计（谁在什么时候审查/合并/忽略） | `storageDomain` 表 `audit`（append-only 语义，key = 时间序 id） | 同上；`KvTable` 无事务，审计用"只增不改"约定即可 |
| 轮询游标（lastPollAt、ETag、cursor） | `storageDomain` 单例 `global`（或 `state` 表） | `DomainGlobal.get/set`；重启恢复靠它（G3） |
| UI 偏好（当前 tab、筛选、折叠） | 浏览器 `localStorage` | 面板会被卸载（A6），宿主不持久化 panelInfo（A4） |
| 一键审查产生的会话映射 | `storageDomain` 表 `reviews`（key = MR 键，value = `{ sessionId, status, startedAt }`） | D4 复用会话需要它 |

**不要**把 PAT 写进 `Config`：Config 会进 `cordis.patch.yml`（磁盘明文）且会出现在 `settings.describe({redactSecrets})` 的 schema 里；secrets 只能走 credentials。

### C2 建议 schema（schemastery/zod 风格伪码）

```ts
// Config（cordis.patch.yml 的 config；settings 自动生成表单）
interface DailyWorkConfig {
  instances: Array<{
    id: string                 // 稳定短 id，用于 CredentialKey / domain key
    label: string              // "公司 GitLab"
    baseUrl: string            // https://gitlab.example.com（必须 https，除 localhost）
    pollSeconds: number        // 60（下限 30）
    scopes: Array<
      | { kind: 'project'; path: string }             // group/sub/project
      | { kind: 'group'; path: string; includeSubgroups: boolean }
    >
    review: { enabled: boolean; maxConcurrent: number; promptId?: string }
  }>
  poll: { jitterRatio: number; backoffMaxSeconds: number }   // 抖动/退避
  ui: { openExternal: 'browser' | 'copy' }
}

// credentials
type GitlabPatKey = CredentialKey<'daily-work/gitlab/<instanceId>'>   // kind: 'grant', payload: { token }
// 或 CredentialRef<'DAILY_WORK_GITLAB_PAT_<INSTANCE>' 大写> 走 env 回退（CI/多机场景）

// storageDomain: name='daily-work', version=1
interface DailyWorkDomain {
  global: { lastFullSyncAt: number; schemaVersion: 1 }
  tables: {
    items:   Record<string, ItemRecord>      // key: `${instanceId}/${projectPath}!${type}!${iid}`
    prompts: Record<string, PromptRecord>    // key: promptId
    reviews: Record<string, ReviewRecord>    // key: 同 items
    audit:   Record<string, AuditRecord>     // key: `${ts}-${uuid}`
  }
}

interface ItemRecord {
  instanceId: string; type: 'mr' | 'issue'; projectPath: string; iid: number
  title: string; author: string; state: 'opened' | 'merged' | 'closed'
  updatedAt: string                 // GitLab updated_at（游标）
  webUrl: string
  headSha?: string; sourceBranch?: string; targetBranch?: string
  reviewState: 'unreviewed' | 'reviewing' | 'reviewed' | 'failed'
  seenAt?: number; ignoredAt?: number; archivedAt?: number   // 三态各自时间戳，便于撤销
  labels: string[]
  etag?: string                     // 详情页 304 复用
}

interface PromptRecord { id: string; name: string; body: string; updatedAt: number; builtin?: boolean }
interface ReviewRecord { itemKey: string; sessionId: string; status: 'queued'|'running'|'done'|'failed'; startedAt: number; finishedAt?: number; error?: string }
interface AuditRecord { at: number; actor: 'ui' | 'tool' | 'poll'; action: string; itemKey?: string; detail?: string }
```

### C3 迁移与兼容 ✔

- `DomainSpec` 有 `version` / `compatibleVersions` / `invalidRecords: 'backup-and-skip'`；升级时**加字段必须给默认值**（`loadAll` 会对每条记录做 schema 校验，不合法即 `invalid-record` 失败或备份跳过）。
- `practices.md:11`：别给会话日志加新事件类型（`appendPluginRecord` 仅限 DSH 实验包）⇒ 我们的审计**不进会话日志**，只进 storageDomain。

## 5. D · 一键 AI 审查：真正创建/复用会话

### D1 六条路径的差别 ✔

| 入口 | 语义 | 会不会"新建可见会话" | 适用 |
|---|---|---|---|
| `agents.create(CreateAgentOptions)` | 通过 factory（agent-loop）**构造 + 发布**agent 与其 session，返回 `AgentHandle{agent, dispose}` | 会（走 start 事务 + `agent/created` 序列派发） | **推荐主路径** |
| `agentLoop.create(id, options, meta)` | 更底层：直接拿 Loop 建 agent（`id` 必填），不走 `agents` 注册表 | 会，但**不做 registry 记账** | 不推荐业务用 |
| `agentLoop.createAgent(ownerCtx, options)` | factory 面（`AgentFactory.createAgent`），`ownerCtx` 决定归属与卸载 | 会 | 只有你在实现另一个 agent 工厂时 |
| `subagents.startActivation/prompt` | 命名 provider 的"子代理"，`origin:'subagent'`、`delegationDepth>0` | 会，但作为**子会话**（不是你在左栏看到的普通会话），且 `schedule` 明确拒绝子会话（`subagent_session`） | 一次性并行审查（不落主界面） |
| `commands.execute(agent, line, ...)` | 在**已存在** agent 上执行斜杠命令，不新建会话；会写 `command/run`/`command/done` | 不会 | 给"当前会话"加 `/review` 命令 |
| `agent.inject()` / `agent.followup()` | 给**已存在** agent 入队/追加消息：`inject` 不唤醒，`followup` 唤醒 | 不会 | 复用会话时的"再来一轮" |
| `ctx.subagents` vs `agents` | 前者是 provider 注册表 + 托管激活；后者是 live agent 注册表 | — | 见上 |

`CreateAgentOptions`（精确签名）：
```ts
interface CreateAgentOptions {
  readonly sessionId: SessionId
  readonly parentAgent?: Agent
  readonly meta?: { cwd?, parentSession?, isSeeded?, origin?, delegationDepth?, agentPreset? }
  readonly inheritedEventCount?: SessionLogOffset
  readonly seed?: readonly SessionEvent[]
  readonly agentOptions?: { provider?, model?, reasoningEffort?, maxTokens? }
  readonly signal?: AbortSignal
  readonly setup?: (agentCtx, agent) => AgentSetupCommit | void
}
```
关键点：`sessionId` 必填（`SessionId = string & brand`，可自行生成，允许字符集未公开约束 ⇒ V5）；`meta.cwd` 必须是**绝对路径**（`sessions.create` 会校验，storage backend 按它分目录）；`setup` 里拿到的 `agentCtx` 是**按会话隔离的上下文**——审查指令、per-agent 工具都应注册在这里（`practices.md:19`：per-agent 行为注册到 `agent.ctx`，并保留 disposer）。

### D2 推荐流程（Host 服务 `ReviewService.open(itemKey)`）

1. **查复用**：`reviews.get(itemKey)` → 有 `sessionId` 且 `ctx.agents.get(sessionId)` 活着 ⇒ 复用：`agent.followup(...)` 再跑一轮（会唤醒）；否则 `agents.resume({ resumeSessionId, agentOptions, setup })` 恢复历史会话。
2. **新建**：`ctx.agents.create({ sessionId: mint(), meta: { cwd: 项目检出目录 }, agentOptions: { provider, model }, setup(agentCtx, agent) { /* 注入审查提示词 + 只读约束 */ } })`。
3. **提示词从哪来**：`ctx.systemPrompt.section({ name:'daily-work/review', order, text })`（全局）或只在 `setup` 内对 `agentCtx` 注册（仅该会话生效）。技能侧用 `skills` / `sessionSkillCatalog`（提示词与技能管理是 P0 的另一半，二者共用 `prompts` 表）。
4. **给模型的输入**：`agent.inject()` 写入系统级上下文（不唤醒）；需要它立刻动起来时用 `agent.followup()`（`practices.md:29`："A timer that starts work calls `agent.followup()`, which wakes the agent; `agent.inject()` does not wake it"）。
5. **流式回显两条路**：
   - **A（推荐，零成本）**：把该会话"变成用户眼前的会话"——客户端 `ctx.layout.selectPanel(null)` 回 Conversation，并让左侧会话列表选中它；审查输出就是原生的 conversation 流（durable `turn/end`、`assistant/message`、`tool/result`；token 级用 `agent/assistant-stream`）。
   - **B（面板内嵌流）**：Host 订阅 `ctx.on('agent/assistant-stream', ({frame}) => ...)`（或 `session/event`），把帧推给面板的 SSE；面板自绘"审查进行中"的滚动文本。实现成本高、且与"官方 conversation"重复，**P0 不做**，只在"面板内快速预览结论"时用（且只推 `turn/end` 摘要，不推 token）。
6. **收尾**：`reviews.put(itemKey, {...})`、`audit.put(...)`；`forge.refresh(ref)`（若注册了 provider 且有 watch）或下一轮轮询自然收敛。

### D3 让左侧会话区看见新会话 ✔ / ?（关键待验证）

- 事实：`session/created`（emit，"Read-only creation announcement after store entry"）与 `api-session/added(summary)`（emit，"A Session became visible or its Agent was created or disposed"）是两个独立事件；后者才是**会话列表/侧栏**的数据源（`api-session/*` 家族：`added/removed/status/activity/error`）。
- `agents.create` 走 factory 的"start 事务"（`agent/created` 是 serial 派发），按 `agents.create` 的描述"Create and publish a new agent … after setup, rollback-covered publication, and loop start complete" ⇒ 发布应当包含 `api-session/added`。
- ?待验证（V1）：用 `agents.create` 建的会话是否**立刻出现在左栏会话列表并可直接点开**；以及它是否需要一个 `workspace` 归属（`workspaceRegistry`/`workspaceController` 有 `insertSessionBefore/rename/archive` 等 Remote，说明会话列表是"workspace + 归档状态"驱动的）。
- ?待验证（V2）：如何在客户端**选中**某个会话（`ui-session`/`ui-workspace` 的公开客户端服务方法名本次未取到——client Inspect 超时；dshmarket 也没有选会话的需求，因为它的面板不碰会话）。备选：只 `selectPanel(null)`，让用户在左栏点一下；或用 `sessionController`/`workspaceController` 的 Remote（那是 Host 侧，客户端仍需 HTTP 路由包装）。

### D4 并发与配额 ✔

- 一次"审查 20 个 MR"= 20 个会话 × 各自 LLM 调用。必须限流：`Config.review.maxConcurrent`（建议 2–3）+ 队列落 `reviews` 表（status=queued），`turn/end` 后再起下一个（`practices.md:28`：等 durable 事件，不要轮询 `agent/status`）。
- 会话上限：`agents.list()` 只给 live agent；**不要让审查会话常驻**——完成后 `handle.dispose()`（或保留 `reviews.sessionId` 供 resume），避免几十个会话同时活着。

## 6. E · 工具化（UI 与工具共用实现）

### E1 `ctx.tools.register` 的精确形状 ✔

```ts
interface ToolSchema { deferLoading?: true; name: string; description: string; parameters: Record<string, unknown> }
interface ToolDefinition extends ToolSchema {
  readonly output: { schema: JsonSchemaNode; render(args, value): ContentBlock[]; presentationMeta?(...) }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  projectContent? / finalizeContent? / timeoutMs? / isConcurrencySafe? / presentCall? / presentResult?
}
register(definition: ToolDefinition, options: ToolRegistrationOptions = {}): () => void
interface ToolRegistrationOptions { readonly when?: (context: ToolActivationContext) => boolean | Promise<boolean> }
```
- `parameters` 是**原始 JSON Schema**（`Record<string, unknown>`），不是 zod；`output.schema` 用 `JsonSchemaNode`。
- 保留名：`run_code`（`register` 说明："duplicates within one layer and the reserved `run_code` name fail"）。
- 条件激活：`options.when(ctx)` 在**每一步**解析一次（`tools.resolve(context)`），可用于"只在 GitLab 已配置时暴露工具"。

### E2 作用域与可见性 ✔

- **注册在插件根 ctx ⇒ 全局层，默认对所有 agent 可见**（`register` 说明："Register globally or in the calling agent scope. Scoped tools shadow globals"）。
- 收窄只有三种正规手段，且都**只能减不能加**：
  - `ctx.tools.restrict({ allow?, deny? })`（在某个 agent 的 ctx 上调用 ⇒ 只影响该 agent；"Restrictions intersect; scoped registrations remain visible"）
  - `ctx.tools.guard(fn)`（同步拒绝，单调）
  - preset 的 `toolSet`（`tools.get(name, scope, toolSet)`/`definitions(scope, toolSet)` 都按 `ResolvedToolSet` 过滤；`agentPresets` 负责装配）
- 结论：**"如何保证审查类工具可用"** = 注册在插件根 ctx（全局），不要在 `agent.ctx` 里注册（除非只给审查会话用）；然后用 `restrict` 在别的 agent 上把它关掉（例如纯聊天会话）。`deferLoading: true` 可以让工具在 schema 里延迟加载（省 prompt token），但会让模型先看到"按需加载"的提示，需评估。
- ?待验证（V6）：本 profile 的三个 preset（`preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis`）各自是否 `restrict` 掉了未列出的全局工具；若 `preset-minimal` 默认 deny 全部，需要显式 `allow` 才能让审查工具出现在"用最小 preset 起的会话"里。

### E3 UI 与工具共用同一实现 ✔（对齐 `user-actions.md`）

`user-actions.md` 的三步范式，落到本插件：

1. **一份实现**：Host 服务 `DailyWorkService`（`items()/refresh()/ignore()/archive()/openReview()/applyPrompt()`），返回结果或带原因的状态。
2. **UI**：面板 → `POST /api/daily-work/v1/review`（fetch 路由）→ 同一个方法；失败必须把原因显示出来（不要静默 `catch {}`，dshmarket 的 `:18658` 就是反例）。
3. **工具**：`daily_work` 工具（`action: 'list' | 'review' | 'ignore' | 'archive' | 'refresh'`）→ 同一个方法 → 把结果作为 tool result。
4. **用户专属动作**（不能给工具）：批准/授权类（例如"把 PAT 换成更高权限的 token"、"合并别人的 MR"）保持 UI-only；工具侧用 `guard` 拒绝或干脆不暴露 action。

## 7. F · 用系统浏览器打开 GitLab 页面

### F1 现状：没有"打开 URL"的通用服务 ✔

- 全量 106 个 Host Service 里没有 `openExternal`/`launchUrl` 一类；`shell` 是**抽象的 bash 执行**（`ShellExecRequest{command, workdir, timeoutMs, ...}` / `ShellExecution.result()`），不是"打开浏览器"的语义。
- `@deepseek-ai/dsh-host-open-in-app` 确实存在且已装配（`include:open-in-app`，`status: schema`），但它的 `package.json` 描述是"resolved application catalog, icons, and the launch endpoint as **three webServer routes**"，catalog 只含文件管理器/编辑器/IDE/Git GUI/终端（`lib/index.js:109-120` 起），**不含浏览器**；它的客户端半 `@deepseek-ai/dsh-client-ui-open-in-app` 在本 profile 为 `absent`（未装配）⇒ 前端入口也不在。
- 结论：**不能**通过宿主拿到"用系统默认浏览器打开 https://gitlab.../mr/123"。

### F2 三个可行做法（按推荐序）✔ / ?

1. **客户端 `window.open(url, '_blank', 'noopener')`**：Web 场景 100% 可用；Desktop（Electron）是否在系统浏览器打开取决于外壳的 `setWindowOpenHandler`——**?待验证（V4）**。实现上必须：只允许 `http(s)`、只允许 `Config.instances[].baseUrl` 的 origin（防钓鱼/防 `file://`/`javascript:`）。
2. **兜底：复制链接 + Toast**（`writeClipboard` 在 ui-primitives 里存在，但按 B1 我们不 require 它 ⇒ 用 `navigator.clipboard.writeText`，失败再退回 `document.execCommand('copy')` 的隐藏 textarea）。这是"永不失败"的路径，适合作为 Desktop 下的默认。
3. **Host 侧兜底（可选、需谨慎）**：`ctx.shell.resolve/execute`（Windows 上 `cmd /c start "" "<url>"`，macOS `open`，Linux `xdg-open`）。风险：① 沙箱模式下被拒（`ShellSandboxInfo.denied`）；② URL 进命令行 = 注入面（必须严格校验 origin + 拒绝空白/引号/换行）；③ 在 SSH/headless 下无意义（`launchedThroughSsh` 在 open-in-app 里就是专门处理这个的）。**建议只在"用户明确点击且浏览器路失败"时降级，并记录审计。**

## 8. G · 调度：timer vs schedule，未读与重启恢复

### G1 二者不是同一层东西 ✔

| | `ctx.timer`（cordis-plugin-timer） | `ctx.schedule` |
|---|---|---|
| 形状 | `timeout/throttle/debounce/interval`，`interval(cb, delay)` 返回 disposer；`interval(delay)` 返回 `AsyncIterableIterator` | `create(sessionId, {prompt,title, after_seconds|at|every_seconds|daily|weekly|cron})` |
| 归属 | 插件 ctx（effect 管理，卸载即清） | **绑定一个真实 Session**，投递进该会话的 inbox |
| 持久化 | 无 | 有（`ScheduleRecord` 落盘，`schedule/catalog` 可读全部；`schedule/changed` 广播） |
| 唤醒 | 你自己决定 | 投递即唤醒会话（依赖 `session/flush` 参与者；`subagent_session` 会被拒） |
| 用途 | **后台轮询**、去抖刷新、SSE 心跳 | 用户级"每天 9 点提醒我看 MR" |

⇒ **后台 GitLab 轮询必须用 `ctx.timer.interval`（Host 插件作用域），不要用 `schedule`。** 用 `schedule` 会导致：每个实例要绑一个真实会话、投递会写会话日志（污染审计）、且重启后要恢复会话才能继续。

### G2 轮询循环的形状（要点）✔

- **单飞**：一个 `interval` 驱动全部实例，而不是每项目一个定时器（`forge` 服务的描述就是范本："Watchers of one change request share a single polling loop; each forge has at most one fetch in flight, which batches every due change request of that forge"）。
- **去抖/合并**：用户手动"刷新"与定时器撞车时，用 `ctx.timer.debounce` 或一个 `inFlight` promise 复用。
- **背压**：一次只允许 N 个并发请求（`Config.review.maxConcurrent` 之外，轮询也要自己的 `pollConcurrency`，建议 2）。
- **退避**：连续失败指数退避到 `backoffMaxSeconds`；401 → 标记实例 `unauthenticated` 并在面板顶部提示"重新填写 PAT"（不要静默重试）。
- **停机**：`ctx.effect` 返回 disposer（`interval` 的返回值就是）；`AbortController` 传给 fetch（`ShellExecRequest.signal` 同款语义）。

### G3 未读提示与重启恢复 ✔（方案；计数一致性 ?）

- **单一事实源在 Host**：`unread = count(items where reviewState='unreviewed' and seenAt is null and ignoredAt is null)`；面板/角标只读不算。
- 推送：客户端轮询 `GET /state?since=` 或 SSE `event: state`；`active` 为真时把 `seenAt` 批量写回（避免"打开面板就全变已读"误伤——建议"停留 >3s 才算看到"）。
- **重启恢复**：`global.lastFullSyncAt` + 每实例 `{ etag, lastUpdatedAt }`（存 `state` 表）；启动时先读 domain，再**立即跑一轮增量**（`updated_after=lastUpdatedAt`），随后才挂 `interval`。这样"关掉两小时再打开"也不会丢事件。
- 多窗口：`PeerScope` 是"所有已认证浏览器连接共享的 owner Peer"⇒ Host 侧一份未读计数即可；客户端每个窗口各自轮询/订阅（不要试图跨窗口同步 localStorage，`storage` 事件在 Electron 下行为也未验证）。

## 9. H · GitLab ForgeProvider 的取舍

### H1 接口能力清单（精确签名）✔

```ts
interface ForgeProvider {
  forge: string
  repositoryFromRemote(url): ForgeRepository | undefined
  changeRequestFromUrl(url): ChangeRequestRef | undefined
  changeRequestUrl(ref): string
  fetch(refs: readonly ChangeRequestRef[], signal): Promise<ReadonlyMap<Key, Snapshot | ForgeFailure>>   // 批量轮询
  findByHead(repository, branch, signal): Promise<readonly ChangeRequestRef[]>
  readiness(host, signal): Promise<ForgeReadiness>          // 'ready' | 'unauthenticated' | 'unavailable'
  markReady(ref, signal); merge(ref, {method, headSha}, signal)
  diff(ref, signal): string | ForgeFailure
  fileText(ref, commit, path, signal); fileUrl(ref, commit, path)
}
```
- **没有** `listOpenForMe()` / `search()` / `listAssigned()`。`fetch(refs)` 要求**你先知道 refs**；`findByHead` 需要"仓库 + 分支"（且排除默认分支与 fork）。
- ⇒ 结论：**ForgeProvider 不能承载"列出待我审的 MR / 分配给我的 Issue"**，那是 forge 的"发现"能力，宿主故意没抽象。

### H2 当前组合内没有 provider ✔

- 214 个 loader 条目里没有任何 `@deepseek-ai/dsh-forge-*` 或 GitLab/GitHub provider 包；`dsh-webhook-github` 只是 webhook 规则（`webhookRuntime.register/dispatch`），不是 forge provider。
- 后果：`forge.changeRequestFromUrl('https://gitlab.../mr/1')` 现在应返回 `undefined`；`forgePanel.track(session, url)` 会抛 `forgePanel/unrecognized-url`；`changeRequestStates` 流为空。⇒ **forgePanel 在今天等于不可用**（?待验证 V7：实际调用一次确认）。

### H3 "自建适配器为主 + 注册 provider 为辅"：值得，但顺序要对 ✔

| 方案 | 得到什么 | 成本 | 结论 |
|---|---|---|---|
| 只自建 GitLab REST 适配器 | 待我审 MR / 分配 Issue / todo / discussions / diff 全部可控；无宿主依赖 | 一个 `gitlab.ts`（~600–900 行）+ 轮询 | **P0 必做** |
| 只注册 ForgeProvider | 复用 `forgePanel` 的 diff 树/文件视图/合并按钮 + `watch` 共享轮询 | 要实现 12 个方法（`diff`/`fileText`/`merge`/`markReady`/`readiness` + 三个 URL 映射）；**仍然拿不到"待我审列表"** | 单独做没有意义 |
| 二者结合（推荐 Phase 2） | 自己的列表 + 选中 MR 后"在会话里打开 forgePanel"（`track` 后 `forge.diff/fileText` 直接喂给审查提示词；diff 视图免写） | 额外 300–500 行 + `forge/providers-changed` 协调 | 有价值：**diff 渲染 + 合并动作**是宿主已经写好的部分，值得复用；但**不是 P0 的阻塞项** |

补充：宿主给了 `forge.providers-changed(forge)` 事件（parallel），我们注册 provider 后应监听以更新 UI"已就绪"。另外 `credentials.readiness` 语义要对齐：`ForgeReadiness.message` 用于面板提示"PAT 失效"。

## 10. I · 风险与性能

| 风险 | 触发条件 | 影响 | 对策 |
|---|---|---|---|
| 轮询放大 | 20 项目 × 60s = 20 req/min；若每项目再拉 detail = ×5 | GitLab 429 / 本机 CPU | 单飞循环 + 批量（`updated_after` + 每项目 1 次列表，详情按需）+ 并发 2 + 指数退避 + `ETag/If-None-Match` 命中 304 零解析 |
| 多窗口重复 | 用户开 3 个窗口 | 3× 请求、3× SSE | Provider 端去重（Host 单例轮询）；客户端只订阅；面板不可见即停 SSE/降频轮询 |
| 面板切走泄漏 | 组件卸载未清 interval/EventSource | 后台常驻请求、内存增长 | 所有资源在 `useEffect` 清理；SSE 在 `visibilitychange` 时 `close()`；`ctx.effect` 管 Host 侧 |
| token 泄漏 | 路由回显、错误信息、日志、客户端 store | PAT 外泄 | PAT 只在 Host；响应体白名单字段；`log-redaction`；不把 token 放进 URL（`authenticatedUrl` 只用于页面登录） |
| 插件卸载残留 | 面板仍指向已注销的 main key | 中央区空白 | 参照 dshmarket：disposer 里先 `selectPanel(null)` 再 `offPanel/offRow`（A8） |
| 未读漂移 | 多窗口 + "看到即已读" | 误标已读 | 停留计时 + Host 单一写者 + 审计留痕 |
| 反代/前缀部署 | 挂在 `https://host/app/dsh/` 下 | 硬编码 `/` 路径全 404 | 客户端所有 URL 用 `new URL(rel, document.baseURI).pathname`（dshmarket `:2788-2792` 的 `api()` 就是为这个 bug 写的） |
| Desktop 协议未知 | 页面走 `dsh-app://` 而非 http | 自定义路由不可达/鉴权缺失 | V3 实测；兜底方案：把数据面挪到"宿主已有 Remote"（但 plain JS 做不到）⇒ 若 Desktop 不可用，则 P0 只承诺 Web profile |
| 提示词注入 | MR 描述/评论里写"忽略以上指令" | 审查结果被操纵 | 审查提示词里明确"仓库内容是不可信数据"；`practices.md:8` 的 "framework drives, plugin computes" 原则同样适用：**不要**让 MR 文本参与"决定用哪个工具/哪个目录/什么权限" |

**性能预算（初版目标，非验收线）**：20 项目 / 60s / 单实例：稳态 ≤ 1 次列表请求/项目/轮 + ≤ 2 并发；面板首屏 ≤ 300ms（数据来自 Host 缓存，不阻塞于 GitLab）；未读状态更新延迟 ≤ 5s（轮询）或 ≤ 1s（SSE）。

## 11. 代码骨架 1/3 · Host：webServer 路由 + 鉴权 + SSE

> 位置：bundle 的 `index.js`（纯 ESM，无构建）；`cordis.patch.yml` 只需 `- insert: [{ id: daily-work, name: '<pkg>', config: {...} }]`

```js
// index.js —— Host half
export const name = 'daily-work'
export const inject = ['webServer', 'connection']   // 硬依赖用 inject；可选服务用 ctx.inject 包一层

const PREFIX = '/daily-work'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ instances?: unknown[] }} config
 */
export function apply(ctx, config) {
  // 1) 服务本体（UI 与工具共用）
  const service = createDailyWorkService(ctx, config)   // 内部持有 storageDomain/credentials/timer

  // 2) 可选服务缺失时不要炸：storageDomain / credentials / timer
  ctx.inject(['storageDomain', 'credentials', 'timer'], (scoped) => {
    service.attach(scoped)
    scoped.effect(() => () => service.dispose(), 'daily-work: service')
  })

  // 3) 路由：一条 prefix 吃掉 /daily-work/*
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      // 3.1 宿主栅栏：Host/Origin + 浏览器登录（缺 connection 时 fail-closed）
      const rejection = ctx.get('connection')?.requestRejection?.({ headers: req.headers })
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'unauthenticated' }))
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const path = url.pathname.slice(PREFIX.length) || '/'

      try {
        if (req.method === 'GET' && path === '/v1/state') {
          return sendJson(res, 200, await service.state(url))
        }
        if (req.method === 'POST' && path === '/v1/refresh') {
          const body = await readJson(req, 64 * 1024)        // 限量 body
          return sendJson(res, 200, await service.refresh(body))
        }
        if (req.method === 'POST' && path === '/v1/review') {
          const body = await readJson(req, 64 * 1024)
          return sendJson(res, 200, await service.openReview(body))   // 见骨架 2 的流程
        }
        if (req.method === 'GET' && path === '/v1/stream') {
          return streamState(ctx, res)                       // 3.2 SSE
        }
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'not-found' }))
      } catch (error) {
        // 不吞错：把原因交给 UI（user-actions.md 的“失败要带原因”）
        sendJson(res, 500, { error: 'internal', message: String(error?.message ?? error) })
      }
    },
  }), 'daily-work: routes')

  // 4) 工具（与路由同一服务方法）
  ctx.effect(() => registerDailyWorkTool(ctx, service), 'daily-work: tools')
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

async function readJson(req, maxBytes) {
  const chunks = []; let received = 0
  for await (const chunk of req) {
    received += chunk.byteLength
    if (received > maxBytes) throw new Error(`body too large: ${received}`)
    chunks.push(chunk)
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// 3.2 SSE：心跳 + 卸载清理。切走/关闭窗口时 req 'close' 一定触发。
function streamState(ctx, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  const unsubscribe = ctx.get('dailyWorkBus')?.subscribe((event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }) ?? (() => {})
  const heartbeat = ctx.timer.interval(() => res.write(': ping\n\n'), 15_000)
  return new Promise((resolve) => {
    res.on('close', () => { unsubscribe(); heartbeat(); resolve() })
  })
}
```

> 备注：若改走 `connection.fetch.register({ path: '/daily-work/v1/state', methods: ['GET'], requestBody: 'buffered', fetch })`，鉴权与 body 模式由共享通道处理，`fetch(request)` 直接返回 `new Response(JSON.stringify(...))`，SSE 返回 `new Response(stream)` 即可——**代码更短，建议首版用它；上面的 webServer 版作为 dshmarket 验证过的兜底**。

## 12. 代码骨架 2/3 · Client：面板 + panellist 行 + 角标 + 顺序

> 位置：bundle 的 `client/client.js`（plain JS，`window.__ModuleLoader__.load`）；`package.json` 需 `exports["./client"]` 与 `dsh.client = { platform: 'web' }`

```js
window.__ModuleLoader__.load({
  id: 'dsh-daily-work',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'daily-work'
    const PANEL_ID = 'daily-work'
    const inject = ['slots', 'locale', 'layout']      // 只声明我们真正用的宿主服务

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, {
        zh: { panel: '每日工作台', inbox: '收件箱', review: '审查队列', settings: '设置', unread: '未读' },
        en: { panel: 'Daily work', inbox: 'Inbox', review: 'Review queue', settings: 'Settings', unread: 'Unread' },
      }), 'daily-work: dictionaries')
      const t = ctx.locale.bind(NS)

      // 1) 先注册 main（keyed），再注册 panellist 行——顺序只影响 selectPanel，不影响渲染
      const offPanel = ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }),
      }, () => h(Panel, { t })))

      // 2) 侧栏图标行：owner = { size, active }；角标自己画
      const offRow = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 1,
        label: () => t('panel'), locale: NS,
      }, (owner = {}) => h(PanelIcon, { size: owner.size ?? 16, active: owner.active === true }))) 

      // 3) 恢复上次视图：注册完成后才 selectPanel（否则 LayoutController 抛错，见 A3）
      ctx.inject(['layout'], (scoped) => {
        const saved = safeRead('daily-work:panel')
        if (saved === PANEL_ID) scoped.layout.selectPanel(PANEL_ID)
        scoped.effect(() => () => {
          if (scoped.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID) {
            scoped.layout.selectPanel(null)               // A8：卸载前回 Conversation
          }
          safeWrite('daily-work:panel', null)
        }, 'daily-work: panel memory')
      })

      return () => {
        // slots.inject 的返回值本身是 disposer；这里再兜一次，保证行先摘、面板后摘
        if (typeof offRow === 'function') offRow()
        if (typeof offPanel === 'function') offPanel()
      }
    }

    // —— 面板：三段式 + 自管状态（切走即卸载，所以偏好进 localStorage）——
    function Panel({ t }) {
      const [tab, setTab] = React.useState(() => safeRead('daily-work:tab') ?? 'inbox')
      const [items, setItems] = React.useState([])
      const [selected, setSelected] = React.useState(null)
      usePolledState('/daily-work/v1/state', setItems)       // 见骨架 3
      React.useEffect(() => { safeWrite('daily-work:tab', tab) }, [tab])
      return h('div', { style: { display: 'flex', height: '100%', background: 'var(--dsw-alias-bg-base)' } },
        h('nav', { style: { width: 280, borderRight: '0.5px solid var(--dsw-alias-border-l3)' } },
          h(Tabs, { tab, onChange: setTab, t }),
          h(ItemList, { items: items[tab] ?? [], selected, onSelect: setSelected, t })),
        h('section', { style: { flex: 1, minWidth: 0, overflow: 'auto' } },
          selected === null ? h(Empty, { t }) : h(Detail, { key: selected, item: selected, t })))
    }

    function PanelIcon({ size, active }) {
      return h('span', { style: { position: 'relative', display: 'inline-flex', width: size, height: size } },
        h('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true' }, /* 自绘路径 */),
        unreadCount > 0 && h('span', {
          'aria-label': t('unread'),
          style: {
            position: 'absolute', top: -2, right: -2, minWidth: 6, height: 6, borderRadius: 3,
            background: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-bg-danger, #e5484d)',
          },
        }))
    }

    function safeRead(key) { try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null } }
    function safeWrite(key, value) { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)) } catch {} }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
```

要点复述：**不要** require `ui-primitives`（B1）；`label` 用函数（A1）；`order` 决定行序；角标画在图标里（A5）；卸载顺序 `selectPanel(null)` → 摘行 → 摘面板（A8）。

## 13. 代码骨架 3/3 · Client：SSE 优先 + 轮询兜底（可见才连，切走就断）

```js
// 轮询：稳、幂等，带 ETag；面板不可见时降频/停摆
function usePolledState(path, onData, { intervalMs = 5000 } = {}) {
  const state = React.useRef({ etag: null, timer: null, stopped: false })
  React.useEffect(() => {
    state.current.stopped = false
    const tick = async () => {
      if (state.current.stopped || document.visibilityState !== 'visible') return
      try {
        const res = await fetch(api(path), {
          cache: 'no-store',
          headers: state.current.etag === null ? {} : { 'if-none-match': state.current.etag },
        })
        if (res.status === 304) return
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        state.current.etag = res.headers.get('etag')
        onData(await res.json())
      } catch (error) {
        console.warn('[daily-work] poll failed', error)      // 不静默：面板顶部另有一处错误条
      }
    }
    tick()
    state.current.timer = window.setInterval(tick, intervalMs)
    return () => { state.current.stopped = true; window.clearInterval(state.current.timer) }
  }, [path, intervalMs])
}

// 反代/前缀安全：以 document.baseURI 为基准（dshmarket 的 api() 就是为这个 bug 存在）
function api(path) {
  const relative = path.replace(/^\/+/, '')
  return typeof document === 'undefined' ? `/${relative}` : new URL(relative, document.baseURI).pathname
}

// SSE：可见才连；切走/卸载立即 close（EventSource 同源自动带登录 cookie）
function useStream(path, onEvent) {
  React.useEffect(() => {
    let source = null
    const open = () => {
      source = new EventSource(api(path))
      source.addEventListener('state', (e) => onEvent(JSON.parse(e.data)))
      source.onerror = () => {                        // 断线：让浏览器重试，但窗口不可见时不重连
        if (document.visibilityState !== 'visible') { source.close(); source = null }
      }
    }
    const sync = () => {
      if (document.visibilityState === 'visible') { if (source === null) open() }
      else if (source !== null) { source.close(); source = null }
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => { document.removeEventListener('visibilitychange', sync); source?.close() }
  }, [path])
}
```

取舍：**默认 `usePolledState`（5s）**；只有在"面板可见且用户开启了实时"时叠加 `useStream`，并在 `state` 事件里只传增量（`{unread, changed:[itemKey]}`），详情仍走按需 `GET /v1/items/:key`。

## 14. 待验证清单（按优先级，装一个最小插件即可批量收敛）

- **V1（高）** `agents.create()` 建出的会话是否立刻出现在左侧会话列表、可直接点开，并正常流式输出。若否，D 段要退回"创建 + 在面板内 SSE 回显"。
- **V2（高）** 客户端选中指定会话的公开方法（`ui-session`/`ui-workspace` 的 client service 名称与签名；本次 client Inspect 超时）。
- **V3（高）** Desktop（`dsh-app://` 或 `127.0.0.1`）下 `webServer` 自定义前缀路由是否可达、`requestRejection` 是否可用（dshmarket 明确未在 Desktop 验证过）。
- **V4（中）** `window.open` 在 Desktop 是否交给系统浏览器（否则默认改用"复制链接"）。
- **V5（中）** 自造 `SessionId` 的字符集/唯一性约束（`agents.create` 未限；`sessions.create` 会自动 mint `session-<n>`，可参考）。
- **V6（中）** 三个 preset 是否默认 `restrict` 掉全局工具（决定审查工具在 minimal preset 里是否可见）。
- **V7（中）** `forge.providers` 确实空（`changeRequestFromUrl(gitlabUrl) === undefined`），`forgePanel.track` 抛 `unrecognized-url`。
- **V8（低）** `cordis-client-runner` 的动态双半插件能否在**不编译**的前提下提供 remote/事件订阅（本 profile `absent`）。
- **V9（低）** `sidebar.panellist` 行被用户"取消固定"（`setPinned`，内存态，`client.js:17-30`）后是否影响我们的入口可达性。
- **V10（低）** `settings.describe({redactSecrets:true})` 在我们有 `Config.instances[].baseUrl` 时生成的表单是否可直接编辑（含数组增删）。 
- **V11（低）** `storageDomain` 的 `layout: 'single' | 'per-record'` 在 20 项目 × 数百条 item 下的读写表现（决定审计表是否要独立 domain）。
- **V12（低）** SSE 在 Desktop 下是否被中间层 buffer（`x-accel-buffering` 是否生效）。

## 15. 证据索引（可复核）

| 结论 | 证据位置 |
|---|---|
| `main` keyed、`entryKey = activePanelId ?? 'conversation'` | `app.asar/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js:118-120`, `:649-652` |
| `selectPanel` 校验 + `hasMainPanel` | 同上 `:467-472`, `:635` |
| `ctx.layout` 提供 + `panelInfo` 分享 | 同上 `:639-640` |
| `activePanelId` 初始 null（不持久化） | 同上 `:394`, `:410-412` |
| `sidebar.panellist` list 槽 + `syncPanels(id/order/label)` | `.../dsh-client-ui-sidebar/lib/client.js:663-682`, `:731-734` |
| panellist 工厂 props `{size, active}` | 同上 `:207-232`（`renderSlot("sidebar.panellist", { size, active }, { only: id })`） |
| `sidebar.toggle.badge` 仅折叠态 | 同上 `:389` |
| `sidebar.panellist.actions` props | 同上 `:280-285` |
| 面板 pin 仅内存 | 同上 `:17-30` |
| dshmarket 真实 main+panellist 注册与清理 | `$DSH_PROFILE_DIR/node_modules/dshmarket/client/client.js:18838-18855` |
| dshmarket 客户端只用 fetch、无 ctx.remote | 同上 `:18649`, `:18664`, `:2788-2792`；grep `ctx.remote` = 0 命中 |
| plain-JS bundle 形态与 require 表 | 同上 `:1`, `:29-33`；`.../dsh-client-modules/lib/client.js:1-9` |
| `dsh.client` / `WebBootEntry.external` | `.../dsh-client-modules/package.json:29-35`；`clientModules` 服务 `graph()` 的 `WebBootEntry` |
| webServer 路由/前缀/exact 语义 | `Service.listService('webServer')`：`register(route: WebRoute｜WebResourceRoute)` + `WebRouteKind='exact'｜'prefix'` |
| 共享 `/api` 通道与 fetch 路由/PeerScope | `Service.listService('connection')`：`HostConnectionFetch.register(ConnectionFetchRoute)`、`PeerScope`、`requestRejection`、`createSharedFetchHandler('/api')` |
| exact 路由绕开 /api 栅栏（必须自己加 gate） | `dshmarket/lib/index.js:126-129`, `:163-169`；`lib/http.js:46-67` |
| 路由注册的真实代码 + 方法/405 处理 | `dshmarket/lib/routes.js:2383-2429` |
| credentials 两个 key 空间 + `modifyRecord` 唯一写路径 | `Service.listService('credentials')` 描述与 `CredentialKey/GrantRecord/ApiKeyRecord` |
| storageDomain/KvTable/DomainSpec | `Service.listService('storageDomain')`：`DomainSpec{name,version,layout,global,tables}`、`KvTable.put/update/delete/entries` |
| settings 表单投影与 secrets 脱敏 | `Service.listService('settings')`：`describe({redactSecrets})`、`SettingsDescriptor.secrets`、`update/replace/mutate` |
| `agents.create(CreateAgentOptions)` 与 `AgentHandle` | `Service.listService('agents')`；`CreateAgentOptions{sessionId,meta.cwd,seed,agentOptions,setup}` |
| `agent.inject` 不唤醒 / `agent.followup` 唤醒 | `references/practices.md:29`（skill 文档，与本机 0.2.2 行为一致） |
| `session/created` vs `api-session/added` | `Event.listEvents`：两条事件签名与描述 |
| forge 接口无"列待我审"；watch 共享轮询 | `Service.listService('forge')`：`ForgeProvider` 全量方法 + `watch/latest/refresh` |
| forgePanel `track` 需 provider（否则 `unrecognized-url`） | `Service.listService('forgePanel')`：`track/dismiss/follow/changeRequestStates` |
| 组合内无 forge provider | `Config.listConfigs` 214 条（无 `dsh-forge-*`）；app.asar `package.json:18-265` 依赖表无 forge 包 |
| `open-in-app` 是"打开本地应用"的三条路由，非 URL 打开 | `.../dsh-host-open-in-app/package.json:3`、`lib/index.js:109-120` |
| timer vs schedule 语义 | `Service.listService('timer')`（`interval(cb,delay): () => void`）；`Service.listService('schedule')`（`create(sessionId, ...)`、`schedule/changed`） |
| 不允许 iframe / 不要 require client 包 | `references/practices.md:33`, `:35` |

> 说明：`app.asar/...` 前缀 = `D:/Program Files/DSH Desktop/resources/app.asar/node_modules/`；`$DSH_PROFILE_DIR` = `C:\Users\Administrator\AppData\Roaming\dsh-desktop\harness\profiles\web`。行号基于本次读取时的文件内容。