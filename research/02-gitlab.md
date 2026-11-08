# GitLab 集成 API 方案（P0：MR/Issue 轮询 + 一键 AI 审查）

任务 t2 research-gitlab｜核对基线：`docs.gitlab.com` 文档源文件（`gitlab-org/gitlab` master `doc/`），2026-11-08 抓取｜标记：✅=文档核对确认，⚠️=记忆/推断需实测，🚫=明确不支持。未发起真实 API 调用。

## 0. 结论摘要

1. P0 只靠轮询即可：审查队列 = MR 列表 + `/todos` + `/approvals` + `/discussions`，不依赖 webhook。
2. 主查询用 `scope=reviews_for_me`；`reviewer_username=me` **不要用**（文档只接受真实 username）✅。
3. `/events` 不返回 MR/Epic 事件 ✅ → 不能做 MR 收件箱。
4. `/changes` 已弃用（15.7，API v5 移除）✅ → 一律 `/diffs`。
5. 无 ETag/If-None-Match 文档支持 ⚠️ → 增量靠 `updated_after` + 指纹（`updated_at`/`sha`/notes 数/unresolved 数）。
6. 写操作硬限流：note/discussion 创建 **60 次/分钟**，且**不出现在 `RateLimit-*` 头**（application-level）✅。
7. Webhook 默认禁止指向本机与私网，需实例管理员开白 ✅；GitLab.com 无法改 → P0 仅轮询。
8. master 文档含 19.x 未发布变更（todos 限流 19.6、`draft` 过滤 19.0、`wip` 弃用、`changed_paths` beta）✅ → 必须"能力探测 + 降级"，目标 16.0–18.x。

## 1. 身份与权限

| 作用域 | 文档定义 ✅ | 用途 | 结论 |
|---|---|---|---|
| `api` | 令牌范围内 API 完整读写 | 轮询+评论+resolve+approve | **写操作必需** |
| `read_api` | 只读 API | 只读轮询/diff/CI | 只读模式够用，不能写 |
| `read_user` | 用户信息 | `GET /user`、`GET /events` | `read_api` 不覆盖 |
| `read_repository` | 仓库读（Git-over-HTTPS 或 repository files API） | 读文件原文 | 可选 |
| `write_repository` | 仓库写 | 不推代码 | 不申请 |

推荐：**双 token**——只读链 `read_api + read_user + read_repository`，写入链 `api` 仅在用户点「发布」时启用；自建实例用 **project access token**（作用域支持 personal/group/project ✅）收敛到单项目 + Developer 角色。启动自检三步：`GET /user` ✅（拿 username）→ `GET /personal_access_tokens/self` ✅（`scopes`/`expires_at`/`active`，提前 7 天告警）→ `GET /version` ⚠️（失败则跳过，改能力探测）。

| 版本差异 | 文档结论 | 插件策略 |
|---|---|---|
| `merge_status` → `detailed_merge_status` | `merge_status` **15.6 弃用** ✅ | 有则用 `detailed_merge_status`，否则 `merge_status`+`draft` 推导 |
| `has_conflicts` | 仅当 `merge_status=cannot_be_merged` 时为 true，否则 false（可能是"未检查"）✅ | 用 `detailed_merge_status`；精确值需 `with_merge_status_recheck=true` ⚠️ |
| `/approvals` | CE 只回 `approved`/`approved_by`/`user_can_approve`/`user_has_approved`；EE 全字段 ✅ | 字段缺失即降级为二值展示 |
| `/approval_state` | **Premium/Ultimate** ✅ | 403/404 → 关闭 code_owner 识别 |
| `approvals_before_merge` | **16.0 弃用** ✅ | 不依赖 |
| `draft` vs `wip` | `draft` 现役；`wip` **19.0 弃用** ✅ | 读写统一用 `draft` |
| `prepared_at` | ⚠️ 15.11+ | 为空 → 本轮跳过 |
| `collapsed`/`too_large` | 18.4 引入 ✅ | 字段缺失时按 `diff` 空推断 |

## 2. 「需要我审查的 MR」的定义与查询

| # | 信号 | 依据 | 端点 | 可靠性 |
|---|---|---|---|---|
| 1 | 我是 reviewer | `reviewers[].username==me` | `GET /merge_requests?scope=reviews_for_me&state=opened` ✅ | 高（主） |
| 2 | 我要审批 | `approval_rules_left[]`/`approval_state.rules[].eligible_approvers` ✅ | `.../approvals`、`.../approval_state` | 高（EE/Premium） |
| 3 | 我被 @ / 指派 | todo `action` ∈ `mentioned`/`directly_addressed`/`assigned` ✅ | `GET /todos?state=pending` | 高 |
| 4 | 我是 CODEOWNER | `rule_type=code_owner` + eligible_approvers ✅；或解析 CODEOWNERS 文件 ⚠️ | `.../approval_state` | 中 |
| 5 | 我参与过讨论 | `subscribed` + 我在 notes 作者中 | `.../discussions` | 中（仅"回看"） |

```
GET /merge_requests?scope=reviews_for_me&state=opened&order_by=updated_at&sort=desc&per_page=100   # 主
GET /merge_requests?scope=all&state=opened&reviewer_username=<username>&per_page=100               # 回退
GET /projects/:id/merge_requests?state=opened&reviewer_username=<username>&per_page=100            # 项目级
GET /merge_requests?scope=assigned_to_me&state=opened&per_page=100                                 # 我负责的
```

- MR 列表**默认只返回我创建的** ✅，必须显式 `scope`；不要用 `view=simple`（缺 `detailed_merge_status`/`draft`/`reviewers`）。
- 列表不主动重算 `merge_status` ✅ → 列表只做粗筛，精判打详情。
- 二次过滤：排除 `author==me`、`state!=opened`、`draft`（可配置）、**当前 head SHA 已审查过**；`detailed_merge_status∈{conflict,discussions_not_resolved,ci_still_running,not_approved}` 只打标不排除；`user_notes_count>30` 或 `changes_count` 过大 → 需用户显式触发。
- 排序打分（0–100）：`+30` 我是 reviewer 未审、`+20` 需我审批、`+15` CI 绿、`+10` 我参与过、`-20` draft、`-30` 文件>50、`+min(age_days*2,20)`。
- 审批语义坑 ✅：EE 下"无适用规则时 `approved=true` 且 `approved_by` 空"，CE 下"至少一个 approval 才 true"→ 文案不能把 `approved` 等同于"有人批准过"。
- CODEOWNERS：**REST 无专用端点** 🚫；优先用 `approval_state` 的 `code_owner` 规则反推；自行解析 `CODEOWNERS`/`docs/CODEOWNERS`/`.gitlab/CODEOWNERS`（优先级 ⚠️）列为 P1。

## 3. 收件箱类

- **`GET /todos`** ✅ 是最佳单端点：`state=pending`、`type=MergeRequest`、`action` 可枚举（`review_requested`/`approval_required`/`directly_addressed`/`mentioned`/`unmergeable`/`assigned`…）；返回 `id`/`action_name`/`target_type`/`target{}`/`project{}`/`created_at`；按用户限流 300/min（19.6+ feature flag，老实例无）✅；`POST /todos/:id/mark_as_done` ⚠️ 端点名需实测。
- **`GET /events`** ✅ 明确不含 MR/Epic 事件、批量 push 字段被截断 → 仅用于"我今天做了什么"活动流（P1 日报），**不作审查队列**。
- **`GET /issues?scope=assigned_to_me&state=opened&updated_after=`** ✅（`assignee_id` 与 `assignee_username` 互斥；`scope=all` 在 GitLab.com 可能 400 ✅）。
- **`GET /projects?membership=true&simple=true&per_page=100`** ✅；projects 支持 keyset（`pagination=keyset&order_by=id&sort=asc`）✅；限流 2,000/10min；`GET /groups` 仅 50/min（要用群组维度需注意）。

## 4. MR 详情与 diff

`GET /projects/:id/merge_requests/:iid` ✅ 关键字段：`iid`/`project_id`/`title`/`description`/`state`/`draft`/`sha`/`source_branch`/`target_branch`/`merge_status`/`detailed_merge_status`/`has_conflicts`/`changes_count`/`overflow`/`user_notes_count`/`blocking_discussions_resolved`/`prepared_at`(⚠️)/`reviewers`/`assignees`/`author`/`labels`/`milestone`/`references.full`/`web_url`。

| 端点 | 用途 | 关键点 |
|---|---|---|
| `.../diffs?page=&per_page=&unidiff=true` ✅ | 变更文件 diff | 默认 20/页，上限 100；元素含 `old_path/new_path/diff/new_file/deleted_file/renamed_file/generated_file/collapsed/too_large` |
| `.../raw_diffs` ✅ | `too_large` 兜底 | 走 Gitaly，慢但绕过 DB diff 限制 |
| `.../versions` ✅ | **行内评论 SHA 唯一来源** | 最新在最前；`base_commit_sha`/`head_commit_sha`/`start_commit_sha` |
| `.../changes` ✅ | **已弃用** | 15.7 弃用 → 禁用 |
| `.../commits`、`.../pipelines` | 提交/CI | 见第 7 节 |
| `.../discussions` ✅ | 行内评论树 | `resolvable`/`resolved`/`position{...}`；**无"只看未解决"参数** → 客户端过滤 |
| `.../notes` ✅ | 总览评论 | `DiscussionNote` 不在此端点 ✅ |
| `.../reviewers` ✅ | 谁没看 | `[{user, state:"unreviewed"/"reviewed"}]` |

GraphQL（一次拉详情+讨论树）：`MergeRequest.{approvalState, approved, conflicts, detailedMergeStatus, diffHeadSha, diffRefs{baseSha,headSha,startSha}, diffStats{additions,deletions}, discussions, notes(filter:), reviewers, userNotesCount, draft, reference(full), webUrl}` ✅；`Discussion.{resolvable,resolved,notes,replyId}` ✅；`Note.{position,resolvable,resolved,system,author}` ✅。限制 ✅：页 100、复杂度 250（未认证 200）、查询 10k 字符、**超时 30s**、blob 合计 20MB → diff 内容仍走 REST 分页。

**大 diff 分块**：≤20 文件全量；20–100 文件按风险排序（新增源文件 > 修改源文件 > 测试 > 文档/生成物）分页喂；>100 或 `overflow` 只喂统计+高风险文件 hunk；`too_large` 转读文件原文抽样；`generated_file` 排除；纯重命名不占预算。护栏：单 MR ≤60k 字符、单文件 ≤400 行、上下文不足时按 `position` 行号取 ±60 行。

## 5. 文件内容

- `GET /projects/:id/repository/files/:file_path/raw?ref=<sha>` ✅（路径须 URL-encode `%2F`；raw 端点 300/min、files API 500/min(IP+path) ✅）。
- `GET .../repository/files/:file_path?ref=` ✅ 元数据+base64（`size`/`content_sha256`/`last_commit_id`）。
- `GET .../repository/compare?from=&to=&straight=&unidiff=` ✅（`compare_timeout=true` 时 diffs 可能不完整）。
- `GET .../repository/commits/:sha/diff` ✅（force-push 后复审必用）；`GET .../repository/commits?ref_name=&since=&until=` ✅。
- 按需读取：只在 LLM 要求补上下文或 `too_large` 兜底时读，避免打满 raw 限流。

## 6. 写操作（审查结果落地）

**普通评论**：`POST /projects/:id/merge_requests/:iid/notes`，`body` 必填 ✅（60/min）。

**行内评论**（`POST .../discussions`）✅：

```
body=<文本>
position[position_type]=text                 # text | image | file
position[base_sha]=<versions[0].base_commit_sha>
position[head_sha]=<versions[0].head_commit_sha>
position[start_sha]=<versions[0].start_commit_sha>
position[old_path]=src/a.rb                  # 变更前路径
position[new_path]=src/a.rb                  # 变更后路径
position[new_line]=18                        # 新增行：只给 new_line
# 删除行：只给 old_line；未变更行：new_line + old_line 都给 ✅
position[line_range][start|end][{line_code,type,old_line,new_line}]   # 多行 ✅
```

`line_code` = `<SHA1(文件路径)>_<old>_<new>` ✅；四个 SHA 必须同版本（错用是 422 主因；文档标注已知 bug #296829 ✅）。

| 操作 | 端点 | 约束 |
|---|---|---|
| 解决/重开讨论 | `PUT .../discussions/:discussion_id?resolved=true` ✅ | Developer/Maintainer/Owner 或变更作者 |
| 批准 | `POST .../approve` ✅ | 需 eligible approver；带 `sha` 校验版本，不匹配 **409** ✅；开"需重新认证"时要 `approval_password` |
| 取消批准 | `POST .../unapprove` ✅ | 同上 |
| 改描述 | `PUT .../merge_requests/:iid`（`description`）✅ | 无 ETag → 读-改-写有丢失更新风险 ⚠️ |

写入策略：**默认 dry-run**（结果只落本地面板），用户逐条勾选后发布；每批 ≤10 条、批间隔 ≥3s（对应 60/min 的 1/3）；每条带幂等标记 `<!-- dsh-review:run=<id> sha=<sha> -->`；单条失败不中断，记录 `failed[]` 重放；**AI 永不自动 approve**（approve 需二次确认并带 `sha`）。

## 7. CI 与质量

| 数据 | 端点 | 关键字段 |
|---|---|---|
| MR 流水线 | `.../merge_requests/:iid/pipelines` ✅ | `id`/`status`/`sha`/`ref` |
| 单流水线 | `GET /projects/:id/pipelines/:pid` ✅ | `status`/`detailed_status`/**`coverage`**/`duration`/`yaml_errors` |
| 作业 | `GET /projects/:id/jobs?scope[]=…` ✅ / `.../pipelines/:pid/jobs` ⚠️ | `id`/`name`/`stage`/`status`；keyset 支持 ✅ |
| 失败日志 | `GET /projects/:id/jobs/:jid/trace` ✅ | 纯文本，只取尾部 ≤8KB |
| 测试摘要 | `GET .../pipelines/:pid/test_report_summary` ✅ | `total{count,success,failed,skipped,error}` |
| 依赖/漏洞 | `GET .../dependencies` ✅；`GET .../vulnerabilities`（Ultimate）✅ | `vulnerabilities[]`/`licenses[]`；漏洞 REST 正迁 GraphQL |
| 安全报告 | `GET .../jobs/:jid/artifacts/*` ⚠️ | 读 `gl-sast-report.json` 等；无专门"MR 安全报告"端点 🚫 |

门禁映射：pipeline `sha==mr.sha && status==success`；`yaml_errors==null`；`coverage>=baseline`；`failed==0`；无新增 high/critical 依赖；`blocking_discussions_resolved==true` 且 unresolved==0；`detailed_merge_status` 无 `conflict`。

## 8. 工程细节

- **分页** ✅：`per_page` 默认 20、上限 100；**按 `Link` 的 `rel="next"` 翻页**（不要自拼）；headers `x-next-page`/`x-total`；>10,000 条不返回 `x-total`/`x-total-pages`/`rel=last`；keyset 到末尾 `Link` 消失。
- **限流（GitLab.com 公开值）** ✅：认证 API 2,000/min/用户；note 创建 60/min（不在响应头）；raw 300/min；repository files 500/min(IP+path)；projects 列表 2,000/10min；单项目 400/min；`/groups` 50/min；todos 300/min(19.6+)；GraphQL 复杂度 250。
- **响应头** ✅：`RateLimit-Limit/Name/Observed/Remaining/Reset`；429 额外 `Retry-After`、`RateLimit-ResetTime`。两套限流并存：application-level **不在头里**；projects/groups/users 列表限流响应无信息头 ✅。
- **客户端三桶**：read 240/min、raw 60/min、write 20/min；`RateLimit-Remaining<20%` 全桶降 50%，`<5%` 降 10%。
- **ETag**：文档无 ETag/If-None-Match/304 说明 → 按不支持 ⚠️；实现前连续两次 GET 抓响应头确认。增量替代：`updated_after` + 指纹（`updated_at`+`sha`+`user_notes_count`+`unresolved_count`+`ci_status`）+ 懒加载详情/diff。
- **超时/重试**：单请求 30s（与 GraphQL 30s 对齐）；429 按 `Retry-After`/`RateLimit-Reset`；5xx 指数退避 `min(120, 2^n)+jitter`，≤4 次；401/403/404/422 不重试；409 重取版本后重试一次。
- **按项目预算**：小 ≤12 次/轮、中 ≤35、大 ≤60 且分片；项目数>20 时每轮只刷 1/3；一轮（2min）总调用 ≤300，留 50% 给用户手动操作。
- **项目迁移**：GET 会 301+`Location` ✅；非 GET 对旧路径 405 ✅ → **所有写操作用数字 `project_id`**。

## 9. Webhook 替代方案

| 方案 | 可行性 | 前置 | 实时性 | 取舍 |
|---|---|---|---|---|
| **A 仅轮询（P0）** | 任何环境 | PAT | 1–3 min | 零基础设施、可预测限流；有空转 |
| B 本地反代 + 允许私网 webhook（P1） | 自建实例 | ①管理员勾选"Allow requests to the local network from webhooks and integrations" ②本机/内网可达 HTTPS 反代 ③签名 token 校验 | 秒级 | GitLab **默认禁止**指向 `127.0.0.1`/私网/实例自身 ✅；GitLab.com 不可行；接收端慢会被自动禁用 ✅ |
| C 中心中继（P2） | 团队 | 公网中继 + 本地推送通道 | 秒级 | 多一层服务与信任边界 |
| D 自适应轮询 | 任何环境 | 纯客户端 | 10–60 s | 聚焦 30s、后台 3min、隐藏 10min + 手动刷新 |

P0 = A + D；B 作为 P1 可选增强（webhook 只用于"提前触发一次轮询"，事件仍以 REST 回读为准——事件会重复/乱序/丢失）。

## 10. 安全

Token 存 **DSH credentials**（不写插件配置/日志/localStorage）；只读链与写入链分离；`expires_at` 提前 7 天告警；日志脱敏 `PRIVATE-TOKEN`/`Authorization`/`X-Gitlab-Token`/`private_token`/`access_token` 及疑似密钥（`glpat-`/`ghp_`/`AKIA`），日志只出现 `project_id`+`iid`；自建实例自签证书必须显式配 CA（禁止 `NODE_TLS_REJECT_UNAUTHORIZED=0`），提供"信任此证书（显示指纹）"确认；仅允许 `https://`（`http://` 需显式确认）；支持 `HTTPS_PROXY`；写操作默认 dry-run + 审计（`run_id → note_id/discussion_id`）；403 需区分"作用域不足"与"项目角色不足"。

## 附录 A：API 调用清单（24 条）

| # | 用途 | 方法 / 路径 | 关键参数 | 关键返回字段 | 分页 | 限流/备注 | 核对 |
|---|---|---|---|---|---|---|---|
| 1 | 我是谁 | `GET /user` | — | `id`,`username`,`name`,`state` | 1 | 需 `read_user` 或 `api` | ✅ |
| 2 | 令牌自检 | `GET /personal_access_tokens/self` | — | `scopes`,`expires_at`,`active`,`last_used_at` | 1 | — | ✅ |
| 3 | 实例版本 | `GET /version` | — | `version`,`revision` | 1 | 权限行为待实测 | ⚠️ |
| 4 | 我参与的项目 | `GET /projects` | `membership=true`,`simple=true`,`pagination=keyset`,`order_by=id`,`sort=asc` | `id`,`path_with_namespace`,`default_branch` | 100 | 2,000/10min | ✅ |
| 5 | **审查队列（主）** | `GET /merge_requests` | `scope=reviews_for_me`,`state=opened`,`order_by=updated_at`,`per_page=100` | `iid`,`project_id`,`title`,`draft`,`sha`,`detailed_merge_status`,`user_notes_count`,`reviewers`,`references.full` | 100 | 默认只回我创建的 | ✅ |
| 6 | reviewer 过滤回退 | `GET /merge_requests` | `scope=all`,`state=opened`,`reviewer_username=<u>` | 同上 | 100 | 不接受 `me` | ✅ |
| 7 | 项目级队列 | `GET /projects/:id/merge_requests` | `state=opened`,`reviewer_username=` | 同上 | 100 | 便于项目预算 | ✅ |
| 8 | 我负责的 MR | `GET /merge_requests` | `scope=assigned_to_me`,`state=opened` | 同上 | 100 | — | ✅ |
| 9 | **待办** | `GET /todos` | `state=pending`,`type=MergeRequest`,`action=` | `id`,`action_name`,`target_type`,`target{}`,`created_at` | 100 | 300/min(19.6+) | ✅ |
| 10 | 指派 issue | `GET /issues` | `scope=assigned_to_me`,`state=opened`,`updated_after=` | `iid`,`title`,`labels`,`due_date`,`updated_at` | 100 | `scope=all` 可能 400 | ✅ |
| 11 | 活动流 | `GET /events` | `target_type=`,`action=`,`after=` | `action_name`,`target_type`,`target_iid`,`created_at` | 100 | **不含 MR/Epic** | ✅ |
| 12 | MR 详情 | `GET /projects/:id/merge_requests/:iid` | `with_merge_status_recheck`⚠️ | 见第 4 节 | 1 | 不主动重算 merge_status | ✅ |
| 13 | 变更 diff | `GET .../diffs` | `page=`,`per_page=`,`unidiff=true` | `old_path`,`new_path`,`diff`,`too_large`,`collapsed`,`generated_file` | 20/100 | 受实例 diff 限制 | ✅ |
| 14 | 原始 diff | `GET .../raw_diffs` | `page=`,`per_page=` | 同上 | 20/100 | 走 Gitaly 慢 | ✅ |
| 15 | **diff 版本** | `GET .../versions` | — | `base_commit_sha`,`head_commit_sha`,`start_commit_sha` | 20/100 | 最新在前 | ✅ |
| 16 | 变更概览（弃用） | `GET .../changes` | `access_raw_diffs` | `changes[]`,`overflow` | 1 | 15.7 弃用→禁用 | ✅ |
| 17 | 提交 | `GET .../commits` | — | `id`,`short_id`,`title`,`created_at` | 20/100 | — | ✅ |
| 18 | MR 流水线 | `GET .../pipelines` | — | `id`,`status`,`sha`,`web_url` | 20/100 | — | ✅ |
| 19 | 审批状态 | `GET .../approvals` | — | `approved`,`approvals_left`,`approval_rules_left`,`approved_by`,`user_can_approve` | 1 | CE 只 4 字段 | ✅ |
| 20 | 规则级审批 | `GET .../approval_state` | — | `rules[]{name,rule_type,eligible_approvers,approvals_required,approved}` | 1 | **Premium+** | ✅ |
| 21 | 评审人状态 | `GET .../reviewers` | — | `user`,`state`,`created_at` | 20/100 | — | ✅ |
| 22 | **讨论树** | `GET .../discussions` | `per_page=100` | `id`,`notes[]{body,author,system,resolvable,resolved,position}` | 20/100 | 无未解决过滤 | ✅ |
| 23 | 总览评论 | `GET .../notes` | `sort=desc` | `body`,`author`,`system`,`created_at` | 20/100 | DiscussionNote 不在 | ✅ |
| 24 | GraphQL 聚合 | `POST /api/graphql` | `query`,`variables` | 见第 4 节 | 100 nodes | 复杂度 250 / 30s | ✅ |
| 25 | 文件原文 | `GET .../repository/files/:path/raw` | `ref=<sha>` | 纯文本 | 1 | raw 300/min；files 500/min | ✅ |
| 26 | 文件元数据 | `GET .../repository/files/:path` | `ref=` | `size`,`encoding`,`content_sha256` | 1 | 路径 encode | ✅ |
| 27 | 分支对比 | `GET .../repository/compare` | `from=`,`to=`,`straight=`,`unidiff=` | `commits[]`,`diffs[]`,`compare_timeout` | — | 可能截断 | ✅ |
| 28 | 单提交 diff | `GET .../repository/commits/:sha/diff` | — | `diffs[]` | — | force-push 复审 | ✅ |
| 29 | 单流水线 | `GET /projects/:id/pipelines/:pid` | — | `status`,`coverage`,`detailed_status`,`yaml_errors` | 1 | — | ✅ |
| 30 | 测试摘要 | `GET .../pipelines/:pid/test_report_summary` | — | `total{count,success,failed,skipped,error}` | 1 | — | ✅ |
| 31 | 失败日志 | `GET /projects/:id/jobs/:jid/trace` | — | 纯文本 | — | 取尾部 | ✅ |
| 32 | 依赖 | `GET /projects/:id/dependencies` | `package_manager=` | `name`,`version`,`vulnerabilities[]`,`licenses[]` | 20/100 | Gemnasium 语言限定 | ✅ |
| 33 | **写：总览评论** | `POST .../merge_requests/:iid/notes` | `body` | note 对象 | — | **60/min** | ✅ |
| 34 | **写：行内评论** | `POST .../merge_requests/:iid/discussions` | `body`,`position[...]` | discussion 对象 | — | 422/409 | ✅ |
| 35 | **写：resolve/approve/描述** | `PUT .../discussions/:did?resolved=true`；`POST .../approve`(`sha`)；`POST .../unapprove`；`PUT .../merge_requests/:iid`(`description`) | — | 对应对象 | — | approve 需 eligible approver | ✅ |

（P1 补充：`GET/POST /projects/:id/hooks`、`POST .../hooks/:hid/events/:eid/resend` ✅；`POST /todos/:id/mark_as_done` ⚠️；`GET .../jobs/:jid/artifacts/*` ⚠️；`GET .../repository/changed_paths`（beta/flag）⚠️。）

## 附录 B：『MR 审查数据包』字段定义

`ReviewPackage` 唯一键 = `project_id + iid + head_sha`（配 `run_id`），保证同版本不重复审查。

| 分组 | 字段 | 类型 | 来源 | 上限/截断 |
|---|---|---|---|---|
| 元 | `schema_version`/`run_id`/`generated_at` | string | 本地 | — |
| 项目 | `project{id,path_with_namespace,default_branch,web_url}` | object | #4/#12 ✅ | — |
| MR | `mr{iid,id,project_id,title,description,state,draft,author,assignees[],reviewers[],source_branch,target_branch,head_sha,diff_refs{base_sha,head_sha,start_sha},changed_files_count,labels[],milestone,web_url,reference,detailed_merge_status,has_conflicts,blocking_discussions_resolved,prepared_at}` | object | #12/#15 ✅ | `description` ≤8000 字符 |
| 文件 | `files[]{old_path,new_path,new_file,deleted_file,renamed_file,generated_file,too_large,collapsed,additions,deletions,language,risk}` | array | #13 ✅ + 本地推断 | ≤200 文件；`risk`=high/medium/low |
| Hunk | `hunks[]{file_path,old_start,old_lines,new_start,new_lines,header,lines[]{type(+/-/ ),old_line,new_line,text},truncated}` | array | #13 解析 ✅ | 单文件 ≤400 行、单 MR ≤60k 字符；**行号必须保留**（写行内评论直接复用） |
| 上下文 | `context_files[]{path,ref,lines[],reason}` | array | #25 ✅ | ≤10 文件、单文件 ≤200 行 |
| CI | `ci{pipeline_id,pipeline_sha,status,detailed_status,coverage,duration,yaml_errors,failed_jobs[],failed_job_trace_tail,tests{total,success,failed,skipped,error},gates[]{name,status,detail}}` | object | #18/#29/#30/#31 ✅ | trace 尾部 ≤8KB |
| 审批 | `approvals{approved,approvals_left,approvals_required,approved_by[],user_can_approve,user_has_approved,rules[],i_am_code_owner}` | object | #19/#20 ✅ | CE 字段缺失即降级 |
| **历史评论** | `discussions{unresolved_count,my_last_review_at,items[]{id,resolvable,resolved,notes[]{id,author_username,system,body,created_at,position,resolvable,resolved}},summary_for_llm}` | object | #22 ✅ | ≤100 讨论、每讨论 ≤20 note、单 note ≤2000 字符；系统 note 折叠成计数 |
| 待办 | `todos[]{action_name,target_type}` | array | #9 ✅ | ≤20 |
| **项目约定** | `project_conventions{conventions_doc,mr_template,codeowners_excerpt,review_checklist[],language_rules[],severity_policy{blocker,major,minor,nit}}` | object | 仓库文件 ⚠️ + 本地提示词库 | `conventions_doc` ≤4000 字符 |
| 预算 | `budget{chars_used,files_sent,hunks_sent,truncated}` | object | 本地 | — |

历史评论处理要点：`resolved==false && resolvable==true` 计入 `unresolved_count` ✅；`system=true`（"added 3 commits"）不进 LLM 正文；`my_last_review_at` 用于判断"我是否已审过这一版"；行内评论的 `position.new_line/old_line` 保留，便于"AI 不重复报同一个问题"。

## 附录 C：轮询策略表

| 数据类 | 端点 | 基准频率 | 聚焦 | 后台/隐藏 | 单次预算 |
|---|---|---|---|---|---|
| 审查队列 | #5 | 120s | 60s | 600s | 1–2 调用 |
| 待办 | #9 | 120s | 60s | 600s | 1 |
| 我负责的 MR | #8 | 300s | — | 900s | 1 |
| MR 详情（变更项） | #12 | 120s | 60s | 600s | ≤10 MR/轮 |
| diff | #13 | **按需** | 按需 | — | ≤5 调用/轮 |
| versions | #15 | 审查前 | — | — | 1/审查 |
| 审批 | #19 | 300s | 120s | 900s | ≤10/轮 |
| 规则级审批 | #20 | 600s | — | — | ≤5/轮（仅 Premium+ 且 approvals_left>0） |
| 讨论树 | #22 | 300s | 120s | 900s | ≤10/轮 |
| CI | #18/#29 | 90s | 60s | 600s | ≤10/轮 |
| 失败日志 | #31 | 按需 | — | — | ≤2/轮 |
| 项目清单 | #4 | 3600s | — | — | keyset 全量 |
| 指派 issue | #10 | 300s | 180s | 900s | 1 |
| 依赖/漏洞 | #32 | 6–24h | — | — | 1/项目 |
| 活动流 | #11 | 每日 | — | — | 1–2 页 |

总预算：任意 60s 窗口 ≤240 读 + 20 写；一轮 2min ≤300 调用。连续 6 轮无变化 → 频率 ×2（上限 10min）；聚焦/手动刷新 → 立即恢复基准。

## 附录 D：增量轮询算法（伪代码）

```
state = {
  caps:   {reviews_scope, detailed_merge_status, approval_state, diffs_collapsed},  # 能力探测结果
  cursors: {todos_last_id, issues_updated_after, per_project{pid: mr_updated_after}},
  fp:      {"<pid>!<iid>": {updated_at, head_sha, user_notes_count, unresolved_count, ci_status}},
  budget:  TokenBucket(read=240/60s, raw=60/60s, write=20/60s, adaptive=1.0)
}

def tick(now):
  if not healthy(): return                                   # 401 后短路
  changed = []
  # 1) 最便宜的信号：todos（分页靠 Link/X-Next-Page）
  for t in paginate("/todos", {state:"pending", per_page:100}):
      if t.target_type == "MergeRequest": changed += key(t.project.id, t.target.iid, t.action_name)

  # 2) 主队列（scope=reviews_for_me），不信 x-total，按 Link rel=next 翻页
  page = get("/merge_requests", {scope:"reviews_for_me", state:"opened",
                                 order_by:"updated_at", sort:"desc", per_page:100})
  while page:
      for mr in page.items:
          if mr.author.username == me or (mr.draft and not cfg.review_drafts): continue
          changed += key(mr.project_id, mr.iid, mr.updated_at, mr.sha)
      page = follow(page.link, "next")

  # 3) 项目级增量（轮转 1/3 项目）
  for pid in rotate(projects, now.round % 3):
      mrs = get(f"/projects/{pid}/merge_requests",
                {state:"opened", reviewer_username: me_username,
                 updated_after: cursor(pid).mr_updated_after, per_page:100})
      changed += [key(pid, mr.iid, mr.updated_at, mr.sha) for mr in mrs]

  # 4) 指纹去重 → 只对"真的变了"的 MR 拉详情
  for k in dedupe(changed):
      detail = get(f"/projects/{k.pid}/merge_requests/{k.iid}")     # 1 次
      if detail.prepared_at is None: schedule_retry(k, +60s); continue   # ⚠️ 未就绪
      fp = {updated_at: detail.updated_at, head_sha: detail.sha,
            user_notes_count: detail.user_notes_count}
      discs = paginate(f"…/{k.iid}/discussions", per_page:100)       # 只在详情页/审查需要
      fp.unresolved_count = count(d for d in discs if d.resolvable and not d.resolved)
      if fp == state.fp.get(k) and not force(k): continue           # 无 ETag → 用指纹跳过
      if caps.approval_state and get(f"…/{k.iid}/approvals").approvals_left:
          rules = safe_get(f"…/{k.iid}/approval_state")              # Premium+，404 则关能力
      pipes = get(f"…/{k.iid}/pipelines"); fp.ci_status = head_of(pipes, detail.sha)
      if within_budget(k): enqueue_review(k, detail, discs, fp)      # 懒取 diff，不在此处拉
      else: mark_needs_manual(k)
      state.fp[k] = fp

  # 5) 水位只在整轮成功后推进（至少一次语义 + 写入侧幂等标记去重）
  if all_ok():
      state.cursors.todos_last_id = max_id(todos)
      state.cursors.issues_updated_after = now.iso8601()
      for pid in touched: cursor(pid).mr_updated_after = now.iso8601()
  persist_atomic(state)          # 写临时文件再 rename，避免崩溃留半截

def publish(k, selected):        # 用户显式触发；默认 dry-run
  refs = versions_latest(k)      # base/head/start 同版本
  for batch in chunks(selected, 10):
      for f in batch:
          body = with_marker(f, run_id)                       # <!-- dsh-review:... --> 幂等
          if posted(k, f.fingerprint): continue
          try:    post(f"…/{k.iid}/discussions", {body, position: pos(f, refs)})
          except 409: refs = versions_latest(k); retry_once(f, refs)   # 版本变了
          except 422: downgrade_to_note(f)                    # 定位失败→总览评论
      sleep(3 + jitter())                                      # 60/min 的 1/3
  if user_confirmed: post(f"…/{k.iid}/approve", {sha: k.head_sha})
```

要点：水位只在成功后推进；指纹跳过替代 ETag；列表/详情绝不拉 diff（懒取）；写桶独立；approve 带 `sha` 保证版本一致，行内评论用 `/versions` 的 SHA，409 重取一次后降级。

## 附录 E：错误码与降级

| 状态 | 含义 | 重试 | 插件行为 |
|---|---|---|---|
| 301 | 项目迁移（仅 GET）✅ | 1 次（跟随 `Location`） | 更新本地 path；写操作用 `project_id` |
| 400 | 参数非法（`scope=all` 被限、`reviewer_username=me`、position 缺字段）✅ | 否 | 去 `scope=all`/换真实 username |
| 401 | token 无效/过期/吊销 | **否** | 暂停该实例轮询；面板提示重配；缓存只读 |
| 403 | 作用域不足/角色不足/审批需重认证/规则不可编辑 ✅ | 否 | 区分文案（缺 scope vs 缺 Developer 角色） |
| 404 | 资源不存在/端点在该版本无（CE 的 `approval_state`）✅ | 否 | 关闭对应能力（code_owner、多字段审批） |
| 405 | 对迁移项目发非 GET ✅ | 否 | 改用 `project_id` |
| 409 | approve 的 `sha` 不符 ✅ / 行内评论版本过期 ⚠️ | 1 次 | 重取 `/versions` 或详情后重试；仍失败→转总览评论 |
| 422 | position 非法（行号/路径/SHA 组合）✅ | 否 | 该 finding 降级为总览评论并计数 |
| 429 | 限流（Rack::Attack 或 application-level）✅ | 是 | 按 `Retry-After`/`RateLimit-Reset` 等待；本桶降速 50% |
| 500/502/503 | 服务端 | 是（≤4，指数+抖动） | 失败后标"数据陈旧"，UI 显示最后更新时间 |
| 超时/504 | 大 diff、raw、trace | 1 次（缩小 `per_page`） | 半页/尾部读取；仍失败→标"需手动" |
| GraphQL complexity | >250 ✅ | 否 | 拆查询、减 `first:` |
| GraphQL 超时 | 服务端 30s ✅ | 是（缩范围） | 讨论树分页 |
| 证书错误 | 自签 | 否 | 弹指纹确认，写入 trusted CA（不全局关校验） |

降级阶梯：正常 → 降频(50%) → 只读（禁写）→ 只读缓存（暂停请求，显示"数据截至 X"）→ 离线。

## 附录 F：与 forge 的分工

假设：宿主 forge 提供本地仓库/工作区与 git 操作（fetch/branch/checkout/文件读取），但**没有**评论、批准、Issue、commit-range diff 这些 GitLab 语义能力。据此划界：

| 能力 | 宿主 forge | 插件自有 GitLab 客户端 | 说明 |
|---|---|---|---|
| 本地 git 操作、工作区文件 | ✅ 由 forge 负责 | ❌ 不重复实现 | 避免两套 git 状态 |
| 按 ref 读远端历史版本文件 | ❌ | ✅ `repository/files/:path/raw?ref=`、`/blob` | forge 通常只有工作区/HEAD |
| MR 列表/详情/审批/reviewer 语义 | ❌（最多 branch 信息） | ✅ `scope=reviews_for_me`、`/approvals`、`/approval_state` | 审查队列的数据基础 |
| **评论与行内评论** | ❌ | ✅ `POST /notes`、`POST /discussions`+`position` | 核心写能力，必须自有 |
| **批准/取消批准** | ❌ | ✅ `POST /approve`(`sha`)、`/unapprove` | 含 409 版本校验与二次确认 |
| 讨论 resolve/unresolve | ❌ | ✅ `PUT /discussions/:id?resolved=true` | — |
| **Issue / todos 收件箱** | ❌ | ✅ `/todos`、`/issues?scope=assigned_to_me` | forge 无此概念 |
| **commit-range diff** | ❌ | ✅ `/repository/compare`、`/commits/:sha/diff` | force-push 后复审唯一途径 |
| CI 状态/失败日志/覆盖率 | ❌ | ✅ `/pipelines`、`/jobs/:id/trace`、`test_report_summary` | — |
| 认证/限流/重试/游标/脱敏 | ❌ | ✅ 三桶限流器 + 指纹游标 + 错误映射 | 与宿主网络层解耦，只借其代理/CA 能力 |

结论：**插件必须自带完整 GitLab REST/GraphQL 客户端**（认证、分页、限流、重试、错误映射、身份自检）；宿主 forge 只提供本地仓库与凭据/代理基础设施。这样"评论/批准/Issue/commit-range diff"不会被 forge 的能力边界卡住，也便于把客户端抽成可复用模块（未来接 GitHub/Gitea 只换适配层）。

## 附录 G：参考与待核对

核对来源（文档源文件 + 渲染页）：`/api/rest/`、`/api/merge_requests/`、`/api/merge_request_approvals/`、`/api/discussions/`、`/api/notes/`、`/api/todos/`、`/api/events/`、`/api/issues/`、`/api/projects/`、`/api/repository_files/`、`/api/repositories/`、`/api/commits/`、`/api/pipelines/`、`/api/jobs/`、`/api/dependencies/`、`/api/vulnerabilities/`、`/api/users/`、`/api/personal_access_tokens/`、`/api/project_webhooks/`、`/api/graphql/`、`/api/graphql/reference/objects/`、`/security/tokens/access_token_scopes/`、`/user/gitlab_com/rate_limits/`、`/administration/settings/user_and_ip_rate_limits/`、`/security/webhooks/`、`/user/project/integrations/webhooks/`、`/user/project/merge_requests/reviews/`（均为 `docs.gitlab.com` 前缀）。

实现前必须实测：① `GET /version` 可用性 ② `scope=reviews_for_me` 最低版本 ③ `reviewer_username` 是否接受 `me`（结论：不接受）④ `approval_state` 的 Tier ⑤ `collapsed`/`too_large` 是否存在 ⑥ **ETag/304 是否真的不支持** ⑦ `/todos` 限流开关 ⑧ jobs artifacts 路径 ⑨ 自建实例 `per_page` 与 diff 限制 ⑩ 自签证书 CA 配置 ⑪ `prepared_at` ⑫ `blocking_discussions_resolved` ⑬ GraphQL `approvalState.rules` 字段名 ⑭ `scope=all` 在 GitLab.com 的可用性 ⑮ 写限流实际阈值。

*变更记录：2026-11-08 首版（文档级核对，无真实 API 调用）。*