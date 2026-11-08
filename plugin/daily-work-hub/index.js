/**
 * daily-work-hub — Host half.
 *
 * M0 scope: prove the platform path end to end with one authenticated route.
 * Everything GitLab-specific (PR/Issue polling, review queue, AI review) is M1+.
 *
 * Registration surface note (verified against DSH 0.2.2-alpha.2):
 * - `webServer.register({ kind: 'exact', path, handler })` gets a node
 *   IncomingMessage/ServerResponse. Exact routes on the bare webServer win over
 *   the `/api` prefix fence, so this route MUST run the host's own request gate
 *   itself — dshmarket (an installed third-party bundle) does exactly this, see
 *   its `lib/index.js` / `lib/http.js` (`refuseUnadmitted`).
 * - The alternative, `connection.fetch.register(...)`, rides the shared `/api`
 *   channel and gets auth + body modes for free, but its reachability on this
 *   Desktop host is unverified. M0 takes the proven path and gates explicitly.
 */

/** Plugin name as it appears in the Loader tree. */
export const name = 'daily-work-hub'

/** Hard dependency: without a web server there is no route to register. */
export const inject = ['webServer']

/** Version reported by the ping route; keep in step with package.json. */
export const VERSION = '0.1.0'

/**
 * Build the Config schema when the host resolves schemastery.
 *
 * A workspace-linked bundle cannot `import '@deepseek-ai/schemastery'`: the
 * profile's node_modules holds only installed bundles, and `install_bundle` on a
 * local directory links the checkout rather than installing its dependencies.
 * So the schema is attached opportunistically and `normalizeConfig()` stays the
 * authority for defaults. A published bundle that declares schemastery as a
 * dependency would resolve here and produce the same two fields.
 * @param {any} z schemastery module, or undefined when unresolvable.
 * @returns {any} schema with defaults, or undefined (Loader treats it as absent).
 */
function buildConfigSchema(z) {
  if (z === undefined) return undefined
  try {
    return z.object({
      instance: z.string().default('default'),
      pollIntervalSec: z.natural().default(60),
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

/**
 * Declared fields: `instance` and `pollIntervalSec`, both with defaults.
 *
 * `undefined` on a host where schemastery is not resolvable from this file —
 * the Loader then treats the plugin as having no schema and hands `config`
 * through untouched, which is why {@link DEFAULTS} + `normalizeConfig()` own the
 * defaults. The same declaration becomes a live schema (settings form, patch
 * validation) once the package is installed in a way that installs its
 * `@deepseek-ai/schemastery` optional peer, e.g. from a packed tarball.
 */
export const Config = buildConfigSchema(schema)

/** Narrowest polling interval the poller may be configured with, in seconds. */
const MIN_POLL_INTERVAL_SEC = 15

/**
 * Declared fields and their defaults.
 *
 * These are the same two fields {@link Config} declares. Keeping them in plain
 * JS is what makes the values authoritative on a host where the schema cannot
 * resolve (see {@link Config}).
 */
export const DEFAULTS = Object.freeze({
  /** Instance selector; a GitLab instance id once M1 adds per-instance config. */
  instance: 'default',
  /** Polling interval in seconds, clamped to {@link MIN_POLL_INTERVAL_SEC}. */
  pollIntervalSec: 60,
})

/**
 * Apply defaults to whatever the Loader handed us — a patch `config`, a user
 * override, or nothing at all.
 * @param {unknown} config row config.
 * @returns {{ instance: string, pollIntervalSec: number }} normalized values.
 */
function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const instance =
    typeof raw.instance === 'string' && raw.instance.trim() !== ''
      ? raw.instance.trim()
      : DEFAULTS.instance
  const seconds = Number(raw.pollIntervalSec)
  const pollIntervalSec = Number.isFinite(seconds)
    ? Math.max(MIN_POLL_INTERVAL_SEC, Math.round(seconds))
    : DEFAULTS.pollIntervalSec
  return { instance, pollIntervalSec }
}

/**
 * Write one JSON response. `no-store` because every value here is live state.
 * @param {import('node:http').ServerResponse} response target.
 * @param {number} status HTTP status.
 * @param {unknown} payload JSON-serializable body.
 */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

/**
 * Run the host's Host/Origin + browser-login gate for one request.
 *
 * Fails closed: a host without the `connection` service, or a gate that throws,
 * refuses instead of admitting. This is the whole reason the route is safe to
 * expose on the browser origin.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {import('node:http').IncomingMessage} request incoming request.
 * @param {import('node:http').ServerResponse} response response to answer on refusal.
 * @returns {boolean} true when the request was refused and already answered.
 */
function refuseUnadmitted(ctx, request, response) {
  const connection = ctx.get('connection')
  const gate = connection?.requestRejection
  if (typeof gate !== 'function') {
    sendJson(response, 503, {
      ok: false,
      error: 'connection-unavailable',
      message: 'Host connection service is unavailable; refusing to serve plugin routes.',
    })
    return true
  }
  let status
  try {
    status = gate.call(connection, { headers: request.headers })
  } catch {
    status = 403
  }
  if (status === undefined) return false
  sendJson(response, status, {
    ok: false,
    error: status === 401 ? 'unauthenticated' : 'forbidden',
    message:
      status === 401
        ? 'DSH 登录已失效：请重新打开 dsh web 启动时打印的网址。 / DSH login required: reopen the URL dsh web printed.'
        : '请求来源不受信任，已拒绝。 / Untrusted request origin; refused.',
  })
  return true
}

/**
 * Plugin body.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {unknown} config row config (see {@link Config}).
 */
export function apply(ctx, config) {
  const { instance, pollIntervalSec } = normalizeConfig(config)
  ctx.logger?.info?.(
    `[daily-work-hub] active instance=${instance} pollIntervalSec=${pollIntervalSec} v${VERSION}`,
  )

  // The only registration in M0. `ctx.effect` owns it: plugin unload, profile
  // patch removal and HMR all release the route through this disposer.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/daily-work/ping',
        handler: (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
            response.end()
            return
          }
          if (refuseUnadmitted(ctx, request, response)) return

          const body = {
            ok: true,
            version: VERSION,
            time: new Date().toISOString(),
            instance,
            pollIntervalSec,
            method: request.method,
          }
          if (request.method === 'HEAD') {
            response.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            response.end()
            return
          }
          sendJson(response, 200, body)
        },
      }),
    'daily-work-hub: GET /api/daily-work/ping',
  )
}