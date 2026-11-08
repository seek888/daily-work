/**
 * daily-work-hub — Client half (plain-JS dynamic bundle, no build step).
 *
 * Format: `window.__ModuleLoader__.load({ id, factory })`. `factory(require)`
 * receives the host module table; React is the only module required. The
 * factory must NOT touch `exports` / `module` — those are undeclared inside the
 * loader wrapper and a ReferenceError blanks the slot. The exports object is
 * returned instead.
 *
 * Surfaces:
 *   - `main` (keyed full-page panel, key `daily-work-hub`)
 *   - `sidebar.panellist` row (icon + unread badge)
 *
 * Visual rules: colours only through `--dsw-alias-*` / `--dsw-radius-*` tokens,
 * applied inline. The one injected stylesheet holds only layout-neutral things
 * that cannot be expressed inline (focus ring, scrollbar, keyframes).
 */
window.__ModuleLoader__.load({ id: 'daily-work-hub', factory: (require) => { const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef } = React

    /* ==================================================================== *
     * 1. Constants
     * ==================================================================== */

    /** Panel id — `main` slot key and `sidebar.panellist` id. */
    const PANEL_ID = 'daily-work-hub'
    /** Locale namespace registered with the host. */
    const LOCALE_NS = 'daily-work-hub'

    /** REST endpoints, relative to the `/api/daily-work` base. */
    const ROUTE = { state: '/state', items: '/items', item: '/item', actions: '/actions', turns: '/turns', templates: '/templates',
      jobs: '/jobs', runs: '/runs', run: '/run', settings: '/settings', connect: '/connect', audit: '/audit', refresh: '/refresh', }

    /** List poll cadence (contract §8) and running-run cadence. */
    const POLL_LIST_MS = 3000
    const POLL_RUN_MS = 1000
    /** Idle cadence for the jobs page when nothing is running. */
    const POLL_JOBS_MS = 5000

    /** Layout constants from DESIGN §4.1 and research/04-ux §1.2. */
    const NAV_WIDTH = 220
    const LIST_WIDTH = 380
    const DRAWER_WIDTH = 404
    const FILE_TREE_WIDTH = 190
    const BREAK_TWO_COL = 1240
    const BREAK_NARROW = 900

    /** Reason weights — mirrors CONTRACTS §4 for client-side grouping. */
    const REASON_ORDER = [ 'review_requested', 'approval_required', 'changes_requested', 'conflict', 'ci_failed', 'assigned', 'mentioned',
      'authored_feedback', 'authored', 'watching', ]

    /** Copy + tone per reason. Unknown reasons fall back to a neutral chip. */
    const REASON_META = { review_requested: { zh: '待我审', en: 'Review requested', tone: 'brand' },
      approval_required: { zh: '待批准', en: 'Approval required', tone: 'brand' },
      changes_requested: { zh: '要我改', en: 'Changes requested', tone: 'warn' }, conflict: { zh: '冲突', en: 'Conflict', tone: 'warn' },
      ci_failed: { zh: 'CI 失败', en: 'CI failed', tone: 'error' }, assigned: { zh: '指派给我', en: 'Assigned to me', tone: 'neutral' },
      mentioned: { zh: '@我', en: 'Mentioned me', tone: 'neutral' },
      authored_feedback: { zh: '我提的有反馈', en: 'Feedback on mine', tone: 'warn' },
      authored: { zh: '我提的', en: 'Authored by me', tone: 'neutral' }, watching: { zh: '关注中', en: 'Watching', tone: 'neutral' }, }

    /** Views that reuse the inbox list component. */
    const INBOX_MODES = ['inbox', 'review', 'work', 'projects']

    /** Primary navigation. `badge` names a count slot from `/state`. */
    const NAV_GROUPS = [ { label: 'nav.groupWork', items: [ { id: 'inbox', icon: 'inbox', label: 'nav.inbox', badge: 'unread' },
          { id: 'review', icon: 'queue', label: 'nav.review', badge: 'review' },
          { id: 'work', icon: 'work', label: 'nav.work', badge: 'myWork' },
          { id: 'projects', icon: 'proj', label: 'nav.projects', badge: 'projects' }, ], }, { label: 'nav.groupAuto', items: [
          { id: 'jobs', icon: 'clock', label: 'nav.jobs', badge: 'running' },
          { id: 'prompts', icon: 'prompt', label: 'nav.prompts', badge: 'prompts' }, ], }, { label: 'nav.groupConfig',
        items: [{ id: 'settings', icon: 'gear', label: 'nav.settings', badge: null }], }, ]

    /** Snooze presets — requirement: 1h / 4h / tomorrow. */
    const SNOOZE_PRESETS = [ { id: '1h', key: 'snooze.1h', hours: 1 }, { id: '4h', key: 'snooze.4h', hours: 4 },
      { id: 'tomorrow', key: 'snooze.tomorrow', hours: -1 }, ]

    /** Variables offered in the prompt editor (DESIGN §4.4 whitelist). */
    const TEMPLATE_VARIABLES = [ '{{mr.title}}', '{{mr.description}}', '{{mr.author}}', '{{diff}}', '{{files}}', '{{files.changed}}',
      '{{project.path}}', '{{project.conventions}}', ]

    /** Severity display order for findings. */
    const SEVERITY_ORDER = ['blocker', 'high', 'medium', 'low']

    /* ==================================================================== *
     * 2. Locale dictionaries (inlined; locale/*.json mirror this content)
     * ==================================================================== */

    const ZH = { 'meta.title': '日常工作台', 'meta.description': '开发者整页工作台：GitLab MR 与 Issue 收件箱、审查队列、一键 AI 审查、任务自动化与提示词管理。', 'nav.inbox': '收件箱',
      'nav.review': '审查队列', 'nav.work': '我的工作', 'nav.projects': '项目', 'nav.jobs': '任务与自动化', 'nav.prompts': '提示词与技能', 'nav.settings': '设置',
      'nav.groupWork': '处理', 'nav.groupAuto': '自动化', 'nav.groupConfig': '配置', 'common.refresh': '刷新', 'common.pausePolling': '暂停轮询',
      'common.resumePolling': '恢复轮询', 'common.save': '保存', 'common.cancel': '取消', 'common.close': '关闭', 'common.delete': '删除',
      'common.edit': '编辑', 'common.copy': '复制', 'common.retry': '重试', 'common.back': '返回', 'common.open': '打开', 'common.search': '搜索',
      'common.all': '全部', 'common.loading': '加载中…', 'common.enabled': '启用', 'common.disabled': '已停用', 'common.confirm': '确认',
      'common.dryRun': '干跑', 'common.create': '新建', 'common.duplicate': '复制一份', 'common.archive': '归档', 'common.ignore': '忽略',
      'common.read': '已读', 'common.snooze': '稍后', 'common.more': '更多', 'common.audit': '查看审计', 'common.unknown': '未知',
      'common.test': '测试连接', 'common.enable': '启用', 'common.disable': '停用', 'common.minutesShort': '{n} 分钟', 'common.never': '从未',
      'filters.project': '项目', 'filters.reason': '原因', 'filters.state': '状态', 'filters.sort': '排序', 'filters.recommended': 'Recommended',
      'filters.searchPlaceholder': '搜索标题、项目、作者', 'filters.allProjects': '全部项目', 'filters.allReasons': '全部原因', 'filters.allStates': '全部状态',
      'filters.needsReview': '仅需我审', 'filters.mine': '我提的', 'filters.ciFailed': 'CI 失败', 'filters.snoozed': '已稍后', 'filters.unread': '未读',
      'filters.clear': '清除筛选', 'list.selected': '已选 {n} 项', 'list.clear': '清除选择', 'list.emptyTitle': '收件箱是空的',
      'list.emptyBody': '连接 GitLab 后，指给你的 MR 与 Issue 会出现在这里', 'list.noProject': '未分组', 'list.bulkHint': '批量操作只提供 已读 / 忽略 / 稍后 / 归档',
      'list.showing': '共 {n} 项', 'detail.overview': '概览', 'detail.changes': '变更', 'detail.discussions': '讨论', 'detail.pipelines': '流水线',
      'detail.openGitlab': '打开 GitLab', 'detail.approvals': '审批', 'detail.ci': 'CI', 'detail.labels': '标签', 'detail.branches': '分支',
      'detail.mergeStatus': '合并状态', 'detail.head': '提交', 'detail.files': '{n} 个文件', 'detail.noDescription': '没有描述',
      'detail.noChanges': '没有可比对的变更', 'detail.noDiscussions': '还没有讨论', 'detail.unresolved': '未解决 {n} 条', 'detail.resolved': '已解决',
      'detail.staleTitle': '结论基于旧提交', 'detail.staleBody': 'AI 结论针对 {old}，当前 head 已是 {now}；写操作已禁用，请增量重审。',
      'detail.coverageSkipped': '未覆盖 {n} 个文件（分片或体积超限）', 'detail.errorInline': '无法读取该条目的详情', 'detail.placeholderTitle': '选择左侧一条工作项',
      'detail.placeholderBody': '详情、变更与 AI 审查抽屉都会显示在这里', 'detail.approvedOf': '{approved} / {of}', 'detail.adds': '+{n}',
      'detail.dels': '−{n}', 'ai.title': 'AI 审查', 'ai.state.idle': '尚未运行', 'ai.state.running': '运行中', 'ai.state.done': '已完成',
      'ai.state.failed': '失败', 'ai.state.stale': '结论可能过期', 'ai.run': '开始审查', 'ai.rerun': '重新审查', 'ai.empty': '还没有审查结论',
      'ai.emptyHint': '运行一次 AI 审查，或先换一份提示词模板。', 'ai.runningHint': '{mode} · 正在分析 diff 与讨论', 'ai.failed': '审查失败', 'ai.findings': '发现 {n} 条',
      'ai.evidence': '证据', 'ai.suggestion': '建议修法', 'ai.addToComment': '加入评论', 'ai.ignoreFinding': '忽略', 'ai.jumpToFile': '跳转到文件',
      'ai.followupPlaceholder': '追问：继续问这条 MR 的细节（回车发送）', 'ai.followupSend': '发送',
      'ai.followupUnsupported': '追问接口暂不可用（契约未定义 /actions 的 follow-up），已保留输入。', 'ai.draft': '生成评论草稿', 'ai.previewDraft': '预览草稿',
      'ai.publish': '发布到 GitLab', 'ai.confirmTitle': '发布评论到 GitLab？', 'ai.confirmBody': '将向 {subject} 提交一条评论。此操作会写入远端，需在本次确认后才执行。',
      'ai.draftReady': '草稿已生成，确认后再发布。', 'ai.published': '评论已发布', 'ai.confirmStaleRevision': '确认令牌已过期，已刷新数据；请再确认一次。',
      'ai.verdict.approve': '建议批准', 'ai.verdict.comments': '仅评论', 'ai.verdict.requestChanges': '建议要求修改', 'ai.verdict.unknown': '结论未知',
      'ai.severity.blocker': '阻塞', 'ai.severity.high': '高', 'ai.severity.medium': '中', 'ai.severity.low': '低', 'ai.riskSummary': '风险分布',
      'ai.coverage': '覆盖范围', 'ai.heuristicNote': '本地启发式审查（未做语义覆盖）', 'ai.turnMissing': '尚未运行', 'ai.drawerClose': '关闭 AI 抽屉',
      'ai.draftBody': '评论正文', 'jobs.title': '任务与自动化', 'jobs.tab.library': '任务库', 'jobs.tab.runs': '运行历史', 'jobs.tab.triggers': '触发器',
      'jobs.new': '新建任务', 'jobs.edit': '编辑任务', 'jobs.runNow': '立即运行', 'jobs.lastRun': '上次运行', 'jobs.successRate': '成功率',
      'jobs.avgDuration': '平均耗时', 'jobs.cronSummary': '触发', 'jobs.executor': '执行器', 'jobs.output': '产出', 'jobs.enabled': '已启用',
      'jobs.disabled': '已停用', 'jobs.running': '{n} 运行中', 'jobs.empty': '还没有任务', 'jobs.emptyHint': '新建一个任务，把重复的一天的活交给定时与事件。',
      'jobs.runs.time': '时间', 'jobs.runs.job': '任务', 'jobs.runs.source': '触发源', 'jobs.runs.state': '状态', 'jobs.runs.duration': '耗时',
      'jobs.runs.tokens': 'Token', 'jobs.runs.artifact': '产物', 'jobs.runs.actions': '操作', 'jobs.runs.rerun': '重跑', 'jobs.runs.cancel': '取消',
      'jobs.runs.why': 'why', 'jobs.runs.empty': '还没有运行记录', 'jobs.runs.runningNote': '运行中，每 1s 刷新进度', 'jobs.auditTitle': '审计回放',
      'jobs.auditEmpty': '没有审计记录', 'jobs.deleteTitle': '删除任务？', 'jobs.deleteBody': '删除「{name}」后，它的历史运行记录仍会保留，但不再产生新的运行。',
      'jobs.triggerEvent': '事件', 'jobs.triggerAction': '动作', 'jobs.triggerPaused': '暂停开关', 'jobs.noTriggers': '没有事件或上游触发的任务',
      'jobs.triggerHint': '触发器来自任务定义（trigger.kind = event / after）；开关等价于停用该任务。', 'jobs.form.basic': '基本', 'jobs.form.trigger': '触发',
      'jobs.form.executor': '执行', 'jobs.form.params': '参数', 'jobs.form.output': '产出', 'jobs.form.policy': '策略', 'jobs.form.name': '名称',
      'jobs.form.description': '描述', 'jobs.form.icon': '图标', 'jobs.form.catchUp': '补跑策略', 'jobs.form.cron': 'cron 表达式',
      'jobs.form.tz': '时区', 'jobs.form.event': '事件类型', 'jobs.form.after': '上游任务', 'jobs.form.afterStatus': '上游状态',
      'jobs.form.template': '模板', 'jobs.form.prompt': '提示词', 'jobs.form.cwd': '目录', 'jobs.form.access': '权限', 'jobs.form.readOnly': '只读',
      'jobs.form.write': '可写', 'jobs.form.paramList': '参数列表', 'jobs.form.addParam': '添加参数', 'jobs.form.outputKind': '产出类型',
      'jobs.form.outputPath': '路径模板', 'jobs.form.notify': '通知方式', 'jobs.form.concurrency': '并发', 'jobs.form.timeout': '超时（分钟）',
      'jobs.form.retry': '重试次数', 'jobs.form.quiet': '静默时段', 'jobs.form.dailyCap': '每日上限', 'jobs.form.dryHint': '干跑只读上下文，不写任何外部系统；先保存再干跑。',
      'jobs.form.required': '名称必填', 'jobs.form.cronInvalid': 'cron 需要 5 段', 'jobs.form.noParams': '没有参数', 'jobs.saved': '任务已保存',
      'jobs.runStarted': '已启动：{name}', 'jobs.cancelled': '已请求取消', 'jobs.dryStarted': '干跑已启动，结果只会给你看', 'jobs.needSaveFirst': '先保存任务，再干跑',
      'jobs.pausedHint': '暂停后不再定时、不再接事件；已排队的运行不补跑', 'jobs.manual': '手动', 'jobs.triggerKind.manual': '手动', 'jobs.triggerKind.cron': '定时',
      'jobs.triggerKind.event': '事件', 'jobs.triggerKind.after': '上游任务后', 'jobs.state.queued': '排队', 'jobs.state.running': '运行中',
      'jobs.state.succeeded': '成功', 'jobs.state.failed': '失败', 'jobs.state.interrupted': '中断', 'jobs.state.cancelled': '已取消',
      'jobs.state.skipped': '跳过', 'jobs.source.manual': '手动（你）', 'jobs.source.cron': '定时', 'jobs.source.event': '事件',
      'jobs.source.after': '上游 Job', 'prompts.title': '提示词与技能', 'prompts.new': '新建提示词', 'prompts.name': '名称', 'prompts.scope': '适用范围',
      'prompts.version': '版本', 'prompts.used': '使用次数', 'prompts.adoption': '采纳率', 'prompts.enabled': '启用', 'prompts.role': '角色',
      'prompts.checklist': '检查清单', 'prompts.context': '上下文装配', 'prompts.output': '输出格式', 'prompts.selfCheck': '自检',
      'prompts.variables': '可用变量', 'prompts.preview': '预览渲染结果', 'prompts.previewEmpty': '还没有可预览的渲染结果',
      'prompts.previewNote': '预览来自模板接口（脱敏）；接口未返回时用本地变量替换兜底。', 'prompts.saveVersion': '保存并生成新版本', 'prompts.saved': '已保存 v{version}',
      'prompts.validation': '校验', 'prompts.valid': '校验通过', 'prompts.invalid': '校验未通过',
      'prompts.exportHint': '导出为 skill：把当前模板写成 SKILL.md 放到技能目录；插件侧只存覆盖层，不回写 DSH skill 文件。',
      'prompts.skillsHint': '已安装的 DSH skills 作为只读来源引用（~/.dsh/skills），可绑定为审查方法或检查清单。', 'prompts.select': '选择左侧一条模板',
      'prompts.empty': '还没有提示词模板', 'prompts.checklistHint': '每行一条检查项', 'prompts.contextHint': '每行一条上下文装配项', 'prompts.deleteTitle': '删除模板？',
      'prompts.deleteBody': '历史轮次仍保留 templateVersion，但不能再选它审查。', 'prompts.defaultName': '未命名模板', 'settings.title': '设置',
      'settings.desc': '连接、轮询、范围、通知与 AI 策略。保存后立即生效，无需重启面板。', 'settings.gitlab': 'GitLab 连接',
      'settings.gitlabDesc': '令牌只存本机 Harness profile，不写日志；面板用它把 MR / Issue 拉取为收件箱条目。', 'settings.baseUrl': '实例地址',
      'settings.baseUrlHint': '自建实例填完整 origin，可含子路径', 'settings.pat': '个人访问令牌（PAT）', 'settings.patHint': '需 read_api；写评论还需 api',
      'settings.patSaved': '已保存', 'settings.patNotSet': '未保存', 'settings.connection': '连接状态', 'settings.connectionOk': '连接正常',
      'settings.connectionNone': '未配置', 'settings.connectionFail': '连接失败', 'settings.collect': '采集范围',
      'settings.collectDesc': '组包含其子项目；每行一个。', 'settings.groups': '组', 'settings.projects': '项目', 'settings.exclude': '排除路径',
      'settings.rhythm': '节奏', 'settings.pollInterval': '轮询间隔（秒）', 'settings.quietHours': '静默时段', 'settings.quietHint': '格式 20:00-09:00',
      'settings.concurrency': '并发上限', 'settings.failureThreshold': '失败告警阈值', 'settings.ai': 'AI', 'settings.provider': '默认 provider',
      'settings.model': '默认模型', 'settings.allowWrites': '允许写评论', 'settings.allowWritesHint': '关闭后 AI 只出草稿，发布按钮置灰；批准仍需二次确认。',
      'settings.save': '保存设置', 'settings.saved': '设置已保存', 'settings.connect': '测试连接', 'settings.connectOk': '连接成功',
      'settings.connectFail': '连接失败：{message}', 'settings.onboardingTitle': '先连接 GitLab',
      'settings.onboardingBody': '填实例地址与 PAT，保存后即可开始拉取 MR 与 Issue。',
      'settings.failedThresholdExtra': '（契约未定义此字段，作为扩展字段写入 settings.failureThreshold）', 'empty.noGitlabTitle': '先连接 GitLab',
      'empty.noGitlabBody': '连接后，指给你的 MR 与 Issue 会自动出现在收件箱。', 'empty.goSettings': '去设置', 'empty.queueTitle': '队列已清空',
      'empty.queueBody': '没有需要你审查的条目；下一次轮询会自动带入新项。', 'empty.workTitle': '我的工作为空', 'empty.workBody': '你提的 MR 与指派给你的 Issue 会出现在这里。',
      'empty.projectsTitle': '还没有项目数据', 'empty.projectsBody': '连接 GitLab 并选择采集范围后，这里按项目分组显示。', 'empty.filteredTitle': '没有匹配的条目',
      'empty.filteredBody': '试试清除筛选或换一个项目。', 'banner.offline': '拉取失败：{message}', 'banner.lastSuccess': '上次成功 {ago}',
      'banner.authTitle': '登录已失效，请重新打开 dsh web 打印的网址', 'banner.authBody': '本轮请求被宿主拒绝（401）。面板保留上次数据，重新登录后刷新即可恢复。', 'banner.retry': '重试',
      'banner.pausedHint': '轮询已暂停；恢复后立即刷新一次。', 'toast.archived': '已归档', 'toast.read': '已标记已读', 'toast.ignored': '已忽略',
      'toast.snoozed': '已稍后至 {until}', 'toast.failed': '操作失败：{message}', 'toast.bulk': '已处理 {n} 项', 'toast.done': '完成',
      'toast.copied': '已复制到剪贴板', 'toast.copyFail': '复制失败，请手动复制', 'toast.refreshed': '已刷新', 'toast.paused': '已暂停轮询',
      'toast.resumed': '已恢复轮询', 'toast.openFail': '浏览器拦截了新窗口，链接已复制', 'toast.publishBlocked': '代码已变更或未开启写评论，发布已被阻止', 'palette.title': '命令面板',
      'palette.placeholder': '切换视图、跳项目或执行动作…', 'palette.views': '切换视图', 'palette.projects': '跳转到项目', 'palette.actions': '动作',
      'palette.empty': '没有匹配的命令', 'palette.refresh': '刷新数据', 'palette.pause': '暂停轮询', 'palette.resume': '恢复轮询', 'palette.newJob': '新建任务',
      'palette.settings': '打开设置', 'palette.aiReview': 'AI 审查选中项', 'palette.archive': '归档选中项', 'keys.title': '快捷键', 'keys.move': '移动',
      'keys.open': '打开', 'keys.back': '返回 / 关闭', 'keys.archive': '归档', 'keys.snooze': '稍后', 'keys.ai': '审查', 'keys.comment': '起草评论',
      'keys.refresh': '刷新', 'keys.palette': '命令面板', 'crash.title': '面板渲染出错', 'crash.body': '错误已被面板边界接住，其他区域仍可用。可先刷新数据；问题持续时把下面的信息发给维护者。',
      'crash.reload': '刷新数据', }

    const EN = { 'meta.title': 'Daily work hub',
      'meta.description': 'Full-page developer workspace: GitLab MR and issue inbox, review queue, one-click AI review, jobs and prompt management.',
      'nav.inbox': 'Inbox', 'nav.review': 'Review queue', 'nav.work': 'My work', 'nav.projects': 'Projects',
      'nav.jobs': 'Jobs & automation', 'nav.prompts': 'Prompts & skills', 'nav.settings': 'Settings', 'nav.groupWork': 'Work',
      'nav.groupAuto': 'Automation', 'nav.groupConfig': 'Config', 'common.refresh': 'Refresh', 'common.pausePolling': 'Pause polling',
      'common.resumePolling': 'Resume polling', 'common.save': 'Save', 'common.cancel': 'Cancel', 'common.close': 'Close',
      'common.delete': 'Delete', 'common.edit': 'Edit', 'common.copy': 'Copy', 'common.retry': 'Retry', 'common.back': 'Back',
      'common.open': 'Open', 'common.search': 'Search', 'common.all': 'All', 'common.loading': 'Loading…', 'common.enabled': 'Enabled',
      'common.disabled': 'Disabled', 'common.confirm': 'Confirm', 'common.dryRun': 'Dry run', 'common.create': 'New',
      'common.duplicate': 'Duplicate', 'common.archive': 'Archive', 'common.ignore': 'Ignore', 'common.read': 'Read',
      'common.snooze': 'Snooze', 'common.more': 'More', 'common.audit': 'Audit trail', 'common.unknown': 'Unknown',
      'common.test': 'Test connection', 'common.enable': 'Enable', 'common.disable': 'Disable', 'common.minutesShort': '{n} min',
      'common.never': 'Never', 'filters.project': 'Project', 'filters.reason': 'Reason', 'filters.state': 'State', 'filters.sort': 'Sort',
      'filters.recommended': 'Recommended', 'filters.searchPlaceholder': 'Search title, project, author',
      'filters.allProjects': 'All projects', 'filters.allReasons': 'All reasons', 'filters.allStates': 'All states',
      'filters.needsReview': 'Needs my review', 'filters.mine': 'Mine', 'filters.ciFailed': 'CI failed', 'filters.snoozed': 'Snoozed',
      'filters.unread': 'Unread', 'filters.clear': 'Clear filters', 'list.selected': '{n} selected', 'list.clear': 'Clear selection',
      'list.emptyTitle': 'Inbox is empty', 'list.emptyBody': 'Once GitLab is connected, MRs and issues assigned to you land here.',
      'list.noProject': 'Ungrouped', 'list.bulkHint': 'Bulk actions offer read / ignore / snooze / archive only',
      'list.showing': '{n} items', 'detail.overview': 'Overview', 'detail.changes': 'Changes', 'detail.discussions': 'Discussions',
      'detail.pipelines': 'Pipelines', 'detail.openGitlab': 'Open in GitLab', 'detail.approvals': 'Approvals', 'detail.ci': 'CI',
      'detail.labels': 'Labels', 'detail.branches': 'Branches', 'detail.mergeStatus': 'Merge status', 'detail.head': 'Head',
      'detail.files': '{n} files', 'detail.noDescription': 'No description', 'detail.noChanges': 'No diff to show',
      'detail.noDiscussions': 'No discussions yet', 'detail.unresolved': '{n} unresolved', 'detail.resolved': 'Resolved',
      'detail.staleTitle': 'Result is based on an older commit',
      'detail.staleBody': 'AI result covers {old}; head is now {now}. Writes are disabled until you re-review.',
      'detail.coverageSkipped': '{n} files not covered (split or oversized)', 'detail.errorInline': 'Could not load this item',
      'detail.placeholderTitle': 'Pick an item on the left', 'detail.placeholderBody': 'Detail, diff and the AI review drawer render here',
      'detail.approvedOf': '{approved} / {of}', 'detail.adds': '+{n}', 'detail.dels': '−{n}', 'ai.title': 'AI review',
      'ai.state.idle': 'Not run', 'ai.state.running': 'Running', 'ai.state.done': 'Done', 'ai.state.failed': 'Failed',
      'ai.state.stale': 'Possibly stale', 'ai.run': 'Run review', 'ai.rerun': 'Re-run review', 'ai.empty': 'No review result yet',
      'ai.emptyHint': 'Run an AI review, or pick a prompt template first.', 'ai.runningHint': '{mode} · analysing diff and discussions',
      'ai.failed': 'Review failed', 'ai.findings': '{n} findings', 'ai.evidence': 'Evidence', 'ai.suggestion': 'Suggested fix',
      'ai.addToComment': 'Add to comment', 'ai.ignoreFinding': 'Ignore', 'ai.jumpToFile': 'Jump to file',
      'ai.followupPlaceholder': 'Follow up: ask about this MR (Enter to send)', 'ai.followupSend': 'Send',
      'ai.followupUnsupported': 'Follow-up is not available (/actions has no follow-up action in the contract); input kept.',
      'ai.draft': 'Draft comment', 'ai.previewDraft': 'Preview draft', 'ai.publish': 'Publish to GitLab',
      'ai.confirmTitle': 'Publish this comment to GitLab?',
      'ai.confirmBody': 'A comment will be posted to {subject}. This writes to the remote and only runs after this confirmation.',
      'ai.draftReady': 'Draft ready — publish after confirming.', 'ai.published': 'Comment published',
      'ai.confirmStaleRevision': 'Confirm token expired; data refreshed — confirm again.', 'ai.verdict.approve': 'Approve suggested',
      'ai.verdict.comments': 'Comments only', 'ai.verdict.requestChanges': 'Request changes suggested',
      'ai.verdict.unknown': 'Unknown verdict', 'ai.severity.blocker': 'Blocker', 'ai.severity.high': 'High', 'ai.severity.medium': 'Medium',
      'ai.severity.low': 'Low', 'ai.riskSummary': 'Risk breakdown', 'ai.coverage': 'Coverage',
      'ai.heuristicNote': 'Local heuristic review (no semantic coverage)', 'ai.turnMissing': 'Not run yet',
      'ai.drawerClose': 'Close AI drawer', 'ai.draftBody': 'Comment body', 'jobs.title': 'Jobs & automation', 'jobs.tab.library': 'Library',
      'jobs.tab.runs': 'Run history', 'jobs.tab.triggers': 'Triggers', 'jobs.new': 'New job', 'jobs.edit': 'Edit job',
      'jobs.runNow': 'Run now', 'jobs.lastRun': 'Last run', 'jobs.successRate': 'Success rate', 'jobs.avgDuration': 'Avg duration',
      'jobs.cronSummary': 'Trigger', 'jobs.executor': 'Executor', 'jobs.output': 'Output', 'jobs.enabled': 'Enabled',
      'jobs.disabled': 'Disabled', 'jobs.running': '{n} running', 'jobs.empty': 'No jobs yet',
      'jobs.emptyHint': 'Create a job to hand the repeatable parts of your day to cron and events.', 'jobs.runs.time': 'Time',
      'jobs.runs.job': 'Job', 'jobs.runs.source': 'Trigger', 'jobs.runs.state': 'State', 'jobs.runs.duration': 'Duration',
      'jobs.runs.tokens': 'Tokens', 'jobs.runs.artifact': 'Artifact', 'jobs.runs.actions': 'Actions', 'jobs.runs.rerun': 'Re-run',
      'jobs.runs.cancel': 'Cancel', 'jobs.runs.why': 'why', 'jobs.runs.empty': 'No runs recorded',
      'jobs.runs.runningNote': 'Running — refreshing progress every 1s', 'jobs.auditTitle': 'Audit replay',
      'jobs.auditEmpty': 'No audit entries', 'jobs.deleteTitle': 'Delete this job?',
      'jobs.deleteBody': 'Deleting “{name}” keeps past runs but stops new ones.', 'jobs.triggerEvent': 'Event',
      'jobs.triggerAction': 'Action', 'jobs.triggerPaused': 'Pause', 'jobs.noTriggers': 'No event or upstream-triggered jobs',
      'jobs.triggerHint': 'Triggers are derived from job definitions (trigger.kind = event / after); the switch disables the job.',
      'jobs.form.basic': 'Basics', 'jobs.form.trigger': 'Trigger', 'jobs.form.executor': 'Executor', 'jobs.form.params': 'Parameters',
      'jobs.form.output': 'Output', 'jobs.form.policy': 'Policy', 'jobs.form.name': 'Name', 'jobs.form.description': 'Description',
      'jobs.form.icon': 'Icon', 'jobs.form.catchUp': 'Catch-up', 'jobs.form.cron': 'cron expression', 'jobs.form.tz': 'Time zone',
      'jobs.form.event': 'Event types', 'jobs.form.after': 'Upstream job', 'jobs.form.afterStatus': 'Upstream status',
      'jobs.form.template': 'Template', 'jobs.form.prompt': 'Prompt', 'jobs.form.cwd': 'Directory', 'jobs.form.access': 'Access',
      'jobs.form.readOnly': 'Read-only', 'jobs.form.write': 'Writable', 'jobs.form.paramList': 'Parameters',
      'jobs.form.addParam': 'Add parameter', 'jobs.form.outputKind': 'Output kind', 'jobs.form.outputPath': 'Path template',
      'jobs.form.notify': 'Notify', 'jobs.form.concurrency': 'Concurrency', 'jobs.form.timeout': 'Timeout (min)',
      'jobs.form.retry': 'Retries', 'jobs.form.quiet': 'Quiet hours', 'jobs.form.dailyCap': 'Daily cap',
      'jobs.form.dryHint': 'A dry run reads context only and writes nothing; save the job first.', 'jobs.form.required': 'Name is required',
      'jobs.form.cronInvalid': 'cron needs 5 fields', 'jobs.form.noParams': 'No parameters', 'jobs.saved': 'Job saved',
      'jobs.runStarted': 'Started: {name}', 'jobs.cancelled': 'Cancel requested', 'jobs.dryStarted': 'Dry run started — results stay local',
      'jobs.needSaveFirst': 'Save the job before a dry run',
      'jobs.pausedHint': 'Paused jobs stop cron and events; queued runs are not replayed', 'jobs.manual': 'Manual',
      'jobs.triggerKind.manual': 'Manual', 'jobs.triggerKind.cron': 'Cron', 'jobs.triggerKind.event': 'Event',
      'jobs.triggerKind.after': 'After upstream', 'jobs.state.queued': 'Queued', 'jobs.state.running': 'Running',
      'jobs.state.succeeded': 'Succeeded', 'jobs.state.failed': 'Failed', 'jobs.state.interrupted': 'Interrupted',
      'jobs.state.cancelled': 'Cancelled', 'jobs.state.skipped': 'Skipped', 'jobs.source.manual': 'Manual (you)',
      'jobs.source.cron': 'Cron', 'jobs.source.event': 'Event', 'jobs.source.after': 'Upstream job', 'prompts.title': 'Prompts & skills',
      'prompts.new': 'New prompt', 'prompts.name': 'Name', 'prompts.scope': 'Scope', 'prompts.version': 'Version', 'prompts.used': 'Used',
      'prompts.adoption': 'Adoption', 'prompts.enabled': 'Enabled', 'prompts.role': 'Role', 'prompts.checklist': 'Checklist',
      'prompts.context': 'Context assembly', 'prompts.output': 'Output format', 'prompts.selfCheck': 'Self-check',
      'prompts.variables': 'Variables', 'prompts.preview': 'Rendered preview', 'prompts.previewEmpty': 'Nothing to preview yet',
      'prompts.previewNote': 'Preview comes from the templates endpoint (redacted); local substitution is the fallback.',
      'prompts.saveVersion': 'Save as new version', 'prompts.saved': 'Saved v{version}', 'prompts.validation': 'Validation',
      'prompts.valid': 'Valid', 'prompts.invalid': 'Invalid',
      'prompts.exportHint': 'Export as skill: write the template to SKILL.md in the skills directory; the plugin only stores its overlay and never rewrites DSH skill files.',
      'prompts.skillsHint': 'Installed DSH skills (~/.dsh/skills) are referenced read-only as a review method or checklist source.',
      'prompts.select': 'Pick a template on the left', 'prompts.empty': 'No prompt templates', 'prompts.checklistHint': 'One item per line',
      'prompts.contextHint': 'One context source per line', 'prompts.deleteTitle': 'Delete this template?',
      'prompts.deleteBody': 'Past turns keep their templateVersion, but this template can no longer be selected.',
      'prompts.defaultName': 'Untitled template', 'settings.title': 'Settings',
      'settings.desc': 'Connection, polling, scope, notifications and AI policy. Saved settings apply immediately.',
      'settings.gitlab': 'GitLab connection',
      'settings.gitlabDesc': 'The token stays in the local Harness profile and is never logged. The panel uses it to pull MRs and issues.',
      'settings.baseUrl': 'Instance URL', 'settings.baseUrlHint': 'Self-hosted instances need the full origin, sub-path allowed',
      'settings.pat': 'Personal access token (PAT)', 'settings.patHint': 'read_api is enough to read; posting comments also needs api',
      'settings.patSaved': 'Saved', 'settings.patNotSet': 'Not saved', 'settings.connection': 'Connection',
      'settings.connectionOk': 'Connected', 'settings.connectionNone': 'Not configured', 'settings.connectionFail': 'Failed',
      'settings.collect': 'Collection scope', 'settings.collectDesc': 'Groups include their projects; one per line.',
      'settings.groups': 'Groups', 'settings.projects': 'Projects', 'settings.exclude': 'Excluded paths', 'settings.rhythm': 'Rhythm',
      'settings.pollInterval': 'Poll interval (s)', 'settings.quietHours': 'Quiet hours', 'settings.quietHint': 'Format 20:00-09:00',
      'settings.concurrency': 'Concurrency limit', 'settings.failureThreshold': 'Failure threshold', 'settings.ai': 'AI',
      'settings.provider': 'Default provider', 'settings.model': 'Default model', 'settings.allowWrites': 'Allow comment writes',
      'settings.allowWritesHint': 'When off, AI only drafts; publishing is disabled. Approval still needs confirmation.',
      'settings.save': 'Save settings', 'settings.saved': 'Settings saved', 'settings.connect': 'Test connection',
      'settings.connectOk': 'Connection ok', 'settings.connectFail': 'Connection failed: {message}',
      'settings.onboardingTitle': 'Connect GitLab first',
      'settings.onboardingBody': 'Enter the instance URL and a PAT, then save to start pulling MRs and issues.',
      'settings.failedThresholdExtra': '(not in the contract; written as the extra field settings.failureThreshold)',
      'empty.noGitlabTitle': 'Connect GitLab first',
      'empty.noGitlabBody': 'Assigned MRs and issues show up here once the connection works.', 'empty.goSettings': 'Go to settings',
      'empty.queueTitle': 'Queue is clear', 'empty.queueBody': 'Nothing needs your review; the next poll brings new items automatically.',
      'empty.workTitle': 'My work is empty', 'empty.workBody': 'MRs you authored and issues assigned to you appear here.',
      'empty.projectsTitle': 'No project data yet', 'empty.projectsBody': 'Connect GitLab and pick a scope; projects group here.',
      'empty.filteredTitle': 'No matching items', 'empty.filteredBody': 'Clear the filters or pick another project.',
      'banner.offline': 'Refresh failed: {message}', 'banner.lastSuccess': 'Last success {ago}',
      'banner.authTitle': 'Session expired — reopen the URL printed by dsh web',
      'banner.authBody': 'The host rejected this request (401). Last data is kept; sign in again and refresh.', 'banner.retry': 'Retry',
      'banner.pausedHint': 'Polling is paused; resuming refreshes once immediately.', 'toast.archived': 'Archived',
      'toast.read': 'Marked read', 'toast.ignored': 'Ignored', 'toast.snoozed': 'Snoozed until {until}',
      'toast.failed': 'Action failed: {message}', 'toast.bulk': 'Handled {n} items', 'toast.done': 'Done',
      'toast.copied': 'Copied to clipboard', 'toast.copyFail': 'Copy failed — copy manually', 'toast.refreshed': 'Refreshed',
      'toast.paused': 'Polling paused', 'toast.resumed': 'Polling resumed', 'toast.openFail': 'Window blocked; link copied instead',
      'toast.publishBlocked': 'Code changed or writes disabled — publish blocked', 'palette.title': 'Command palette',
      'palette.placeholder': 'Switch view, jump to a project, run an action…', 'palette.views': 'Switch view',
      'palette.projects': 'Jump to project', 'palette.actions': 'Actions', 'palette.empty': 'No matching command',
      'palette.refresh': 'Refresh data', 'palette.pause': 'Pause polling', 'palette.resume': 'Resume polling', 'palette.newJob': 'New job',
      'palette.settings': 'Open settings', 'palette.aiReview': 'AI review selected item', 'palette.archive': 'Archive selected item',
      'keys.title': 'Keyboard', 'keys.move': 'Move', 'keys.open': 'Open', 'keys.back': 'Back / close', 'keys.archive': 'Archive',
      'keys.snooze': 'Snooze', 'keys.ai': 'Review', 'keys.comment': 'Draft comment', 'keys.refresh': 'Refresh',
      'keys.palette': 'Command palette', 'crash.title': 'Panel render error',
      'crash.body': 'The panel boundary caught this error; the rest of the shell keeps working. Refresh data first, and share the details below if it persists.',
      'crash.reload': 'Reload data', }

    /** Pick the dictionary from the document language, Chinese by default. */
    function detectLang() { let tag = ''
      try { tag = document.documentElement.lang || navigator.language || ''
      } catch { tag = ''
      }
      return /^en/i.test(tag) ? 'en' : 'zh'
    }

    /**
     * Build a translate function for one language.
     * @param {'zh'|'en'} lang dictionary to use.
     * @returns {(key: string, vars?: Record<string, string|number>) => string} t
     */
    function makeT(lang) { const primary = lang === 'en' ? EN : ZH
      const fallback = lang === 'en' ? ZH : EN
      return function t(key, vars) { let text = primary[key] ?? fallback[key] ?? key
        if (vars !== undefined) { text = text.replace(/\{(\w+)\}/g, (whole, name) => vars[name] === undefined ? whole : String(vars[name]),
          )
        }
        return text
      }
    }

    /** Language resolved once at load; host reloads the page on locale switch. */
    const LANG = detectLang()
    /** Module-level translator used by pure formatters and components. */
    const tr = makeT(LANG)

    /* ==================================================================== *
     * 3. Utilities
     * ==================================================================== */

    const MINUTE = 60 * 1000
    const HOUR = 60 * MINUTE
    const DAY = 24 * HOUR

    /** Safe read used all over the panel (`??` chains stay readable). */
    function pick(source, ...keys) { if (source === null || source === undefined) return undefined
      for (const key of keys) { const value = source[key]
        if (value !== undefined && value !== null) return value
      }
      return undefined
    }

    /** Format an ISO timestamp as a relative "8 分钟 / 昨天 / 10-31" label. */
    function fmtAgo(iso) { const time = typeof iso === 'string' ? Date.parse(iso) : Number(iso)
      if (iso === null || iso === undefined || Number.isNaN(time)) return tr('common.unknown')
      const diff = Date.now() - time
      if (diff < MINUTE) return LANG === 'en' ? 'just now' : '刚刚'
      if (diff < HOUR) return tr('common.minutesShort', { n: Math.max(1, Math.round(diff / MINUTE)) })
      if (diff < DAY) return LANG === 'en' ? `${Math.round(diff / HOUR)}h` : `${Math.round(diff / HOUR)} 小时`
      if (diff < 2 * DAY) return LANG === 'en' ? 'yesterday' : '昨天'
      if (diff < 30 * DAY) { const d = new Date(time)
        return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      }
      const d = new Date(time)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    /** Absolute local date-time label for tables and tooltips. */
    function fmtDateTime(value) { const time = typeof value === 'number' ? value : Date.parse(value)
      if (!value || Number.isNaN(time)) return '—'
      const d = new Date(time)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    /** Duration in seconds or milliseconds → compact label. */
    function fmtDuration(startedAt, finishedAt) { const start = Date.parse(startedAt)
      if (!startedAt || Number.isNaN(start)) return '—'
      const end = finishedAt ? Date.parse(finishedAt) : Date.now()
      if (Number.isNaN(end)) return '—'
      const ms = Math.max(0, end - start)
      if (ms < 1000) return `${Math.round(ms)}ms`
      if (ms < 60 * 1000) return `${(ms / 1000).toFixed(ms < 10 * 1000 ? 1 : 0)}s`
      const min = Math.floor(ms / 60000)
      const sec = Math.round((ms % 60000) / 1000)
      return `${min}m${sec > 0 ? `${String(sec).padStart(2, '0')}s` : ''}`
    }

    /** Token usage from `{input, output}` or a plain number. */
    function fmtTokens(usage) { if (usage === null || usage === undefined) return '—'
      if (typeof usage === 'number') return fmtCompact(usage)
      const total = (Number(usage.input) || 0) + (Number(usage.output) || 0)
      return total === 0 ? '—' : fmtCompact(total)
    }

    /** 12400 → 12.4k. */
    function fmtCompact(value) { const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      if (n < 1000) return String(Math.round(n))
      if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
      return `${(n / 1000000).toFixed(1)}M`
    }

    /** Short commit sha (7 chars by default). */
    function shortSha(sha) { if (typeof sha !== 'string' || sha === '') return '—'
      return sha.slice(0, 7)
    }

    /** Truncate middle of a long string. */
    function middleTruncate(value, max) { const text = String(value ?? '')
      if (text.length <= max) return text
      const head = Math.ceil((max - 1) / 2)
      const tail = Math.floor((max - 1) / 2)
      return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
    }

    /** Format an ISO date the way GitLab's `updated_at` budget allows. */
    function isoFromNow(ms) { return new Date(Date.now() + ms).toISOString()
    }

    /** Build a query string, skipping empty values. */
    function buildQuery(query) { if (query === null || query === undefined) return ''
      const parts = []
      for (const key of Object.keys(query)) { const value = query[key]
        if (value === undefined || value === null || value === '') continue
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      }
      return parts.join('&')
    }

    /** Read an error message without assuming a shape. */
    function errorMessage(error) { if (error === null || error === undefined) return 'unknown'
      if (typeof error === 'string') return error
      return error.message ?? String(error)
    }

    /** Split a textarea value into trimmed non-empty lines. */
    function splitLines(value) { if (typeof value !== 'string') return []
      return value
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    }

    /** Stable shallow clone without a key. */
    function omitKey(source, key) { const next = {}
      for (const name of Object.keys(source ?? {})) { if (name !== key) next[name] = source[name]
      }
      return next
    }

    /** Copy text, tolerating a missing clipboard (non-secure origin). */
    async function copyText(text) { try { if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch { /* fall through to the legacy path */
      }
      try { const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch { return false
      }
    }

    /** Human summary for a job cron expression (host `describeCron` is not on REST). */
    function describeCron(expr) { if (typeof expr !== 'string' || expr.trim() === '') return tr('jobs.manual')
      const fields = expr.trim().split(/\s+/)
      if (fields.length !== 5) return expr
      const [min, hour, dom, month, dow] = fields
      const everyMinutes = /^\*\/(\d+)$/.exec(min)
      if (everyMinutes && hour === '*' && dom === '*' && month === '*' && dow === '*') {
        return LANG === 'en' ? `every ${everyMinutes[1]} min` : `每 ${everyMinutes[1]} 分钟`
      }
      if (min === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') { return LANG === 'en' ? 'every minute' : '每分钟'
      }
      if (hour === '*' && dom === '*' && month === '*' && dow === '*') {
        return LANG === 'en' ? `every hour at :${String(min).padStart(2, '0')}` : `每小时第 ${min} 分`
      }
      if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && month === '*') {
        const hhmm = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`
        if (dow === '*') return LANG === 'en' ? `daily ${hhmm}` : `每天 ${hhmm}`
        if (dow === '1-5') return LANG === 'en' ? `weekdays ${hhmm}` : `工作日 ${hhmm}`
        if (/^[0-7]$/.test(dow)) { const names = LANG === 'en'
            ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
            : ['周日', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
          return LANG === 'en' ? `${names[Number(dow)]} ${hhmm}` : `每${names[Number(dow)]} ${hhmm}`
        }
      }
      return expr
    }

    /* ==================================================================== *
     * 4. API layer
     * ==================================================================== */

    /**
     * Resolve a plugin route against the page DSH serves the UI from.
     * Root-absolute paths break under a reverse-proxy mount prefix.
     * @param {string} path route relative to `/api/daily-work`.
     * @param {Record<string, string|number|boolean|undefined>} [query] query values.
     * @returns {string} pathname (+ optional query) usable from `fetch`.
     */
    function apiUrl(path, query) { const route = path.startsWith('/') ? path : `/${path}`
      let pathname = `/api/daily-work${route}`
      try { if (typeof document !== 'undefined' && document.baseURI) {
          pathname = new URL(`api/daily-work${route}`, document.baseURI).pathname
        }
      } catch { /* keep the root-absolute fallback */
      }
      const search = buildQuery(query)
      return search === '' ? pathname : `${pathname}?${search}`
    }

    /** Attach HTTP facts to an Error so callers can branch on them. */
    function httpError(status, body, path) { const message = pick(body, 'message') ?? `HTTP ${status}${path ? ` · ${path}` : ''}`
      const error = new Error(String(message))
      error.status = status
      error.code = pick(body, 'code')
      error.body = body
      return error
    }

    /**
     * One JSON request. Never throws a bare string; 304 is reported separately
     * so the caller can keep whatever it already has.
     * @param {string} path route relative to `/api/daily-work`.
     * @param {{method?: string, query?: object, body?: any, headers?: object, signal?: AbortSignal}} [options]
     * @returns {Promise<{data?: any, response: Response, notModified?: boolean}>} parsed result.
     */
    async function requestJson(path, options = {}) { const { method = 'GET', query, body, headers, signal } = options
      const init = { method, cache: 'no-store', credentials: 'same-origin', signal }
      const merged = {}
      if (body !== undefined) merged['Content-Type'] = 'application/json'
      if (headers !== undefined) Object.assign(merged, headers)
      if (Object.keys(merged).length > 0) init.headers = merged
      if (body !== undefined) init.body = JSON.stringify(body)
      const response = await fetch(apiUrl(path, query), init)
      if (response.status === 304) return { response, notModified: true }
      let text = ''
      try { text = await response.text()
      } catch { text = ''
      }
      let data = null
      if (text !== '') { try { data = JSON.parse(text)
        } catch { data = null
        }
      }
      if (!response.ok) throw httpError(response.status, data, path)
      return { data, response }
    }

    /** POST helper for write routes; returns the parsed body. */
    async function postJson(path, body, headers) { const { data } = await requestJson(path, { method: 'POST', body, headers })
      return data ?? {}
    }

    /* ==================================================================== *
     * 5. Hooks
     * ==================================================================== */

    /** Viewport width with passive resize tracking (breakpoints 1240 / 900). */
    function useViewportWidth() { const [width, setWidth] = useState(() =>
        typeof window === 'undefined' ? BREAK_TWO_COL : window.innerWidth, )
      useEffect(() => { if (typeof window === 'undefined') return undefined
        let frame = 0
        const onResize = () => { if (frame !== 0) return
          frame = window.requestAnimationFrame(() => { frame = 0
            setWidth(window.innerWidth)
          })
        }
        window.addEventListener('resize', onResize)
        return () => { window.removeEventListener('resize', onResize)
          if (frame !== 0) window.cancelAnimationFrame(frame)
        }
      }, [])
      return width
    }

    /**
     * Polling loader for one endpoint.
     *
     * Guarantees required by CONTRACTS §8:
     * - `cache: 'no-store'` on every call;
     * - `If-None-Match` + 304 reuse when `etag` is requested;
     * - a failed poll keeps the previous data and records the error;
     * - 401 is reported so the shell can raise the red banner.
     *
     * `query` must be memoized by the caller (it is a dependency).
     * @param {{path: string, query?: object, pollMs?: number, paused?: boolean,
     *   enabled?: boolean, etag?: boolean, onAuth?: (error: Error) => void}} options loader options.
     * @returns {{data: any, error: Error|null, lastSuccessAt: string|null,
     *   loading: boolean, refresh: () => Promise<void>}} current snapshot + refresh.
     */
    function usePoll(options) { const { path, query, pollMs = 0, paused = false, enabled = true, etag = false, onAuth } = options
      const [snapshot, setSnapshot] = useState({ data: null, error: null, lastSuccessAt: null, loading: enabled === true, })
      const etagRef = useRef('')
      const abortRef = useRef(null)
      const onAuthRef = useRef(onAuth)
      onAuthRef.current = onAuth

      const load = useCallback(async () => { if (enabled !== true) return
        if (abortRef.current) abortRef.current.abort()
        const controller = new AbortController()
        abortRef.current = controller
        const headers = {}
        if (etag === true && etagRef.current !== '') headers['If-None-Match'] = etagRef.current
        try { const result = await requestJson(path, { query, headers: Object.keys(headers).length > 0 ? headers : undefined,
            signal: controller.signal, })
          if (result.notModified === true) { setSnapshot((prev) => ({ data: prev.data, error: null, loading: false,
              lastSuccessAt: new Date().toISOString(), }))
            return
          }
          const nextEtag = result.response.headers.get('etag')
          if (typeof nextEtag === 'string' && nextEtag !== '') etagRef.current = nextEtag
          setSnapshot({ data: result.data, error: null, loading: false, lastSuccessAt: new Date().toISOString(), })
        } catch (error) { if (error !== null && error !== undefined && error.name === 'AbortError') return
          const status = error !== null && error !== undefined ? error.status : undefined
          if (status === 401 && typeof onAuthRef.current === 'function') onAuthRef.current(error)
          setSnapshot((prev) => ({ data: prev.data, error: error ?? new Error('request failed'), loading: false,
            lastSuccessAt: prev.lastSuccessAt, }))
        }
      }, [path, query, enabled, etag])

      useEffect(() => { if (enabled !== true) return undefined
        void load()
        if (pollMs <= 0 || paused === true) { return () => { if (abortRef.current) abortRef.current.abort()
          }
        }
        const timer = window.setInterval(() => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void load()
        }, pollMs)
        return () => { window.clearInterval(timer)
          if (abortRef.current) abortRef.current.abort()
        }
      }, [load, pollMs, paused, enabled])

      return { ...snapshot, refresh: load }
    }

    /** Run an async action once per trigger and expose its status. */
    function usePending() { const [pending, setPending] = useState(null)
      const mounted = useRef(true)
      useEffect(() => () => { mounted.current = false }, [])
      const run = useCallback(async (key, task) => { setPending(key)
        try { return await task()
        } finally { if (mounted.current) setPending(null)
        }
      }, [])
      return { pending, run }
    }

    /** Auto-dismissing toast queue entry. */
    function useToast() { const [toast, setToast] = useState(null)
      const timerRef = useRef(0)
      const dismiss = useCallback(() => { if (timerRef.current !== 0) { window.clearTimeout(timerRef.current)
          timerRef.current = 0
        }
        setToast(null)
      }, [])
      const show = useCallback( (message, tone = 'info') => { if (timerRef.current !== 0) window.clearTimeout(timerRef.current)
          setToast({ message, tone, id: Date.now() })
          timerRef.current = window.setTimeout(() => { timerRef.current = 0
            setToast(null)
          }, 5000)
        }, [], )
      useEffect( () => () => { if (timerRef.current !== 0) window.clearTimeout(timerRef.current)
        }, [], )
      return { toast, show, dismiss }
    }

    /** True when the event came from a typing surface (hotkeys must not steal it). */
    function isTypingTarget(target) { if (target === null || target === undefined || typeof target.tagName !== 'string') return false
      const tag = target.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
      if (target.isContentEditable === true) return true
      return false
    }

    /* ==================================================================== *
     * 6. Design tokens + primitives
     * ==================================================================== */

    /** Colour tokens. Values are host aliases only — no literal hex here. */
    const T = { bg: 'var(--dsw-alias-bg-base)', l1: 'var(--dsw-alias-bg-layer-1)', l2: 'var(--dsw-alias-bg-layer-2)',
      overlay: 'var(--dsw-alias-bg-overlay)', b1: 'var(--dsw-alias-border-l1)', b2: 'var(--dsw-alias-border-l2)',
      b3: 'var(--dsw-alias-border-l3)', fg: 'var(--dsw-alias-label-primary)', fg2: 'var(--dsw-alias-label-secondary)',
      fg3: 'var(--dsw-alias-label-tertiary)', cap: 'var(--dsw-alias-label-caption)', hover: 'var(--dsw-alias-interactive-bg-hover)',
      active: 'var(--dsw-alias-interactive-bg-active)', selected: 'var(--dsw-alias-button-ghost-active-fill)',
      brand: 'var(--dsw-alias-state-business-primary)', link: 'var(--dsw-alias-link)', ok: 'var(--dsw-alias-state-success-primary)',
      okBg: 'var(--dsw-alias-state-success-tertiary)', warn: 'var(--dsw-alias-state-warn-primary)',
      warnLabel: 'var(--dsw-alias-state-warn-label)', warnBg: 'var(--dsw-alias-state-warn-tertiary)',
      err: 'var(--dsw-alias-state-error-primary)', done: 'var(--dsw-alias-state-done-primary)', idle: 'var(--dsw-alias-state-idle-primary)',
      btn: 'var(--dsw-alias-button-primary-fill)', btnFg: 'var(--dsw-alias-label-primary-foreground)',
      code: 'var(--dsw-alias-markdown-code-block)', inlineCode: 'var(--dsw-alias-markdown-inline-code)',
      tag: 'var(--dsw-alias-markdown-tag)', addBg: 'var(--dsw-alias-file-diff-added-bg)',
      addGutter: 'var(--dsw-alias-file-diff-added-gutter)', addMarker: 'var(--dsw-alias-file-diff-added-marker)',
      delBg: 'var(--dsw-alias-file-diff-deleted-bg)', delGutter: 'var(--dsw-alias-file-diff-deleted-gutter)',
      delMarker: 'var(--dsw-alias-file-diff-deleted-marker)', evidence: 'var(--dsw-alias-code-diff-added)',
      skeleton: 'var(--dsw-alias-bg-skeleton)', toastBg: 'var(--dsw-alias-toast-bg)', toastFg: 'var(--dsw-alias-toast-label)',
      scrollbar: 'var(--dsw-alias-scrollbar-bg-l2)', sidebar: 'var(--dsw-specific-sidebar-fill)', }

    /** Radii, mirroring the host scale (4/8/12/16/20). */
    const R = { xs: 'var(--dsw-radius-xs, 4px)', sm: 'var(--dsw-radius-sm, 8px)', md: 'var(--dsw-radius-md, 12px)',
      lg: 'var(--dsw-radius-lg, 16px)', }

    /** Type scale from research/04-ux: 12 / 13 / 14 / 16. */
    const TYPE = { xxs: 12, xs: 13, s: 14, base: 16 }

    /** One stylesheet for things inline styles cannot express. */
    const BASE_CSS = [ '.dw-root,.dw-root *{box-sizing:border-box}',
      '.dw-root{height:100%;min-height:0;font-family:var(--dsw-font-family,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);',
      'font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}',
      '.dw-root :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dw-root button{font:inherit;color:inherit}', '.dw-root input,.dw-root textarea,.dw-root select{font:inherit}',
      '.dw-scroll{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}',
      '.dw-scroll::-webkit-scrollbar{width:8px;height:8px}',
      '.dw-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:4px}',
      '.dw-scroll::-webkit-scrollbar-track{background:transparent}', '.dw-click:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dw-click:active{background:var(--dsw-alias-interactive-bg-active)}', '@keyframes dw-spin{to{transform:rotate(360deg)}}',
      '@keyframes dw-pulse{0%,100%{opacity:.4}50%{opacity:.85}}', ].join('')

    /** Inject BASE_CSS exactly once. Cosmetic failure must never break the panel. */
    function ensureBaseStyles() { try { if (typeof document === 'undefined') return
        if (document.getElementById('daily-work-hub-base-styles') !== null) return
        const holder = document.createElement('div')
        holder.id = 'daily-work-hub-base-styles'
        holder.style.display = 'none'
        holder.textContent = `<style>${BASE_CSS}</style>`
        document.head.appendChild(holder)
      } catch { /* styles are cosmetic */
      }
    }

    /** SVG path table. 16×16, stroke-only, currentColor. */
    const ICONS = { inbox: ['M2 9h3l1 2h4l1-2h3', 'M2 9l2-6h8l2 6v4H2z'], queue: ['M3 4h10M3 8h6M3 12h4', 'M10.5 11.5l1.5 1.5 2.5-2.5'],
      work: ['M4 3h8v10H4z', 'M6 6h4M6 9h3'], proj: ['M3 5.5l5-2.5 5 2.5v5l-5 2.5-5-2.5z', 'M3 5.5l5 2.5 5-2.5'],
      prompt: ['M4 5l3 3-3 3M9.5 11h3'], rules: ['M3 5h10M3 8h10M3 11h10'],
      gear: ['M8 5.8a2.2 2.2 0 100 4.4 2.2 2.2 0 000-4.4z', 'M8 2v1.6M8 12.4V14M2 8h1.6M12.4 8H14M3.8 3.8l1.1 1.1M11.1 11.1l1.1 1.1M12.2 3.8l-1.1 1.1M4.9 11.1l-1.1 1.1'],
      search: ['M7 3a4 4 0 100 8 4 4 0 000-8z', 'M10 10l3.5 3.5'], chev: ['M6 4l4 4-4 4'], down: ['M4 6l4 4 4-4'],
      ext: ['M6.5 3H13v6.5M13 3L7 9M3.5 6v6.5H10'], spark: ['M8 2l1.5 4L14 7.5 9.5 9 8 13 6.5 9 2 7.5 6.5 6z'],
      merge: ['M4.5 2.4a1.6 1.6 0 100 3.2 1.6 1.6 0 000-3.2z', 'M4.5 10.4a1.6 1.6 0 100 3.2 1.6 1.6 0 000-3.2z', 'M11.5 2.4a1.6 1.6 0 100 3.2 1.6 1.6 0 000-3.2z', 'M4.5 5.6v4.8M9.9 4.6c0 2.4-1.4 3-3.4 3'],
      check: ['M3.5 8.5l3 3 6-6.5'], warn: ['M8 2.8l5.2 10.4H2.8zM8 6.4v3.1', 'M8 11.2v.8'], talk: ['M3 3.5h10v6.5H6.5L3 13z'],
      plus: ['M8 3.5v9M3.5 8h9'], clock: ['M8 2.8a5.2 5.2 0 100 10.4A5.2 5.2 0 008 2.8z', 'M8 5v3.2l2 1.3'], x: ['M4 4l8 8M12 4l-8 8'],
      shield: ['M8 2l5 2v5l-5 3-5-3V4z', 'M6 8l1.5 1.5L10.5 6.5'], play: ['M5.5 3.8l6 4.2-6 4.2z'],
      hist: ['M3 8a5 5 0 105-5M8 5.5V8l2 1.4M3 3.5V6h2.5'], file: ['M4 2.5h5l3 3v8H4zM9 2.5v3h3'],
      more: ['M4 7.2v1.6M8 7.2v1.6M12 7.2v1.6'], refresh: ['M13 8a5 5 0 01-8.5 3.5M3 8a5 5 0 018.5-3.5M11.5 2v3h-3M4.5 14v-3h3'],
      eye: ['M1.8 8S4.5 4 8 4s6.2 4 6.2 4-2.7 4-6.2 4S1.8 8 1.8 8z', 'M8 6.2a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6z'],
      trash: ['M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.6 8.5h4.8l.6-8.5'], copy: ['M5.5 5.5h7v7h-7z', 'M10.5 5.5V3.5h-7v7h2'],
      edit: ['M4 11.5l6.5-6.5 2 2L6 13.5H4z', 'M10.5 3.5l2 2'],
      link: ['M6.5 9.5l3-3', 'M7 5.5l1-1a2.2 2.2 0 013 3l-1 1', 'M9 10.5l-1 1a2.2 2.2 0 01-3-3l1-1'], filter: ['M3 4h10M5.5 8h5M7.5 12h1'],
      arrowLeft: ['M10 4l-4 4 4 4'], dot: ['M8 6.2a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6z'], pause: ['M6 4v8M10 4v8'],
      stop: ['M4.5 4.5h7v7h-7z'], folder: ['M2.5 4h4l1 1.5h6V13h-11z'], archive: ['M3 5h10v8H3z', 'M3 5l1.5-2h7L13 5', 'M6.5 8h3'], }

    /**
     * Small inline icon.
     * @param {{name: string, size?: number, color?: string, style?: object}} props
     * @returns {any} svg element.
     */
    function Icon(props) { const size = props.size ?? 14
      const paths = ICONS[props.name] ?? ICONS.dot
      return h( 'svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
          style: { flex: 'none', color: props.color ?? 'currentColor', ...(props.style ?? {}) }, },
        paths.map((d, index) => h('path', { key: index, d })), )
    }

    /** Hover binding helper (inline styles cannot express :hover). */
    function useHover() { const [hover, setHover] = useState(false)
      const handlers = useMemo( () => ({ onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false), }), [], )
      return [hover, handlers]
    }

    /** Tone → foreground/background pair using color-mix, host-style. */
    function toneColors(tone) { switch (tone) { case 'ok':
          return { fg: T.ok, bg: `color-mix(in srgb, ${T.ok} 14%, transparent)` }
        case 'warn':
          return { fg: T.warnLabel, bg: `color-mix(in srgb, ${T.warn} 16%, transparent)` }
        case 'error':
          return { fg: T.err, bg: `color-mix(in srgb, ${T.err} 14%, transparent)` }
        case 'brand':
          return { fg: T.brand, bg: `color-mix(in srgb, ${T.brand} 14%, transparent)` }
        case 'done':
          return { fg: T.done, bg: `color-mix(in srgb, ${T.done} 14%, transparent)` }
        default:
          return { fg: T.fg2, bg: T.tag }
      }
    }

    /**
     * Button.
     * @param {{variant?: 'primary'|'ghost'|'subtle'|'danger'|'text', size?: 'sm'|'md',
     *   icon?: string, children?: any, onClick?: Function, disabled?: boolean,
     *   title?: string, type?: string, style?: object, full?: boolean}} props
     * @returns {any} button element.
     */
    function Button(props) { const [hover, bind] = useHover()
      const variant = props.variant ?? 'ghost'
      const small = props.size === 'sm'
      const disabled = props.disabled === true
      const base = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: small ? 26 : 30,
        padding: small ? '0 10px' : '0 12px', borderRadius: R.sm, border: '1px solid transparent',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, fontSize: TYPE.xs, fontWeight: 500,
        whiteSpace: 'nowrap', background: 'transparent', color: T.fg, ...(props.full === true ? { width: '100%' } : {}),
        ...(props.style ?? {}), }
      if (variant === 'primary') { Object.assign(base, { background: T.btn, color: T.btnFg, fontWeight: 600 })
        if (hover && !disabled) base.filter = 'brightness(1.08)'
      } else if (variant === 'ghost') {
        Object.assign(base, { borderColor: T.b3, background: hover && !disabled ? T.hover : 'transparent', color: T.fg })
      } else if (variant === 'subtle') { Object.assign(base, { borderColor: T.b2, background: hover && !disabled ? T.active : T.l1 })
      } else if (variant === 'danger') { Object.assign(base, { borderColor: `color-mix(in srgb, ${T.err} 50%, transparent)`, color: T.err,
          background: hover && !disabled ? `color-mix(in srgb, ${T.err} 12%, transparent)` : 'transparent', })
      } else if (variant === 'text') {
        Object.assign(base, { borderColor: 'transparent', color: hover && !disabled ? T.link : T.fg2, padding: 0, height: 'auto' })
      }
      return h( 'button', { type: props.type ?? 'button', title: props.title, disabled, onClick: disabled ? undefined : props.onClick,
          ...bind, style: base, }, props.icon !== undefined ? h(Icon, { name: props.icon, size: small ? 12 : 14 }) : null, props.children, )
    }

    /** Square icon-only button. */
    function IconButton(props) { const [hover, bind] = useHover()
      const size = props.size ?? 26
      return h( 'button', { type: 'button', title: props.title, 'aria-label': props['aria-label'] ?? props.title,
          disabled: props.disabled === true, onClick: props.disabled === true ? undefined : props.onClick, ...bind, style: { width: size,
            height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0,
            border: '1px solid transparent', borderRadius: R.sm, background: hover && props.disabled !== true ? T.hover : 'transparent',
            color: props.active === true ? T.fg : T.fg3, cursor: props.disabled === true ? 'not-allowed' : 'pointer',
            opacity: props.disabled === true ? 0.5 : 1, ...(props.style ?? {}), }, },
        h(Icon, { name: props.icon, size: props.iconSize ?? 14 }), )
    }

    /**
     * Pill chip. `tone` selects the semantic colour pair.
     * @param {{tone?: string, children?: any, title?: string, onClick?: Function, *   active?: boolean, dot?: boolean}} props
     */
    function Chip(props) { const [hover, bind] = useHover()
      const colors = toneColors(props.tone ?? 'neutral')
      const clickable = typeof props.onClick === 'function'
      return h( 'span', { onClick: clickable ? props.onClick : undefined, ...(clickable ? bind : {}), style: { display: 'inline-flex',
            alignItems: 'center', gap: 4, maxWidth: '100%', padding: '1px 8px', height: 20, borderRadius: 999,
            border: '1px solid transparent', background: props.active === true ? colors.fg : colors.bg,
            color: props.active === true ? T.bg : colors.fg, fontSize: 11, lineHeight: '18px', whiteSpace: 'nowrap', overflow: 'hidden',
            textOverflow: 'ellipsis', cursor: clickable ? 'pointer' : 'default', }, title: props.title, },
        props.dot === true ? h('span', { style: { width: 5, height: 5, borderRadius: 3, background: 'currentColor' } }) : null,
        props.children, )
    }

    /** Small count badge. */
    function CountBadge(props) { const n = Number(props.value)
      if (!Number.isFinite(n) || n <= 0) return null
      const text = n > 99 ? '99+' : String(n)
      return h( 'span', { style: { minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, lineHeight: '18px',
            background: props.tone === 'error' ? T.err : props.tone === 'brand' ? `color-mix(in srgb, ${T.brand} 18%, transparent)` : T.tag,
            color: props.tone === 'error' ? T.btnFg : props.tone === 'brand' ? T.brand : T.fg3, }, }, text, )
    }

    /** Unread dot, 6px. */
    function UnreadDot() { return h('span', { style: { width: 6, height: 6, borderRadius: 3, background: T.brand, flex: 'none' } })
    }

    /** Label + hint + control row used by every form in the panel. */
    function Field(props) { return h( 'label', { style: { display: 'flex', flexDirection: props.inline === true ? 'row' : 'column',
            alignItems: props.inline === true ? 'center' : 'stretch', justifyContent: 'space-between', gap: props.inline === true ? 16 : 4,
            padding: props.inline === true ? '10px 0' : '0', minWidth: 0, }, }, h( 'span',
          { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
          h('span', { style: { fontSize: TYPE.xs, fontWeight: 500, color: T.fg } }, props.label),
          props.hint !== undefined && props.hint !== null
            ? h('span', { style: { fontSize: 11, color: T.cap, lineHeight: '15px' } }, props.hint)
            : null, ), h('span', { style: { flex: props.inline === true ? '0 0 auto' : '1 1 auto', minWidth: 0 } }, props.children), )
    }

    /** Shared input styling. */
    function inputStyle(extra) { return { width: '100%', minHeight: 30, padding: '5px 9px', borderRadius: R.sm, border: `1px solid ${T.b3}`,
        background: T.l2, color: T.fg, fontSize: TYPE.xs, lineHeight: '18px', outline: 'none', ...(extra ?? {}), }
    }

    /** Text input. */
    function TextInput(props) { return h('input', { type: props.type ?? 'text', value: props.value ?? '', placeholder: props.placeholder,
        disabled: props.disabled === true, onChange: (event) => {
          if (typeof props.onChange === 'function') props.onChange(event.target.value, event)
        }, onKeyDown: props.onKeyDown, style: inputStyle(props.style), spellCheck: false, })
    }

    /** Multi-line input. */
    function TextArea(props) { return h('textarea', { value: props.value ?? '', placeholder: props.placeholder, rows: props.rows ?? 4,
        disabled: props.disabled === true, onChange: (event) => {
          if (typeof props.onChange === 'function') props.onChange(event.target.value, event)
        },
        style: inputStyle({ resize: 'vertical', fontFamily: props.mono === true ? 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)' : 'inherit', ...(props.style ?? {}) }),
        spellCheck: false, })
    }

    /** Native select styled to the host input look. */
    function SelectInput(props) { return h( 'select', { value: props.value ?? '', disabled: props.disabled === true, onChange: (event) => {
            if (typeof props.onChange === 'function') props.onChange(event.target.value, event)
          }, style: inputStyle({ cursor: 'pointer', appearance: 'auto', ...(props.style ?? {}) }), }, props.options.map((option) =>
          h('option', { key: option.value, value: option.value }, option.label), ), )
    }

    /** Switch with aria-checked semantics. */
    function Switch(props) { const on = props.checked === true
      return h( 'button', { type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': props.label,
          disabled: props.disabled === true, onClick: props.disabled === true ? undefined : props.onClick, style: { width: 34, height: 20,
            flex: 'none', borderRadius: 999, border: '1px solid transparent', padding: 0,
            cursor: props.disabled === true ? 'not-allowed' : 'pointer', opacity: props.disabled === true ? 0.5 : 1,
            background: on ? T.ok : T.idle, position: 'relative', }, }, h('span', { style: { position: 'absolute', top: 2,
            left: on ? 16 : 2, width: 16, height: 16, borderRadius: '50%', background: T.btnFg, transition: 'left .12s ease', }, }), )
    }

    /** Card surface. */
    function Card(props) { return h( 'section', { style: { border: `1px solid ${props.dashed === true ? T.b3 : T.b2}`,
            borderStyle: props.dashed === true ? 'dashed' : 'solid', borderRadius: R.md, background: props.tone === 'layer' ? T.l2 : T.l1,
            padding: props.padding ?? 12, minWidth: 0, ...(props.style ?? {}), }, }, props.children, )
    }

    /** Modal dialog with Esc + backdrop dismissal. */
    function Modal(props) { const onCloseRef = useRef(props.onClose)
      onCloseRef.current = props.onClose
      useEffect(() => { const onKey = (event) => { if (event.key !== 'Escape') return
          event.stopPropagation()
          if (typeof onCloseRef.current === 'function') onCloseRef.current()
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [])
      return h( 'div', { style: { position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'flex-start',
            justifyContent: 'center', padding: '8vh 24px 24px', background: 'color-mix(in srgb, #000 45%, transparent)', },
          onMouseDown: (event) => { if (event.target === event.currentTarget && typeof props.onClose === 'function') props.onClose()
          }, }, h( 'div', { role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title, className: 'dw-scroll', style: {
              width: props.width ?? 560, maxWidth: 'calc(100vw - 48px)', maxHeight: '84vh', display: 'flex', flexDirection: 'column',
              background: T.overlay, color: T.fg, border: `1px solid ${T.b2}`, borderRadius: R.lg, boxShadow: '0 18px 48px rgba(0,0,0,.35)',
              overflow: 'hidden', }, }, h( 'header', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
                borderBottom: `1px solid ${T.b1}`, flex: 'none', }, },
            h('span', { style: { fontSize: TYPE.s, fontWeight: 600, flex: 1, minWidth: 0 } }, props.title),
            typeof props.onClose === 'function'
              ? h(IconButton, { icon: 'x', title: tr('common.close'), onClick: props.onClose })
              : null, ),
          h('div', { className: 'dw-scroll', style: { padding: props.bodyPadding ?? '14px 16px', overflow: 'auto', flex: 1, minHeight: 0 } }, props.children),
          props.footer !== undefined
            ? h( 'footer', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '10px 16px',
                    borderTop: `1px solid ${T.b1}`, flex: 'none', }, }, props.footer, )
            : null, ), )
    }

    /** Two-step confirmation dialog for every remote write. */
    function ConfirmDialog(props) { return h( Modal, { title: props.title, width: props.width ?? 460, onClose: props.onCancel, footer: [
            h(Button, { key: 'cancel', onClick: props.onCancel }, props.cancelLabel ?? tr('common.cancel')), h( Button,
              { key: 'ok', variant: props.danger === true ? 'danger' : 'primary', onClick: props.onConfirm },
              props.confirmLabel ?? tr('common.confirm'), ), ], },
        h('p', { style: { margin: 0, color: T.fg2, lineHeight: '20px' } }, props.body), )
    }

    /** Yellow / red / info banner. */
    function Banner(props) { const tone = props.tone ?? 'warn'
      const colors = toneColors(tone === 'error' ? 'error' : tone === 'ok' ? 'ok' : 'warn')
      return h( 'div', { role: tone === 'error' ? 'alert' : 'status', style: { display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 12px', borderRadius: R.sm, border: `1px solid color-mix(in srgb, ${colors.fg} 35%, transparent)`,
            background: colors.bg, color: colors.fg, fontSize: TYPE.xs, flex: 'none', }, },
        h(Icon, { name: tone === 'error' ? 'shield' : 'warn', size: 14 }),
        h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
          h('span', { style: { fontWeight: 600 } }, props.title),
          props.body !== undefined ? h('span', { style: { opacity: 0.9, fontSize: 12, lineHeight: '16px' } }, props.body) : null, ),
        props.actions, )
    }

    /** Empty state block. */
    function EmptyState(props) { return h( 'div', { style: { display: 'flex', flexDirection: 'column',
            alignItems: props.compact === true ? 'flex-start' : 'center', justifyContent: 'center', gap: 6,
            padding: props.compact === true ? '12px 0' : '40px 24px', textAlign: props.compact === true ? 'left' : 'center', color: T.fg2,
            flex: 1, minHeight: 0, }, }, h( 'span', { style: { width: 32, height: 32, borderRadius: R.md, display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center', background: T.tag, color: T.fg3, marginBottom: 2, }, },
          h(Icon, { name: props.icon ?? 'inbox', size: 16 }), ),
        h('div', { style: { fontSize: TYPE.s, fontWeight: 600, color: T.fg } }, props.title),
        props.body !== undefined ? h('div', { style: { fontSize: TYPE.xs, color: T.fg2, maxWidth: 380, lineHeight: '20px' } }, props.body) : null,
        props.actionLabel !== undefined
          ? h('div', { style: { marginTop: 6 } }, h(Button, { variant: 'primary', onClick: props.onAction }, props.actionLabel))
          : null, )
    }

    /** Skeleton bar used while a review runs or a list loads. */
    function Skeleton(props) { return h('div', { style: { height: props.height ?? 12, width: props.width ?? '100%', borderRadius: R.xs,
          background: T.skeleton, animation: 'dw-pulse 1.6s ease-in-out infinite', }, })
    }

    /** Inline spinner. */
    function Spinner(props) { return h('span', { 'aria-hidden': 'true', style: { width: props.size ?? 14, height: props.size ?? 14,
          borderRadius: '50%', border: `2px solid ${T.brand}`, borderRightColor: 'transparent', animation: 'dw-spin 1s linear infinite',
          display: 'inline-block', flex: 'none', }, })
    }

    /** Bottom-right toast. */
    function Toast(props) { if (props.toast === null || props.toast === undefined) return null
      const tone = props.toast.tone === 'error' ? 'error' : props.toast.tone === 'ok' ? 'ok' : 'neutral'
      const color = tone === 'error' ? T.err : tone === 'ok' ? T.ok : T.toastFg
      return h( 'div', { role: 'status', style: { position: 'fixed', right: 16, bottom: 38, zIndex: 70, display: 'flex',
            alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: R.sm, background: T.toastBg, color: color, fontSize: TYPE.xs,
            boxShadow: '0 8px 24px rgba(0,0,0,.28)', maxWidth: 420, }, }, h(Icon, { name: tone === 'error' ? 'warn' : 'check', size: 14 }),
        h('span', { style: { color: T.toastFg } }, props.toast.message),
        h(IconButton, { icon: 'x', title: tr('common.close'), size: 20, onClick: props.onDismiss, style: { color: T.toastFg } }), )
    }

    /** Underline tabs (indicator uses label-primary, not brand — mockup rule). */
    function Tabs(props) { return h( 'div',
        { role: 'tablist', style: { display: 'flex', alignItems: 'stretch', gap: 2, flex: 'none', minWidth: 0 } }, props.tabs.map((tab) =>
          h( 'button', { key: tab.id, type: 'button', role: 'tab', 'aria-selected': props.active === tab.id ? 'true' : 'false',
              onClick: () => props.onChange(tab.id), style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px',
                background: 'transparent', border: 'none', borderBottom: `2px solid ${props.active === tab.id ? T.fg : 'transparent'}`,
                color: props.active === tab.id ? T.fg : T.fg2, fontWeight: props.active === tab.id ? 600 : 400, fontSize: TYPE.xs,
                cursor: 'pointer', whiteSpace: 'nowrap', }, }, tab.label, tab.count !== undefined && tab.count !== null
              ? h('span', { style: { fontSize: 11, color: T.cap } }, String(tab.count))
              : null, ), ), )
    }

    /** Popover menu for the `⋯` affordances. */
    function Menu(props) { const [open, setOpen] = useState(false)
      const rootRef = useRef(null)
      useEffect(() => { if (!open) return undefined
        const onDown = (event) => { if (rootRef.current !== null && rootRef.current.contains(event.target) === false) setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('mousedown', onDown, true)
        window.addEventListener('keydown', onKey, true)
        return () => { window.removeEventListener('mousedown', onDown, true)
          window.removeEventListener('keydown', onKey, true)
        }
      }, [open])
      return h( 'span', { ref: rootRef, style: { position: 'relative', display: 'inline-flex' } },
        h(IconButton, { icon: props.icon ?? 'more', title: props.title ?? tr('common.more'), onClick: () => setOpen((value) => !value), active: open }),
        open
          ? h( 'div', { role: 'menu', style: { position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 40, minWidth: 150,
                  padding: 4, borderRadius: R.sm, border: `1px solid ${T.b2}`, background: T.overlay,
                  boxShadow: '0 10px 30px rgba(0,0,0,.3)', }, }, props.items.map((item) => h( 'button', { key: item.id, type: 'button',
                    role: 'menuitem', disabled: item.disabled === true, onClick: () => { setOpen(false)
                      if (typeof item.onSelect === 'function') item.onSelect()
                    }, className: 'dw-click', style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 8px',
                      border: 'none', borderRadius: R.xs, background: 'transparent', color: item.danger === true ? T.err : T.fg,
                      fontSize: TYPE.xs, textAlign: 'left', cursor: item.disabled === true ? 'not-allowed' : 'pointer',
                      opacity: item.disabled === true ? 0.5 : 1, }, },
                  item.icon !== undefined ? h(Icon, { name: item.icon, size: 12 }) : null, item.label, ), ), )
          : null, )
    }

    /** Monospace block for evidence, payloads and rendered previews. */
    function CodeBlock(props) { return h( 'pre', { className: 'dw-scroll', style: { margin: 0, padding: '8px 10px', borderRadius: R.sm,
            border: `1px solid ${T.b1}`, background: props.inline === true ? T.inlineCode : T.code, color: T.fg2,
            fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)', fontSize: 12, lineHeight: '18px',
            maxHeight: props.maxHeight ?? 240, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', }, }, props.children, )
    }

    /** Readable crash box rendered by the boundary. */
    function CrashBox(props) { return h( 'div', { role: 'alert', style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 20,
            margin: 16, border: `1px solid color-mix(in srgb, ${T.err} 40%, transparent)`, borderRadius: R.md, background: T.l1,
            color: T.fg, }, },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, color: T.err, fontWeight: 600 } }, h(Icon, { name: 'warn', size: 16 }), tr('crash.title')),
        h('div', { style: { fontSize: TYPE.xs, color: T.fg2 } }, tr('crash.body')),
        h(CodeBlock, { maxHeight: 160 }, String(props.error?.stack ?? props.error?.message ?? props.error)), )
    }

    /** Class boundary — the only construct React can catch render errors with. */
    class PanelErrorBoundary extends React.Component { constructor(props) { super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) { return { error }
      }

      componentDidCatch(error, info) { try { console.error('[daily-work-hub] render error', error, info)
        } catch { /* console may be gone */
        }
      }

      render() { if (this.state.error !== null) return h(CrashBox, { error: this.state.error })
        return this.props.children
      }
    }

    /* ==================================================================== *
     * 7. Inbox family (list, filters, bulk, workspace)
     * ==================================================================== */

    const REVIEW_REASONS = ['review_requested', 'approval_required']
    const WORK_REASON_PREFIXES = ['authored', 'changes_requested']

    /** All reasons attached to a row (fallback to the single primary reason). */
    function reasonsOf(item) { if (item === null || item === undefined) return []
      if (Array.isArray(item.reasons) && item.reasons.length > 0) return item.reasons
      return item.reason ? [item.reason] : []
    }

    /** Does a row belong to a filtered inbox mode (review / my work)? */
    function matchesMode(item, mode) { if (mode !== 'review' && mode !== 'work') return true
      const reasons = reasonsOf(item)
      if (mode === 'review') return reasons.some((reason) => REVIEW_REASONS.includes(reason))
      return reasons.some((reason) => WORK_REASON_PREFIXES.some((prefix) => String(reason).startsWith(prefix)))
    }

    /** Reason weight from CONTRACTS §4 (client-side ordering fallback). */
    const REASON_WEIGHT = { review_requested: 95, approval_required: 92, changes_requested: 85, conflict: 82, ci_failed: 78, assigned: 65,
      mentioned: 60, authored_feedback: 55, authored: 40, watching: 20, }

    /** Reason label + tone; unknown reasons degrade to the raw string. */
    function reasonMeta(reason) { const meta = REASON_META[reason]
      if (meta !== undefined) return { label: LANG === 'en' ? meta.en : meta.zh, tone: meta.tone }
      return { label: String(reason ?? tr('common.unknown')), tone: 'neutral' }
    }

    /** Normalized CI facts. */
    function ciMeta(ci) { const status = String(pick(ci, 'status') ?? '').toLowerCase()
      if (status === '') return null
      if (['success', 'succeeded', 'passed', 'ok'].includes(status)) return { label: 'CI ✓', tone: 'ok' }
      if (['failed', 'failure', 'error'].includes(status)) return { label: 'CI ✗', tone: 'error' }
      if (['running', 'pending', 'created', 'preparing', 'manual'].includes(status)) {
        return { label: LANG === 'en' ? 'CI running' : 'CI 运行中', tone: 'warn' }
      }
      if (['canceled', 'cancelled', 'skipped'].includes(status)) return { label: LANG === 'en' ? 'CI skipped' : 'CI 跳过', tone: 'neutral' }
      return { label: `CI ${status}`, tone: 'neutral' }
    }

    /** Build the meta separators for one row (missing data leaves the slot empty). */
    function rowMetaParts(item) { const parts = []
      const reason = reasonMeta(item.reason)
      parts.push({ key: 'reason', node: h('span', { style: { color: T.fg2 } }, reason.label) })
      if (item.author) parts.push({ key: 'author', node: h('span', null, item.author) })
      const adds = Number(item.additions)
      const dels = Number(item.deletions)
      if (Number.isFinite(adds) || Number.isFinite(dels)) { parts.push({ key: 'diffstat', node: h( 'span',
            { style: { display: 'inline-flex', gap: 4 } },
            h('span', { style: { color: T.addMarker } }, `+${Number.isFinite(adds) ? adds : 0}`),
            h('span', { style: { color: T.delMarker } }, `−${Number.isFinite(dels) ? dels : 0}`), ), })
      }
      const ci = ciMeta(item.ci)
      if (ci !== null) parts.push({ key: 'ci', node: h('span', { style: { color: ci.tone === 'ok' ? T.ok : ci.tone === 'error' ? T.err : T.warn } }, ci.label) })
      const approvals = item.approvals
      if (approvals !== null && approvals !== undefined) { const approved = Number(approvals.approved) || 0
        const of = Number(approvals.of) || 0
        parts.push({ key: 'approvals', node: h('span', null, LANG === 'en' ? `approvals ${approved}/${of}` : `待审批 ${approved}/${of}`) })
      }
      parts.push({ key: 'time', node: h('span', { style: { color: T.cap } }, fmtAgo(item.updatedAtRemote)) })
      return parts
    }

    /** One inbox row. */
    function ItemRow(props) { const item = props.item
      const selected = props.selected === true
      const [hover, bind] = useHover()
      const unread = String(item.localState ?? '') === 'unread'
      const subject = item.subject ?? ''
      const iidLabel = typeof subject === 'string' && subject.includes('#') ? subject.slice(subject.indexOf('#')) : ''
      const parts = rowMetaParts(item)
      return h( 'div', { role: 'option', 'aria-selected': selected ? 'true' : 'false', 'data-key': item.key,
          onClick: () => props.onSelect(item), ...bind, style: { display: 'flex', alignItems: 'flex-start', gap: 8, minHeight: 58,
            padding: '7px 10px', borderBottom: `1px solid ${T.b1}`, background: selected ? T.selected : hover ? T.hover : 'transparent',
            cursor: 'pointer', position: 'relative', }, }, h( 'span', { role: 'checkbox',
            'aria-checked': props.checked === true ? 'true' : 'false', 'aria-label': LANG === 'en' ? 'Select item' : '选择条目',
            onClick: (event) => { event.stopPropagation()
              props.onToggleCheck(item)
            }, style: { width: 16, height: 16, marginTop: 2, flex: 'none', borderRadius: R.xs,
              border: `1px solid ${props.checked === true ? 'transparent' : T.b3}`,
              background: props.checked === true ? T.brand : 'transparent', display: 'inline-flex', alignItems: 'center',
              justifyContent: 'center', }, }, props.checked === true ? h(Icon, { name: 'check', size: 10, color: T.btnFg }) : null, ),
        h(Icon, { name: item.kind === 'issue' ? 'file' : 'merge', size: 14, color: T.fg3, style: { marginTop: 2 } }), h( 'div',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } }, h( 'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } }, unread ? h(UnreadDot, null) : null,
            h('span', { style: { fontSize: 11, color: T.fg3, flex: 'none' } }, item.kind === 'issue' ? 'Issue' : 'MR'), h( 'span', {
                style: { fontSize: TYPE.xs, fontWeight: 500, color: T.fg, overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap', }, title: item.title, }, item.title ?? tr('common.unknown'), ), ), h( 'div', { style: {
                display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 11, color: T.fg3, whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis', }, },
            h('span', { style: { fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)', color: T.fg3, flex: 'none' } }, item.project ?? ''),
            iidLabel !== '' ? h('span', { style: { flex: 'none' } }, `·${iidLabel}`) : null, ), h( 'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden', fontSize: 11, color: T.fg3 } },
            parts.map((part, index) => h( 'span',
                { key: part.key, style: { display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' } },
                index > 0 ? h('span', { style: { color: T.cap } }, '·') : null, part.node, ), ), ), ),
        (item.hasFindings === true || (typeof item.lastVerdict === 'string' && item.lastVerdict !== ''))
          ? h(Chip, { tone: item.hasFindings === true ? 'warn' : 'brand', title: LANG === 'en' ? 'AI reviewed' : 'AI 已审' }, 'AI')
          : null, )
    }

    /** Collapsible group header. */
    function GroupHeader(props) { const [hover, bind] = useHover()
      return h( 'button', { type: 'button', onClick: props.onToggle, 'aria-expanded': props.collapsed === true ? 'false' : 'true', ...bind,
          style: { display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 10px',
            background: hover ? T.hover : 'transparent', border: 'none', borderBottom: `1px solid ${T.b1}`, color: T.fg3, fontSize: 11,
            cursor: 'pointer', position: 'sticky', top: 0, zIndex: 2, backdropFilter: 'blur(2px)', }, },
        h(Icon, { name: props.collapsed === true ? 'chev' : 'down', size: 10 }),
        h('span', { style: { fontWeight: 600, letterSpacing: '.02em' } }, props.label),
        h('span', { style: { color: T.cap } }, String(props.count)),
        h('span', { style: { flex: 1, height: 1, background: T.b1, marginLeft: 4 } }),
        props.oldest ? h('span', { style: { color: T.cap, fontWeight: 400 } }, props.oldest) : null, )
    }

    /** Search + project/reason/state filters. */
    function FilterBar(props) { const projects = props.projects
      const projectOptions = [{ value: '', label: tr('filters.allProjects') }].concat(
        projects.map((project) => ({ value: project, label: project })), )
      const reasonOptions = [{ value: '', label: tr('filters.allReasons') }].concat(
        REASON_ORDER.map((reason) => ({ value: reason, label: reasonMeta(reason).label })), )
      const stateOptions = [ { value: '', label: tr('filters.allStates') }, { value: 'unread', label: tr('filters.unread') },
        { value: 'read', label: tr('common.read') }, { value: 'snoozed', label: tr('filters.snoozed') },
        { value: 'archived', label: tr('common.archive') }, ]
      return h( 'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderBottom: `1px solid ${T.b1}`, flex: 'none' } },
        h( 'div', { style: { position: 'relative', display: 'flex', alignItems: 'center' } },
          h(Icon, { name: 'search', size: 12, color: T.fg3, style: { position: 'absolute', left: 8, pointerEvents: 'none' } }),
          h(TextInput, { value: props.filters.q, placeholder: tr('filters.searchPlaceholder'),
            onChange: (value) => props.onChange({ ...props.filters, q: value }), style: { paddingLeft: 26, minHeight: 28 }, }), ), h( 'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 } },
          h(SelectInput, { value: props.filters.project, options: projectOptions, onChange: (value) => props.onChange({ ...props.filters, project: value }), style: { minHeight: 26, fontSize: 11 } }),
          h(SelectInput, { value: props.filters.reason, options: reasonOptions, onChange: (value) => props.onChange({ ...props.filters, reason: value }), style: { minHeight: 26, fontSize: 11 } }),
          h(SelectInput, { value: props.filters.state, options: stateOptions, onChange: (value) => props.onChange({ ...props.filters, state: value }), style: { minHeight: 26, fontSize: 11 } }),
        ), )
    }

    /** Bulk action bar — low-risk actions only (never publish / approve). */
    function BulkBar(props) { return h( 'div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px',
            borderTop: `1px solid ${T.b2}`, background: T.l2, flex: 'none', }, },
        h('span', { style: { fontSize: TYPE.xs, fontWeight: 600 } }, tr('list.selected', { n: props.count })),
        h('span', { style: { flex: 1 } }),
        h(Button, { size: 'sm', icon: 'check', onClick: () => props.onAction('read'), title: tr('list.bulkHint') }, tr('common.read')),
        h(Button, { size: 'sm', icon: 'eye', onClick: () => props.onAction('ignore') }, tr('common.ignore')),
        h(Button, { size: 'sm', icon: 'clock', onClick: () => props.onAction('snooze') }, tr('common.snooze')),
        h(Button, { size: 'sm', icon: 'archive', onClick: () => props.onAction('archive') }, tr('common.archive')),
        h(IconButton, { icon: 'x', title: tr('list.clear'), onClick: props.onClear }), )
    }

    /** Snooze preset dialog (1h / 4h / tomorrow). */
    function SnoozeDialog(props) { return h( Modal, { title: tr('common.snooze'), width: 380, onClose: props.onCancel,
          footer: h(Button, { onClick: props.onCancel }, tr('common.cancel')), }, h( 'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, SNOOZE_PRESETS.map((preset) => h( Button, { key: preset.id,
                variant: preset.id === '1h' ? 'primary' : 'ghost', onClick: () => props.onPick(preset), full: true, }, tr(preset.key), ), ),
        ), )
    }

    /** The inbox list column (used by all four inbox-family views). */
    function InboxList(props) { const { rows, selectedKeys, collapsed, onToggleGroup } = props
      const listRef = useRef(null)
      const groups = props.groups
      useEffect(() => { if (props.focusKey === null || props.focusKey === undefined) return
        const container = listRef.current
        if (container === null) return
        const node = container.querySelector(`[data-key="${String(props.focusKey).replace(/"/g, '\\"')}"]`)
        if (node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
      }, [props.focusKey])
      const allChecked = rows.length > 0 && rows.every((row) => selectedKeys.has(row.key))
      return h( 'section', { style: { flex: '1 1 auto', width: props.fullWidth === true ? '100%' : LIST_WIDTH,
            maxWidth: props.fullWidth === true ? 'none' : LIST_WIDTH, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0,
            borderRight: props.docked === true ? `1px solid ${T.b1}` : 'none', background: T.bg, position: 'relative', }, }, h( 'header',
          { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 10px 8px', borderBottom: `1px solid ${T.b1}`, flex: 'none' } },
          h( 'div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
            h('h2', { style: { margin: 0, fontSize: TYPE.base, fontWeight: 600, lineHeight: '24px', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.title),
            h('span', { style: { fontSize: 11, color: T.cap, flex: 'none' } }, props.countLabel),
            h(IconButton, { icon: 'check', title: tr('common.read'), onClick: props.onMarkAllRead, disabled: rows.length === 0 }),
            h(IconButton, { icon: 'refresh', title: `${tr('common.refresh')} (r)`, onClick: props.onRefresh }), h(IconButton, {
              icon: 'check', title: allChecked ? tr('list.clear') : `${tr('common.all')} · ⌘A`, active: allChecked,
              onClick: allChecked ? props.onClearSelection : props.onSelectAll, }), ), ), h(FilterBar, { filters: props.filters,
          projects: props.projects, onChange: props.onFilters, }), h( 'div',
          { ref: listRef, className: 'dw-scroll', role: 'listbox', 'aria-label': props.title, style: { flex: 1, minHeight: 0, overflowY: 'auto' } },
          groups.length === 0
            ? h(EmptyState, { title: props.emptyTitle, body: props.emptyBody, actionLabel: props.emptyActionLabel,
                onAction: props.emptyAction, icon: props.emptyIcon, })
            : groups.map((group) => h( 'div', { key: group.id, role: 'group' }, h(GroupHeader, { label: group.label,
                    count: group.rows.length, oldest: group.oldest, collapsed: collapsed.has(group.id),
                    onToggle: () => onToggleGroup(group.id), }), collapsed.has(group.id)
                    ? null
                    : group.rows.map((row) => h(ItemRow, { key: row.key, item: row, selected: row.key === props.selectedKey,
                          checked: selectedKeys.has(row.key), onSelect: props.onSelect, onToggleCheck: props.onToggleCheck, }), ), ), ), ),
        selectedKeys.size > 0
          ? h(BulkBar, { count: selectedKeys.size, onAction: props.onBulk, onClear: props.onClearSelection })
          : null, )
    }

    /** Group rows by reason (default) or by project (projects view). */
    function buildGroups(rows, mode, sort, collapsed) { const buckets = new Map()
      const order = []
      const groupIdOf = (item) => { if (mode === 'projects') return item.project ?? tr('list.noProject')
        return item.reason ?? 'watching'
      }
      for (const item of rows) { const id = groupIdOf(item)
        if (!buckets.has(id)) { buckets.set(id, [])
          order.push(id)
        }
        buckets.get(id).push(item)
      }
      const oldestOf = (bucketRows) => { let oldest = null
        for (const item of bucketRows) { const at = Date.parse(item.updatedAtRemote ?? '')
          if (Number.isNaN(at)) continue
          if (oldest === null || at < oldest) oldest = at
        }
        return oldest === null ? null : fmtAgo(new Date(oldest).toISOString())
      }
      const groupIds = mode === 'projects'
        ? order.slice().sort((a, b) => a.localeCompare(b))
        : order.slice().sort((a, b) => { const ia = REASON_ORDER.indexOf(a)
            const ib = REASON_ORDER.indexOf(b)
            const ra = ia === -1 ? 99 : ia
            const rb = ib === -1 ? 99 : ib
            return ra - rb
          })
      return groupIds.map((id) => { const bucketRows = buckets.get(id).slice()
        bucketRows.sort((a, b) => compareItems(a, b, sort))
        return { id, label: mode === 'projects' ? id : reasonMeta(id).label, rows: bucketRows, oldest: oldestOf(bucketRows), }
      })
    }

    /** Ordering: recommended (weight + waiting), updated, priority. */
    function compareItems(a, b, sort) { if (sort === 'updated') {
        return (Date.parse(b.updatedAtRemote ?? '') || 0) - (Date.parse(a.updatedAtRemote ?? '') || 0)
      }
      const weight = (item) => Number(item.priority) || REASON_WEIGHT[item.reason] || 10
      if (sort === 'priority') return weight(b) - weight(a)
      const delta = weight(b) - weight(a)
      if (delta !== 0) return delta
      return (Date.parse(a.updatedAtRemote ?? '') || 0) - (Date.parse(b.updatedAtRemote ?? '') || 0)
    }

    /** Quick focus chips shown in the top toolbar. */
    const QUICK_FILTERS = [ { id: 'all', label: 'common.all' }, { id: 'review', label: 'filters.needsReview' },
      { id: 'mine', label: 'filters.mine' }, { id: 'ci', label: 'filters.ciFailed' }, { id: 'snoozed', label: 'filters.snoozed' }, ]

    /** Does a row pass the quick focus chip? */
    function matchesQuick(item, quick) { switch (quick) { case 'review':
          return matchesMode(item, 'review')
        case 'mine':
          return matchesMode(item, 'work')
        case 'ci':
          return ciMeta(item.ci)?.tone === 'error'
        case 'snoozed':
          return String(item.localState ?? '') === 'snoozed'
        default:
          return true
      }
    }

    /** Three-column (or overlay) inbox workspace shared by the four views. */
    function InboxWorkspace(props) { const hub = props.hub
      const mode = props.mode
      const width = useViewportWidth()
      const twoCol = width < BREAK_TWO_COL
      const narrow = width < BREAK_NARROW
      const [collapsed, setCollapsed] = useState(() => new Set())
      const rows = hub.visibleRows
      const groups = useMemo(() => buildGroups(rows, mode, hub.sort, collapsed), [rows, mode, hub.sort, collapsed])
      const projects = useMemo(
        () => Array.from(new Set(hub.allRows.map((item) => item.project).filter(Boolean))).sort(),
        [hub.allRows],
      )
      const toggleGroup = useCallback((id) => { setCollapsed((prev) => { const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }, [])
      const filteredEmpty = hub.allRows.length > 0 && rows.length === 0
      const detailVisible = hub.selectedKey !== null && hub.selectedKey !== undefined
      const listFull = twoCol && detailVisible
      return h( 'div', { style: { flex: 1, minHeight: 0, display: 'flex', position: 'relative', overflow: 'hidden' } }, !listFull
          ? h(InboxList, { title: props.title, countLabel: props.countLabel, rows, groups, collapsed, onToggleGroup: toggleGroup, projects,
              filters: hub.filters, onFilters: hub.setFilters, sort: hub.sort, selectedKey: hub.selectedKey, selectedKeys: hub.selectedKeys,
              onSelect: hub.selectItem, onToggleCheck: hub.toggleSelect, onSelectAll: hub.selectAllVisible,
              onClearSelection: hub.clearChecked, onMarkAllRead: hub.markAllRead, onRefresh: hub.refreshAll, onBulk: hub.bulkAction,
              fullWidth: twoCol, docked: !twoCol, focusKey: hub.selectedKey,
              emptyIcon: filteredEmpty ? 'filter' : props.emptyIcon,
              emptyTitle: filteredEmpty ? tr('empty.filteredTitle') : props.emptyTitle,
              emptyBody: filteredEmpty ? tr('empty.filteredBody') : props.emptyBody,
              emptyActionLabel: filteredEmpty ? tr('filters.clear') : props.emptyActionLabel,
              emptyAction: filteredEmpty
                ? () => { hub.setFilters({ q: '', project: '', reason: '', state: '' }); hub.setQuick('all') }
                : props.emptyAction, })
          : null, detailVisible
          ? h( 'div', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: narrow ? 'column' : 'row',
                  background: T.bg, ...(twoCol
                    ? { position: 'absolute', inset: 0, zIndex: 5, background: T.bg }
                    : {}), }, }, h(DetailPane, { hub, item: hub.selectedItem, detail: hub.detail.data, turn: hub.turn,
                detailLoading: hub.detail.loading, detailError: hub.detail.error, narrow, onBack: twoCol ? hub.clearSelection : null,
                onOpenDrawer: () => hub.setDrawerOpen(true), }), hub.drawerOpen && !narrow
                ? h(AIDrawer, { hub, item: hub.selectedItem, turn: hub.turn, docked: true })
                : null, hub.drawerOpen && narrow
                ? h(AIDrawer, { hub, item: hub.selectedItem, turn: hub.turn, docked: false, fullScreen: true })
                : null, )
          : h( 'div', { style: { flex: '1 1 auto', minWidth: 0, display: narrow ? 'none' : 'flex', alignItems: 'center',
                  justifyContent: 'center', borderLeft: twoCol ? 'none' : `1px solid ${T.b1}`, }, }, h(EmptyState, { icon: 'inbox',
                title: tr('detail.placeholderTitle'), body: tr('detail.placeholderBody'), compact: false, }), ), )
    }

    /* ==================================================================== *
     * 8. Detail pane: overview, diff, discussions, pipelines
     * ==================================================================== */

    /** Normalize one diff file from GitLab's several possible shapes. */
    function normalizeFile(raw) { const path = pick(raw, 'newPath', 'new_path', 'path', 'file') ?? tr('common.unknown')
      const diff = typeof pick(raw, 'diff') === 'string' ? pick(raw, 'diff') : ''
      const normalizeCount = (value, isAdd) => { if (Number.isFinite(Number(value))) return Number(value)
        let count = 0
        for (const line of diff.split('\n')) { if (isAdd && line.startsWith('+') && !line.startsWith('+++')) count += 1
          if (!isAdd && line.startsWith('-') && !line.startsWith('---')) count += 1
        }
        return count
      }
      return { path, oldPath: pick(raw, 'oldPath', 'old_path') ?? path, isNew: pick(raw, 'newFile', 'new_file') === true,
        isDeleted: pick(raw, 'deletedFile', 'deleted_file') === true, isRenamed: pick(raw, 'renamedFile', 'renamed_file') === true, diff,
        additions: normalizeCount(pick(raw, 'additions'), true), deletions: normalizeCount(pick(raw, 'deletions'), false), }
    }

    /** Files out of `/item`'s `detail` payload, tolerating `diffs` vs `files`. */
    function detailFiles(detail) { const source = pick(detail, 'diffs', 'files')
      let rawList = []
      if (Array.isArray(source)) rawList = source
      else if (source !== null && source !== undefined) {
        rawList = Array.isArray(source.files) ? source.files : Array.isArray(source.changes) ? source.changes : []
      }
      return rawList.map(normalizeFile)
    }

    /** Parse a unified diff body into hunks with old/new line numbers. */
    function parseUnifiedDiff(text) { const hunks = []
      if (typeof text !== 'string' || text === '') return hunks
      let current = null
      let oldNo = 0
      let newNo = 0
      for (const rawLine of text.split('\n')) { const line = rawLine.replace(/\r$/, '')
        const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
        if (header !== null) { oldNo = Number(header[1])
          newNo = Number(header[2])
          current = { header: line, rows: [] }
          hunks.push(current)
          continue
        }
        if (current === null) continue
        if (line.startsWith('+')) { current.rows.push({ type: 'add', oldNo: null, newNo, text: line.slice(1) })
          newNo += 1
          continue
        }
        if (line.startsWith('-')) { current.rows.push({ type: 'del', oldNo, newNo: null, text: line.slice(1) })
          oldNo += 1
          continue
        }
        if (line.startsWith('\\')) continue
        current.rows.push({ type: 'ctx', oldNo, newNo, text: line.length > 0 ? line.slice(1) : '' })
        oldNo += 1
        newNo += 1
      }
      return hunks
    }

    /** Align deletions and additions into side-by-side row pairs. */
    function pairDiffRows(rows) { const pairs = []
      let index = 0
      while (index < rows.length) { const row = rows[index]
        if (row.type === 'ctx') { pairs.push({ left: row, right: row })
          index += 1
          continue
        }
        const dels = []
        const adds = []
        while (index < rows.length && rows[index].type === 'del') { dels.push(rows[index])
          index += 1
        }
        while (index < rows.length && rows[index].type === 'add') { adds.push(rows[index])
          index += 1
        }
        const span = Math.max(dels.length, adds.length)
        for (let offset = 0; offset < span; offset += 1) { pairs.push({ left: dels[offset] ?? null, right: adds[offset] ?? null })
        }
      }
      return pairs
    }

    /** One side of a two-column diff row. */
    function DiffSide(props) { const row = props.row
      const side = props.side
      const filler = { height: 18, background: T.skeleton, opacity: 0.25 }
      if (row === null || row === undefined) return h('div', { style: filler })
      const isAdd = row.type === 'add'
      const isDel = row.type === 'del'
      const background = side === 'left'
        ? isDel ? T.delBg : 'transparent'
        : isAdd ? T.addBg : 'transparent'
      const gutter = side === 'left'
        ? isDel ? T.delGutter : 'transparent'
        : isAdd ? T.addGutter : 'transparent'
      const marker = side === 'left'
        ? isDel ? '−' : ''
        : isAdd ? '+' : ''
      const markerColor = isAdd ? T.addMarker : T.delMarker
      const lineNo = side === 'left' ? row.oldNo : row.newNo
      return h( 'div', { style: { display: 'flex', minHeight: 18, background, minWidth: 0 } }, h( 'span', { style: { width: 40,
              flex: 'none', textAlign: 'right', paddingRight: 6, color: T.cap, background: gutter, fontSize: 11, lineHeight: '18px',
              userSelect: 'none', }, }, lineNo === null || lineNo === undefined ? '' : String(lineNo), ), h( 'span',
          { style: { width: 12, flex: 'none', textAlign: 'center', color: markerColor, fontSize: 11, lineHeight: '18px', userSelect: 'none' } },
          marker, ), h( 'span', { style: { flex: 1, minWidth: 0, paddingRight: 8,
              fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)', fontSize: 12, lineHeight: '18px',
              whiteSpace: 'pre', color: isDel || isAdd ? T.fg : T.fg2, overflow: 'hidden', textOverflow: 'ellipsis', }, title: row.text, },
          row.text === '' ? ' ' : row.text, ), )
    }

    /** File tree (190px) with change letter and diffstat. */
    function FileTree(props) { const groups = useMemo(() => { const map = new Map()
        props.files.forEach((file, index) => { const slash = file.path.lastIndexOf('/')
          const dir = slash === -1 ? '.' : file.path.slice(0, slash + 1)
          if (!map.has(dir)) map.set(dir, [])
          map.get(dir).push({ file, index })
        })
        return Array.from(map.entries())
      }, [props.files])
      return h( 'div', { className: 'dw-scroll', style: { width: FILE_TREE_WIDTH, flex: 'none', borderRight: `1px solid ${T.b1}`,
            overflowY: 'auto', minHeight: 0, padding: '6px 0', }, }, h( 'div',
          { style: { padding: '2px 10px 8px', display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('b', { style: { fontSize: 12 } }, tr('detail.files', { n: props.files.length })),
            h(Chip, { tone: 'neutral' }, `${tr('detail.adds', { n: props.totalAdds })} ${tr('detail.dels', { n: props.totalDels })}`), ),
          props.coverageNote !== null && props.coverageNote !== undefined
            ? h(Chip, { tone: 'warn' }, props.coverageNote)
            : null, ), groups.map(([dir, entries]) => h( 'div', { key: dir },
            h('div', { style: { padding: '4px 10px', fontSize: 11, color: T.cap, fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)' } }, dir),
            entries.map(({ file, index }) => h( 'button', { key: `${file.path}-${index}`, type: 'button',
                  onClick: () => props.onSelect(index), className: 'dw-click', title: file.path, style: { display: 'flex',
                    alignItems: 'center', gap: 6, width: '100%', padding: '4px 10px', border: 'none', borderRadius: R.xs,
                    background: props.selected === index ? T.selected : 'transparent', color: T.fg2, fontSize: 12, textAlign: 'left',
                    cursor: 'pointer', }, }, h( 'span', { style: { width: 14, flex: 'none', textAlign: 'center', fontSize: 10,
                      fontWeight: 600, color: file.isDeleted ? T.delMarker : file.isNew ? T.addMarker : T.warn, }, },
                  file.isDeleted ? 'D' : file.isNew ? 'A' : file.isRenamed ? 'R' : 'M', ), h( 'span',
                  { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  file.path.split('/').pop(), ), h( 'span', { style: { flex: 'none', display: 'inline-flex', gap: 4, fontSize: 10 } },
                  file.additions > 0 ? h('span', { style: { color: T.addMarker } }, `+${file.additions}`) : null,
                  file.deletions > 0 ? h('span', { style: { color: T.delMarker } }, `−${file.deletions}`) : null, ), ), ), ), ), )
    }

    /** Two-column hunk viewer for one file. */
    function DiffView(props) { const file = props.file
      const hunks = useMemo(() => parseUnifiedDiff(file === null || file === undefined ? '' : file.diff), [file])
      if (file === null || file === undefined || hunks.length === 0) {
        return h(EmptyState, { icon: 'file', title: tr('detail.noChanges'), body: file?.path ?? '', compact: true })
      }
      return h( 'div', { className: 'dw-scroll', style: { flex: 1, minHeight: 0, overflow: 'auto', background: T.bg }, },
        hunks.map((hunk, hunkIndex) => h( 'div', { key: hunkIndex }, h( 'div', { style: { padding: '4px 10px', background: T.code,
                  color: T.fg3, fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)', fontSize: 11,
                  position: 'sticky', top: 0, zIndex: 1, }, }, hunk.header, ), pairDiffRows(hunk.rows).map((pair, pairIndex) => h( 'div',
                { key: pairIndex, style: { display: 'grid', gridTemplateColumns: '1fr 1fr', minWidth: 0 } },
                h(DiffSide, { side: 'left', row: pair.left }),
                h('div', { style: { borderLeft: `1px solid ${T.b1}`, minWidth: 0 } }, h(DiffSide, { side: 'right', row: pair.right })), ),
            ), ), ), )
    }

    /** Normalize discussions from `/item`'s `detail.discussions`. */
    function normalizeDiscussions(detail) { const source = pick(detail, 'discussions', 'threads')
      let list = []
      if (Array.isArray(source)) list = source
      else if (source !== null && source !== undefined && Array.isArray(source.threads)) list = source.threads
      return list.map((thread, index) => { const notesRaw = Array.isArray(thread.notes) ? thread.notes : thread.notes ? [thread.notes] : []
        const file = pick(thread, 'file', 'path') ?? pick(thread.position, 'newPath', 'new_path', 'path') ?? ''
        return { id: thread.id ?? `thread-${index}`, file: typeof file === 'string' && file !== '' ? file : tr('list.noProject'),
          line: pick(thread, 'line') ?? pick(thread.position, 'newLine', 'new_line'), resolved: thread.resolved === true,
          notes: notesRaw.map((note) => ({ author: pick(note, 'author') ?? pick(note, 'author', 'username') ?? '—',
            body: pick(note, 'body', 'note') ?? '', createdAt: note.createdAt ?? note.created_at ?? null, })), }
      })
    }

    /** Discussion tab: grouped by file, unresolved first. */
    function DiscussionsView(props) { const threads = props.discussions
      if (threads.length === 0) return h(EmptyState, { icon: 'talk', title: tr('detail.noDiscussions'), compact: true })
      const sorted = threads.slice().sort((a, b) => Number(b.resolved) - Number(a.resolved))
      const groups = []
      for (const thread of sorted) { const last = groups[groups.length - 1]
        if (last !== undefined && last.file === thread.file) last.threads.push(thread)
        else groups.push({ file: thread.file, threads: [thread] })
      }
      return h( 'div',
        { className: 'dw-scroll', style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 12 } },
        groups.map((group) => h( 'div', { key: group.file, style: { display: 'flex', flexDirection: 'column', gap: 6 } }, h( 'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: T.fg3, fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)' } },
              h(Icon, { name: 'file', size: 12 }),
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group.file),
              h('span', { style: { flex: 1, height: 1, background: T.b1 } }), ), group.threads.map((thread) => h( Card,
                { key: thread.id, padding: 10, style: { opacity: thread.resolved ? 0.72 : 1 } }, h( 'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
                  h(Chip, { tone: thread.resolved ? 'neutral' : 'warn' }, thread.resolved ? tr('detail.resolved') : tr('detail.unresolved', { n: 1 })),
                  thread.line !== undefined && thread.line !== null
                    ? h('span', { style: { fontSize: 11, color: T.cap, fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)' } }, `:${thread.line}`)
                    : null, h('span', { style: { flex: 1 } }),
                  h('span', { style: { fontSize: 11, color: T.cap } }, `${thread.notes.length} ${LANG === 'en' ? 'notes' : '条'}`), ),
                thread.notes.map((note, noteIndex) => h( 'div',
                    { key: noteIndex, style: { display: 'flex', gap: 8, padding: '4px 0', borderTop: noteIndex === 0 ? 'none' : `1px solid ${T.b1}` } },
                    h('span', { style: { width: 20, height: 20, flex: 'none', borderRadius: '50%', background: T.tag, color: T.fg2,
                        fontSize: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', },
                    }, String(note.author).slice(0, 1).toUpperCase()), h( 'div',
                      { style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } }, h( 'div',
                        { style: { fontSize: 11, color: T.cap } }, `${note.author}${note.createdAt ? ` · ${fmtAgo(note.createdAt)}` : ''}`,
                      ),
                      h('div', { style: { fontSize: TYPE.xs, color: T.fg2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, note.body),
                    ), ), ), ), ), ), ), )
    }

    /** Pipelines tab (best-effort; the payload shape is GitLab's own). */
    function PipelinesView(props) { const pipelines = Array.isArray(props.pipelines) ? props.pipelines : []
      if (pipelines.length === 0) return h(EmptyState, { icon: 'play', title: LANG === 'en' ? 'No pipeline' : '没有流水线', compact: true })
      return h( 'div',
        { className: 'dw-scroll', style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 } },
        pipelines.map((pipeline, index) => { const status = String(pick(pipeline, 'status') ?? '').toLowerCase()
          const tone = ['success', 'succeeded', 'passed'].includes(status) ? 'ok' : ['failed', 'failure'].includes(status) ? 'error' : 'warn'
          const url = pick(pipeline, 'webUrl', 'web_url', 'url')
          return h( Card, { key: pick(pipeline, 'id') ?? index, padding: 10 }, h( 'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } }, h(Icon, { name: 'play', size: 12 }),
              h('span', { style: { fontWeight: 600, fontSize: TYPE.xs } }, `#${pick(pipeline, 'id') ?? '—'}`),
              h(Chip, { tone }, status || tr('common.unknown')), h('span', { style: { flex: 1 } }), pick(pipeline, 'duration') !== undefined
                ? h('span', { style: { fontSize: 11, color: T.cap } }, fmtDuration(Date.now() - Number(pipeline.duration) * 1000, Date.now()))
                : null, typeof url === 'string'
                ? h(Button, { size: 'sm', icon: 'ext', onClick: () => props.onOpen(url) }, tr('common.open'))
                : null, ),
            h('div', { style: { fontSize: 11, color: T.cap, marginTop: 4 } }, [pick(pipeline, 'ref'), pick(pipeline, 'sha') ? shortSha(pick(pipeline, 'sha')) : null].filter(Boolean).join(' · ')),
          )
        }), )
    }

    /** Overview tab: blocker, approvals, description. */
    function OverviewTab(props) { const item = props.item
      const mr = props.mr
      const approvals = item.approvals
      const ci = ciMeta(item.ci)
      const leftApprovals = approvals !== null && approvals !== undefined ? Number(approvals.left) || 0 : 0
      const blocker = (ci !== null && ci.tone === 'error') || leftApprovals > 0
      const description = pick(mr, 'description', 'body') ?? ''
      return h( 'div',
        { className: 'dw-scroll', style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 } },
        blocker
          ? h( 'div', { style: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', borderRadius: R.sm,
                  background: T.warnBg, border: `1px solid color-mix(in srgb, ${T.warn} 40%, transparent)`, color: T.warnLabel,
                  fontSize: TYPE.xs, }, }, h(Icon, { name: 'warn', size: 14 }), h( 'div', null,
                h('b', null, LANG === 'en' ? 'Not mergeable: ' : '暂不可合并：'), [
                  ci !== null && ci.tone === 'error' ? (LANG === 'en' ? 'CI failed' : 'CI 失败') : null, leftApprovals > 0
                    ? LANG === 'en'
                      ? `${leftApprovals} approvals still needed`
                      : `还差 ${leftApprovals} 个批准`
                    : null, ].filter(Boolean).join(LANG === 'en' ? ' and ' : '，'), ), )
          : null, h( Card, { padding: 12 }, h( 'div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
            h(Icon, { name: 'check', size: 14 }), h('b', { style: { fontSize: TYPE.xs } }, tr('detail.approvals')),
            h(Chip, { tone: leftApprovals === 0 ? 'ok' : 'neutral' },
              tr('detail.approvedOf', { approved: Number(approvals?.approved) || 0, of: Number(approvals?.of) || 0 })), ),
          h('div', { style: { fontSize: 12, color: T.fg2 } }, describeApprovals(item, approvals)), ), h( Card, { padding: 12 },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
            h('b', { style: { fontSize: TYPE.xs } }, LANG === 'en' ? 'Description' : '描述')), description === ''
            ? h('div', { style: { fontSize: 12, color: T.cap } }, tr('detail.noDescription'))
            : h( 'div',
                { style: { fontSize: TYPE.xs, color: T.fg2, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto' } },
                description, ), ), )
    }

    /** One line of approval detail; the payload has no reviewer list in the contract. */
    function describeApprovals(item, approvals) {
      if (approvals === null || approvals === undefined) return LANG === 'en' ? 'No approval data' : '没有审批数据'
      const approved = Number(approvals.approved) || 0
      const of = Number(approvals.of) || 0
      const left = Number(approvals.left) || 0
      if (LANG === 'en') {
        return `${approved} of ${of} approvals · ${left === 0 ? 'rule satisfied' : `${left} more needed`}${approvals.approvedByMe === true ? ' · you approved' : ''}`
      }
      return `${approved} / ${of} 已批准 · ${left === 0 ? '规则已满足' : `还需 ${left} 个`}${approvals.approvedByMe === true ? ' · 你已批准' : ''}`
    }

    /** Detail header: crumb, title, actions, meta, tabs. */
    function DetailHeader(props) { const item = props.item
      const mr = props.mr
      const reason = reasonMeta(item.reason)
      const ci = ciMeta(item.ci)
      const approvals = item.approvals
      const source = pick(mr, 'sourceBranch', 'source_branch')
      const target = pick(mr, 'targetBranch', 'target_branch')
      const mergeStatus = pick(mr, 'mergeStatus', 'merge_status') ?? item.mergeStatus
      const headSha = pick(mr, 'sha', 'headSha') ?? item.headSha
      return h( 'header',
        { style: { padding: '10px 16px 0', borderBottom: `1px solid ${T.b1}`, flex: 'none', display: 'flex', flexDirection: 'column', gap: 8 } },
        h( 'div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: T.cap, minWidth: 0 } },
          props.onBack !== null && props.onBack !== undefined
            ? h(Button, { size: 'sm', variant: 'text', icon: 'arrowLeft', onClick: props.onBack }, tr('common.back'))
            : null,
          h('span', { style: { fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.project ?? ''),
          h(Icon, { name: 'chev', size: 10 }),
          h('span', null, item.kind === 'issue' ? 'Issue' : (LANG === 'en' ? 'Merge request' : '合并请求')),
          h(Icon, { name: 'chev', size: 10 }),
          h('code', { style: { fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)' } }, item.subject ?? ''),
          h('span', { style: { color: T.cap } }, `· ${LANG === 'en' ? 'updated' : '更新'} ${fmtAgo(item.updatedAtRemote)}`), ), h( 'div',
          { style: { display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0 } },
          h('h1', { style: { margin: 0, fontSize: TYPE.base, lineHeight: '24px', fontWeight: 600, flex: 1, minWidth: 0 } }, item.title ?? tr('common.unknown')),
          h( 'div', { style: { display: 'flex', alignItems: 'center', gap: 6, flex: 'none' } },
            h(Button, { variant: 'primary', size: 'sm', icon: 'spark', onClick: props.onRunReview, disabled: props.reviewRunning === true }, tr('ai.run')),
            h(Button, { size: 'sm', icon: 'ext', onClick: () => props.onOpenExternal(item.link) }, tr('detail.openGitlab')),
            h(IconButton, { icon: 'eye', title: tr('ai.title'), onClick: props.onOpenDrawer, active: props.drawerOpen === true }), ), ), h(
          'div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0 } }, h('span', { style: {
              width: 18, height: 18, borderRadius: '50%', background: T.tag, color: T.fg2,
              fontSize: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', },
          }, String(item.author ?? '?').slice(0, 1).toUpperCase()),
          h('span', { style: { fontSize: 12, color: T.fg2 } }, item.author ?? tr('common.unknown')), source !== undefined
            ? h(Chip, { tone: 'neutral', title: String(source) }, String(source))
            : null, source !== undefined || target !== undefined ? h(Icon, { name: 'chev', size: 10, color: T.cap }) : null,
          target !== undefined ? h(Chip, { tone: 'neutral', title: String(target) }, String(target)) : null,
          h(Chip, { tone: reason.tone }, reason.label),
          ci !== null ? h(Chip, { tone: ci.tone, onClick: typeof pick(item.ci, 'url') === 'string' ? () => props.onOpenExternal(pick(item.ci, 'url')) : undefined }, ci.label) : null,
          mergeStatus !== undefined && mergeStatus !== '' ? h(Chip, { tone: 'neutral' }, String(mergeStatus)) : null,
          h(Chip, { tone: 'neutral' }, `${tr('detail.adds', { n: Number(item.additions) || 0 })} ${tr('detail.dels', { n: Number(item.deletions) || 0 })}`),
          approvals !== null && approvals !== undefined
            ? h(Chip, { tone: (Number(approvals.left) || 0) === 0 ? 'ok' : 'neutral' },
                tr('detail.approvedOf', { approved: Number(approvals.approved) || 0, of: Number(approvals.of) || 0 }))
            : null, (Array.isArray(item.labels) ? item.labels : []).slice(0, 4).map((label) =>
            h(Chip, { key: String(label), tone: 'neutral' }, String(label)), ),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: T.cap } }, tr('detail.head'),
            h('code', { style: { fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)' } }, shortSha(headSha)), ), ),
        h(Tabs, { active: props.tab, onChange: props.onTab, tabs: [ { id: 'overview', label: tr('detail.overview') },
            { id: 'changes', label: tr('detail.changes'), count: props.fileCount },
            { id: 'discussions', label: tr('detail.discussions'), count: props.discussionCount },
            { id: 'pipelines', label: tr('detail.pipelines') }, ], }), )
    }

    /** Right-hand detail column. */
    function DetailPane(props) { const { hub, item, detail, turn } = props
      const [fileIndex, setFileIndex] = useState(0)
      const files = useMemo(() => detailFiles(detail), [detail])
      const discussions = useMemo(() => normalizeDiscussions(detail), [detail])
      const mr = pick(detail, 'mr') ?? {}
      const tab = hub.detailTab
      const stale = isTurnStale(turn, item)
      const coverage = turn?.coverage
      const skipped = (Array.isArray(coverage?.skipped) ? coverage.skipped.length : 0) + (Array.isArray(coverage?.oversized) ? coverage.oversized.length : 0)

      useEffect(() => { setFileIndex(0)
      }, [item?.key])

      useEffect(() => { if (hub.focusFile === null || hub.focusFile === undefined) return
        const wanted = String(hub.focusFile)
        const index = files.findIndex((file) => file.path === wanted || file.path.endsWith(`/${wanted}`) || wanted.endsWith(`/${file.path}`))
        if (index >= 0) setFileIndex(index)
        hub.clearFocusFile()
      }, [hub.focusFile, files, hub.clearFocusFile])

      if (item === null || item === undefined) return null

      const totalAdds = files.reduce((sum, file) => sum + (Number(file.additions) || 0), 0)
      const totalDels = files.reduce((sum, file) => sum + (Number(file.deletions) || 0), 0)

      return h( 'section', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
            background: T.bg, borderLeft: props.onBack === null || props.onBack === undefined ? `1px solid ${T.b1}` : 'none', }, },
        h(DetailHeader, { item, mr, tab, onTab: hub.setDetailTab, onBack: props.onBack, onRunReview: () => hub.runReview(item.key),
          onOpenExternal: hub.openExternal, onOpenDrawer: props.onOpenDrawer, drawerOpen: hub.drawerOpen,
          reviewRunning: turnStateOf(turn, item) === 'running', fileCount: files.length,
          discussionCount: discussions.filter((thread) => thread.resolved !== true).length, }), stale
          ? h( 'div', { style: { padding: '8px 16px 0', flex: 'none' } }, h(Banner, { tone: 'warn', title: tr('detail.staleTitle'),
                body: tr('detail.staleBody', { old: shortSha(turn?.computedForHead), now: shortSha(item.headSha), }), }), )
          : null, props.detailError !== null && props.detailError !== undefined
          ? h( 'div', { style: { padding: '8px 16px 0', flex: 'none' } }, h(Banner, { tone: 'error', title: tr('detail.errorInline'),
                body: `${tr('banner.offline', { message: errorMessage(props.detailError) })}`,
                actions: h(Button, { size: 'sm', onClick: props.hub.reloadDetail }, tr('common.retry')), }), )
          : null, props.detailLoading === true && detail === null
          ? h('div', { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 8 } },
              h(Skeleton, { height: 14, width: '40%' }), h(Skeleton, { height: 12 }), h(Skeleton, { height: 12, width: '80%' }))
          : null, tab === 'overview'
          ? h(OverviewTab, { item, mr })
          : tab === 'changes'
            ? h( 'div', { style: { flex: 1, minHeight: 0, display: 'flex' } }, h( 'div',
                  { style: { display: 'flex', flexDirection: 'column', minHeight: 0, width: FILE_TREE_WIDTH, flex: 'none' } }, h(FileTree, {
                    files, selected: fileIndex, onSelect: setFileIndex, totalAdds, totalDels,
                    coverageNote: skipped > 0 ? tr('detail.coverageSkipped', { n: skipped }) : null, }), ), h( 'div',
                  { style: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' } }, h( 'div', { style: {
                        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                        borderBottom: `1px solid ${T.b1}`, flex: 'none', minWidth: 0, }, },
                    h(Chip, { tone: 'neutral' }, files[fileIndex] !== undefined
                      ? files[fileIndex].isDeleted ? 'D' : files[fileIndex].isNew ? 'A' : files[fileIndex].isRenamed ? 'R' : 'M'
                      : '—'), h('span', {
                      style: { fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)', fontSize: 11, color: T.fg2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      title: files[fileIndex]?.path, }, files[fileIndex]?.path ?? tr('common.unknown')), h('span', { style: { flex: 1 } }),
                    files[fileIndex] !== undefined
                      ? h(Button, { size: 'sm', icon: 'eye', onClick: () => hub.setHideGenerated((value) => !value) }, hub.hideGenerated === true ? (LANG === 'en' ? 'Generated shown' : '含生成代码') : (LANG === 'en' ? 'Hide generated' : '隐藏生成代码'))
                      : null, ), h(DiffView, { file: files[fileIndex] }), ), )
            : tab === 'discussions'
              ? h(DiscussionsView, { discussions })
              : h(PipelinesView, { pipelines: pick(detail, 'pipelines') ?? [], onOpen: hub.openExternal }), )
    }

    /* ==================================================================== *
     * 9. AI drawer
     * ==================================================================== */

    /** Generated-file patterns the diff can hide on demand (DESIGN §4.3). */
    const GENERATED_PATTERNS = [/\.lock$/i, /(^|\/)dist\//i, /\.min\.(js|css)$/i, /(^|\/)vendor\//i, /(^|\/)node_modules\//i]

    /** Should this path be hidden by the "hide generated" toggle? */
    function isGeneratedPath(path) { const value = String(path ?? '')
      return GENERATED_PATTERNS.some((pattern) => pattern.test(value))
    }

    /** Turn state → drawer badge state. */
    function turnStateOf(turn, item) { if (turn === null || turn === undefined) return 'idle'
      const state = String(turn.state ?? '')
      if (state === 'running' || state === 'queued') return 'running'
      if (state === 'failed' || state === 'cancelled' || state === 'interrupted') return 'failed'
      if (state === 'done' || state === 'succeeded') return 'done'
      if (turn.verdict !== undefined || (Array.isArray(turn.findings) && turn.findings.length > 0)) return 'done'
      if (item !== null && item !== undefined && item.lastTurn !== null && item.lastTurn !== undefined) return 'done'
      return state === '' ? 'idle' : 'done'
    }

    /** Does the turn's computed head differ from the item's current head? */
    function isTurnStale(turn, item) { if (turn === null || turn === undefined || item === null || item === undefined) return false
      const computed = pick(turn, 'computedForHead', 'computedForHeadSha')
      const head = pick(item, 'headSha')
      if (typeof computed !== 'string' || typeof head !== 'string') return false
      if (computed === '' || head === '') return false
      return computed !== head
    }

    /** Verdict label + tone. */
    function verdictMeta(verdict) { const value = String(verdict ?? '')
      if (value === 'approve-suggested' || value === 'approve') return { label: tr('ai.verdict.approve'), tone: 'ok' }
      if (value === 'comments-only') return { label: tr('ai.verdict.comments'), tone: 'brand' }
      if (value === 'request-changes-suggested' || value === 'request-changes') return { label: tr('ai.verdict.requestChanges'), tone: 'warn' }
      return { label: tr('ai.verdict.unknown'), tone: 'neutral' }
    }

    /** Findings from a turn or from a stamped item. */
    function normalizeFindings(turn, item) {
      const raw = Array.isArray(turn?.findings) ? turn.findings : Array.isArray(item?.findings) ? item.findings : []
      return raw.map((finding, index) => ({ id: finding.id ?? `${finding.file ?? 'x'}:${finding.line ?? index}:${index}`,
        severity: String(finding.severity ?? 'medium').toLowerCase(), file: finding.file ?? '', line: finding.line,
        title: finding.title ?? '', evidence: finding.evidence ?? '', suggestion: finding.suggestion ?? '',
        adopted: finding.adopted ?? 'pending', }))
    }

    /** Severity → chip tone. */
    function severityTone(severity) { switch (severity) { case 'blocker':
        case 'high':
          return 'error'
        case 'medium':
          return 'warn'
        default:
          return 'neutral'
      }
    }

    /** One finding card. */
    function FindingCard(props) { const finding = props.finding
      return h( Card, { padding: 10, style: { display: 'flex', flexDirection: 'column', gap: 6 } }, h( 'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h(Chip, { tone: severityTone(finding.severity) }, finding.severity.toUpperCase().slice(0, 3)),
          h('span', { style: { fontSize: TYPE.xs, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, finding.title),
          h('span', { style: { fontSize: 10, color: T.cap, fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)',
              flex: 'none', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', },
            title: `${finding.file}:${finding.line ?? ''}`,
          }, `${String(finding.file).split('/').pop()}${finding.line !== undefined && finding.line !== null ? `:${finding.line}` : ''}`), ),
        finding.evidence !== ''
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('span', { style: { fontSize: 10, color: T.cap } }, tr('ai.evidence')),
              h(CodeBlock, { maxHeight: 110, inline: true }, finding.evidence))
          : null, finding.suggestion !== ''
          ? h('div', { style: { fontSize: 12, color: T.fg2, lineHeight: '17px' } }, h('b', { style: { color: T.fg } }, tr('ai.suggestion')),
              ` ${finding.suggestion}`)
          : null, h( 'div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 } },
          finding.adopted === 'adopted' ? h(Chip, { tone: 'ok' }, LANG === 'en' ? 'In comment' : '已加入评论') : null,
          finding.adopted === 'ignored' ? h(Chip, { tone: 'neutral' }, LANG === 'en' ? 'Ignored' : '已忽略') : null,
          h('span', { style: { flex: 1 } }),
          h(Button, { size: 'sm', variant: 'subtle', icon: 'link', disabled: finding.adopted !== 'pending', onClick: () => props.onAdopt(finding) }, tr('ai.addToComment')),
          h(Button, { size: 'sm', variant: 'ghost', disabled: finding.adopted !== 'pending', onClick: () => props.onIgnore(finding) }, tr('ai.ignoreFinding')),
          h(Button, { size: 'sm', variant: 'ghost', icon: 'eye', disabled: finding.file === '', onClick: () => props.onJump(finding) }, tr('ai.jumpToFile')),
        ), )
    }

    /** AI review drawer: idle / running / done / failed / stale. */
    function AIDrawer(props) { const { hub, item, turn } = props
      const [question, setQuestion] = useState('')
      const [confirmOpen, setConfirmOpen] = useState(false)
      const state = turnStateOf(turn, item)
      const stale = isTurnStale(turn, item)
      const findings = useMemo(() => normalizeFindings(turn, item), [turn, item])
      const counts = useMemo(() => { const result = { blocker: 0, high: 0, medium: 0, low: 0 }
        for (const finding of findings) { if (result[finding.severity] !== undefined) result[finding.severity] += 1
        }
        return result
      }, [findings])
      const verdict = verdictMeta(turn?.verdict ?? item?.lastVerdict)
      const coverage = turn?.coverage
      const skipped = (Array.isArray(coverage?.skipped) ? coverage.skipped.length : 0) + (Array.isArray(coverage?.oversized) ? coverage.oversized.length : 0)
      const draftBody = hub.draft?.body ?? ''
      const writesAllowed = hub.settings?.allowWrites !== false
      const canPublish = draftBody !== '' && stale !== true && writesAllowed

      useEffect(() => { setQuestion('')
        setConfirmOpen(false)
      }, [item?.key])

      if (item === null || item === undefined) return null

      const badgeState = stale === true && state === 'done' ? 'stale' : state

      return h( 'aside', { 'aria-label': tr('ai.title'), className: 'dw-scroll', style: {
            width: props.fullScreen === true ? '100%' : DRAWER_WIDTH, maxWidth: props.fullScreen === true ? 'none' : DRAWER_WIDTH,
            flex: props.fullScreen === true ? '1 1 auto' : `0 0 ${DRAWER_WIDTH}px`,
            borderLeft: props.docked === true ? `1px solid ${T.b2}` : 'none', background: T.l2, display: 'flex', flexDirection: 'column',
            minHeight: 0, minWidth: 0, ...(props.fullScreen === true ? { position: 'absolute', inset: 0, zIndex: 10 } : {}), }, }, h(
          'header',
          { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${T.b1}`, flex: 'none' } },
          h(Icon, { name: 'spark', size: 14, color: T.brand }),
          h('span', { style: { fontSize: TYPE.xs, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            `${tr('ai.title')} · ${tr(`ai.state.${badgeState}`)}`),
          turn !== null && turn !== undefined && turn.templateVersion !== undefined
            ? h(Chip, { tone: 'neutral' }, `v${turn.templateVersion}`)
            : null, h(IconButton, { icon: 'x', title: tr('ai.drawerClose'), onClick: () => hub.setDrawerOpen(false) }), ), h( 'div',
          { className: 'dw-scroll', style: { flex: 1, minHeight: 0, overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 } },
          state === 'idle'
            ? h(EmptyState, { icon: 'spark', title: tr('ai.empty'), body: tr('ai.emptyHint'), actionLabel: tr('ai.run'),
                onAction: () => hub.runReview(item.key), })
            : null, state === 'running'
            ? h( 'div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, h(Card, { padding: 10 },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } }, h(Spinner, null),
                    h('span', { style: { fontSize: TYPE.xs, fontWeight: 600 } }, tr('ai.state.running')), ),
                  h('div', { style: { fontSize: 11, color: T.fg2 } }, tr('ai.runningHint', { mode: String(turn?.mode ?? 'session') })), ),
                h(Skeleton, { height: 56 }), h(Skeleton, { height: 70 }), h(Skeleton, { height: 48 }), )
            : null, state === 'failed'
            ? h(Banner, { tone: 'error', title: tr('ai.failed'), body: String(turn?.error ?? tr('common.unknown')),
                actions: h(Button, { size: 'sm', onClick: () => hub.runReview(item.key) }, tr('ai.rerun')), })
            : null, state === 'done'
            ? h( 'div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, h( Card,
                  { padding: 10, style: { opacity: stale === true ? 0.6 : 1 } },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
                    h(Chip, { tone: verdict.tone }, verdict.label), h('span', { style: { flex: 1 } }),
                    turn?.finishedAt !== undefined ? h('span', { style: { fontSize: 11, color: T.cap } }, fmtAgo(turn.finishedAt)) : null,
                  ), h('div', { style: { fontSize: 10, color: T.cap, marginBottom: 4 } }, tr('ai.riskSummary')), h( 'div',
                    { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, SEVERITY_ORDER.map((severity) =>
                      h(Chip, { key: severity, tone: severityTone(severity) + (counts[severity] === 0 ? '' : '') },
                        `${tr(`ai.severity.${severity}`)} ${counts[severity]}`), ), ), findings.length === 0
                    ? h('div', { style: { fontSize: 12, color: T.fg2, marginTop: 8 } }, LANG === 'en' ? 'No findings — nothing blocking.' : '没有发现问题。')
                    : null, ), h('div', { style: { fontSize: 11, color: T.cap } }, tr('ai.findings', { n: findings.length })),
                findings.map((finding) => h(FindingCard, { key: finding.id, finding, onAdopt: (value) => hub.adoptFinding(item.key, value),
                    onIgnore: (value) => hub.ignoreFinding(item.key, value), onJump: (value) => hub.jumpToFile(value), }), ), skipped > 0
                  ? h(Banner, { tone: 'warn', title: tr('ai.coverage'), body: tr('detail.coverageSkipped', { n: skipped }) })
                  : null, turn?.mode === 'heuristic'
                  ? h(Banner, { tone: 'info', title: tr('ai.heuristicNote'), body: String(turn?.note ?? '') })
                  : null, stale
                  ? h(Banner, { tone: 'warn', title: tr('detail.staleTitle'),
                      body: tr('detail.staleBody', { old: shortSha(turn?.computedForHead), now: shortSha(item.headSha) }), })
                  : null, )
            : null, ), h( 'div',
          { style: { borderTop: `1px solid ${T.b1}`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8, flex: 'none', background: T.l2 } },
          h( 'div', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, h(Icon, { name: 'spark', size: 12, color: T.fg3 }),
            h(TextInput, { value: question, placeholder: tr('ai.followupPlaceholder'), onChange: setQuestion, onKeyDown: (event) => {
                if (event.key !== 'Enter' || question.trim() === '') return
                event.preventDefault()
                void hub.followUp(item.key, question.trim()).then(() => setQuestion(''))
              }, style: { minHeight: 28, fontSize: 12 }, }), h(Button, { size: 'sm', variant: 'subtle', disabled: question.trim() === '',
              onClick: () => { void hub.followUp(item.key, question.trim()).then(() => setQuestion(''))
              }, }, tr('ai.followupSend')), ), draftBody !== ''
            ? h( 'div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                h('span', { style: { fontSize: 10, color: T.cap } }, tr('ai.draftBody')), h(CodeBlock, { maxHeight: 120 }, draftBody), )
            : null, h( 'div', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, draftBody === ''
              ? h(Button, { variant: 'primary', size: 'sm', icon: 'edit', disabled: hub.drafting === true, onClick: () => hub.draftComment(item.key) }, tr('ai.draft'))
              : h(Button, { variant: 'ghost', size: 'sm', disabled: hub.drafting === true, onClick: () => hub.draftComment(item.key) }, tr('ai.draft')),
            h('span', { style: { flex: 1 } }), draftBody !== ''
              ? h(Button, { variant: 'primary', size: 'sm', icon: 'link', disabled: canPublish !== true,
                  title: canPublish === true ? undefined : tr('toast.publishBlocked'), onClick: () => setConfirmOpen(true),
                }, tr('ai.publish'))
              : null, ), writesAllowed !== true
            ? h('span', { style: { fontSize: 10, color: T.cap } }, tr('settings.allowWritesHint'))
            : null, ), confirmOpen
          ? h(ConfirmDialog, { title: tr('ai.confirmTitle'), body: tr('ai.confirmBody', { subject: item.subject ?? item.key }),
              confirmLabel: tr('ai.publish'), cancelLabel: tr('common.cancel'), onCancel: () => setConfirmOpen(false), onConfirm: () => {
                setConfirmOpen(false)
                void hub.publishComment(item, draftBody)
              }, })
          : null, )
    }

    /* ==================================================================== *
     * 10. Jobs & automation
     * ==================================================================== */

    /** Jobs page polls runs fast while the server reports a running job. */
    function useJobsData(hub) { const jobs = usePoll({ path: ROUTE.jobs, pollMs: POLL_JOBS_MS, paused: hub.paused, onAuth: hub.onAuth })
      const running = Number(pick(pick(hub.status, 'nav'), 'running')) || 0
      const runs = usePoll({ path: ROUTE.runs, pollMs: running > 0 ? POLL_RUN_MS : POLL_JOBS_MS, paused: hub.paused, onAuth: hub.onAuth, })
      return { jobs, runs }
    }

    /** Per-job aggregate derived from the run list (no aggregate route in §7). */
    function jobStats(runs, jobId) { const own = runs.filter((run) => run.jobId === jobId)
      const succeeded = own.filter((run) => run.state === 'succeeded').length
      const finished = own.filter((run) => run.finishedAt !== undefined || run.state === 'succeeded' || run.state === 'failed').length
      const durations = own
        .filter((run) => run.startedAt && run.finishedAt)
        .map((run) => Date.parse(run.finishedAt) - Date.parse(run.startedAt))
        .filter((value) => Number.isFinite(value) && value >= 0)
      const avg = durations.length === 0 ? null : durations.reduce((sum, value) => sum + value, 0) / durations.length
      const last = own
        .slice()
        .sort((a, b) => (Date.parse(b.startedAt ?? b.scheduledAt ?? '') || 0) - (Date.parse(a.startedAt ?? a.scheduledAt ?? '') || 0))[0]
      return { total: own.length, rate: finished === 0 ? null : succeeded / finished, avg, last: last ?? null, }
    }

    /** Run state → chip tone. */
    function runStateTone(state) { switch (String(state)) { case 'succeeded':
          return 'ok'
        case 'failed':
          return 'error'
        case 'running':
        case 'queued':
          return 'brand'
        case 'cancelled':
        case 'interrupted':
        case 'skipped':
          return 'neutral'
        default:
          return 'neutral'
      }
    }

    /** Job trigger summary line. */
    function jobTriggerLabel(job) { const trigger = job.trigger ?? {}
      const kind = String(trigger.kind ?? 'manual')
      if (kind === 'cron') { const cron = describeCron(trigger.cron)
        const tz = trigger.tz ? ` · ${trigger.tz}` : ''
        const catchUp = trigger.catchUp === 'run-once' ? (LANG === 'en' ? ' · catch up once' : ' · 补一次') : ''
        return `${cron}${tz}${catchUp}`
      }
      if (kind === 'event') { const events = Array.isArray(trigger.events) ? trigger.events : []
        return events.length > 0 ? `event · ${events.slice(0, 3).join(', ')}` : 'event'
      }
      if (kind === 'after') { const ids = Array.isArray(trigger.after?.jobIds) ? trigger.after.jobIds : []
        return `after · ${ids.slice(0, 2).join(', ') || '—'} (hops ≤ 8)`
      }
      return tr('jobs.triggerKind.manual')
    }

    /** Job card in the library tab. */
    function JobCard(props) { const job = props.job
      const stats = props.stats
      const enabled = job.enabled !== false
      return h( Card, { padding: 12, style: { display: 'flex', flexDirection: 'column', gap: 8, opacity: enabled ? 1 : 0.72 } }, h( 'div',
          { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } }, h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              h('b', { style: { fontSize: TYPE.s, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, job.name ?? tr('common.unknown')),
              job.builtin === true ? h(Chip, { tone: 'neutral' }, LANG === 'en' ? 'Built-in' : '内置') : null, ),
            job.description ? h('div', { style: { fontSize: 12, color: T.fg2, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, job.description) : null,
          ), h(Switch, { checked: enabled, label: tr('jobs.enabled'), onClick: () => props.onToggle(job), }), ),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 12, color: T.fg3 } },
          h('span', null, `⏱ ${jobTriggerLabel(job)}`),
          h('span', null, `${tr('jobs.lastRun')}：${stats.last ? `${fmtDateTime(stats.last.finishedAt ?? stats.last.startedAt)} · ${tr(`jobs.state.${stats.last.state}`)}` : tr('common.never')}`),
          stats.rate !== null ? h('span', null, `${tr('jobs.successRate')} ${Math.round(stats.rate * 100)}%`) : null,
          stats.avg !== null ? h('span', null, `${tr('jobs.avgDuration')} ${fmtDuration(Date.now() - stats.avg, Date.now())}`) : null, ), h(
          'div', { style: { display: 'flex', alignItems: 'center', gap: 6, paddingTop: 8, borderTop: `1px solid ${T.b1}` } },
          h(Chip, { tone: 'brand' }, String(job.executor?.kind ?? 'session')),
          job.executor?.access ? h(Chip, { tone: 'neutral' }, String(job.executor.access)) : null,
          job.output?.kind ? h(Chip, { tone: 'neutral' }, String(job.output.kind)) : null, h('span', { style: { flex: 1 } }),
          h(Button, { size: 'sm', icon: 'play', onClick: () => props.onRun(job) }, tr('jobs.runNow')), h(Menu, { items: [
              { id: 'edit', label: tr('common.edit'), icon: 'edit', onSelect: () => props.onEdit(job) },
              { id: 'copy', label: tr('common.duplicate'), icon: 'copy', onSelect: () => props.onDuplicate(job) },
              { id: 'toggle', label: enabled ? tr('common.disable') : tr('common.enable'), icon: 'pause', onSelect: () => props.onToggle(job) },
              { id: 'audit', label: tr('common.audit'), icon: 'hist', onSelect: () => props.onAudit(job.id) },
              { id: 'delete', label: tr('common.delete'), icon: 'trash', danger: true, onSelect: () => props.onDelete(job) }, ], }), ), )
    }

    /** Parameters dialog shown before a manual run when a job declares params. */
    function JobParamsDialog(props) { const [values, setValues] = useState(() => { const initial = {}
        for (const param of props.job.params ?? []) initial[param.key] = param.default !== undefined && param.default !== null ? param.default : param.type === 'bool' ? false : ''
        return initial
      })
      return h( Modal, { title: props.job.name, width: 420, onClose: props.onCancel, footer: [
            h(Button, { key: 'cancel', onClick: props.onCancel }, tr('common.cancel')),
            h(Button, { key: 'run', variant: 'primary', onClick: () => props.onRun(values) }, tr('jobs.runNow')), ], }, h( 'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, (props.job.params ?? []).map((param) => h(Field, {
              key: param.key, label: param.key, hint: param.type, children: param.type === 'bool'
                ? h(Switch, { checked: values[param.key] === true, onClick: () => setValues((prev) => ({ ...prev, [param.key]: prev[param.key] !== true })) })
                : param.type === 'enum'
                  ? h(SelectInput, { value: String(values[param.key] ?? ''),
                      options: (param.values ?? []).map((value) => ({ value: String(value), label: String(value) })),
                      onChange: (next) => setValues((prev) => ({ ...prev, [param.key]: next })), })
                  : h(TextInput, { value: String(values[param.key] ?? ''),
                      onChange: (next) => setValues((prev) => ({ ...prev, [param.key]: next })), }), }), ), ), )
    }

    /** Audit replay dialog (`GET /audit?key=`). */
    function AuditDialog(props) {
      const query = useMemo(() => ({ key: props.subjectKey }), [props.subjectKey])
      const audit = usePoll({ path: ROUTE.audit, query, pollMs: 0, enabled: true, onAuth: props.onAuth })
      const entries = Array.isArray(audit.data?.entries) ? audit.data.entries : []
      return h( Modal, { title: `${tr('jobs.auditTitle')} · ${props.title}`, width: 640, onClose: props.onClose,
          footer: h(Button, { onClick: props.onClose }, tr('common.close')), }, audit.loading && entries.length === 0
          ? h(Skeleton, { height: 80 })
          : entries.length === 0
            ? h(EmptyState, { icon: 'hist', title: tr('jobs.auditEmpty'), compact: true })
            : h( 'div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, entries.map((entry, index) => h( 'div',
                    { key: entry.id ?? index, style: { display: 'flex', gap: 8, padding: '6px 0', borderTop: index === 0 ? 'none' : `1px solid ${T.b1}`, fontSize: 12 } },
                    h('span', { style: { flex: 'none', color: T.cap, fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)' } }, fmtDateTime(entry.at)),
                    h('span', { style: { flex: 'none', color: T.fg2, minWidth: 56 } }, entry.kind ?? ''),
                    h('span', { style: { flex: 'none', color: T.fg3, minWidth: 64 } }, entry.actor ?? ''),
                    h('span', { style: { flex: 1, minWidth: 0, color: T.fg2, wordBreak: 'break-word' } }, `${entry.subject ?? ''} ${entry.detail ?? ''}`.trim()),
                  ), ), ), )
    }

    /** Numeric input helper for the job form. */
    function NumberInput(props) { return h(TextInput, { type: 'number',
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        onChange: (value) => props.onChange(value === '' ? undefined : Number(value)), style: props.style, })
    }

    /** Segmented control for enum fields. */
    function Segmented(props) { return h( 'div',
        { style: { display: 'inline-flex', gap: 2, padding: 2, borderRadius: R.sm, background: T.l2, flexWrap: 'wrap' } },
        props.options.map((option) => h( 'button', { key: option.value, type: 'button', onClick: () => props.onChange(option.value),
              style: { padding: '3px 8px', borderRadius: R.xs, border: 'none',
                background: props.value === option.value ? T.l1 : 'transparent', color: props.value === option.value ? T.fg : T.fg2,
                fontSize: 12, cursor: 'pointer', }, }, option.label, ), ), )
    }

    /** Section heading inside the job form. */
    function FormSection(props) { return h( 'div',
        { style: { gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, paddingTop: 10, borderTop: `1px solid ${T.b1}` } },
        h('b', { style: { fontSize: TYPE.xs, color: T.fg } }, props.label),
        props.hint ? h('span', { style: { fontSize: 11, color: T.cap } }, props.hint) : null, )
    }

    /** Build a blank job draft with the contract's defaults. */
    function blankJob() { return { name: '', description: '', icon: 'clock', enabled: true, version: 1,
        trigger: { kind: 'manual', cron: '0 9 * * 1-5', tz: 'Asia/Shanghai', catchUp: 'skip', events: [], after: { jobIds: [], status: 'success' } },
        executor: { kind: 'session', template: '', skill: '', prompt: '', cwd: '', access: 'read-only' }, params: [], inputs: [],
        output: { kind: 'artifact', path: '', notify: 'card' },
        policy: { concurrency: 1, laneKey: '', timeoutMin: 10, retry: { max: 1, backoff: '5m' }, quietHours: [], maxRunsPerDay: 2 }, }
    }

    /** Six-section job form modal (DESIGN §9.5). */
    function JobFormModal(props) { const [draft, setDraft] = useState(() => props.initial ?? blankJob())
      const [error, setError] = useState('')
      const patch = (updater) => setDraft((prev) => updater(prev))
      const setField = (key, value) => patch((prev) => ({ ...prev, [key]: value }))
      const setTrigger = (key, value) => patch((prev) => ({ ...prev, trigger: { ...prev.trigger, [key]: value } }))
      const setExecutor = (key, value) => patch((prev) => ({ ...prev, executor: { ...prev.executor, [key]: value } }))
      const setOutput = (key, value) => patch((prev) => ({ ...prev, output: { ...prev.output, [key]: value } }))
      const setPolicy = (key, value) => patch((prev) => ({ ...prev, policy: { ...prev.policy, [key]: value } }))

      const validate = () => { if (String(draft.name).trim() === '') return tr('jobs.form.required')
        if (draft.trigger.kind === 'cron' && String(draft.trigger.cron).trim().split(/\s+/).filter(Boolean).length !== 5) {
          return tr('jobs.form.cronInvalid')
        }
        return ''
      }

      const submit = (dry) => { const message = validate()
        if (message !== '') { setError(message)
          return
        }
        setError('')
        props.onSubmit({ ...draft, name: String(draft.name).trim() }, dry === true)
      }

      const triggerKind = String(draft.trigger.kind ?? 'manual')
      const executorKind = String(draft.executor.kind ?? 'session')

      return h( Modal, { title: props.mode === 'edit' ? tr('jobs.edit') : tr('jobs.new'), width: 760, onClose: props.onCancel, footer: [
            h('span', { key: 'hint', style: { flex: 1, fontSize: 11, color: T.cap } }, tr('jobs.pausedHint')),
            h(Button, { key: 'cancel', onClick: props.onCancel }, tr('common.cancel')),
            h(Button, { key: 'dry', icon: 'play', onClick: () => submit(true) }, tr('jobs.form.dryHint') === '' ? tr('common.dryRun') : tr('common.dryRun')),
            h(Button, { key: 'save', variant: 'primary', onClick: () => submit(false) }, tr('common.save')), ], }, h( 'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, error !== '' ? h(Banner, { tone: 'error', title: error }) : null,
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
            h(FormSection, { label: tr('jobs.form.basic') }),
            h(Field, { label: tr('jobs.form.name'), children: h(TextInput, { value: draft.name, onChange: (value) => setField('name', value) }) }),
            h(Field, { label: tr('jobs.form.icon'), hint: 'icon id', children: h(TextInput, { value: draft.icon ?? '', onChange: (value) => setField('icon', value) }) }),
            h(Field, { label: tr('jobs.form.description'), children: h(TextInput, { value: draft.description ?? '', onChange: (value) => setField('description', value) }) }),
            h(Field, { label: tr('jobs.enabled'), inline: true,
              children: h(Switch, { checked: draft.enabled !== false, label: tr('jobs.enabled'), onClick: () => setField('enabled', draft.enabled === false) }),
            }),

            h(FormSection, { label: tr('jobs.form.trigger') }), h(Field, { label: tr('jobs.form.trigger'), children: h(Segmented, {
                value: triggerKind, onChange: (value) => setTrigger('kind', value), options: [
                  { value: 'manual', label: tr('jobs.triggerKind.manual') }, { value: 'cron', label: tr('jobs.triggerKind.cron') },
                  { value: 'event', label: tr('jobs.triggerKind.event') }, { value: 'after', label: tr('jobs.triggerKind.after') }, ], }),
            }), triggerKind === 'cron'
              ? h( 'div', { style: { gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 } },
                  h(Field, { label: tr('jobs.form.cron'), hint: '0 18 * * 5', children: h(TextInput, { value: draft.trigger.cron ?? '', onChange: (value) => setTrigger('cron', value) }) }),
                  h(Field, { label: tr('jobs.form.tz'), children: h(TextInput, { value: draft.trigger.tz ?? '', onChange: (value) => setTrigger('tz', value) }) }),
                  h(Field, { label: tr('jobs.form.catchUp'), children: h(SelectInput, { value: draft.trigger.catchUp ?? 'skip', options: [
                        { value: 'skip', label: LANG === 'en' ? 'Skip' : '跳过' },
                        { value: 'run-once', label: LANG === 'en' ? 'Run once' : '补一次' }, ],
                      onChange: (value) => setTrigger('catchUp', value), }), }), )
              : null, triggerKind === 'event'
              ? h(Field, { label: tr('jobs.form.event'), hint: LANG === 'en' ? 'one per line' : '每行一个', children: h(TextArea, { rows: 3,
                    value: (draft.trigger.events ?? []).join('\n'), onChange: (value) => setTrigger('events', splitLines(value)), }), })
              : null, triggerKind === 'after'
              ? h( 'div', { style: { gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 } }, h(Field, {
                    label: tr('jobs.form.after'), hint: LANG === 'en' ? 'job ids, one per line' : '任务 id，每行一个', children: h(TextArea, {
                      rows: 3, value: ((draft.trigger.after ?? {}).jobIds ?? []).join('\n'),
                      onChange: (value) => setTrigger('after', { ...(draft.trigger.after ?? {}), jobIds: splitLines(value) }), }), }),
                  h(Field, { label: tr('jobs.form.afterStatus'), children: h(SelectInput, { value: draft.trigger.after?.status ?? 'success',
                      options: [ { value: 'success', label: tr('jobs.state.succeeded') },
                        { value: 'failure', label: tr('jobs.state.failed') }, ],
                      onChange: (value) => setTrigger('after', { ...(draft.trigger.after ?? {}), status: value }), }), }), )
              : null,

            h(FormSection, { label: tr('jobs.form.executor') }), h(Field, { label: tr('jobs.executor'), children: h(Segmented, {
                value: executorKind, onChange: (value) => setExecutor('kind', value), options: [ { value: 'session', label: 'session' },
                  { value: 'headless', label: 'headless' }, { value: 'command', label: 'command' }, ], }), }), h(Field, {
              label: tr('jobs.form.access'), children: h(Segmented, { value: draft.executor.access ?? 'read-only',
                onChange: (value) => setExecutor('access', value), options: [ { value: 'read-only', label: tr('jobs.form.readOnly') },
                  { value: 'workspace-write', label: tr('jobs.form.write') }, ], }), }),
            h(Field, { label: tr('jobs.form.template'), hint: 'template id', children: h(TextInput, { value: draft.executor.template ?? '', onChange: (value) => setExecutor('template', value) }) }),
            h(Field, { label: tr('jobs.form.cwd'), hint: '~/notes', children: h(TextInput, { value: draft.executor.cwd ?? '', onChange: (value) => setExecutor('cwd', value) }) }),
            h('div', { style: { gridColumn: '1 / -1' } },
              h(Field, { label: tr('jobs.form.prompt'), children: h(TextArea, { rows: 3, value: draft.executor.prompt ?? '', onChange: (value) => setExecutor('prompt', value) }) }),
            ),

            h(FormSection, { label: tr('jobs.form.params') }),
            h('div', { style: { gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 6 } },
              (draft.params ?? []).length === 0
                ? h('span', { style: { fontSize: 12, color: T.cap } }, tr('jobs.form.noParams'))
                : (draft.params ?? []).map((param, index) => h( 'div',
                      { key: `param-${index}`, style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto auto', gap: 6, alignItems: 'center' } },
                      h(TextInput, { value: param.key ?? '', placeholder: 'key', onChange: (value) => patch((prev) => {
                          const params = (prev.params ?? []).slice()
                          params[index] = { ...params[index], key: value }
                          return { ...prev, params }
                        }), }), h(SelectInput, { value: param.type ?? 'string',
                        options: ['string', 'number', 'enum', 'bool'].map((value) => ({ value, label: value })),
                        onChange: (value) => patch((prev) => { const params = (prev.params ?? []).slice()
                          params[index] = { ...params[index], type: value }
                          return { ...prev, params }
                        }), }), h(TextInput, { value: param.default === undefined ? '' : String(param.default), placeholder: 'default',
                        onChange: (value) => patch((prev) => { const params = (prev.params ?? []).slice()
                          params[index] = { ...params[index], default: value }
                          return { ...prev, params }
                        }), }), h(Switch, { checked: param.required === true, label: 'required', onClick: () => patch((prev) => {
                          const params = (prev.params ?? []).slice()
                          params[index] = { ...params[index], required: params[index].required !== true }
                          return { ...prev, params }
                        }), }), h(IconButton, { icon: 'trash', title: tr('common.delete'),
                        onClick: () => patch((prev) => ({ ...prev, params: (prev.params ?? []).filter((item, at) => at !== index) })), }),
                    ), ), h('div', null, h(Button, { size: 'sm', icon: 'plus',
                  onClick: () => patch((prev) => ({ ...prev, params: (prev.params ?? []).concat({ key: 'param', type: 'string', default: '', required: false }) })),
                }, tr('jobs.form.addParam')), ), ),

            h(FormSection, { label: tr('jobs.form.output') }), h(Field, { label: tr('jobs.form.outputKind'), children: h(SelectInput, {
                value: draft.output.kind ?? 'artifact',
                options: ['artifact', 'card', 'notification', 'workitem', 'none'].map((value) => ({ value, label: value })),
                onChange: (value) => setOutput('kind', value), }), }),
            h(Field, { label: tr('jobs.form.outputPath'), hint: 'reports/weekly-{{date}}.md', children: h(TextInput, { value: draft.output.path ?? '', onChange: (value) => setOutput('path', value) }) }),
            h(Field, { label: tr('jobs.form.notify'), children: h(SelectInput, { value: draft.output.notify ?? 'card',
                options: ['card', 'notification', 'none'].map((value) => ({ value, label: value })),
                onChange: (value) => setOutput('notify', value), }), }),

            h(FormSection, { label: tr('jobs.form.policy') }),
            h(Field, { label: tr('jobs.form.concurrency'), children: h(NumberInput, { value: draft.policy.concurrency, onChange: (value) => setPolicy('concurrency', value) }) }),
            h(Field, { label: tr('jobs.form.timeout'), children: h(NumberInput, { value: draft.policy.timeoutMin, onChange: (value) => setPolicy('timeoutMin', value) }) }),
            h(Field, { label: tr('jobs.form.retry'), children: h(NumberInput, { value: draft.policy.retry?.max, onChange: (value) => setPolicy('retry', { ...(draft.policy.retry ?? {}), max: value ?? 0 }) }) }),
            h(Field, { label: 'backoff', children: h(TextInput, { value: draft.policy.retry?.backoff ?? '', onChange: (value) => setPolicy('retry', { ...(draft.policy.retry ?? {}), backoff: value }) }) }),
            h(Field, { label: tr('jobs.form.quiet'), hint: '22:00-08:00', children: h(TextInput, {
                value: (draft.policy.quietHours ?? []).join(','),
                onChange: (value) => setPolicy('quietHours', splitLines(value.replace(/,/g, '\n'))), }), }),
            h(Field, { label: tr('jobs.form.dailyCap'), children: h(NumberInput, { value: draft.policy.maxRunsPerDay, onChange: (value) => setPolicy('maxRunsPerDay', value) }) }),
            h('div', { style: { gridColumn: '1 / -1', fontSize: 11, color: T.cap } }, tr('jobs.form.dryHint')), ), ), )
    }

    /** Jobs page: library / run history / triggers. */
    function JobsView(props) { const hub = props.hub
      const [tab, setTab] = useState('library')
      const [editing, setEditing] = useState(null)
      const [paramsFor, setParamsFor] = useState(null)
      const [auditFor, setAuditFor] = useState(null)
      const [deleteFor, setDeleteFor] = useState(null)
      const [busy, setBusy] = useState(null)
      const { jobs, runs } = useJobsData(hub)
      const jobRows = Array.isArray(jobs.data?.jobs) ? jobs.data.jobs : []
      const runRows = Array.isArray(runs.data?.runs) ? runs.data.runs : []
      const runningRuns = runRows.filter((run) => run.state === 'running' || run.state === 'queued')

      const toastError = useCallback( (error) => hub.show(tr('toast.failed', { message: errorMessage(error) }), 'error'), [hub], )

      const saveJob = useCallback( async (job, dry) => { setBusy('save')
          try { const data = await postJson(ROUTE.jobs, { action: 'save', job })
            hub.show(tr('jobs.saved'), 'ok')
            setEditing(null)
            await jobs.refresh()
            if (dry === true) { const saved = Array.isArray(data?.jobs) ? data.jobs.find((item) => item.name === job.name) : null
              if (saved !== null && saved !== undefined) {
                await postJson(ROUTE.runs, { action: 'run', jobId: saved.id, params: { dryRun: true } })
                hub.show(tr('jobs.dryStarted'), 'ok')
                await runs.refresh()
              } else { hub.show(tr('jobs.needSaveFirst'), 'error')
              }
            }
          } catch (error) { toastError(error)
          } finally { setBusy(null)
          }
        }, [hub, jobs, runs, toastError], )

      const startRun = useCallback( async (job, params) => { setBusy(`run:${job.id}`)
          try { await postJson(ROUTE.runs, { action: 'run', jobId: job.id, params })
            hub.show(tr('jobs.runStarted', { name: job.name }), 'ok')
            setParamsFor(null)
            await runs.refresh()
            await hub.refreshStatus()
          } catch (error) { toastError(error)
          } finally { setBusy(null)
          }
        }, [hub, runs, toastError], )

      const toggleJob = useCallback( async (job) => { try {
            await postJson(ROUTE.jobs, { action: 'toggle', job: { ...job, enabled: job.enabled === false } })
            await jobs.refresh()
          } catch (error) { toastError(error)
          }
        }, [jobs, toastError], )

      const duplicateJob = useCallback( async (job) => { try {
            const copy = { ...omitKey(job, 'id'), name: `${job.name} (copy)`, version: 1, builtin: false }
            await postJson(ROUTE.jobs, { action: 'save', job: copy })
            hub.show(tr('jobs.saved'), 'ok')
            await jobs.refresh()
          } catch (error) { toastError(error)
          }
        }, [hub, jobs, toastError], )

      const removeJob = useCallback(async () => { if (deleteFor === null) return
        try { await postJson(ROUTE.jobs, { action: 'remove', job: { id: deleteFor.id } })
          hub.show(tr('toast.done'), 'ok')
          setDeleteFor(null)
          await jobs.refresh()
        } catch (error) { toastError(error)
        }
      }, [deleteFor, hub, jobs, toastError])

      const cancelRun = useCallback( async (run) => { try { await postJson(ROUTE.runs, { action: 'cancel', runId: run.id })
            hub.show(tr('jobs.cancelled'), 'ok')
            await runs.refresh()
          } catch (error) { toastError(error)
          }
        }, [hub, runs, toastError], )

      const triggerRows = useMemo( () => jobRows.filter((job) => ['event', 'after'].includes(String(job.trigger?.kind ?? ''))), [jobRows], )

      const tableHead = [tr('jobs.runs.time'), tr('jobs.runs.job'), tr('jobs.runs.source'), tr('jobs.runs.state'), tr('jobs.runs.duration'), tr('jobs.runs.tokens'), tr('jobs.runs.artifact'), tr('jobs.runs.actions')]

      return h( 'div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: T.bg } }, h( 'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 24px', borderBottom: `1px solid ${T.b1}`, flex: 'none', flexWrap: 'wrap' } },
          h('h1', { style: { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600 } }, tr('jobs.title')), h(Tabs, { active: tab,
            onChange: setTab, tabs: [ { id: 'library', label: tr('jobs.tab.library'), count: jobRows.length },
              { id: 'runs', label: tr('jobs.tab.runs'), count: runRows.length },
              { id: 'triggers', label: tr('jobs.tab.triggers'), count: triggerRows.length }, ], }), h('span', { style: { flex: 1 } }),
          runningRuns.length > 0
            ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.brand } },
                h(Spinner, { size: 12 }), tr('jobs.running', { n: runningRuns.length }))
            : null,
          h(Button, { size: 'sm', icon: 'refresh', onClick: async () => { await jobs.refresh(); await runs.refresh() } }, tr('common.refresh')),
          h(Button, { variant: 'primary', size: 'sm', icon: 'plus', onClick: () => setEditing({ mode: 'new', job: blankJob() }) }, tr('jobs.new')),
        ), runningRuns.length > 0
          ? h( 'div',
              { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 24px', borderBottom: `1px solid ${T.b1}`, flex: 'none' } },
              h(Spinner, null), h('span', { style: { fontSize: 12, fontWeight: 600 } }, `${runningRuns[0].jobId ?? 'run'}`),
              h('span', { style: { fontSize: 11, color: T.fg3 } }, tr('jobs.runs.runningNote')), h('span', { style: { flex: 1 } }),
              h(Button, { size: 'sm', onClick: () => cancelRun(runningRuns[0]) }, tr('jobs.runs.cancel')), )
          : null, h( 'div', { className: 'dw-scroll', style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 24px 24px' } },
          tab === 'library'
            ? jobRows.length === 0
              ? h(EmptyState, { icon: 'clock', title: tr('jobs.empty'), body: tr('jobs.emptyHint'), actionLabel: tr('jobs.new'),
                  onAction: () => setEditing({ mode: 'new', job: blankJob() }), })
              : h( 'div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 12 } },
                  jobRows.map((job) => { const stats = jobStats(runRows, job.id)
                    return h( 'div', { key: job.id, style: { display: 'flex' } }, h(JobCard, { job, stats, onToggle: toggleJob,
                        onRun: (value) => { if (Array.isArray(value.params) && value.params.length > 0) setParamsFor(value)
                          else void startRun(value, {})
                        }, onEdit: (value) => setEditing({ mode: 'edit', job: value }), onDuplicate: duplicateJob,
                        onAudit: (id) => setAuditFor({ key: id, title: id }), onDelete: (value) => setDeleteFor(value), }), )
                  }), h( 'button', { type: 'button', onClick: () => setEditing({ mode: 'new', job: blankJob() }), style: { display: 'flex',
                        flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 140, borderRadius: R.md,
                        border: `1px dashed ${T.b3}`, background: 'transparent', color: T.fg3, cursor: 'pointer', fontSize: TYPE.xs, }, },
                    h(Icon, { name: 'plus', size: 16 }), tr('jobs.new'), ), )
            : tab === 'runs'
              ? runRows.length === 0
                ? h(EmptyState, { icon: 'hist', title: tr('jobs.runs.empty'), compact: false })
                : h( 'table', { style: { width: '100%', borderCollapse: 'collapse' } }, h('thead', null,
                      h('tr', null, tableHead.map((label) => h('th', { key: label,
                        style: { textAlign: 'left', fontWeight: 500, color: T.cap, fontSize: 11, padding: '6px 10px', borderBottom: `1px solid ${T.b1}`, whiteSpace: 'nowrap' },
                      }, label))), ), h('tbody', null, runRows.map((run) => { const job = jobRows.find((item) => item.id === run.jobId)
                      const artifact = Array.isArray(run.artifacts) && run.artifacts.length > 0 ? run.artifacts[0] : null
                      const canCancel = run.state === 'running' || run.state === 'queued'
                      return h( 'tr', { key: run.id, className: 'dw-click' },
                        h('td', { style: { padding: '7px 10px', borderBottom: `1px solid ${T.b1}`, fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)', fontSize: 12, color: T.fg2, whiteSpace: 'nowrap' } }, fmtDateTime(run.startedAt ?? run.scheduledAt)),
                        h('td', { style: { padding: '7px 10px', borderBottom: `1px solid ${T.b1}`, color: T.fg2 } }, job?.name ?? run.jobId ?? '—'),
                        h('td', { style: { padding: '7px 10px', borderBottom: `1px solid ${T.b1}`, color: T.fg3, fontSize: 12 } }, tr(`jobs.source.${run.triggerSource ?? 'manual'}`)),
                        h('td', { style: { padding: '7px 10px', borderBottom: `1px solid ${T.b1}` } },
                          h(Chip, { tone: runStateTone(run.state) }, tr(`jobs.state.${run.state ?? 'queued'}`))),
                        h('td', { style: { padding: '7px 10px', borderBottom: `1px solid ${T.b1}`, color: T.fg2, fontSize: 12 } }, fmtDuration(run.startedAt, run.finishedAt)),
                        h('td', { style: { padding: '7px 10px', borderBottom: `1px solid ${T.b1}`, color: T.fg2, fontSize: 12 } }, fmtTokens(run.usage)),
                        h('td', { style: { padding: '7px 10px', borderBottom: `1px solid ${T.b1}` } }, artifact !== null
                            ? h(Button, { size: 'sm', variant: 'text', title: artifact.path, onClick: async () => {
                                  const ok = await copyText(artifact.path)
                                  hub.show(ok ? tr('toast.copied') : tr('toast.copyFail'), ok ? 'ok' : 'error')
                                }, }, artifact.title ?? artifact.path)
                            : run.state === 'failed'
                              ? h(Button, { size: 'sm', variant: 'text', onClick: () => hub.show(String(run.error ?? run.reason ?? '—'), 'error') }, run.error ? (LANG === 'en' ? 'See error' : '看错误') : '—')
                              : h('span', { style: { color: T.cap } }, '—'), ),
                        h('td', { style: { padding: '7px 10px', borderBottom: `1px solid ${T.b1}`, whiteSpace: 'nowrap' } }, h(Button, {
                            size: 'sm', variant: 'text', onClick: () => { const target = jobRows.find((item) => item.id === run.jobId)
                              if (target !== undefined) void startRun(target, run.params ?? {})
                            }, }, tr('jobs.runs.rerun')),
                          canCancel ? h(Button, { size: 'sm', variant: 'text', onClick: () => cancelRun(run) }, tr('jobs.runs.cancel')) : null,
                          h(Button, { size: 'sm', variant: 'text',
                            onClick: () => setAuditFor({ key: run.jobId ?? run.id, title: run.jobId ?? run.id }), }, tr('jobs.runs.why')),
                        ), )
                    })), )
              : triggerRows.length === 0
                ? h(EmptyState, { icon: 'rules', title: tr('jobs.noTriggers'), body: tr('jobs.triggerHint'), compact: false })
                : h( 'div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    h(Banner, { tone: 'info', title: tr('jobs.triggerHint') }), h( 'table',
                      { style: { width: '100%', borderCollapse: 'collapse', marginTop: 6 } }, h('thead', null, h('tr', null,
                        h('th', { style: { textAlign: 'left', padding: '6px 10px', borderBottom: `1px solid ${T.b1}`, fontSize: 11, color: T.cap } }, tr('jobs.triggerEvent')),
                        h('th', { style: { textAlign: 'left', padding: '6px 10px', borderBottom: `1px solid ${T.b1}`, fontSize: 11, color: T.cap } }, tr('jobs.triggerAction')),
                        h('th', { style: { textAlign: 'left', padding: '6px 10px', borderBottom: `1px solid ${T.b1}`, fontSize: 11, color: T.cap } }, tr('jobs.triggerPaused')),
                      )), h('tbody', null, triggerRows.map((job) => h('tr', { key: job.id },
                          h('td', { style: { padding: '7px 10px', borderBottom: `1px solid ${T.b1}`, fontSize: 12, color: T.fg2, fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)' } },
                            String(job.trigger.kind) === 'event' ? (job.trigger.events ?? []).join(', ') : `after · ${(job.trigger.after?.jobIds ?? []).join(', ')}`),
                          h('td', { style: { padding: '7px 10px', borderBottom: `1px solid ${T.b1}`, fontSize: 12, color: T.fg2 } }, job.name),
                          h('td', { style: { padding: '7px 10px', borderBottom: `1px solid ${T.b1}` } },
                            h(Switch, { checked: job.enabled !== false, label: job.name, onClick: () => toggleJob(job) })), ), )), ), ), ),
        editing !== null
          ? h(JobFormModal, { mode: editing.mode, initial: editing.job, onCancel: () => setEditing(null), onSubmit: saveJob, })
          : null, paramsFor !== null
          ? h(JobParamsDialog, { job: paramsFor, onCancel: () => setParamsFor(null), onRun: (params) => startRun(paramsFor, params), })
          : null, auditFor !== null
          ? h(AuditDialog, { query: { key: auditFor.key }, title: auditFor.title, onClose: () => setAuditFor(null), onAuth: hub.onAuth })
          : null, deleteFor !== null
          ? h(ConfirmDialog, { title: tr('jobs.deleteTitle'), body: tr('jobs.deleteBody', { name: deleteFor.name }),
              confirmLabel: tr('common.delete'), danger: true, onCancel: () => setDeleteFor(null), onConfirm: removeJob, })
          : null,
        busy !== null ? h(Toast, { toast: { message: tr('common.loading'), tone: 'info' }, onDismiss: () => setBusy(null) }) : null, )
    }

    /* ==================================================================== *
     * 11. Prompts & skills
     * ==================================================================== */

    /** Editable clone of a template (keeps the contract fields only). */
    function toTemplateDraft(template) { return { id: template.id, name: template.name ?? tr('prompts.defaultName'),
        version: template.version ?? 1, scope: { projects: Array.isArray(template.scope?.projects) ? template.scope.projects.slice() : [],
          paths: Array.isArray(template.scope?.paths) ? template.scope.paths.slice() : [],
          exclude: Array.isArray(template.scope?.exclude) ? template.scope.exclude.slice() : [], }, role: template.role ?? '',
        checklist: Array.isArray(template.checklist) ? template.checklist.slice() : [],
        context: Array.isArray(template.context) ? template.context.slice() : [],
        variables: Array.isArray(template.variables) ? template.variables.slice() : [],
        outputSchema: template.outputSchema ?? 'ReviewResult@1', model: template.model ?? { provider: '', model: '', temperature: 0.2 },
        enabled: template.enabled !== false, stats: template.stats ?? { used: 0, adopted: 0, ignored: 0 }, updatedAt: template.updatedAt, }
    }

    /** Template id prefix for new drafts. */
    function newTemplateId() { return `tpl-${Date.now().toString(36)}`
    }

    /** Compose the five editor sections into one prompt body. */
    function composeTemplateText(draft) { const parts = [String(draft.role ?? '')]
      if ((draft.checklist ?? []).length > 0) parts.push(`# 检查清单\n${draft.checklist.join('\n')}`)
      if ((draft.context ?? []).length > 0) parts.push(`# 上下文\n${draft.context.join('\n')}`)
      parts.push(`# 输出格式\n${String(draft.outputSchema ?? '')}`)
      return parts.filter((part) => part.trim() !== '').join('\n\n')
    }

    /** Sample variable values for the local preview fallback. */
    function sampleVars(item) { return { 'mr.title': item?.title ?? (LANG === 'en' ? 'feat: example change' : 'feat: 示例变更'),
        'mr.description': LANG === 'en' ? '(MR description)' : '（MR 描述）', 'mr.author': item?.author ?? '—',
        'diff': LANG === 'en' ? '(truncated diff preview)' : '（截断的 diff 预览）', 'files': String(item?.changedFiles ?? 12),
        'files.changed': String(item?.changedFiles ?? 12), 'project.path': item?.project ?? 'gp/order-service',
        'project.conventions': LANG === 'en' ? '(repo conventions)' : '（仓库约定）', }
    }

    /** Local `{{var}}` substitution used when the endpoint has no preview. */
    function renderTemplateLocally(draft, sample) { const body = composeTemplateText(draft)
      return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name) => sample[name] !== undefined ? String(sample[name]) : whole, )
    }

    /** Self-check list for the editor's 自检 section. */
    function templateIssues(draft) { const issues = []
      if (String(draft.name ?? '').trim() === '') issues.push(LANG === 'en' ? 'Name is empty' : '名称为空')
      if (String(draft.role ?? '').trim() === '') issues.push(LANG === 'en' ? 'Role section is empty' : '角色段为空')
      if ((draft.checklist ?? []).length === 0) issues.push(LANG === 'en' ? 'Checklist is empty' : '检查清单为空')
      if ((draft.context ?? []).length === 0) issues.push(LANG === 'en' ? 'No context source' : '没有上下文装配项')
      if (String(draft.outputSchema ?? '').trim() === '') issues.push(LANG === 'en' ? 'Output format missing' : '输出格式为空')
      const known = new Set(TEMPLATE_VARIABLES.map((value) => value.replace(/[{}]/g, '').trim()))
      const body = composeTemplateText(draft)
      const used = Array.from(body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)).map((match) => match[1])
      for (const name of used) { if (!known.has(name)) issues.push(LANG === 'en' ? `Unknown variable {{${name}}}` : `未知变量 {{${name}}}`)
      }
      return issues
    }

    /** One row in the template list. */
    function TemplateRow(props) { const [hover, bind] = useHover()
      const template = props.template
      const adoption = Number(template.stats?.used) > 0
        ? Math.round(((Number(template.stats?.adopted) || 0) / Number(template.stats.used)) * 100)
        : null
      return h( 'div', { role: 'option', 'aria-selected': props.selected === true ? 'true' : 'false',
          onClick: () => props.onSelect(template), ...bind, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
            borderBottom: `1px solid ${T.b1}`, background: props.selected === true ? T.selected : hover ? T.hover : 'transparent',
            cursor: 'pointer', }, }, h('span', { style: { width: 24, height: 24, flex: 'none', borderRadius: R.sm, background: T.tag,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: T.fg3, },
        }, h(Icon, { name: 'prompt', size: 13 })), h( 'div',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
          h('div', { style: { fontSize: TYPE.xs, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, template.name ?? tr('prompts.defaultName')),
          h( 'div', { style: { fontSize: 11, color: T.fg3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            `v${template.version ?? 1} · ${template.enabled === false ? tr('common.disabled') : tr('common.enabled')} · ${templateScopeLabel(template)}${adoption !== null ? ` · ${tr('prompts.adoption')} ${adoption}%` : ''}`,
          ), ), h(Switch, { checked: template.enabled !== false, label: tr('prompts.enabled'), onClick: (event) => {
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
            props.onToggle(template)
          }, }), )
    }

    /** Scope label: global / projects / paths. */
    function templateScopeLabel(template) { const scope = template.scope ?? {}
      const projects = Array.isArray(scope.projects) ? scope.projects : []
      const paths = Array.isArray(scope.paths) ? scope.paths : []
      if (projects.length === 0 && paths.length === 0) return LANG === 'en' ? 'All projects' : '全部项目'
      if (projects.length > 0) return `${projects[0]}${projects.length > 1 ? ` +${projects.length - 1}` : ''}`
      return `${paths[0]}${paths.length > 1 ? ` +${paths.length - 1}` : ''}`
    }

    /** Prompt library + editor. */
    function PromptsView(props) { const hub = props.hub
      const templatesPoll = usePoll({ path: ROUTE.templates, pollMs: 0, paused: hub.paused, onAuth: hub.onAuth })
      const templates = Array.isArray(templatesPoll.data?.templates) ? templatesPoll.data.templates : []
      const [selectedId, setSelectedId] = useState(null)
      const [draft, setDraft] = useState(null)
      const [preview, setPreview] = useState({ text: '', source: 'local', loading: false })
      const [saving, setSaving] = useState(false)
      const [deleteOpen, setDeleteOpen] = useState(false)
      const width = useViewportWidth()
      const narrow = width < BREAK_TWO_COL

      useEffect(() => { if (selectedId === null && templates.length > 0) setSelectedId(templates[0].id)
      }, [templates, selectedId])

      useEffect(() => { if (selectedId === null) return
        const found = templates.find((template) => template.id === selectedId)
        if (found !== undefined) setDraft(toTemplateDraft(found))
      }, [selectedId, templatesPoll.data])

      const issues = useMemo(() => (draft === null ? [] : templateIssues(draft)), [draft])

      useEffect(() => { if (draft === null) return undefined
        let cancelled = false
        const timer = window.setTimeout(async () => { const fallback = renderTemplateLocally(draft, sampleVars(hub.selectedItem))
          setPreview((prev) => ({ ...prev, loading: true }))
          try { const { data } = await requestJson(ROUTE.templates, {
              query: { preview: 1, templateId: draft.id ?? '', text: composeTemplateText(draft) }, })
            const remote = pick(data, 'preview', 'rendered', 'text')
            const usable = typeof remote === 'string' && remote !== ''
            if (!cancelled) setPreview({ text: usable ? remote : fallback, source: usable ? 'remote' : 'local', loading: false })
          } catch { if (!cancelled) setPreview({ text: fallback, source: 'local', loading: false })
          }
        }, 500)
        return () => { cancelled = true
          window.clearTimeout(timer)
        }
      }, [draft, hub.selectedItem])

      const patchDraft = useCallback((updater) => { setDraft((prev) => (prev === null ? prev : updater(prev)))
      }, [])

      const saveTemplate = useCallback( async (extra) => { if (draft === null) return
          setSaving(true)
          try { const template = { ...draft, ...(extra ?? {}) }
            const data = await postJson(ROUTE.templates, { action: 'save', template })
            const saved = Array.isArray(data?.templates)
              ? data.templates.find((item) => item.id === template.id)
              : null
            hub.show(tr('prompts.saved', { version: saved?.version ?? template.version ?? 1 }), 'ok')
            if (saved !== null && saved !== undefined) setSelectedId(saved.id)
            await templatesPoll.refresh()
          } catch (error) { hub.show(tr('toast.failed', { message: errorMessage(error) }), 'error')
          } finally { setSaving(false)
          }
        }, [draft, hub, templatesPoll], )

      const createTemplate = useCallback(() => {
        const fresh = toTemplateDraft({ id: newTemplateId(), name: tr('prompts.defaultName'), version: 0, role: '', checklist: [], context: [], variables: [], outputSchema: 'ReviewResult@1', enabled: true })
        setSelectedId(fresh.id)
        setDraft(fresh)
      }, [])

      const removeTemplate = useCallback(async () => { if (draft === null) return
        try { await postJson(ROUTE.templates, { action: 'remove', template: { id: draft.id } })
          setDeleteOpen(false)
          setSelectedId(null)
          setDraft(null)
          hub.show(tr('toast.done'), 'ok')
          await templatesPoll.refresh()
        } catch (error) { hub.show(tr('toast.failed', { message: errorMessage(error) }), 'error')
        }
      }, [draft, hub, templatesPoll])

      const toggleEnabled = useCallback( async (template) => { try {
            await postJson(ROUTE.templates, { action: 'save', template: { ...template, enabled: template.enabled === false } })
            await templatesPoll.refresh()
          } catch (error) { hub.show(tr('toast.failed', { message: errorMessage(error) }), 'error')
          }
        }, [hub, templatesPoll], )

      const insertVariable = useCallback((variable) => {
        patchDraft((prev) => ({ ...prev, role: `${prev.role ?? ''}${prev.role ? ' ' : ''}${variable}` }))
      }, [patchDraft])

      const section = (key, label, hint, control) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } }, h('b', { style: { fontSize: TYPE.xs } }, label),
            hint ? h('span', { style: { fontSize: 11, color: T.cap } }, hint) : null, ), control, )

      return h( 'div', { style: { flex: 1, minHeight: 0, display: 'flex', background: T.bg } }, h( 'section',
          { style: { width: 340, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: `1px solid ${T.b1}` } },
          h( 'header',
            { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 10px', borderBottom: `1px solid ${T.b1}`, flex: 'none' } },
            h('h1', { style: { margin: 0, fontSize: TYPE.base, fontWeight: 600, flex: 1 } }, tr('prompts.title')),
            h('span', { style: { fontSize: 11, color: T.cap } }, String(templates.length)),
            h(IconButton, { icon: 'plus', title: tr('prompts.new'), onClick: createTemplate }),
            h(IconButton, { icon: 'refresh', title: tr('common.refresh'), onClick: templatesPoll.refresh }), ), h( 'div',
            { className: 'dw-scroll', role: 'listbox', 'aria-label': tr('prompts.title'), style: { flex: 1, minHeight: 0, overflow: 'auto' } },
            templates.length === 0
              ? h(EmptyState, { icon: 'prompt', title: tr('prompts.empty'), actionLabel: tr('prompts.new'), onAction: createTemplate, })
              : templates.map((template) => h(TemplateRow, { key: template.id, template, selected: template.id === selectedId,
                    onSelect: (value) => setSelectedId(value.id), onToggle: toggleEnabled, }), ), ), ), h( 'section',
          { style: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' } }, draft === null
            ? h(EmptyState, { icon: 'prompt', title: tr('prompts.select'), compact: false })
            : h( React.Fragment, null, h( 'header',
                  { style: { padding: '10px 16px 0', borderBottom: `1px solid ${T.b1}`, flex: 'none', display: 'flex', flexDirection: 'column', gap: 8 } },
                  h( 'div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
                    h('h2', { style: { margin: 0, fontSize: TYPE.base, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, draft.name),
                    h(Chip, { tone: 'neutral' }, LANG === 'en' ? 'Prompt' : '提示词'),
                    h(Chip, { tone: draft.enabled === false ? 'neutral' : 'ok' }, draft.enabled === false ? tr('common.disabled') : tr('prompts.enabled')),
                    h('span', { style: { flex: 1 } }), h(Switch, { checked: draft.enabled !== false, label: tr('prompts.enabled'),
                      onClick: () => patchDraft((prev) => ({ ...prev, enabled: prev.enabled === false })), }),
                    h(Button, { size: 'sm', icon: 'refresh', onClick: () => { setSelectedId(null); window.setTimeout(() => setSelectedId(draft.id), 0) } }, LANG === 'en' ? 'Replay' : '试跑'),
                    h(Button, { variant: 'primary', size: 'sm', disabled: saving, onClick: () => saveTemplate() }, tr('prompts.saveVersion')),
                  ), h( 'div', { style: { fontSize: 11, color: T.fg3, display: 'flex', flexWrap: 'wrap', gap: '2px 8px' } },
                    h('code', null, `v${draft.version ?? 1}`), h('span', null, `· ${templateScopeLabel(draft)}`),
                    h('span', null, `· ${tr('prompts.used')} ${Number(draft.stats?.used) || 0}`),
                    h('span', null, `· ${tr('prompts.adoption')} ${Number(draft.stats?.used) > 0 ? Math.round(((Number(draft.stats?.adopted) || 0) / Number(draft.stats.used)) * 100) : 0}%`),
                    draft.updatedAt ? h('span', null, `· ${fmtAgo(draft.updatedAt)}`) : null, ), h( 'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', paddingBottom: 6 } },
                    h('span', { style: { fontSize: 11, color: T.cap } }, tr('prompts.variables')), TEMPLATE_VARIABLES.map((variable) =>
                      h(Chip, { key: variable, tone: 'brand', onClick: () => insertVariable(variable), title: LANG === 'en' ? 'Insert into role' : '插入到角色段' }, variable),
                    ), h('span', { style: { flex: 1 } }), issues.length === 0
                      ? h(Chip, { tone: 'ok' }, tr('prompts.valid'))
                      : h(Chip, { tone: 'error' }, tr('prompts.invalid')), ), ), h( 'div',
                  { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: narrow ? 'column' : 'row' } }, h( 'div',
                    { className: 'dw-scroll', style: { flex: 1, minWidth: 0, overflow: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 } },
                    h(Field, { label: tr('prompts.name'),
                      children: h(TextInput, { value: draft.name, onChange: (value) => patchDraft((prev) => ({ ...prev, name: value })) }),
                    }), section('role', tr('prompts.role'), 'system prompt', h(TextArea, { rows: 4, value: draft.role ?? '',
                      onChange: (value) => patchDraft((prev) => ({ ...prev, role: value })), })),
                    section('checklist', tr('prompts.checklist'), tr('prompts.checklistHint'), h(TextArea, { rows: 5,
                      value: (draft.checklist ?? []).join('\n'),
                      onChange: (value) => patchDraft((prev) => ({ ...prev, checklist: splitLines(value) })), })),
                    section('context', tr('prompts.context'), tr('prompts.contextHint'), h(TextArea, { rows: 4,
                      value: (draft.context ?? []).join('\n'),
                      onChange: (value) => patchDraft((prev) => ({ ...prev, context: splitLines(value) })), })),
                    section('output', tr('prompts.output'), 'ReviewResult@1', h(TextInput, { value: draft.outputSchema ?? '',
                      onChange: (value) => patchDraft((prev) => ({ ...prev, outputSchema: value })), })),
                    section('self-check', tr('prompts.selfCheck'), null, issues.length === 0
                        ? h('div', { style: { fontSize: 12, color: T.ok } }, tr('prompts.valid'))
                        : h('ul', { style: { margin: 0, paddingLeft: 18, fontSize: 12, color: T.warnLabel, display: 'flex', flexDirection: 'column', gap: 2 } },
                            issues.map((issue, index) => h('li', { key: index }, issue))), ), h( 'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 } },
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                        h(Icon, { name: 'ext', size: 12, color: T.fg3 }),
                        h('b', { style: { fontSize: 12 } }, LANG === 'en' ? 'Export as skill' : '导出为 skill'), ),
                      h('div', { style: { fontSize: 11, color: T.fg2, lineHeight: '17px' } }, tr('prompts.exportHint')),
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 } },
                        h(Icon, { name: 'shield', size: 12, color: T.fg3 }),
                        h('b', { style: { fontSize: 12 } }, LANG === 'en' ? 'Existing skills' : '引用现有技能'), ),
                      h('div', { style: { fontSize: 11, color: T.fg2, lineHeight: '17px' } }, tr('prompts.skillsHint')), ), ), h( 'div', {
                      className: 'dw-scroll', style: { width: narrow ? '100%' : 360, flex: narrow ? '0 0 auto' : '0 0 360px',
                        maxHeight: narrow ? 240 : 'none', borderLeft: narrow ? 'none' : `1px solid ${T.b1}`,
                        borderTop: narrow ? `1px solid ${T.b1}` : 'none', overflow: 'auto', padding: '12px 14px', display: 'flex',
                        flexDirection: 'column', gap: 8, background: T.l2, }, },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, h(Icon, { name: 'eye', size: 12, color: T.fg3 }),
                      h('b', { style: { fontSize: 12 } }, tr('prompts.preview')), h('span', { style: { flex: 1 } }),
                      h(Chip, { tone: preview.source === 'remote' ? 'ok' : 'neutral' }, preview.source === 'remote' ? 'API' : 'local'), ),
                    preview.loading === true
                      ? h(Skeleton, { height: 120 })
                      : preview.text === ''
                        ? h(EmptyState, { icon: 'eye', title: tr('prompts.previewEmpty'), compact: true })
                        : h(CodeBlock, { maxHeight: 420 }, preview.text),
                    h('div', { style: { fontSize: 10, color: T.cap, lineHeight: '15px' } }, tr('prompts.previewNote')), ), ), h( 'footer',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderTop: `1px solid ${T.b1}`, flex: 'none' } },
                  issues.length === 0
                    ? h(Chip, { tone: 'ok' }, h(Icon, { name: 'check', size: 10 }), tr('prompts.valid'))
                    : h(Chip, { tone: 'error' }, tr('prompts.invalid')), h('span', { style: { flex: 1 } }),
                  h(Button, { size: 'sm', onClick: () => saveTemplate({ id: undefined, name: `${draft.name} (copy)`, version: 0 }) }, tr('common.duplicate')),
                  h(Button, { size: 'sm', variant: 'danger', icon: 'trash', onClick: () => setDeleteOpen(true) }, tr('common.delete')), ),
              ), ), deleteOpen
          ? h(ConfirmDialog, { title: tr('prompts.deleteTitle'), body: tr('prompts.deleteBody'), confirmLabel: tr('common.delete'),
              danger: true, onCancel: () => setDeleteOpen(false), onConfirm: removeTemplate, })
          : null, )
    }

    /* ==================================================================== *
     * 12. Settings
     * ==================================================================== */

    /** Settings page: connection, scope, rhythm, AI. */
    function SettingsView(props) { const hub = props.hub
      const settingsPoll = usePoll({ path: ROUTE.settings, pollMs: 0, paused: hub.paused, onAuth: hub.onAuth })
      const loaded = settingsPoll.data?.settings ?? null
      const [draft, setDraft] = useState(null)
      const [pat, setPat] = useState('')
      const [connecting, setConnecting] = useState(false)
      const [saving, setSaving] = useState(false)
      const days = useViewportWidth() < BREAK_NARROW

      useEffect(() => { if (loaded !== null) setDraft(loaded)
      }, [loaded])

      const current = draft ?? loaded ?? {}
      const set = (key, value) => setDraft((prev) => ({ ...(prev ?? loaded ?? {}), [key]: value }))
      const connection = hub.status?.connection ?? {}

      const save = async () => { setSaving(true)
        try { const payload = { ...current,
            groups: Array.isArray(current.groups) ? current.groups : splitLines(String(current.groups ?? '')),
            projects: Array.isArray(current.projects) ? current.projects : splitLines(String(current.projects ?? '')),
            excludePaths: Array.isArray(current.excludePaths) ? current.excludePaths : splitLines(String(current.excludePaths ?? '')),
            quietHours: Array.isArray(current.quietHours) ? current.quietHours : splitLines(String(current.quietHours ?? '').replace(/,/g, '\n')),
          }
          await postJson(ROUTE.settings, { settings: payload })
          hub.show(tr('settings.saved'), 'ok')
          await hub.refreshStatus()
          await settingsPoll.refresh()
        } catch (error) { hub.show(tr('toast.failed', { message: errorMessage(error) }), 'error')
        } finally { setSaving(false)
        }
      }

      const connect = async () => { setConnecting(true)
        try { const data = await postJson(ROUTE.connect, { baseUrl: String(current.gitlabBaseUrl ?? ''), token: pat })
          setPat('')
          await hub.refreshStatus()
          await settingsPoll.refresh()
          const verified = data?.connection?.verified === true
          hub.show(verified ? tr('settings.connectOk') : tr('settings.connectFail', { message: String(data?.connection?.error ?? '—') }), verified ? 'ok' : 'error')
        } catch (error) { hub.show(tr('settings.connectFail', { message: errorMessage(error) }), 'error')
        } finally { setConnecting(false)
        }
      }

      const row = (label, hint, control) => h(Field, { label, hint, inline: days === false, children: control })

      return h( 'div', { className: 'dw-scroll', style: { flex: 1, minHeight: 0, overflow: 'auto', background: T.bg } }, h( 'div',
          { style: { maxWidth: 960, margin: '0 auto', padding: '20px 24px 40px', display: 'flex', flexDirection: 'column', gap: 20 } }, h(
            'div', { style: { display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' } },
            h('div', { style: { flex: 1, minWidth: 240 } },
              h('h1', { style: { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600 } }, tr('settings.title')),
              h('p', { style: { margin: '4px 0 0', fontSize: TYPE.xs, color: T.fg2, lineHeight: '20px' } }, tr('settings.desc')), ),
            h('div', { style: { display: 'flex', gap: 8 } },
              h(Button, { onClick: () => settingsPoll.refresh() }, LANG === 'en' ? 'Reset' : '恢复默认'),
              h(Button, { variant: 'primary', disabled: saving, onClick: save }, tr('settings.save')), ), ), connection.configured !== true
            ? h(Banner, { tone: 'warn', title: tr('settings.onboardingTitle'), body: tr('settings.onboardingBody'), })
            : null, h( Card, { padding: 0 }, h('div', { style: { padding: '12px 16px' } },
              h('h3', { style: { margin: 0, fontSize: TYPE.xs } }, tr('settings.gitlab')),
              h('p', { style: { margin: '4px 0 0', fontSize: 11, color: T.cap, lineHeight: '16px' } }, tr('settings.gitlabDesc')), ),
            h('div', { style: { padding: '0 16px 10px', display: 'flex', flexDirection: 'column' } },
              row(tr('settings.baseUrl'), tr('settings.baseUrlHint'), h(TextInput, {
                  value: String(current.gitlabBaseUrl ?? connection.baseUrl ?? ''), placeholder: 'https://gp.gitlab.example.com',
                  onChange: (value) => set('gitlabBaseUrl', value), })), row(tr('settings.pat'), tr('settings.patHint'),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, h('div', { style: { flex: 1 } }, h(TextInput, {
                      type: 'password', value: pat, placeholder: connection.configured === true ? '••••••••（已保存，留空不修改）' : 'glpat-…',
                      onChange: setPat, }), ),
                  h(Chip, { tone: hub.settings?.tokenSet === true || connection.configured === true ? 'ok' : 'neutral' },
                    connection.configured === true ? tr('settings.patSaved') : tr('settings.patNotSet')),
                  h(Button, { size: 'sm', disabled: pat.trim() === '' || connecting, onClick: connect }, tr('settings.connect')), )),
              row(tr('settings.connection'), connection.lastCheck ? fmtAgo(connection.lastCheck) : undefined,
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } }, h(Chip, {
                    tone: connection.configured !== true ? 'neutral' : connection.verified === true ? 'ok' : 'error',
                  }, connection.configured !== true ? tr('settings.connectionNone') : connection.verified === true ? tr('settings.connectionOk') : tr('settings.connectionFail')),
                  connection.error ? h('span', { style: { fontSize: 11, color: T.err, wordBreak: 'break-word' } }, String(connection.error)) : null,
                )), ), ), h( Card, { padding: 0 }, h('div', { style: { padding: '12px 16px' } },
              h('h3', { style: { margin: 0, fontSize: TYPE.xs } }, tr('settings.collect')),
              h('p', { style: { margin: '4px 0 0', fontSize: 11, color: T.cap, lineHeight: '16px' } }, tr('settings.collectDesc')), ),
            h('div', { style: { padding: '0 16px 10px', display: 'grid', gridTemplateColumns: days ? '1fr' : '1fr 1fr', gap: 12 } },
              h(Field, { label: tr('settings.groups'), hint: 'gp', children: h(TextArea, { rows: 4,
                  value: Array.isArray(current.groups) ? current.groups.join('\n') : String(current.groups ?? ''),
                  onChange: (value) => set('groups', splitLines(value)), }), }), h(Field, { label: tr('settings.projects'),
                hint: 'gp/order-service', children: h(TextArea, { rows: 4,
                  value: Array.isArray(current.projects) ? current.projects.join('\n') : String(current.projects ?? ''),
                  onChange: (value) => set('projects', splitLines(value)), }), }), h('div', { style: { gridColumn: '1 / -1' } }, h(Field, {
                  label: tr('settings.exclude'), hint: 'dist/**, *.lock', children: h(TextInput, {
                    value: Array.isArray(current.excludePaths) ? current.excludePaths.join(',') : String(current.excludePaths ?? ''),
                    onChange: (value) => set('excludePaths', splitLines(value.replace(/,/g, '\n'))), }), }), ), ), ), h( Card,
            { padding: 0 }, h('div', { style: { padding: '12px 16px' } },
              h('h3', { style: { margin: 0, fontSize: TYPE.xs } }, tr('settings.rhythm')), ),
            h('div', { style: { padding: '0 16px 10px', display: 'flex', flexDirection: 'column' } },
              row(tr('settings.pollInterval'), undefined, h(SelectInput, { value: String(current.pollIntervalSec ?? 60),
                  options: ['15', '30', '60', '120', '300'].map((value) => ({ value, label: `${value}s` })),
                  onChange: (value) => set('pollIntervalSec', Number(value)), })), row(tr('settings.quietHours'), tr('settings.quietHint'),
                h(TextInput, { value: Array.isArray(current.quietHours) ? current.quietHours.join(',') : String(current.quietHours ?? ''),
                  onChange: (value) => set('quietHours', splitLines(value.replace(/,/g, '\n'))), })),
              row(tr('settings.concurrency'), undefined, h(SelectInput, { value: String(current.reviewConcurrency ?? 2),
                  options: ['1', '2', '3', '4'].map((value) => ({ value, label: value })),
                  onChange: (value) => set('reviewConcurrency', Number(value)), })),
              row(tr('settings.failureThreshold'), tr('settings.failedThresholdExtra'), h('div', { style: { maxWidth: 120 } },
                  h(TextInput, { type: 'number', value: String(current.failureThreshold ?? 3),
                    onChange: (value) => set('failureThreshold', Number(value)), }), )), ), ), h( Card, { padding: 0 },
            h('div', { style: { padding: '12px 16px' } }, h('h3', { style: { margin: 0, fontSize: TYPE.xs } }, tr('settings.ai')), ),
            h('div', { style: { padding: '0 16px 10px', display: 'flex', flexDirection: 'column' } },
              row(tr('settings.provider'), undefined, h(TextInput, { value: String(current.defaultProvider ?? ''), placeholder: 'deepseek',
                  onChange: (value) => set('defaultProvider', value), })), row(tr('settings.model'), undefined, h(TextInput, {
                  value: String(current.defaultModel ?? ''), placeholder: 'deepseek-v4', onChange: (value) => set('defaultModel', value),
                })), row(tr('settings.allowWrites'), tr('settings.allowWritesHint'), h(Switch, { checked: current.allowWrites !== false,
                  label: tr('settings.allowWrites'), onClick: () => set('allowWrites', current.allowWrites === false), })), ), ),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
            h(Button, { disabled: saving, onClick: save }, tr('settings.save')), ), ), )
    }

    /* ==================================================================== *
     * 13. Command palette
     * ==================================================================== */

    /** `⌘K` / `Ctrl-K` palette: switch view, jump project, run action. */
    function CommandPalette(props) { const [query, setQuery] = useState('')
      const [index, setIndex] = useState(0)
      const inputRef = useRef(null)
      useEffect(() => { if (inputRef.current !== null && typeof inputRef.current.focus === 'function') inputRef.current.focus()
      }, [])
      const filtered = useMemo(() => { const needle = query.trim().toLowerCase()
        if (needle === '') return props.items
        return props.items.filter((item) => `${item.group ?? ''} ${item.label}`.toLowerCase().includes(needle), )
      }, [props.items, query])
      useEffect(() => { setIndex((prev) => (prev >= filtered.length ? 0 : prev))
      }, [filtered.length])
      const run = (item) => { if (item === undefined) return
        props.onClose()
        if (typeof item.run === 'function') item.run()
      }
      const onKeyDown = (event) => { if (event.key === 'Escape') { event.preventDefault()
          props.onClose()
          return
        }
        if (event.key === 'ArrowDown') { event.preventDefault()
          setIndex((prev) => (filtered.length === 0 ? 0 : (prev + 1) % filtered.length))
          return
        }
        if (event.key === 'ArrowUp') { event.preventDefault()
          setIndex((prev) => (filtered.length === 0 ? 0 : (prev - 1 + filtered.length) % filtered.length))
          return
        }
        if (event.key === 'Enter') { event.preventDefault()
          run(filtered[index])
        }
      }
      let lastGroup = null
      return h( 'div', { style: { position: 'fixed', inset: 0, zIndex: 80, display: 'flex', justifyContent: 'center',
            alignItems: 'flex-start', paddingTop: '12vh', background: 'color-mix(in srgb, #000 42%, transparent)', },
          onMouseDown: (event) => { if (event.target === event.currentTarget) props.onClose()
          }, }, h( 'div', { role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('palette.title'), style: { width: 560,
              maxWidth: 'calc(100vw - 40px)', maxHeight: '62vh', display: 'flex', flexDirection: 'column', borderRadius: R.lg,
              border: `1px solid ${T.b2}`, background: T.overlay, boxShadow: '0 20px 60px rgba(0,0,0,.4)', overflow: 'hidden', }, }, h(
            'div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${T.b1}` } },
            h(Icon, { name: 'search', size: 14, color: T.fg3 }), h('input', { ref: inputRef, value: query,
              placeholder: tr('palette.placeholder'), onKeyDown, onChange: (event) => { setQuery(event.target.value)
                setIndex(0)
              },
              style: { flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: T.fg, fontSize: TYPE.s, padding: '2px 0' },
              spellCheck: false, }), h(Chip, { tone: 'neutral' }, 'esc'), ), h( 'div',
            { className: 'dw-scroll', role: 'listbox', style: { flex: 1, minHeight: 0, overflow: 'auto', padding: 6 } },
            filtered.length === 0
              ? h('div', { style: { padding: 16, fontSize: 12, color: T.cap, textAlign: 'center' } }, tr('palette.empty'))
              : filtered.map((item, itemIndex) => { const showGroup = item.group !== lastGroup
                  lastGroup = item.group
                  return h( React.Fragment, { key: item.id }, showGroup
                      ? h('div', { style: { padding: '6px 8px 2px', fontSize: 10, color: T.cap, letterSpacing: '.04em' } }, item.group)
                      : null, h( 'button', { type: 'button', role: 'option', 'aria-selected': itemIndex === index ? 'true' : 'false',
                        onMouseEnter: () => setIndex(itemIndex), onClick: () => run(item), style: { display: 'flex', alignItems: 'center',
                          gap: 8, width: '100%', padding: '6px 8px', border: 'none', borderRadius: R.xs,
                          background: itemIndex === index ? T.selected : 'transparent', color: T.fg, fontSize: TYPE.xs, textAlign: 'left',
                          cursor: 'pointer', }, }, item.icon ? h(Icon, { name: item.icon, size: 13, color: T.fg3 }) : null,
                      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.label),
                      item.hint ? h('span', { style: { fontSize: 10, color: T.cap, flex: 'none' } }, item.hint) : null, ), )
                }), ), ), )
    }

    /* ==================================================================== *
     * 14. Shell: sidebar, toolbar, status bar
     * ==================================================================== */

    /** Unread badge shared with the `sidebar.panellist` icon. */
    const panelBadge = { value: 0, listeners: new Set(), set(next) { const value = Number(next) || 0
        if (value === this.value) return
        this.value = value
        for (const listener of this.listeners) { try { listener(value)
          } catch { /* a dead listener must not break the panel */
          }
        }
      }, }

    /** Human label for one primary view. */
    function viewLabel(view) { const map = { inbox: 'nav.inbox', review: 'nav.review', work: 'nav.work', projects: 'nav.projects',
        jobs: 'nav.jobs', prompts: 'nav.prompts', settings: 'nav.settings', }
      return tr(map[view] ?? 'nav.inbox')
    }

    /** Left navigation, 220px, seven entries in three groups. */
    function SidebarNav(props) { return h( 'nav', { 'aria-label': tr('meta.title'), style: { width: NAV_WIDTH, flex: 'none',
            display: 'flex', flexDirection: 'column', gap: 1, padding: '12px 10px', borderRight: `1px solid ${T.b1}`, background: T.bg,
            minHeight: 0, }, }, h( 'div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 6px 10px' } }, h('span', {
            style: { width: 22, height: 22, borderRadius: R.sm, display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center', background: T.btn, color: T.btnFg, fontSize: 11, fontWeight: 700, },
          }, LANG === 'en' ? 'D' : '日'),
          h('span', { style: { fontSize: TYPE.xs, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, tr('meta.title')),
        ), NAV_GROUPS.map((group) => h( 'div', { key: group.label, style: { display: 'flex', flexDirection: 'column', gap: 1 } },
            h('div', { style: { padding: '10px 8px 4px', fontSize: 10, color: T.cap, letterSpacing: '.04em' } }, tr(group.label)),
            group.items.map((item) => { const active = props.view === item.id
              const count = item.badge === null ? 0 : Number(props.counts[item.badge]) || 0
              return h( 'button', { key: item.id, type: 'button', 'aria-current': active ? 'page' : undefined,
                  onClick: () => props.onSelect(item.id), className: 'dw-click', style: { display: 'flex', alignItems: 'center', gap: 8,
                    width: '100%', padding: '6px 8px', borderRadius: R.sm, border: 'none', background: active ? T.active : 'transparent',
                    color: active ? T.fg : T.fg2, fontWeight: active ? 600 : 400, fontSize: TYPE.xs, textAlign: 'left', cursor: 'pointer',
                  }, }, h(Icon, { name: item.icon, size: 14, color: active ? T.fg : T.fg3 }),
                h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, tr(item.label)),
                count > 0 ? h(CountBadge, { value: count, tone: item.id === 'inbox' ? 'error' : 'brand' }) : null, )
            }), ), ), h('span', { style: { flex: 1 } }), h( 'div', { style: { borderTop: `1px solid ${T.b1}`, paddingTop: 8,
              display: 'flex', flexDirection: 'column', gap: 3, fontSize: 10, color: T.cap, lineHeight: '15px', }, },
          h('div', null, props.status?.status?.polling === false
            ? (LANG === 'en' ? 'Polling off' : '轮询未开启')
            : `${LANG === 'en' ? 'Polling' : '轮询'} · ${props.paused === true ? (LANG === 'en' ? 'paused' : '已暂停') : `${Number(props.status?.status?.backoffMs) > 0 ? (LANG === 'en' ? 'backoff' : '退避中') : (LANG === 'en' ? 'ok' : '正常')}`}`),
          h('div', null, `${LANG === 'en' ? 'Last success' : '上次成功'} ${props.status?.status?.lastSuccessAt ? fmtAgo(props.status.status.lastSuccessAt) : '—'}`),
          h('div', null, `${LANG === 'en' ? 'Next' : '下次'} ${props.status?.status?.nextPollAt ? fmtAgo(props.status.status.nextPollAt) : '—'}`),
        ), )
    }

    /** Top bar: breadcrumb, quick filters, sort, refresh, pause, palette. */
    function TopToolbar(props) { const quickChips = INBOX_MODES.includes(props.view)
      const inboxMode = INBOX_MODES.includes(props.view)
      return h( 'header', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: `1px solid ${T.b1}`,
            flex: 'none', flexWrap: 'wrap', minHeight: 44, background: T.bg, }, }, h( 'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.fg3, minWidth: 0 } },
          h(Icon, { name: 'inbox', size: 13, color: T.fg3 }), h('span', { style: { fontWeight: 600, color: T.fg } }, viewLabel(props.view)),
          props.selectedItem !== null && props.selectedItem !== undefined
            ? h(React.Fragment, null, h(Icon, { name: 'chev', size: 10 }),
                h('span', { style: { maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.selectedItem.subject ?? props.selectedItem.title ?? ''),
              )
            : null, ), quickChips
          ? h( 'div', { style: { display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' } }, QUICK_FILTERS.map((entry) =>
                h(Chip, { key: entry.id, active: props.quick === entry.id, onClick: () => props.onQuick(entry.id),
                  tone: entry.id === 'ci' ? 'error' : 'brand', }, tr(entry.label)), ), )
          : null, h('span', { style: { flex: 1 } }), inboxMode
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, h(Icon, { name: 'filter', size: 12, color: T.fg3 }),
              h(SelectInput, { value: props.sort, options: [
                  { value: 'recommended', label: `${tr('filters.sort')} · ${tr('filters.recommended')}` },
                  { value: 'updated', label: `${tr('filters.sort')} · ${LANG === 'en' ? 'Updated' : '更新时间'}` },
                  { value: 'priority', label: `${tr('filters.sort')} · ${LANG === 'en' ? 'Priority' : '优先级'}` }, ], onChange: props.onSort,
                style: { minHeight: 26, fontSize: 11, width: 170 }, }), )
          : null, h(IconButton, { icon: 'refresh', title: `${tr('common.refresh')} (r)`, onClick: props.onRefresh }), h( Button, {
            size: 'sm', variant: props.paused ? 'primary' : 'ghost', icon: props.paused ? 'play' : 'pause', onClick: props.onTogglePause,
            title: tr('banner.pausedHint'), }, props.paused ? tr('common.resumePolling') : tr('common.pausePolling'), ),
        h(Button, { size: 'sm', variant: 'ghost', icon: 'search', onClick: props.onOpenPalette, title: '⌘K' }, '⌘K'), )
    }

    /** Bottom shortcut bar (26px, mockup parity). */
    function StatusBar(props) { const hints = [ ['j/k', tr('keys.move')], ['Enter', tr('keys.open')], ['Esc', tr('keys.back')],
        ['e', tr('keys.archive')], ['s', tr('keys.snooze')], ['a', tr('keys.ai')], ['c', tr('keys.comment')], ['r', tr('keys.refresh')], ]
      return h( 'footer', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', height: 26, flex: 'none',
            borderTop: `1px solid ${T.b1}`, fontSize: 10, color: T.cap, background: T.bg, overflow: 'hidden', }, },
        hints.map(([key, label]) => h('span', { key, style: { display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none' } },
            h('kbd', { style: { padding: '0 4px', height: 16, lineHeight: '16px', borderRadius: R.xs, border: `1px solid ${T.b2}`,
                background: T.tag, fontSize: 9, fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)', }, }, key),
            label, ), ), h('span', { style: { flex: 1 } }), h('span', { style: { flex: 'none' } },
          `${props.status?.status?.lastSuccessAt ? fmtAgo(props.status.status.lastSuccessAt) : '—'} · ${Number(props.counts.unread) || 0} ${LANG === 'en' ? 'unread' : '未读'} · ${Number(props.counts.total) || 0} ${LANG === 'en' ? 'items' : '项'}`),
      )
    }

    /* ==================================================================== *
     * 15. Panel root: data wiring, actions, hotkeys
     * ==================================================================== */

    /** Today at 08:00 + one day, for the "tomorrow" snooze preset. */
    function tomorrowMorning() { const date = new Date()
      date.setDate(date.getDate() + 1)
      date.setHours(8, 0, 0, 0)
      return date.toISOString()
    }

    /** Resolve one snooze preset to an ISO instant. */
    function snoozeUntil(preset) { if (preset.hours === -1) return tomorrowMorning()
      return new Date(Date.now() + Number(preset.hours) * 60 * 60 * 1000).toISOString()
    }

    /** The full-page workbench. */
    function HubApp() { const [view, setView] = useState('inbox')
      const [filters, setFilters] = useState({ q: '', project: '', reason: '', state: '' })
      const [quick, setQuick] = useState('all')
      const [sort, setSort] = useState('recommended')
      const [paused, setPaused] = useState(false)
      const [authLost, setAuthLost] = useState(false)
      const [selectedKey, setSelectedKey] = useState(null)
      const [selectedSnapshot, setSelectedSnapshot] = useState(null)
      const [selectedKeys, setSelectedKeys] = useState(() => new Set())
      const [drawerOpen, setDrawerOpen] = useState(false)
      const [detailTab, setDetailTab] = useState('overview')
      const [focusFile, setFocusFile] = useState(null)
      const [hideGenerated, setHideGenerated] = useState(false)
      const [draft, setDraft] = useState(null)
      const [drafting, setDrafting] = useState(false)
      const [reviewPolling, setReviewPolling] = useState(false)
      const [reviewPending, setReviewPending] = useState(false)
      const [paletteOpen, setPaletteOpen] = useState(false)
      const [snoozeFor, setSnoozeFor] = useState(null)
      const [templatesCount, setTemplatesCount] = useState(0)
      const { toast, show, dismiss } = useToast()
      const revisionRef = useRef('')
      const hubRef = useRef(null)

      useEffect(() => { ensureBaseStyles()
      }, [])

      const onAuth = useCallback(() => setAuthLost(true), [])

      /* ---- data ---- */

      const statusPoll = usePoll({ path: ROUTE.state, pollMs: POLL_LIST_MS, paused, onAuth })
      const status = statusPoll.data ?? {}
      const connection = status.connection ?? {}
      const counts = status.counts ?? {}
      const listEnabled = INBOX_MODES.includes(view)
      const listQuery = useMemo( () => ({ q: filters.q === '' ? undefined : filters.q,
          project: filters.project === '' ? undefined : filters.project, reason: filters.reason === '' ? undefined : filters.reason,
          state: filters.state === '' ? undefined : filters.state, sort, limit: 200, }),
        [filters.q, filters.project, filters.reason, filters.state, sort], )
      const listPoll = usePoll({ path: ROUTE.items, query: listQuery, pollMs: POLL_LIST_MS, paused, onAuth, etag: true, enabled: listEnabled })
      const allRows = useMemo(() => (Array.isArray(listPoll.data?.rows) ? listPoll.data.rows : []), [listPoll.data])
      const selectedItem = useMemo( () => allRows.find((item) => item.key === selectedKey) ?? selectedSnapshot,
        [allRows, selectedKey, selectedSnapshot], )
      const detailQuery = useMemo(() => ({ key: selectedKey ?? '' }), [selectedKey])
      const detailPoll = usePoll({ path: ROUTE.item, query: detailQuery, pollMs: reviewPolling ? POLL_RUN_MS : 0,
        enabled: selectedKey !== null, onAuth, })
      const turn = useMemo( () => detailPoll.data?.turn ?? selectedItem?.lastTurn ?? null, [detailPoll.data, selectedItem], )
      const settingsPoll = usePoll({ path: ROUTE.settings, pollMs: 0, paused, onAuth })
      const templatesPoll = usePoll({ path: ROUTE.templates, pollMs: 0, paused, onAuth })
      const runtimeSettings = settingsPoll.data?.settings ?? null

      useEffect(() => { if (Array.isArray(templatesPoll.data?.templates)) setTemplatesCount(templatesPoll.data.templates.length)
      }, [templatesPoll.data])

      useEffect(() => { const revisions = [listPoll.data?.revision, statusPoll.data?.revision, detailPoll.data?.revision].filter(
          (value) => typeof value === 'number', )
        if (revisions.length > 0) revisionRef.current = Math.max(...revisions)
      }, [listPoll.data, statusPoll.data, detailPoll.data])

      useEffect(() => { panelBadge.set(Number(counts.unread) || 0)
      }, [counts.unread])

      useEffect(() => { if (selectedKey === null) return
        setDraft(null)
        setFocusFile(null)
        setDetailTab('overview')
      }, [selectedKey])

      const turnState = turnStateOf(turn, selectedItem)
      useEffect(() => { if (reviewPolling === true && turnState !== 'running') { setReviewPolling(false)
          setReviewPending(false)
        }
      }, [reviewPolling, turnState])

      /* ---- derived rows ---- */

      const visibleRows = useMemo(() => { const mode = view === 'inbox' ? null : view
        return allRows
          .filter((item) => matchesMode(item, mode))
          .filter((item) => matchesQuick(item, quick))
          .filter((item) => (filters.reason === '' ? true : reasonsOf(item).includes(filters.reason) || item.reason === filters.reason))
          .filter((item) => (filters.project === '' ? true : item.project === filters.project))
      }, [allRows, view, quick, filters.reason, filters.project])

      const projectNames = useMemo( () => Array.from(new Set(allRows.map((item) => item.project).filter(Boolean))).sort(), [allRows], )

      /* ---- transport ---- */

      const refreshAll = useCallback(async () => { setAuthLost(false)
        await Promise.all([ statusPoll.refresh(), listEnabled === true ? listPoll.refresh() : Promise.resolve(),
          selectedKey !== null ? detailPoll.refresh() : Promise.resolve(), settingsPoll.refresh(), templatesPoll.refresh(), ])
      }, [statusPoll.refresh, listPoll.refresh, detailPoll.refresh, settingsPoll.refresh, templatesPoll.refresh, listEnabled, selectedKey])

      useEffect(() => { void refreshAll()
      }, [])

      const fail = useCallback( (error, action) => { if (action !== undefined) {
            console.warn('[daily-work-hub] action failed', action, error)
          }
          show(tr('toast.failed', { message: errorMessage(error) }), 'error')
        }, [show], )

      const postAction = useCallback(async (action, key, params, options) => { const body = { action, key, params }
        const confirm = options !== undefined && options.confirm === true
        const headers = confirm === true ? { 'X-DW-Confirm': String(revisionRef.current ?? '') } : undefined
        const data = await postJson(ROUTE.actions, body, headers)
        if (data?.revision !== undefined) revisionRef.current = Number(data.revision)
        if (data?.ok === false) { const error = new Error(String(data.message ?? data.code ?? 'action failed'))
          error.code = data.code
          throw error
        }
        return data ?? {}
      }, [])

      const refreshAfterWrite = useCallback(async () => {
        await Promise.all([statusPoll.refresh(), listPoll.refresh(), selectedKey !== null ? detailPoll.refresh() : Promise.resolve()])
      }, [statusPoll.refresh, listPoll.refresh, detailPoll.refresh, selectedKey])

      /* ---- selection ---- */

      const selectItem = useCallback((item) => { if (item === null || item === undefined) return
        setSelectedKey(item.key)
        setSelectedSnapshot(item)
      }, [])

      const closeDetail = useCallback(() => { setSelectedKey(null)
        setSelectedSnapshot(null)
        setDrawerOpen(false)
        setDraft(null)
      }, [])

      const toggleSelect = useCallback((item) => { setSelectedKeys((prev) => { const next = new Set(prev)
          if (next.has(item.key)) next.delete(item.key)
          else next.add(item.key)
          return next
        })
      }, [])

      const clearChecked = useCallback(() => setSelectedKeys(new Set()), [])

      const selectAllVisible = useCallback(() => { setSelectedKeys(new Set(visibleRows.map((item) => item.key)))
      }, [visibleRows])

      /* ---- item actions ---- */

      const applyState = useCallback( async (action, keys, params, message) => { if (keys.length === 0) return
          const results = await Promise.allSettled(keys.map((key) => postAction(action, key, params)))
          const failed = results.filter((result) => result.status === 'rejected')
          if (failed.length > 0) { const first = failed[0].reason
            if (first?.code === 'confirm-required') show(tr('ai.confirmStaleRevision'), 'error')
            else fail(first, action)
          } else { show(message ?? (keys.length > 1 ? tr('toast.bulk', { n: keys.length }) : tr('toast.done')), 'ok')
          }
          await refreshAfterWrite()
          return failed.length
        }, [postAction, refreshAfterWrite, show, fail], )

      const markAllRead = useCallback(async () => { const keys = visibleRows.map((item) => item.key)
        await applyState('read', keys, undefined, tr('toast.read'))
        clearChecked()
      }, [visibleRows, applyState, clearChecked])

      const bulkAction = useCallback( async (kind) => { const keys = Array.from(selectedKeys)
          if (keys.length === 0) return
          if (kind === 'snooze') { setSnoozeFor({ keys })
            return
          }
          const message = kind === 'read' ? tr('toast.read') : kind === 'ignore' ? tr('toast.ignored') : tr('toast.archived')
          await applyState(kind, keys, undefined, keys.length > 1 ? tr('toast.bulk', { n: keys.length }) : message)
          clearChecked()
        }, [selectedKeys, applyState, clearChecked], )

      const applySnooze = useCallback( async (keys, preset) => { const until = snoozeUntil(preset)
          await applyState('snooze', keys, { until, preset: preset.id }, tr('toast.snoozed', { until: fmtDateTime(until) }))
          clearChecked()
        }, [applyState, clearChecked], )

      /* ---- review / AI ---- */

      const runReview = useCallback( async (key) => { setDrawerOpen(true)
          setReviewPending(true)
          try { await postAction('review', key)
            setReviewPolling(true)
            await detailPoll.refresh()
            await listPoll.refresh()
          } catch (error) { setReviewPolling(false)
            setReviewPending(false)
            fail(error, 'review')
          }
        }, [postAction, detailPoll, listPoll, fail], )

      const adoptFinding = useCallback( async (key, finding) => { try { await postAction('adopt-finding', key, { finding })
            show(tr('ai.addToComment'), 'ok')
            await detailPoll.refresh()
          } catch (error) { fail(error, 'adopt-finding')
          }
        }, [postAction, detailPoll, show, fail], )

      const ignoreFinding = useCallback( async (key, finding) => { try { await postAction('dismiss-finding', key, { finding })
            show(tr('ai.ignoreFinding'), 'ok')
            await detailPoll.refresh()
          } catch (error) { fail(error, 'dismiss-finding')
          }
        }, [postAction, detailPoll, show, fail], )

      const followUp = useCallback( async (key, question) => { try {
            const data = await postAction('summarize', key, { question, followUp: question })
            const answer = pick(data, 'message', 'answer', 'summary')
            show(typeof answer === 'string' && answer !== '' ? answer : tr('toast.done'), 'ok')
            await detailPoll.refresh()
          } catch (error) { show(tr('ai.followupUnsupported'), 'error')
          }
        }, [postAction, detailPoll, show], )

      const draftComment = useCallback( async (key) => { setDrafting(true)
          try { const data = await postAction('draft-comment', key)
            const body = pick(data, 'body') ??
              pick(pick(data, 'data'), 'body') ??
              pick(pick(data, 'item'), 'commentDraft', 'body') ??
              pick(pick(data, 'data'), 'item', 'commentDraft', 'body')
            await detailPoll.refresh()
            if (typeof body === 'string' && body !== '') { setDraft({ body, headSha: selectedItem?.headSha ?? null })
            } else { setDraft(null)
            }
            show(tr('ai.draftReady'), 'ok')
          } catch (error) { fail(error, 'draft-comment')
          } finally { setDrafting(false)
          }
        }, [postAction, detailPoll, show, fail, selectedItem], )

      const publishComment = useCallback( async (item, body) => { if (item === null || item === undefined || body === '') return
          if (isTurnStale(turn, item) || runtimeSettings?.allowWrites === false) { show(tr('toast.publishBlocked'), 'error')
            return
          }
          try { await postAction('publish-comment', item.key, { body, headSha: item.headSha }, { confirm: true })
            setDraft(null)
            show(tr('ai.published'), 'ok')
            await refreshAfterWrite()
          } catch (error) { if (error?.code === 'confirm-required') { show(tr('ai.confirmStaleRevision'), 'error')
              await refreshAfterWrite()
              return
            }
            fail(error, 'publish-comment')
          }
        }, [postAction, refreshAfterWrite, show, fail, turn, runtimeSettings], )

      const jumpToFile = useCallback((finding) => { if (finding === null || finding === undefined || !finding.file) return
        setFocusFile(finding.file)
        setDetailTab('changes')
      }, [])

      const openExternal = useCallback( async (url) => { if (typeof url !== 'string' || url === '') { show(tr('toast.copyFail'), 'error')
            return
          }
          try { const opened = window.open(url, '_blank', 'noopener,noreferrer')
            if (opened === null || opened === undefined) { const ok = await copyText(url)
              show(ok ? tr('toast.openFail') : tr('toast.copyFail'), ok ? 'ok' : 'error')
            }
          } catch { const ok = await copyText(url)
            show(ok ? tr('toast.openFail') : tr('toast.copyFail'), ok ? 'ok' : 'error')
          }
        }, [show], )

      const requestSnooze = useCallback((keys) => setSnoozeFor({ keys }), [])
      const clearFocusFile = useCallback(() => setFocusFile(null), [])

      const togglePause = useCallback(() => { setPaused((prev) => { const next = prev !== true
          show(next ? tr('toast.paused') : tr('toast.resumed'), 'ok')
          return next
        })
        void statusPoll.refresh()
      }, [statusPoll, show])

      /* ---- hub object shared with the views ---- */

      const hub = { view, setView, status, counts, connection, list: listPoll, allRows, visibleRows, filters, setFilters, quick, setQuick,
        sort, setSort, selectedKey, selectedItem, selectItem, clearSelection: closeDetail, selectedKeys, toggleSelect, selectAllVisible,
        clearChecked, drawerOpen, setDrawerOpen, detailTab, setDetailTab, focusFile, clearFocusFile, jumpToFile, hideGenerated,
        setHideGenerated, draft, drafting, runReview, reviewPending, draftComment, publishComment, followUp, adoptFinding, ignoreFinding,
        detail: detailPoll, reloadDetail: detailPoll.refresh, turn, paused, setPaused: togglePause, authLost, refreshAll,
        refreshStatus: statusPoll.refresh, show, onAuth, bulkAction, markAllRead, requestSnooze, applySnooze, settings: runtimeSettings,
        settingsTokenSet: settingsPoll.data?.tokenSet === true, templatesCount, openExternal, }
      hubRef.current = hub

      /* ---- hotkeys ---- */

      useEffect(() => { const onKeyDown = (event) => { if (isTypingTarget(event.target)) return
          const current = hubRef.current
          if (current === null) return
          const withMeta = event.metaKey === true || event.ctrlKey === true
          if (withMeta && String(event.key).toLowerCase() === 'k') { event.preventDefault()
            setPaletteOpen((prev) => !prev)
            return
          }
          if (paletteOpen === true) return
          if (event.altKey === true) return
          const rows = current.visibleRows
          const at = rows.findIndex((item) => item.key === current.selectedKey)
          const move = (delta) => { if (rows.length === 0) return
            const nextIndex = at === -1 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + delta))
            current.selectItem(rows[nextIndex])
          }
          switch (event.key) { case 'j':
              event.preventDefault()
              move(1)
              break
            case 'k':
              event.preventDefault()
              move(-1)
              break
            case 'Enter':
              if (current.selectedKey === null && rows.length > 0) { event.preventDefault()
                current.selectItem(rows[0])
              }
              break
            case 'Escape':
              if (current.drawerOpen === true) { current.setDrawerOpen(false)
              } else if (current.selectedKey !== null) { current.clearSelection()
              } else if (current.selectedKeys.size > 0) { current.clearChecked()
              }
              break
            case 'e':
              if (current.selectedKey !== null) { event.preventDefault()
                void applyState('archive', [current.selectedKey], undefined, tr('toast.archived'))
              }
              break
            case 's':
              if (current.selectedKey !== null) { event.preventDefault()
                current.requestSnooze([current.selectedKey])
              }
              break
            case 'a':
              if (current.selectedKey !== null) { event.preventDefault()
                void current.runReview(current.selectedKey)
              }
              break
            case 'c':
              if (current.selectedKey !== null) { event.preventDefault()
                void current.draftComment(current.selectedKey)
              }
              break
            case 'r':
              event.preventDefault()
              void current.refreshAll()
              break
            default:
              break
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [paletteOpen, applyState])

      /* ---- palette items ---- */

      const paletteItems = useMemo(() => { const items = []
        const viewIcons = { inbox: 'inbox', review: 'queue', work: 'work', projects: 'proj', jobs: 'clock', prompts: 'prompt', settings: 'gear' }
        for (const id of [...INBOX_MODES, 'jobs', 'prompts', 'settings']) { items.push({ id: `view:${id}`, group: tr('palette.views'),
            label: viewLabel(id), icon: viewIcons[id], hint: id === view ? (LANG === 'en' ? 'current' : '当前') : undefined,
            run: () => setView(id), })
        }
        for (const project of projectNames.slice(0, 8)) { items.push({ id: `project:${project}`, group: tr('palette.projects'),
            label: project, icon: 'proj', run: () => { setView('inbox')
              setFilters((prev) => ({ ...prev, project }))
            }, })
        }
        items.push({ id: 'action:refresh', group: tr('palette.actions'), label: tr('palette.refresh'), icon: 'refresh', hint: 'r',
          run: () => void refreshAll(), })
        items.push({ id: 'action:pause', group: tr('palette.actions'), label: paused ? tr('palette.resume') : tr('palette.pause'),
          icon: paused ? 'play' : 'pause', run: () => togglePause(), })
        items.push({ id: 'action:newJob', group: tr('palette.actions'), label: tr('palette.newJob'), icon: 'plus',
          run: () => setView('jobs'), })
        items.push({ id: 'action:settings', group: tr('palette.actions'), label: tr('palette.settings'), icon: 'gear',
          run: () => setView('settings'), })
        if (selectedKey !== null) { items.push({ id: 'action:review', group: tr('palette.actions'), label: tr('palette.aiReview'),
            icon: 'spark', hint: 'a', run: () => void runReview(selectedKey), })
          items.push({ id: 'action:archive', group: tr('palette.actions'), label: tr('palette.archive'), icon: 'archive', hint: 'e',
            run: () => void applyState('archive', [selectedKey], undefined, tr('toast.archived')), })
        }
        return items
      }, [view, projectNames, paused, selectedKey, refreshAll, togglePause, runReview, applyState])

      /* ---- nav counts ---- */

      const navCounts = { unread: Number(counts.unread) || 0, review: Number(pick(status.nav, 'reviewQueue') ?? counts.review) || 0,
        myWork: Number(pick(status.nav, 'myWork')) || 0,
        projects: projectNames.length > 0 ? projectNames.length : Array.isArray(runtimeSettings?.projects) ? runtimeSettings.projects.length : 0,
        running: Number(pick(status.nav, 'running') ?? counts.running) || 0, prompts: templatesCount, }

      const pollError = statusPoll.error ?? listPoll.error ?? null
      const lastSuccessAt = listPoll.lastSuccessAt ?? statusPoll.lastSuccessAt
      const width = useViewportWidth()
      const narrow = width < BREAK_NARROW

      const inboxMode = INBOX_MODES.includes(view)
      const configured = connection.configured === true
      const showOnboarding = statusPoll.data !== null && configured !== true && inboxMode

      let content = null
      if (view === 'jobs') content = h(JobsView, { hub })
      else if (view === 'prompts') content = h(PromptsView, { hub })
      else if (view === 'settings') content = h(SettingsView, { hub })
      else if (showOnboarding) { content = h( 'div',
          { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 } },
          h(Card, { padding: 24, style: { maxWidth: 460 } }, h(EmptyState, { icon: 'link', title: tr('empty.noGitlabTitle'),
              body: tr('empty.noGitlabBody'), actionLabel: tr('empty.goSettings'), onAction: () => setView('settings'), }), ), )
      } else if (view === 'review') { content = h(InboxWorkspace, { hub, mode: 'review', title: tr('nav.review'),
          countLabel: `${visibleRows.length} ${LANG === 'en' ? 'pending' : '待审'}`, emptyIcon: 'queue', emptyTitle: tr('empty.queueTitle'),
          emptyBody: tr('empty.queueBody'), })
      } else if (view === 'work') { content = h(InboxWorkspace, { hub, mode: 'work', title: tr('nav.work'),
          countLabel: `${visibleRows.length} ${LANG === 'en' ? 'items' : '项'}`, emptyIcon: 'work', emptyTitle: tr('empty.workTitle'),
          emptyBody: tr('empty.workBody'), })
      } else if (view === 'projects') { content = h(InboxWorkspace, { hub, mode: 'projects', title: tr('nav.projects'),
          countLabel: `${projectNames.length} ${LANG === 'en' ? 'projects' : '个项目'}`, emptyIcon: 'proj',
          emptyTitle: tr('empty.projectsTitle'), emptyBody: tr('empty.projectsBody'), })
      } else { content = h(InboxWorkspace, { hub, mode: 'inbox', title: tr('nav.inbox'),
          countLabel: `${Number(counts.unread) || 0} ${LANG === 'en' ? 'unread' : '未读'} · ${Number(listPoll.data?.total) || visibleRows.length} ${LANG === 'en' ? 'items' : '项'}`,
          emptyIcon: 'inbox', emptyTitle: tr('list.emptyTitle'), emptyBody: tr('list.emptyBody'), })
      }

      return h( 'div', { className: 'dw-root', 'data-dw-view': view,
          style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: T.bg, color: T.fg }, }, h( 'div',
          { style: { flex: 1, minHeight: 0, display: 'flex' } }, narrow === true
            ? null
            : h(SidebarNav, { view, onSelect: setView, counts: navCounts, paused, status }), h( 'main',
            { style: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' } }, narrow === true
              ? h( 'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${T.b1}`, flex: 'none' } },
                  h(Icon, { name: 'inbox', size: 14, color: T.fg3 }), h(SelectInput, { value: view, options: [
                      ...INBOX_MODES.map((id) => ({ value: id, label: viewLabel(id) })), { value: 'jobs', label: viewLabel('jobs') },
                      { value: 'prompts', label: viewLabel('prompts') }, { value: 'settings', label: viewLabel('settings') }, ],
                    onChange: setView, style: { flex: 1, maxWidth: 320 }, }), h('span', { style: { flex: 1 } }),
                  h(IconButton, { icon: 'search', title: '⌘K', onClick: () => setPaletteOpen(true) }), )
              : null, h(TopToolbar, { view, selectedItem, quick, onQuick: setQuick, sort, onSort: setSort, onRefresh: refreshAll, paused,
              onTogglePause: togglePause, onOpenPalette: () => setPaletteOpen(true), }), authLost === true
              ? h( 'div', { style: { padding: '8px 16px 0', flex: 'none' } }, h(Banner, { tone: 'error', title: tr('banner.authTitle'),
                    body: tr('banner.authBody'), actions: h(Button, { size: 'sm', onClick: refreshAll }, tr('banner.retry')), }), )
              : pollError !== null
                ? h( 'div', { style: { padding: '8px 16px 0', flex: 'none' } }, h(Banner, { tone: 'warn',
                      title: tr('banner.offline', { message: errorMessage(pollError) }),
                      body: tr('banner.lastSuccess', { ago: lastSuccessAt ? fmtAgo(lastSuccessAt) : tr('common.never') }),
                      actions: h(Button, { size: 'sm', onClick: refreshAll }, tr('banner.retry')), }), )
                : null, paused === true
              ? h( 'div', { style: { padding: '8px 16px 0', flex: 'none' } },
                  h(Banner, { tone: 'warn', title: tr('common.pausePolling'), body: tr('banner.pausedHint') }), )
              : null, content, ), ), h(StatusBar, { status, counts }), paletteOpen === true
          ? h(CommandPalette, { items: paletteItems, onClose: () => setPaletteOpen(false) })
          : null, snoozeFor !== null
          ? h(SnoozeDialog, { onCancel: () => setSnoozeFor(null), onPick: (preset) => { const keys = snoozeFor.keys
                setSnoozeFor(null)
                void applySnooze(keys, preset)
              }, })
          : null, h(Toast, { toast, onDismiss: dismiss }), )
    }

    /** Panel entry — keeps a boundary around the whole surface. */
    function HubPanel() { return h(PanelErrorBoundary, null, h(HubApp))
    }

    /* ==================================================================== *
     * 16. Sidebar icon
     * ==================================================================== */

    /** Tray icon with an unread badge; owner props are `{ size, active }`. */
    function SidebarIcon(props) { const size = props.size ?? 16
      const [badge, setBadge] = useState(panelBadge.value)
      useEffect(() => { panelBadge.listeners.add(setBadge)
        return () => panelBadge.listeners.delete(setBadge)
      }, [])
      const dot = props.active === true ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-bg-danger)'
      const count = Number(badge) || 0
      return h( 'span', { style: { position: 'relative', display: 'inline-flex', width: size, height: size } }, h( 'svg', { width: size,
            height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
            strokeLinejoin: 'round', 'aria-hidden': 'true', style: { color: 'var(--dsw-alias-label-secondary)' }, },
          h('path', { d: 'M2 9h3l1 2h4l1-2h3' }), h('path', { d: 'M2 9l2-6h8l2 6v4H2z' }), ), count > 0
          ? h( 'span', { 'aria-label': `${count}`, style: { position: 'absolute', top: -5, right: -6, minWidth: 12, height: 12,
                  padding: '0 3px', borderRadius: 6, background: 'var(--dsw-alias-state-error-primary)', color: '#fff', fontSize: 8,
                  lineHeight: '12px', textAlign: 'center', fontWeight: 700, }, }, count > 9 ? '9+' : String(count), )
          : props.active === true
            ? null
            : h('span', { style: { position: 'absolute', top: -1, right: -1, width: 5, height: 5, borderRadius: 3, background: dot, }, }), )
    }

    /* ==================================================================== *
     * 17. apply
     * ==================================================================== */

    /**
     * Client plugin body. Registrations are Cordis effects/disposers so a
     * reload leaves no dangling slots.
     * @param {any} ctx client root context (slots, locale, layout).
     * @returns {() => void} teardown that clears the panel selection first.
     */
    function apply(ctx) { try { ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh: ZH, en: EN }), 'daily-work-hub: dictionaries')
      } catch (error) { console.error('[daily-work-hub] locale registration failed', error)
      }

      ensureBaseStyles()

      let offPanel
      let offRow
      try { offPanel = ctx.slots.inject('main', () => ctx.slots.register( { name: 'main', key: PANEL_ID, locale: LOCALE_NS }, HubPanel, ), )
      } catch (error) { console.error('[daily-work-hub] main slot registration failed', error)
      }
      try { offRow = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register( { name: 'sidebar.panellist', id: PANEL_ID, order: 1,
              label: () => (LANG === 'en' ? 'Daily work hub' : '日常工作台'), locale: LOCALE_NS, },
            (owner = {}) => h(SidebarIcon, { size: owner.size ?? 16, active: owner.active === true }), ), )
      } catch (error) { console.error('[daily-work-hub] sidebar.panellist registration failed', error)
      }

      return () => {
        // Order matters: if this panel is the active one, clear the selection
        // before its `main` entry disappears, or the centre column keeps an id
        // that no longer resolves.
        try { const layout = ctx.get('layout')
          if (layout?.panelInfo?.getSnapshot?.().activePanelId === PANEL_ID) layout.selectPanel(null)
        } catch { /* layout may already be gone during teardown */
        }
        try { if (typeof offRow === 'function') offRow()
        } catch { /* slot may already be gone */
        }
        try { if (typeof offPanel === 'function') offPanel()
        } catch { /* slot may already be gone */
        }
      }
    }

    return { name: 'daily-work-hub', inject: ['slots', 'locale', 'layout'], apply }
  }, })