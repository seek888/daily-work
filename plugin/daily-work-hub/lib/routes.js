/**
 * HTTP surface of the panel: `/api/daily-work/*` (DESIGN §3.4).
 *
 * This module is deliberately transport-thin:
 * - {@link createRouter} is pure request/response plumbing over a `host` object,
 *   so every route is unit-testable without a server.
 * - {@link attachRoutes} is the only place that touches `ctx.webServer`.
 *
 * The exact-path form bypasses the host's `/api` fence, so every request is
 * gated here by `connection.requestRejection` before anything else runs.
 * @module lib/routes
 */

import { normalizeError, redact, safeJson } from './util.js'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/api/daily-work'

/** Maximum accepted request body size. */
const MAX_BODY_BYTES = 1024 * 1024

/** Actions that change GitLab or local state and therefore require confirmation. */
export const WRITE_ACTIONS = Object.freeze([
  'publish-comment',
  'approve',
  'resolve-discussion',
  'snooze',
  'archive',
  'unarchive',
  'ignore',
  'read',
  'adopt-finding',
  'dismiss-finding',
])

/**
 * Read a Node request body as UTF-8 text.
 * @param {import('node:http').IncomingMessage} request incoming request.
 * @returns {Promise<string>} body text (empty when none).
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        request.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', (error) => reject(error))
  })
}

/**
 * Send a JSON response.
 * @param {import('node:http').ServerResponse} response target.
 * @param {number} status HTTP status.
 * @param {unknown} payload JSON body.
 * @param {Record<string, string>} [headers] extra headers.
 * @returns {void}
 */
function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  response.end(body)
}

/**
 * Parse an integer query parameter.
 * @param {unknown} value raw value.
 * @param {number} fallback default.
 * @param {{ min?: number, max?: number }} [bounds] bounds.
 * @returns {number} integer within bounds.
 */
function intParam(value, fallback, bounds = {}) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const min = bounds.min ?? 0
  const max = bounds.max ?? 10_000
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/**
 * Build a router over a host service.
 *
 * @param {object} options router options.
 * @param {any} options.store store handle (for revision/ETag).
 * @param {object} options.host host operations (implemented in index.js).
 * @param {any} [options.logger] logger.
 * @returns {{ handle: (input: { method?: string, path: string, query?: URLSearchParams | Record<string, string>, body?: any, headers?: Record<string, any> }) => Promise<{ status: number, headers: Record<string, string>, body: any }>, attach: (ctx: any) => () => void }} router.
 */
export function createRouter(options) {
  const store = options.store
  const host = options.host
  const logger = options.logger

  /**
   * Normalize a path into its route id relative to {@link ROUTE_PREFIX}.
   * @param {string} path request path or route id.
   * @returns {string} route id such as `/items`.
   */
  function routeId(path) {
    const raw = String(path ?? '')
    const withoutPrefix = raw.startsWith(ROUTE_PREFIX) ? raw.slice(ROUTE_PREFIX.length) : raw
    const clean = withoutPrefix.split('?')[0]
    return clean === '' ? '/' : clean.replace(/\/+$/, '') || '/'
  }

  /**
   * Convert a query source into a plain object.
   * @param {URLSearchParams | Record<string, string> | undefined} query query source.
   * @returns {Record<string, string>} plain query map.
   */
  function queryOf(query) {
    if (query === undefined) return {}
    if (typeof query.get === 'function') return Object.fromEntries(query.entries())
    return { ...query }
  }

  /**
   * Evaluate the write-confirmation protocol (§7).
   * @param {string} requestPath route id.
   * @param {string} action action name.
   * @param {Record<string, any>} headers request headers.
   * @returns {{ ok: boolean, code?: string, message?: string }} decision.
   */
  function checkConfirm(requestPath, action, headers) {
    if (requestPath !== '/actions' && requestPath !== '/runs') return { ok: true }
    if (!WRITE_ACTIONS.includes(action)) return { ok: true }
    const provided = String(headers['x-dw-confirm'] ?? headers['X-DW-Confirm'] ?? '')
    if (provided === '') {
      return { ok: false, code: 'confirm-required', message: '写操作需要人工确认（缺少 X-DW-Confirm）' }
    }
    if (provided !== String(store.getRevision())) {
      return { ok: false, code: 'confirm-stale', message: '确认已过期，请刷新后重试' }
    }
    return { ok: true }
  }

  /**
   * Dispatch one already-parsed request.
   * @param {{ method?: string, path: string, query?: any, body?: any, headers?: Record<string, any> }} input request.
   * @returns {Promise<{ status: number, headers: Record<string, string>, body: any }>} response.
   */
  async function handle(input) {
    const method = String(input.method ?? 'GET').toUpperCase()
    const id = routeId(input.path)
    const query = queryOf(input.query)
    const headers = input.headers ?? {}
    const body = input.body ?? {}

    try {
      if (method !== 'GET' && method !== 'POST') {
        return { status: 405, headers: { allow: 'GET, POST' }, body: { ok: false, code: 'method', message: '不支持的请求方法' } }
      }

      if (id === '/' || id === '/ping') {
        return { status: 200, headers: {}, body: { ok: true, version: host.version, time: new Date().toISOString() } }
      }

      if (id === '/state' && method === 'GET') {
        const revision = store.getRevision()
        return {
          status: 200,
          headers: { etag: `"dw-${revision}"` },
          body: { ok: true, revision, ...(await host.state()) },
        }
      }

      if (id === '/items' && method === 'GET') {
        const revision = store.getRevision()
        const etag = `"dw-items-${revision}-${JSON.stringify(query)}"`
        if (String(headers['if-none-match'] ?? '') === etag) {
          return { status: 304, headers: { etag }, body: null }
        }
        const result = await host.listItems({
          reason: query.reason,
          project: query.project,
          state: query.state,
          kind: query.kind,
          q: query.q,
          sort: query.sort,
          limit: intParam(query.limit, 100, { min: 1, max: 500 }),
          offset: intParam(query.offset, 0, { min: 0 }),
        })
        return { status: 200, headers: { etag }, body: { ok: true, revision, ...result } }
      }

      if (id === '/item' && method === 'GET') {
        const key = String(query.key ?? '')
        if (key === '') return { status: 400, headers: {}, body: { ok: false, code: 'bad-request', message: '缺少 key' } }
        const result = await host.getItem(key)
        if (result === undefined || result === null) {
          return { status: 404, headers: {}, body: { ok: false, code: 'not-found', message: '工作项不存在' } }
        }
        return { status: 200, headers: {}, body: { ok: true, ...result } }
      }

      if (id === '/actions' && method === 'POST') {
        const action = String(body.action ?? '')
        if (action === '') return { status: 400, headers: {}, body: { ok: false, code: 'bad-request', message: '缺少 action' } }
        const confirm = checkConfirm(id, action, headers)
        if (confirm.ok !== true) return { status: 409, headers: {}, body: { ok: false, ...confirm } }
        const result = await host.runAction(action, { key: body.key, params: body.params ?? {} })
        return { status: result.ok === false ? 400 : 200, headers: {}, body: result }
      }

      if (id === '/turns' && method === 'GET') {
        if (typeof query.id === 'string' && query.id !== '') {
          const turn = await host.getTurn(query.id)
          return { status: turn === undefined ? 404 : 200, headers: {}, body: { ok: turn !== undefined, turn } }
        }
        const turns = await host.listTurns({ key: query.key, limit: intParam(query.limit, 20, { min: 1, max: 100 }) })
        return { status: 200, headers: {}, body: { ok: true, turns } }
      }

      if (id === '/templates' && method === 'GET') {
        return { status: 200, headers: {}, body: { ok: true, templates: await host.listTemplates() } }
      }

      if (id === '/templates' && method === 'POST') {
        const action = String(body.action ?? 'save')
        if (action === 'preview') {
          const preview = await host.previewTemplate(body.template, body.vars ?? {})
          return { status: 200, headers: {}, body: { ok: true, preview } }
        }
        if (action === 'remove') {
          const result = await host.removeTemplate(String(body.id ?? ''))
          return { status: result.ok === false ? 400 : 200, headers: {}, body: result }
        }
        const result = await host.saveTemplate(body.template ?? {})
        return { status: result.ok === false ? 400 : 200, headers: {}, body: result }
      }

      if (id === '/jobs' && method === 'GET') {
        return { status: 200, headers: {}, body: { ok: true, jobs: await host.listJobs(), nextRuns: await host.listNextRuns() } }
      }

      if (id === '/jobs' && method === 'POST') {
        const action = String(body.action ?? 'save')
        const result =
          action === 'remove'
            ? await host.removeJob(String(body.id ?? ''))
            : action === 'toggle'
              ? await host.toggleJob(String(body.id ?? ''), body.enabled === true)
              : await host.saveJob(body.job ?? {})
        return { status: result.ok === false ? 400 : 200, headers: {}, body: result }
      }

      if (id === '/runs' && method === 'GET') {
        return {
          status: 200,
          headers: {},
          body: {
            ok: true,
            runs: await host.listRuns({
              jobId: query.jobId,
              state: query.state,
              limit: intParam(query.limit, 50, { min: 1, max: 200 }),
            }),
          },
        }
      }

      if (id === '/runs' && method === 'POST') {
        const action = String(body.action ?? 'run')
        if (action === 'cancel') {
          const result = await host.cancelRun(String(body.runId ?? ''))
          return { status: result.ok === false ? 400 : 200, headers: {}, body: result }
        }
        const result = await host.runJob(String(body.jobId ?? ''), body.params ?? {})
        return { status: result.ok === false ? 400 : 200, headers: {}, body: result }
      }

      if (id === '/run' && method === 'GET') {
        const run = await host.getRun(String(query.id ?? ''))
        return { status: run === undefined ? 404 : 200, headers: {}, body: { ok: run !== undefined, run } }
      }

      if (id === '/settings' && method === 'GET') {
        return { status: 200, headers: {}, body: { ok: true, ...(await host.getSettingsView()) } }
      }

      if (id === '/settings' && method === 'POST') {
        const result = await host.patchSettings(body.settings ?? {})
        return { status: result.ok === false ? 400 : 200, headers: {}, body: result }
      }

      if (id === '/connect' && method === 'POST') {
        const result = await host.connect({ baseUrl: body.baseUrl, token: body.token })
        return { status: result.ok === false ? 400 : 200, headers: {}, body: result }
      }

      if (id === '/audit' && method === 'GET') {
        const entries = await host.listAudit({
          subject: query.key ?? query.subject,
          turn: query.turn,
          limit: intParam(query.limit, 100, { min: 1, max: 500 }),
        })
        return { status: 200, headers: {}, body: { ok: true, entries } }
      }

      if (id === '/refresh' && method === 'POST') {
        const result = await host.refresh({ full: body.full === true })
        return { status: 200, headers: {}, body: result }
      }

      if (id === '/views' && method === 'GET') {
        return { status: 200, headers: {}, body: { ok: true, views: await host.listViews() } }
      }

      if (id === '/views' && method === 'POST') {
        const action = String(body.action ?? 'save')
        const result = action === 'remove' ? await host.removeView(String(body.id ?? '')) : await host.saveView(body.view ?? {})
        return { status: result.ok === false ? 400 : 200, headers: {}, body: result }
      }

      return { status: 404, headers: {}, body: { ok: false, code: 'not-found', message: `未知路由 ${id}` } }
    } catch (error) {
      const normalized = normalizeError(error)
      logger?.error?.(`routes: ${id} failed: ${normalized.message}`)
      return { status: 500, headers: {}, body: { ok: false, code: normalized.code, message: redact(normalized.message) } }
    }
  }

  /**
   * Register the prefix route on the host web server.
   * @param {any} ctx plugin context.
   * @returns {() => void} disposer.
   */
  function attach(ctx) {
    const server = ctx.get('webServer')
    if (server === undefined || typeof server.register !== 'function') {
      logger?.warn?.('routes: webServer unavailable; the panel will stay without data')
      return () => {}
    }

    /**
     * Node request handler.
     * @param {import('node:http').IncomingMessage} request incoming request.
     * @param {import('node:http').ServerResponse} response response.
     * @returns {Promise<void>} resolution after responding.
     */
    async function handler(request, response) {
      const connection = ctx.get('connection')
      const rejection = typeof connection?.requestRejection === 'function'
        ? connection.requestRejection({ headers: request.headers })
        : 403
      if (rejection !== undefined) {
        sendJson(response, rejection, {
          ok: false,
          code: rejection === 401 ? 'unauthenticated' : 'forbidden',
          message:
            rejection === 401
              ? 'DSH 登录已失效：请重新打开 dsh web 启动时打印的网址。'
              : '请求来源不受信任，已拒绝。',
        })
        return
      }

      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      let body = {}
      if (request.method === 'POST') {
        const text = await readBody(request).catch(() => '')
        if (text !== '') {
          const parsed = safeJson(text, undefined)
          if (parsed === undefined) {
            sendJson(response, 400, { ok: false, code: 'bad-json', message: '请求体不是合法 JSON' })
            return
          }
          body = parsed
        }
      }

      const result = await handle({
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body,
        headers: request.headers,
      })
      if (result.status === 304) {
        response.writeHead(304, { ...result.headers, 'cache-control': 'no-store' })
        response.end()
        return
      }
      sendJson(response, result.status, result.body, result.headers)
    }

    const disposePrefix = server.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
    return () => {
      disposePrefix?.()
    }
  }

  return { handle, attach, routeId }
}