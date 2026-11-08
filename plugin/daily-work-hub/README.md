# daily-work-hub · 日常工作台

DeepSeek Harness 的整页工作台插件：把「GitLab 巡检 → 判断 → AI 审查 → 人工确认 → 处理 → 复盘」收进宿主里，并为可重复作业（手动 / 定时 / 并行 / after 链）提供任务库与运行历史。

- 面板：`sidebar.panellist` 图标行 + `main['daily-work-hub']` 整页（7 个一级入口、三栏布局、AI 抽屉）。
- Host：GitLab REST 采集、轮询与退避、工作项状态机、审查流水线、模板库、Job 调度器、运行历史、HTTP 接口、审计。
- 设计依据：仓库根 `DESIGN.md`；实现契约与平台取证：`docs/CONTRACTS.md`。

## 现在能用什么

| 能力 | 状态 |
|---|---|
| 设置页配置 GitLab（实例地址 + PAT，测试连接即验证） | ✅ |
| 定时轮询：待我审 MR、指派 Issue、我提的 MR、To-Do 补齐；`updated_at` + head 水位、失败退避（5min→1h，连续 10 次停手） | ✅ |
| 收件箱：reason 分组/过滤/搜索、未读、snooze、忽略、归档、批量动作、保存视图 | ✅ |
| MR 详情：概览、文件树 + 双栏 diff、讨论线程、CI 汇总、审批进度 | ✅ |
| 一键 AI 审查：真实 Session（不可用时结构化 subagent，再不行本地启发式）、结构化 findings、后校验、覆盖范围、stale 判定 | ✅ |
| 评论草稿 → 预览 → 人工确认发布（`X-DW-Confirm` 二次校验 + head 未变） | ✅ |
| 提示词模板：列表/编辑/变量白名单/版本/启用/预览渲染 | ✅ |
| 任务与自动化：Job 库、cron、手动 ▶、运行历史、重跑/取消/why 审计、参数表单、dry-run | ✅ |
| 并行与编排：同 lane 串行、跨 lane 并行、并发上限、after 链 8 跳熔断、重启恢复 | ✅ |
| 审计：只追加日志，`why(turnId)` 可回放 | ✅ |
| Agent 工具：`dailywork_list` / `dailywork_action`（写操作仍需人工确认） | ✅（宿主有 tools 服务时） |

## 安装与启用

```text
plugin_manager(action: "install_bundle", target: "<path>/daily-work-hub-0.2.0.tgz")
```

装好后**刷新页面**，左侧栏出现「日常工作台」图标；点开即整页面板。首次使用：

1. 设置 → GitLab 连接：填实例地址（如 `https://gitlab.example.com`）与 Personal Access Token（需要 `api` 或 `read_api`），点「测试连接」。
2. 采集范围：填要盯的项目（`group/repo`，逗号或换行分隔）或留空表示全部可见项目。
3. 节奏：轮询间隔（默认 60s，最小 15s）、静默时段、审查并发。
4. AI：默认 provider / model；「允许写操作」默认开，关掉后发布评论与 approve 一律拒绝。

PAT 走宿主 `credentials`（引用名 `DAILY_WORK_GITLAB_PAT`）；服务不可用时退回插件数据文件并在日志中明确告警。任何响应与日志都不含令牌明文。

## 结构

```
daily-work-hub/
  index.js                 # Host 装配：store → poller → reviewer → scheduler → routes → tools
  lib/util.js              # 时间/哈希/glob/令牌桶/重试/脱敏
  lib/store.js             # storageDomain 优先，退化到原子写 JSON；items/events/audit/templates/jobs/runs/turns/views/settings/meta
  lib/reasons.js           # reason 计算、优先级、状态机、自动收口白名单、分组/过滤/计数
  lib/gitlab.js            # REST 客户端：分页、限流桶、错误归一、路径穿越防护、能力探测回退
  lib/poller.js            # 轮询、水位、去重、合并且只在水位提交成功后推进游标
  lib/templates.js         # 模板 CRUD/校验/变量白名单（只允许文件引用）/渲染
  lib/review.js            # diff 解析、分段、上下文文件、启发式与模型结构化审查、后校验、聚合
  lib/cron.js              # 5 段 cron + 时区 + DST
  lib/scheduler.js         # tick、幂等键、lane、catchUp、after 链熔断、重启恢复
  lib/jobs.js              # 内置 4 个 Job、校验、归一、参数
  lib/runs.js              # Run 生命周期与执行器描述
  lib/routes.js            # /api/daily-work/*（前缀路由 + 自守 401/403）
  client/client.js         # plain-JS 动态 bundle（React.createElement，无构建步骤）
  test/                    # 106 个测试：node --test "test/*.test.mjs"
  docs/CONTRACTS.md        # 实现契约 + 平台取证
```

## 接口

前缀 `/api/daily-work`：`/state`、`/items`、`/item`、`/actions`、`/turns`、`/templates`、`/jobs`、`/runs`、`/run`、`/settings`、`/connect`、`/audit`、`/refresh`、`/views`。

- 全部响应 `{ ok, code?, message?, ...data }`；`no-store`；`/items` 带 `ETag`，`If-None-Match` 命中返回 304。
- 写操作（发布评论、approve、snooze、归档、忽略等）要求 `X-DW-Confirm: <revision>`，过期返回 `409 confirm-stale`。
- approve 额外要求 `allowWrites` 开启且 `headSha` 未变；AI 永不自动 approve / merge。

## 测试

```text
node --test "test/*.test.mjs"     # 106/106
```

覆盖：cron/DST、调度器 9 条语义、模板校验与版本、diff 解析/分段/启发式/后校验/聚合、GitLab 客户端（打桩 fetch）、存储持久化、路由与确认协议、**整插件端到端**（假 Cordis + 假 GitLab：连接→轮询→收件箱→详情→审查→草稿→确认发布→审计），以及**客户端 bundle 冒烟**（加载、导出契约、槽位注册、卸载）。

## 已知边界

- 未连真实 GitLab 实例验证（本机没有可用实例）；REST 语义按官方文档实现，能力探测做了三档回退。首次接真实实例时建议先看「测试连接」返回的 scopes。
- 未接宿主 `actionCards`：写操作确认改为面板内二次确认 + 服务端 `X-DW-Confirm`（跨进程卡片接线未在本版本验证，避免阻断主链路）。
- 审查的模型通道优先 `agents.create` 真实 Session，其次 `subagents.prompt`；两者都不可用时落到本地启发式，并在轮次 `note` 里明确「本轮未做语义审查」。
- `too_large` / 超大 diff 会显式标注覆盖范围（covered/skipped/oversized），不会假装审过。
- 客户端 bundle 只能用 `react`，样式只用 `--dsw-alias-*` token；改样式需刷新页面。