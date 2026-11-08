/**
 * Cron scheduler with a virtual-clock-friendly core.
 *
 * Semantics (DESIGN §9.3, proven offline in `design/SCHEDULER-PROOF.md`):
 * - one Run per due window: the idempotency key is `jobId + scheduledAt`, so a
 *   repeated tick — or a tick that lost the window-advance write — cannot create
 *   a second Run for the same window;
 * - the window always advances (cron `nextRunAt`) after being considered, even
 *   when the run was skipped, capped or already existed;
 * - `catchUp: 'skip'` (default) drops missed windows, `'run-once'` produces at
 *   most one catch-up Run and still advances the window into the future;
 * - same `laneKey` serializes, different lanes run in parallel up to each job's
 *   `policy.concurrency`;
 * - `after` chains inherit `hops` from the parent Run and are fused above
 *   {@link HOP_LIMIT} hops (audited, never dispatched);
 * - `recover()` marks orphaned `running` Runs `interrupted` and retries them at
 *   most once per `policy.retry.max`;
 * - `quietHours` defers only the notification (`run.deferredNotify`), never the
 *   task itself.
 *
 * The module never touches items/templates, never throws out of `tick()`, and
 * takes its clock from `now` so tests can drive it without real timers.
 */

import { nextRunAt } from './cron.js'
import { paramDefaults, coerceParams } from './jobs.js'
import { createRun, finishRun, isTerminal, startRun } from './runs.js'

/** Hard after-chain fuse: a child at hop depth 9 is only audited. */
export const HOP_LIMIT = 8

/** How many recent runs one job lookup may scan for idempotency/caps. */
const RUN_SCAN_LIMIT = 500

/** Default tick cadence; callers normally pass `ctx.timer` and a smaller value. */
const DEFAULT_TICK_MS = 30_000

/**
 * Normalize any thrown value into a log line.
 * @param {unknown} error thrown value.
 * @returns {string} message text.
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Create a scheduler bound to one store.
 * @param {object} options scheduler options.
 * @param {object} options.store store API from CONTRACTS §3 (`jobs`, `runs`, `audit` only).
 * @param {() => number} [options.now] injectable clock returning epoch ms.
 * @param {(context: { job: object, run: object, params: object, signal: AbortSignal }) => Promise<object>} options.execute execution hook; throwing marks the run failed.
 * @param {{ interval?: (fn: () => void, ms: number) => (() => void) }} [options.timer] host timer (`ctx.get('timer')`); global `setInterval` when absent.
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.logger] optional logger.
 * @param {number} [options.tickMs] tick period in milliseconds.
 * @param {string[]} [options.quietHours] global quiet-hour ranges, merged with `policy.quietHours`.
 * @param {string} [options.timeZone] default zone for job state and quiet hours.
 * @returns {{ start: () => () => void, tick: () => Promise<void>, runNow: (jobId: string, params?: object, triggerSource?: string) => Promise<object>, cancel: (runId: string) => Promise<object|undefined>, nextRuns: (limit?: number) => Promise<{ jobId: string, at: number }[]>, recover: () => Promise<{ interrupted: number, retried: number, requeued: number }>, dispose: () => void }} scheduler API.
 */
export function createScheduler(options = {}) {
  const store = options.store
  if (!store || typeof store.jobs?.list !== 'function' || typeof store.runs?.put !== 'function') {
    throw new Error('createScheduler 需要符合 CONTRACTS §3 的 store')
  }
  if (typeof options.execute !== 'function') {
    throw new Error('createScheduler 需要注入 execute({ job, run, params, signal })')
  }

  const execute = options.execute
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const logger = options.logger
  const timer = options.timer
  const tickMs = Number.isFinite(options.tickMs) ? Math.max(1000, Math.round(options.tickMs)) : DEFAULT_TICK_MS
  const globalQuietHours = Array.isArray(options.quietHours) ? options.quietHours : []
  const fallbackTimeZone = typeof options.timeZone === 'string' && options.timeZone !== '' ? options.timeZone : 'Asia/Shanghai'

  /** Active executions: runId → { controller, job }. */
  const active = new Map()
  /** Runs waiting for lane/concurrency capacity: runId → { job, run }. */
  const pending = new Map()
  /** laneKey → runId currently holding that lane. */
  const laneBusy = new Map()
  /** runIds whose caller asked to cancel. */
  const cancelled = new Set()
  /** Dedupe keys for after-triggered children. */
  const afterSpawned = new Set()

  let pumping = false
  let tickChain = Promise.resolve()
  let stopTimer = null
  let disposed = false

  /**
   * Append one audit entry; never lets an audit failure break scheduling.
   * @param {string} kind audit kind, e.g. `run.start`.
   * @param {string} subject job or run id.
   * @param {string} detail human-readable detail.
   * @returns {Promise<void>} resolves even when the write fails.
   */
  async function audit(kind, subject, detail) {
    try {
      await store.audit.append({ actor: 'scheduler', kind, subject, detail })
    } catch (error) {
      logger?.warn?.(`[daily-work-hub] 审计写入失败: ${messageOf(error)}`)
    }
  }

  /**
   * Zone used for a job's wall-clock work.
   * @param {object} job job definition.
   * @returns {string} IANA zone id.
   */
  function jobTimeZone(job) {
    const zone = job?.trigger?.tz
    return typeof zone === 'string' && zone !== '' ? zone : fallbackTimeZone
  }

  /**
   * Lane key of a job, or null when the job has no lane.
   * @param {object} job job definition.
   * @returns {string|null} lane key.
   */
  function laneOf(job) {
    const lane = job?.policy?.laneKey
    return typeof lane === 'string' && lane !== '' ? lane : null
  }

  /**
   * Count live runs owned by one job.
   * @param {string} jobId job id.
   * @returns {number} number of active executions.
   */
  function activeForJob(jobId) {
    let count = 0
    for (const entry of active.values()) {
      if (entry.job?.id === jobId) count += 1
    }
    return count
  }

  /**
   * Whether a new run of this job may start now: under its own concurrency limit
   * and holding no already-busy lane.
   * @param {object} job job definition.
   * @returns {boolean} true when capacity is available.
   */
  function canStart(job) {
    const limit = Number.isInteger(job?.policy?.concurrency) ? job.policy.concurrency : 1
    if (activeForJob(job.id) >= Math.max(1, limit)) return false
    const lane = laneOf(job)
    if (lane !== null && laneBusy.has(lane)) return false
    return true
  }

  /** Day formatter cache for `dayKey` (and date-only comparisons). */
  const dayFormatters = new Map()
  /** Clock formatter cache for quiet-hour checks. */
  const clockFormatters = new Map()

  /**
   * Local calendar day (`YYYY-MM-DD`) of an instant in a zone.
   * @param {number} ms epoch ms.
   * @param {string} timeZone IANA zone id.
   * @returns {string} day key.
   */
  function dayKey(ms, timeZone) {
    let formatter = dayFormatters.get(timeZone)
    if (formatter === undefined) {
      try {
        formatter = new Intl.DateTimeFormat('en-CA', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        })
      } catch {
        formatter = null
      }
      dayFormatters.set(timeZone, formatter)
    }
    if (formatter === null) return new Date(ms).toISOString().slice(0, 10)
    return formatter.format(new Date(ms))
  }

  /**
   * Local minute-of-day of an instant in a zone.
   * @param {number} ms epoch ms.
   * @param {string} timeZone IANA zone id.
   * @returns {number} minutes since local midnight, 0–1439.
   */
  function minuteOfDay(ms, timeZone) {
    let formatter = clockFormatters.get(timeZone)
    if (formatter === undefined) {
      try {
        formatter = new Intl.DateTimeFormat('en-GB', {
          timeZone,
          hourCycle: 'h23',
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch {
        formatter = null
      }
      clockFormatters.set(timeZone, formatter)
    }
    if (formatter === null) {
      const date = new Date(ms)
      return date.getHours() * 60 + date.getMinutes()
    }
    const fields = {}
    for (const part of formatter.formatToParts(new Date(ms))) {
      if (part.type !== 'literal') fields[part.type] = part.value
    }
    return Number(fields.hour) * 60 + Number(fields.minute)
  }

  /**
   * Quiet-hour ranges that apply to a job.
   * @param {object} job job definition.
   * @returns {string[]} `HH:MM-HH:MM` ranges.
   */
  function quietRanges(job) {
    const own = Array.isArray(job?.policy?.quietHours) ? job.policy.quietHours : []
    return [...globalQuietHours, ...own]
  }

  /**
   * Whether an instant falls inside any quiet range of a job.
   * @param {object} job job definition.
   * @param {number} at epoch ms.
   * @returns {boolean} true inside quiet hours.
   */
  function inQuietHours(job, at) {
    const ranges = quietRanges(job)
    if (ranges.length === 0) return false
    const minute = minuteOfDay(at, jobTimeZone(job))
    return ranges.some((range) => {
      const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(String(range))
      if (!match) return false
      const start = Number(match[1]) * 60 + Number(match[2])
      const end = Number(match[3]) * 60 + Number(match[4])
      return start <= end ? minute >= start && minute < end : minute >= start || minute < end
    })
  }

  /**
   * Whether a job produces a notification that quiet hours can defer.
   * @param {object} job job definition.
   * @returns {boolean} true when the output notifies someone.
   */
  function willNotify(job) {
    const output = job?.output ?? {}
    if (output.notify !== undefined && output.notify !== 'none') return true
    return output.kind === 'notification' || output.kind === 'card'
  }

  /**
   * Whether a run record already exists for one due window.
   * @param {string} jobId job id.
   * @param {number} scheduledAt window instant in epoch ms.
   * @returns {Promise<boolean>} true when a Run was already created for that window.
   */
  async function hasRunForWindow(jobId, scheduledAt) {
    let runs
    try {
      runs = await store.runs.list({ jobId, limit: RUN_SCAN_LIMIT })
    } catch (error) {
      logger?.warn?.(`[daily-work-hub] 读取运行记录失败: ${messageOf(error)}`)
      return false
    }
    return runs.some((run) => run.scheduledAt === scheduledAt)
  }

  /**
   * Number of runs a job created on its local current day, excluding skipped ones.
   * @param {object} job job definition.
   * @param {number} at epoch ms.
   * @returns {Promise<number>} today's run count.
   */
  async function countRunsToday(job, at) {
    let runs
    try {
      runs = await store.runs.list({ jobId: job.id, limit: RUN_SCAN_LIMIT })
    } catch {
      return 0
    }
    const zone = jobTimeZone(job)
    const today = dayKey(at, zone)
    return runs.filter(
      (run) =>
        run.state !== 'skipped' && dayKey(run.createdAt ?? run.scheduledAt, zone) === today,
    ).length
  }

  /**
   * Whether `maxRunsPerDay` is exhausted for a job (0 means unlimited).
   * @param {object} job job definition.
   * @param {number} at epoch ms.
   * @returns {Promise<boolean>} true when no further run may start today.
   */
  async function capReached(job, at) {
    const cap = job?.policy?.maxRunsPerDay
    if (!Number.isInteger(cap) || cap <= 0) return false
    return (await countRunsToday(job, at)) >= cap
  }

  /**
   * Create, persist and enqueue one Run.
   * @param {object} job job definition.
   * @param {{ triggerSource?: string, params?: object, hops?: number, scheduledAt?: number, parentRunId?: string }} spec run inputs.
   * @returns {Promise<object|null>} the queued run, or null when capped.
   */
  async function enqueueNew(job, spec = {}) {
    const at = now()
    if (await capReached(job, at)) {
      await audit(
        'run.capped',
        job.id,
        `达到每日上限 maxRunsPerDay=${job.policy.maxRunsPerDay}，跳过 ${new Date(spec.scheduledAt ?? at).toISOString()} 的窗口`,
      )
      return null
    }
    const scheduledAt = Number.isFinite(spec.scheduledAt) ? spec.scheduledAt : at
    const run = createRun({
      jobId: job.id,
      jobVersion: job.version,
      triggerSource: spec.triggerSource ?? 'cron',
      params: spec.params ?? paramDefaults(job),
      hops: spec.hops ?? 0,
      scheduledAt,
      createdAt: at,
      parentRunId: spec.parentRunId,
      deferredNotify: inQuietHours(job, at) && willNotify(job),
    })
    try {
      await store.runs.put(run)
    } catch (error) {
      logger?.warn?.(`[daily-work-hub] 写入运行记录失败: ${messageOf(error)}`)
      return null
    }
    await audit(
      'run.queued',
      run.id,
      `job=${job.id} trigger=${run.triggerSource} scheduledAt=${new Date(scheduledAt).toISOString()} hops=${run.hops}${run.deferredNotify ? ' notify=deferred' : ''}`,
    )
    pending.set(run.id, { job, run })
    await pump()
    return run
  }

  /**
   * Persist a job's window state.
   * @param {object} job job definition (mutated locally).
   * @param {number|null} next next window instant, or null when none remains.
   * @param {number} [lastScheduledAt] last window that was considered.
   * @returns {Promise<void>} resolves after the write attempt.
   */
  async function persistWindow(job, next, lastScheduledAt) {
    job.nextRunAt = next
    if (Number.isFinite(lastScheduledAt)) job.lastScheduledAt = lastScheduledAt
    try {
      await store.jobs.put(job)
    } catch (error) {
      logger?.warn?.(`[daily-work-hub] 写入任务状态失败: ${messageOf(error)}`)
    }
  }

  /**
   * Start whatever queued runs fit the lane/concurrency budget.
   * @returns {Promise<void>} resolves once no further run can start.
   */
  async function pump() {
    if (pumping || disposed) return
    pumping = true
    try {
      let progressed = true
      while (progressed && !disposed) {
        progressed = false
        for (const [runId, entry] of pending) {
          if (!canStart(entry.job)) continue
          pending.delete(runId)
          progressed = true
          await launch(entry.job, entry.run)
          break
        }
      }
    } finally {
      pumping = false
    }
  }

  /**
   * Move one queued run to `running`, persist that, then execute it in the
   * background. The caller gets control back immediately.
   * @param {object} job job definition.
   * @param {object} run queued run record.
   * @returns {Promise<object>} the running run record.
   */
  async function launch(job, run) {
    if (disposed) return run
    const running = startRun(run, now())
    const lane = laneOf(job)
    const controller = new AbortController()
    active.set(running.id, { controller, job })
    if (lane !== null) laneBusy.set(lane, running.id)

    try {
      await store.runs.put(running)
    } catch (error) {
      logger?.warn?.(`[daily-work-hub] 写入运行状态失败: ${messageOf(error)}`)
    }
    await audit('run.start', running.id, `job=${job.id} trigger=${running.triggerSource} attempts=${running.attempts}`)
    void executeRun(job, running, controller)
    return running
  }

  /**
   * Await one injected execution, persist its terminal state, then continue the
   * after-chain and the queue. Never rejects.
   * @param {object} job job definition.
   * @param {object} run running run record.
   * @param {AbortController} controller cancellation handle.
   * @returns {Promise<void>} resolves when the terminal state is stored.
   */
  async function executeRun(job, run, controller) {
    const lane = laneOf(job)
    let outcome = null
    let failure = null
    let timeoutHandle = null

    try {
      const timeoutMin = Number(job.policy?.timeoutMin)
      const invocation = execute({ job, run, params: run.params, signal: controller.signal })
      if (Number.isFinite(timeoutMin) && timeoutMin > 0) {
        const timeout = new Promise((resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort()
            reject(new Error(`执行超时（${timeoutMin} 分钟）`))
          }, timeoutMin * 60_000)
          timeoutHandle.unref?.()
        })
        outcome = await Promise.race([invocation, timeout])
      } else {
        outcome = await invocation
      }
    } catch (error) {
      failure = messageOf(error)
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle)
    }

    const at = now()
    let finished
    if (cancelled.has(run.id)) {
      finished = finishRun(run, { state: 'cancelled', at, reason: '用户取消', error: failure ?? undefined })
    } else if (failure !== null) {
      finished = finishRun(run, {
        state: 'failed',
        at,
        error: failure,
        usage: outcome?.usage,
        artifacts: outcome?.artifacts,
        sessionId: outcome?.sessionId,
      })
    } else {
      finished = finishRun(run, {
        state: 'succeeded',
        at,
        usage: outcome?.usage,
        artifacts: outcome?.artifacts,
        sessionId: outcome?.sessionId,
      })
    }

    try {
      await store.runs.put(finished)
    } catch (error) {
      logger?.warn?.(`[daily-work-hub] 写入运行结果失败: ${messageOf(error)}`)
    }
    await audit(`run.${finished.state}`, finished.id, `job=${job.id}${finished.error ? ` error=${finished.error}` : ''}`)

    active.delete(run.id)
    cancelled.delete(run.id)
    if (lane !== null && laneBusy.get(lane) === run.id) laneBusy.delete(lane)

    try {
      await fireAfter(finished)
    } catch (error) {
      logger?.warn?.(`[daily-work-hub] after 链派发失败: ${messageOf(error)}`)
    }
    await pump()
  }

  /**
   * Whether a parent run already spawned a child for one job.
   * @param {string} parentRunId parent run id.
   * @param {string} childJobId child job id.
   * @returns {Promise<boolean>} true when such a child run exists.
   */
  async function hasChildRun(parentRunId, childJobId) {
    let runs
    try {
      runs = await store.runs.list({ jobId: childJobId, limit: RUN_SCAN_LIMIT })
    } catch {
      return false
    }
    return runs.some((run) => run.parentRunId === parentRunId)
  }

  /**
   * Dispatch `after` jobs whose upstream run reached the configured status.
   * Hop depth above {@link HOP_LIMIT} is audited and dropped.
   * @param {object} finished terminal parent run.
   * @returns {Promise<void>} resolves after every eligible child is enqueued.
   */
  async function fireAfter(finished) {
    if (finished.state !== 'succeeded' && finished.state !== 'failed') return
    const status = finished.state === 'succeeded' ? 'success' : 'failure'

    let jobs
    try {
      jobs = await store.jobs.list()
    } catch (error) {
      logger?.warn?.(`[daily-work-hub] 读取任务列表失败: ${messageOf(error)}`)
      return
    }

    for (const job of jobs) {
      if (!job || job.enabled === false) continue
      const trigger = job.trigger ?? {}
      if (trigger.kind !== 'after') continue
      const after = trigger.after ?? {}
      const jobIds = Array.isArray(after.jobIds) ? after.jobIds : []
      if (!jobIds.includes(finished.jobId)) continue
      if ((after.status ?? 'success') !== status) continue

      const hops = (Number.isFinite(finished.hops) ? finished.hops : 0) + 1
      if (hops > HOP_LIMIT) {
        await audit(
          'run.blocked',
          job.id,
          `after 链第 ${hops} 跳超过 ${HOP_LIMIT} 跳熔断（上游 ${finished.id}），只记录不派发`,
        )
        continue
      }

      const spawnKey = `${finished.id}>${job.id}`
      if (afterSpawned.has(spawnKey)) continue
      if (await hasChildRun(finished.id, job.id)) {
        afterSpawned.add(spawnKey)
        continue
      }
      afterSpawned.add(spawnKey)
      const child = await enqueueNew(job, {
        triggerSource: 'after',
        hops,
        scheduledAt: now(),
        parentRunId: finished.id,
      })
      if (child !== null) {
        await audit('run.after-dispatched', child.id, `after ${finished.id} → ${job.id} hops=${hops}`)
      }
    }
  }

  /**
   * Consider one job for its due cron window and advance it.
   * @param {object} job job definition.
   * @returns {Promise<void>} resolves when the window is handled.
   */
  async function advanceJob(job) {
    if (!job || job.enabled === false) return
    const trigger = job.trigger ?? {}
    if (trigger.kind !== 'cron' || typeof trigger.cron !== 'string') return

    const zone = jobTimeZone(job)
    const at = now()
    if (job.nextRunAt === null) return

    let next = Number.isFinite(job.nextRunAt) ? job.nextRunAt : null
    if (next === null) {
      const first = nextRunAt(trigger.cron, zone, at)
      await persistWindow(job, first)
      if (first !== null) {
        await audit('job.scheduled', job.id, `首次计算下次运行 ${new Date(first).toISOString()}`)
      }
      return
    }
    if (next > at) return

    const following = nextRunAt(trigger.cron, zone, next)
    const missedBeyondCurrent = following !== null && following <= at
    const catchUp = trigger.catchUp === 'run-once' ? 'run-once' : 'skip'

    if (!missedBeyondCurrent) {
      if (!(await hasRunForWindow(job.id, next))) {
        await enqueueNew(job, { triggerSource: 'cron', scheduledAt: next })
      }
      await persistWindow(job, following, next)
      return
    }

    if (catchUp === 'run-once') {
      if (!(await hasRunForWindow(job.id, next))) {
        const catchUpRun = await enqueueNew(job, { triggerSource: 'cron', scheduledAt: next })
        if (catchUpRun !== null) {
          await audit('run.catch-up', catchUpRun.id, `补跑窗口 ${new Date(next).toISOString()}`)
        }
      } else {
        await audit('job.skipped', job.id, `补跑窗口 ${new Date(next).toISOString()} 已存在运行记录，不重复补跑`)
      }
    } else {
      await audit(
        'job.skipped',
        job.id,
        `错过窗口 ${new Date(next).toISOString()}（后续窗口也已到期），catchUp=skip 不补跑`,
      )
    }

    const future = nextRunAt(trigger.cron, zone, at)
    await persistWindow(job, future)
    if (future !== null) {
      await audit('job.window-advanced', job.id, `窗口推进到 ${new Date(future).toISOString()}`)
    }
  }

  /**
   * One scheduler pass. Serialized: overlapping calls wait for the previous pass.
   * Never rejects.
   * @returns {Promise<void>} resolves when the pass finished.
   */
  function tick() {
    const pass = tickChain.then(() => doTick(), () => doTick())
    tickChain = pass.then(() => undefined, () => undefined)
    return pass
  }

  /**
   * Body of one scheduler pass; every job is isolated so one failure cannot stop
   * the others.
   * @returns {Promise<void>} resolves when all jobs were considered.
   */
  async function doTick() {
    if (disposed) return
    try {
      const jobs = await store.jobs.list()
      for (const job of jobs) {
        try {
          await advanceJob(job)
        } catch (error) {
          logger?.warn?.(`[daily-work-hub] 任务 ${job?.id} 调度失败: ${messageOf(error)}`)
        }
      }
      await pump()
    } catch (error) {
      logger?.error?.(`[daily-work-hub] 调度 tick 失败: ${messageOf(error)}`)
    }
  }

  /**
   * Run one job immediately, bypassing its cron trigger but not its policy.
   * @param {string} jobId job id.
   * @param {object} [params] raw parameters; coerced against the job declaration.
   * @param {'manual'|'cron'|'event'|'after'} [triggerSource] trigger label; defaults to manual.
   * @returns {Promise<object>} the created run (running/queued, or skipped when capped).
   * @throws {Error} when the job is unknown or the parameters are invalid.
   */
  async function runNow(jobId, params, triggerSource = 'manual') {
    if (disposed) throw new Error('调度器已释放')
    const job = await store.jobs.get(jobId)
    if (!job) throw new Error(`任务不存在: ${jobId}`)
    const coerced = coerceParams(job, params)
    if (!coerced.ok) {
      throw new Error(`参数不合法: ${coerced.errors.map((error) => error.message).join('；')}`)
    }

    const at = now()
    if (await capReached(job, at)) {
      const skipped = finishRun(
        createRun({
          jobId: job.id,
          jobVersion: job.version,
          triggerSource,
          params: coerced.params,
          scheduledAt: at,
          createdAt: at,
        }),
        { state: 'skipped', at, reason: `达到每日运行上限 ${job.policy.maxRunsPerDay}` },
      )
      await store.runs.put(skipped)
      await audit('run.capped', skipped.id, `手动运行被每日上限 ${job.policy.maxRunsPerDay} 拦截`)
      return skipped
    }

    const run = createRun({
      jobId: job.id,
      jobVersion: job.version,
      triggerSource,
      params: coerced.params,
      scheduledAt: at,
      createdAt: at,
      deferredNotify: inQuietHours(job, at) && willNotify(job),
    })
    await store.runs.put(run)
    await audit('run.queued', run.id, `job=${job.id} trigger=${triggerSource} manual`)
    pending.set(run.id, { job, run })
    await pump()
    return (await store.runs.get(run.id)) ?? run
  }

  /**
   * Cancel a queued or running run.
   * @param {string} runId run id.
   * @returns {Promise<object|undefined>} current run record, or undefined when unknown.
   */
  async function cancel(runId) {
    const live = active.get(runId)
    if (live) {
      cancelled.add(runId)
      try {
        live.controller.abort()
      } catch {
        // abort on an already-settled controller is a no-op
      }
      await audit('run.cancel-requested', runId, '用户请求取消运行中的任务')
      return (await store.runs.get(runId)) ?? undefined
    }

    const queued = pending.get(runId)
    if (queued) {
      pending.delete(runId)
      const stopped = finishRun(queued.run, { state: 'cancelled', at: now(), reason: '用户取消' })
      await store.runs.put(stopped)
      await audit('run.cancelled', stopped.id, '排队中的运行已取消')
      await pump()
      return stopped
    }

    const stored = await store.runs.get(runId)
    if (!stored) return undefined
    if (isTerminal(stored)) return stored
    if (stored.state === 'queued') {
      const stopped = finishRun(stored, { state: 'cancelled', at: now(), reason: '用户取消' })
      await store.runs.put(stopped)
      await audit('run.cancelled', stopped.id, '排队中的运行已取消')
      return stopped
    }
    return stored
  }

  /**
   * List upcoming cron windows across enabled jobs.
   * @param {number} [limit] how many entries to return, 1–50 (default 5).
   * @returns {Promise<{ jobId: string, at: number }[]>} sorted by time ascending.
   */
  async function nextRuns(limit = 5) {
    const count = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 5
    let jobs
    try {
      jobs = await store.jobs.list()
    } catch (error) {
      logger?.warn?.(`[daily-work-hub] 读取任务列表失败: ${messageOf(error)}`)
      return []
    }

    const at = now()
    const upcoming = []
    for (const job of jobs) {
      if (!job || job.enabled === false) continue
      const trigger = job.trigger ?? {}
      if (trigger.kind !== 'cron' || typeof trigger.cron !== 'string') continue
      const zone = jobTimeZone(job)
      try {
        let cursor = Number.isFinite(job.nextRunAt) && job.nextRunAt > at
          ? job.nextRunAt
          : nextRunAt(trigger.cron, zone, at)
        let guard = 0
        while (cursor !== null && guard < count) {
          upcoming.push({ jobId: job.id, at: cursor })
          cursor = nextRunAt(trigger.cron, zone, cursor)
          guard += 1
        }
      } catch (error) {
        logger?.warn?.(`[daily-work-hub] 任务 ${job.id} 的下次运行计算失败: ${messageOf(error)}`)
      }
    }
    upcoming.sort((a, b) => a.at - b.at || a.jobId.localeCompare(b.jobId))
    return upcoming.slice(0, count)
  }

  /**
   * Startup recovery: orphaned `running` runs become `interrupted` and are
   * retried at most once when `policy.retry.max > 0`; leftover queued runs from a
   * previous process are re-queued.
   * @returns {Promise<{ interrupted: number, retried: number, requeued: number }>} recovery summary.
   */
  async function recover() {
    if (disposed) return { interrupted: 0, retried: 0, requeued: 0 }
    const at = now()
    let runs
    try {
      runs = await store.runs.list({ limit: RUN_SCAN_LIMIT })
    } catch (error) {
      logger?.warn?.(`[daily-work-hub] 恢复时读取运行记录失败: ${messageOf(error)}`)
      return { interrupted: 0, retried: 0, requeued: 0 }
    }

    const orphans = runs
      .filter((run) => run.state === 'running' && !active.has(run.id))
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))

    let retried = 0
    for (const orphan of orphans) {
      const job = await store.jobs.get(orphan.jobId)
      const interrupted = finishRun(orphan, {
        state: 'interrupted',
        at,
        error: orphan.error ?? '进程重启时任务仍在运行，已标记中断',
      })
      await store.runs.put(interrupted)
      await audit('run.interrupted', interrupted.id, `job=${orphan.jobId} 重启恢复`)

      const retryMax = Number(job?.policy?.retry?.max) || 0
      const attempts = Number.isFinite(orphan.attempts) ? orphan.attempts : 1
      if (job && retryMax > 0 && attempts < 2) {
        const retry = createRun({
          jobId: job.id,
          jobVersion: job.version,
          triggerSource: orphan.triggerSource ?? 'cron',
          params: orphan.params ?? paramDefaults(job),
          hops: orphan.hops ?? 0,
          scheduledAt: at,
          createdAt: at,
          attempts: attempts + 1,
          retryOf: orphan.id,
          deferredNotify: inQuietHours(job, at) && willNotify(job),
        })
        await store.runs.put(retry)
        await audit('run.retry', retry.id, `重试中断的 ${orphan.id}`)
        pending.set(retry.id, { job, run: retry })
        retried += 1
      }
    }

    let requeued = 0
    for (const run of runs) {
      if (run.state !== 'queued' || pending.has(run.id) || active.has(run.id)) continue
      const job = await store.jobs.get(run.jobId)
      if (!job) continue
      pending.set(run.id, { job, run })
      requeued += 1
    }

    await pump()
    return { interrupted: orphans.length, retried, requeued }
  }

  /**
   * Register the periodic tick. Uses the injected host timer; falls back to the
   * global `setInterval` only when no timer was supplied.
   * @returns {() => void} disposer that stops the timer.
   */
  function start() {
    if (disposed) return () => {}
    if (stopTimer !== null) stopTimer()

    const run = () => {
      tick().catch((error) => {
        logger?.error?.(`[daily-work-hub] 调度 tick 异常: ${messageOf(error)}`)
      })
    }

    let disposer
    if (timer !== undefined && timer !== null && typeof timer.interval === 'function') {
      disposer = timer.interval(run, tickMs)
    } else if (typeof timer === 'function') {
      disposer = timer(run, tickMs)
    } else {
      const handle = globalThis.setInterval(run, tickMs)
      handle.unref?.()
      disposer = () => globalThis.clearInterval(handle)
    }

    stopTimer = typeof disposer === 'function' ? disposer : () => {}
    return stopTimer
  }

  /**
   * Stop the timer, abort live executions and drop queued runs.
   * @returns {void}
   */
  function dispose() {
    disposed = true
    if (stopTimer !== null) {
      try {
        stopTimer()
      } catch {
        // disposing twice is harmless
      }
      stopTimer = null
    }
    for (const entry of active.values()) {
      try {
        entry.controller.abort()
      } catch {
        // ignore
      }
    }
    pending.clear()
  }

  return { start, tick, runNow, cancel, nextRuns, recover, dispose }
}