import test from 'node:test'
import assert from 'node:assert/strict'

import { createScheduler } from '../lib/scheduler.js'
import { artifactPath, summarizeRun, EXECUTORS } from '../lib/runs.js'

/** Aligned to a `*​/5` cron window in UTC. */
const T0 = Date.parse('2026-11-09T00:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * Virtual clock: tests advance it explicitly, so no real timer ever fires.
 * @param {number} [start] initial epoch ms.
 * @returns {{ now: () => number, set: (value: number) => void, add: (ms: number) => void }} clock helpers.
 */
function createClock(start = T0) {
  let current = start
  return {
    now: () => current,
    set(value) {
      current = value
    },
    add(ms) {
      current += ms
    },
  }
}

/**
 * Minimal in-memory store implementing the subset of CONTRACTS §3 the scheduler
 * is allowed to touch. Records are cloned on read/write, like the real store.
 * @returns {object} fake store with `jobs`, `runs`, `audit` plus test accessors.
 */
function createFakeStore() {
  const jobs = new Map()
  const runs = new Map()
  const auditEntries = []
  let revision = 0
  const clone = (value) => structuredClone(value)

  return {
    getRevision() {
      return revision
    },
    onChange() {
      return () => {}
    },
    jobs: {
      list: async () => [...jobs.values()].map(clone),
      get: async (id) => (jobs.has(id) ? clone(jobs.get(id)) : undefined),
      put: async (job) => {
        jobs.set(job.id, clone(job))
        revision += 1
        return clone(job)
      },
      remove: async (id) => {
        jobs.delete(id)
        revision += 1
      },
    },
    runs: {
      list: async ({ jobId, limit } = {}) => {
        let rows = [...runs.values()]
        if (jobId !== undefined) rows = rows.filter((run) => run.jobId === jobId)
        rows.sort(
          (a, b) =>
            (b.createdAt ?? b.scheduledAt ?? 0) - (a.createdAt ?? a.scheduledAt ?? 0) ||
            String(b.id).localeCompare(String(a.id)),
        )
        if (Number.isInteger(limit)) rows = rows.slice(0, limit)
        return rows.map(clone)
      },
      get: async (id) => (runs.has(id) ? clone(runs.get(id)) : undefined),
      put: async (run) => {
        runs.set(run.id, clone(run))
        revision += 1
        return clone(run)
      },
    },
    audit: {
      append: async (entry) => {
        auditEntries.push({ id: `audit-${auditEntries.length}`, at: 0, ...entry })
        revision += 1
      },
      list: async ({ subject, limit } = {}) => {
        let rows = [...auditEntries].reverse()
        if (subject !== undefined) rows = rows.filter((entry) => entry.subject === subject)
        if (Number.isInteger(limit)) rows = rows.slice(0, limit)
        return rows
      },
    },
    get _audit() {
      return auditEntries
    },
    get _revision() {
      return revision
    },
  }
}

/**
 * Build a job record with production-shaped defaults.
 * @param {string} id job id.
 * @param {object} [overrides] shallow overrides; `trigger` and `policy` merge one level.
 * @returns {object} job definition.
 */
function makeJob(id, overrides = {}) {
  const base = {
    id,
    name: id,
    version: 1,
    enabled: true,
    trigger: { kind: 'cron', cron: '*/5 * * * *', tz: 'UTC', catchUp: 'skip' },
    executor: { kind: 'dry-run' },
    params: [],
    inputs: [],
    output: { kind: 'artifact', path: `reports/${id}-{{date}}.md` },
    policy: {
      concurrency: 1,
      timeoutMin: 0,
      retry: { max: 0, backoff: '5m' },
      maxRunsPerDay: 0,
      quietHours: [],
    },
  }
  const merged = { ...base, ...overrides }
  merged.trigger = { ...base.trigger, ...(overrides.trigger ?? {}) }
  merged.policy = {
    ...base.policy,
    ...(overrides.policy ?? {}),
    retry: { ...base.policy.retry, ...(overrides.policy?.retry ?? {}) },
  }
  if (overrides.output !== undefined) merged.output = overrides.output
  return merged
}

/**
 * Execution recorder. Immediate mode resolves right away; deferred mode keeps
 * the run busy until the test releases it, so lane/concurrency timelines are
 * fully deterministic on the virtual clock.
 * @param {{ now?: () => number, immediate?: boolean, abortRejects?: boolean }} options recorder options.
 * @returns {object} executor facade with calls and assertions helpers.
 */
function createExecutor(options = {}) {
  const now = options.now ?? (() => 0)
  const calls = []
  const waiting = []
  const active = new Set()
  const laneCounts = new Map()
  let maxActive = 0
  let maxLane = 0

  /**
   * Record one execution and return its result promise.
   * @param {{ job: object, run: object, params: object, signal: AbortSignal }} context execution context.
   * @returns {Promise<object>} execution result.
   */
  function execute(context) {
    const lane = context.job.policy?.laneKey
    const call = {
      jobId: context.job.id,
      runId: context.run.id,
      params: context.params,
      signal: context.signal,
      startedAt: now(),
      endedAt: null,
      resolve: null,
      reject: null,
    }
    calls.push(call)
    active.add(call)
    maxActive = Math.max(maxActive, active.size)
    if (typeof lane === 'string' && lane !== '') {
      laneCounts.set(lane, (laneCounts.get(lane) ?? 0) + 1)
      maxLane = Math.max(maxLane, laneCounts.get(lane))
    }

    const finish = () => {
      if (call.endedAt !== null) return
      call.endedAt = now()
      active.delete(call)
      if (typeof lane === 'string' && lane !== '') {
        laneCounts.set(lane, laneCounts.get(lane) - 1)
      }
    }

    const defaultResult = { artifacts: [{ path: `${context.job.id}.md` }] }
    if (options.immediate === true) {
      finish()
      return Promise.resolve(defaultResult)
    }
    return new Promise((resolve, reject) => {
      call.resolve = (result = defaultResult) => {
        const index = waiting.indexOf(call)
        if (index >= 0) waiting.splice(index, 1)
        finish()
        resolve(result)
      }
      call.reject = (error) => {
        const index = waiting.indexOf(call)
        if (index >= 0) waiting.splice(index, 1)
        finish()
        reject(error)
      }
      if (options.abortRejects === true) {
        context.signal.addEventListener('abort', () => call.reject(new Error('aborted')))
      }
      waiting.push(call)
    })
  }

  return {
    execute,
    calls,
    waiting,
    get maxActive() {
      return maxActive
    },
    get maxLane() {
      return maxLane
    },
  }
}

/**
 * Let every pending microtask settle without waiting on a timer.
 * @returns {Promise<void>} resolves on the next event-loop turn.
 */
function settle() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Release every deferred execution.
 * @param {object} executor recorder.
 * @returns {void}
 */
function releaseAll(executor) {
  for (const call of [...executor.waiting]) call.resolve()
}

/**
 * Release deferred executions until nothing is left, letting each finished run
 * start whatever was queued behind it.
 * @param {object} executor recorder.
 * @returns {Promise<void>} resolves when the queue is empty.
 */
async function drain(executor) {
  for (let guard = 0; guard < 10 && executor.waiting.length > 0; guard += 1) {
    releaseAll(executor)
    await settle()
  }
}

test('S1 同一到期只产生一个 Run；重复 tick 不重复跑', async () => {
  const store = createFakeStore()
  const clock = createClock(T0)
  await store.jobs.put(makeJob('job-cron', { nextRunAt: T0 }))
  const executor = createExecutor({ now: clock.now, immediate: true })
  const scheduler = createScheduler({ store, now: clock.now, execute: executor.execute })

  await scheduler.tick()
  await settle()
  let runs = await store.runs.list({ jobId: 'job-cron' })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].state, 'succeeded')
  assert.equal(runs[0].scheduledAt, T0)
  assert.equal(runs[0].triggerSource, 'cron')

  // 模拟“窗口推进写入丢失”：把 nextRunAt 拨回同一窗口，重复 tick 不得新增 Run
  const rewound = await store.jobs.get('job-cron')
  rewound.nextRunAt = T0
  await store.jobs.put(rewound)
  await scheduler.tick()
  await settle()
  runs = await store.runs.list({ jobId: 'job-cron' })
  assert.equal(runs.length, 1)
  assert.equal((await store.jobs.get('job-cron')).nextRunAt, T0 + 5 * MINUTE)

  scheduler.dispose()
})

test('S1b 下个窗口正常再跑', async () => {
  const store = createFakeStore()
  const clock = createClock(T0)
  await store.jobs.put(makeJob('job-cron', { nextRunAt: T0 }))
  const executor = createExecutor({ now: clock.now, immediate: true })
  const scheduler = createScheduler({ store, now: clock.now, execute: executor.execute })

  await scheduler.tick()
  await settle()
  clock.set(T0 + 5 * MINUTE)
  await scheduler.tick()
  await settle()

  const runs = await store.runs.list({ jobId: 'job-cron' })
  assert.equal(runs.length, 2)
  assert.deepEqual(
    runs.map((run) => run.scheduledAt).sort((a, b) => a - b),
    [T0, T0 + 5 * MINUTE],
  )
  assert.equal(executor.calls.length, 2)
  assert.equal((await store.jobs.get('job-cron')).nextRunAt, T0 + 10 * MINUTE)
  scheduler.dispose()
})

test('S2 同 laneKey 串行（时间线不重叠）', async () => {
  const store = createFakeStore()
  const clock = createClock(T0)
  const lane = 'gp/order-service'
  await store.jobs.put(makeJob('job-a', { nextRunAt: T0, policy: { laneKey: lane, concurrency: 3 } }))
  await store.jobs.put(makeJob('job-b', { nextRunAt: T0, policy: { laneKey: lane, concurrency: 3 } }))
  const executor = createExecutor({ now: clock.now })
  const scheduler = createScheduler({ store, now: clock.now, execute: executor.execute })

  await scheduler.tick()
  await settle()
  let runs = await store.runs.list()
  assert.equal(runs.filter((run) => run.state === 'running').length, 1)
  assert.equal(runs.filter((run) => run.state === 'queued').length, 1)
  assert.equal(executor.calls.length, 1)
  assert.equal(executor.maxLane, 1)

  clock.add(1000)
  executor.waiting[0].resolve()
  await settle()
  assert.equal(executor.calls.length, 2)
  const ordered = [...executor.calls].sort((a, b) => a.startedAt - b.startedAt)
  assert.ok(ordered[1].startedAt >= ordered[0].endedAt, '第二个 Run 必须在上一个结束后才开始')
  assert.equal(executor.maxLane, 1)

  releaseAll(executor)
  await settle()
  runs = await store.runs.list()
  assert.equal(runs.length, 2)
  for (const run of runs) assert.equal(run.state, 'succeeded')
  scheduler.dispose()
})

test('S3 不同 lane 可并行；per-job concurrency 与同 lane 排队生效', async () => {
  const store = createFakeStore()
  const clock = createClock(T0)
  await store.jobs.put(makeJob('job-x', { policy: { laneKey: 'lane-x' } }))
  await store.jobs.put(makeJob('job-y', { policy: { laneKey: 'lane-y' } }))
  await store.jobs.put(makeJob('job-p', { policy: { concurrency: 2 } }))
  await store.jobs.put(makeJob('job-q', { policy: { laneKey: 'lane-q', concurrency: 1 } }))
  const executor = createExecutor({ now: clock.now })
  const scheduler = createScheduler({ store, now: clock.now, execute: executor.execute })

  const x = await scheduler.runNow('job-x')
  const y = await scheduler.runNow('job-y')
  assert.equal(x.state, 'running')
  assert.equal(y.state, 'running')
  assert.equal(executor.calls.length, 2)
  assert.equal(executor.maxActive, 2)

  const p1 = await scheduler.runNow('job-p')
  const p2 = await scheduler.runNow('job-p')
  assert.equal(p1.state, 'running')
  assert.equal(p2.state, 'running')
  assert.equal(executor.calls.length, 4)

  const q1 = await scheduler.runNow('job-q')
  const q2 = await scheduler.runNow('job-q')
  assert.equal(q1.state, 'running')
  assert.equal(q2.state, 'queued')
  assert.equal(executor.calls.length, 5)
  assert.equal(executor.maxLane, 1)

  releaseAll(executor)
  await settle()
  await drain(executor)
  for (const run of await store.runs.list()) assert.equal(run.state, 'succeeded')
  scheduler.dispose()
})

test('S4 错过 5 期 catchUp=skip 不补跑，窗口推进到未来', async () => {
  const store = createFakeStore()
  const clock = createClock(T0 + 25 * MINUTE)
  await store.jobs.put(makeJob('job-daily', { nextRunAt: T0, trigger: { catchUp: 'skip' } }))
  const executor = createExecutor({ now: clock.now, immediate: true })
  const scheduler = createScheduler({ store, now: clock.now, execute: executor.execute })

  await scheduler.tick()
  await settle()
  const runs = await store.runs.list({ jobId: 'job-daily' })
  assert.equal(runs.length, 0)
  assert.equal(executor.calls.length, 0)
  const job = await store.jobs.get('job-daily')
  assert.equal(job.nextRunAt, T0 + 30 * MINUTE)
  assert.ok(job.nextRunAt > clock.now())
  assert.ok(store._audit.some((entry) => entry.kind === 'job.skipped'))
  scheduler.dispose()
})

test('S5 错过 5 期 catchUp=run-once 只补一次，窗口同样推进到未来', async () => {
  const store = createFakeStore()
  const clock = createClock(T0 + 25 * MINUTE)
  await store.jobs.put(makeJob('job-daily', { nextRunAt: T0, trigger: { catchUp: 'run-once' } }))
  const executor = createExecutor({ now: clock.now, immediate: true })
  const scheduler = createScheduler({ store, now: clock.now, execute: executor.execute })

  await scheduler.tick()
  await settle()
  const runs = await store.runs.list({ jobId: 'job-daily' })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].scheduledAt, T0)
  assert.equal(executor.calls.length, 1)
  const job = await store.jobs.get('job-daily')
  assert.equal(job.nextRunAt, T0 + 30 * MINUTE)
  assert.ok(job.nextRunAt > clock.now())
  assert.ok(store._audit.some((entry) => entry.kind === 'run.catch-up'))

  // 补跑后窗口已在未来：同一时刻再 tick 不得再补
  await scheduler.tick()
  await settle()
  assert.equal((await store.runs.list({ jobId: 'job-daily' })).length, 1)
  scheduler.dispose()
})

test('maxRunsPerDay 拦截窗口运行与手动运行，窗口仍然推进', async () => {
  const store = createFakeStore()
  const clock = createClock(T0)
  await store.jobs.put(makeJob('job-cap', { nextRunAt: T0, policy: { maxRunsPerDay: 1 } }))
  const executor = createExecutor({ now: clock.now, immediate: true })
  const scheduler = createScheduler({ store, now: clock.now, execute: executor.execute })

  await scheduler.tick()
  await settle()
  assert.equal((await store.runs.list({ jobId: 'job-cap' })).length, 1)

  clock.set(T0 + 5 * MINUTE)
  await scheduler.tick()
  await settle()
  let runs = await store.runs.list({ jobId: 'job-cap' })
  assert.equal(runs.length, 1)
  assert.equal(executor.calls.length, 1)
  assert.equal((await store.jobs.get('job-cap')).nextRunAt, T0 + 10 * MINUTE)
  assert.ok(store._audit.some((entry) => entry.kind === 'run.capped'))

  const manual = await scheduler.runNow('job-cap')
  await settle()
  assert.equal(manual.state, 'skipped')
  assert.match(manual.reason, /每日运行上限/)
  assert.equal(executor.calls.length, 1)
  runs = await store.runs.list({ jobId: 'job-cap' })
  assert.equal(runs.filter((run) => run.state === 'succeeded').length, 1)
  assert.equal(runs.filter((run) => run.state === 'skipped').length, 1)
  scheduler.dispose()
})

test('S6 after 链第 9 跳熔断，只审计不派发', async () => {
  const store = createFakeStore()
  const clock = createClock(T0)
  await store.jobs.put(makeJob('j0', { nextRunAt: T0 }))
  for (let index = 1; index <= 10; index += 1) {
    await store.jobs.put(
      makeJob(`j${index}`, {
        trigger: {
          kind: 'after',
          after: { jobIds: [`j${index - 1}`], status: 'success' },
        },
      }),
    )
  }
  const executor = createExecutor({ now: clock.now, immediate: true })
  const scheduler = createScheduler({ store, now: clock.now, execute: executor.execute })

  await scheduler.tick()
  await settle()

  const runs = await store.runs.list()
  assert.equal(runs.length, 9)
  const executed = new Set(runs.map((run) => run.jobId))
  for (let index = 0; index <= 8; index += 1) assert.ok(executed.has(`j${index}`), `应执行 j${index}`)
  assert.equal(executed.has('j9'), false)
  assert.equal(executed.has('j10'), false)
  const deepest = runs.find((run) => run.jobId === 'j8')
  assert.equal(deepest.hops, 8)

  const blocked = store._audit.filter((entry) => entry.kind === 'run.blocked')
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].subject, 'j9')
  assert.match(blocked[0].detail, /第 9 跳/)
  scheduler.dispose()
})

test('S7 recover() 把 running 标为 interrupted 并按 retry.max 重试一次', async () => {
  const store = createFakeStore()
  const clock = createClock(T0)
  await store.jobs.put(
    makeJob('job-slow', { nextRunAt: T0, policy: { retry: { max: 1 } } }),
  )
  const firstExecutor = createExecutor({ now: clock.now })
  const firstScheduler = createScheduler({
    store,
    now: clock.now,
    execute: firstExecutor.execute,
  })

  await firstScheduler.tick()
  await settle()
  let runs = await store.runs.list({ jobId: 'job-slow' })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].state, 'running')
  const originalId = runs[0].id

  // 进程“重启”：新调度器没有内存中的活动执行，旧运行成为孤儿
  clock.add(1000)
  const secondExecutor = createExecutor({ now: clock.now, immediate: true })
  const secondScheduler = createScheduler({
    store,
    now: clock.now,
    execute: secondExecutor.execute,
  })

  const summary = await secondScheduler.recover()
  await settle()
  assert.deepEqual(summary, { interrupted: 1, retried: 1, requeued: 0 })

  runs = await store.runs.list({ jobId: 'job-slow' })
  const original = await store.runs.get(originalId)
  assert.equal(original.state, 'interrupted')
  assert.ok(original.finishedAt !== null)
  assert.equal(original.attempts, 1)

  const retry = runs.find((run) => run.retryOf === originalId)
  assert.ok(retry, '应存在重试 Run')
  assert.equal(retry.attempts, 2)
  assert.equal(retry.state, 'succeeded')
  assert.equal(secondExecutor.calls.length, 1)

  // S7b：重试只产出一个产物，且不会再次重试
  const totalArtifacts = runs.reduce((sum, run) => sum + (run.artifacts?.length ?? 0), 0)
  assert.equal(totalArtifacts, 1)
  assert.deepEqual(await secondScheduler.recover(), { interrupted: 0, retried: 0, requeued: 0 })
  assert.equal(secondExecutor.calls.length, 1)

  firstScheduler.dispose()
  secondScheduler.dispose()
})

test('recover() 重新入队上一个进程遗留的 queued Run', async () => {
  const store = createFakeStore()
  const clock = createClock(T0 + 1000)
  await store.jobs.put(makeJob('job-legacy'))
  await store.runs.put({
    id: 'run-legacy',
    jobId: 'job-legacy',
    jobVersion: 1,
    triggerSource: 'manual',
    params: {},
    state: 'queued',
    scheduledAt: T0,
    createdAt: T0,
    startedAt: null,
    finishedAt: null,
    hops: 0,
    artifacts: [],
    attempts: 1,
    log: [],
    deferredNotify: false,
  })
  const executor = createExecutor({ now: clock.now, immediate: true })
  const scheduler = createScheduler({ store, now: clock.now, execute: executor.execute })

  const summary = await scheduler.recover()
  await settle()
  assert.deepEqual(summary, { interrupted: 0, retried: 0, requeued: 1 })
  assert.equal((await store.runs.get('run-legacy')).state, 'succeeded')
  scheduler.dispose()
})

test('cancel() 取消运行中的 Run 并中止 signal', async () => {
  const store = createFakeStore()
  const clock = createClock(T0)
  await store.jobs.put(makeJob('job-cancel', { nextRunAt: T0 }))
  const executor = createExecutor({ now: clock.now, abortRejects: true })
  const scheduler = createScheduler({ store, now: clock.now, execute: executor.execute })

  await scheduler.tick()
  await settle()
  const [run] = await store.runs.list({ jobId: 'job-cancel' })
  assert.equal(run.state, 'running')
  const call = executor.calls[0]

  await scheduler.cancel(run.id)
  assert.equal(call.signal.aborted, true)
  await settle()

  const stored = await store.runs.get(run.id)
  assert.equal(stored.state, 'cancelled')
  assert.equal(stored.reason, '用户取消')
  assert.equal(executor.maxActive, 1)
  scheduler.dispose()
})

test('cancel() 取消排队中的 Run', async () => {
  const store = createFakeStore()
  const clock = createClock(T0)
  await store.jobs.put(makeJob('job-queue', { policy: { laneKey: 'lane-q', concurrency: 1 } }))
  const executor = createExecutor({ now: clock.now })
  const scheduler = createScheduler({ store, now: clock.now, execute: executor.execute })

  await scheduler.runNow('job-queue')
  const queued = await scheduler.runNow('job-queue')
  assert.equal(queued.state, 'queued')

  const cancelled = await scheduler.cancel(queued.id)
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(executor.calls.length, 1)
  releaseAll(executor)
  await settle()
  scheduler.dispose()
})

test('execute 抛错时 tick 不抛出，Run 标为 failed，其他任务继续', async () => {
  const store = createFakeStore()
  const clock = createClock(T0)
  await store.jobs.put(makeJob('job-bad', { nextRunAt: T0 }))
  await store.jobs.put(makeJob('job-good', { nextRunAt: T0 }))
  const good = createExecutor({ now: clock.now, immediate: true })
  const execute = async (context) => {
    if (context.job.id === 'job-bad') throw new Error('boom')
    return good.execute(context)
  }
  const scheduler = createScheduler({ store, now: clock.now, execute })

  await assert.doesNotReject(() => scheduler.tick())
  await settle()

  const bad = await store.runs.list({ jobId: 'job-bad' })
  const ok = await store.runs.list({ jobId: 'job-good' })
  assert.equal(bad[0].state, 'failed')
  assert.equal(bad[0].error, 'boom')
  assert.equal(ok[0].state, 'succeeded')
  scheduler.dispose()
})

test('quietHours 只延后通知，任务照常执行', async () => {
  const store = createFakeStore()
  const clock = createClock(Date.parse('2026-11-09T15:00:00Z')) // 上海 23:00
  await store.jobs.put(
    makeJob('job-quiet', {
      nextRunAt: clock.now(),
      trigger: { tz: 'Asia/Shanghai' },
      output: { kind: 'notification', notify: 'notification' },
      policy: { quietHours: ['22:00-08:00'] },
    }),
  )
  const executor = createExecutor({ now: clock.now, immediate: true })
  const scheduler = createScheduler({ store, now: clock.now, execute: executor.execute })

  await scheduler.tick()
  await settle()
  let runs = await store.runs.list({ jobId: 'job-quiet' })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].state, 'succeeded')
  assert.equal(runs[0].deferredNotify, true)

  const noon = Date.parse('2026-11-10T04:00:00Z') // 上海 12:00
  clock.set(noon)
  const job = await store.jobs.get('job-quiet')
  job.nextRunAt = noon
  await store.jobs.put(job)
  await scheduler.tick()
  await settle()

  runs = await store.runs.list({ jobId: 'job-quiet' })
  const later = runs.find((run) => run.scheduledAt === noon)
  assert.ok(later, '应产生中午的 Run')
  assert.equal(later.deferredNotify, false)
  assert.equal(later.state, 'succeeded')
  scheduler.dispose()
})

test('nextRuns() 返回按时间升序的未来窗口', async () => {
  const store = createFakeStore()
  const clock = createClock(T0)
  await store.jobs.put(
    makeJob('job-morning', { trigger: { cron: '0 8 * * *' }, nextRunAt: undefined }),
  )
  await store.jobs.put(
    makeJob('job-late', { trigger: { cron: '0 9 * * *' }, nextRunAt: undefined }),
  )
  await store.jobs.put(makeJob('job-off', { enabled: false }))
  const executor = createExecutor({ now: clock.now, immediate: true })
  const scheduler = createScheduler({ store, now: clock.now, execute: executor.execute })

  const list = await scheduler.nextRuns(3)
  assert.equal(list.length, 3)
  assert.deepEqual(
    list.map((entry) => entry.at),
    [T0 + 8 * HOUR, T0 + 9 * HOUR, T0 + 32 * HOUR],
  )
  assert.deepEqual(
    list.slice(0, 2).map((entry) => entry.jobId),
    ['job-morning', 'job-late'],
  )
  assert.equal((await scheduler.nextRuns(1)).length, 1)
  scheduler.dispose()
})

test('start() 使用注入的 timer，dispose() 清理', async () => {
  const store = createFakeStore()
  const clock = createClock(T0)
  await store.jobs.put(makeJob('job-timer', { nextRunAt: T0 }))
  const registrations = []
  let stopped = false
  const fakeTimer = {
    interval(fn, ms) {
      registrations.push({ fn, ms })
      return () => {
        stopped = true
      }
    },
  }
  const executor = createExecutor({ now: clock.now, immediate: true })
  const scheduler = createScheduler({
    store,
    now: clock.now,
    execute: executor.execute,
    timer: fakeTimer,
    tickMs: 1234,
  })

  const disposer = scheduler.start()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].ms, 1234)

  registrations[0].fn()
  await settle()
  assert.equal((await store.runs.list({ jobId: 'job-timer' })).length, 1)

  disposer()
  assert.equal(stopped, true)
  scheduler.dispose()
})

test('runNow() 校验参数、拒绝未知任务并返回 Run', async () => {
  const store = createFakeStore()
  const clock = createClock(T0)
  await store.jobs.put(
    makeJob('job-params', {
      trigger: { kind: 'manual' },
      params: [{ key: 'range', type: 'enum', values: ['a', 'b'], default: 'a' }],
    }),
  )
  const executor = createExecutor({ now: clock.now, immediate: true })
  const scheduler = createScheduler({ store, now: clock.now, execute: executor.execute })

  const run = await scheduler.runNow('job-params', { range: 'b' })
  await settle()
  assert.equal(run.params.range, 'b')
  assert.equal(run.jobId, 'job-params')
  assert.equal(run.triggerSource, 'manual')
  assert.equal((await store.runs.get(run.id)).state, 'succeeded')

  const defaulted = await scheduler.runNow('job-params')
  await settle()
  assert.equal(defaulted.params.range, 'a')

  await assert.rejects(() => scheduler.runNow('job-missing'), /任务不存在/)
  await assert.rejects(() => scheduler.runNow('job-params', { range: 'zzz' }), /参数不合法/)
  await assert.rejects(() => scheduler.runNow('job-params', { nope: 1 }), /参数不合法/)
  scheduler.dispose()
})

test('runs 助手：artifactPath 展开/越界与 EXECUTORS 描述', () => {
  const job = { id: 'job-weekly', trigger: { tz: 'UTC' } }
  const run = { id: 'run-1' }

  assert.equal(
    artifactPath('reports/weekly-{{date}}.md', { job, run, now: T0 }),
    'reports/weekly-2026-11-09.md',
  )
  assert.equal(
    artifactPath('logs/{{job}}-{{run}}-{{time}}.log', { job, run, now: T0 }),
    'logs/job-weekly-run-1-00-00-00.log',
  )
  assert.equal(artifactPath('../escape.md', { job, run, now: T0 }), null)
  assert.equal(artifactPath('/absolute.md', { job, run, now: T0 }), null)
  assert.equal(artifactPath(undefined, {}), null)

  assert.equal(
    EXECUTORS.command.describe(null, { executor: { command: 'ls', cwd: '.' } }),
    '命令 ls · 目录 .',
  )
  assert.equal(
    EXECUTORS.session.describe(null, { executor: { kind: 'session', access: 'read-only' } }),
    '会话执行 · 自由提示词 · 只读',
  )

  const summary = summarizeRun({
    id: 'run-1',
    jobId: 'job-weekly',
    state: 'succeeded',
    triggerSource: 'cron',
    scheduledAt: T0,
    startedAt: T0,
    finishedAt: T0 + 500,
    hops: 0,
    attempts: 1,
    artifacts: [{ path: 'a.md' }],
    deferredNotify: true,
  })
  assert.equal(summary.durationMs, 500)
  assert.deepEqual(summary.artifacts, ['a.md'])
  assert.equal(summary.deferredNotify, true)
})