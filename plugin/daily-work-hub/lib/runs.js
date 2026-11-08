/**
 * Run lifecycle helpers shared by the scheduler and the REST layer.
 *
 * Everything here is pure data shaping: no store, no timers, no process spawn.
 * Helpers return new run objects instead of mutating their input, so a persisted
 * record is never aliased by a caller that later rewrites it.
 *
 * Additive fields beyond CONTRACTS §5 (all JSON-safe, ignored by consumers that
 * do not know them): `attempts`, `createdAt`, `deferredNotify`, `parentRunId`,
 * `retryOf`.
 */

/** States after which a Run never changes again. */
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'interrupted', 'cancelled', 'skipped'])

/** Monotonic per-process counter used to keep ids unique within one millisecond. */
let idSeq = 0

/**
 * Short random token for run ids.
 * @returns {string} 4-character base36 token.
 */
function token() {
  return Math.random().toString(36).slice(2, 6)
}

/**
 * Create a queued Run record.
 * @param {object} input run fields.
 * @param {string} input.jobId owning job id.
 * @param {number} [input.jobVersion] job version at creation time.
 * @param {'manual'|'cron'|'event'|'after'} [input.triggerSource] what caused this run.
 * @param {object} [input.params] coerced parameter values.
 * @param {number} [input.hops] after-chain depth inherited from the parent run.
 * @param {number} [input.scheduledAt] intended epoch ms (defaults to now).
 * @param {string} [input.id] explicit id (tests/imports); generated otherwise.
 * @param {number} [input.attempts] attempt counter, 1-based.
 * @param {string} [input.parentRunId] run that triggered this one through `after`.
 * @param {string} [input.retryOf] interrupted run this one retries.
 * @param {number} [input.createdAt] epoch ms; defaults to `scheduledAt`.
 * @param {boolean} [input.deferredNotify] true when quiet hours deferred the notification.
 * @returns {object} Run in `queued` state.
 */
export function createRun(input) {
  const scheduledAt = Number.isFinite(input.scheduledAt) ? input.scheduledAt : Date.now()
  idSeq += 1
  const id = input.id ?? `run-${scheduledAt}-${idSeq.toString(36)}${token()}`
  return {
    id,
    jobId: input.jobId,
    jobVersion: Number.isFinite(input.jobVersion) ? input.jobVersion : 1,
    triggerSource: input.triggerSource ?? 'manual',
    params: input.params !== null && typeof input.params === 'object' ? { ...input.params } : {},
    state: 'queued',
    reason: null,
    scheduledAt,
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : scheduledAt,
    startedAt: null,
    finishedAt: null,
    sessionId: null,
    usage: null,
    hops: Number.isFinite(input.hops) ? input.hops : 0,
    artifacts: [],
    cardId: null,
    log: [],
    error: null,
    attempts: Number.isFinite(input.attempts) ? input.attempts : 1,
    deferredNotify: input.deferredNotify === true,
    parentRunId: input.parentRunId ?? null,
    retryOf: input.retryOf ?? null,
  }
}

/**
 * Mark a run as running and record the start time.
 * @param {object} run current run record.
 * @param {number} [at] epoch ms of the transition.
 * @returns {object} new run in `running` state.
 */
export function startRun(run, at = Date.now()) {
  return {
    ...run,
    state: 'running',
    startedAt: at,
    finishedAt: null,
    error: null,
    log: [...(run.log ?? []), `start ${new Date(at).toISOString()}`],
  }
}

/**
 * Move a run to a terminal state.
 * @param {object} run current run record.
 * @param {object} outcome terminal fields.
 * @param {'succeeded'|'failed'|'interrupted'|'cancelled'|'skipped'} outcome.state terminal state.
 * @param {string} [outcome.error] error text for failed/interrupted runs.
 * @param {{ input?: number, output?: number }} [outcome.usage] token usage.
 * @param {{ path: string, title?: string }[]} [outcome.artifacts] produced artifacts.
 * @param {string} [outcome.sessionId] session id for session executors.
 * @param {string} [outcome.reason] short human reason, e.g. a daily-cap skip.
 * @param {number} [outcome.at] epoch ms of the transition.
 * @returns {object} new terminal run.
 */
export function finishRun(run, outcome) {
  const at = Number.isFinite(outcome.at) ? outcome.at : Date.now()
  return {
    ...run,
    state: outcome.state,
    reason: outcome.reason ?? run.reason ?? null,
    finishedAt: at,
    error: outcome.error ?? null,
    usage: outcome.usage ?? run.usage ?? null,
    sessionId: outcome.sessionId ?? run.sessionId ?? null,
    artifacts: Array.isArray(outcome.artifacts) ? outcome.artifacts : (run.artifacts ?? []),
    log: [...(run.log ?? []), `${outcome.state} ${new Date(at).toISOString()}`],
  }
}

/**
 * Tell whether a run has reached a state it cannot leave.
 * @param {object} run run record.
 * @returns {boolean} true for succeeded/failed/interrupted/cancelled/skipped.
 */
export function isTerminal(run) {
  return TERMINAL_STATES.has(run?.state)
}

/**
 * Compact run view for lists and notifications.
 * @param {object} run run record.
 * @returns {{ id: string, jobId: string, state: string, triggerSource: string,
 *   scheduledAt: number, startedAt: number|null, finishedAt: number|null,
 *   durationMs: number|null, hops: number, attempts: number, sessionId: string|null,
 *   usage: object|null, artifacts: string[], deferredNotify: boolean,
 *   error?: string, reason?: string }} summary.
 */
export function summarizeRun(run) {
  const summary = {
    id: run.id,
    jobId: run.jobId,
    state: run.state,
    triggerSource: run.triggerSource,
    scheduledAt: run.scheduledAt,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    durationMs:
      Number.isFinite(run.startedAt) && Number.isFinite(run.finishedAt)
        ? run.finishedAt - run.startedAt
        : null,
    hops: run.hops ?? 0,
    attempts: run.attempts ?? 1,
    sessionId: run.sessionId ?? null,
    usage: run.usage ?? null,
    artifacts: (run.artifacts ?? []).map((artifact) => artifact.path),
    deferredNotify: run.deferredNotify === true,
  }
  if (run.error) summary.error = run.error
  if (run.reason) summary.reason = run.reason
  return summary
}

/**
 * Executor descriptors. The scheduler only records which executor a job uses and
 * how to describe it; real wiring (session creation, subprocess spawn) belongs to
 * the Lead. `requires` lists the configuration fields an executor needs — a
 * display hint, not a spawn contract.
 */
export const EXECUTORS = Object.freeze({
  session: {
    kind: 'session',
    requires: ['template 或 skill 或 prompt'],
    /**
     * One-line description for the panel.
     * @param {object} run run record.
     * @param {object} job job definition.
     * @returns {string} description.
     */
    describe(run, job) {
      const executor = job?.executor ?? {}
      const source = executor.template
        ? `模板 ${executor.template}`
        : executor.skill
          ? `技能 ${executor.skill}`
          : '自由提示词'
      return `会话执行 · ${source} · ${executor.access === 'workspace-write' ? '可写' : '只读'}`
    },
  },
  headless: {
    kind: 'headless',
    requires: ['prompt'],
    /**
     * One-line description for the panel.
     * @param {object} run run record.
     * @param {object} job job definition.
     * @returns {string} description.
     */
    describe(run, job) {
      return `隔离子进程执行 · ${job?.executor?.prompt ? '提示词已配置' : '缺少提示词'}`
    },
  },
  command: {
    kind: 'command',
    requires: ['command', 'cwd'],
    /**
     * One-line description for the panel.
     * @param {object} run run record.
     * @param {object} job job definition.
     * @returns {string} description.
     */
    describe(run, job) {
      const executor = job?.executor ?? {}
      return `命令 ${executor.command ?? '(未配置)'} · 目录 ${executor.cwd ?? '(未配置)'}`
    },
  },
  'dry-run': {
    kind: 'dry-run',
    requires: [],
    /**
     * One-line description for the panel.
     * @returns {string} description.
     */
    describe() {
      return '干跑（只读，不写任何外部系统）'
    },
  },
})

/**
 * Expand an output path template into a workspace-relative path.
 * Tokens: `{{date}}` (YYYY-MM-DD), `{{time}}` (HH-mm-ss), `{{job}}` (job id),
 * `{{run}}` (run id). Unknown tokens are left untouched so a bad template is
 * visible instead of silently wrong.
 * @param {string} template path template, e.g. `reports/weekly-{{date}}.md`.
 * @param {{ job?: object, run?: object, now?: number, tz?: string }} context expansion context.
 * @returns {string|null} expanded relative path, or null when the template is
 *   missing, absolute, or escapes the workspace with `..`.
 */
export function artifactPath(template, context = {}) {
  if (typeof template !== 'string') return null
  const trimmed = template.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) return null
  const segments = trimmed.replace(/\\/g, '/').split('/')
  if (segments.includes('..')) return null

  const at = Number.isFinite(context.now) ? context.now : Date.now()
  const { date, time } = dateTimeParts(at, context.tz ?? context.job?.trigger?.tz)
  return trimmed
    .replaceAll('{{date}}', date)
    .replaceAll('{{time}}', time)
    .replaceAll('{{job}}', String(context.job?.id ?? ''))
    .replaceAll('{{run}}', String(context.run?.id ?? ''))
}

/**
 * Format the calendar date and clock time for one instant.
 * @param {number} ms epoch ms.
 * @param {string} [tz] IANA zone; system local time when absent or invalid.
 * @returns {{ date: string, time: string }} `YYYY-MM-DD` and `HH-mm-ss`.
 */
function dateTimeParts(ms, tz) {
  let parts
  if (typeof tz === 'string' && tz !== '') {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
      parts = {}
      for (const part of formatter.formatToParts(new Date(ms))) {
        if (part.type !== 'literal') parts[part.type] = part.value
      }
    } catch {
      parts = undefined
    }
  }
  if (parts === undefined) {
    const date = new Date(ms)
    parts = {
      year: String(date.getFullYear()),
      month: String(date.getMonth() + 1).padStart(2, '0'),
      day: String(date.getDate()).padStart(2, '0'),
      hour: String(date.getHours()).padStart(2, '0'),
      minute: String(date.getMinutes()).padStart(2, '0'),
      second: String(date.getSeconds()).padStart(2, '0'),
    }
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}-${parts.minute}-${parts.second}`,
  }
}