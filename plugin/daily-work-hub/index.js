/**
 * daily-work-hub — Host half.
 *
 * One page, four loops:
 * 1. `lib/poller.js` turns GitLab state into work items (every N seconds).
 * 2. `lib/review.js` turns one work item into a review turn (on demand).
 * 3. `lib/scheduler.js` turns job definitions into runs (cron / manual / after).
 * 4. `lib/routes.js` serves all of it to the browser panel.
 *
 * Registration surface (verified against this Desktop host's live service
 * catalogue — see docs/CONTRACTS.md §0): `webServer.register`, `connection.
 * requestRejection`, `storageDomain`, `credentials`, `agents.create` +
 * `agent.followup`/`whenIdle`, `subagents.prompt`, `timer.interval`, `tools.
 * register`. Every one of them is optional at runtime: the plugin degrades
 * (file store, heuristic review, no tools) instead of failing to mount.
 */

import { createGitlabAdapter } from './lib/gitlab.js'
import { SEED_JOBS, coerceParams, normalizeJob, paramDefaults, validateJob } from './lib/jobs.js'
import { createPoller } from './lib/poller.js'
import { createRouter } from './lib/routes.js'
import { createScheduler } from './lib/scheduler.js'
import { createReviewer } from './lib/review.js'
import { SEED_TEMPLATES, createTemplateStore, renderPrompt } from './lib/templates.js'
import { TOKEN_REF, createStore } from './lib/store.js'
import { countItems, filterItems, snoozeUntil, sortRecent, sortRecommended } from './lib/reasons.js'
import {
  clamp,
  createLogger,
  isoTimestamp,
  normalizeError,
  redact,
  relativeTime,
  shortId,
  truncate,
} from './lib/util.js'

/** Plugin name as it appears in the Loader tree. */
export const name = 'daily-work-hub'

/** Hard dependency: without a web server the panel has no data channel. */
export const inject = ['webServer']

/** Version reported by the panel and the ping route; keep in step with package.json. */
export const VERSION = '0.2.0'

/** Minimum poll interval, in seconds. */
const MIN_POLL_INTERVAL_SEC = 15

/** Build the Config schema when the host resolves schemastery (optional). */
function buildConfigSchema(z) {
  if (z === undefined) return undefined
  try {
    return z.object({
      instance: z.string().default('default'),
      pollIntervalSec: z.natural().default(60),
      reviewConcurrency: z.natural().default(3),
      dataDir: z.string().default(''),
    })
  } catch {
    return undefined
  }
}

let schema
try {
  schema = (await import('@deepseek-ai/schemastery')).default
} catch {
  schema = undefined
}

/** Declared fields; `normalizeConfig` stays authoritative when the schema is absent. */
export const Config = buildConfigSchema(schema)

/** Declared defaults. */
export const DEFAULTS = Object.freeze({
  instance: 'default',
  pollIntervalSec: 60,
  reviewConcurrency: 3,
  dataDir: '',
})

/**
 * Apply defaults to whatever the Loader handed us.
 * @param {unknown} config row config.
 * @returns {{ instance: string, pollIntervalSec: number, reviewConcurrency: number, dataDir: string }} normalized config.
 */
function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const instance = typeof raw.instance === 'string' && raw.instance.trim() !== '' ? raw.instance.trim() : DEFAULTS.instance
  return {
    instance,
    pollIntervalSec: clamp(Number(raw.pollIntervalSec) || DEFAULTS.pollIntervalSec, MIN_POLL_INTERVAL_SEC, 3600),
    reviewConcurrency: clamp(Number(raw.reviewConcurrency) || DEFAULTS.reviewConcurrency, 1, 8),
    dataDir: typeof raw.dataDir === 'string' ? raw.dataDir.trim() : DEFAULTS.dataDir,
  }
}

/**
 * Read one secret through the host credential service, falling back to a
 * plugin-owned store record when the service is absent.
 * @param {any} ctx plugin context.
 * @param {string} ref credential reference name.
 * @param {{ read: () => Promise<string | undefined> }} fallback local fallback.
 * @returns {Promise<string | undefined>} secret value.
 */
async function resolveSecret(ctx, ref, fallback) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(ref)
      const value = typeof resolved === 'string' ? resolved : resolved?.value
      if (typeof value === 'string' && value !== '') return value
    } catch {
      /* fall through to the local fallback */
    }
  }
  return fallback.read()
}

/**
 * Store one secret.
 * @param {any} ctx plugin context.
 * @param {string} ref credential reference name.
 * @param {string} value secret.
 * @param {{ write: (value: string) => Promise<void> }} fallback local fallback.
 * @returns {Promise<void>} resolution after the write.
 */
async function storeSecret(ctx, ref, value, fallback) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.set === 'function') {
    try {
      await credentials.set(ref, value)
      return
    } catch {
      /* fall through */
    }
  }
  await fallback.write(value)
}

/**
 * Nothing in this plugin may throw during mount: a broken optional service must
 * leave the panel usable.
 * @template T
 * @param {() => T} fn work to attempt.
 * @param {any} logger logger.
 * @param {string} label description for the log line.
 * @returns {T | undefined} the value, or undefined on failure.
 */
function attempt(fn, logger, label) {
  try {
    return fn()
  } catch (error) {
    logger.warn(`${label} unavailable: ${normalizeError(error).message}`)
    return undefined
  }
}

/**
 * Plugin body.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {unknown} config row config.
 */
export function apply(ctx, config) {
  const normalized = normalizeConfig(config)
  const logger = createLogger(ctx)

  // One async effect owns the whole lifecycle: store open → loops start →
  // routes mount → reverse everything on unload.
  ctx.effect(async () => {
    const store = await createStore({ ctx, logger, dir: normalized.dataDir === '' ? undefined : normalized.dataDir })

    /** Local secret store used when the credential service is unavailable. */
    const secretFallback = {
      async read() {
        const meta = await store.meta.get()
        return typeof meta.localSecret === 'string' && meta.localSecret !== '' ? meta.localSecret : undefined
      },
      async write(value) {
        await store.meta.patch({ localSecret: value })
        logger.warn('credentials service unavailable: the GitLab token is stored in the plugin data file')
      },
    }

    // ---- seed the libraries once -----------------------------------------
    if ((await store.templates.list()).length === 0) {
      for (const template of SEED_TEMPLATES) await store.templates.put({ ...template })
    }
    if ((await store.jobs.list()).length === 0) {
      for (const job of SEED_JOBS) await store.jobs.put({ ...job })
    }

    const templates = createTemplateStore(store)

    // ---- GitLab adapter, resolved lazily so settings edits apply at once ---
    /** @type {any} */
    let adapter
    let adapterKey = ''

    /**
     * Resolve an adapter for current settings, or throw a helpful error.
     * @returns {Promise<any>} GitLab adapter.
     */
    async function getAdapter() {
      const settings = await store.settings.get()
      const baseUrl = String(settings.gitlabBaseUrl ?? '')
      if (baseUrl === '') throw Object.assign(new Error('GitLab 未配置：请在设置页填写实例地址'), { code: 'not-configured' })
      const token = await resolveSecret(ctx, String(settings.tokenRef ?? TOKEN_REF), secretFallback)
      if (typeof token !== 'string' || token === '') {
        throw Object.assign(new Error('GitLab Token 未配置：请在设置页填写 Token'), { code: 'no-token' })
      }
      const key = `${baseUrl}|${token}`
      if (adapter === undefined || adapterKey !== key) {
        adapter = createGitlabAdapter({ baseUrl, token, logger })
        adapterKey = key
      }
      return adapter
    }

    /**
     * Duck-typed facade so the reviewer stays unaware of adapter caching.
     * @returns {object} adapter proxy.
     */
    const gitlabProxy = {
      getMergeRequest: async (...args) => (await getAdapter()).getMergeRequest(...args),
      getDiffs: async (...args) => (await getAdapter()).getDiffs(...args),
      getDiscussions: async (...args) => (await getAdapter()).getDiscussions(...args),
      getApprovals: async (...args) => (await getAdapter()).getApprovals(...args),
      getPipelines: async (...args) => (await getAdapter()).getPipelines(...args),
      getVersions: async (...args) => (await getAdapter()).getVersions(...args),
      getFileRaw: async (...args) => (await getAdapter()).getFileRaw(...args),
      postNote: async (...args) => (await getAdapter()).postNote(...args),
      postDiscussion: async (...args) => (await getAdapter()).postDiscussion(...args),
      setDiscussionResolved: async (...args) => (await getAdapter()).setDiscussionResolved(...args),
      approve: async (...args) => (await getAdapter()).approve(...args),
      getUser: async (...args) => (await getAdapter()).getUser(...args),
    }

    /** Read provider/model from settings, with a safe fallback. */
    async function modelOptions() {
      const settings = await store.settings.get()
      const options = {}
      if (typeof settings.defaultProvider === 'string' && settings.defaultProvider !== '') options.provider = settings.defaultProvider
      if (typeof settings.defaultModel === 'string' && settings.defaultModel !== '') options.model = settings.defaultModel
      return options
    }

    /**
     * Extract the last assistant text from a live agent, when the host exposes it.
     * @param {any} agent live agent.
     * @returns {string} concatenated text.
     */
    function lastAssistantText(agent) {
      try {
        const messages = agent?.session?.deriveMessages?.() ?? []
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]
          if (message?.role !== 'assistant') continue
          const blocks = Array.isArray(message.content) ? message.content : []
          return blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
        }
      } catch {
        /* the host may not expose the session; caller degrades to heuristic */
      }
      return ''
    }

    // ---- model runner: real sessions first, structured subagents second ----
    const modelRunner = {
      /**
       * Ask a subagent for structured JSON when the provider supports it.
       * @param {{ prompt: string, outputSchema?: object, signal?: AbortSignal }} input request.
       * @returns {Promise<string>} model text.
       */
      async subagent(input) {
        const subagents = ctx.get('subagents')
        if (subagents === undefined || typeof subagents.prompt !== 'function') {
          throw Object.assign(new Error('subagents 服务不可用'), { code: 'unavailable' })
        }
        const receipt = await subagents.prompt(
          {
            prompt: input.prompt,
            outputSchema: input.outputSchema,
            title: '日常工作台审查',
            agentOptions: await modelOptions(),
          },
          input.signal,
        )
        return typeof receipt === 'string' ? receipt : String(receipt?.text ?? receipt?.content ?? '')
      },

      /**
       * Run the review as a real, visible Session in the conversation area.
       * @param {{ prompt: string, sessionId: string, signal?: AbortSignal }} input request.
       * @returns {Promise<{ text: string, sessionId: string }>} model text.
       */
      async session(input) {
        const agents = ctx.get('agents')
        if (agents === undefined || typeof agents.create !== 'function') {
          throw Object.assign(new Error('agents 服务不可用'), { code: 'unavailable' })
        }
        const handle = await agents.create({
          sessionId: input.sessionId,
          meta: { cwd: process.cwd() },
          agentOptions: await modelOptions(),
          setup: (agentCtx) => {
            attempt(
              () => agentCtx.tools?.restrict?.({ deny: ['pwsh', 'write', 'edit'] }),
              logger,
              'read-only tool restriction',
            )
          },
        })
        try {
          await handle.agent.followup({
            content: [{ type: 'text', text: input.prompt }],
            source: { kind: 'daily-work-hub' },
          })
          if (typeof handle.agent.whenIdle === 'function') await handle.agent.whenIdle()
          return { text: lastAssistantText(handle.agent), sessionId: input.sessionId }
        } finally {
          attempt(() => void handle.dispose?.(), logger, 'session dispose')
        }
      },
    }

    const reviewer = createReviewer({
      store,
      gitlab: gitlabProxy,
      templates,
      ctx,
      logger,
      config: { reviewConcurrency: normalized.reviewConcurrency, cwd: process.cwd() },
      runner: modelRunner,
    })

    // ---- poller ----------------------------------------------------------
    const poller = createPoller({
      ctx,
      store,
      logger,
      adapterFactory: getAdapter,
      settingsProvider: () => store.settings.get(),
      source: `gitlab:${normalized.instance}`,
      onChange: () => {},
    })

    /**
     * Expand an artifact path template.
     * @param {string} template path template.
     * @param {any} job job.
     * @param {any} run run.
     * @returns {string} absolute path.
     */
    function artifactTarget(template, job, run) {
      const now = new Date()
      const date = now.toISOString().slice(0, 10)
      const time = now.toISOString().slice(11, 16).replace(':', '')
      return String(template)
        .replace(/\{\{\s*date\s*\}\}/g, date)
        .replace(/\{\{\s*time\s*\}\}/g, time)
        .replace(/\{\{\s*job\s*\}\}/g, String(job?.id ?? 'job'))
        .replace(/\{\{\s*run\s*\}\}/g, String(run?.id ?? 'run'))
    }

    // ---- job execution ---------------------------------------------------
    /**
     * Execute one job run. The only place that starts sessions or subprocesses
     * for jobs, so the scheduler itself stays pure.
     * @param {{ job: any, run: any, params: Record<string, unknown>, signal: AbortSignal }} input execution input.
     * @returns {Promise<object>} outcome fields merged into the run.
     */
    async function executeRun(input) {
      const { job, run, params, signal } = input
      const settings = await store.settings.get()
      const executor = job?.executor ?? {}
      const startedAt = Date.now()

      if (job?.policy?.dryRun === true || executor.kind === 'dry-run') {
        const template = await templates.get(executor.template ?? 'tpl-summary')
        const rendered = renderPrompt(template ?? SEED_TEMPLATES[2], {
          files: { mr: '(dry-run)', diff: '(dry-run)' },
        })
        return {
          usage: { input: 0, output: 0 },
          artifacts: [],
          log: [
            'dry-run：未调用模型，未写任何外部系统',
            `提示词 ${rendered.text.length} 字符`,
            `参数 ${JSON.stringify(params)}`,
            `目录 ${executor.cwd ?? process.cwd()}`,
          ],
        }
      }

      if (executor.kind === 'command') {
        const subprocess = ctx.get('subprocess')
        if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
          throw Object.assign(new Error('command 执行器不可用（宿主没有 subprocess 服务）'), { code: 'unavailable' })
        }
        const handle = subprocess.spawn({
          command: String(executor.command ?? ''),
          args: [],
          cwd: executor.cwd ?? process.cwd(),
          signal,
        })
        const exitCode = await handle?.exited?.catch?.(() => 1)
        if (exitCode !== 0 && exitCode !== undefined) {
          throw Object.assign(new Error(`命令退出码 ${exitCode}`), { code: 'command-failed' })
        }
        return { usage: { input: 0, output: 0 }, artifacts: [], log: [`已执行 ${executor.command}`] }
      }

      const template = await templates.get(executor.template ?? 'tpl-review-default')
      const rendered = renderPrompt(template ?? SEED_TEMPLATES[0], {
        files: { mr: '(job)', diff: '(job)', discussions: '(job)', conventions: '(job)' },
      })
      const agents = ctx.get('agents')
      if (agents === undefined || typeof agents.create !== 'function') {
        throw Object.assign(new Error('agents 服务不可用'), { code: 'unavailable' })
      }
      const sessionId = `dw-job-${run.id}`
      const handle = await agents.create({
        sessionId,
        meta: { cwd: executor.cwd ?? process.cwd() },
        agentOptions: {
          provider: settings.defaultProvider || undefined,
          model: settings.defaultModel || undefined,
        },
        setup: (agentCtx) => {
          if (executor.access === 'read-only') {
            attempt(() => agentCtx.tools?.restrict?.({ deny: ['pwsh', 'write', 'edit'] }), logger, 'job tool restriction')
          }
        },
      })
      try {
        await handle.agent.followup({
          content: [{ type: 'text', text: rendered.text }],
          source: { kind: 'daily-work-hub' },
        })
        if (typeof handle.agent.whenIdle === 'function') await handle.agent.whenIdle()
        const text = lastAssistantText(handle.agent)
        const artifacts = []
        if (job.output?.kind === 'artifact' && typeof job.output.path === 'string') {
          const fs = await import('node:fs/promises')
          const path = await import('node:path')
          const target = artifactTarget(job.output.path, job, run)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, text, 'utf8')
          artifacts.push({ path: target, title: path.basename(target) })
        }
        return {
          sessionId,
          usage: { input: 0, output: 0 },
          artifacts,
          log: [`session=${sessionId}`, `耗时 ${relativeTime(startedAt, Date.now())}`],
        }
      } finally {
        attempt(() => void handle.dispose?.(), logger, 'job session dispose')
      }
    }

    const scheduler = createScheduler({
      store,
      timer: ctx.get('timer'),
      logger,
      execute: executeRun,
      notify: async (run, job) => {
        await store.audit.append({
          actor: 'scheduler',
          kind: 'run-finished',
          subject: job?.id,
          detail: { runId: run.id, state: run.state },
        })
      },
    })
    await attempt(() => scheduler.recover(), logger, 'scheduler recovery')

    // ---- item detail cache (process-local, 5 minutes) ---------------------
    const detailCache = new Map()

    /**
     * Build the list-row projection the client consumes.
     * @param {any} item stored work item.
     * @returns {object} row.
     */
    function toRow(item) {
      return {
        key: item.key,
        kind: item.kind,
        subject: item.subject,
        title: item.title,
        project: item.project,
        author: item.author,
        link: item.link,
        reason: item.reason,
        reasons: item.reasons ?? [],
        priority: item.priority ?? 0,
        localState: item.localState,
        remoteState: item.remoteState,
        headSha: item.headSha,
        ci: item.ci ?? null,
        approvals: item.approvals ?? null,
        additions: item.additions ?? 0,
        deletions: item.deletions ?? 0,
        changedFiles: item.changedFiles ?? 0,
        unreadComments: item.unreadComments ?? 0,
        unresolvedDiscussions: item.unresolvedDiscussions ?? 0,
        labels: item.labels ?? [],
        updatedAtRemote: item.updatedAtRemote,
        lastVerdict: item.lastTurn?.verdict ?? null,
        hasFindings: Array.isArray(item.findings) && item.findings.length > 0,
        draft: item.draft === true,
        mergeStatus: item.mergeStatus ?? 'n/a',
      }
    }

    /**
     * Audit one state transition.
     * @param {any} item work item.
     * @param {string} kind audit kind.
     * @param {object} [detail] extra detail.
     * @returns {Promise<void>} resolution after write.
     */
    async function auditItem(item, kind, detail = {}) {
      await store.audit.append({ actor: 'user', kind, subject: item.key, detail })
    }

    /**
     * Apply a local state change.
     * @param {string} key item key.
     * @param {string} nextState target local state.
     * @param {object} [extra] extra fields.
     * @returns {Promise<any>} updated item.
     */
    async function setLocalState(key, nextState, extra = {}) {
      const item = await store.items.get(key)
      if (item === undefined) throw Object.assign(new Error('工作项不存在'), { code: 'not-found' })
      const patched = await store.items.patch(key, () => ({
        localState: nextState,
        seenAt: isoTimestamp(),
        ...extra,
      }))
      await auditItem(patched ?? item, `state-${nextState}`, { from: item.localState })
      return patched
    }

    /**
     * Trim a GitLab diff to what the panel renders.
     * @param {any} diff raw diff.
     * @returns {object} summary.
     */
    function summarizeDiff(diff) {
      const text = typeof diff?.diff === 'string' ? diff.diff : ''
      return {
        oldPath: diff?.old_path ?? '',
        newPath: diff?.new_path ?? '',
        newFile: diff?.new_file === true,
        deletedFile: diff?.deleted_file === true,
        renamedFile: diff?.renamed_file === true,
        generated: diff?.generated_file === true,
        tooLarge: diff?.too_large === true,
        diff: truncate(text, 200_000),
      }
    }

    /**
     * Fetch and cache the rich detail for one item (never throws).
     * @param {any} item work item.
     * @param {{ force?: boolean }} [options] cache control.
     * @returns {Promise<object>} detail payload.
     */
    async function loadDetail(item, options = {}) {
      const cached = detailCache.get(item.key)
      if (options.force !== true && cached !== undefined && Date.now() - cached.at < 5 * 60 * 1000) return cached.value
      const empty = { mr: null, diffs: [], discussions: [], approvals: null, pipelines: [], files: [], error: null }
      if (item.kind !== 'mr') {
        const value = { ...empty, issue: { title: item.title, state: item.remoteState } }
        detailCache.set(item.key, { at: Date.now(), value })
        return value
      }
      try {
        const adapterInstance = await getAdapter()
        const [mr, diffs, discussions, approvals, pipelines] = await Promise.all([
          adapterInstance.getMergeRequest(item.project, item.iid),
          adapterInstance.getDiffs(item.project, item.iid).catch(() => []),
          adapterInstance.getDiscussions(item.project, item.iid).catch(() => []),
          adapterInstance.getApprovals(item.project, item.iid).catch(() => null),
          adapterInstance.getPipelines(item.project, item.iid).catch(() => []),
        ])
        const value = {
          mr,
          diffs: Array.isArray(diffs) ? diffs.map(summarizeDiff) : [],
          discussions: Array.isArray(discussions) ? discussions : [],
          approvals,
          pipelines: Array.isArray(pipelines) ? pipelines : [],
          files: Array.isArray(diffs)
            ? diffs.map((diff) => ({
                path: diff.new_path,
                oldPath: diff.old_path,
                generated: diff.generated_file === true,
                tooLarge: diff.too_large === true,
              }))
            : [],
          error: null,
        }
        detailCache.set(item.key, { at: Date.now(), value })
        return value
      } catch (error) {
        const value = { ...empty, error: normalizeError(error) }
        detailCache.set(item.key, { at: Date.now(), value })
        return value
      }
    }

    /**
     * Compose a comment draft from the last review's findings.
     * @param {any} item work item.
     * @param {string[] | undefined} findingIds selected findings.
     * @returns {string} markdown body.
     */
    function composeComment(item, findingIds) {
      const findings = (item.findings ?? []).filter((finding) =>
        Array.isArray(findingIds) && findingIds.length > 0 ? findingIds.includes(finding.id) : true,
      )
      if (findings.length === 0) {
        return `已审查 ${item.subject}（head ${String(item.headSha).slice(0, 8)}），未发现需要修改的问题。`
      }
      const lines = [`已审查 ${item.subject}（head ${String(item.headSha).slice(0, 8)}），以下 ${findings.length} 点建议：`, '']
      for (const finding of findings) {
        const where = finding.file === undefined ? '' : `\`${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}\` `
        lines.push(`- **${String(finding.severity).toUpperCase()}** ${where}${finding.title}`)
        if (finding.suggestion !== undefined) lines.push(`  - 建议：${finding.suggestion}`)
      }
      lines.push('', '_由日常工作台 AI 审查生成，已人工确认。_')
      return lines.join('\n')
    }

    // ---- host operations (router contract, docs/CONTRACTS.md §7) ----------
    const host = {
      version: VERSION,

      async state() {
        const [items, runs, settings] = await Promise.all([
          store.items.all(),
          store.runs.list({ limit: 200 }),
          store.settings.get(),
        ])
        const token = await resolveSecret(ctx, String(settings.tokenRef ?? TOKEN_REF), secretFallback).catch(() => undefined)
        const meta = await store.meta.get()
        return {
          connection: {
            configured: String(settings.gitlabBaseUrl ?? '') !== '' && typeof token === 'string' && token !== '',
            baseUrl: String(settings.gitlabBaseUrl ?? ''),
            verified: Boolean(meta.poller?.lastSuccessAt),
            lastCheck: meta.poller?.lastSuccessAt ?? null,
            error: poller.status().lastError,
          },
          counts: countItems(items, runs),
          status: poller.status(),
          nav: {
            reviewQueue: countItems(items.filter((item) => ['review_requested', 'approval_required'].includes(item.reason)), runs).total,
            myWork: countItems(items.filter((item) => ['authored', 'authored_feedback', 'changes_requested'].includes(item.reason)), runs).total,
            jobs: (await store.jobs.list()).length,
            running: runs.filter((run) => run.state === 'running').length,
            failed: runs.filter((run) => run.state === 'failed' || run.state === 'interrupted').length,
          },
          version: VERSION,
          time: isoTimestamp(),
        }
      },

      async listItems(query) {
        const all = await store.items.all()
        const filtered = filterItems(all, {
          reason: query.reason,
          project: query.project,
          state: query.state,
          kind: query.kind,
          q: query.q,
        })
        const sorted = query.sort === 'recent' ? sortRecent(filtered) : sortRecommended(filtered)
        const offset = query.offset ?? 0
        const rows = sorted.slice(offset, offset + (query.limit ?? 100)).map(toRow)
        return { total: sorted.length, counts: countItems(all, []), rows }
      },

      async getItem(key) {
        const item = await store.items.get(key)
        if (item === undefined) return undefined
        const detail = await loadDetail(item)
        const turn = item.lastTurn?.id === undefined ? undefined : await store.turns.get(item.lastTurn.id)
        return { item, detail, turn: turn ?? null }
      },

      async runAction(action, input) {
        const key = String(input.key ?? '')
        const item = key === '' ? undefined : await store.items.get(key)
        if (item === undefined && action !== 'refresh') {
          return { ok: false, code: 'bad-request', message: '缺少或无效的工作项 key' }
        }
        switch (action) {
          case 'read':
            await setLocalState(key, 'read')
            return { ok: true, data: { key, localState: 'read' } }

          case 'snooze': {
            const until = snoozeUntil(input.params?.preset ?? '1h')
            await setLocalState(key, 'snoozed', { snoozedUntil: until })
            return { ok: true, data: { key, snoozedUntil: until } }
          }

          case 'archive':
            await setLocalState(key, 'archived')
            return { ok: true, data: { key, localState: 'archived' } }

          case 'unarchive':
            await setLocalState(key, 'read')
            return { ok: true, data: { key, localState: 'read' } }

          case 'ignore':
            await setLocalState(key, 'archived', { closedReason: 'ignored' })
            return { ok: true, data: { key } }

          case 'refresh':
          case 'refresh-item': {
            const fresh = await loadDetail(item, { force: true })
            return { ok: true, data: { detail: fresh } }
          }

          case 'review':
          case 'summarize': {
            const turn = await reviewer.review(item, {
              templateId: input.params?.templateId,
              concurrency: normalized.reviewConcurrency,
              runner: modelRunner,
              force: input.params?.force === true,
            })
            return { ok: true, data: { turnId: turn.id, verdict: turn.verdict, findings: turn.findings?.length ?? 0 } }
          }

          case 'draft-comment': {
            const body = composeComment(item, input.params?.findingIds)
            const draft = { body, headSha: item.headSha, createdAt: isoTimestamp() }
            await store.items.patch(key, () => ({ commentDraft: draft }))
            await auditItem(item, 'draft-comment', { findings: input.params?.findingIds ?? 'all' })
            return { ok: true, data: { draft } }
          }

          case 'publish-comment': {
            const settings = await store.settings.get()
            if (settings.allowWrites === false) {
              return { ok: false, code: 'writes-disabled', message: '设置里已关闭写操作' }
            }
            const body = String(input.params?.body ?? item.commentDraft?.body ?? '')
            if (body.trim() === '') return { ok: false, code: 'bad-request', message: '评论内容为空' }
            if (item.commentDraft?.headSha !== undefined && item.commentDraft.headSha !== item.headSha) {
              return { ok: false, code: 'stale-head', message: 'MR 已更新（head 变化），请重新审查后再发布' }
            }
            const adapterInstance = await getAdapter()
            const note = await adapterInstance.postNote(item.project, item.iid, body)
            await store.items.patch(key, () => ({ commentDraft: null, localState: 'read', closedReason: 'commented' }))
            await auditItem(item, 'publish-comment', { noteId: note?.id ?? null, bytes: body.length })
            return { ok: true, data: { noteId: note?.id ?? null } }
          }

          case 'approve': {
            const settings = await store.settings.get()
            if (settings.allowWrites === false) {
              return { ok: false, code: 'writes-disabled', message: '设置里已关闭写操作' }
            }
            const adapterInstance = await getAdapter()
            await adapterInstance.approve(item.project, item.iid, { sha: item.headSha })
            await auditItem(item, 'approve', { headSha: item.headSha })
            await store.items.patch(key, () => ({ localState: 'done', closedReason: 'approved' }))
            return { ok: true, data: { approved: true } }
          }

          case 'resolve-discussion': {
            const adapterInstance = await getAdapter()
            await adapterInstance.setDiscussionResolved(
              item.project,
              item.iid,
              String(input.params?.discussionId ?? ''),
              true,
            )
            await auditItem(item, 'resolve-discussion', { discussionId: input.params?.discussionId })
            return { ok: true }
          }

          case 'adopt-finding':
          case 'dismiss-finding': {
            const findingId = String(input.params?.findingId ?? '')
            const adopted = action === 'adopt-finding' ? 'adopted' : 'ignored'
            await store.items.patch(key, (current) => ({
              findings: (current.findings ?? []).map((finding) =>
                finding.id === findingId ? { ...finding, adopted, ignoreReason: input.params?.reason ?? null } : finding,
              ),
            }))
            await auditItem(item, action, { findingId, reason: input.params?.reason ?? null })
            return { ok: true }
          }

          default:
            return { ok: false, code: 'unknown-action', message: `未知动作 ${action}` }
        }
      },

      async getTurn(id) {
        return store.turns.get(id)
      },

      async listTurns(query) {
        return store.turns.list(query)
      },

      async listTemplates() {
        return templates.list()
      },

      async saveTemplate(input) {
        const result = await templates.save(input)
        if (result.ok === false) return result
        return { ok: true, templates: await templates.list() }
      },

      async removeTemplate(id) {
        const result = await templates.remove(id)
        if (result.ok === false) return result
        return { ok: true, templates: await templates.list() }
      },

      async previewTemplate(template, vars) {
        const candidate = template?.id === undefined ? template : (await templates.get(template.id)) ?? template
        const rendered = renderPrompt(candidate ?? SEED_TEMPLATES[0], {
          files: {
            mr: 'ctx/turn/mr.json',
            diff: 'ctx/turn/diff.patch',
            discussions: 'ctx/turn/discussions.json',
            conventions: 'ctx/turn/conventions.md',
          },
          ...vars,
        })
        return { text: rendered.text, missing: rendered.missing, used: rendered.used }
      },

      async listJobs() {
        return store.jobs.list()
      },

      async listNextRuns() {
        return scheduler.nextRuns(8)
      },

      async saveJob(input) {
        const existing = await store.jobs.list()
        const validation = validateJob(input, existing)
        if (validation.ok === false) {
          return { ok: false, code: 'validation', message: '任务定义不合法', errors: validation.errors }
        }
        const job = normalizeJob(input, existing)
        await store.jobs.put(job)
        await store.audit.append({ actor: 'user', kind: 'job-save', subject: job.id, detail: { version: job.version } })
        return { ok: true, job, jobs: await store.jobs.list() }
      },

      async removeJob(id) {
        const job = await store.jobs.get(id)
        if (job === undefined) return { ok: false, code: 'not-found', message: '任务不存在' }
        await store.jobs.remove(id)
        await store.audit.append({ actor: 'user', kind: 'job-remove', subject: id })
        return { ok: true, jobs: await store.jobs.list() }
      },

      async toggleJob(id, enabled) {
        const job = await store.jobs.get(id)
        if (job === undefined) return { ok: false, code: 'not-found', message: '任务不存在' }
        const next = { ...job, enabled: enabled === true, version: (job.version ?? 1) + 1 }
        await store.jobs.put(next)
        await store.audit.append({ actor: 'user', kind: 'job-toggle', subject: id, detail: { enabled: next.enabled } })
        return { ok: true, job: next, jobs: await store.jobs.list() }
      },

      async listRuns(query) {
        return store.runs.list(query)
      },

      async getRun(id) {
        return store.runs.get(id)
      },

      async runJob(jobId, params) {
        const job = await store.jobs.get(jobId)
        if (job === undefined) return { ok: false, code: 'not-found', message: '任务不存在' }
        if (job.enabled === false) return { ok: false, code: 'disabled', message: '任务已停用' }
        const coerced = coerceParams(job, params)
        if (coerced.ok === false) return { ok: false, code: 'validation', message: '参数不合法', errors: coerced.errors }
        const run = await scheduler.runNow(jobId, coerced.params, 'manual')
        return { ok: true, run, runs: await store.runs.list({ limit: 50 }) }
      },

      async cancelRun(runId) {
        const result = await scheduler.cancel(runId)
        return { ...result, runs: await store.runs.list({ limit: 50 }) }
      },

      async getSettingsView() {
        const settings = await store.settings.get()
        const token = await resolveSecret(ctx, String(settings.tokenRef ?? TOKEN_REF), secretFallback).catch(() => undefined)
        return {
          settings: { ...settings, tokenRef: String(settings.tokenRef ?? TOKEN_REF) },
          tokenSet: typeof token === 'string' && token !== '',
          poller: poller.status(),
        }
      },

      async patchSettings(partial) {
        const next = { ...(partial ?? {}) }
        for (const field of ['groups', 'projects', 'quietHours', 'excludePaths']) {
          if (next[field] !== undefined && !Array.isArray(next[field])) {
            next[field] = String(next[field])
              .split(/[\n,]/)
              .map((entry) => entry.trim())
              .filter((entry) => entry !== '')
          }
        }
        if (next.pollIntervalSec !== undefined) {
          next.pollIntervalSec = clamp(Number(next.pollIntervalSec) || 60, MIN_POLL_INTERVAL_SEC, 3600)
        }
        if (next.reviewConcurrency !== undefined) {
          next.reviewConcurrency = clamp(Number(next.reviewConcurrency) || 3, 1, 8)
        }
        if (next.allowWrites !== undefined) next.allowWrites = next.allowWrites !== false
        if (next.paused !== undefined) poller.setPaused(next.paused === true)
        const saved = await store.settings.patch(next)
        await store.audit.append({ actor: 'user', kind: 'settings', subject: 'settings', detail: { keys: Object.keys(next) } })
        return { ok: true, settings: saved, tokenSet: (await host.getSettingsView()).tokenSet }
      },

      async connect(input) {
        const baseUrl = String(input.baseUrl ?? '').trim()
        const token = String(input.token ?? '').trim()
        if (baseUrl === '') return { ok: false, code: 'validation', message: '请填写 GitLab 实例地址' }
        if (token === '') return { ok: false, code: 'validation', message: '请填写 Personal Access Token' }
        const probe = await poller.probe({ baseUrl, token })
        if (probe.ok !== true) return { ok: false, code: probe.code ?? 'probe-failed', message: probe.message ?? '连接失败' }
        await storeSecret(ctx, TOKEN_REF, token, secretFallback)
        await store.settings.patch({ gitlabBaseUrl: baseUrl, tokenRef: TOKEN_REF })
        await store.audit.append({ actor: 'user', kind: 'connect', subject: 'settings', detail: { baseUrl } })
        poller.resetBackoff()
        void poller.poll({ force: true })
        return {
          ok: true,
          connection: { configured: true, baseUrl, verified: true, user: probe.user, token: probe.token },
          settings: await store.settings.get(),
        }
      },

      async listAudit(query) {
        let subject = query.subject
        if (query.turn !== undefined && query.turn !== '') {
          const turn = await store.turns.get(String(query.turn))
          if (turn !== undefined) subject = turn.key
        }
        return store.audit.list({ subject, limit: query.limit })
      },

      async refresh(input) {
        poller.resetBackoff()
        const result = await poller.poll({ force: true, full: input?.full })
        return { ok: result.ok !== false, result, status: poller.status() }
      },

      async listViews() {
        return store.views.list()
      },

      async saveView(view) {
        const name = String(view?.name ?? '').trim()
        if (name === '') return { ok: false, code: 'validation', message: '视图名称不能为空' }
        const existing = await store.views.list()
        if (existing.length >= 15 && !existing.some((entry) => entry.id === view.id)) {
          return { ok: false, code: 'limit', message: '最多保存 15 个视图' }
        }
        const saved = {
          id: view.id ?? shortId('view', name),
          name,
          filters: view.filters ?? {},
          createdAt: view.createdAt ?? isoTimestamp(),
        }
        await store.views.put(saved)
        return { ok: true, view: saved, views: await store.views.list() }
      },

      async removeView(id) {
        await store.views.remove(String(id))
        return { ok: true, views: await store.views.list() }
      },
    }

    // ---- routes ----------------------------------------------------------
    const router = createRouter({ store, host, logger })
    const disposeRoutes = router.attach(ctx)

    // ---- optional tools --------------------------------------------------
    const disposeTools = registerTools(ctx, { store, host, logger })

    // ---- start loops -----------------------------------------------------
    const stopPoller = poller.start({ intervalSec: normalized.pollIntervalSec })
    attempt(() => scheduler.start(), logger, 'scheduler start')

    logger.info(
      `[daily-work-hub] active instance=${normalized.instance} poll=${normalized.pollIntervalSec}s backend=${store.backend} v${VERSION}`,
    )

    return async () => {
      stopPoller?.()
      attempt(() => scheduler.dispose?.(), logger, 'scheduler dispose')
      disposeTools?.()
      disposeRoutes?.()
      detailCache.clear()
      await store.close()
    }
  }, 'daily-work-hub: host runtime')
}

/**
 * Register the agent-facing tools when the host exposes a tool registry.
 * @param {any} ctx plugin context.
 * @param {{ store: any, host: any, logger: any }} deps dependencies.
 * @returns {(() => void) | undefined} disposer, if registered.
 */
function registerTools(ctx, deps) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.register !== 'function') return undefined
  const disposers = []
  try {
    disposers.push(
      tools.register({
        name: 'dailywork_list',
        description: '列出日常工作台收件箱里的工作项（GitLab 待我审 MR、指派 Issue、我提的 MR 等）。',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: '按原因过滤，如 review_requested、assigned' },
            state: { type: 'string', description: 'unread/read/snoozed/done/archived，或 active' },
            limit: { type: 'number', description: '返回条数，默认 20' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { total: { type: 'number' }, rows: { type: 'array', items: { type: 'object' } } },
            additionalProperties: true,
          },
          render: (args, value) => [
            {
              type: 'text',
              text: `共 ${String(value?.total ?? 0)} 条\n${(value?.rows ?? [])
                .map((row) => `- ${row.key} · ${row.reason} · ${row.title}`)
                .join('\n')}`,
            },
          ],
        },
        async execute(args) {
          const result = await deps.host.listItems({
            reason: args?.reason,
            state: args?.state,
            limit: clamp(Number(args?.limit) || 20, 1, 100),
            offset: 0,
          })
          return { total: result.total, rows: result.rows }
        },
      }),
    )
    disposers.push(
      tools.register({
        name: 'dailywork_action',
        description: '对一条工作项执行动作：review（AI 审查）/ summarize / draft-comment / snooze / archive / read。写操作仍需人工确认。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['review', 'summarize', 'draft-comment', 'snooze', 'archive', 'read'] },
            key: { type: 'string', description: '工作项 key' },
            preset: { type: 'string', description: 'snooze 预设：1h/4h/tomorrow' },
          },
          required: ['action', 'key'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
            additionalProperties: true,
          },
          render: (args, value) => [
            { type: 'text', text: value?.ok === true ? `${args.action} 已执行` : `失败：${value?.message ?? 'unknown'}` },
          ],
        },
        async execute(args) {
          return deps.host.runAction(String(args?.action), { key: String(args?.key ?? ''), params: { preset: args?.preset } })
        },
      }),
    )
  } catch (error) {
    deps.logger.warn(`tools registration degraded: ${normalizeError(error).message}`)
    for (const dispose of disposers) attempt(dispose, deps.logger, 'tool dispose')
    return undefined
  }
  return () => {
    for (const dispose of disposers) attempt(dispose, deps.logger, 'tool dispose')
  }
}