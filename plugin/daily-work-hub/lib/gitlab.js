/**
 * GitLab REST adapter (DESIGN §5.1).
 *
 * Only "what to ask": endpoints, pagination, error normalization and rate
 * limiting. Scheduling, dedupe and state belong to `lib/poller.js`.
 *
 * The adapter never logs or returns the token, and every outgoing path is built
 * from validated fields — caller text never becomes a request target.
 * @module lib/gitlab
 */

import { MINUTE, createTokenBucket, normalizeError, redact, withTimeout } from './util.js'

/** GitLab API version root appended to the instance base URL. */
const API_ROOT = '/api/v4'

/** Read requests are cheap but bounded; writes are the scarce resource (§5.4). */
const READ_BUCKET = Object.freeze({ capacity: 120, refillPerMinute: 120 })
const WRITE_BUCKET = Object.freeze({ capacity: 30, refillPerMinute: 30 })

/** Network timeout per request. */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Normalized GitLab failure. `code` is the stable discriminant callers switch on.
 */
export class GitlabError extends Error {
  /**
   * @param {string} code stable code such as `auth`, `rate-limit`, `not-found`, `network`.
   * @param {string} message human-readable message with secrets redacted.
   * @param {{ status?: number, retryAfterMs?: number, cause?: unknown }} [extra] failure detail.
   */
  constructor(code, message, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
    this.name = 'GitlabError'
    this.code = code
    if (extra.status !== undefined) this.status = extra.status
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs
  }
}

/**
 * Remove a trailing slash and validate the base URL.
 * @param {string} baseUrl instance URL.
 * @returns {string} normalized URL without trailing slash.
 */
export function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim()
  if (raw === '') throw new GitlabError('config', 'GitLab 实例地址未配置')
  if (!/^https?:\/\/[\x21-\x7e]+$/i.test(raw)) {
    throw new GitlabError('config', 'GitLab 实例地址必须是 http(s) 且只含 ASCII 字符')
  }
  return raw.replace(/\/+$/, '').replace(/\/api\/v4$/i, '')
}

/**
 * Reject path traversal before a value becomes a URL segment.
 * @param {string} value candidate path.
 * @param {string} what human-readable subject for the error.
 * @returns {string} the validated value.
 */
export function assertSafePath(value, what = '路径') {
  const text = String(value ?? '')
  if (text === '') throw new GitlabError('config', `${what}为空，已拒绝请求`)
  if (text.startsWith('/') || text.includes('\\')) {
    throw new GitlabError('config', `${what}不能是绝对路径，已拒绝请求`)
  }
  const segments = text.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new GitlabError('config', `${what}包含非法路径段，已拒绝请求`)
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(text)) {
    throw new GitlabError('config', `${what}含非法字符，已拒绝请求`)
  }
  return text
}

/**
 * Encode a project path (`group/sub/project`) for the `/projects/:id` segment.
 * @param {string} projectPath project path or numeric id.
 * @returns {string} URL-safe project id.
 */
export function encodeProjectId(projectPath) {
  const value = String(projectPath ?? '')
  if (/^\d+$/.test(value)) return value
  return encodeURIComponent(assertSafePath(value, '项目路径'))
}

/**
 * Build a query string from defined values.
 * @param {Record<string, unknown>} query parameters.
 * @returns {string} `?...` or empty string.
 */
export function buildQuery(query = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      for (const entry of value) params.append(key, String(entry))
      continue
    }
    params.set(key, String(value))
  }
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

/**
 * Pick the pipeline relevant to a commit, falling back to the newest one.
 * @param {readonly any[]} pipelines pipeline list.
 * @param {string} [headSha] current head.
 * @returns {{ status: string, sha: string, url?: string, id?: number } | null} summary.
 */
export function summarizePipeline(pipelines, headSha) {
  if (!Array.isArray(pipelines) || pipelines.length === 0) return null
  const forHead = headSha === undefined ? undefined : pipelines.find((pipeline) => pipeline?.sha === headSha)
  const chosen = forHead ?? pipelines[0]
  if (chosen === null || chosen === undefined) return null
  return {
    status: typeof chosen.status === 'string' ? chosen.status : 'unknown',
    sha: typeof chosen.sha === 'string' ? chosen.sha : '',
    url: typeof chosen.web_url === 'string' ? chosen.web_url : undefined,
    id: typeof chosen.id === 'number' ? chosen.id : undefined,
  }
}

/**
 * Normalize project references returned by the API.
 * @param {any} project raw payload.
 * @returns {{ id: number|undefined, path: string, name: string, webUrl: string|undefined }} summary.
 */
export function summarizeProject(project) {
  return {
    id: typeof project?.id === 'number' ? project.id : undefined,
    path: typeof project?.path_with_namespace === 'string' ? project.path_with_namespace : '',
    name: typeof project?.name === 'string' ? project.name : '',
    webUrl: typeof project?.web_url === 'string' ? project.web_url : undefined,
  }
}

/**
 * Create a GitLab adapter.
 *
 * @param {object} options adapter options.
 * @param {string} options.baseUrl instance base URL.
 * @param {string} options.token personal access token (never logged).
 * @param {typeof fetch} [options.fetchImpl] fetch implementation (injectable for tests).
 * @param {any} [options.logger] logger.
 * @param {(path: string, init?: object) => Promise<any>} [options.onRequest] test hook.
 * @returns {object} adapter with the endpoint methods used by the poller and reviewer.
 */
export function createGitlabAdapter(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const token = String(options.token ?? '')
  if (token === '') throw new GitlabError('auth', 'GitLab Token 未配置')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new GitlabError('config', '当前运行环境没有 fetch')
  const logger = options.logger
  const readBucket = createTokenBucket(READ_BUCKET)
  const writeBucket = createTokenBucket(WRITE_BUCKET)
  const capabilities = { reviewsForMe: undefined, approvals: undefined, detailedStatus: undefined }
  const hook = options.onRequest

  /**
   * Wait until the bucket allows a token, then consume it.
   * @param {ReturnType<typeof createTokenBucket>} bucket bucket to use.
   * @param {number} cost tokens to consume.
   * @param {AbortSignal} [signal] cancellation.
   * @returns {Promise<void>} resolution when the request may proceed.
   */
  async function reserve(bucket, cost = 1, signal) {
    for (;;) {
      const waitMs = bucket.waitMs(cost)
      if (waitMs <= 0) {
        bucket.take(cost)
        return
      }
      if (signal?.aborted === true) throw new GitlabError('aborted', '请求已取消')
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(waitMs, MINUTE))
        timer.unref?.()
      })
    }
  }

  /**
   * Execute one API request.
   * @param {string} path API path beginning with `/`.
   * @param {{ method?: string, query?: Record<string, unknown>, body?: unknown, signal?: AbortSignal, write?: boolean }} [init] request options.
   * @returns {Promise<{ status: number, headers: Headers, data: any }>} response.
   */
  async function request(path, init = {}) {
    const method = String(init.method ?? 'GET').toUpperCase()
    const write = init.write === true || method !== 'GET'
    await reserve(write ? writeBucket : readBucket, 1, init.signal)

    const url = `${baseUrl}${API_ROOT}${path}${buildQuery(init.query)}`
    const headers = {
      'PRIVATE-TOKEN': token,
      accept: 'application/json',
    }
    if (init.body !== undefined) headers['content-type'] = 'application/json'

    let response
    try {
      response = await withTimeout(
        fetchImpl(url, {
          method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: init.signal,
        }),
        REQUEST_TIMEOUT_MS,
        'GitLab 请求',
      )
    } catch (error) {
      if (error?.name === 'AbortError') throw new GitlabError('aborted', '请求已取消')
      throw new GitlabError('network', `GitLab 连接失败：${redact(normalizeError(error).message)}`, { cause: error })
    }

    hook?.(path, { method, url })

    const remaining = response.headers?.get?.('ratelimit-remaining')
    if (remaining !== null && remaining !== undefined && Number(remaining) < 5) {
      logger?.warn?.(`gitlab: rate limit nearly exhausted (remaining=${remaining})`)
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers?.get?.('retry-after') ?? 0)
      throw new GitlabError('rate-limit', 'GitLab 限流（429），稍后重试', {
        status: 429,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : MINUTE,
      })
    }
    if (response.status === 401) throw new GitlabError('auth', 'GitLab Token 无效或已过期', { status: 401 })
    if (response.status === 403) throw new GitlabError('forbidden', 'GitLab 权限不足（403）', { status: 403 })
    if (response.status === 404) throw new GitlabError('not-found', 'GitLab 资源不存在（404）', { status: 404 })
    if (response.status >= 500) {
      throw new GitlabError('server', `GitLab 服务异常（${response.status}）`, { status: response.status })
    }
    if (!response.ok) {
      let detail = ''
      try {
        const text = await response.text()
        detail = redact(text).slice(0, 300)
      } catch {
        /* ignore */
      }
      throw new GitlabError('http', `GitLab 请求失败（${response.status}）${detail === '' ? '' : `：${detail}`}`, {
        status: response.status,
      })
    }

    const text = response.status === 204 ? '' : await response.text()
    let data = null
    if (text !== '') {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    return { status: response.status, headers: response.headers, data }
  }

  /**
   * Walk a paginated collection.
   * @param {string} path API path.
   * @param {Record<string, unknown>} query base query.
   * @param {{ perPage?: number, maxPages?: number, signal?: AbortSignal }} [options] paging options.
   * @returns {Promise<any[]>} concatenated rows.
   */
  async function paginate(path, query = {}, options = {}) {
    const perPage = Math.min(100, Math.max(1, options.perPage ?? 100))
    const maxPages = Math.max(1, options.maxPages ?? 20)
    const rows = []
    let page = 1
    for (;;) {
      const response = await request(path, {
        query: { ...query, per_page: perPage, page },
        signal: options.signal,
      })
      if (Array.isArray(response.data)) rows.push(...response.data)
      const nextPage = response.headers?.get?.('x-next-page')
      if (nextPage === null || nextPage === undefined || nextPage === '' || nextPage === '0') break
      page = Number(nextPage)
      if (!Number.isFinite(page) || page <= 0 || page > maxPages) break
    }
    return rows
  }

  const api = {
    baseUrl,
    capabilities,

    /** @returns {Promise<{ id: number, username: string, name: string }>} the token owner. */
    async getUser() {
      const response = await request('/user')
      const data = response.data ?? {}
      return {
        id: typeof data.id === 'number' ? data.id : 0,
        username: typeof data.username === 'string' ? data.username : '',
        name: typeof data.name === 'string' ? data.name : '',
      }
    },

    /**
     * Token self-check with scope information (DESIGN §5.1).
     * @returns {Promise<{ active: boolean, scopes: string[], expiresAt: string | null, username?: string }>} token state.
     */
    async checkToken() {
      try {
        const response = await request('/personal_access_tokens/self')
        const data = response.data ?? {}
        return {
          active: data.active !== false,
          scopes: Array.isArray(data.scopes) ? data.scopes : [],
          expiresAt: typeof data.expires_at === 'string' ? data.expires_at : null,
        }
      } catch (error) {
        if (error?.code === 'not-found' || error?.code === 'forbidden') {
          // Older/CE instances may not expose this endpoint; fall back to /user.
          const user = await api.getUser()
          return { active: user.id !== 0, scopes: [], expiresAt: null, username: user.username }
        }
        throw error
      }
    },

    /**
     * Projects the user can see (for the settings picker).
     * @param {{ search?: string, signal?: AbortSignal }} [options] filters.
     * @returns {Promise<any[]>} projects.
     */
    async listProjects(options = {}) {
      return paginate('/projects', { membership: true, simple: true, search: options.search }, options)
    },

    /**
     * Merge requests awaiting my review.
     *
     * Capability probe order (`scope=reviews_for_me` → `reviewer_username` →
     * reviewer filter over open MRs) follows DESIGN §5.1.
     * @param {{ username?: string, signal?: AbortSignal }} [options] fallback identity.
     * @returns {Promise<any[]>} merge requests.
     */
    async listReviewRequests(options = {}) {
      if (capabilities.reviewsForMe !== false) {
        try {
          const rows = await paginate(
            '/merge_requests',
            { scope: 'reviews_for_me', state: 'opened', order_by: 'updated_at', sort: 'desc' },
            options,
          )
          capabilities.reviewsForMe = true
          return rows
        } catch (error) {
          if (error?.code !== 'http' && error?.code !== 'not-found') throw error
          capabilities.reviewsForMe = false
          logger?.warn?.('gitlab: scope=reviews_for_me unsupported; falling back to reviewer_username')
        }
      }
      const username = String(options.username ?? '')
      if (username !== '') {
        try {
          return await paginate(
            '/merge_requests',
            {
              reviewer_username: username,
              state: 'opened',
              order_by: 'updated_at',
              sort: 'desc',
              scope: 'all',
            },
            options,
          )
        } catch (error) {
          if (error?.code !== 'http') throw error
        }
      }
      const rows = await paginate(
        '/merge_requests',
        { state: 'opened', order_by: 'updated_at', sort: 'desc', scope: 'all' },
        options,
      )
      if (username === '') return rows
      return rows.filter((row) => (row?.reviewers ?? []).some((reviewer) => reviewer?.username === username))
    },

    /**
     * Pending todos, used to fill approval gaps on CE instances.
     * @param {{ signal?: AbortSignal }} [options] options.
     * @returns {Promise<any[]>} todos.
     */
    async listTodos(options = {}) {
      return paginate('/todos', { state: 'pending', per_page: 100 }, options)
    },

    /**
     * Issues assigned to me.
     * @param {{ signal?: AbortSignal }} [options] options.
     * @returns {Promise<any[]>} issues.
     */
    async listAssignedIssues(options = {}) {
      return paginate(
        '/issues',
        { scope: 'assigned_to_me', state: 'opened', order_by: 'updated_at', sort: 'desc' },
        options,
      )
    },

    /**
     * Open merge requests I authored.
     * @param {{ signal?: AbortSignal }} [options] options.
     * @returns {Promise<any[]>} merge requests.
     */
    async listAuthoredMergeRequests(options = {}) {
      return paginate(
        '/merge_requests',
        { scope: 'created_by_me', state: 'opened', order_by: 'updated_at', sort: 'desc' },
        options,
      )
    },

    /**
     * Open issues I authored.
     * @param {{ signal?: AbortSignal }} [options] options.
     * @returns {Promise<any[]>} issues.
     */
    async listAuthoredIssues(options = {}) {
      return paginate('/issues', { scope: 'created_by_me', state: 'opened', order_by: 'updated_at', sort: 'desc' }, options)
    },

    /**
     * One merge request with the fields the detail view and reviewer need.
     * @param {string} projectId project path or id.
     * @param {number} iid merge request iid.
     * @param {{ signal?: AbortSignal }} [options] options.
     * @returns {Promise<any>} merge request payload.
     */
    async getMergeRequest(projectId, iid, options = {}) {
      const response = await request(`/projects/${encodeProjectId(projectId)}/merge_requests/${Number(iid)}`, {
        signal: options.signal,
      })
      return response.data
    },

    /**
     * Paginated `/diffs` (the endpoint that replaced `/changes`).
     * @param {string} projectId project path or id.
     * @param {number} iid merge request iid.
     * @param {{ signal?: AbortSignal, maxPages?: number }} [options] options.
     * @returns {Promise<any[]>} file diffs.
     */
    async getDiffs(projectId, iid, options = {}) {
      return paginate(
        `/projects/${encodeProjectId(projectId)}/merge_requests/${Number(iid)}/diffs`,
        {},
        { signal: options.signal, maxPages: options.maxPages ?? 10 },
      )
    },

    /**
     * Merge request versions, used to detect head movement.
     * @param {string} projectId project path or id.
     * @param {number} iid merge request iid.
     * @param {{ signal?: AbortSignal }} [options] options.
     * @returns {Promise<any[]>} versions.
     */
    async getVersions(projectId, iid, options = {}) {
      return paginate(`/projects/${encodeProjectId(projectId)}/merge_requests/${Number(iid)}/versions`, {}, options)
    },

    /**
     * Approvals. On CE this 404s; callers must treat `null` as "unsupported".
     * @param {string} projectId project path or id.
     * @param {number} iid merge request iid.
     * @param {{ signal?: AbortSignal }} [options] options.
     * @returns {Promise<any | null>} approvals payload or null.
     */
    async getApprovals(projectId, iid, options = {}) {
      if (capabilities.approvals === false) return null
      try {
        const response = await request(`/projects/${encodeProjectId(projectId)}/merge_requests/${Number(iid)}/approvals`, {
          signal: options.signal,
        })
        capabilities.approvals = true
        return response.data
      } catch (error) {
        if (error?.code === 'not-found' || error?.code === 'forbidden') {
          capabilities.approvals = false
          return null
        }
        throw error
      }
    },

    /**
     * Discussion threads, including resolvable/resolved state and positions.
     * @param {string} projectId project path or id.
     * @param {number} iid merge request iid.
     * @param {{ signal?: AbortSignal }} [options] options.
     * @returns {Promise<any[]>} discussions.
     */
    async getDiscussions(projectId, iid, options = {}) {
      return paginate(`/projects/${encodeProjectId(projectId)}/merge_requests/${Number(iid)}/discussions`, {}, options)
    },

    /**
     * Pipelines for the merge request (CI is a signal only, never logs).
     * @param {string} projectId project path or id.
     * @param {number} iid merge request iid.
     * @param {{ signal?: AbortSignal }} [options] options.
     * @returns {Promise<any[]>} pipelines.
     */
    async getPipelines(projectId, iid, options = {}) {
      return paginate(`/projects/${encodeProjectId(projectId)}/merge_requests/${Number(iid)}/pipelines`, {}, options)
    },

    /**
     * Raw repository file, for context beyond the diff.
     * @param {string} projectId project path or id.
     * @param {string} path repository-relative path.
     * @param {string} ref commit sha or branch.
     * @param {{ signal?: AbortSignal }} [options] options.
     * @returns {Promise<string>} file text.
     */
    async getFileRaw(projectId, path, ref, options = {}) {
      assertSafePath(path, '文件路径')
      const response = await request(
        `/projects/${encodeProjectId(projectId)}/repository/files/${encodeURIComponent(path)}/raw`,
        { query: { ref }, signal: options.signal },
      )
      return typeof response.data === 'string' ? response.data : ''
    },

    /**
     * Compare two SHAs, for incremental review.
     * @param {string} projectId project path or id.
     * @param {string} from sha.
     * @param {string} to sha.
     * @param {{ signal?: AbortSignal }} [options] options.
     * @returns {Promise<any>} compare payload.
     */
    async compare(projectId, from, to, options = {}) {
      const response = await request(`/projects/${encodeProjectId(projectId)}/repository/compare`, {
        query: { from, to },
        signal: options.signal,
      })
      return response.data
    },

    /**
     * Post a note to the merge request.
     * @param {string} projectId project path or id.
     * @param {number} iid merge request iid.
     * @param {string} body markdown body.
     * @param {{ signal?: AbortSignal }} [options] options.
     * @returns {Promise<any>} created note.
     */
    async postNote(projectId, iid, body, options = {}) {
      const response = await request(`/projects/${encodeProjectId(projectId)}/merge_requests/${Number(iid)}/notes`, {
        method: 'POST',
        body: { body: String(body ?? '') },
        write: true,
        signal: options.signal,
      })
      return response.data
    },

    /**
     * Post an inline discussion on a diff position.
     * @param {string} projectId project path or id.
     * @param {number} iid merge request iid.
     * @param {{ body: string, position: object }} input discussion input.
     * @param {{ signal?: AbortSignal }} [options] options.
     * @returns {Promise<any>} created discussion.
     */
    async postDiscussion(projectId, iid, input, options = {}) {
      const response = await request(
        `/projects/${encodeProjectId(projectId)}/merge_requests/${Number(iid)}/discussions`,
        { method: 'POST', body: { body: input.body, position: input.position }, write: true, signal: options.signal },
      )
      return response.data
    },

    /**
     * Resolve or unresolve one discussion.
     * @param {string} projectId project path or id.
     * @param {number} iid merge request iid.
     * @param {string} discussionId discussion id.
     * @param {boolean} resolved target state.
     * @param {{ signal?: AbortSignal }} [options] options.
     * @returns {Promise<any>} updated discussion.
     */
    async setDiscussionResolved(projectId, iid, discussionId, resolved, options = {}) {
      const response = await request(
        `/projects/${encodeProjectId(projectId)}/merge_requests/${Number(iid)}/discussions/${encodeURIComponent(discussionId)}`,
        { method: 'PUT', query: { resolved: resolved === true }, write: true, signal: options.signal },
      )
      return response.data
    },

    /**
     * Approve the merge request. Only ever called from an explicit user action.
     * @param {string} projectId project path or id.
     * @param {number} iid merge request iid.
     * @param {{ sha?: string, signal?: AbortSignal }} [options] options.
     * @returns {Promise<any>} approval payload.
     */
    async approve(projectId, iid, options = {}) {
      const response = await request(`/projects/${encodeProjectId(projectId)}/merge_requests/${Number(iid)}/approve`, {
        method: 'POST',
        body: options.sha === undefined ? {} : { sha: options.sha },
        write: true,
        signal: options.signal,
      })
      return response.data
    },
  }

  return api
}