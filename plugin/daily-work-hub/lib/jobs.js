/**
 * Job definitions: builtin seeds, validation, normalization and parameter binding.
 *
 * Everything here is pure (no store, no clock): the caller loads jobs, edits the
 * plain object and hands it back. Field ranges mirror CONTRACTS §5; anything the
 * panel may save must pass {@link validateJob} first.
 */

import { isValidTimeZone, parseCron } from './cron.js'

const TRIGGER_KINDS = ['manual', 'cron', 'event', 'after']
const EXECUTOR_KINDS = ['session', 'headless', 'command', 'dry-run']
const OUTPUT_KINDS = ['artifact', 'card', 'notification', 'workitem', 'none']
const NOTIFY_KINDS = ['card', 'notification', 'none']
const ACCESS_KINDS = ['read-only', 'workspace-write']
const PARAM_TYPES = ['string', 'number', 'enum', 'bool']
const CATCH_UP_KINDS = ['skip', 'run-once']
const AFTER_STATUS = ['success', 'failure']

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/
const LANE_PATTERN = /^[A-Za-z0-9#._:/@-]{1,64}$/
const PARAM_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
const BACKOFF_PATTERN = /^\d{1,4}(s|m|h|d)$/
const QUIET_PATTERN = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/

/** Defaults merged into every saved job. */
const DEFAULT_POLICY = {
  concurrency: 1,
  timeoutMin: 10,
  retry: { max: 1, backoff: '5m' },
  maxRunsPerDay: 4,
  quietHours: [],
}

/** Default trigger-zone for cron jobs when the panel does not send one. */
const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

/**
 * Tell whether a value is a plain object (not null, not an array).
 * @param {unknown} value candidate.
 * @returns {boolean} true for `{}`-like values.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Record one validation error.
 * @param {{ field: string, message: string }[]} errors collector.
 * @param {string} field dotted field path.
 * @param {string} message Chinese explanation.
 */
function fail(errors, field, message) {
  errors.push({ field, message })
}

/**
 * Validate a whole number within inclusive bounds.
 * @param {unknown} value candidate.
 * @param {number} min lower bound.
 * @param {number} max upper bound.
 * @returns {boolean} true when `value` is an integer in range.
 */
function isIntInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max
}

/**
 * Whether a `HH:MM-HH:MM` quiet-hours range is valid.
 * @param {unknown} range candidate range.
 * @returns {boolean} true when both clock times exist and the range is written correctly.
 */
function isQuietRange(range) {
  if (typeof range !== 'string') return false
  const match = QUIET_PATTERN.exec(range)
  if (!match) return false
  const startHour = Number(match[1])
  const startMinute = Number(match[2])
  const endHour = Number(match[3])
  const endMinute = Number(match[4])
  return startHour <= 23 && startMinute <= 59 && endHour <= 23 && endMinute <= 59
}

/**
 * Whether an output path template is a safe workspace-relative path.
 * @param {unknown} template candidate template.
 * @returns {boolean} true when relative and free of `..` segments.
 */
function isSafeArtifactPath(template) {
  if (typeof template !== 'string' || template.trim() === '') return false
  const text = template.trim().replace(/\\/g, '/')
  if (text.startsWith('/') || /^[A-Za-z]:[^/]/.test(text) || /^[A-Za-z]:\//.test(text)) return false
  return !text.split('/').includes('..')
}

/**
 * Build a stable job id from an ASCII name, falling back to a timestamp id.
 * @param {string} name display name, possibly Chinese.
 * @returns {string} id matching {@link ID_PATTERN}.
 */
function generateJobId(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const suffix = Math.random().toString(36).slice(2, 6)
  const base = slug === '' ? `job-${Date.now().toString(36)}` : `job-${slug}`
  return `${base}-${suffix}`.slice(0, 64).replace(/-+$/g, '')
}

/**
 * Resolve the existing record an edit refers to.
 * @param {object|object[]|undefined} existing single record, list, or nothing.
 * @param {{ id?: string, name?: string }} input incoming job.
 * @returns {object|undefined} matching record.
 */
function resolveExisting(existing, input) {
  if (Array.isArray(existing)) {
    return existing.find(
      (job) =>
        (input.id !== undefined && job.id === input.id) ||
        (job.name !== undefined && job.name === input.name),
    )
  }
  return isPlainObject(existing) ? existing : undefined
}

/**
 * Validate a job definition. Uniqueness is checked against `existing` jobs, which
 * the caller loads from the store (CONTRACTS §3); pass an empty list when saving
 * a brand-new job.
 * @param {unknown} input candidate definition.
 * @param {object[]|object} [existing] other saved jobs, for the unique-name check.
 * @returns {{ ok: boolean, errors: { field: string, message: string }[] }} validation result.
 */
export function validateJob(input, existing = []) {
  const errors = []
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ field: '', message: '任务定义必须是对象' }] }
  }

  if (input.id !== undefined && (typeof input.id !== 'string' || !ID_PATTERN.test(input.id))) {
    fail(errors, 'id', 'id 必须是以字母或数字开头的 2–64 位小写字母、数字或连字符')
  }
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    fail(errors, 'name', '名称必填')
  } else if (input.name.trim().length > 80) {
    fail(errors, 'name', '名称最多 80 个字符')
  }

  const others = (Array.isArray(existing) ? existing : [existing]).filter(
    (job) => isPlainObject(job) && job.id !== input.id,
  )
  if (typeof input.name === 'string' && input.name.trim() !== '') {
    const duplicate = others.find(
      (job) => typeof job.name === 'string' && job.name.trim() === input.name.trim(),
    )
    if (duplicate) fail(errors, 'name', `名称已被任务 ${duplicate.id} 使用`)
  }

  if (input.description !== undefined && typeof input.description !== 'string') {
    fail(errors, 'description', '描述必须是字符串')
  }
  if (input.icon !== undefined && typeof input.icon !== 'string') {
    fail(errors, 'icon', '图标必须是字符串')
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    fail(errors, 'enabled', '启用状态必须是布尔值')
  }
  if (input.version !== undefined && !isIntInRange(input.version, 1, 1_000_000)) {
    fail(errors, 'version', '版本号必须是正整数')
  }
  if (input.builtin !== undefined && typeof input.builtin !== 'boolean') {
    fail(errors, 'builtin', '内置标记必须是布尔值')
  }

  validateTrigger(input.trigger, errors)
  validateExecutor(input.executor, errors)
  validateParams(input.params, errors)
  validateInputs(input.inputs, errors)
  validateOutput(input.output, errors)
  validatePolicy(input.policy, errors)
  validateFanOut(input.fanOut, errors)

  return { ok: errors.length === 0, errors }
}

/**
 * Validate the trigger block.
 * @param {unknown} trigger trigger definition.
 * @param {{ field: string, message: string }[]} errors collector.
 */
function validateTrigger(trigger, errors) {
  if (!isPlainObject(trigger)) {
    fail(errors, 'trigger', '触发器必填')
    return
  }
  if (!TRIGGER_KINDS.includes(trigger.kind)) {
    fail(errors, 'trigger.kind', `触发器类型必须是 ${TRIGGER_KINDS.join(' / ')}`)
    return
  }
  if (trigger.catchUp !== undefined && !CATCH_UP_KINDS.includes(trigger.catchUp)) {
    fail(errors, 'trigger.catchUp', '补跑策略必须是 skip 或 run-once')
  }
  if (trigger.tz !== undefined && !isValidTimeZone(trigger.tz)) {
    fail(errors, 'trigger.tz', `无效时区: ${String(trigger.tz)}`)
  }

  if (trigger.kind === 'cron') {
    if (typeof trigger.cron !== 'string' || trigger.cron.trim() === '') {
      fail(errors, 'trigger.cron', 'cron 触发必须填写 5 段表达式')
    } else {
      try {
        parseCron(trigger.cron)
      } catch (error) {
        fail(errors, 'trigger.cron', error.message)
      }
      if (trigger.tz === undefined) {
        fail(errors, 'trigger.tz', `cron 触发必须指定时区，例如 ${DEFAULT_TIME_ZONE}`)
      }
    }
  }

  if (trigger.kind === 'event') {
    if (!Array.isArray(trigger.events) || trigger.events.length === 0) {
      fail(errors, 'trigger.events', '事件触发必须至少选择一个事件')
    } else if (trigger.events.some((event) => typeof event !== 'string' || event.trim() === '')) {
      fail(errors, 'trigger.events', '事件名必须是非空字符串')
    }
  }

  if (trigger.kind === 'after') {
    const after = trigger.after
    if (!isPlainObject(after)) {
      fail(errors, 'trigger.after', 'after 触发必须配置上游任务')
      return
    }
    if (!Array.isArray(after.jobIds) || after.jobIds.length === 0) {
      fail(errors, 'trigger.after.jobIds', 'after 触发必须至少指定一个上游任务 id')
    } else if (after.jobIds.some((id) => typeof id !== 'string' || !ID_PATTERN.test(id))) {
      fail(errors, 'trigger.after.jobIds', '上游任务 id 格式不合法')
    }
    if (after.status !== undefined && !AFTER_STATUS.includes(after.status)) {
      fail(errors, 'trigger.after.status', '上游状态必须是 success 或 failure')
    }
  }
}

/**
 * Validate the executor block, including the presence rules for command jobs.
 * @param {unknown} executor executor definition.
 * @param {{ field: string, message: string }[]} errors collector.
 */
function validateExecutor(executor, errors) {
  if (!isPlainObject(executor)) {
    fail(errors, 'executor', '执行器必填')
    return
  }
  if (!EXECUTOR_KINDS.includes(executor.kind)) {
    fail(errors, 'executor.kind', `执行器类型必须是 ${EXECUTOR_KINDS.join(' / ')}`)
    return
  }
  if (executor.access !== undefined && !ACCESS_KINDS.includes(executor.access)) {
    fail(errors, 'executor.access', '权限必须是 read-only 或 workspace-write')
  }
  for (const field of ['template', 'skill', 'prompt', 'cwd', 'command']) {
    if (executor[field] !== undefined && typeof executor[field] !== 'string') {
      fail(errors, `executor.${field}`, `${field} 必须是字符串`)
    }
  }

  if (executor.kind === 'command') {
    if (typeof executor.command !== 'string' || executor.command.trim() === '') {
      fail(errors, 'executor.command', '命令执行器必须填写 command')
    }
    if (typeof executor.cwd !== 'string' || executor.cwd.trim() === '') {
      fail(errors, 'executor.cwd', '命令执行器必须填写工作目录 cwd')
    }
  }

  if (executor.kind === 'session' || executor.kind === 'headless') {
    const configured = [executor.template, executor.skill, executor.prompt].filter(
      (value) => typeof value === 'string' && value.trim() !== '',
    )
    if (configured.length === 0) {
      fail(errors, `executor.${executor.kind}`, '会话执行器必须配置 template、skill 或 prompt 之一')
    }
    if (executor.cwd !== undefined && executor.cwd.trim() === '') {
      fail(errors, 'executor.cwd', '工作目录不能为空字符串')
    }
  }
}

/**
 * Validate the parameter declarations.
 * @param {unknown} params parameter list.
 * @param {{ field: string, message: string }[]} errors collector.
 */
function validateParams(params, errors) {
  if (params === undefined) return
  if (!Array.isArray(params)) {
    fail(errors, 'params', '参数必须是数组')
    return
  }
  const seen = new Set()
  params.forEach((param, index) => {
    const field = `params[${index}]`
    if (!isPlainObject(param)) {
      fail(errors, field, '参数声明必须是对象')
      return
    }
    if (typeof param.key !== 'string' || !PARAM_KEY_PATTERN.test(param.key)) {
      fail(errors, `${field}.key`, '参数 key 必须是字母开头的 1–32 位字母、数字、下划线或连字符')
    } else if (seen.has(param.key)) {
      fail(errors, `${field}.key`, `参数 key 重复: ${param.key}`)
    } else {
      seen.add(param.key)
    }
    if (!PARAM_TYPES.includes(param.type)) {
      fail(errors, `${field}.type`, `参数类型必须是 ${PARAM_TYPES.join(' / ')}`)
      return
    }
    if (param.required !== undefined && typeof param.required !== 'boolean') {
      fail(errors, `${field}.required`, 'required 必须是布尔值')
    }
    if (param.type === 'enum') {
      if (!Array.isArray(param.values) || param.values.length === 0) {
        fail(errors, `${field}.values`, '枚举参数必须提供 values')
      } else if (
        param.default !== undefined &&
        !param.values.some((value) => String(value) === String(param.default))
      ) {
        fail(errors, `${field}.default`, '枚举默认值必须出现在 values 中')
      }
    }
    if (param.default !== undefined) {
      const valid = matchesParamType(param.type, param.default, param.values)
      if (!valid) fail(errors, `${field}.default`, '默认值与参数类型不匹配')
    }
  })
}

/**
 * Tell whether a value fits a declared parameter type.
 * @param {'string'|'number'|'enum'|'bool'} type parameter type.
 * @param {unknown} value candidate value.
 * @param {unknown[]} [values] enum values.
 * @returns {boolean} true when the value is valid for the type.
 */
function matchesParamType(type, value, values) {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'bool') return typeof value === 'boolean'
  if (type === 'enum') {
    return Array.isArray(values) && values.some((candidate) => String(candidate) === String(value))
  }
  return false
}

/**
 * Validate the input source list.
 * @param {unknown} inputs input sources.
 * @param {{ field: string, message: string }[]} errors collector.
 */
function validateInputs(inputs, errors) {
  if (inputs === undefined) return
  if (!Array.isArray(inputs) || inputs.some((item) => typeof item !== 'string' || item.trim() === '')) {
    fail(errors, 'inputs', 'inputs 必须是非空字符串数组')
  }
}

/**
 * Validate the output block.
 * @param {unknown} output output definition.
 * @param {{ field: string, message: string }[]} errors collector.
 */
function validateOutput(output, errors) {
  if (!isPlainObject(output)) {
    fail(errors, 'output', '产出配置必填')
    return
  }
  if (!OUTPUT_KINDS.includes(output.kind)) {
    fail(errors, 'output.kind', `产出类型必须是 ${OUTPUT_KINDS.join(' / ')}`)
    return
  }
  if (output.kind === 'artifact') {
    if (!isSafeArtifactPath(output.path)) {
      fail(errors, 'output.path', '产物路径必须是工作区内的相对路径，且不能包含 ..')
    }
  } else if (output.path !== undefined && typeof output.path !== 'string') {
    fail(errors, 'output.path', '产物路径必须是字符串')
  }
  if (output.notify !== undefined && !NOTIFY_KINDS.includes(output.notify)) {
    fail(errors, 'output.notify', `通知方式必须是 ${NOTIFY_KINDS.join(' / ')}`)
  }
}

/**
 * Validate the policy block: numeric ranges, lane key, retry and quiet hours.
 * @param {unknown} policy policy definition.
 * @param {{ field: string, message: string }[]} errors collector.
 */
function validatePolicy(policy, errors) {
  if (!isPlainObject(policy)) {
    fail(errors, 'policy', '策略配置必填')
    return
  }
  if (policy.concurrency !== undefined && !isIntInRange(policy.concurrency, 1, 16)) {
    fail(errors, 'policy.concurrency', '并发数必须是 1–16 的整数')
  }
  if (policy.laneKey !== undefined && (typeof policy.laneKey !== 'string' || !LANE_PATTERN.test(policy.laneKey))) {
    fail(errors, 'policy.laneKey', 'laneKey 必须是 1–64 位字母、数字或 #._:/@-')
  }
  if (policy.timeoutMin !== undefined) {
    const valid = typeof policy.timeoutMin === 'number' && policy.timeoutMin >= 0 && policy.timeoutMin <= 1440
    if (!valid) fail(errors, 'policy.timeoutMin', '超时必须是 0–1440 分钟的数字（0 表示不超时）')
  }
  if (policy.maxRunsPerDay !== undefined && !isIntInRange(policy.maxRunsPerDay, 0, 200)) {
    fail(errors, 'policy.maxRunsPerDay', '每日上限必须是 0–200 的整数（0 表示不限）')
  }
  if (policy.dryRun !== undefined && typeof policy.dryRun !== 'boolean') {
    fail(errors, 'policy.dryRun', 'dryRun 必须是布尔值')
  }
  if (policy.retry !== undefined) {
    if (!isPlainObject(policy.retry)) {
      fail(errors, 'policy.retry', '重试配置必须是对象')
    } else {
      if (policy.retry.max !== undefined && !isIntInRange(policy.retry.max, 0, 5)) {
        fail(errors, 'policy.retry.max', '重试次数必须是 0–5 的整数')
      }
      if (policy.retry.backoff !== undefined && (typeof policy.retry.backoff !== 'string' || !BACKOFF_PATTERN.test(policy.retry.backoff))) {
        fail(errors, 'policy.retry.backoff', '退避必须形如 30s / 5m / 2h / 1d')
      }
    }
  }
  if (policy.quietHours !== undefined) {
    if (!Array.isArray(policy.quietHours) || policy.quietHours.some((range) => !isQuietRange(range))) {
      fail(errors, 'policy.quietHours', '静默时段必须是 HH:MM-HH:MM 数组')
    }
  }
}

/**
 * Validate the optional fan-out descriptor.
 * @param {unknown} fanOut fan-out block.
 * @param {{ field: string, message: string }[]} errors collector.
 */
function validateFanOut(fanOut, errors) {
  if (fanOut === undefined) return
  if (!isPlainObject(fanOut)) {
    fail(errors, 'fanOut', 'fanOut 必须是对象')
    return
  }
  if (typeof fanOut.source !== 'string' || fanOut.source.trim() === '') {
    fail(errors, 'fanOut.source', 'fanOut.source 必须是非空字符串')
  }
  if (fanOut.limit !== undefined && !isIntInRange(fanOut.limit, 1, 50)) {
    fail(errors, 'fanOut.limit', 'fanOut.limit 必须是 1–50 的整数')
  }
}

/**
 * Normalize a job definition: fill defaults, merge the current record for edits,
 * assign an id when absent and bump `version`.
 * @param {object} input incoming definition.
 * @param {object|object[]} [existing] current record(s); an array is searched by id/name.
 * @returns {object} normalized job, safe to persist through `store.jobs.put`.
 */
export function normalizeJob(input, existing) {
  const source = isPlainObject(input) ? input : {}
  const current = resolveExisting(existing, source)
  const name = typeof source.name === 'string' && source.name.trim() !== '' ? source.name.trim() : (current?.name ?? '未命名任务')
  const id =
    typeof source.id === 'string' && ID_PATTERN.test(source.id)
      ? source.id
      : (current?.id ?? generateJobId(name))

  const triggerSource = isPlainObject(source.trigger) ? source.trigger : (current?.trigger ?? {})
  const executorSource = isPlainObject(source.executor) ? source.executor : (current?.executor ?? {})
  const outputSource = isPlainObject(source.output) ? source.output : (current?.output ?? {})
  const policySource = isPlainObject(source.policy) ? source.policy : (current?.policy ?? {})

  const trigger = { kind: 'manual', ...triggerSource }
  if (trigger.kind === 'cron' && trigger.tz === undefined) trigger.tz = DEFAULT_TIME_ZONE
  if (trigger.kind === 'cron' && trigger.catchUp === undefined) trigger.catchUp = 'skip'

  const executor = { kind: 'session', ...executorSource }
  if (executor.access === undefined) executor.access = 'read-only'

  const policy = {
    ...DEFAULT_POLICY,
    ...policySource,
    retry: { ...DEFAULT_POLICY.retry, ...(isPlainObject(policySource.retry) ? policySource.retry : {}) },
    quietHours: Array.isArray(policySource.quietHours)
      ? [...policySource.quietHours]
      : (current?.policy?.quietHours ?? DEFAULT_POLICY.quietHours),
  }

  const previousVersion = Number.isInteger(current?.version)
    ? current.version
    : Number.isInteger(source.version)
      ? source.version
      : 0

  return {
    ...(current ?? {}),
    ...source,
    id,
    name,
    description: source.description ?? current?.description ?? '',
    icon: source.icon ?? current?.icon ?? 'calendar',
    enabled: source.enabled ?? current?.enabled ?? true,
    version: previousVersion + 1,
    builtin: source.builtin ?? current?.builtin ?? false,
    trigger,
    executor,
    params: Array.isArray(source.params)
      ? [...source.params]
      : (current?.params ?? []),
    inputs: Array.isArray(source.inputs) ? [...source.inputs] : (current?.inputs ?? []),
    output: { kind: outputSource.kind ?? current?.output?.kind ?? 'none', ...outputSource },
    policy,
  }
}

/**
 * Collect the default value of every declared parameter.
 * @param {object} job job definition.
 * @returns {Record<string, unknown>} key → default value (missing ones omitted).
 */
export function paramDefaults(job) {
  const params = {}
  const declarations = Array.isArray(job?.params) ? job.params : []
  for (const declaration of declarations) {
    if (!isPlainObject(declaration) || typeof declaration.key !== 'string') continue
    if (declaration.default !== undefined) params[declaration.key] = declaration.default
  }
  return params
}

/**
 * Bind caller-supplied parameters onto a job's declarations, applying defaults
 * and rejecting unknown keys or values outside the declared type.
 * @param {object} job job definition.
 * @param {object|null|undefined} input raw parameter values.
 * @returns {{ ok: boolean, params: Record<string, unknown>, errors: { field: string, message: string }[] }} coerced values.
 */
export function coerceParams(job, input) {
  const errors = []
  const raw = isPlainObject(input) ? input : {}
  const declarations = Array.isArray(job?.params) ? job.params : []
  const known = new Set()

  for (const declaration of declarations) {
    if (!isPlainObject(declaration) || typeof declaration.key !== 'string') continue
    known.add(declaration.key)
  }
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) fail(errors, key, `未知参数: ${key}`)
  }

  const params = { ...paramDefaults(job) }
  for (const declaration of declarations) {
    if (!isPlainObject(declaration) || typeof declaration.key !== 'string') continue
    const key = declaration.key
    const provided = Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined
    const value = provided ? raw[key] : declaration.default

    if (value === undefined) {
      if (declaration.required === true) fail(errors, key, `参数 ${key} 必填`)
      else delete params[key]
      continue
    }

    switch (declaration.type) {
      case 'string': {
        if (typeof value !== 'string') fail(errors, key, `参数 ${key} 必须是字符串`)
        else params[key] = value
        break
      }
      case 'number': {
        const text = typeof value === 'string' ? value.trim() : value
        if (text === '' || typeof text === 'object' || !Number.isFinite(Number(text))) {
          fail(errors, key, `参数 ${key} 必须是数字`)
        } else {
          params[key] = Number(text)
        }
        break
      }
      case 'bool': {
        const bool = toBool(value)
        if (bool === undefined) fail(errors, key, `参数 ${key} 必须是布尔值`)
        else params[key] = bool
        break
      }
      case 'enum': {
        const values = Array.isArray(declaration.values) ? declaration.values : []
        const matched = values.find((candidate) => String(candidate) === String(value))
        if (matched === undefined) {
          fail(errors, key, `参数 ${key} 必须是 ${values.map((item) => String(item)).join(' / ')} 之一`)
        } else {
          params[key] = matched
        }
        break
      }
      default:
        fail(errors, key, `参数 ${key} 的类型 ${String(declaration.type)} 不受支持`)
    }
  }

  return { ok: errors.length === 0, params, errors }
}

/**
 * Convert common truthy/falsy representations to a boolean.
 * @param {unknown} value candidate.
 * @returns {boolean|undefined} parsed boolean, or undefined when unparseable.
 */
function toBool(value) {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === '1') return true
    if (text === 'false' || text === '0') return false
  }
  return undefined
}

/**
 * Builtin jobs shipped with the plugin. They are ordinary records: the user may
 * copy or edit them, and `store.jobs` owns persistence.
 */
export const SEED_JOBS = [
  {
    id: 'job-weekly-report',
    name: '周五周报',
    description: '每周五 18:00 汇总本周提交与已合并 MR，生成周报草稿',
    icon: 'file-text',
    enabled: true,
    trigger: { kind: 'cron', cron: '0 18 * * 5', tz: 'Asia/Shanghai', catchUp: 'skip' },
    executor: {
      kind: 'session',
      skill: 'work-report-writer',
      prompt: '汇总本周（{{range}}）的提交、已合并 MR 与未完成事项，输出中文周报草稿。',
      cwd: '.',
      access: 'read-only',
    },
    params: [
      {
        key: 'range',
        type: 'enum',
        values: ['this-week', 'last-week'],
        default: 'this-week',
      },
    ],
    inputs: ['gitlab.commits', 'gitlab.mergedMRs'],
    output: { kind: 'artifact', path: 'reports/weekly-{{date}}.md', notify: 'card' },
    policy: {
      concurrency: 1,
      timeoutMin: 10,
      retry: { max: 1, backoff: '5m' },
      maxRunsPerDay: 4,
      quietHours: [],
    },
    builtin: true,
  },
  {
    id: 'job-morning-brief',
    name: '每日早报',
    description: '工作日 08:00 生成当日待办与需关注变更的早报',
    icon: 'sunrise',
    enabled: true,
    trigger: { kind: 'cron', cron: '0 8 * * 1-5', tz: 'Asia/Shanghai', catchUp: 'skip' },
    executor: {
      kind: 'session',
      skill: 'work-report-writer',
      prompt: '生成今日早报：待审 MR、需回复的讨论、今日到期事项。',
      cwd: '.',
      access: 'read-only',
    },
    params: [],
    inputs: ['items.reviewQueue', 'items.myWork'],
    output: { kind: 'notification', notify: 'notification' },
    policy: {
      concurrency: 1,
      timeoutMin: 5,
      retry: { max: 1, backoff: '2m' },
      maxRunsPerDay: 2,
      quietHours: [],
    },
    builtin: true,
  },
  {
    id: 'job-dependency-check',
    name: '依赖巡检',
    description: '每周一 09:00 检查依赖过期情况并留下报告',
    icon: 'package',
    enabled: true,
    trigger: { kind: 'cron', cron: '0 9 * * 1', tz: 'Asia/Shanghai', catchUp: 'skip' },
    executor: {
      kind: 'command',
      command: 'npm outdated --json',
      cwd: '.',
      access: 'read-only',
    },
    params: [],
    inputs: [],
    output: { kind: 'artifact', path: 'reports/dependencies-{{date}}.json' },
    policy: {
      concurrency: 1,
      timeoutMin: 5,
      retry: { max: 0, backoff: '5m' },
      maxRunsPerDay: 1,
      quietHours: [],
    },
    builtin: true,
  },
  {
    id: 'job-review-batch',
    name: '批量审查',
    description: '手动对审查队列中的 MR 批量展开审查（最多 5 个，3 路并行）',
    icon: 'layers',
    enabled: true,
    trigger: { kind: 'manual' },
    executor: {
      kind: 'session',
      prompt: '对选中的每个 MR 逐个执行审查，最后汇总成一张待拍板卡片。',
      cwd: '.',
      access: 'read-only',
    },
    params: [
      { key: 'limit', type: 'number', default: 5 },
      { key: 'dryRun', type: 'bool', default: true },
    ],
    inputs: ['items.reviewQueue'],
    fanOut: { source: 'items.reviewQueue', limit: 5 },
    output: { kind: 'card', notify: 'card' },
    policy: {
      concurrency: 3,
      timeoutMin: 20,
      retry: { max: 1, backoff: '5m' },
      maxRunsPerDay: 5,
      quietHours: [],
    },
    builtin: true,
  },
].map((job) => normalizeJob(job))