/**
 * Zero-dependency 5-field Vixie cron: parsing, matching, next-instant search and
 * a short Chinese description.
 *
 * Time zones: a wall-clock candidate is built as a pseudo-UTC timestamp (UTC
 * getters over the *local* calendar fields), then resolved back to a real
 * instant by subtracting the zone offset sampled around that wall time. A local
 * time that does not exist (spring-forward gap) resolves to `null` and the
 * search moves on to the next minute; an ambiguous time (fall-back) produces two
 * instants and the earliest one strictly after `fromMs` wins. DST edges never
 * throw — only malformed expressions and unknown IANA ids do.
 *
 * Day-of-month / day-of-week follow Vixie's OR rule: when both are restricted, a
 * date matches if EITHER matches. A field written as `*` is unrestricted.
 */

const MINUTE_MS = 60_000

/** Upper bound on wall-clock steps per `nextRunAt` call; rare expressions bail out with null. */
const SEARCH_LIMIT = 50_000

/** Field order and allowed range, index 0 is the minute field of a 5-field expression. */
const FIELD_SPECS = [
  { key: 'minutes', name: 'minute', min: 0, max: 59 },
  { key: 'hours', name: 'hour', min: 0, max: 23 },
  { key: 'daysOfMonth', name: 'day-of-month', min: 1, max: 31 },
  { key: 'months', name: 'month', min: 1, max: 12 },
  { key: 'daysOfWeek', name: 'day-of-week', min: 0, max: 7 },
]

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** Cache of `Intl.DateTimeFormat` instances keyed by IANA zone. */
const formatters = new Map()

/**
 * Parse one cron field into the sorted set of allowed values.
 * Supports `*`, `a`, `a-b`, `*​/n`, `a-b/n`, `a/n` and comma lists of those.
 * Day-of-week accepts 7 as Sunday and folds it to 0.
 * @param {string} raw raw field text.
 * @param {{ key: string, name: string, min: number, max: number }} spec field spec.
 * @returns {number[]} sorted unique allowed values.
 */
function parseField(raw, spec) {
  const text = String(raw).trim()
  if (text === '') throw new Error(`cron 的 ${spec.name} 字段为空`)

  const values = new Set()
  for (const item of text.split(',')) {
    const piece = item.trim()
    if (piece === '') throw new Error(`cron 的 ${spec.name} 字段包含空项: "${raw}"`)

    const chunks = piece.split('/')
    if (chunks.length > 2) throw new Error(`cron 的 ${spec.name} 字段无法解析: "${piece}"`)
    const base = chunks[0].trim()
    const step = chunks.length === 2 ? parseStep(chunks[1], spec, piece) : 1

    let start
    let end
    if (base === '*') {
      start = spec.min
      end = spec.max
    } else if (base.includes('-')) {
      const bounds = base.split('-')
      if (bounds.length !== 2) throw new Error(`cron 的 ${spec.name} 字段范围无法解析: "${piece}"`)
      start = parseValue(bounds[0], spec, piece)
      end = parseValue(bounds[1], spec, piece)
      if (start > end) {
        throw new Error(`cron 的 ${spec.name} 字段范围起点大于终点: "${piece}"`)
      }
    } else {
      start = parseValue(base, spec, piece)
      end = chunks.length === 2 ? spec.max : start
    }

    for (let value = start; value <= end; value += step) {
      values.add(spec.key === 'daysOfWeek' && value === 7 ? 0 : value)
    }
  }

  if (values.size === 0) throw new Error(`cron 的 ${spec.name} 字段没有可用取值: "${raw}"`)
  return [...values].sort((a, b) => a - b)
}

/**
 * Parse a cron step (`/n`) as a positive integer.
 * @param {string} raw raw step text.
 * @param {{ name: string }} spec owning field.
 * @param {string} piece full list item, for the error message.
 * @returns {number} step >= 1.
 */
function parseStep(raw, spec, piece) {
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) {
    throw new Error(`cron 的 ${spec.name} 字段步长必须是正整数: "${piece}"`)
  }
  const step = Number(text)
  if (step < 1) throw new Error(`cron 的 ${spec.name} 字段步长必须 ≥ 1: "${piece}"`)
  return step
}

/**
 * Parse and range-check one numeric field value.
 * @param {string} raw raw value text.
 * @param {{ name: string, min: number, max: number }} spec owning field.
 * @param {string} piece full list item, for the error message.
 * @returns {number} validated value.
 */
function parseValue(raw, spec, piece) {
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) {
    throw new Error(`cron 的 ${spec.name} 字段必须是数字: "${piece}"`)
  }
  const value = Number(text)
  if (value < spec.min || value > spec.max) {
    throw new Error(
      `cron 的 ${spec.name} 字段超出范围 ${spec.min}-${spec.max}: "${piece}"`,
    )
  }
  return value
}

/**
 * Parse a 5-field cron expression, validating every field.
 * @param {string} expr expression such as `0 18 * * 5`.
 * @returns {{ expression: string, minutes: number[], hours: number[],
 *   daysOfMonth: number[], months: number[], daysOfWeek: number[],
 *   domAny: boolean, dowAny: boolean, fields: Record<string, string> }} parsed form.
 * @throws {Error} on wrong field count, out-of-range values or bad ranges/steps.
 */
export function parseCron(expr) {
  if (typeof expr !== 'string') throw new Error('cron 表达式必须是字符串')
  const text = expr.trim()
  if (text === '') throw new Error('cron 表达式为空')
  const parts = text.split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(
      `cron 表达式必须由 5 个字段组成（分 时 日 月 周），实际收到 ${parts.length} 个: "${text}"`,
    )
  }

  const parsed = {
    expression: text,
    fields: {
      minute: parts[0],
      hour: parts[1],
      dayOfMonth: parts[2],
      month: parts[3],
      dayOfWeek: parts[4],
    },
  }
  for (let index = 0; index < FIELD_SPECS.length; index += 1) {
    parsed[FIELD_SPECS[index].key] = parseField(parts[index], FIELD_SPECS[index])
  }
  parsed.domAny = parts[2].trim() === '*'
  parsed.dowAny = parts[4].trim() === '*'
  return parsed
}

/**
 * Build (and cache) the formatter used to read wall-clock fields for one zone.
 * @param {string} timeZone IANA zone id.
 * @returns {Intl.DateTimeFormat} formatter.
 */
function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/**
 * Validate and normalize an IANA time zone id.
 * @param {string} timeZone candidate id, e.g. `Asia/Shanghai` or `UTC`.
 * @returns {string} trimmed id.
 * @throws {Error} when the id is missing or unknown to `Intl`.
 */
function requireTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') {
    throw new Error('时区必须是 IANA 名称，例如 Asia/Shanghai 或 UTC')
  }
  const zone = timeZone.trim()
  try {
    formatterFor(zone)
  } catch {
    throw new Error(`无效时区: ${timeZone}`)
  }
  return zone
}

/**
 * Tell whether `Intl` recognizes a time zone id.
 * @param {string} timeZone candidate id.
 * @returns {boolean} true when the id is usable.
 */
export function isValidTimeZone(timeZone) {
  try {
    requireTimeZone(timeZone)
    return true
  } catch {
    return false
  }
}

/**
 * Read the wall-clock fields of an instant in a zone.
 * @param {number} ms epoch milliseconds.
 * @param {string} timeZone IANA zone id.
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }} local fields.
 */
function zonedParts(ms, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms))
  const fields = {}
  for (const part of parts) {
    if (part.type !== 'literal') fields[part.type] = part.value
  }
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
    second: Number(fields.second),
  }
}

/**
 * Read UTC calendar fields, used for pseudo-wall timestamps.
 * @param {number} ms pseudo-UTC milliseconds.
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: number }} fields.
 */
function utcParts(ms) {
  const date = new Date(ms)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    weekday: date.getUTCDay(),
  }
}

/**
 * Zone offset (local minus UTC) in milliseconds at one instant.
 * @param {number} ms epoch milliseconds.
 * @param {string} timeZone IANA zone id.
 * @returns {number} offset in milliseconds.
 */
function offsetAt(ms, timeZone) {
  const parts = zonedParts(ms, timeZone)
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  return wall - Math.floor(ms / 1000) * 1000
}

/**
 * Resolve a local wall-clock minute to an epoch instant in a zone.
 * Handles the fall-back ambiguity by returning the earliest candidate and the
 * spring-forward gap by returning `null` when the wall time never exists.
 * @param {string} timeZone IANA zone id.
 * @param {number} wallMs pseudo-UTC milliseconds for the local wall clock.
 * @param {number} afterMs exclusive lower bound.
 * @returns {number|null} matching instant, or null.
 */
function resolveWall(timeZone, wallMs, afterMs) {
  const target = utcParts(wallMs)
  const offsets = new Set()
  for (const delta of [0, -3_600_000, 3_600_000, -93_600_000, 93_600_000]) {
    offsets.add(offsetAt(wallMs + delta, timeZone))
  }

  let best = null
  for (const offset of offsets) {
    const candidate = wallMs - offset
    if (candidate <= afterMs) continue
    const actual = zonedParts(candidate, timeZone)
    const same =
      actual.year === target.year &&
      actual.month === target.month &&
      actual.day === target.day &&
      actual.hour === target.hour &&
      actual.minute === target.minute
    if (!same) continue
    if (best === null || candidate < best) best = candidate
  }
  return best
}

/**
 * Vixie day rule: `*` on both day fields means every day; otherwise a restricted
 * field must match, and when both are restricted EITHER one matching is enough.
 * @param {{ daysOfMonth: number[], daysOfWeek: number[], domAny: boolean, dowAny: boolean }} parsed expression.
 * @param {{ day: number, weekday: number, month: number }} parts candidate date.
 * @returns {boolean} whether the date is allowed.
 */
function dateMatches(parsed, parts) {
  if (!parsed.months.includes(parts.month)) return false
  if (parsed.domAny && parsed.dowAny) return true
  const dom = parsed.daysOfMonth.includes(parts.day)
  const dow = parsed.daysOfWeek.includes(parts.weekday)
  if (parsed.domAny) return dow
  if (parsed.dowAny) return dom
  return dom || dow
}

/**
 * Find the next instant that matches a cron expression, strictly after `fromMs`.
 * @param {string} expr 5-field cron expression.
 * @param {string} timeZone IANA zone id used for the wall clock.
 * @param {number} [fromMs] exclusive lower bound in epoch ms; defaults to now.
 * @returns {number|null} epoch ms of the next match, or null when none is found.
 * @throws {Error} on a malformed expression or unknown time zone.
 */
export function nextRunAt(expr, timeZone, fromMs) {
  const parsed = parseCron(expr)
  const zone = requireTimeZone(timeZone)
  const from = Number.isFinite(fromMs) ? Number(fromMs) : Date.now()

  const origin = zonedParts(from, zone)
  let wall = Date.UTC(origin.year, origin.month - 1, origin.day, origin.hour, origin.minute, 0) + MINUTE_MS

  for (let step = 0; step < SEARCH_LIMIT; step += 1) {
    const parts = utcParts(wall)

    if (!parsed.months.includes(parts.month)) {
      wall = Date.UTC(parts.year, parts.month, 1, 0, 0, 0)
      continue
    }
    if (!dateMatches(parsed, parts)) {
      wall = Date.UTC(parts.year, parts.month - 1, parts.day + 1, 0, 0, 0)
      continue
    }
    if (!parsed.hours.includes(parts.hour)) {
      wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour + 1, 0, 0)
      continue
    }
    if (!parsed.minutes.includes(parts.minute)) {
      wall += MINUTE_MS
      continue
    }

    const instant = resolveWall(zone, wall, from)
    if (instant !== null) return instant
    wall += MINUTE_MS
  }
  return null
}

/**
 * Test whether an instant matches a cron expression in a time zone.
 * @param {string} expr 5-field cron expression.
 * @param {Date|number} date instant to test.
 * @param {string} timeZone IANA zone id.
 * @returns {boolean} true when minute, hour, day, month and weekday match.
 * @throws {Error} on a malformed expression or unknown time zone.
 */
export function cronMatches(expr, date, timeZone) {
  const parsed = parseCron(expr)
  const zone = requireTimeZone(timeZone)
  const ms = date instanceof Date ? date.getTime() : Number(date)
  if (!Number.isFinite(ms)) throw new Error('cronMatches 需要一个有效的 Date 或毫秒时间戳')
  const parts = zonedParts(ms, zone)
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
  return (
    parsed.minutes.includes(parts.minute) &&
    parsed.hours.includes(parts.hour) &&
    dateMatches(parsed, { day: parts.day, month: parts.month, weekday })
  )
}

/**
 * Return the uniform step of a value list that starts at 0, or 0 when the list
 * is irregular. Used only for descriptions.
 * @param {number[]} values sorted values.
 * @returns {number} step, or 0.
 */
function uniformStep(values) {
  if (values.length === 0 || values[0] !== 0) return 0
  if (values.length === 1) return 0
  const step = values[1] - values[0]
  if (step < 2) return 0
  for (let index = 2; index < values.length; index += 1) {
    if (values[index] - values[index - 1] !== step) return 0
  }
  return step
}

/**
 * Zero-pad a number to two digits.
 * @param {number} value number.
 * @returns {string} padded text.
 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * Describe an expression in one short Chinese line.
 * Falls back to the raw expression when the shape is too irregular to name.
 * @param {string} expr 5-field cron expression.
 * @returns {string} e.g. `每周五 18:00`, `每天 09:00`, `每 30 分钟`, `每月 1 日 00:00`.
 */
export function describeCron(expr) {
  const raw = typeof expr === 'string' ? expr.trim().replace(/\s+/g, ' ') : String(expr)
  let parsed
  try {
    parsed = parseCron(raw)
  } catch {
    return raw
  }

  const { minutes, hours, daysOfMonth, months, daysOfWeek } = parsed
  const allDays = parsed.domAny && parsed.dowAny
  const allMonths = months.length === 12
  const allHours = hours.length === 24

  if (allDays && allMonths && allHours) {
    const step = uniformStep(minutes)
    if (step > 1) return `每 ${step} 分钟`
    if (minutes.length === 1) return `每小时第 ${minutes[0]} 分`
    if (minutes.length === 60) return '每分钟'
    return `每小时第 ${minutes.join('、')} 分`
  }

  if (allHours) {
    if (minutes.length === 1 && allDays) return `每小时第 ${minutes[0]} 分`
    return raw
  }

  if (minutes.length !== 1) return raw
  if (hours.length !== 1) return raw

  const time = `${pad2(hours[0])}:${pad2(minutes[0])}`

  if (allMonths) {
    if (allDays) return `每天 ${time}`

    if (parsed.dowAny && !parsed.domAny) {
      const days = [...daysOfMonth].sort((a, b) => a - b)
      if (days.length === 1) return `每月 ${days[0]} 日 ${time}`
      return `每月 ${days.join('、')} 日 ${time}`
    }

    if (parsed.domAny && !parsed.dowAny) {
      const days = [...daysOfWeek].sort((a, b) => a - b)
      if (days.length === 7) return `每天 ${time}`
      if (days.length === 5 && days.join(',') === '1,2,3,4,5') return `工作日 ${time}`
      if (days.length === 2 && days.join(',') === '0,6') return `周末 ${time}`
      return `每${days.map((day) => WEEKDAY_NAMES[day]).join('、')} ${time}`
    }

    const dom = [...daysOfMonth].sort((a, b) => a - b).join('、')
    const dow = [...daysOfWeek].sort((a, b) => a - b).map((day) => WEEKDAY_NAMES[day]).join('、')
    return `每月 ${dom} 日或每${dow} ${time}`
  }

  if (months.length === 1 && allDays) {
    const days = daysOfMonth.length === 1 ? daysOfMonth[0] : daysOfMonth.join('、')
    return `每年 ${months[0]} 月 ${days} 日 ${time}`
  }

  return raw
}

/**
 * Build the cron helper bundle. Mirrors CONTRACTS §5 `createCron()`; every member
 * is also a named export for direct import.
 * @returns {{ parseCron: typeof parseCron, nextRunAt: typeof nextRunAt, describeCron: typeof describeCron, cronMatches: typeof cronMatches, isValidTimeZone: typeof isValidTimeZone }} helper bundle.
 */
export function createCron() {
  return { parseCron, nextRunAt, describeCron, cronMatches, isValidTimeZone }
}