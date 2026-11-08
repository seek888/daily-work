/**
 * End-to-end test: mount the real Host half against a fake Cordis context and a
 * fake GitLab, then drive the real HTTP routes.
 *
 * Covers: settings/connect, polling → inbox, AI review (heuristic degradation),
 * comment draft, confirmed publish, audit trail and teardown.
 * @module test/integration.test
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, VERSION } from '../index.js'
import { nextRunAt } from '../lib/cron.js'

/** One reviewable merge request fixture. */
const MR = {
  id: 101,
  iid: 1,
  project_id: 9,
  title: 'feat: 订单幂等校验',
  description: 'adds idempotency',
  state: 'opened',
  draft: false,
  sha: 'head1111',
  web_url: 'https://gitlab.example.com/gp/demo/-/merge_requests/1',
  updated_at: '2026-11-09T00:00:00.000Z',
  created_at: '2026-11-08T00:00:00.000Z',
  author: { username: 'zhang' },
  reviewers: [{ username: 'me' }],
  assignees: [],
  labels: ['backend'],
  user_notes_count: 2,
  changes_count: '2',
  detailed_merge_status: 'mergeable',
  merge_status: 'can_be_merged',
  has_conflicts: false,
  diff_refs: { base_sha: 'base0000', start_sha: 'start000', head_sha: 'head1111' },
  additions: 12,
  deletions: 3,
  source_branch: 'feat/idem',
  target_branch: 'main',
  references: { full_path: 'gp/demo' },
}

/** A diff that the heuristic reviewer can actually find something in. */
const PATCH = [
  '@@ -1,4 +1,8 @@',
  ' export function pay(order) {',
  '+  // TODO: handle retry after timeout',
  '+  console.log("debug", order)',
  '+  const qty = order.qty',
  '+  return qty * 2',
  ' }',
].join('\n')

/**
 * A fake GitLab that behaves like a CE instance (approvals 404).
 * @param {{ calls: any[] }} state request recorder.
 * @returns {typeof fetch} fetch implementation.
 */
function fakeGitlab(state) {
  return async (url, init = {}) => {
    const parsed = new URL(url)
    const path = parsed.pathname
    const method = String(init.method ?? 'GET').toUpperCase()
    state.calls.push({ path, method, search: parsed.search })

    /**
     * Build a Response-like object.
     * @param {number} status status code.
     * @param {unknown} body payload.
     * @param {Record<string, string>} [headers] extra headers.
     * @returns {object} response.
     */
    const respond = (status, body, headers = {}) => {
      const map = new Map(Object.entries(headers))
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
        text: async () => (body === undefined ? '' : JSON.stringify(body)),
      }
    }

    if (method === 'POST' && path.endsWith('/notes')) return respond(201, { id: 99, body: 'ok' })
    if (method === 'POST' && path.endsWith('/approve')) return respond(201, { approved: true })
    if (path === '/api/v4/user') return respond(200, { id: 7, username: 'me', name: 'Me' })
    if (path === '/api/v4/personal_access_tokens/self') return respond(200, { active: true, scopes: ['api'] })
    if (path === '/api/v4/merge_requests') {
      if (parsed.searchParams.get('scope') === 'reviews_for_me') return respond(200, [MR])
      return respond(200, [])
    }
    if (path === '/api/v4/todos') return respond(200, [])
    if (path === '/api/v4/issues') return respond(200, [])
    if (path === '/api/v4/projects/gp%2Fdemo/merge_requests/1' || path === '/api/v4/projects/gp%2Fdemo/merge_requests/1') {
      return respond(200, MR)
    }
    if (path.endsWith('/diffs')) return respond(200, [{ old_path: 'src/pay.js', new_path: 'src/pay.js', diff: PATCH }])
    if (path.endsWith('/discussions')) return respond(200, [])
    if (path.endsWith('/approvals')) return respond(404, { message: '404 Not Found' })
    if (path.endsWith('/pipelines')) return respond(200, [{ id: 5, status: 'success', sha: 'head1111' }])
    return respond(404, { message: 'not found' })
  }
}

/**
 * Build a fake Cordis context exposing only what this plugin uses.
 * @param {{ services?: Record<string, any> }} [options] overrides.
 * @returns {{ ctx: any, capture: { route?: any }, boot: Promise<any>, teardown: () => Promise<void> }} fixture.
 */
function fakeCtx(options = {}) {
  const capture = {}
  let bootResolve
  let bootReject
  const boot = new Promise((resolve, reject) => {
    bootResolve = resolve
    bootReject = reject
  })
  let teardown
  const services = {
    webServer: {
      register: (route) => {
        capture.route = route
        return () => {
          capture.route = undefined
        }
      },
    },
    connection: { requestRejection: () => undefined },
    timer: { interval: () => () => {} },
    ...options.services,
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    get: (name) => services[name],
    effect: (fn) => {
      const value = fn()
      if (value !== null && typeof value?.then === 'function') {
        value.then(
          (dispose) => {
            teardown = dispose
            bootResolve(undefined)
          },
          (error) => {
            bootReject(error)
          },
        )
      } else {
        teardown = value
        bootResolve(undefined)
      }
      return value
    },
    provide: () => {},
    on: () => () => {},
  }
  return {
    ctx,
    capture,
    boot,
    teardown: async () => {
      if (typeof teardown === 'function') await teardown()
    },
  }
}

/**
 * Invoke the captured HTTP route with Node-shaped request/response objects.
 * @param {any} route registered route.
 * @param {{ path: string, method?: string, headers?: Record<string, string>, body?: unknown }} input request.
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: any }>} response.
 */
function httpCall(route, input) {
  return new Promise((resolve, reject) => {
    const text = input.body === undefined ? '' : JSON.stringify(input.body)
    const listeners = new Map()
    const request = {
      method: input.method ?? 'GET',
      url: input.path,
      headers: input.headers ?? {},
      on(event, callback) {
        listeners.set(event, callback)
        return request
      },
      destroy() {},
    }
    const response = {
      status: 0,
      headers: {},
      body: undefined,
      writeHead(status, headers) {
        this.status = status
        this.headers = { ...headers }
      },
      end(payload) {
        this.body = typeof payload === 'string' && payload !== '' ? JSON.parse(payload) : undefined
        resolve({ status: this.status, headers: this.headers, body: this.body })
      },
    }
    setImmediate(() => {
      try {
        if (text !== '') listeners.get('data')?.(Buffer.from(text))
        listeners.get('end')?.()
      } catch (error) {
        reject(error)
      }
    })
    Promise.resolve(route.handler(request, response)).catch(reject)
  })
}

test('integration: mount, connect, poll, review, draft and publish', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dw-int-'))
  const gitlabState = { calls: [] }
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeGitlab(gitlabState)

  const { ctx, capture, boot, teardown } = fakeCtx()
  try {
    apply(ctx, { instance: 'default', pollIntervalSec: 15, dataDir: dir })
    await boot
    assert.ok(capture.route, 'the plugin must register its HTTP route')
    assert.equal(capture.route.path, '/api/daily-work')
    assert.equal(capture.route.kind, 'prefix')

    // The panel can read state before GitLab is configured.
    const initial = await httpCall(capture.route, { path: '/api/daily-work/state' })
    assert.equal(initial.status, 200)
    assert.equal(initial.body.ok, true)
    assert.equal(initial.body.connection.configured, false)
    assert.equal(initial.body.version, VERSION)

    // Configure + verify the connection (this is the onboarding path).
    const connect = await httpCall(capture.route, {
      path: '/api/daily-work/connect',
      method: 'POST',
      body: { baseUrl: 'https://gitlab.example.com', token: 'glpat-SECRETSECRET' },
    })
    assert.equal(connect.status, 200)
    assert.equal(connect.body.ok, true)
    assert.equal(connect.body.connection.verified, true)

    // A forced poll collects the review request.
    const refreshed = await httpCall(capture.route, { path: '/api/daily-work/refresh', method: 'POST', body: {} })
    assert.equal(refreshed.status, 200)
    assert.equal(refreshed.body.ok, true)
    assert.equal(refreshed.body.result.ok, true)

    const list = await httpCall(capture.route, { path: '/api/daily-work/items' })
    assert.equal(list.status, 200)
    assert.equal(list.body.total, 1)
    const row = list.body.rows[0]
    assert.equal(row.reason, 'review_requested')
    assert.equal(row.subject, 'gp/demo#1')
    assert.equal(row.ci.status, 'success')
    assert.equal(row.title, 'feat: 订单幂等校验')
    assert.equal(row.link.startsWith('https://'), true)

    // Detail is served from the adapter.
    const detail = await httpCall(capture.route, { path: `/api/daily-work/item?key=${encodeURIComponent(row.key)}` })
    assert.equal(detail.status, 200)
    assert.equal(detail.body.detail.diffs.length, 1)
    assert.equal(detail.body.detail.error, null)

    // Review: no agent/subagent services in this fixture, so it must degrade to
    // the heuristic path rather than fail.
    const revision = (await httpCall(capture.route, { path: '/api/daily-work/state' })).body.revision
    const review = await httpCall(capture.route, {
      path: '/api/daily-work/actions',
      method: 'POST',
      headers: { 'x-dw-confirm': String(revision) },
      body: { action: 'review', key: row.key },
    })
    assert.equal(review.status, 200, JSON.stringify(review.body))
    assert.equal(review.body.ok, true)
    assert.equal(typeof review.body.data.turnId, 'string')

    const turn = await httpCall(capture.route, {
      path: `/api/daily-work/turns?id=${encodeURIComponent(review.body.data.turnId)}`,
    })
    assert.equal(turn.status, 200)
    assert.equal(turn.body.turn.state, 'done', JSON.stringify(turn.body.turn))
    assert.equal(turn.body.turn.mode, 'heuristic')
    assert.ok(turn.body.turn.findings.length > 0, 'the heuristic review should find the TODO/console.log')
    assert.equal(turn.body.turn.computedForHead, 'head1111')

    // Drafting a comment needs no confirmation token.
    const draft = await httpCall(capture.route, {
      path: '/api/daily-work/actions',
      method: 'POST',
      body: { action: 'draft-comment', key: row.key },
    })
    assert.equal(draft.status, 200)
    assert.ok(draft.body.data.draft.body.includes('gp/demo#1'))

    // Publishing requires the confirmation header and must actually hit GitLab.
    const publishWithout = await httpCall(capture.route, {
      path: '/api/daily-work/actions',
      method: 'POST',
      body: { action: 'publish-comment', key: row.key },
    })
    assert.equal(publishWithout.status, 409)

    const revision2 = (await httpCall(capture.route, { path: '/api/daily-work/state' })).body.revision
    const publish = await httpCall(capture.route, {
      path: '/api/daily-work/actions',
      method: 'POST',
      headers: { 'x-dw-confirm': String(revision2) },
      body: { action: 'publish-comment', key: row.key, params: { body: 'LGTM with nits' } },
    })
    assert.equal(publish.status, 200, JSON.stringify(publish.body))
    assert.equal(publish.body.data.noteId, 99)
    assert.equal(gitlabState.calls.some((call) => call.method === 'POST' && call.path.endsWith('/notes')), true)

    // Audit trail contains the decisions (why/turn replay).
    const audit = await httpCall(capture.route, { path: `/api/daily-work/audit?key=${encodeURIComponent(row.key)}` })
    assert.equal(audit.status, 200)
    assert.ok(audit.body.entries.some((entry) => entry.kind === 'publish-comment'))

    // Snapshots never leak the token.
    const stateBody = JSON.stringify(await httpCall(capture.route, { path: '/api/daily-work/state' }))
    assert.equal(stateBody.includes('SECRETSECRET'), false)
  } finally {
    await teardown()
    globalThis.fetch = originalFetch
    await rm(dir, { recursive: true, force: true })
  }
})

test('cron: New York spring-forward skips the nonexistent wall time', () => {
  // 2026-03-08 02:30 local never happens; the next real 02:30 is 03-09 in EDT.
  const next = nextRunAt('30 2 * * *', 'America/New_York', Date.parse('2026-03-08T00:00:00-05:00'))
  assert.equal(new Date(next).toISOString(), '2026-03-09T06:30:00.000Z')
})