/**
 * Router tests: every route, the confirmation protocol, ETag/304 and errors.
 * @module test/routes.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ROUTE_PREFIX, createRouter } from '../lib/routes.js'

/**
 * Build a router over a fake store and host.
 * @param {object} [overrides] host overrides.
 * @returns {{ router: object, calls: any[] }} fixture.
 */
function fixture(overrides = {}) {
  const calls = []
  const store = { getRevision: () => 7 }
  const host = {
    version: '0.1.0',
    state: async () => ({ counts: { unread: 1 }, status: { polling: false } }),
    listItems: async (query) => {
      calls.push({ op: 'listItems', query })
      return { total: 1, counts: { unread: 1 }, rows: [{ key: 'k' }] }
    },
    getItem: async (key) => (key === 'missing' ? undefined : { item: { key }, detail: {}, turn: null }),
    runAction: async (action, input) => {
      calls.push({ op: 'runAction', action, input })
      return { ok: true, data: { action } }
    },
    getTurn: async (id) => (id === 'none' ? undefined : { id }),
    listTurns: async () => [],
    listTemplates: async () => [{ id: 'tpl' }],
    saveTemplate: async (template) => (template?.name === '' ? { ok: false, code: 'validation', message: '名称为空' } : { ok: true, templates: [] }),
    removeTemplate: async () => ({ ok: true }),
    previewTemplate: async () => ({ text: 'preview', missing: [] }),
    listJobs: async () => [{ id: 'j1' }],
    listNextRuns: async () => [],
    saveJob: async () => ({ ok: true }),
    removeJob: async () => ({ ok: true }),
    toggleJob: async () => ({ ok: true }),
    listRuns: async () => [{ id: 'r1' }],
    getRun: async (id) => (id === 'none' ? undefined : { id, state: 'running' }),
    runJob: async (jobId) => ({ ok: true, run: { id: 'r2', jobId } }),
    cancelRun: async () => ({ ok: true }),
    getSettingsView: async () => ({ settings: { pollIntervalSec: 60 }, tokenSet: false }),
    patchSettings: async () => ({ ok: true, settings: {} }),
    connect: async () => ({ ok: true, connection: { verified: true } }),
    listAudit: async () => [],
    refresh: async () => ({ ok: true, status: {} }),
    listViews: async () => [],
    saveView: async () => ({ ok: true }),
    removeView: async () => ({ ok: true }),
    ...overrides,
  }
  const router = createRouter({ store, host, logger: { error: () => {}, warn: () => {} } })
  return { router, calls }
}

test('routes: prefix is not double-counted', () => {
  const { router } = fixture()
  assert.equal(router.routeId('/api/daily-work/items'), '/items')
  assert.equal(router.routeId('/items'), '/items')
  assert.equal(router.routeId('/api/daily-work/'), '/')
  assert.equal(router.routeId('/api/daily-work/items/'), '/items')
  assert.equal(ROUTE_PREFIX, '/api/daily-work')
})

test('routes: ping and state respond', async () => {
  const { router } = fixture()
  const ping = await router.handle({ path: '/api/daily-work/ping', method: 'GET' })
  assert.equal(ping.status, 200)
  assert.equal(ping.body.ok, true)

  const state = await router.handle({ path: '/api/daily-work/state', method: 'GET' })
  assert.equal(state.status, 200)
  assert.equal(state.body.revision, 7)
  assert.equal(state.headers.etag, '"dw-7"')
  assert.equal(state.body.counts.unread, 1)
})

test('routes: items pagination params are clamped and ETag matches 304', async () => {
  const { router, calls } = fixture()
  const first = await router.handle({
    path: '/api/daily-work/items',
    method: 'GET',
    query: { limit: '9999', offset: '-3', reason: 'review_requested' },
  })
  assert.equal(first.status, 200)
  assert.deepEqual(calls[0].query.reason, 'review_requested')
  assert.equal(calls[0].query.limit, 500)
  assert.equal(calls[0].query.offset, 0)

  const etag = first.headers.etag
  const second = await router.handle({
    path: '/api/daily-work/items',
    method: 'GET',
    query: { limit: '9999', offset: '-3', reason: 'review_requested' },
    headers: { 'if-none-match': etag },
  })
  assert.equal(second.status, 304)
})

test('routes: item requires a key and reports 404 honestly', async () => {
  const { router } = fixture()
  const missingKey = await router.handle({ path: '/api/daily-work/item', method: 'GET', query: {} })
  assert.equal(missingKey.status, 400)

  const notFound = await router.handle({ path: '/api/daily-work/item', method: 'GET', query: { key: 'missing' } })
  assert.equal(notFound.status, 404)

  const found = await router.handle({ path: '/api/daily-work/item', method: 'GET', query: { key: 'k' } })
  assert.equal(found.status, 200)
  assert.equal(found.body.ok, true)
})

test('routes: write actions require a fresh confirmation token', async () => {
  const { router } = fixture()
  const noHeader = await router.handle({
    path: '/api/daily-work/actions',
    method: 'POST',
    body: { action: 'archive', key: 'k' },
    headers: {},
  })
  assert.equal(noHeader.status, 409)
  assert.equal(noHeader.body.code, 'confirm-required')

  const stale = await router.handle({
    path: '/api/daily-work/actions',
    method: 'POST',
    body: { action: 'archive', key: 'k' },
    headers: { 'x-dw-confirm': '3' },
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'confirm-stale')

  const ok = await router.handle({
    path: '/api/daily-work/actions',
    method: 'POST',
    body: { action: 'archive', key: 'k' },
    headers: { 'x-dw-confirm': '7' },
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
})

test('routes: read-only actions need no confirmation', async () => {
  const { router, calls } = fixture()
  const review = await router.handle({
    path: '/api/daily-work/actions',
    method: 'POST',
    body: { action: 'review', key: 'k' },
    headers: {},
  })
  assert.equal(review.status, 200)
  assert.equal(calls.at(-1).action, 'review')
})

test('routes: a failing action body is reported as validation, not 500', async () => {
  const { router } = fixture({ runAction: async () => ({ ok: false, code: 'validation', message: '缺少 key' }) })
  const result = await router.handle({
    path: '/api/daily-work/actions',
    method: 'POST',
    body: { action: 'snooze', key: '' },
    headers: { 'x-dw-confirm': '7' },
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'validation')
})

test('routes: throwing host operations become a redacted 500', async () => {
  const { router } = fixture({
    listItems: async () => {
      const error = new Error('boom glpat-SECRETSECRET')
      throw error
    },
  })
  const result = await router.handle({ path: '/api/daily-work/items', method: 'GET' })
  assert.equal(result.status, 500)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.message.includes('SECRETSECRET'), false)
})

test('routes: templates, jobs, runs, settings and views respond', async () => {
  const { router } = fixture()
  assert.equal((await router.handle({ path: '/api/daily-work/templates', method: 'GET' })).body.templates.length, 1)

  const preview = await router.handle({
    path: '/api/daily-work/templates',
    method: 'POST',
    body: { action: 'preview', template: { id: 'x' } },
  })
  assert.equal(preview.body.preview.text, 'preview')

  assert.equal((await router.handle({ path: '/api/daily-work/jobs', method: 'GET' })).body.jobs.length, 1)
  assert.equal(
    (await router.handle({ path: '/api/daily-work/jobs', method: 'POST', body: { action: 'toggle', id: 'j1' } })).status,
    200,
  )
  assert.equal((await router.handle({ path: '/api/daily-work/runs', method: 'GET' })).body.runs.length, 1)

  const run = await router.handle({ path: '/api/daily-work/runs', method: 'POST', body: { jobId: 'j1' } })
  assert.equal(run.body.run.jobId, 'j1')

  const runMissing = await router.handle({ path: '/api/daily-work/run', method: 'GET', query: { id: 'none' } })
  assert.equal(runMissing.status, 404)

  assert.equal((await router.handle({ path: '/api/daily-work/settings', method: 'GET' })).body.tokenSet, false)
  assert.equal((await router.handle({ path: '/api/daily-work/views', method: 'GET' })).body.ok, true)
  assert.equal((await router.handle({ path: '/api/daily-work/audit', method: 'GET' })).body.ok, true)
  assert.equal((await router.handle({ path: '/api/daily-work/refresh', method: 'POST', body: {} })).body.ok, true)
})

test('routes: unknown path is 404 and unsupported method is 405', async () => {
  const { router } = fixture()
  const unknown = await router.handle({ path: '/api/daily-work/nope', method: 'GET' })
  assert.equal(unknown.status, 404)

  const method = await router.handle({ path: '/api/daily-work/state', method: 'DELETE' })
  assert.equal(method.status, 405)
  assert.equal(method.headers.allow, 'GET, POST')
})

test('routes: turn lookup distinguishes found and missing', async () => {
  const { router } = fixture()
  const found = await router.handle({ path: '/api/daily-work/turns', method: 'GET', query: { id: 't1' } })
  assert.equal(found.body.turn.id, 't1')

  const missing = await router.handle({ path: '/api/daily-work/turns', method: 'GET', query: { id: 'none' } })
  assert.equal(missing.status, 404)
})