/**
 * Persistent store for daily-work-hub.
 *
 * Two interchangeable backends:
 * - `domain`: the host's `ctx.storageDomain` facility (transactional, durable).
 * - `file`: one atomically-written JSON file per table under a data directory.
 *
 * Callers only ever see the API in docs/CONTRACTS.md §3. The backend choice is
 * an implementation detail and is reported through {@link StoreHandle#backend}.
 * @module lib/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { clone, createLogger, isoTimestamp, normalizeError, stableStringify } from './util.js'

/** Tables owned by this plugin. */
export const TABLES = Object.freeze([
  'items',
  'events',
  'audit',
  'templates',
  'jobs',
  'runs',
  'turns',
  'views',
  'settings',
  'meta',
])

/** Settings defaults, merged into every read (docs/CONTRACTS.md §2). */
export const DEFAULT_SETTINGS = Object.freeze({
  gitlabBaseUrl: '',
  tokenRef: 'DAILY_WORK_GITLAB_PAT',
  groups: [],
  projects: [],
  pollIntervalSec: 60,
  quietHours: [],
  reviewConcurrency: 3,
  defaultProvider: '',
  defaultModel: '',
  allowWrites: true,
  includeIssues: true,
  excludePaths: ['**/*.lock', 'dist/**', '**/*.min.js'],
  paused: false,
})

/** GitLab token reference name (a POSIX identifier, per the credentials contract). */
export const TOKEN_REF = DEFAULT_SETTINGS.tokenRef

/** Days an event record is retained (§2 of DESIGN). */
const EVENT_RETENTION_DAYS = 30

/** Remove undefined members so JSON round-trips stay stable. */
function compact(value) {
  if (Array.isArray(value)) return value.map(compact)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue
      out[key] = compact(entry)
    }
    return out
  }
  return value
}

/**
 * Resolve the fallback data directory for the file backend.
 * @param {any} ctx plugin context, used for the profile directory when present.
 * @returns {string} absolute directory path.
 */
export function resolveDataDir(ctx) {
  const profile = ctx?.get?.('profileContext')
  const profileDir = typeof profile?.dir === 'string' && profile.dir !== '' ? profile.dir : undefined
  if (profileDir !== undefined) return join(profileDir, 'daily-work-hub')
  const envDir = process.env.DSH_PROFILE_DIR
  if (typeof envDir === 'string' && envDir !== '') return join(envDir, 'daily-work-hub')
  return join(homedir(), '.dsh', 'daily-work-hub')
}

/**
 * In-memory table fronted by one JSON file, written atomically on every change.
 */
class FileTable {
  /**
   * @param {string} file absolute file path.
   * @param {Map<string, any>} records loaded records.
   * @param {(work: () => Promise<void>) => Promise<void>} enqueue serial writer.
   */
  constructor(file, records, enqueue) {
    this.file = file
    this.records = records
    this.enqueue = enqueue
  }

  /** @returns {Map<string, any>} live record map. */
  map() {
    return this.records
  }

  /**
   * Persist one table snapshot.
   * @returns {Promise<void>} resolution after the rename.
   */
  flush() {
    return this.enqueue(async () => {
      const payload = `${JSON.stringify({ version: 1, values: Object.fromEntries(this.records) }, null, 0)}\n`
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this.file)
    })
  }

  /**
   * Put one record.
   * @param {string} key record key.
   * @param {any} value record value.
   * @returns {Promise<void>} resolution after durable write.
   */
  async put(key, value) {
    this.records.set(key, value)
    await this.flush()
  }

  /**
   * Delete one record.
   * @param {string} key record key.
   * @returns {Promise<boolean>} whether a record was removed.
   */
  async delete(key) {
    const had = this.records.delete(key)
    if (had) await this.flush()
    return had
  }
}

/**
 * Open the file backend.
 * @param {{ dir: string, logger: ReturnType<typeof createLogger> }} options backend options.
 * @returns {Promise<{ kind: 'file', dir: string, tables: Map<string, FileTable>, close: () => Promise<void> }>} backend.
 */
async function openFileBackend(options) {
  const dir = options.dir
  const logger = options.logger
  let chain = Promise.resolve()
  const enqueue = (work) => {
    const run = chain.then(work)
    chain = run.then(() => undefined, () => undefined)
    return run
  }
  const tables = new Map()
  await mkdir(dir, { recursive: true })

  for (const name of TABLES) {
    const file = join(dir, `${name}.json`)
    let records = new Map()
    try {
      const text = await readFile(file, 'utf8')
      const parsed = JSON.parse(text)
      const values = parsed?.values ?? {}
      if (values !== null && typeof values === 'object') records = new Map(Object.entries(values))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn(`store: could not read ${name}.json (${normalizeError(error).message}); starting empty`)
        try {
          await rename(file, `${file}.corrupt-${Date.now()}`)
        } catch {
          /* best effort */
        }
      }
    }
    tables.set(name, new FileTable(file, records, enqueue))
  }

  return {
    kind: 'file',
    dir,
    tables,
    async close() {
      await chain
    },
  }
}

/**
 * Open the ctx.storageDomain backend when the service exists and accepts our spec.
 *
 * The value schemas are identity parsers: the store validates shape itself and
 * must not depend on zod being resolvable from this bundle.
 * @param {any} ctx plugin context.
 * @param {ReturnType<typeof createLogger>} logger logger.
 * @returns {Promise<object | null>} backend, or null when unavailable.
 */
async function openDomainBackend(ctx, logger) {
  const facility = ctx?.get?.('storageDomain')
  if (facility === undefined || facility === null || typeof facility.open !== 'function') return null

  /** Identity schema: the store already normalized the record. */
  const passThrough = Object.freeze({ parse: (value) => value })
  const spec = {
    name: 'daily-work',
    version: 1,
    tables: Object.fromEntries(TABLES.map((name) => [name, { valueSchema: passThrough }])),
  }

  let domain
  try {
    domain = await facility.open(spec)
  } catch (error) {
    logger.warn(`store: storageDomain unavailable (${normalizeError(error).message}); using file backend`)
    return null
  }

  const tables = new Map()
  for (const name of TABLES) {
    const handle = domain.table(name)
    tables.set(name, {
      map: () => new Map([...handle.entries()]),
      put: (key, value) => handle.put(key, value),
      delete: (key) => handle.delete(key),
    })
  }
  return {
    kind: 'domain',
    tables,
    async close() {
      await domain.close?.()
    },
  }
}

/**
 * Build the store.
 * @param {object} options store options.
 * @param {any} [options.ctx] plugin context (for storageDomain / profileContext).
 * @param {string} [options.dir] file backend directory override (tests).
 * @param {any} [options.logger] logger override.
 * @param {boolean} [options.forceFile] skip storageDomain entirely (tests).
 * @returns {Promise<object>} store handle.
 */
export async function createStore(options = {}) {
  const logger = options.logger ?? createLogger(options.ctx)
  const backend =
    options.forceFile === true
      ? await openFileBackend({ dir: options.dir ?? join(homedir(), '.dsh', 'daily-work-hub'), logger })
      : (await openDomainBackend(options.ctx, logger)) ??
        (await openFileBackend({ dir: options.dir ?? resolveDataDir(options.ctx), logger }))

  /** Per-table in-memory mirror; domain reads are mirrored so ordering stays stable. */
  const mirrors = new Map()
  for (const name of TABLES) {
    const handle = backend.tables.get(name)
    const map = new Map()
    try {
      const entries = typeof handle.map === 'function' ? handle.map() : new Map()
      for (const [key, value] of entries) map.set(key, value)
    } catch (error) {
      logger.warn(`store: table ${name} could not be read (${normalizeError(error).message})`)
    }
    mirrors.set(name, map)
  }

  const listeners = new Set()
  let revision = Number(mirrors.get('meta').get('singleton')?.revision ?? 0) || 0
  let writeChain = Promise.resolve()
  let closed = false

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener(revision)
      } catch (error) {
        logger.warn(`store: change listener failed (${normalizeError(error).message})`)
      }
    }
  }

  const bumpRevision = () => {
    revision += 1
    return revision
  }

  const serialize = (work) => {
    const run = writeChain.then(work)
    writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Persist one record through the backend and mirror it locally.
   * @param {string} table table name.
   * @param {string} key record key.
   * @param {any} value record value.
   * @returns {Promise<any>} the stored value.
   */
  async function writeRecord(table, key, value) {
    if (closed) throw new Error('store is closed')
    const handle = backend.tables.get(table)
    const record = compact(value)
    await serialize(async () => {
      await handle.put(key, record)
      mirrors.get(table).set(key, record)
    })
    bumpRevision()
    await persistMetaRevision()
    notify()
    return record
  }

  /**
   * Delete one record.
   * @param {string} table table name.
   * @param {string} key record key.
   * @returns {Promise<boolean>} whether a record was removed.
   */
  async function deleteRecord(table, key) {
    if (closed) throw new Error('store is closed')
    const handle = backend.tables.get(table)
    const had = mirrors.get(table).has(key)
    if (!had) return false
    await serialize(async () => {
      await handle.delete(key)
      mirrors.get(table).delete(key)
    })
    bumpRevision()
    await persistMetaRevision()
    notify()
    return true
  }

  /** Persist the revision on the meta record so restarts keep monotonicity. */
  async function persistMetaRevision() {
    const meta = clonesMeta()
    meta.revision = revision
    mirrors.get('meta').set('singleton', meta)
    const handle = backend.tables.get('meta')
    await serialize(async () => {
      await handle.put('singleton', meta)
    })
  }

  function clonesMeta() {
    return clone(mirrors.get('meta').get('singleton') ?? {}) ?? {}
  }

  const tableOf = (name) => mirrors.get(name)

  const api = {
    backend: backend.kind,
    dataDir: backend.dir,
    getRevision: () => revision,
    onChange(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    items: {
      async list(query = {}) {
        const rows = [...tableOf('items').values()]
        return { rows, total: rows.length }
      },
      async get(key) {
        return clone(tableOf('items').get(key))
      },
      async all() {
        return clone([...tableOf('items').values()])
      },
      async upsert(item) {
        if (item === undefined || typeof item.key !== 'string' || item.key === '') {
          throw new Error('items.upsert requires a key')
        }
        const current = tableOf('items').get(item.key)
        const merged = { ...(current ?? {}), ...compact(item) }
        return clone(await writeRecord('items', item.key, merged))
      },
      async patch(key, fn) {
        const current = tableOf('items').get(key)
        if (current === undefined) return undefined
        const next = await fn(clone(current))
        if (next === undefined) return clone(current)
        return clone(await writeRecord('items', key, { ...current, ...compact(next) }))
      },
      async remove(key) {
        return deleteRecord('items', key)
      },
    },

    events: {
      async record(events) {
        const added = []
        let duplicates = 0
        for (const event of Array.isArray(events) ? events : []) {
          if (event === undefined || typeof event.id !== 'string' || event.id === '') continue
          if (tableOf('events').has(event.id)) {
            duplicates += 1
            continue
          }
          added.push(clone(await writeRecord('events', event.id, event)))
        }
        return { added, duplicates }
      },
      async list() {
        return clone([...tableOf('events').values()])
      },
      async pruneBefore(iso) {
        const cutoff = Date.parse(iso)
        if (!Number.isFinite(cutoff)) return 0
        const expired = [...tableOf('events').entries()]
          .filter(([, event]) => {
            const at = Date.parse(event?.at ?? '')
            return !Number.isFinite(at) || at < cutoff
          })
          .map(([key]) => key)
        for (const key of expired) await deleteRecord('events', key)
        return expired.length
      },
    },

    audit: {
      async append(entry) {
        const at = entry?.at ?? isoTimestamp()
        const seq = Number(clonesMeta().auditSeq ?? 0) + 1
        const record = {
          id: `${at}#${String(seq).padStart(6, '0')}`,
          at,
          actor: entry?.actor ?? 'system',
          kind: entry?.kind ?? 'note',
          subject: entry?.subject ?? null,
          detail: compact(entry?.detail ?? null),
        }
        const meta = clonesMeta()
        meta.auditSeq = seq
        mirrors.get('meta').set('singleton', meta)
        await writeRecord('audit', record.id, record)
        return record
      },
      async list(query = {}) {
        const rows = [...tableOf('audit').values()]
        const subject = typeof query.subject === 'string' ? query.subject : undefined
        const filtered = subject === undefined ? rows : rows.filter((row) => row.subject === subject)
        filtered.sort((a, b) => String(b.id).localeCompare(String(a.id)))
        const limit = Number.isFinite(query.limit) ? Math.max(1, Math.trunc(query.limit)) : 200
        return clone(filtered.slice(0, limit))
      },
    },

    turns: {
      async put(turn) {
        return clone(await writeRecord('turns', turn.id, turn))
      },
      async get(id) {
        return clone(tableOf('turns').get(id))
      },
      async list(query = {}) {
        const rows = [...tableOf('turns').values()]
        const key = typeof query.key === 'string' ? query.key : undefined
        const filtered = key === undefined ? rows : rows.filter((row) => row.key === key)
        filtered.sort((a, b) => Date.parse(b.startedAt ?? 0) - Date.parse(a.startedAt ?? 0))
        return clone(filtered.slice(0, Number(query.limit ?? 50)))
      },
    },

    templates: {
      async list() {
        const rows = [...tableOf('templates').values()]
        rows.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh'))
        return clone(rows)
      },
      async get(id) {
        return clone(tableOf('templates').get(id))
      },
      async put(template) {
        return clone(await writeRecord('templates', template.id, template))
      },
      async remove(id) {
        return deleteRecord('templates', id)
      },
    },

    jobs: {
      async list() {
        const rows = [...tableOf('jobs').values()]
        rows.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh'))
        return clone(rows)
      },
      async get(id) {
        return clone(tableOf('jobs').get(id))
      },
      async put(job) {
        return clone(await writeRecord('jobs', job.id, job))
      },
      async remove(id) {
        return deleteRecord('jobs', id)
      },
    },

    runs: {
      async list(query = {}) {
        const rows = [...tableOf('runs').values()]
        const jobId = typeof query.jobId === 'string' ? query.jobId : undefined
        const state = typeof query.state === 'string' ? query.state : undefined
        const filtered = rows.filter(
          (row) => (jobId === undefined || row.jobId === jobId) && (state === undefined || row.state === state),
        )
        filtered.sort((a, b) => Date.parse(b.scheduledAt ?? 0) - Date.parse(a.scheduledAt ?? 0))
        const limit = Number.isFinite(query.limit) ? Math.max(1, Math.trunc(query.limit)) : 100
        return clone(filtered.slice(0, limit))
      },
      async get(id) {
        return clone(tableOf('runs').get(id))
      },
      async put(run) {
        return clone(await writeRecord('runs', run.id, run))
      },
      async remove(id) {
        return deleteRecord('runs', id)
      },
    },

    views: {
      async list() {
        return clone([...tableOf('views').values()])
      },
      async put(view) {
        return clone(await writeRecord('views', view.id, view))
      },
      async remove(id) {
        return deleteRecord('views', id)
      },
    },

    settings: {
      async get() {
        return clone({ ...DEFAULT_SETTINGS, ...(tableOf('settings').get('singleton') ?? {}) })
      },
      async patch(partial) {
        const current = { ...DEFAULT_SETTINGS, ...(tableOf('settings').get('singleton') ?? {}) }
        const next = { ...current, ...compact(partial ?? {}) }
        return clone(await writeRecord('settings', 'singleton', next))
      },
    },

    meta: {
      async get() {
        return clone(mirrors.get('meta').get('singleton') ?? { revision })
      },
      async patch(partial) {
        const current = clonesMeta()
        const next = { ...current, ...compact(partial ?? {}), revision }
        await writeRecord('meta', 'singleton', next)
        return clone(next)
      },
    },

    /** Deterministic fingerprint used by the routes for ETags. */
    fingerprint() {
      return stableStringify({ revision, meta: mirrors.get('meta').get('singleton') ?? null }).length + revision
    },

    async close() {
      closed = true
      listeners.clear()
      try {
        await backend.close()
      } catch (error) {
        logger.warn(`store: close failed (${normalizeError(error).message})`)
      }
    },
  }

  logger.info(
    `store: backend=${backend.kind}${backend.dir === undefined ? '' : ` dir=${backend.dir}`} revision=${revision}`,
  )
  return api
}

/** Retention window in milliseconds for events. */
export const EVENT_RETENTION_MS = EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000