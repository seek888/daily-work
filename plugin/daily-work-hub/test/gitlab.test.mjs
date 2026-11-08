/**
 * GitLab adapter tests against a stub fetch (no network).
 * @module test/gitlab.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  GitlabError,
  buildQuery,
  createGitlabAdapter,
  encodeProjectId,
  normalizeBaseUrl,
  summarizePipeline,
} from '../lib/gitlab.js'

/**
 * Build a fetch stub that records calls.
 * @param {Array<{ status?: number, body?: any, headers?: Record<string, string>, text?: string }>} responses queued responses.
 * @returns {{ fetchImpl: typeof fetch, calls: any[] }} stub.
 */
function stubFetch(responses) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const spec = responses.length > 1 ? responses.shift() : responses[0]
    const status = spec?.status ?? 200
    const headers = new Map(Object.entries(spec?.headers ?? {}))
    const text = spec?.text ?? (spec?.body === undefined ? '' : JSON.stringify(spec.body))
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name) => headers.get(String(name).toLowerCase()) ?? null,
      },
      text: async () => text,
    }
  }
  return { fetchImpl, calls }
}

test('gitlab: base url normalization rejects junk', () => {
  assert.equal(normalizeBaseUrl('https://gitlab.example.com/'), 'https://gitlab.example.com')
  assert.equal(normalizeBaseUrl('https://gitlab.example.com/api/v4'), 'https://gitlab.example.com')
  assert.throws(() => normalizeBaseUrl(''), GitlabError)
  assert.throws(() => normalizeBaseUrl('ftp://x'), GitlabError)
})

test('gitlab: project ids are encoded, numeric ids pass through', () => {
  assert.equal(encodeProjectId('gp/order-service'), 'gp%2Forder-service')
  assert.equal(encodeProjectId(42), '42')
  assert.throws(() => encodeProjectId('gp/../etc'), GitlabError)
})

test('gitlab: query building skips empty values and expands arrays', () => {
  assert.equal(buildQuery({}), '')
  assert.equal(buildQuery({ a: 1, b: '', c: null }), '?a=1')
  assert.equal(buildQuery({ labels: ['x', 'y'] }), '?labels=x&labels=y')
})

test('gitlab: requests carry PRIVATE-TOKEN and never log the secret', async () => {
  const { fetchImpl, calls } = stubFetch([{ body: { id: 7, username: 'me', name: 'Me' } }])
  const adapter = createGitlabAdapter({ baseUrl: 'https://gl.example.com', token: 'glpat-SECRET-123456', fetchImpl })
  const user = await adapter.getUser()
  assert.equal(user.username, 'me')
  assert.equal(calls[0].url, 'https://gl.example.com/api/v4/user')
  assert.equal(calls[0].init.headers['PRIVATE-TOKEN'], 'glpat-SECRET-123456')
})

test('gitlab: 401 and 403 normalize into auth/forbidden', async () => {
  const unauthorized = createGitlabAdapter({
    baseUrl: 'https://gl.example.com',
    token: 't',
    fetchImpl: stubFetch([{ status: 401 }]).fetchImpl,
  })
  await assert.rejects(() => unauthorized.getUser(), (error) => error.code === 'auth')

  const forbidden = createGitlabAdapter({
    baseUrl: 'https://gl.example.com',
    token: 't',
    fetchImpl: stubFetch([{ status: 403 }]).fetchImpl,
  })
  await assert.rejects(() => forbidden.getUser(), (error) => error.code === 'forbidden')
})

test('gitlab: 429 surfaces retryAfterMs and 404 is not-found', async () => {
  const limited = createGitlabAdapter({
    baseUrl: 'https://gl.example.com',
    token: 't',
    fetchImpl: stubFetch([{ status: 429, headers: { 'retry-after': '30' } }]).fetchImpl,
  })
  await assert.rejects(
    () => limited.getUser(),
    (error) => error.code === 'rate-limit' && error.retryAfterMs === 30000,
  )

  const missing = createGitlabAdapter({
    baseUrl: 'https://gl.example.com',
    token: 't',
    fetchImpl: stubFetch([{ status: 404 }]).fetchImpl,
  })
  await assert.rejects(() => missing.getMergeRequest('gp/x', 1), (error) => error.code === 'not-found')
})

test('gitlab: pagination follows X-Next-Page and stops at the end', async () => {
  const { fetchImpl, calls } = stubFetch([
    { body: [{ iid: 1 }], headers: { 'x-next-page': '2' } },
    { body: [{ iid: 2 }], headers: { 'x-next-page': '' } },
  ])
  const adapter = createGitlabAdapter({ baseUrl: 'https://gl.example.com', token: 't', fetchImpl })
  const rows = await adapter.getDiffs('gp/x', 9)
  assert.deepEqual(rows.map((row) => row.iid), [1, 2])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url.includes('/merge_requests/9/diffs'), true)
  assert.equal(calls[0].url.includes('per_page=100'), true)
})

test('gitlab: reviews_for_me falls back to reviewer filter', async () => {
  const { fetchImpl, calls } = stubFetch([
    { status: 400, body: { message: 'unsupported scope' } },
    { body: [{ iid: 3, reviewers: [{ username: 'me' }] }] },
  ])
  const adapter = createGitlabAdapter({ baseUrl: 'https://gl.example.com', token: 't', fetchImpl })
  const rows = await adapter.listReviewRequests({ username: 'me' })
  assert.equal(rows.length, 1)
  assert.equal(adapter.capabilities.reviewsForMe, false)
  assert.equal(calls[0].url.includes('scope=reviews_for_me'), true)
  assert.equal(calls[1].url.includes('reviewer_username=me'), true)
})

test('gitlab: approvals 404 degrades to null and is cached', async () => {
  const { fetchImpl, calls } = stubFetch([{ status: 404 }])
  const adapter = createGitlabAdapter({ baseUrl: 'https://gl.example.com', token: 't', fetchImpl })
  assert.equal(await adapter.getApprovals('gp/x', 2), null)
  assert.equal(adapter.capabilities.approvals, false)
  assert.equal(await adapter.getApprovals('gp/x', 2), null)
  assert.equal(calls.length, 1)
})

test('gitlab: writes use POST and the file raw path is validated', async () => {
  const { fetchImpl, calls } = stubFetch([{ body: { id: 5 } }])
  const adapter = createGitlabAdapter({ baseUrl: 'https://gl.example.com', token: 't', fetchImpl })
  await adapter.postNote('gp/x', 3, 'hello')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(JSON.parse(calls[0].init.body).body, 'hello')

  await assert.rejects(() => adapter.getFileRaw('gp/x', '../../etc/passwd', 'main'), GitlabError)
})

test('gitlab: summarizePipeline prefers the pipeline for the current head', () => {
  const rows = [
    { id: 1, status: 'failed', sha: 'old' },
    { id: 2, status: 'success', sha: 'new' },
  ]
  const summary = summarizePipeline(rows, 'new')
  assert.equal(summary.status, 'success')
  assert.equal(summary.id, 2)
  assert.equal(summarizePipeline([], 'new'), null)
})

test('gitlab: adapter rejects construction without a token', () => {
  assert.throws(() => createGitlabAdapter({ baseUrl: 'https://gl.example.com', token: '' }), GitlabError)
})