/**
 * Store tests: file persistence, revisions, audit, dedupe, settings defaults.
 * @module test/store.test
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DEFAULT_SETTINGS, TOKEN_REF, createStore, resolveDataDir } from '../lib/store.js'

/**
 * Create a throwaway store in a temp directory.
 * @returns {Promise<{ store: object, dir: string, cleanup: () => Promise<void> }>} fixture.
 */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dw-store-'))
  const store = await createStore({ forceFile: true, dir })
  return {
    store,
    dir,
    cleanup: async () => {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('store: defaults and token ref', async () => {
  const { store, cleanup } = await fixture()
  try {
    const settings = await store.settings.get()
    assert.deepEqual(settings.projects, DEFAULT_SETTINGS.projects)
    assert.equal(settings.pollIntervalSec, 60)
    assert.equal(settings.allowWrites, true)
    assert.equal(TOKEN_REF, 'DAILY_WORK_GITLAB_PAT')
    assert.equal(store.backend, 'file')
    assert.equal(resolveDataDir({}).endsWith('daily-work-hub'), true)
  } finally {
    await cleanup()
  }
})

test('store: settings patch merges instead of replacing', async () => {
  const { store, cleanup } = await fixture()
  try {
    await store.settings.patch({ gitlabBaseUrl: 'https://gitlab.example.com' })
    await store.settings.patch({ pollIntervalSec: 90 })
    const settings = await store.settings.get()
    assert.equal(settings.gitlabBaseUrl, 'https://gitlab.example.com')
    assert.equal(settings.pollIntervalSec, 90)
    assert.equal(settings.includeIssues, true)
  } finally {
    await cleanup()
  }
})

test('store: item upsert merges and patch applies a transform', async () => {
  const { store, cleanup } = await fixture()
  try {
    await store.items.upsert({ key: 'gitlab:default|gp/repo#1', title: 'first', localState: 'unread', priority: 80 })
    await store.items.upsert({ key: 'gitlab:default|gp/repo#1', title: 'second', headSha: 'abc' })
    const item = await store.items.get('gitlab:default|gp/repo#1')
    assert.equal(item.title, 'second')
    assert.equal(item.headSha, 'abc')
    assert.equal(item.localState, 'unread')

    const patched = await store.items.patch('gitlab:default|gp/repo#1', (current) => ({
      localState: 'read',
      title: current.title,
    }))
    assert.equal(patched.localState, 'read')
    assert.equal(patched.priority, 80)
    assert.equal(await store.items.patch('missing', () => ({})), undefined)
  } finally {
    await cleanup()
  }
})

test('store: revisions are monotonic and change listeners fire', async () => {
  const { store, cleanup } = await fixture()
  try {
    const seen = []
    const off = store.onChange((revision) => seen.push(revision))
    const before = store.getRevision()
    await store.items.upsert({ key: 'k1', title: 'a' })
    const after = store.getRevision()
    assert.equal(after > before, true)
    assert.equal(seen.length >= 1, true)
    off()
    await store.items.upsert({ key: 'k2', title: 'b' })
    assert.equal(seen.length, 1)
  } finally {
    await cleanup()
  }
})

test('store: events dedupe by id and prune by age', async () => {
  const { store, cleanup } = await fixture()
  try {
    const event = { id: 'e1', type: 'workitem.review_requested', at: '2026-11-08T00:00:00.000Z' }
    const first = await store.events.record([event, event])
    assert.equal(first.added.length, 1)
    assert.equal(first.duplicates, 1)

    const second = await store.events.record([event])
    assert.equal(second.added.length, 0)
    assert.equal(second.duplicates, 1)

    const pruned = await store.events.pruneBefore('2026-11-09T00:00:00.000Z')
    assert.equal(pruned, 1)
    assert.equal((await store.events.list()).length, 0)
  } finally {
    await cleanup()
  }
})

test('store: audit is append-only with monotonic ids', async () => {
  const { store, cleanup } = await fixture()
  try {
    await store.audit.append({ actor: 'user', kind: 'archive', subject: 'a#1', detail: { x: 1 } })
    await store.audit.append({ actor: 'poller', kind: 'poll', subject: 'a#2' })
    const entries = await store.audit.list({})
    assert.equal(entries.length, 2)
    assert.equal(entries[0].kind, 'poll')
    const filtered = await store.audit.list({ subject: 'a#1' })
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].detail.x, 1)
  } finally {
    await cleanup()
  }
})

test('store: data survives reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dw-store-'))
  try {
    const first = await createStore({ forceFile: true, dir })
    await first.items.upsert({ key: 'k', title: 'persisted', localState: 'unread' })
    await first.settings.patch({ pollIntervalSec: 45 })
    const revision = first.getRevision()
    await first.close()

    const second = await createStore({ forceFile: true, dir })
    const item = await second.items.get('k')
    assert.equal(item.title, 'persisted')
    assert.equal((await second.settings.get()).pollIntervalSec, 45)
    assert.equal(second.getRevision() >= revision, true)
    await second.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('store: jobs, runs, turns, templates and views round-trip', async () => {
  const { store, cleanup } = await fixture()
  try {
    await store.jobs.put({ id: 'j1', name: '周报', enabled: true })
    assert.equal((await store.jobs.list())[0].name, '周报')
    assert.equal((await store.jobs.get('j1')).enabled, true)

    await store.runs.put({ id: 'r1', jobId: 'j1', state: 'running', scheduledAt: '2026-11-09T00:00:00.000Z' })
    await store.runs.put({ id: 'r2', jobId: 'j2', state: 'failed', scheduledAt: '2026-11-09T01:00:00.000Z' })
    assert.equal((await store.runs.list({ jobId: 'j1' })).length, 1)
    assert.equal((await store.runs.list({ state: 'failed' }))[0].id, 'r2')
    assert.equal((await store.runs.list({})).length, 2)

    await store.turns.put({ id: 't1', key: 'k', startedAt: '2026-11-09T00:00:00.000Z' })
    assert.equal((await store.turns.get('t1')).key, 'k')

    await store.templates.put({ id: 'tpl', name: '默认' })
    assert.equal((await store.templates.list()).length, 1)
    assert.equal(await store.templates.remove('tpl'), true)
    assert.equal(await store.templates.remove('tpl'), false)

    await store.views.put({ id: 'v1', name: '待我审' })
    assert.equal((await store.views.list()).length, 1)
  } finally {
    await cleanup()
  }
})