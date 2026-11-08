/**
 * GitLab poller (DESIGN §3.2, §5.1, §5.2, §5.5).
 *
 * Only "when to ask": polling cadence, increments, backoff and cursors. What to
 * ask lives in `lib/gitlab.js`; what an event means lives in `lib/reasons.js`.
 *
 * Cursors advance only after a successful upload, so a network failure can never
 * silently skip items.
 * @module lib/poller
 */

import { computeReason, itemKey, shouldAutoClose } from './reasons.js'
import { EVENT_RETENTION_MS, TOKEN_REF } from './store.js'
import {
  HOUR,
  MINUTE,
  createLogger,
  isoTimestamp,
  normalizeError,
  redact,
  sanitizeSubject,
  sanitizeUrl,
  truncate,
} from './util.js'
import { summarizePipeline } from './gitlab.js'

/** Backoff after consecutive failures: 5 minutes, doubling to one hour. */
const BACKOFF_BASE_MS = 5 * MINUTE
const BACKOFF_MAX_MS = HOUR
/** After this many consecutive failures the poller stops asking and asks a human. */
const FAILURE_LIMIT = 10
/** Maximum items enriched per cycle, to keep one poll bounded. */
const MAX_ENRICH_PER_CYCLE = 60
/** Poll interval floor. */
const MIN_POLL_INTERVAL_SEC = 15

/**
 * Normalize a merge-request payload into the fields the item model needs.
 * @param {any} row GitLab merge request.
 * @param {string} source source id.
 * @returns {object | null} candidate item, or null when essential fields are missing.
 */
export function normalizeMergeRequestRow(row, source) {
  const project = row?.references?.full_path ?? row?.project_id
  const subject = sanitizeSubject(`${typeof project === 'string' ? project : String(project)}#${row?.iid}`)
  if (subject === undefined) return null
  const link = sanitizeUrl(row?.web_url)
  const author = typeof row?.author?.username === 'string' ? row.author.username : ''
  return {
    key: itemKey(source, subject),
    source,
    kind: 'mr',
    subject,
    project: typeof project === 'string' ? project : String(project ?? ''),
    iid: Number(row?.iid) || 0,
    title: truncate(row?.title ?? '', 300),
    author,
    link,
    headSha: typeof row?.sha === 'string' ? row.sha : '',
    baseSha: typeof row?.diff_refs?.base_sha === 'string' ? row.diff_refs.base_sha : '',
    startSha: typeof row?.diff_refs?.start_sha === 'string' ? row.diff_refs.start_sha : '',
    draft: row?.draft === true || row?.work_in_progress === true,
    mergeStatus: String(row?.detailed_merge_status ?? row?.merge_status ?? 'unknown'),
    hasConflicts: row?.has_conflicts === true ||
      ['conflict', 'cannot_be_merged'].includes(String(row?.detailed_merge_status ?? '')),
    mergeState: String(row?.state ?? 'opened'),
    updatedAtRemote: typeof row?.updated_at === 'string' ? row.updated_at : isoTimestamp(),
    reviewers: Array.isArray(row?.reviewers) ? row.reviewers.map((r) => r?.username).filter(Boolean) : [],
    assignees: Array.isArray(row?.assignees) ? row.assignees.map((a) => a?.username).filter(Boolean) : [],
    labels: Array.isArray(row?.labels) ? row.labels.slice(0, 20) : [],
    userNotesCount: Number(row?.user_notes_count) || 0,
    changesCount: Number(String(row?.changes_count ?? '').replace(/\D/g, '')) || 0,
    sourceBranch: typeof row?.source_branch === 'string' ? row.source_branch : '',
    targetBranch: typeof row?.target_branch === 'string' ? row.target_branch : '',
  }
}

/**
 * Normalize an issue payload.
 * @param {any} row GitLab issue.
 * @param {string} source source id.
 * @returns {object | null} candidate item, or null.
 */
export function normalizeIssueRow(row, source) {
  const project = row?.references?.full_path ?? row?.project_id
  const subject = sanitizeSubject(`${typeof project === 'string' ? project : String(project)}#${row?.iid}`)
  if (subject === undefined) return null
  return {
    key: itemKey(source, subject),
    source,
    kind: 'issue',
    subject,
    project: typeof project === 'string' ? project : String(project ?? ''),
    iid: Number(row?.iid) || 0,
    title: truncate(row?.title ?? '', 300),
    author: typeof row?.author?.username === 'string' ? row.author.username : '',
    link: sanitizeUrl(row?.web_url),
    headSha: '',
    baseSha: '',
    startSha: '',
    draft: false,
    mergeStatus: 'n/a',
    hasConflicts: false,
    mergeState: String(row?.state ?? 'opened'),
    updatedAtRemote: typeof row?.updated_at === 'string' ? row.updated_at : isoTimestamp(),
    reviewers: [],
    assignees: Array.isArray(row?.assignees) ? row.assignees.map((a) => a?.username).filter(Boolean) : [],
    labels: Array.isArray(row?.labels) ? row.labels.slice(0, 20) : [],
    userNotesCount: Number(row?.user_notes_count) || 0,
    changesCount: 0,
    sourceBranch: '',
    targetBranch: '',
  }
}

/**
 * Compute the polling backoff for a failure count.
 * @param {number} failures consecutive failures.
 * @returns {number} delay in milliseconds (0 before the first failure).
 */
export function backoffFor(failures) {
  if (failures <= 0) return 0
  const delay = BACKOFF_BASE_MS * 2 ** (failures - 1)
  return Math.min(BACKOFF_MAX_MS, delay)
}

/**
 * Create the poller.
 *
 * @param {object} options poller options.
 * @param {any} options.store store handle (docs/CONTRACTS.md §3).
 * @param {() => Promise<any>} options.adapterFactory resolves a GitLab adapter or throws.
 * @param {() => Promise<object>} [options.settingsProvider] reads current settings.
 * @param {any} [options.ctx] plugin context (timer lives here).
 * @param {any} [options.logger] logger.
 * @param {() => number} [options.now] clock injection.
 * @param {() => void} [options.onChange] called after a cycle changed state.
 * @returns {object} poller handle.
 */
export function createPoller(options = {}) {
  const store = options.store
  const adapterFactory = options.adapterFactory
  const settingsProvider = options.settingsProvider ?? (async () => store.settings.get())
  const ctx = options.ctx
  const logger = options.logger ?? createLogger(ctx)
  const now = options.now ?? Date.now
  const onChange = options.onChange ?? (() => {})
  const serviceName = String(options.source ?? 'gitlab:default')

  /** @type {{ polling: boolean, paused: boolean, stopped: boolean, lastSuccessAt: string | null, lastError: string | null, consecutiveFailures: number, backoffUntil: number, nextPollAt: number, lastCycleItems: number }} */
  const state = {
    polling: false,
    paused: false,
    stopped: false,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    backoffUntil: 0,
    nextPollAt: 0,
    lastCycleItems: 0,
  }

  let disposer
  let cyclePromise = null

  /**
   * Read persisted poller meta (cursors, identity).
   * @returns {Promise<object>} meta record.
   */
  async function readMeta() {
    const meta = await store.meta.get()
    return meta?.poller ?? {}
  }

  /**
   * Persist poller meta without clobbering other meta keys.
   * @param {object} patch partial poller meta.
   * @returns {Promise<void>} resolution after write.
   */
  async function writeMeta(patch) {
    const current = await readMeta()
    await store.meta.patch({ poller: { ...current, ...patch } })
  }

  /**
   * Public status snapshot for `/state`.
   * @returns {object} status fields.
   */
  function status() {
    return {
      polling: state.polling,
      paused: state.paused,
      stopped: state.stopped,
      lastSuccessAt: state.lastSuccessAt,
      nextPollAt: state.nextPollAt === 0 ? null : isoTimestamp(state.nextPollAt),
      backoffMs: Math.max(0, state.backoffUntil - now()),
      lastError: state.lastError,
      consecutiveFailures: state.consecutiveFailures,
      lastCycleItems: state.lastCycleItems,
    }
  }

  /**
   * Whether a cycle may run right now.
   * @param {{ force?: boolean }} [input] options.
   * @returns {{ allowed: boolean, reason?: string }} gate decision.
   */
  function gate(input = {}) {
    if (state.polling) return { allowed: false, reason: 'busy' }
    if (input.force === true) return { allowed: true }
    if (state.paused) return { allowed: false, reason: 'paused' }
    if (state.stopped) return { allowed: false, reason: 'stopped' }
    if (state.backoffUntil > now()) return { allowed: false, reason: 'backoff' }
    return { allowed: true }
  }

  /**
   * Run one collection cycle.
   *
   * @param {{ force?: boolean, signal?: AbortSignal }} [input] cycle options.
   * @returns {Promise<{ ok: boolean, code?: string, message?: string, items?: number, added?: number, closed?: number }>} cycle result.
   */
  async function poll(input = {}) {
    if (cyclePromise !== null) {
      // A forced refresh joins the in-flight cycle instead of reporting "busy":
      // the caller asked for fresh data, and that cycle is already producing it.
      if (input.force === true) return cyclePromise
      return { ok: false, code: 'busy', message: '上一轮仍在进行' }
    }
    const permission = gate(input)
    if (!permission.allowed) return { ok: false, code: permission.reason, message: '本轮跳过' }

    state.polling = true
    cyclePromise = (async () => {
      try {
        const settings = await settingsProvider()
        if (settings?.gitlabBaseUrl === undefined || settings.gitlabBaseUrl === '') {
          state.lastError = 'GitLab 未配置：请在设置页填写实例地址与 Token'
          return { ok: false, code: 'not-configured', message: state.lastError }
        }
        const adapter = await adapterFactory()
        const identity = await resolveIdentity(adapter)
        const collected = await collect(adapter, identity, settings, input.signal)
        const applied = await apply(collected, identity, settings)

        state.consecutiveFailures = 0
        state.stopped = false
        state.backoffUntil = 0
        state.lastError = null
        state.lastSuccessAt = isoTimestamp()
        state.lastCycleItems = applied.items
        await writeMeta({
          cursors: collected.cursors,
          identity,
          lastSuccessAt: state.lastSuccessAt,
        })
        await store.events.pruneBefore(isoTimestamp(now() - EVENT_RETENTION_MS))
        if (applied.items > 0 || applied.closed > 0) onChange()
        return { ok: true, items: applied.items, added: applied.added, closed: applied.closed }
      } catch (error) {
        const normalized = normalizeError(error)
        state.consecutiveFailures += 1
        state.lastError = `${normalized.code}: ${normalized.message}`
        state.backoffUntil = now() + backoffFor(state.consecutiveFailures)
        if (state.consecutiveFailures >= FAILURE_LIMIT) {
          state.stopped = true
          state.lastError += `（连续失败 ${state.consecutiveFailures} 次，已暂停自动轮询，请手动刷新或检查设置）`
          logger.error(`poller: ${state.lastError}`)
          await store.audit.append({
            actor: 'poller',
            kind: 'poller-stopped',
            subject: serviceName,
            detail: { failures: state.consecutiveFailures, error: state.lastError },
          })
        } else {
          logger.warn(`poller: cycle failed (${state.lastError}); backoff ${state.backoffUntil - now()}ms`)
        }
        return { ok: false, code: normalized.code, message: normalized.message }
      } finally {
        state.polling = false
        cyclePromise = null
        state.nextPollAt = now() + Math.max(MIN_POLL_INTERVAL_SEC * 1000, backoffFor(state.consecutiveFailures))
        onChange()
      }
    })()

    return cyclePromise
  }

  /**
   * Resolve (and cache) the token owner identity.
   * @param {any} adapter GitLab adapter.
   * @returns {Promise<{ id: number, username: string, name: string }>} identity.
   */
  async function resolveIdentity(adapter) {
    const meta = await readMeta()
    const cached = meta.identity
    if (cached !== undefined && typeof cached.username === 'string' && cached.username !== '') return cached
    const user = await adapter.getUser()
    await writeMeta({ identity: user })
    return user
  }

  /**
   * Collect candidates from every scope, enriching changed ones.
   * @param {any} adapter GitLab adapter.
   * @param {{ username: string }} identity token owner.
   * @param {object} settings plugin settings.
   * @param {AbortSignal} [signal] cancellation.
   * @returns {Promise<{ candidates: object[], cursors: object, seenKeys: Set<string> }>} collection result.
   */
  async function collect(adapter, identity, settings, signal) {
    const meta = await readMeta()
    const cursors = meta.cursors ?? {}
    const seenKeys = new Set()
    const candidates = []

    /** @type {Record<string, { isReviewer?: boolean, todoAction?: string, isAuthor?: boolean, assignedToMe?: boolean }>} */
    const signals = {}

    const reviewRequests = await adapter.listReviewRequests({ username: identity.username, signal })
    const authoredMrs = await adapter.listAuthoredMergeRequests({ signal })
    const todos = await adapter.listTodos({ signal }).catch((error) => {
      logger.warn(`poller: /todos unavailable (${normalizeError(error).message})`)
      return []
    })
    const assignedIssues = settings.includeIssues === true
      ? await adapter.listAssignedIssues({ signal }).catch(() => [])
      : []
    const authoredIssues = settings.includeIssues === true
      ? await adapter.listAuthoredIssues({ signal }).catch(() => [])
      : []

    for (const row of reviewRequests) {
      const candidate = normalizeMergeRequestRow(row, serviceName)
      if (candidate === null) continue
      signals[candidate.key] = { ...(signals[candidate.key] ?? {}), isReviewer: true }
      candidates.push(candidate)
      seenKeys.add(candidate.key)
    }
    for (const row of authoredMrs) {
      const candidate = normalizeMergeRequestRow(row, serviceName)
      if (candidate === null) continue
      signals[candidate.key] = { ...(signals[candidate.key] ?? {}), isAuthor: true }
      if (!seenKeys.has(candidate.key)) candidates.push(candidate)
      seenKeys.add(candidate.key)
    }
    for (const row of [...assignedIssues, ...authoredIssues]) {
      const candidate = normalizeIssueRow(row, serviceName)
      if (candidate === null) continue
      const isAuthor = String(row?.author?.username ?? '') === identity.username
      signals[candidate.key] = { ...(signals[candidate.key] ?? {}), assignedToMe: true, isAuthor }
      if (!seenKeys.has(candidate.key)) candidates.push(candidate)
      seenKeys.add(candidate.key)
    }
    for (const todo of todos) {
      const target = todo?.target
      const project = target?.references?.full_path ?? target?.project_id
      const subject = sanitizeSubject(`${typeof project === 'string' ? project : String(project)}#${target?.iid}`)
      if (subject === undefined) continue
      const key = itemKey(serviceName, subject)
      const kind = todo?.target_type === 'Issue' ? 'issue' : 'mr'
      signals[key] = { ...(signals[key] ?? {}), todoAction: String(todo?.action_name ?? '') }
      if (!seenKeys.has(key)) {
        const candidate = kind === 'issue' ? normalizeIssueRow(target, serviceName) : normalizeMergeRequestRow(target, serviceName)
        if (candidate !== null) candidates.push(candidate)
      }
      seenKeys.add(key)
    }

    const existing = new Map((await store.items.all()).map((item) => [item.key, item]))
    const limited = candidates
      .sort((a, b) => Number(signals[b.key]?.isReviewer === true) - Number(signals[a.key]?.isReviewer === true))
      .slice(0, MAX_ENRICH_PER_CYCLE)

    const enriched = []
    for (const candidate of limited) {
      const previous = existing.get(candidate.key)
      const marker = `${candidate.updatedAtRemote}|${candidate.headSha}|${candidate.mergeState}`
      if (previous !== undefined && previous.fingerprint === marker) {
        enriched.push({ candidate: { ...candidate, ...pickStable(previous) }, previous, changed: false })
        continue
      }
      const detail = await enrich(adapter, candidate, previous, identity, signal)
      enriched.push({ candidate: detail, previous, changed: true })
    }

    // Items we own that disappeared from every open scope: confirm their remote
    // state explicitly before closing anything (absence is not evidence).
    for (const previous of existing.values()) {
      if (seenKeys.has(previous.key)) continue
      if (previous.localState === 'done' || previous.localState === 'archived') continue
      if (previous.kind !== 'mr') continue
      const confirmed = await confirmRemoteState(adapter, previous, signal)
      if (confirmed !== undefined) enriched.push({ candidate: confirmed, previous, changed: true, confirmOnly: true })
    }

    const nextCursors = { ...cursors }
    for (const entry of enriched) {
      if (entry.candidate?.updatedAtRemote !== undefined) {
        const key = `${entry.candidate.project}:${entry.candidate.kind}`
        const value = String(entry.candidate.updatedAtRemote)
        if (nextCursors[key] === undefined || value > nextCursors[key]) nextCursors[key] = value
      }
    }
    return { candidates: enriched, cursors: nextCursors, seenKeys, signals }
  }

  /** Preserve locally-owned fields when the remote fingerprint did not change. */
  function pickStable(previous) {
    return {
      localState: previous.localState,
      snoozedUntil: previous.snoozedUntil,
      seenAt: previous.seenAt,
      lastTurn: previous.lastTurn,
      findings: previous.findings,
      commentDraft: previous.commentDraft,
      closedReason: previous.closedReason,
      createdAt: previous.createdAt,
    }
  }

  /**
   * Enrich one candidate with detail, approvals, pipelines and discussions.
   * @param {any} adapter GitLab adapter.
   * @param {object} candidate normalized row.
   * @param {object | undefined} previous stored item.
   * @param {AbortSignal} [signal] cancellation.
   * @returns {Promise<object>} enriched candidate.
   */
  async function enrich(adapter, candidate, previous, identity, signal) {
    if (candidate.kind !== 'mr') {
      return {
        ...candidate,
        fingerprint: `${candidate.updatedAtRemote}|${candidate.headSha}|${candidate.mergeState}`,
      }
    }
    let detail = null
    try {
      detail = await adapter.getMergeRequest(candidate.project, candidate.iid, { signal })
    } catch (error) {
      if (error?.code === 'not-found') return candidate
      throw error
    }
    const headSha = typeof detail?.sha === 'string' ? detail.sha : candidate.headSha
    const [approvals, pipelines, discussions] = await Promise.all([
      adapter.getApprovals(candidate.project, candidate.iid, { signal }).catch(() => null),
      adapter.getPipelines(candidate.project, candidate.iid, { signal }).catch(() => []),
      adapter.getDiscussions(candidate.project, candidate.iid, { signal }).catch(() => []),
    ])

    const pipeline = summarizePipeline(pipelines, headSha)
    const username = typeof identity?.username === 'string' ? identity.username : ''
    const approvalSummary = approvals === null || approvals === undefined
      ? null
      : {
          approved: approvals.approved === true,
          left: Number(approvals.approvals_left ?? 0) || 0,
          of: Number(approvals.approvals_required ?? 0) || 0,
          approvedByMe: (approvals.approved_by ?? []).some((entry) => entry?.user?.username === username),
        }

    const discussionsList = Array.isArray(discussions) ? discussions : []
    const unresolved = discussionsList.filter(
      (thread) => thread?.resolvable === true && thread?.notes?.some((note) => note?.resolvable === true && note?.resolved === false),
    ).length
    const mentionPattern = username === '' ? undefined : new RegExp(`(^|\\s)@${username.replace(/[^A-Za-z0-9_-]/g, '')}(?![A-Za-z0-9_-])`)
    const mentioned = mentionPattern === undefined
      ? false
      : discussionsList.some((thread) =>
          (Array.isArray(thread?.notes) ? thread.notes : []).some((note) => mentionPattern.test(String(note?.body ?? ''))),
        )

    const mergeState = String(detail?.state ?? candidate.mergeState ?? 'opened')
    const changesRequested = (detail?.reviewers ?? []).length > 0 &&
      ['requested_changes', 'rejected'].includes(String(detail?.detailed_merge_status ?? ''))

    return {
      ...candidate,
      title: truncate(detail?.title ?? candidate.title, 300),
      headSha,
      baseSha: typeof detail?.diff_refs?.base_sha === 'string' ? detail.diff_refs.base_sha : candidate.baseSha,
      startSha: typeof detail?.diff_refs?.start_sha === 'string' ? detail.diff_refs.start_sha : candidate.startSha,
      draft: detail?.draft === true || detail?.work_in_progress === true || candidate.draft,
      mergeStatus: String(detail?.detailed_merge_status ?? detail?.merge_status ?? candidate.mergeStatus),
      hasConflicts: detail?.has_conflicts === true ||
        ['conflict', 'cannot_be_merged'].includes(String(detail?.detailed_merge_status ?? '')),
      mergeState,
      updatedAtRemote: typeof detail?.updated_at === 'string' ? detail.updated_at : candidate.updatedAtRemote,
      additions: Number(detail?.additions) || 0,
      deletions: Number(detail?.deletions) || 0,
      changedFiles: Number(detail?.changes_count ?? candidate.changesCount) || 0,
      reviewers: Array.isArray(detail?.reviewers) ? detail.reviewers.map((r) => r?.username).filter(Boolean) : candidate.reviewers,
      assignees: Array.isArray(detail?.assignees) ? detail.assignees.map((a) => a?.username).filter(Boolean) : candidate.assignees,
      labels: Array.isArray(detail?.labels) ? detail.labels.slice(0, 20) : candidate.labels,
      ci: pipeline,
      approvals: approvalSummary,
      unresolvedDiscussions: unresolved,
      unreadComments: Number(detail?.user_notes_count ?? candidate.userNotesCount) || 0,
      mentionedMe: mentioned,
      changesRequested,
      fingerprint: `${typeof detail?.updated_at === 'string' ? detail.updated_at : candidate.updatedAtRemote}|${headSha}|${mergeState}`,
    }
  }

  /**
   * Confirm the remote state of a previously stored MR that no longer appears in
   * any open scope.
   * @param {any} adapter GitLab adapter.
   * @param {object} previous stored item.
   * @param {AbortSignal} [signal] cancellation.
   * @returns {Promise<object | undefined>} updated candidate, or undefined.
   */
  async function confirmRemoteState(adapter, previous, signal) {
    try {
      const detail = await adapter.getMergeRequest(previous.project, previous.iid, { signal })
      const current = String(detail?.state ?? 'opened')
      if (current === 'opened') return undefined
      return {
        ...previous,
        mergeState: current,
        remoteState: current === 'merged' ? 'merged' : 'closed',
        updatedAtRemote: typeof detail?.updated_at === 'string' ? detail.updated_at : previous.updatedAtRemote,
        fingerprint: `${detail?.updated_at ?? previous.updatedAtRemote}|${detail?.sha ?? previous.headSha}|${current}`,
      }
    } catch (error) {
      if (error?.code === 'not-found' || error?.code === 'forbidden') return undefined
      logger.warn(`poller: could not confirm ${previous.subject} (${normalizeError(error).message})`)
      return undefined
    }
  }

  /**
   * Merge candidates into the store: reasons, state machine, events, audit.
   * @param {{ candidates: object[], signals: object }} collected collection result.
   * @param {{ username: string }} identity token owner.
   * @param {object} settings plugin settings.
   * @returns {Promise<{ items: number, added: number, closed: number }>} applied counts.
   */
  async function apply(collected, identity, settings) {
    const events = []
    let added = 0
    let closed = 0
    let items = 0

    for (const entry of collected.candidates ?? []) {
      const candidate = entry.candidate
      if (candidate === undefined) continue
      const previous = entry.previous
      const signals = collected.signals?.[candidate.key] ?? {}
      const isAuthor = signals.isAuthor === true ||
        (typeof identity?.username === 'string' && candidate.author === identity.username)
      const isReviewer = signals.isReviewer === true ||
        (Array.isArray(candidate.reviewers) && candidate.reviewers.includes(identity?.username))
      const approvalRequired = candidate.approvals !== null &&
        candidate.approvals !== undefined &&
        candidate.approvals.approved !== true &&
        candidate.approvals.left > 0 &&
        isReviewer
      const todoApproval = signals.todoAction === 'approval_required'

      const classification = computeReason({
        kind: candidate.kind,
        isAuthor,
        isReviewer: isReviewer || todoApproval,
        approvalRequired: approvalRequired || todoApproval,
        changesRequested: candidate.changesRequested === true,
        conflict: candidate.hasConflicts === true || candidate.mergeStatus === 'conflict',
        ciStatus: candidate.ci?.status,
        assignedToMe: signals.assignedToMe === true || candidate.assignees?.includes?.(identity?.username),
        mentionedMe: candidate.mentionedMe === true,
        newComments: previous !== undefined && Number(candidate.userNotesCount) > Number(previous.unreadComments ?? -1),
        draft: candidate.draft === true,
        watching: true,
      })

      const remoteState = candidate.kind === 'issue'
        ? (String(candidate.mergeState) === 'opened' ? 'open' : 'closed')
        : (candidate.mergeState === 'merged' ? 'merged' : candidate.mergeState === 'closed' ? 'closed' : 'open')

      const next = {
        ...pickStable(previous ?? {}),
        key: candidate.key,
        source: candidate.source,
        kind: candidate.kind,
        subject: candidate.subject,
        project: candidate.project,
        iid: candidate.iid,
        title: candidate.title,
        author: candidate.author,
        link: candidate.link,
        reason: classification.primary,
        reasons: classification.reasons,
        priority: classification.priority,
        remoteState,
        headSha: candidate.headSha,
        baseSha: candidate.baseSha,
        startSha: candidate.startSha,
        ci: candidate.ci ?? null,
        approvals: candidate.approvals ?? null,
        additions: Number(candidate.additions) || 0,
        deletions: Number(candidate.deletions) || 0,
        changedFiles: Number(candidate.changedFiles) || 0,
        unreadComments: Number(candidate.unreadComments ?? candidate.userNotesCount) || 0,
        unresolvedDiscussions: Number(candidate.unresolvedDiscussions) || 0,
        labels: candidate.labels ?? [],
        draft: candidate.draft === true,
        mergeStatus: candidate.mergeStatus,
        updatedAtRemote: candidate.updatedAtRemote,
        lastEventAt: isoTimestamp(),
        localState: previous?.localState ?? 'unread',
        snoozedUntil: previous?.snoozedUntil ?? null,
        seenAt: previous?.seenAt ?? null,
        createdAt: previous?.createdAt ?? isoTimestamp(),
        lastTurn: previous?.lastTurn ?? null,
        findings: previous?.findings ?? [],
        commentDraft: previous?.commentDraft ?? null,
        closedReason: previous?.closedReason ?? null,
        fingerprint: candidate.fingerprint ?? `${candidate.updatedAtRemote}|${candidate.headSha}|${candidate.mergeState}`,
      }

      const decision = shouldAutoClose(previous, next)
      if (decision.close === true) {
        next.localState = 'done'
        next.closedReason = decision.reason ?? 'remote-closed'
        closed += 1
        events.push({
          id: `auto-close:${candidate.key}:${next.headSha}:${remoteState}`,
          source: serviceName,
          type: 'workitem.closed',
          subject: candidate.subject,
          summary: candidate.title,
          link: candidate.link,
          at: isoTimestamp(),
          hops: 0,
          data: { reason: decision.reason },
        })
      }

      const isNew = previous === undefined
      if (isNew) added += 1
      if (isNew || previous?.headSha !== next.headSha || previous?.reason !== next.reason) {
        events.push({
          id: `${candidate.key}:${next.headSha}:${next.reason}:${next.updatedAtRemote}`,
          source: serviceName,
          type: `workitem.${next.reason}`,
          subject: candidate.subject,
          summary: candidate.title,
          link: candidate.link,
          at: isoTimestamp(),
          hops: 0,
          data: { kind: candidate.kind, project: candidate.project, iid: candidate.iid },
        })
      }

      if (entry.confirmOnly === true) {
        await store.items.patch(candidate.key, () => ({ remoteState: next.remoteState, localState: next.localState, closedReason: next.closedReason }))
      } else {
        await store.items.upsert(next)
      }
      items += 1
    }

    const recorded = await store.events.record(events)
    if (recorded.added.length > 0 || items > 0) {
      await store.audit.append({
        actor: 'poller',
        kind: 'poll',
        subject: serviceName,
        detail: { items, added, closed, newEvents: recorded.added.length, duplicates: recorded.duplicates },
      })
    }
    return { items, added, closed }
  }

  /**
   * Probe the connection without touching items (settings "测试连接").
   * @param {{ baseUrl: string, token: string }} input explicit credentials.
   * @returns {Promise<{ ok: boolean, user?: object, token?: object, message?: string, code?: string }>} probe result.
   */
  async function probe(input) {
    try {
      const { createGitlabAdapter } = await import('./gitlab.js')
      const adapter = createGitlabAdapter({ baseUrl: input.baseUrl, token: input.token, logger })
      const user = await adapter.getUser()
      const token = await adapter.checkToken()
      return { ok: true, user, token }
    } catch (error) {
      const normalized = normalizeError(error)
      return { ok: false, code: normalized.code, message: redact(normalized.message) }
    }
  }

  /**
   * Start the background loop.
   * @param {{ intervalSec?: number }} [input] cadence override.
   * @returns {() => void} disposer.
   */
  function start(input = {}) {
    const intervalSec = Math.max(MIN_POLL_INTERVAL_SEC, Number(input.intervalSec ?? 60) || 60)
    state.nextPollAt = now()
    const timer = ctx?.get?.('timer')
    if (timer !== undefined && typeof timer.interval === 'function') {
      disposer = timer.interval(() => {
        void poll()
      }, intervalSec * 1000)
    } else {
      const handle = setInterval(() => {
        void poll()
      }, intervalSec * 1000)
      handle.unref?.()
      disposer = () => clearInterval(handle)
    }
    // First cycle shortly after mount so the panel has data without a manual refresh.
    const kick = setTimeout(() => {
      void poll()
    }, 1500)
    kick.unref?.()
    const originalDispose = disposer
    return () => {
      clearTimeout(kick)
      originalDispose?.()
    }
  }

  /**
   * Pause or resume automatic polling.
   * @param {boolean} paused target state.
   * @returns {void}
   */
  function setPaused(paused) {
    state.paused = paused === true
    if (state.paused) state.nextPollAt = 0
    onChange()
  }

  /** Clear the stopped/backoff state after a manual refresh. */
  function resetBackoff() {
    state.stopped = false
    state.consecutiveFailures = 0
    state.backoffUntil = 0
    state.lastError = null
  }

  return {
    start,
    stop() {
      disposer?.()
      disposer = undefined
    },
    poll,
    probe,
    status,
    setPaused,
    resetBackoff,
    isPaused: () => state.paused,
    source: serviceName,
    tokenRef: TOKEN_REF,
  }
}