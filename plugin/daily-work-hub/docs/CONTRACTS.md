# daily-work-hub · 实现契约（唯一事实来源）

> 本文件是并行实现的接口合同。**任何与 DESIGN.md 冲突处，以本文件为准**，因为本文件的平台事实来自当前安装（DSH 0.13.x）的实测/源码取证，而 DESIGN.md §13 的部分结论来自旧版本。
> 最后更新：2026-11-09。

---

## 0. 平台事实（已核，不要重新猜）

| 事实 | 结论 |
|---|---|
| 宿主版本 | `app.asar` 内 `@deepseek-ai/*` 包为 **0.2.2-alpha.2** 系列；`dsh.client` 模块加载器为当前 release |
| 插件能否 `import '@deepseek-ai/...'` | **不能**。bundle 以 `file:` 链接，profile 的 `node_modules` 没有 `@deepseek-ai`，`schemastery`/`zod` 都不可解析。**所有宿主能力一律走 `ctx.get('service')` 或 `ctx.<service>`，禁止静态 import 宿主包。** |
| 客户端 bundle 格式 | `window.__ModuleLoader__.load({ id, factory })`；`factory(require)` 只注入 `require`。**禁止在 factory 里直接写 `exports` / `module`**（未声明即 ReferenceError，会导致 `client-modules: import failed` 并回退安全模式）。必须 `return { name, inject, apply }`。 |
| 客户端可 require | 仅 `react`（及宿主模块表里的平台包；本插件不依赖任何平台包）。 |
| Host 路由 | `ctx.webServer.register({ kind: 'exact', path, handler })`，`handler(request, response)` 是 Node `IncomingMessage/ServerResponse`。exact 路由**绕过** `/api` 前缀护栏，因此**必须自己**调 `ctx.get('connection').requestRejection({ headers: request.headers })`：返回 `401|403` 数字则已拒绝，`undefined` 表示放行。 |
| 持久化 | `ctx.get('storageDomain')`（可能不存在）：`await storageDomain.open(spec)`，`spec = { name, version, tables: { t: { valueSchema: { parse(v) } } }, global? }`。`valueSchema` 只需要有 `.parse()`，可用手写校验器（**不要**引入 zod）。域名/表名须匹配 `^[a-z][a-z0-9-]*$` 一类标识符。读同步、写返回 Promise 并保证落盘。**若服务缺失，退回 JSON 文件存储**（`lib/store.js` 负责，其他模块只依赖 store API）。 |
| 凭据 | `ctx.get('credentials')`：`resolve(ref)`，`ref` 形如 `DAILY_WORK_GITLAB_PAT`（`^[A-Za-z_][A-Za-z0-9_]*$`）。返回 `{ value, ... }` 或 `undefined`。`set(ref, value)` / `unset(ref)`。服务缺失时退回本地 `secrets.json`（0600），并在 UI 明示。 |
| 起会话 | `ctx.get('agents').create({ sessionId, meta:{ cwd }, agentOptions:{ provider, model }, setup(agentCtx, agent) })` → `AgentHandle { agent, dispose() }`。驱动：`handle.agent.followup({ content:[{type:'text', text}], source:{ kind:'daily-work-hub' } })`，等待：`await handle.agent.whenIdle()`。会话 id 用 `dw-<turnId>` 保证可回看。**setup 里只做注册**，创建完成后才能 followup。 |
| 结构化子代理 | `ctx.get('subagents').prompt(request, signal)`，`request.outputSchema` 走窄 JSON Schema 子集（`type/oneOf/properties/required/additionalProperties/items/enum/const/description/title/default/examples`）。失败/不可用时降级为本地启发式审查。 |
| 定时 | `ctx.get('timer').interval(fn, ms)` 返回 disposer；或用 `ctx.setInterval`（cordis 混入）。**禁止**用宿主 `schedule`（会话绑定提醒）。 |
| 工具/命令 | `ctx.get('tools').register(definition)`；`ctx.get('commands').register(definition)`。两者均为可选能力，注册失败必须降级且不影响面板。 |
| 宿主 actionCards | **本版本不接**。写操作确认改为面板内二次确认 + 服务端 `X-DW-Confirm` 校验（见 §3）。这是有意偏离 DESIGN §5.3 第 11 步，理由：跨进程卡片接线未验证，且失败会阻断主链路。 |

---

## 1. 文件所有权（并行开发，禁止越界改别人的文件）

| 模块 | 所有者 | 说明 |
|---|---|---|
| `lib/util.js`, `lib/store.js`, `lib/gitlab.js`, `lib/reasons.js`, `lib/poller.js`, `lib/routes.js`, `index.js`, `package.json`, `cordis.patch.yml`, `README.md`, `test/{store,gitlab,routes}.test.mjs` | **Lead** | 基础层与装配 |
| `lib/cron.js`, `lib/scheduler.js`, `lib/jobs.js`, `lib/runs.js`, `test/{cron,scheduler}.test.mjs` | **jobs-scheduler** | 纯逻辑 + 可注入时钟 |
| `lib/templates.js`, `lib/review.js`, `test/{templates,review}.test.mjs` | **review-ai** | 模板与审查流水线 |
| `client/client.js`, `locale/zh.json`, `locale/en.json` | **client-panel** | 整页面板 |
| 集成校验、`test/integration.test.mjs`、最终验收 | **Lead** | 只读别人的文件，问题通过改动自己文件或反馈解决 |

约定：ESM（`.js` + `"type":"module"`），Node 20+，**无构建步骤**，纯 JS + JSDoc。风格沿用现有 `index.js`：2 空格、单引号、不加分号、`export function`/`export const`。所有模块**导入时零副作用**，只导出工厂函数或纯函数。

---

## 2. 数据模型（store 内部表）

所有表都是 `key → JSON 记录`。`store` 负责序列化、修订号、事件通知。

```js
// items 表：key = `${source}|${subject}`，例如 "gitlab:default|gp/order-service#482"
WorkItem = {
  key, source, kind: 'mr' | 'issue',
  subject,                 // 只允许 [A-Za-z0-9#._:/@-]（校验过的字段）
  project, iid: number,
  title, author, link,     // link 只允许纯 ASCII URL
  reason,                  // 单一主原因，见 §4
  reasons: [string],       // 全部命中原因
  priority: number,        // 0-100，越大越急
  localState: 'unread' | 'read' | 'snoozed' | 'done' | 'archived',
  remoteState: 'open' | 'merged' | 'closed',
  headSha, baseSha, startSha,
  ci: { status, sha, url } | null,
  approvals: { approved, left, of, approvedByMe } | null,
  additions: number, deletions: number, changedFiles: number,
  unreadComments: number, unresolvedDiscussions: number,
  labels: [string], draft: boolean, mergeStatus: string,
  updatedAtRemote: ISO, lastEventAt: ISO, snoozedUntil: ISO | null,
  closedReason: string | null,
  lastTurn: { id, verdict, computedForHead, finishedAt, templateVersion } | null,
  findings: [Finding], commentDraft: { body, headSha, createdAt } | null,
  createdAt: ISO, seenAt: ISO | null,
}

// events 表：key = event.id，30 天保留
Event = { id, source, type, subject, summary, link, at, hops, data? }

// audit 表：key = `${at}#${seq}`，只追加
AuditEntry = { id, at, actor, kind, subject, detail }

// templates 表：key = template.id
Template = {
  id, name, version, scope: { projects: [], paths: [], exclude: [] },
  role, checklist: [string], context: [string], variables: [string],
  outputSchema: 'ReviewResult@1', model: { provider, model, temperature },
  enabled: boolean, stats: { used, adopted, ignored }, updatedAt,
}

// jobs 表：key = job.id（见 §5）
// runs 表：key = run.id（见 §5）
// turns 表：key = turn.id
Turn = {
  id, key, state: 'running' | 'done' | 'failed' | 'cancelled',
  mode: 'session' | 'subagent' | 'heuristic',
  startedAt, finishedAt, computedForHead, templateVersion, sessionId,
  verdict, findings: [Finding], coverage: { covered: [], skipped: [], oversized: [] },
  usage: { input, output }, error, note,
}
// views 表：key = view.id
// settings 表：key = 'singleton'
Settings = {
  gitlabBaseUrl, tokenRef, groups: [string], projects: [string],
  pollIntervalSec, quietHours: [string], reviewConcurrency,
  defaultProvider, defaultModel, allowWrites, excludePaths: [string],
  paused: boolean, includeIssues: boolean,
}
// meta 表：key = 'singleton'（游标、状态、修订号）
```

`Finding = { severity: 'blocker'|'high'|'medium'|'low', file, line, title, evidence, suggestion, adopted: 'pending'|'adopted'|'ignored', ignoreReason? }`

---

## 3. store API（其他模块只用这些方法）

全部 `async`（写返回 Promise；读也返回 Promise 以统一风格）。

```js
const store = await createStore({ ctx, logger, dataDir })   // lib/store.js

store.getRevision()                       // number，每次写递增
store.onChange(listener)                  // 返回取消订阅

// items
await store.items.list({ reason, project, state, kind, q, sort, limit, offset })
  // -> { rows: WorkItem[], total: number, counts: { unread, review, snoozed, running, failed } }
await store.items.get(key)                // WorkItem | undefined
await store.items.upsert(item)            // 按 (source, subject) 合并；返回最终记录
await store.items.patch(key, fn)          // fn(current) => next；自动附审计
await store.items.remove(key)             // 仅测试/清理

// events（去重 + 合并进 item 由 poller 做）
await store.events.record(events)         // -> { added: Event[], duplicates: number }
await store.events.pruneBefore(iso)

// audit
await store.audit.append({ actor, kind, subject, detail })
await store.audit.list({ subject, limit }) // 新→旧

// turns
await store.turns.put(turn); await store.turns.get(id); await store.turns.list({ key, limit })

// templates / jobs / runs / views
await store.templates.list(); await store.templates.get(id)
await store.templates.put(t); await store.templates.remove(id)
await store.jobs.list();      await store.jobs.get(id)
await store.jobs.put(j);      await store.jobs.remove(id)
await store.runs.list({ jobId, limit }); await store.runs.get(id); await store.runs.put(r)
await store.views.list(); await store.views.put(v); await store.views.remove(id)

// settings / meta
await store.settings.get()                 // 已合并默认值
await store.settings.patch(partial)
await store.meta.get()                     // { cursors, poll, seq, ... }
await store.meta.patch(partial)
```

审计必须由 `items.patch`、`jobs.*`、`settings.patch`、写操作路线自动追加，调用方不需要重复写。

---

## 4. reason / 优先级（`lib/reasons.js`，纯函数）

```js
computeReason(input) -> { reasons: string[], primary: string, priority: number }
// input: { kind, isAuthor, isReviewer, approvalsLeft, draft, mergeStatus,
//          ciStatus, mentionedMe, changesRequested, assignedToMe, newComments }
```

排序权重（用于 `priority` 与默认排列）：
`review_requested` 95 > `approval_required` 92 > `changes_requested` 85 > `conflict` 82 > `ci_failed` 78 > `assigned` 65 > `mentioned` 60 > `authored_feedback` 55 > `authored` 40 > `watching` 20`。
同权重按等待时长（`updatedAtRemote` 越旧越靠前）。

**自动收口白名单**（`localState → done`）：仅当 `remoteState` 变为 `merged` / `closed`。仅 `updatedAtRemote` 变化**不得**收口。收口写 `closedReason`，`undo` 可在 7 天内恢复为 `read`。

---

## 5. Job / Run 契约（jobs-scheduler 负责实现，Lead 消费）

```js
Job = {
  id, name, description, icon, enabled: boolean, version: number,
  trigger: { kind: 'manual'|'cron'|'event'|'after', cron?, tz?, catchUp?: 'skip'|'run-once',
             events?: [string], after?: { jobIds: [string], status: 'success'|'failure' } },
  executor: { kind: 'session'|'headless'|'command'|'dry-run', template?, skill?, prompt?,
              cwd?, access: 'read-only'|'workspace-write', command? },
  params: [{ key, type: 'string'|'number'|'enum'|'bool', values?, default?, required?: boolean }],
  inputs: [string],
  output: { kind: 'artifact'|'card'|'notification'|'workitem'|'none', path?, notify? },
  policy: { concurrency: number, laneKey?: string, timeoutMin: number,
            retry: { max: number, backoff: string }, quietHours?: [string],
            maxRunsPerDay: number, dryRun?: boolean },
  builtin?: boolean,
}

Run = {
  id, jobId, jobVersion, triggerSource: 'manual'|'cron'|'event'|'after',
  params, state: 'queued'|'running'|'succeeded'|'failed'|'interrupted'|'cancelled'|'skipped',
  reason?, scheduledAt, startedAt, finishedAt, sessionId?, usage?, hops: number,
  artifacts: [{ path, title? }], cardId?, log: [string], error?: string,
}
```

```js
createCron() // lib/cron.js
parseCron(expr) -> { fields }        // 非法抛 Error
nextRunAt(expr, tz, fromMs: number) -> number | null
describeCron(expr) -> string          // 中文摘要，如「每周五 18:00」

createScheduler({ store, now, execute, logger, tickMs })  // lib/scheduler.js
scheduler.start()                                   // 注册 timer，返回 disposer
await scheduler.tick()                              // 幂等；可被测试直接调用
await scheduler.runNow(jobId, params, 'manual')     // -> Run
await scheduler.cancel(runId)
await scheduler.recover()                           // 启动恢复：running→interrupted + retry
await scheduler.nextRuns(limit)                     // -> [{ jobId, at }]
```

- 幂等键 `jobId + scheduledAt`，同一到期只产生一个 Run。
- lane：`policy.laneKey` 相同则串行；不同 lane 并行，总并发受 `policy.concurrency` 限制。
- `catchUp: 'skip'` 默认；`'run-once'` 只补一次。
- after 链 `hops` 继承父 Run，`>= 8` 熔断（只审计，不派发）。
- `recover()` 对 `running` 且无活动执行的 Run 标 `interrupted`，按 `retry.max` 重试一次。
- `execute` 由 Lead 注入：`async ({ job, run, params, signal }) => ({ sessionId?, usage?, artifacts?, log? })`，抛错即 `failed`。
- 调度器不碰业务逻辑；不直接写 items/templates。

---

## 6. 审查契约（review-ai 负责实现，Lead 消费）

```js
createTemplateStore(store)                     // lib/templates.js
listTemplates(store), getTemplate(store, id), saveTemplate(store, input), removeTemplate(store, id)
renderPrompt(template, vars) -> { text, variables: string[] }   // 变量只来自白名单
validateTemplate(input) -> { ok, errors: string[] }
SEED_TEMPLATES                                  // 3 个内置模板（默认审查 / 安全审查 / 变更摘要）

createReviewer({ store, gitlab, templates, ctx, logger, config })  // lib/review.js
await reviewer.review(item, { templateId, concurrency }) -> Turn   // 同步跑完并落库
reviewer.plan(item) -> { segments, coverage }  // 分段计划（纯函数，可测）
reviewer.validateFindings(findings, diffIndex) -> { ok, findings, errors }  // 后校验，纯函数
reviewer.buildContextFiles(item, payload) -> { dir, files: { mr, diff, discussions, conventions } }
```

- 上下文**只写文件**：`mr.json`、`diff.patch`、`discussions.json`、`conventions.md`，路径写进提示词；**不得**把 MR 正文拼进提示词正文。
- 结构化输出优先 `subagents.prompt({ outputSchema })`；不可用则 `agents.create` + `followup` + 解析 `<review-result>JSON</review-result>` 围栏；再不行走 `heuristicFindings()`（纯本地规则：超大函数、`TODO/FIXME`、缺少测试、`console.log`、硬编码密钥、`any`/`eval`、未处理 Promise 等），并标 `mode:'heuristic'`、`note` 说明未做语义审查。
- 后校验四类：`file:line` 必须落在 diff 行上、路径必须存在于 diff、`evidence` 必须能在 diff 文本里逐字找到、`verdict` 与 findings 一致（有 blocker → 不能是 `approve-suggested`）。不通过重试一次，仍不通过降级为 `comments-only` + `note`。
- 结果写 `turns`，并把 `item.lastTurn` / `item.findings` 回写。

---

## 7. REST 契约（Lead 的 `lib/routes.js`；client-panel 只按此写）

前缀 `/api/daily-work`。响应统一 `{ ok, code?, message?, ...data }`，`Content-Type: application/json`，`Cache-Control: no-store`，写响应带 `ETag`/`revision`。

| 路由 | 方法 | 请求 | 响应 |
|---|---|---|---|
| `/state` | GET | — | `{ ok, revision, connection:{configured,baseUrl,verified,lastCheck,error}, counts:{unread,review,snoozed,running,failed,total}, status:{polling,paused,lastSuccessAt,nextPollAt,backoffMs,lastError}, nav:{reviewQueue,myWork,jobs,running,failed}, version, time }` |
| `/items` | GET | `reason,project,state,kind,q,sort,limit,offset` | `{ ok, revision, etag, total, counts, rows:[ItemRow] }` |
| `/item` | GET | `key` | `{ ok, item, detail:{mr,diffs,discussions,approvals,pipelines,files}, turn }` |
| `/actions` | POST | `{ action, key, params }` + 写操作带 `X-DW-Confirm` | `{ ok, data }`；`action ∈ review|summarize|draft-comment|publish-comment|approve|snooze|ignore|archive|unarchive|read|refresh-item|dismiss-finding|adopt-finding` |
| `/turns` | GET | `id` 或 `key` | `{ ok, turn }` / `{ ok, turns }` |
| `/templates` | GET/POST | `{ action:'save'|'remove'|'duplicate', template }` | `{ ok, templates }` |
| `/jobs` | GET/POST | `{ action:'save'|'remove'|'toggle', job }` | `{ ok, jobs }` |
| `/runs` | GET/POST | `{ action:'run'|'cancel', jobId?, runId?, params? }` | `{ ok, runs, run }` |
| `/run` | GET | `id` | `{ ok, run }` |
| `/settings` | GET/POST | `{ settings }` | `{ ok, settings, tokenSet }` |
| `/connect` | POST | `{ baseUrl, token }` | `{ ok, connection }`（写 token 到 credentials） |
| `/audit` | GET | `key` / `turn` | `{ ok, entries }` |
| `/refresh` | POST | `{ full? }` | `{ ok, status }` |
| `/views` | GET/POST | `{ action:'save'|'remove', view }` | `{ ok, views }` |

`ItemRow`（列表用的精简形状，**client 只依赖这些字段**）：
```js
{ key, kind, subject, title, project, author, link, reason, reasons,
  priority, localState, remoteState, headSha, ci, approvals,
  additions, deletions, changedFiles, unreadComments, unresolvedDiscussions,
  labels, updatedAtRemote, lastVerdict, hasFindings, draft, mergeStatus }
```

写操作（`publish-comment` / `approve` / `snooze` / `archive`…）要求 `X-DW-Confirm` 等于当前 `revision`，否则 `409 { ok:false, code:'confirm-required' }`。`approve` 额外要求 `item.headSha` 未变且 `settings.allowWrites !== false`。

---

## 8. 客户端要求（client-panel）

- 单文件 `client/client.js`，`window.__ModuleLoader__.load({ id:'daily-work-hub', factory:(require)=>{...} })`，**结尾 `return { name, inject, apply }`**；`inject = ['slots','locale','layout']`。
- 注册：
  ```js
  ctx.locale.register('daily-work-hub', { zh, en })          // 字典内联在 client.js（locale/*.json 只作参考/导出）
  ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:'daily-work-hub' }, HubPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name:'sidebar.panellist', id:'daily-work-hub', order:1, label:()=>'日常工作台', locale:'daily-work-hub' }, HubIcon))
  ```
  卸载时若当前面板是该 key，先 `ctx.layout.selectPanel(null)`。
- API 基址：`new URL('api/daily-work' + path, document.baseURI).pathname`；轮询 3s（列表）+ 1s（运行中）；用 `ETag`/`If-None-Match`，304 直接复用。
- 7 个一级入口：收件箱、审查队列、我的工作、项目、任务与自动化、提示词与技能、设置。
- 视觉只用 `--dsw-alias-*` token；行高 58–64；三栏 380/自适应/404；断点 1240 / 900。
- 键盘：`j/k` 上下、`Enter` 打开、`Esc` 返回、`e` 归档、`s` snooze、`a` 审查、`c` 起草评论、`r` 刷新。
- 失败降级：轮询失败顶部黄条、令牌失效红条、条目级错误不整页报错。
- 文件必须 `node --check client/client.js` 通过；不得含 `import `/`export ` 语句、不得调用未定义的 `exports`/`module`。
- 面板在无数据时显示明确空态（未配置 GitLab → 引导去设置）。

---

## 9. 测试要求

- `node --test test/` 全部通过，零外部依赖、零网络。
- 纯逻辑模块（cron、scheduler、templates、reasons、store 状态机、review 后校验）必须有单测。
- GitLab 客户端用注入的 `fetch` 打桩测试（不真连）。
- 路由测试用假 `ctx`（`webServer.register` 捕获 handler，直接喂 Node 风格 req/res 或封装好的 `invoke(path, {method, headers, body})`）。
- 集成测试：假 GitLab → poller 产收件箱 → review（heuristic 模式）→ draft → publish（假）全链路。