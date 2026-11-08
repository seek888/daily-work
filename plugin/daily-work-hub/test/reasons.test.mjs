/**
 * Domain-rule tests: reasons, priority, auto-close allow-list, snooze, grouping.
 * @module test/reasons.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MY_WORK_REASONS,
  REASONS,
  REVIEW_QUEUE_REASONS,
  canTransition,
  computeReason,
  countItems,
  filterItems,
  groupItems,
  itemKey,
  reasonLabel,
  shouldAutoClose,
  snoozeExpired,
  snoozeUntil,
  sortRecommended,
} from '../lib/reasons.js'

test('reasons: reviewer wins over every other signal', () => {
  const result = computeReason({
    isReviewer: true,
    isAuthor: true,
    assignedToMe: true,
    ciStatus: 'failed',
    conflict: true,
  })
  assert.equal(result.primary, 'review_requested')
  assert.deepEqual(result.reasons, ['review_requested', 'conflict', 'ci_failed', 'assigned', 'authored'])
  assert.equal(result.priority > 90, true)
})

test('reasons: approval beats conflict but loses to reviewer', () => {
  assert.equal(computeReason({ approvalRequired: true, conflict: true }).primary, 'approval_required')
  assert.equal(computeReason({ approvalRequired: true, isReviewer: true }).primary, 'review_requested')
})

test('reasons: author feedback needs an explicit new-comment signal', () => {
  assert.equal(computeReason({ isAuthor: true }).primary, 'authored')
  assert.equal(computeReason({ isAuthor: true, newComments: true }).primary, 'authored_feedback')
  assert.equal(computeReason({ isAuthor: true, newComments: true, changesRequested: true }).primary, 'changes_requested')
})

test('reasons: drafts are discounted and unknown items are watching', () => {
  const normal = computeReason({ isReviewer: true })
  const draft = computeReason({ isReviewer: true, draft: true })
  assert.equal(draft.priority < normal.priority, true)
  assert.equal(computeReason({}).primary, 'watching')
})

test('reasons: labels and queue sets are consistent', () => {
  assert.equal(reasonLabel('review_requested'), REASONS.review_requested.label)
  assert.equal(reasonLabel('mystery'), 'mystery')
  assert.equal(REVIEW_QUEUE_REASONS.includes('approval_required'), true)
  assert.equal(MY_WORK_REASONS.includes('authored'), true)
})

test('reasons: auto-close only fires on an explicit remote transition', () => {
  assert.deepEqual(shouldAutoClose({ remoteState: 'open' }, { remoteState: 'merged', localState: 'read' }), {
    close: true,
    reason: 'merged',
  })
  assert.deepEqual(shouldAutoClose({ remoteState: 'open' }, { remoteState: 'closed' }), {
    close: true,
    reason: 'closed',
  })
  // updatedAt changing is never a close reason
  assert.equal(shouldAutoClose({ remoteState: 'open' }, { remoteState: 'open', localState: 'unread' }).close, false)
  // already closed stays closed without a second transition
  assert.equal(shouldAutoClose({ remoteState: 'merged' }, { remoteState: 'merged' }).close, false)
  assert.equal(shouldAutoClose(undefined, { remoteState: 'closed' }).close, true)
})

test('reasons: snooze presets resolve to future instants and expire', () => {
  const now = Date.parse('2026-11-09T00:00:00.000Z')
  assert.equal(snoozeUntil('1h', now), '2026-11-09T01:00:00.000Z')
  assert.equal(snoozeUntil('4h', now), '2026-11-09T04:00:00.000Z')
  assert.equal(Date.parse(snoozeUntil('tomorrow', now)) > now, true)
  assert.equal(snoozeExpired({ localState: 'snoozed', snoozedUntil: '2026-11-08T00:00:00.000Z' }, now), true)
  assert.equal(snoozeExpired({ localState: 'snoozed', snoozedUntil: '2026-11-10T00:00:00.000Z' }, now), false)
  assert.equal(snoozeExpired({ localState: 'snoozed' }, now), true)
  assert.equal(snoozeExpired({ localState: 'read' }, now), false)
})

test('reasons: recommended sorting is priority then wait then title', () => {
  const items = [
    { title: 'b', priority: 50, updatedAtRemote: '2026-11-08T00:00:00.000Z' },
    { title: 'a', priority: 90, updatedAtRemote: '2026-11-08T23:00:00.000Z' },
    { title: 'c', priority: 50, updatedAtRemote: '2026-11-01T00:00:00.000Z' },
  ]
  assert.deepEqual(sortRecommended(items, Date.parse('2026-11-09T00:00:00.000Z')).map((item) => item.title), ['a', 'c', 'b'])
})

test('reasons: filtering honours reason, project, state and text', () => {
  const items = [
    { title: 'feat: 订单', project: 'gp/order', reason: 'review_requested', reasons: ['review_requested'], localState: 'unread', kind: 'mr', subject: 'gp/order#1' },
    { title: 'fix: 库存', project: 'gp/stock', reason: 'authored', reasons: ['authored'], localState: 'done', kind: 'mr', subject: 'gp/stock#2' },
  ]
  assert.equal(filterItems(items, { reason: 'review_requested' }).length, 1)
  assert.equal(filterItems(items, { project: 'gp/stock' }).length, 1)
  assert.equal(filterItems(items, { state: 'active' }).length, 1)
  assert.equal(filterItems(items, { q: '库存' }).length, 1)
  assert.equal(filterItems(items, { kind: 'issue' }).length, 0)
})

test('reasons: grouping by reason, project and priority', () => {
  const items = [
    { title: 'a', project: 'p1', reason: 'review_requested', priority: 95 },
    { title: 'b', project: 'p1', reason: 'authored', priority: 40 },
    { title: 'c', project: 'p2', reason: 'review_requested', priority: 60 },
  ]
  const byReason = groupItems(items, 'reason')
  assert.deepEqual(byReason.map((group) => group.id), ['review_requested', 'authored'])
  assert.equal(byReason[0].rows.length, 2)

  const byProject = groupItems(items, 'project')
  assert.equal(byProject[0].id, 'p1')

  const byPriority = groupItems(items, 'priority')
  assert.deepEqual(byPriority.map((group) => group.id), ['p-high', 'p-mid', 'p-low'])
  assert.equal(groupItems(items, 'none')[0].rows.length, 3)
})

test('reasons: counts separate active work from history', () => {
  const items = [
    { localState: 'unread', reason: 'review_requested' },
    { localState: 'snoozed', reason: 'assigned' },
    { localState: 'done', reason: 'authored' },
    { localState: 'archived', reason: 'authored' },
  ]
  const counts = countItems(items, [{ state: 'running' }, { state: 'failed' }])
  assert.equal(counts.unread, 1)
  assert.equal(counts.review, 1)
  assert.equal(counts.snoozed, 1)
  assert.equal(counts.running, 1)
  assert.equal(counts.failed, 1)
  assert.equal(counts.total, 2)
  assert.equal(counts.done, 1)
  assert.equal(counts.archived, 1)
})

test('reasons: local state transitions are bounded', () => {
  assert.equal(canTransition('unread', 'read'), true)
  assert.equal(canTransition('read', 'archived'), true)
  assert.equal(canTransition('archived', 'done'), false)
  assert.equal(canTransition('done', 'snoozed'), true)
  assert.equal(canTransition('read', 'nonsense'), false)
})

test('reasons: item keys are stable and namespaced', () => {
  assert.equal(itemKey('gitlab:default', 'gp/order#1'), 'gitlab:default|gp/order#1')
})