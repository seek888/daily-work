/**
 * Shared helpers for daily-work-hub. Zero dependencies, no host imports.
 * @module lib/util
 */

import { createHash } from 'node:crypto'

/** Milliseconds in one second. */
export const SECOND = 1000
/** Milliseconds in one minute. */
export const MINUTE = 60 * SECOND
/** Milliseconds in one hour. */
export const HOUR = 60 * MINUTE
/** Milliseconds in one day. */
export const DAY = 24 * HOUR

/**
 * Current time as an ISO string.
 * @param {number} [at] epoch ms, defaults to now.
 * @returns {string} ISO 8601 timestamp.
 */
export function isoTimestamp(at = Date.now()) {
  return new Date(at).toISOString()
}

/**
 * sha256 hex digest, used for event dedupe and stable ids.
 * @param {string} text input.
 * @returns {string} 64 hex chars.
 */
export function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

/**
 * Short stable id from a seed.
 * @param {string} prefix id prefix, e.g. 'turn' or 'run'.
 * @param {string} seed any string.
 * @returns {string} `<prefix>-<12 hex>`.
 */
export function shortId(prefix, seed) {
  return `${prefix}-${sha256(seed).slice(0, 12)}`
}

/**
 * Structured clone that tolerates plain JSON data only.
 * @template T
 * @param {T} value value to copy.
 * @returns {T} deep copy.
 */
export function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

/**
 * Clamp a number into [min, max].
 * @param {number} value candidate.
 * @param {number} min lower bound.
 * @param {number} max upper bound.
 * @returns {number} clamped value.
 */
export function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/**
 * Parse a JSON string without throwing.
 * @param {string} text candidate.
 * @param {unknown} fallback value on failure.
 * @returns {unknown} parsed value or fallback.
 */
export function safeJson(text, fallback = undefined) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * Truncate a string, appending an ellipsis marker when cut.
 * @param {string} text source.
 * @param {number} limit max characters.
 * @returns {string} truncated text.
 */
export function truncate(text, limit = 2000) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n…truncated ${value.length - limit} chars…`
}

/**
 * Validate and normalize a work-item subject: `<project>#<iid>` or a project path.
 * Only `[A-Za-z0-9#._:/@-]` survives, per DESIGN §2.2 invariant 1.
 * @param {string} subject raw subject.
 * @returns {string | undefined} normalized subject, or undefined when unusable.
 */
export function sanitizeSubject(subject) {
  if (typeof subject !== 'string') return undefined
  const trimmed = subject.trim()
  if (trimmed === '') return undefined
  const cleaned = trimmed.replace(/[^A-Za-z0-9#._:/@-]/g, '').slice(0, 300)
  return cleaned === '' ? undefined : cleaned
}

/**
 * Only plain ASCII URLs are allowed into records and prompts.
 * @param {unknown} url candidate.
 * @returns {string | undefined} the URL when it is plain ASCII http(s), else undefined.
 */
export function sanitizeUrl(url) {
  if (typeof url !== 'string') return undefined
  if (!/^https?:\/\/[\x21-\x7e]+$/.test(url)) return undefined
  return url.slice(0, 2000)
}

/**
 * Parse a compact duration (`30s`, `5m`, `2h`, `1d`) into milliseconds.
 * @param {string | number} value duration or already-milliseconds number.
 * @returns {number} milliseconds, 0 when unparseable.
 */
export function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/.exec(String(value ?? ''))
  if (match === null) return 0
  const amount = Number(match[1])
  const unit = match[2] ?? 'ms'
  const scale = { ms: 1, s: SECOND, m: MINUTE, h: HOUR, d: DAY }[unit]
  return Math.round(amount * scale)
}

/**
 * Human-readable compact duration.
 * @param {number} ms milliseconds.
 * @returns {string} e.g. `900ms`, `5m`, `2h10m`.
 */
export function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0)
  if (value < SECOND) return `${Math.round(value)}ms`
  if (value < MINUTE) return `${Math.round(value / SECOND)}s`
  if (value < HOUR) return `${Math.round(value / MINUTE)}m`
  const hours = Math.floor(value / HOUR)
  const minutes = Math.round((value % HOUR) / MINUTE)
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`
}

/**
 * Compact relative time in Chinese, for list rows.
 * @param {string | number | undefined} value ISO string or epoch ms.
 * @param {number} [nowMs] reference time.
 * @returns {string} e.g. `刚刚`, `3m`, `2h`, `3d`, `—`.
 */
export function relativeTime(value, nowMs = Date.now()) {
  if (value === undefined || value === null) return '—'
  const at = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(at)) return '—'
  const delta = nowMs - at
  if (delta < 0) return '稍后'
  if (delta < MINUTE) return '刚刚'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`
  if (delta < 30 * DAY) return `${Math.floor(delta / DAY)}d`
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * Match a POSIX-ish path against a simple glob (`*`, `**`, prefix dirs).
 * @param {string} path candidate path.
 * @param {string} pattern glob such as `src/**` or `*.lock`.
 * @returns {boolean} true when the path matches.
 */
export function matchesGlob(path, pattern) {
  if (typeof pattern !== 'string' || pattern === '') return false
  const source = String(path ?? '')
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.')
  try {
    return new RegExp(`^${escaped}$`).test(source)
  } catch {
    return false
  }
}

/**
 * Whether any glob in a list matches the path.
 * @param {string} path candidate.
 * @param {readonly string[] | undefined} patterns globs.
 * @returns {boolean} true when at least one matches.
 */
export function matchesAny(path, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  return patterns.some((pattern) => matchesGlob(path, pattern))
}

/**
 * Remove duplicate primitives while keeping first-seen order.
 * @template T
 * @param {readonly T[]} values input.
 * @returns {T[]} unique values.
 */
export function unique(values) {
  return [...new Set(values)]
}

/**
 * Redact GitLab personal access tokens and similar secrets from text.
 * @param {string} text source text.
 * @returns {string} text with `glpat-…` and bearer tokens masked.
 */
export function redact(text) {
  return String(text ?? '')
    .replace(/glpat-[A-Za-z0-9_-]{8,}/g, 'glpat-****')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ****')
    .replace(/PRIVATE-TOKEN:\s*\S+/gi, 'PRIVATE-TOKEN: ****')
}

/**
 * Split an owner/repo style path into its last segment.
 * @param {string} path full path like `gp/order-service`.
 * @returns {string} last segment.
 */
export function lastSegment(path) {
  const parts = String(path ?? '').split('/')
  return parts[parts.length - 1] ?? ''
}

/**
 * A simple monotonic token bucket used to respect GitLab write limits.
 * @param {{ capacity?: number, refillPerMinute?: number }} [options] bucket sizing.
 * @returns {{ take: (cost?: number) => boolean, waitMs: (cost?: number) => number, refill: (now?: number) => void }} bucket handle.
 */
export function createTokenBucket(options = {}) {
  const capacity = clamp(options.capacity ?? 30, 1, 10_000)
  const refillPerMinute = clamp(options.refillPerMinute ?? 30, 1, 10_000)
  let tokens = capacity
  let updatedAt = Date.now()
  function refill(now = Date.now()) {
    const elapsed = Math.max(0, now - updatedAt)
    if (elapsed === 0) return
    tokens = Math.min(capacity, tokens + (elapsed / MINUTE) * refillPerMinute)
    updatedAt = now
  }
  return {
    refill,
    take(cost = 1) {
      refill()
      if (tokens < cost) return false
      tokens -= cost
      return true
    },
    waitMs(cost = 1) {
      refill()
      if (tokens >= cost) return 0
      return Math.ceil(((cost - tokens) / refillPerMinute) * MINUTE)
    },
  }
}

/**
 * Race a promise against a timeout.
 * @template T
 * @param {Promise<T>} promise work to bound.
 * @param {number} ms timeout.
 * @param {string} [label] error label.
 * @returns {Promise<T>} the value, or a rejected Error on timeout.
 */
export function withTimeout(promise, ms, label = 'operation') {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${formatDuration(ms)}`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Retry an async function with exponential backoff.
 * @template T
 * @param {() => Promise<T>} fn work to retry.
 * @param {{ max?: number, baseMs?: number, signal?: AbortSignal, shouldRetry?: (error: unknown) => boolean }} [options] retry policy.
 * @returns {Promise<T>} the settled value.
 */
export async function retryWithBackoff(fn, options = {}) {
  const max = clamp(options.max ?? 0, 0, 10)
  const baseMs = clamp(options.baseMs ?? 1000, 1, HOUR)
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (error) {
      const retryable = options.shouldRetry === undefined ? true : options.shouldRetry(error)
      if (!retryable || attempt >= max) throw error
      attempt += 1
      const waitMs = baseMs * 2 ** (attempt - 1)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, waitMs)
        timer.unref?.()
        options.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        }, { once: true })
      })
    }
  }
}

/**
 * Build a logger that never throws when the host logger is missing.
 * @param {any} ctx plugin context.
 * @param {string} [scope] prefix.
 * @returns {{ info: Function, warn: Function, error: Function, debug: Function }} logger.
 */
export function createLogger(ctx, scope = 'daily-work-hub') {
  const host = ctx?.logger
  const emit = (level, message) => {
    const text = `[${scope}] ${redact(message)}`
    try {
      if (typeof host?.[level] === 'function') host[level](text)
      else if (level === 'error') console.error(text)
      else if (level === 'warn') console.warn(text)
      else console.log(text)
    } catch {
      /* logging must never break the caller */
    }
  }
  return {
    debug: (message) => emit('debug', message),
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
  }
}

/**
 * Normalize an error into `{ code, message }` for API responses.
 * @param {unknown} error thrown value.
 * @returns {{ code: string, message: string }} normalized error.
 */
export function normalizeError(error) {
  if (error === null || error === undefined) return { code: 'unknown', message: 'unknown error' }
  if (typeof error === 'object') {
    const code = typeof error.code === 'string' && error.code !== '' ? error.code : 'error'
    const message = typeof error.message === 'string' && error.message !== '' ? error.message : String(error)
    return { code, message: redact(message) }
  }
  return { code: 'error', message: redact(String(error)) }
}

/**
 * Stable stringify for hashing comparable records.
 * @param {unknown} value value to serialize.
 * @returns {string} deterministic JSON.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}