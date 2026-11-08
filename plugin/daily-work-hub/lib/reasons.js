/**
 * Reason classification, priority and lifecycle rules for work items.
 *
 * Pure functions only: no clock, no I/O, no host imports — so the rules can be
 * unit tested and reused by the poller, the routes and the client grouping.
 * @module lib/reasons
 */

import { DAY, HOUR, MINUTE } from './util.js'

/**
 * Every reason the panel knows about, in display weight order.
 * Weight drives the default `Recommended` sort (DESIGN §4.2).
 */
export const REASONS = Object.freeze({
  review_requested: { weight: 95, label: '待我审', short: '待审' },
  approval_required: { weight: 92, label: '待我批', short: '待批' },
  changes_requested: { weight: 85, label: '要我改', short: '要改' },
  conflict: { weight: 82, label: '有冲突', short: '冲突' },
  ci_failed: { weight: 78, label: 'CI 失败', short: 'CI' },
  assigned: { weight: 65, label: '指派给我', short: '指派' },
  mentioned: { weight: 60, label: '@我', short: '@我' },
  authored_feedback: { weight: 55, label: '我提的有反馈', short: '反馈' },
  authored: { weight: 40, label: '我提的', short: '我提' },
  watching: { weight: 20, label: '关注中', short: '关注' },
})

/** Reasons that belong to the review queue view. */
export const REVIEW_QUEUE_REASONS = Object.freeze(['review_requested', 'approval_required'])

/** Reasons that belong to the "my work" view. */
export const MY_WORK_REASONS = Object.freeze(['authored', 'authored_feedback', 'changes_requested'])

/** Local states in transition order, used for filters and bulk actions. */
export const LOCAL_STATES = Object.freeze(['unread', 'read', 'snoozed', 'done', 'archived'])

/** Remote states mirrored from GitLab. */
export const REMOTE_STATES = Object.freeze(['open', 'merged', 'closed'])

/**
 * Work-item key: one row per `(source, subject)` (DESIGN §5.2).
 * @param {string} source source id such as `gitlab:default`.
 * @param {string} subject sanitized subject such as `gp/order-service#482`.
 * @returns {string} stable item key.
 */
export function itemKey(source, subject) {
  return `${source}|${subject}`
}

/**
 * Weight for one reason id.
 * @param {string} reason reason id.
 * @returns {number} display weight (0 for unknown).
 */
export function reasonWeight(reason) {
  return REASONS[reason]?.weight ?? 0
}

/**
 * Chinese label for a reason.
 * @param {string} reason reason id.
 * @returns {string} label.
 */
export function reasonLabel(reason) {
  return REASONS[reason]?.label ?? reason
}

/**
 * Compute primary reason, all reasons and priority for one candidate item.
 *
 * Rules are ordered so the most actionable reason wins. All inputs are booleans
 * or enums derived from GitLab payloads; nothing here trusts free text.
 * @param {object} input signals.
 * @param {'mr'|'issue'} [input.kind] item kind.
 * @param {boolean} [input.isAuthor] I opened it.
 * @param {boolean} [input.isReviewer] I am a requested reviewer.
 * @param {boolean} [input.approvalRequired] my approval is still needed.
 * @param {boolean} [input.changesRequested] I am the author and changes were requested.
 * @param {boolean} [input.conflict] merge conflict / cannot be merged.
 * @param {string} [input.ciStatus] latest pipeline status.
 * @param {boolean} [input.assignedToMe] assigned to me.
 * @param {boolean} [input.mentionedMe] a discussion mentions me.
 * @param {boolean} [input.newComments] there are unread comments on my MR.
 * @param {boolean} [input.draft] draft MR.
 * @param {boolean} [input.watching] fallback when it is merely on the radar.
 * @returns {{ reasons: string[], primary: string, priority: number }} classification.
 */
export function computeReason(input = {}) {
  const reasons = []
  const push = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }

  if (input.isReviewer === true) push('review_requested')
  if (input.approvalRequired === true) push('approval_required')
  if (input.changesRequested === true && input.isAuthor === true) push('changes_requested')
  if (input.conflict === true) push('conflict')
  if (typeof input.ciStatus === 'string' && input.ciStatus === 'failed') push('ci_failed')
  if (input.assignedToMe === true) push('assigned')
  if (input.mentionedMe === true) push('mentioned')
  if (input.newComments === true && input.isAuthor === true) push('authored_feedback')
  if (input.isAuthor === true) push('authored')
  if (reasons.length === 0 && input.watching === true) push('watching')

  const sorted = reasons.slice().sort((a, b) => reasonWeight(b) - reasonWeight(a))
  const primary = sorted[0] ?? 'watching'

  // Priority is the primary weight, discounted for drafts and raised for
  // blocker-level signals, so the list order is stable and explainable.
  let priority = reasonWeight(primary)
  if (input.draft === true) priority -= 12
  if (input.ciStatus === 'failed') priority += 3
  if (input.conflict === true) priority += 2

  return { reasons: sorted, primary, priority: Math.max(0, Math.min(100, priority)) }
}

/**
 * Waiting-time rank used only to break ties between equal priorities.
 * @param {object} item work item with `updatedAtRemote`.
 * @param {number} [nowMs] reference time.
 * @returns {number} higher when the item has waited longer.
 */
export function waitingRank(item, nowMs = Date.now()) {
  const at = Date.parse(item?.updatedAtRemote ?? '')
  if (!Number.isFinite(at)) return 0
  const waited = Math.max(0, nowMs - at)
  return Math.min(100, Math.round(waited / HOUR))
}

/**
 * Default `Recommended` ordering: priority desc, then wait desc, then title.
 * @param {readonly object[]} items work items.
 * @param {number} [nowMs] reference time.
 * @returns {object[]} sorted copy.
 */
export function sortRecommended(items, nowMs = Date.now()) {
  return [...items].sort((a, b) => {
    const pa = Number(a.priority) || 0
    const pb = Number(b.priority) || 0
    if (pa !== pb) return pb - pa
    const wa = waitingRank(a, nowMs)
    const wb = waitingRank(b, nowMs)
    if (wa !== wb) return wb - wa
    return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh')
  })
}

/**
 * Newest-first ordering for the "Recent" sort.
 * @param {readonly object[]} items work items.
 * @returns {object[]} sorted copy.
 */
export function sortRecent(items) {
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.updatedAtRemote ?? a.lastEventAt ?? '') || 0
    const tb = Date.parse(b.updatedAtRemote ?? b.lastEventAt ?? '') || 0
    return tb - ta
  })
}

/**
 * Auto-close is the highest-trust action in the plugin, so it is allow-listed:
 * only an explicit remote transition to `merged`/`closed` may set `done`.
 * A changed `updatedAt` alone never closes anything (DESIGN §5.2).
 * @param {object | undefined} previous stored item.
 * @param {object} next candidate item.
 * @returns {{ close: boolean, reason?: string }} decision.
 */
export function shouldAutoClose(previous, next) {
  const before = previous?.remoteState
  const after = next?.remoteState
  if (after !== 'merged' && after !== 'closed') return { close: false }
  if (before === after) return { close: false }
  if (next?.localState === 'archived') return { close: true, reason: 'remote-archived' }
  return { close: true, reason: after === 'merged' ? 'merged' : 'closed' }
}

/**
 * Resolve a snooze preset to an absolute time.
 * @param {'1h'|'4h'|'tomorrow'|'next-week'|number} preset preset id or explicit ms.
 * @param {number} [nowMs] reference time.
 * @returns {string} ISO timestamp.
 */
export function snoozeUntil(preset, nowMs = Date.now()) {
  if (typeof preset === 'number' && Number.isFinite(preset)) return new Date(preset).toISOString()
  if (typeof preset === 'string' && /^\d+[mhd]$/.test(preset)) {
    const amount = Number(preset.slice(0, -1))
    const unit = preset.slice(-1)
    const scale = { m: MINUTE, h: HOUR, d: DAY }[unit]
    return new Date(nowMs + amount * scale).toISOString()
  }
  if (preset === 'tomorrow') {
    const next = new Date(nowMs + DAY)
    next.setHours(9, 0, 0, 0)
    return next.toISOString()
  }
  if (preset === 'next-week') return new Date(nowMs + 7 * DAY).toISOString()
  if (preset === '4h') return new Date(nowMs + 4 * HOUR).toISOString()
  return new Date(nowMs + HOUR).toISOString()
}

/**
 * Whether a snoozed item is due again.
 * @param {object} item work item.
 * @param {number} [nowMs] reference time.
 * @returns {boolean} true when the snooze expired.
 */
export function snoozeExpired(item, nowMs = Date.now()) {
  if (item?.localState !== 'snoozed') return false
  const at = Date.parse(item?.snoozedUntil ?? '')
  if (!Number.isFinite(at)) return true
  return at <= nowMs
}

/**
 * Group items for the list view.
 * @param {readonly object[]} items work items.
 * @param {'reason'|'project'|'priority'|'none'} [mode] grouping mode.
 * @returns {Array<{ id: string, label: string, rows: object[] }>} groups in display order.
 */
export function groupItems(items, mode = 'reason') {
  if (mode === 'none') return [{ id: 'all', label: '全部', rows: [...items] }]
  if (mode === 'project') {
    const groups = new Map()
    for (const item of items) {
      const id = String(item.project ?? 'unknown')
      if (!groups.has(id)) groups.set(id, [])
      groups.get(id).push(item)
    }
    return [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([id, rows]) => ({ id, label: id, rows }))
  }
  if (mode === 'priority') {
    const bands = [
      { id: 'p-high', label: '紧急', rows: [] },
      { id: 'p-mid', label: '重要', rows: [] },
      { id: 'p-low', label: '普通', rows: [] },
    ]
    for (const item of items) {
      const priority = Number(item.priority) || 0
      bands[priority >= 80 ? 0 : priority >= 55 ? 1 : 2].rows.push(item)
    }
    return bands.filter((band) => band.rows.length > 0)
  }
  const groups = new Map()
  for (const item of items) {
    const id = String(item.reason ?? 'watching')
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(item)
  }
  return [...groups.entries()]
    .sort((a, b) => reasonWeight(b[0]) - reasonWeight(a[0]))
    .map(([id, rows]) => ({ id, label: reasonLabel(id), rows }))
}

/**
 * Filter items by the list query parameters used by the REST contract.
 * @param {readonly object[]} items work items.
 * @param {object} query filters.
 * @returns {object[]} matching items.
 */
export function filterItems(items, query = {}) {
  const reason = typeof query.reason === 'string' && query.reason !== '' ? query.reason : undefined
  const project = typeof query.project === 'string' && query.project !== '' ? query.project : undefined
  const state = typeof query.state === 'string' && query.state !== '' ? query.state : undefined
  const kind = typeof query.kind === 'string' && query.kind !== '' ? query.kind : undefined
  const text = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''
  const reasons = Array.isArray(query.reasons) ? query.reasons : undefined

  return items.filter((item) => {
    if (reasons !== undefined && !reasons.includes(item.reason)) return false
    if (reason !== undefined && item.reason !== reason && !(item.reasons ?? []).includes(reason)) return false
    if (project !== undefined && item.project !== project) return false
    if (kind !== undefined && item.kind !== kind) return false
    if (state === 'active' && (item.localState === 'done' || item.localState === 'archived')) return false
    if (state !== undefined && state !== 'active' && item.localState !== state) return false
    if (text !== '') {
      const haystack = `${item.title ?? ''} ${item.subject ?? ''} ${item.project ?? ''} ${item.author ?? ''}`.toLowerCase()
      if (!haystack.includes(text)) return false
    }
    return true
  })
}

/**
 * Counts used by the sidebar badges and `/state`.
 * @param {readonly object[]} items work items.
 * @param {readonly object[]} runs job runs.
 * @returns {{ unread: number, review: number, snoozed: number, running: number, failed: number, total: number, done: number, archived: number }} counts.
 */
export function countItems(items, runs = []) {
  const active = items.filter((item) => item.localState !== 'done' && item.localState !== 'archived')
  return {
    unread: active.filter((item) => item.localState === 'unread').length,
    review: active.filter((item) => REVIEW_QUEUE_REASONS.includes(item.reason)).length,
    snoozed: active.filter((item) => item.localState === 'snoozed').length,
    running: runs.filter((run) => run.state === 'running' || run.state === 'queued').length,
    failed: runs.filter((run) => run.state === 'failed' || run.state === 'interrupted').length,
    total: active.length,
    done: items.filter((item) => item.localState === 'done').length,
    archived: items.filter((item) => item.localState === 'archived').length,
  }
}

/**
 * Whether a local state transition is legal.
 * @param {string} from current local state.
 * @param {string} to requested local state.
 * @returns {boolean} true when the transition is allowed.
 */
export function canTransition(from, to) {
  if (!LOCAL_STATES.includes(to)) return false
  if (from === to) return true
  if (to === 'unread') return from !== 'unread'
  if (to === 'read') return true
  if (to === 'snoozed') return from !== 'archived'
  if (to === 'done') return from !== 'archived'
  if (to === 'archived') return true
  return false
}