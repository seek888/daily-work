/**
 * Review pipeline for daily-work-hub.
 *
 * Fully dependency-injected: no network, no host service imports, no side
 * effects at import time. The pipeline is
 *
 *   fetch payload -> parse diff -> plan segments -> write context files ->
 *   render prompt -> run model (subagent | session | heuristic) ->
 *   validate findings -> aggregate -> persist Turn
 *
 * Rules that matter (docs/CONTRACTS.md §6):
 * - context is **written as files**; prompts contain paths, not MR text.
 * - model output is post-validated; findings that cannot be proven against the
 *   diff are dropped into `errors`, never silently kept.
 * - a model failure never throws out of `review()`; it degrades to
 *   `mode: 'heuristic'` with an explicit note that no semantic review happened.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SEED_TEMPLATES, matchTemplate, renderPrompt } from './templates.js'

/**
 * A single file is treated as oversized after this many changed lines even
 * before the character budget is considered.
 */
const TOO_LARGE_LINES = 2000

/** Default per-segment character budget (≈ 12k tokens of diff). */
const DEFAULT_SEGMENT_CHARS = 48000

/** Default maximum number of segments (research/05-ai-review.md §2.3.4). */
const DEFAULT_MAX_SEGMENTS = 6

/** Upper bound for segment concurrency. */
const MAX_CONCURRENCY = 8

/** Findings are ordered by this ranking. */
const SEVERITY_ORDER = Object.freeze({ blocker: 0, high: 1, medium: 2, low: 3 })

/** Verdicts ordered from least to most conservative. */
const VERDICT_ORDER = Object.freeze({
  'approve-suggested': 0,
  'comments-only': 1,
  'request-changes-suggested': 2,
})

/** Verdicts accepted by the schema and the pipeline. */
const VERDICTS = Object.freeze([
  'approve-suggested',
  'comments-only',
  'request-changes-suggested',
])

/** Severities accepted by docs/CONTRACTS.md §2. */
const SEVERITIES = Object.freeze(['blocker', 'high', 'medium', 'low'])

/** Source extensions that need a test-change signal. */
const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.vue',
  '.svelte',
])

/** Secret-looking value patterns (conservative; high, never blocker). */
const SECRET_PATTERNS = Object.freeze([
  /(?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?key|auth[_-]?token|password|passwd)\s*[:=]\s*['"][^'"]{12,}['"]/i,
  /(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
])

/**
 * Narrow JSON Schema for `ReviewResult@1`, safe for `subagents.prompt` /
 * `runner.subagent({ outputSchema })`.
 *
 * Only the supported subset is used (`type/oneOf/properties/required/
 * additionalProperties/items/enum/description`). `line` is a string on purpose:
 * the host schema cannot express `minimum`, so the line number is parsed and
 * checked by {@link validateFindings} instead.
 * @type {Readonly<object>}
 */
export const REVIEW_RESULT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['verdict', 'summary', 'findings']),
  properties: Object.freeze({
    verdict: Object.freeze({
      type: 'string',
      enum: Object.freeze(VERDICTS),
      description: '建议结论；approve-suggested 仅为建议，永不自动提交到代码托管平台',
    }),
    summary: Object.freeze({
      type: 'string',
      description: '2-5 句中文整体结论，说明主要风险与是否建议阻塞合并',
    }),
    findings: Object.freeze({
      type: 'array',
      description: '发现列表，按 severity 降序；没有问题时返回空数组',
      items: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: Object.freeze(['file', 'line', 'severity', 'title', 'evidence', 'suggestion']),
        properties: Object.freeze({
          file: Object.freeze({
            type: 'string',
            description: '相对仓库根路径，必须与输入 diff 中的路径完全一致',
          }),
          line: Object.freeze({
            type: 'string',
            description: '新文件侧行号（字符串形式，由代码解析）',
          }),
          severity: Object.freeze({
            type: 'string',
            enum: Object.freeze(SEVERITIES),
            description: 'blocker / high / medium / low',
          }),
          title: Object.freeze({ type: 'string', description: '一句话问题描述，≤60 字' }),
          evidence: Object.freeze({
            type: 'string',
            description: '逐字复制 diff 中的一行（含删除行），用于后校验',
          }),
          suggestion: Object.freeze({ type: 'string', description: '可执行的修复建议' }),
        }),
      }),
    }),
  }),
})

/**
 * Rank a severity; unknown severities sort after `low`.
 * @param {unknown} severity severity string.
 * @returns {number} rank.
 */
function severityRank(severity) {
  return SEVERITY_ORDER[severity] ?? 9
}

/**
 * Normalize a line number from a model string or a number.
 * @param {unknown} value candidate.
 * @returns {number | null} positive integer line, or null.
 */
function parseLineNumber(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 ? value : null
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const line = Number(value.trim())
    return line >= 1 ? line : null
  }
  return null
}

/**
 * Detect generated / lock / build-artifact paths.
 * @param {unknown} filePath path from the diff.
 * @returns {boolean} whether the path is generated.
 */
function isGeneratedPath(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return false
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (/^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|go\.sum|cargo\.lock|poetry\.lock|composer\.lock|gemfile\.lock|flake\.lock|uv\.lock|pubspec\.lock)$/.test(base)) {
    return true
  }
  if (/\.(min\.js|min\.css|map)$/.test(base)) return true
  if (/(^|\/)(dist|build|out|vendor|node_modules|coverage|\.next|\.nuxt)\//.test(normalized)) return true
  if (/\.(generated|g)\.[a-z0-9]+$/.test(base)) return true
  if (/_generated\./.test(base) || /\.pb\.go$/.test(base)) return true
  return false
}

/**
 * Detect test paths.
 * @param {unknown} filePath path from the diff.
 * @returns {boolean} whether the path is a test file.
 */
function isTestPath(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return false
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  if (/(^|\/)(__tests__|tests?|testdata)\//.test(normalized)) return true
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  return /\.(test|spec)\.[a-z0-9]+$/.test(base) || /_(test|spec)\.(go|py|rb)$/.test(base)
}

/**
 * Detect configuration files.
 * @param {unknown} filePath path from the diff.
 * @returns {boolean} whether the path is configuration.
 */
function isConfigPath(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return false
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (/^(dockerfile|makefile|procfile|cmakelists\.txt|tsconfig(\..*)?\.json|jsconfig\.json|package\.json|\.env(\..*)?|\.gitlab-ci\.yml)$/.test(base)) {
    return true
  }
  return /\.(json|ya?ml|toml|ini|cfg|conf|env|properties|xml)$/.test(base)
}

/**
 * Strip a diff `a/` or `b/` prefix and optional quotes.
 * @param {string} value raw path.
 * @returns {string} cleaned path.
 */
function stripDiffPrefix(value) {
  let text = String(value).trim()
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) text = text.slice(1, -1)
  if (text.startsWith('a/') || text.startsWith('b/')) return text.slice(2)
  return text
}

/**
 * Parse the paths out of a `diff --git a/x b/y` line.
 * @param {string} line header line.
 * @returns {{ oldPath: string, newPath: string }} paths ('' when absent).
 */
function parseGitHeader(line) {
  const rest = line.slice('diff --git '.length)
  const quoted = /^"a\/(.*)" "b\/(.*)"$/.exec(rest)
  if (quoted !== null) return { oldPath: quoted[1], newPath: quoted[2] }

  let oldRaw = ''
  let newRaw = ''
  if (rest.startsWith('a/')) {
    const split = rest.indexOf(' b/')
    if (split > 2) {
      oldRaw = rest.slice(2, split)
      newRaw = rest.slice(split + 3)
    }
  }
  if (oldRaw === '') {
    const parts = rest.split(' ')
    oldRaw = parts[0] ?? ''
    newRaw = parts[1] ?? ''
  }
  return { oldPath: stripDiffPrefix(oldRaw), newPath: stripDiffPrefix(newRaw) }
}

/**
 * Parse one `---` / `+++` header value.
 * @param {string} value text after the marker.
 * @returns {string | null} path, or null for `/dev/null`.
 */
function parseFileHeaderPath(value) {
  let text = String(value).split('\t')[0].trim()
  if (text === '/dev/null') return null
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) text = text.slice(1, -1)
  return stripDiffPrefix(text)
}

/**
 * Parse a `@@ -a,b +c,d @@` hunk header.
 * @param {string} line header line.
 * @returns {{ oldStart: number, oldCount: number, newStart: number, newCount: number } | null} ranges.
 */
function parseHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
  if (match === null) return null
  const count = (value) => (value === undefined ? 1 : Number(value))
  return {
    oldStart: Number(match[1]),
    oldCount: count(match[2]),
    newStart: Number(match[3]),
    newCount: count(match[4]),
  }
}

/**
 * Parse a unified diff into files with hunk line metadata.
 *
 * Tolerates missing `diff --git` headers (a bare `---`/`+++` pair starts a
 * file) and `\ No newline at end of file` markers. Invalid input yields `[]`.
 * Line objects are `{ type: '+' | '-' | ' ', text, newLine, oldLine }` where the
 * irrelevant side is `null`; `text` never includes the `+`/`-`/space marker.
 * @param {unknown} text unified diff text.
 * @returns {object[]} parsed files.
 */
export function parseDiff(text) {
  if (typeof text !== 'string' || text.trim() === '') return []

  const rawLines = text.split(/\r?\n/)
  const files = []
  let current = null
  let hunk = null
  let oldLine = 0
  let newLine = 0
  let oldRemaining = 0
  let newRemaining = 0

  /**
   * Start a new file record and append it to `files`.
   * @returns {object} the new record.
   */
  const startFile = () => {
    current = {
      oldPath: null,
      newPath: null,
      newFile: false,
      deletedFile: false,
      generated: false,
      tooLarge: false,
      hunks: [],
      additions: 0,
      deletions: 0,
    }
    files.push(current)
    hunk = null
    return current
  }

  for (const rawLine of rawLines) {
    if (rawLine.startsWith('\\')) continue

    if (hunk !== null && (oldRemaining > 0 || newRemaining > 0) && !rawLine.startsWith('diff --git ')) {
      const marker = rawLine.charAt(0)
      if (rawLine === '' || marker === ' ') {
        hunk.lines.push({
          type: ' ',
          text: rawLine === '' ? '' : rawLine.slice(1),
          newLine,
          oldLine,
        })
        oldLine += 1
        newLine += 1
        oldRemaining = Math.max(0, oldRemaining - 1)
        newRemaining = Math.max(0, newRemaining - 1)
        continue
      }
      if (marker === '+') {
        hunk.lines.push({ type: '+', text: rawLine.slice(1), newLine, oldLine: null })
        newLine += 1
        newRemaining = Math.max(0, newRemaining - 1)
        current.additions += 1
        continue
      }
      if (marker === '-') {
        hunk.lines.push({ type: '-', text: rawLine.slice(1), newLine: null, oldLine })
        oldLine += 1
        oldRemaining = Math.max(0, oldRemaining - 1)
        current.deletions += 1
        continue
      }
      hunk = null
    }

    if (rawLine.startsWith('diff --git ')) {
      const parsed = parseGitHeader(rawLine)
      startFile()
      current.oldPath = parsed.oldPath === '' ? null : parsed.oldPath
      current.newPath = parsed.newPath === '' ? null : parsed.newPath
      continue
    }

    if (rawLine.startsWith('--- ')) {
      if (current === null || current.hunks.length > 0) startFile()
      current.oldPath = parseFileHeaderPath(rawLine.slice(4))
      continue
    }

    if (rawLine.startsWith('+++ ')) {
      if (current === null) startFile()
      current.newPath = parseFileHeaderPath(rawLine.slice(4))
      continue
    }

    if (rawLine.startsWith('@@')) {
      if (current === null) startFile()
      const ranges = parseHunkHeader(rawLine)
      if (ranges === null) continue
      hunk = { header: rawLine.trim(), lines: [] }
      current.hunks.push(hunk)
      oldLine = ranges.oldStart
      newLine = ranges.newStart
      oldRemaining = ranges.oldCount
      newRemaining = ranges.newCount
    }
  }

  const parsedFiles = []
  for (const file of files) {
    if (file.oldPath === null && file.newPath === null) continue
    file.newFile = file.oldPath === null && file.newPath !== null
    file.deletedFile = file.newPath === null && file.oldPath !== null
    file.generated = isGeneratedPath(file.newPath ?? file.oldPath)
    file.tooLarge = file.additions + file.deletions > TOO_LARGE_LINES
    parsedFiles.push(file)
  }
  return parsedFiles
}

/**
 * Build a `path:line` lookup over every diff line.
 *
 * Added lines and context lines are indexed on the new side; removed lines on
 * the old side. `kind` is `'added' | 'removed' | 'context'`.
 * @param {object[]} files parsed diff files.
 * @returns {Map<string, { path: string, line: number, text: string, kind: string }>} index.
 */
export function buildDiffIndex(files) {
  const index = new Map()
  const list = Array.isArray(files) ? files : []
  for (const file of list) {
    if (file === null || typeof file !== 'object') continue
    for (const hunk of Array.isArray(file.hunks) ? file.hunks : []) {
      for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
        if (line.type === '+') {
          if (file.newPath && typeof line.newLine === 'number') {
            index.set(`${file.newPath}:${line.newLine}`, {
              path: file.newPath,
              line: line.newLine,
              text: line.text,
              kind: 'added',
            })
          }
          continue
        }
        if (line.type === '-') {
          if (file.oldPath && typeof line.oldLine === 'number') {
            index.set(`${file.oldPath}:${line.oldLine}`, {
              path: file.oldPath,
              line: line.oldLine,
              text: line.text,
              kind: 'removed',
            })
          }
          continue
        }
        if (file.newPath && typeof line.newLine === 'number') {
          index.set(`${file.newPath}:${line.newLine}`, {
            path: file.newPath,
            line: line.newLine,
            text: line.text,
            kind: 'context',
          })
        }
        if (file.oldPath && file.oldPath !== file.newPath && typeof line.oldLine === 'number') {
          index.set(`${file.oldPath}:${line.oldLine}`, {
            path: file.oldPath,
            line: line.oldLine,
            text: line.text,
            kind: 'context',
          })
        }
      }
    }
  }
  return index
}

/**
 * Character size of one parsed file, used for segment budgeting.
 * @param {object} file parsed diff file.
 * @returns {number} approximate characters.
 */
function diffFileChars(file) {
  let chars = 0
  for (const hunk of Array.isArray(file?.hunks) ? file.hunks : []) {
    chars += String(hunk.header ?? '').length + 1
    for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) {
      chars += String(line.text ?? '').length + 1
    }
  }
  return chars
}

/**
 * Priority order for segment packing: core > config > tests > generated.
 * @param {string} reason classification.
 * @returns {number} sort rank.
 */
function priorityRank(reason) {
  if (reason === 'core') return 0
  if (reason === 'config') return 1
  if (reason === 'tests') return 2
  return 3
}

/**
 * Classify one file for packing.
 * @param {object} file parsed diff file.
 * @returns {'core' | 'config' | 'tests' | 'generated'} reason.
 */
function classifyFile(file) {
  const filePath = file.newPath || file.oldPath || ''
  if (file.generated === true || isGeneratedPath(filePath)) return 'generated'
  if (isTestPath(filePath)) return 'tests'
  if (isConfigPath(filePath)) return 'config'
  return 'core'
}

/**
 * Normalize the character budget.
 * @param {unknown} value raw option.
 * @returns {number} positive budget.
 */
function normalizeLimit(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_SEGMENT_CHARS
  return Math.floor(number)
}

/**
 * Normalize the segment cap.
 * @param {unknown} value raw option.
 * @returns {number} positive segment count.
 */
function normalizeMaxSegments(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) return DEFAULT_MAX_SEGMENTS
  return number
}

/**
 * Plan review segments and honest coverage lists.
 *
 * Packing is deterministic: files are sorted by priority (core, config, tests,
 * generated) and original order, then greedily packed up to `maxChars`. A file
 * larger than the budget gets its own segment marked `oversized` (it is listed
 * under `coverage.oversized`, never under `covered`). Files that no longer fit
 * within `maxSegments` are `skipped`, so the three lists partition the diff.
 * @param {object[]} files parsed diff files.
 * @param {{ maxChars?: number, maxSegments?: number }} [options] budget.
 * @returns {{ segments: object[], coverage: { covered: string[], skipped: string[], oversized: string[] } }} plan.
 */
export function planSegments(files, options = {}) {
  const limit = normalizeLimit(options.maxChars)
  const maxSegments = normalizeMaxSegments(options.maxSegments)
  const list = Array.isArray(files) ? files : []

  const entries = []
  list.forEach((file, index) => {
    if (file === null || typeof file !== 'object') return
    const filePath = file.newPath || file.oldPath
    if (typeof filePath !== 'string' || filePath === '') return
    entries.push({
      path: filePath,
      chars: diffFileChars(file),
      reason: classifyFile(file),
      index,
    })
  })
  entries.sort((left, right) => priorityRank(left.reason) - priorityRank(right.reason) || left.index - right.index)

  const segments = []
  const skipped = []
  let sequence = 0
  let current = null

  /**
   * Flush the open segment into `segments`.
   * @returns {void}
   */
  const flush = () => {
    if (current !== null && current.files.length > 0) segments.push(current)
    current = null
  }

  /**
   * Open a fresh segment.
   * @param {{ path: string, chars: number, reason: string }} entry first file.
   * @returns {object} open segment.
   */
  const open = (entry) => {
    sequence += 1
    return {
      id: `seg-${sequence}`,
      files: [entry.path],
      chars: entry.chars,
      reason: entry.reason,
      oversized: false,
    }
  }

  for (const entry of entries) {
    if (entry.chars > limit) {
      flush()
      if (segments.length >= maxSegments) {
        skipped.push(entry.path)
        continue
      }
      sequence += 1
      segments.push({
        id: `seg-${sequence}`,
        files: [entry.path],
        chars: entry.chars,
        reason: entry.reason,
        oversized: true,
      })
      continue
    }

    if (current === null) {
      if (segments.length >= maxSegments) {
        skipped.push(entry.path)
        continue
      }
      current = open(entry)
      continue
    }

    if (current.chars + entry.chars > limit) {
      flush()
      if (segments.length >= maxSegments) {
        skipped.push(entry.path)
        continue
      }
      current = open(entry)
      continue
    }

    current.files.push(entry.path)
    current.chars += entry.chars
  }
  flush()

  const covered = []
  const oversized = []
  for (const segment of segments) {
    if (segment.oversized) oversized.push(...segment.files)
    else covered.push(...segment.files)
  }
  const coveredSet = new Set(covered)
  const oversizedSet = new Set(oversized)
  const skippedPaths = entries
    .map((entry) => entry.path)
    .filter((filePath) => !coveredSet.has(filePath) && !oversizedSet.has(filePath))

  return {
    segments,
    coverage: { covered, skipped: skippedPaths, oversized },
  }
}

/** Sequence for fallback context directories. */
let contextSequence = 0

/**
 * Sanitize a turn id into a single safe path segment.
 * @param {unknown} value candidate.
 * @returns {string} safe segment.
 */
function sanitizeTurnId(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const safe = text
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 64)
  if (safe !== '') return safe
  contextSequence += 1
  return `t-${Date.now().toString(36)}-${contextSequence}`
}

/**
 * Serialize without throwing on unexpected values.
 * @param {unknown} value data.
 * @returns {string} JSON text.
 */
function safeJson(value) {
  try {
    const text = JSON.stringify(value, null, 2)
    return typeof text === 'string' ? text : 'null'
  } catch {
    return 'null'
  }
}

/**
 * Write context files for one turn.
 *
 * Files live under `os.tmpdir()/daily-work-hub/turns/<turnId>/` and contain only
 * data (`mr.json`, `diff.patch`, `discussions.json`, `conventions.md`). The
 * prompt references these paths, so discussion/description text never enters the
 * prompt body.
 * @param {object} item work item (used for fallback metadata and the turn key).
 * @param {object} payload collected review payload (`mr`, `diff`, `discussions`, `conventions`, `files`, `approvals`, `ci`).
 * @returns {{ dir: string, files: { mr: string, diff: string, discussions: string, conventions: string }, turnId: string }} context.
 */
export function buildContextFiles(item, payload) {
  const source = payload !== null && typeof payload === 'object' ? payload : {}
  const turnId = sanitizeTurnId(source.turnId)
  const dir = path.join(os.tmpdir(), 'daily-work-hub', 'turns', turnId)
  fs.mkdirSync(dir, { recursive: true })

  const mr = source.mr !== null && typeof source.mr === 'object' ? source.mr : {}
  const parsedFiles = Array.isArray(source.files) ? source.files : []
  const mrData = {
    key: item?.key ?? null,
    project: mr.project ?? item?.project ?? null,
    iid: mr.iid ?? item?.iid ?? null,
    title: mr.title ?? item?.title ?? null,
    description: mr.description ?? mr.body ?? null,
    author: mr.author ?? item?.author ?? null,
    link: mr.web_url ?? mr.link ?? item?.link ?? null,
    headSha: mr.headSha ?? mr.sha ?? item?.headSha ?? null,
    baseSha: mr.baseSha ?? item?.baseSha ?? null,
    draft: typeof mr.draft === 'boolean' ? mr.draft : (typeof item?.draft === 'boolean' ? item.draft : null),
    labels: Array.isArray(mr.labels) ? mr.labels : (Array.isArray(item?.labels) ? item.labels : []),
    approvals: source.approvals ?? item?.approvals ?? null,
    ci: source.ci ?? item?.ci ?? null,
    pipelines: source.pipelines ?? null,
    changedFiles: parsedFiles.map((file) => ({
      path: file.newPath || file.oldPath || '',
      additions: Number(file.additions) || 0,
      deletions: Number(file.deletions) || 0,
      generated: file.generated === true,
      newFile: file.newFile === true,
      deletedFile: file.deletedFile === true,
    })),
  }

  const files = {
    mr: path.join(dir, 'mr.json'),
    diff: path.join(dir, 'diff.patch'),
    discussions: path.join(dir, 'discussions.json'),
    conventions: path.join(dir, 'conventions.md'),
  }
  fs.writeFileSync(files.mr, safeJson(mrData), 'utf8')
  fs.writeFileSync(files.diff, typeof source.diff === 'string' ? source.diff : '', 'utf8')
  fs.writeFileSync(
    files.discussions,
    safeJson({ discussions: source.discussions ?? [] }),
    'utf8',
  )
  fs.writeFileSync(
    files.conventions,
    typeof source.conventions === 'string' ? source.conventions : '',
    'utf8',
  )
  return { dir, files, turnId }
}

/**
 * Extract added lines (with new-side line numbers) from one file.
 * @param {object} file parsed diff file.
 * @returns {Array<{ text: string, newLine: number }>} added lines.
 */
function addedLines(file) {
  const lines = []
  for (const hunk of Array.isArray(file?.hunks) ? file.hunks : []) {
    for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) {
      if (line.type === '+' && typeof line.newLine === 'number') {
        lines.push({ text: line.text, newLine: line.newLine })
      }
    }
  }
  return lines
}

/**
 * Append one heuristic finding when the anchor is valid.
 * @param {object[]} target collector.
 * @param {{ severity: string, file: string, line: number, title: string, evidence: string, suggestion: string }} input finding fields.
 * @returns {void}
 */
function pushFinding(target, input) {
  if (typeof input.line !== 'number' || input.line < 1) return
  target.push({
    severity: input.severity,
    file: input.file,
    line: input.line,
    title: input.title,
    evidence: String(input.evidence ?? ''),
    suggestion: input.suggestion,
    adopted: 'pending',
  })
}

/**
 * Lower-case base name without a test marker or extension, for test matching.
 * @param {string} filePath path.
 * @returns {string} stem.
 */
function baseStem(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  return base
    .replace(/\.(test|spec)\.[^.]+$/, '')
    .replace(/_(test|spec)\.(go|py|rb)$/, '')
    .replace(/\.[^.]+$/, '')
}

/**
 * Check whether the extension of a path is a source extension.
 * @param {string} filePath path.
 * @returns {boolean} source file.
 */
function isSourcePath(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  const dot = normalized.lastIndexOf('.')
  if (dot === -1) return false
  return SOURCE_EXTENSIONS.has(normalized.slice(dot))
}

/**
 * Local, deterministic review rules.
 *
 * Conservative on purpose: nothing here raises a `blocker`; style trivia stays
 * `low`. Every finding carries the verbatim diff line as `evidence` and a real
 * new-side line number so {@link validateFindings} accepts it.
 * @param {object[]} files parsed diff files.
 * @param {object} [context] optional review context (unused by the current rules).
 * @returns {object[]} findings.
 */
export function heuristicFindings(files, context = {}) {
  void context
  const findings = []
  const list = Array.isArray(files) ? files : []
  const testStems = new Set()
  for (const file of list) {
    if (file === null || typeof file !== 'object') continue
    const filePath = file.newPath || file.oldPath
    if (typeof filePath === 'string' && isTestPath(filePath)) testStems.add(baseStem(filePath))
  }

  const sources = []
  for (const file of list) {
    if (file === null || typeof file !== 'object') continue
    const filePath = file.newPath || file.oldPath
    if (typeof filePath !== 'string' || filePath === '') continue
    const added = addedLines(file)
    if (added.length === 0) continue

    const test = isTestPath(filePath)
    const generated = file.generated === true || isGeneratedPath(filePath)
    if (!test && !generated && isSourcePath(filePath)) sources.push({ filePath, added })

    for (const line of added) {
      const text = String(line.text ?? '')
      const anchor = { file: filePath, line: line.newLine, evidence: text }

      if (/\b(?:TODO|FIXME|XXX)\b/.test(text)) {
        pushFinding(findings, {
          ...anchor,
          severity: 'low',
          title: '新增 TODO/FIXME 标记',
          suggestion: '在合并前处理该标记，或改成带负责人和工单号的说明。',
        })
      }

      if (/\bconsole\.(?:log|debug|info)\s*\(/.test(text)) {
        pushFinding(findings, {
          ...anchor,
          severity: 'low',
          title: '残留 console 调试输出',
          suggestion: '删除调试输出，或改用项目的日志组件。',
        })
      }

      if (/\bdebugger\b/.test(text)) {
        pushFinding(findings, {
          ...anchor,
          severity: 'medium',
          title: '新增 debugger 语句',
          suggestion: '删除 debugger；调试信息用条件断点或日志替代。',
        })
      }

      if (/\beval\s*\(/.test(text)) {
        pushFinding(findings, {
          ...anchor,
          severity: 'high',
          title: '使用 eval 执行动态代码',
          suggestion: '避免 eval；改用显式解析或白名单映射。',
        })
      }

      if (/\b(?:inner|outer)HTML\s*=/.test(text)) {
        pushFinding(findings, {
          ...anchor,
          severity: 'medium',
          title: '直接赋值 innerHTML',
          suggestion: '改用 textContent 或经过消毒的 DOM 构建，避免 XSS。',
        })
      }

      if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
        pushFinding(findings, {
          ...anchor,
          severity: 'high',
          title: '疑似硬编码密钥',
          suggestion: '移出代码，改用凭据服务或环境变量，并轮换已泄露的值。',
        })
      }

      if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(text)) {
        pushFinding(findings, {
          ...anchor,
          severity: 'medium',
          title: 'catch 块静默吞掉异常',
          suggestion: '至少记录错误；能处理时给出降级行为。',
        })
      }

      if (test && /\b(?:describe|it|test)\.only\s*\(/.test(text)) {
        pushFinding(findings, {
          ...anchor,
          severity: 'medium',
          title: '测试残留 .only 焦点',
          suggestion: '删除 .only，避免 CI 只跑一个用例。',
        })
      }

      const extension = filePath.toLowerCase()
      if ((extension.endsWith('.ts') || extension.endsWith('.tsx') || extension.endsWith('.mts') || extension.endsWith('.cts'))
        && /(?::\s*any\b|\bas\s+any\b|<any>|\bany\[\])/.test(text)) {
        pushFinding(findings, {
          ...anchor,
          severity: 'low',
          title: '使用 any 削弱类型检查',
          suggestion: '改用具体类型、泛型或 unknown 加收窄。',
        })
      }
    }

    if (file.additions + file.deletions >= 800) {
      pushFinding(findings, {
        file: filePath,
        line: added[0].newLine,
        evidence: added[0].text,
        severity: 'low',
        title: '单文件改动量过大',
        suggestion: '拆分改动或补充说明，降低审查遗漏风险。',
      })
    }

    for (const hunk of Array.isArray(file.hunks) ? file.hunks : []) {
      let runStart = null
      let runLength = 0
      for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) {
        if (line.type === '+') {
          if (runStart !== null && line.newLine === runStart.line + runLength) {
            runLength += 1
          } else {
            runStart = { line: line.newLine, text: line.text }
            runLength = 1
          }
          if (runLength === 120 && runStart !== null) {
            pushFinding(findings, {
              file: filePath,
              line: runStart.line,
              evidence: runStart.text,
              severity: 'medium',
              title: '新增代码块过长',
              suggestion: '拆分为更小的函数或模块，便于审查与测试。',
            })
          }
        } else {
          runStart = null
          runLength = 0
        }
      }
    }
  }

  for (const source of sources) {
    if (testStems.has(baseStem(source.filePath))) continue
    const first = source.added[0]
    pushFinding(findings, {
      file: source.filePath,
      line: first.newLine,
      evidence: first.text,
      severity: 'low',
      title: '缺少对应测试改动',
      suggestion: '补充或更新覆盖该改动的测试；若无需测试请说明理由。',
    })
  }

  return findings
}

/**
 * Validate model findings against the diff (docs/CONTRACTS.md §6).
 *
 * Four checks:
 * 1. `file` must exist in the diff.
 * 2. `line` must be an actual `file:line` from the diff.
 * 3. `evidence` must appear verbatim in that file's added/removed/context text.
 * 4. `verdict` must be consistent with the findings (a blocker forbids
 *    `approve-suggested`).
 *
 * Invalid findings are dropped and described in `errors`; `ok` is true only
 * when nothing was dropped and no verdict conflict was found.
 * @param {object[]} findings candidate findings.
 * @param {Map<string, { path: string, line: number, text: string }>} diffIndex from {@link buildDiffIndex}.
 * @param {{ verdict?: string }} [options] model verdict, when available.
 * @returns {{ ok: boolean, findings: object[], errors: object[] }} validation result.
 */
export function validateFindings(findings, diffIndex, options = {}) {
  const list = Array.isArray(findings) ? findings : []
  const index = diffIndex instanceof Map ? diffIndex : new Map()
  const pathText = new Map()
  for (const entry of index.values()) {
    const previous = pathText.get(entry.path)
    pathText.set(entry.path, previous === undefined ? entry.text : `${previous}\n${entry.text}`)
  }

  const valid = []
  const errors = []

  for (const finding of list) {
    if (finding === null || typeof finding !== 'object') {
      errors.push({ code: 'malformed-finding', message: 'finding 不是对象', finding })
      continue
    }
    const file = typeof finding.file === 'string' ? finding.file.trim() : ''
    if (file === '') {
      errors.push({ code: 'missing-path', message: 'finding.file 缺失', finding })
      continue
    }
    if (!pathText.has(file)) {
      errors.push({ code: 'unknown-path', message: `路径不在 diff 中：${file}`, finding })
      continue
    }
    const line = parseLineNumber(finding.line)
    if (line === null) {
      errors.push({ code: 'bad-line', message: `行号无效：${String(finding.line)}`, finding })
      continue
    }
    if (!index.has(`${file}:${line}`)) {
      errors.push({ code: 'line-outside-diff', message: `行不在 diff 中：${file}:${line}`, finding })
      continue
    }
    const evidence = typeof finding.evidence === 'string' ? finding.evidence : ''
    if (evidence.trim() === '') {
      errors.push({ code: 'missing-evidence', message: 'finding.evidence 缺失', finding })
      continue
    }
    if (!pathText.get(file).includes(evidence.trim())) {
      errors.push({
        code: 'evidence-not-found',
        message: `evidence 无法在 ${file} 的 diff 文本中逐字找到`,
        finding,
      })
      continue
    }
    valid.push({
      ...finding,
      file,
      line,
      evidence,
      severity: SEVERITIES.includes(finding.severity) ? finding.severity : 'medium',
      adopted: finding.adopted ?? 'pending',
    })
  }

  const verdict = options?.verdict
  if (typeof verdict === 'string') {
    if (!VERDICTS.includes(verdict)) {
      errors.push({ code: 'bad-verdict', message: `不支持的结论：${verdict}` })
    } else if (verdict === 'approve-suggested' && valid.some((finding) => finding.severity === 'blocker')) {
      errors.push({
        code: 'verdict-mismatch',
        message: '存在 blocker 时不能给出 approve-suggested',
      })
    }
  }

  return { ok: errors.length === 0, findings: valid, errors }
}

/**
 * Stable identity of a finding for dedupe and suppression.
 * @param {object} finding finding.
 * @returns {string} `path:line:title`.
 */
function findingKey(finding) {
  const title = String(finding?.title ?? '').trim().replace(/\s+/g, ' ')
  return `${String(finding?.file ?? '')}:${String(finding?.line ?? '')}:${title}`
}

/**
 * Collect suppression ids from previous findings or an explicit id collection.
 * @param {unknown} previous previous findings (objects with `adopted`) or ids.
 * @returns {Set<string>} ignored ids.
 */
function collectIgnoredIds(previous) {
  const ignored = new Set()
  if (previous === undefined || previous === null) return ignored
  if (previous instanceof Set) {
    for (const item of previous) if (typeof item === 'string') ignored.add(item)
    return ignored
  }
  const items = Array.isArray(previous) ? previous : [previous]
  for (const item of items) {
    if (typeof item === 'string') {
      ignored.add(item)
      continue
    }
    if (item !== null && typeof item === 'object' && item.adopted === 'ignored') {
      ignored.add(findingKey(item))
    }
  }
  return ignored
}

/**
 * Deduplicate, suppress and order findings.
 *
 * Dedupe key is `path:line:title` (title whitespace-normalized). Findings whose
 * id appears in `previousFindings` with `adopted: 'ignored'` (or that appear as
 * raw ids in a Set) are suppressed entirely. Output is ordered by severity, then
 * file, then line.
 * @param {object[]} findings fresh findings.
 * @param {object[] | Set<string>} [previousFindings] previous findings or ignored ids.
 * @returns {object[]} aggregated findings.
 */
export function aggregate(findings, previousFindings = []) {
  const ignored = collectIgnoredIds(previousFindings)
  const byKey = new Map()
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (finding === null || typeof finding !== 'object') continue
    // Canonical title: trailing/duplicated whitespace must not create a second row.
    const canonical =
      typeof finding.title === 'string'
        ? { ...finding, title: finding.title.trim().replace(/\s+/g, ' ') }
        : finding
    const key = findingKey(canonical)
    if (ignored.has(key)) continue
    const existing = byKey.get(key)
    if (existing === undefined || severityRank(canonical.severity) < severityRank(existing.severity)) {
      byKey.set(key, canonical)
    }
  }
  return [...byKey.values()].sort((left, right) => {
    const bySeverity = severityRank(left.severity) - severityRank(right.severity)
    if (bySeverity !== 0) return bySeverity
    const byFile = String(left.file).localeCompare(String(right.file))
    if (byFile !== 0) return byFile
    return Number(left.line ?? 0) - Number(right.line ?? 0)
  })
}

/**
 * Deterministic verdict for a finding set.
 *
 * `request-changes-suggested` for any blocker or two or more highs;
 * `comments-only` for any high/medium; otherwise `approve-suggested`.
 * @param {object[]} findings findings.
 * @returns {string} verdict.
 */
export function verdictFor(findings) {
  const list = Array.isArray(findings) ? findings : []
  if (list.some((finding) => finding.severity === 'blocker')) return 'request-changes-suggested'
  if (list.filter((finding) => finding.severity === 'high').length >= 2) return 'request-changes-suggested'
  if (list.some((finding) => finding.severity === 'medium' || finding.severity === 'high')) {
    return 'comments-only'
  }
  return 'approve-suggested'
}

/**
 * Parse the first JSON object out of `text`.
 * @param {string} text candidate text.
 * @returns {object | undefined} parsed object.
 */
function parseJsonObject(text) {
  if (typeof text !== 'string') return undefined
  const source = text.trim()
  if (source === '') return undefined
  const direct = tryParseObject(source)
  if (direct !== undefined) return direct
  const start = source.indexOf('{')
  if (start === -1) return undefined
  const end = balancedObjectEnd(source, start)
  if (end === -1) return undefined
  return tryParseObject(source.slice(start, end + 1))
}

/**
 * JSON.parse an object, swallowing failures.
 * @param {string} source JSON text.
 * @returns {object | undefined} parsed object.
 */
function tryParseObject(source) {
  try {
    const value = JSON.parse(source)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Find the closing brace of the object starting at `start`, string-aware.
 * @param {string} source text.
 * @param {number} start index of `{`.
 * @returns {number} index of the matching `}`, or -1.
 */
function balancedObjectEnd(source, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Extract a `ReviewResult` object from model text.
 *
 * Accepts a bare JSON object, a ```json fenced block, or a
 * `<review-result>...</review-result>` block. Returns undefined on failure.
 * @param {unknown} text model output.
 * @returns {object | undefined} parsed review result.
 */
export function resultFromText(text) {
  if (typeof text !== 'string') return undefined
  const candidates = []

  const tagged = /<review-result>([\s\S]*?)<\/review-result>/gi
  let match = tagged.exec(text)
  while (match !== null) {
    candidates.push(match[1])
    match = tagged.exec(text)
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi
  match = fenced.exec(text)
  while (match !== null) {
    candidates.push(match[1])
    match = fenced.exec(text)
  }

  candidates.push(text)
  for (const candidate of candidates) {
    const parsed = parseJsonObject(candidate)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/**
 * Normalize a verdict string (lenient about the research-doc spelling).
 * @param {unknown} value candidate.
 * @returns {string} one of {@link VERDICTS}.
 */
function normalizeVerdict(value) {
  if (value === 'approve' || value === 'approve-suggested') return 'approve-suggested'
  if (value === 'request_changes' || value === 'request-changes' || value === 'request-changes-suggested') {
    return 'request-changes-suggested'
  }
  return 'comments-only'
}

/**
 * Normalize one model finding to the internal Finding shape.
 * @param {object} finding raw model finding.
 * @returns {object} normalized finding.
 */
function normalizeModelFinding(finding) {
  return {
    severity: SEVERITIES.includes(finding.severity) ? finding.severity : 'medium',
    file: typeof finding.file === 'string' ? finding.file.trim() : '',
    line: finding.line,
    title: typeof finding.title === 'string' ? finding.title.trim() : '',
    evidence: typeof finding.evidence === 'string' ? finding.evidence : '',
    suggestion: typeof finding.suggestion === 'string' ? finding.suggestion : '',
    adopted: 'pending',
  }
}

/**
 * True when `value` looks like a review result.
 * @param {unknown} value candidate.
 * @returns {boolean} whether it has a verdict and a findings array.
 */
function isReviewResult(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.verdict === 'string'
    && Array.isArray(value.findings)
}

/**
 * Normalize one runner response.
 * @param {unknown} raw runner value.
 * @returns {{ structured?: object, text?: string, sessionId?: string, usage?: object }} view.
 */
function viewRunnerOutput(raw) {
  if (typeof raw === 'string') return { text: raw }
  if (raw === null || typeof raw !== 'object') return {}
  const structured = raw.structured !== null && typeof raw.structured === 'object' ? raw.structured : undefined
  let text
  if (typeof raw.text === 'string') text = raw.text
  else if (typeof raw.output === 'string') text = raw.output
  else if (typeof raw.content === 'string') text = raw.content
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : undefined
  return { structured, text, sessionId, usage: raw.usage }
}

/**
 * Normalize a usage report.
 * @param {unknown} usage raw usage.
 * @returns {{ input: number, output: number }} counters.
 */
function normalizeUsage(usage) {
  const value = usage !== null && typeof usage === 'object' ? usage : {}
  const input = Number(value.input ?? value.inputTokens ?? 0)
  const output = Number(value.output ?? value.outputTokens ?? 0)
  return {
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
  }
}

/**
 * Turn an error into a short message.
 * @param {unknown} error thrown value.
 * @returns {string} message.
 */
function errorMessage(error) {
  if (error instanceof Error && typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * Normalize a model result into the pipeline shape.
 * @param {object} value raw parsed result.
 * @returns {{ verdict: string, summary: string, findings: object[] }} normalized.
 */
function normalizeModelResult(value) {
  return {
    verdict: normalizeVerdict(value.verdict),
    summary: typeof value.summary === 'string' ? value.summary : '',
    findings: Array.isArray(value.findings)
      ? value.findings.filter((finding) => finding !== null && typeof finding === 'object')
      : [],
  }
}

/**
 * Read `conventions` text out of the payload.
 * @param {object} payload collected payload.
 * @returns {string} conventions markdown.
 */
function conventionsOf(payload) {
  if (typeof payload?.conventions === 'string') return payload.conventions
  if (typeof payload?.conventionsText === 'string') return payload.conventionsText
  return ''
}

/**
 * Extract diff text from whatever the GitLab client returned.
 * @param {unknown} value string, array of file diffs, or object with diff/raw/text.
 * @returns {string} unified diff text.
 */
function diffTextOf(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item
        if (item === null || typeof item !== 'object') return ''
        const body = typeof item.diff === 'string' ? item.diff : typeof item.patch === 'string' ? item.patch : ''
        if (body === '') return ''
        // GitLab `/diffs` returns each file's hunks WITHOUT `diff --git` / `---`
        // / `+++` headers. Without them the unified-diff parser cannot attribute
        // hunks to a path and drops every file, so synthesize the headers here.
        if (/^diff --git /m.test(body) || /^--- /m.test(body)) return body
        const oldPath = typeof item.old_path === 'string' && item.old_path !== '' ? item.old_path : item.new_path
        const newPath = typeof item.new_path === 'string' && item.new_path !== '' ? item.new_path : item.old_path
        if (typeof oldPath !== 'string' || typeof newPath !== 'string') return body
        const oldHeader = item.new_file === true ? '--- /dev/null' : `--- a/${oldPath}`
        const newHeader = item.deleted_file === true ? '+++ /dev/null' : `+++ b/${newPath}`
        return [`diff --git a/${oldPath} b/${newPath}`, oldHeader, newHeader, body].join('\n')
      })
      .filter((item) => item !== '')
      .join('\n')
  }
  if (value !== null && typeof value === 'object') {
    if (typeof value.diff === 'string') return value.diff
    if (typeof value.raw === 'string') return value.raw
    if (typeof value.text === 'string') return value.text
    if (typeof value.patch === 'string') return value.patch
  }
  return ''
}

/**
 * Remove control characters from a diff path before it enters a prompt.
 * @param {string} value path.
 * @returns {string} sanitized path.
 */
function sanitizePromptPath(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
}

/**
 * Build one segment prompt: shared template body + explicit segment file list.
 * @param {object} template template record.
 * @param {Record<string, string>} contextFiles context file paths.
 * @param {{ files: string[] }} segment segment plan.
 * @param {number} index zero-based index.
 * @param {number} total segment count.
 * @returns {string} prompt text.
 */
function segmentPrompt(template, contextFiles, segment, index, total) {
  const rendered = renderPrompt(template, { files: contextFiles })
  const base = typeof rendered === 'string' ? rendered : (rendered?.text ?? '')
  const lines = [base, '']
  if (contextFiles !== null && typeof contextFiles === 'object') {
    const named = ['mr', 'diff', 'discussions', 'conventions'].filter(
      (name) => typeof contextFiles[name] === 'string' && contextFiles[name] !== '',
    )
    if (named.length > 0) {
      lines.push('# 资料文件（只读；正文在这些文件里，不内联进提示词）')
      for (const name of named) lines.push(`- ${name}: ${sanitizePromptPath(contextFiles[name])}`)
      lines.push('')
    }
  }
  lines.push('# 本段文件')
  for (const filePath of segment.files) lines.push(`- ${sanitizePromptPath(filePath)}`)
  lines.push('')
  lines.push('# 分段信息')
  lines.push(`第 ${index + 1}/${total} 段，共 ${segment.files.length} 个文件。只审本段文件，不要臆测未提供的文件。`)
  return lines.join('\n')
}

/**
 * Clamp the concurrency option.
 * @param {unknown} value raw value.
 * @returns {number} 1..{@link MAX_CONCURRENCY}.
 */
function clampConcurrency(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 3
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(number)))
}

/**
 * Conservative combination of the computed and model verdicts.
 * @param {string} computed verdict from {@link verdictFor}.
 * @param {string | undefined} model verdict reported by the model.
 * @returns {string} the more conservative verdict.
 */
function pickVerdict(computed, model) {
  if (typeof model !== 'string' || VERDICT_ORDER[model] === undefined) return computed
  return VERDICT_ORDER[model] > VERDICT_ORDER[computed] ? model : computed
}

/**
 * Create the review pipeline.
 *
 * Dependencies are injected and optional: `store` (turns/items persistence),
 * `gitlab` (duck-typed `getMergeRequest/getDiffs/getDiscussions/getApprovals/
 * getPipelines`), `templates` (array or a `list`/`get` store), `ctx`, `logger`
 * and `config`. `review()` never throws because of a model failure.
 * @param {{ store?: object, gitlab?: object, templates?: object, ctx?: object, logger?: object, config?: object }} deps dependencies.
 * @returns {object} reviewer API.
 */
export function createReviewer(deps = {}) {
  const store = deps.store
  const gitlab = deps.gitlab
  const templates = deps.templates
  const logger = deps.logger
  const config = deps.config !== null && typeof deps.config === 'object' ? deps.config : {}
  let sequence = 0

  /**
   * Wrap a log call; logging must never break the pipeline.
   * @param {'info'|'warn'} level log level.
   * @param {string} message text.
   * @returns {void}
   */
  const log = (level, message) => {
    try {
      const fn = logger?.[level]
      if (typeof fn === 'function') fn.call(logger, `[daily-work-hub] ${message}`)
    } catch {
      // logging is best effort
    }
  }

  /**
   * Load candidate templates.
   * @returns {Promise<object[]>} templates.
   */
  const loadTemplateList = async () => {
    if (Array.isArray(templates)) return templates
    if (templates !== null && typeof templates === 'object' && typeof templates.list === 'function') {
      const rows = await templates.list()
      if (Array.isArray(rows)) return rows
    }
    return SEED_TEMPLATES
  }

  /**
   * Resolve the template for one review.
   * @param {object} item work item.
   * @param {{ templateId?: string }} options review options.
   * @param {string[]} paths changed paths.
   * @returns {Promise<object | undefined>} template.
   */
  const resolveTemplate = async (item, options, paths) => {
    let list = []
    try {
      list = await loadTemplateList()
    } catch (error) {
      log('warn', `读取模板失败：${errorMessage(error)}`)
      list = []
    }

    if (typeof options?.templateId === 'string' && options.templateId !== '') {
      const direct = list.find((template) => template && template.id === options.templateId)
      if (direct !== undefined) return direct
      if (templates !== null && typeof templates === 'object' && typeof templates.get === 'function') {
        try {
          const found = await templates.get(options.templateId)
          if (found !== undefined) return found
        } catch (error) {
          log('warn', `读取模板 ${options.templateId} 失败：${errorMessage(error)}`)
        }
      }
    }

    if (list.length === 0) {
      return SEED_TEMPLATES.find((template) => template.id === 'tpl-review-default')
    }
    return matchTemplate(list, { project: item?.project, paths }) ?? SEED_TEMPLATES[0]
  }

  /**
   * Fetch the five payload endpoints from the GitLab client.
   * @param {object} item work item.
   * @returns {Promise<object>} payload.
   */
  const fetchPayload = async (item) => {
    const project = item?.project
    const iid = item?.iid
    const call = (name, args) => {
      const fn = gitlab?.[name]
      if (typeof fn !== 'function') return Promise.resolve(undefined)
      return Promise.resolve().then(() => fn.apply(gitlab, args))
    }
    const results = await Promise.all([
      call('getMergeRequest', [project, iid]),
      call('getDiffs', [project, iid]),
      call('getDiscussions', [project, iid]),
      call('getApprovals', [project, iid]),
      call('getPipelines', [project, iid]),
    ])
    const [mr, diffs, discussions, approvals, pipelines] = results
    return {
      mr: mr !== null && typeof mr === 'object' ? mr : undefined,
      diff: diffTextOf(diffs),
      discussions: discussions ?? [],
      approvals,
      pipelines,
      ci: mr !== null && typeof mr === 'object' ? (mr.ci ?? mr.pipeline ?? null) : null,
    }
  }

  /**
   * Try one model channel and return a normalized result.
   * @param {'subagent'|'session'} mode channel name.
   * @param {() => unknown} invoke channel call.
   * @param {string[]} failures failure collector.
   * @param {string | undefined} sessionId session id for session mode.
   * @returns {Promise<object | undefined>} hit.
   */
  const attemptChannel = async (mode, invoke, failures, sessionId) => {
    try {
      const raw = await invoke()
      const view = viewRunnerOutput(raw)
      if (view.structured !== undefined && isReviewResult(view.structured)) {
        return {
          mode,
          result: normalizeModelResult(view.structured),
          sessionId: view.sessionId ?? (mode === 'session' ? sessionId : undefined),
          usage: normalizeUsage(view.usage),
        }
      }
      if (typeof view.text === 'string' && view.text.trim() !== '') {
        const parsed = resultFromText(view.text)
        if (parsed !== undefined && isReviewResult(parsed)) {
          return {
            mode,
            result: normalizeModelResult(parsed),
            sessionId: view.sessionId ?? (mode === 'session' ? sessionId : undefined),
            usage: normalizeUsage(view.usage),
          }
        }
        failures.push(`${mode}: 输出不是合法 ReviewResult JSON`)
        return undefined
      }
      if (view.structured !== undefined) {
        failures.push(`${mode}: structured 输出缺少 verdict/findings`)
      } else {
        failures.push(`${mode}: 没有返回内容`)
      }
      return undefined
    } catch (error) {
      failures.push(`${mode}: ${errorMessage(error)}`)
      return undefined
    }
  }

  /**
   * Run one prompt through the best available model channel.
   *
   * Order: `runner.subagent({ prompt, outputSchema })`, then
   * `runner.session({ prompt, sessionId })`, then a heuristic fallback result
   * that explicitly says no semantic review happened. Never throws.
   * @param {{ prompt?: string, schema?: object, runner?: object, sessionId?: string }} request model request.
   * @returns {Promise<object>} `{ mode, result?, note, sessionId?, usage? }`.
   */
  const runModel = async (request = {}) => {
    const prompt = typeof request.prompt === 'string' ? request.prompt : ''
    const schema = request.schema ?? REVIEW_RESULT_SCHEMA
    const runner = request.runner
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : undefined
    const failures = []

    if (runner !== null && typeof runner === 'object' && typeof runner.subagent === 'function') {
      const hit = await attemptChannel(
        'subagent',
        () => runner.subagent({ prompt, outputSchema: schema }),
        failures,
        undefined,
      )
      if (hit !== undefined) return hit
    }

    if (runner !== null && typeof runner === 'object' && typeof runner.session === 'function') {
      const hit = await attemptChannel(
        'session',
        () => runner.session({ prompt, sessionId }),
        failures,
        sessionId,
      )
      if (hit !== undefined) return hit
    }

    const detail = failures.length > 0 ? `（${failures.join('；')}）` : ''
    return {
      mode: 'heuristic',
      note: `本轮未做语义审查：模型不可用或输出无效${detail}，以下仅为本地启发式规则结果。`,
      failures,
    }
  }

  /**
   * Run all planned segments with bounded concurrency.
   * @param {{ segments: object[] }} plan segment plan.
   * @param {object} template template.
   * @param {object} context context files result.
   * @param {object} runner model runner.
   * @param {number} concurrency parallel limit.
   * @param {string} sessionId session id for the session channel.
   * @returns {Promise<object[]>} per-segment outcomes.
   */
  const runSegments = async (plan, template, context, runner, concurrency, sessionId) => {
    const total = plan.segments.length
    const outcomes = new Array(total)
    let cursor = 0

    const worker = async () => {
      while (cursor < total) {
        const index = cursor
        cursor += 1
        const segment = plan.segments[index]
        try {
          const prompt = segmentPrompt(template, context?.files ?? {}, segment, index, total)
          const outcome = await runModel({
            prompt,
            schema: REVIEW_RESULT_SCHEMA,
            runner,
            sessionId,
          })
          if (outcome.mode === 'heuristic') {
            outcomes[index] = { status: 'fallback', mode: 'heuristic', note: outcome.note }
          } else {
            outcomes[index] = {
              status: 'ok',
              mode: outcome.mode,
              result: outcome.result,
              sessionId: outcome.sessionId,
              usage: outcome.usage,
            }
          }
        } catch (error) {
          outcomes[index] = { status: 'fallback', mode: 'heuristic', note: `分段执行失败：${errorMessage(error)}` }
        }
      }
    }

    const workers = Math.min(concurrency, Math.max(total, 1))
    await Promise.all(Array.from({ length: workers }, () => worker()))
    return outcomes
  }

  /**
   * Persist a Turn and write the item back.
   * @param {object} turn completed turn.
   * @param {object} item work item.
   * @returns {Promise<object>} the turn.
   */
  const persistTurn = async (turn, item) => {
    if (store !== null && typeof store === 'object' && store.turns && typeof store.turns.put === 'function') {
      try {
        await store.turns.put(turn)
      } catch (error) {
        log('warn', `Turn 落库失败：${errorMessage(error)}`)
      }
    }
    if (
      item !== null
      && typeof item === 'object'
      && typeof item.key === 'string'
      && store !== null
      && typeof store === 'object'
      && store.items
      && typeof store.items.patch === 'function'
      && turn.state === 'done'
    ) {
      try {
        await store.items.patch(item.key, (current) => {
          if (current === null || typeof current !== 'object') return current
          return {
            ...current,
            lastTurn: {
              id: turn.id,
              verdict: turn.verdict,
              computedForHead: turn.computedForHead,
              finishedAt: turn.finishedAt,
              templateVersion: turn.templateVersion,
            },
            findings: turn.findings.map((finding) => ({ ...finding })),
          }
        })
      } catch (error) {
        log('warn', `item 回写失败：${errorMessage(error)}`)
      }
    }
    return turn
  }

  /**
   * Build a failed turn (no diff or fetch failure).
   * @param {object} input turn fields.
   * @returns {object} turn.
   */
  const failedTurn = (input) => ({
    id: input.id,
    key: input.key,
    state: 'failed',
    mode: 'heuristic',
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    computedForHead: input.computedForHead,
    templateVersion: input.templateVersion,
    sessionId: null,
    verdict: null,
    summary: '',
    findings: [],
    coverage: { covered: [], skipped: [], oversized: [] },
    usage: { input: 0, output: 0 },
    error: input.error,
    note: input.note,
  })

  /**
   * Run one full review and persist the Turn.
   *
   * @param {object} item work item (needs `key`; `project`/`iid`/`headSha`/`findings` are used when present).
   * @param {{ templateId?: string, concurrency?: number, runner?: object, payload?: object, sessionId?: string }} [options] review options; pass `payload` to skip GitLab fetching.
   * @returns {Promise<object>} persisted Turn.
   */
  const review = async (item, options = {}) => {
    const startedAt = new Date().toISOString()
    sequence += 1
    const turnId = `turn-${Date.now().toString(36)}-${sequence}`
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : `dw-${turnId}`

    let payload = options.payload
    let fetchError = null
    if (payload === null || typeof payload !== 'object') {
      try {
        payload = await fetchPayload(item)
      } catch (error) {
        fetchError = error
        payload = {}
      }
    }

    const diffText = diffTextOf(payload?.diffText ?? payload?.diff ?? payload?.patch)
    const files = parseDiff(diffText)
    const head = item?.headSha ?? payload?.headSha ?? payload?.mr?.headSha ?? payload?.mr?.sha ?? null
    const paths = files.map((file) => file.newPath || file.oldPath).filter((value) => typeof value === 'string')
    const template = await resolveTemplate(item, options, paths)
    const notes = []
    if (fetchError !== null) notes.push(`取数失败：${errorMessage(fetchError)}`)

    if (diffText.trim() === '') {
      notes.push('未取到 diff，本轮没有可审查内容。')
      const turn = failedTurn({
        id: turnId,
        key: item?.key ?? null,
        startedAt,
        computedForHead: head,
        templateVersion: template?.version ?? null,
        error: fetchError !== null ? errorMessage(fetchError) : 'empty-diff',
        note: notes.join('；'),
      })
      await persistTurn(turn, item)
      return turn
    }

    let context
    try {
      context = buildContextFiles(item, {
        ...payload,
        turnId,
        files,
        diff: diffText,
        conventions: conventionsOf(payload),
      })
    } catch (error) {
      notes.push(`上下文文件写入失败：${errorMessage(error)}`)
      context = { dir: null, files: {} }
    }

    const plan = planSegments(files, { maxChars: config.segmentMaxChars })
    const concurrency = clampConcurrency(options.concurrency ?? config.reviewConcurrency)
    const outcomes = await runSegments(
      plan,
      template ?? SEED_TEMPLATES[0],
      context,
      options.runner,
      concurrency,
      sessionId,
    )

    const semanticFindings = []
    const modelVerdicts = []
    let mode = 'heuristic'
    let turnSessionId = null
    const usage = { input: 0, output: 0 }

    for (const outcome of outcomes) {
      if (outcome.status !== 'ok') {
        if (typeof outcome.note === 'string') notes.push(outcome.note)
        continue
      }
      if (outcome.mode === 'subagent' || outcome.mode === 'session') {
        if (mode === 'heuristic') mode = outcome.mode
        for (const finding of outcome.result.findings) {
          semanticFindings.push(normalizeModelFinding(finding))
        }
        modelVerdicts.push(outcome.result.verdict)
        if (outcome.mode === 'session' && turnSessionId === null) {
          turnSessionId = outcome.sessionId ?? sessionId
        }
        usage.input += normalizeUsage(outcome.usage).input
        usage.output += normalizeUsage(outcome.usage).output
      }
    }

    const semanticCount = outcomes.filter((outcome) => outcome.status === 'ok').length
    const fallbackCount = outcomes.filter((outcome) => outcome.status === 'fallback').length
    let candidates = semanticFindings
    if (semanticCount === 0) {
      mode = 'heuristic'
      candidates = heuristicFindings(files, { template })
      if (!notes.some((note) => note.includes('未做语义审查'))) {
        notes.push('本轮未做语义审查：没有可执行模型的分段，仅本地启发式规则结果。')
      }
    } else if (fallbackCount > 0) {
      notes.push(`${fallbackCount}/${outcomes.length} 个分段未做语义审查，结论只覆盖已审查分段。`)
    }

    const diffIndex = buildDiffIndex(files)
    const validation = validateFindings(candidates, diffIndex, {
      verdict: modelVerdicts[0],
    })
    if (validation.errors.length > 0) {
      const codes = [...new Set(validation.errors.map((error) => error.code))]
      notes.push(`后校验丢弃 ${validation.errors.length} 条 finding（${codes.join('、')}）。`)
    }

    const findings = aggregate(validation.findings, item?.findings ?? [])
    let verdict = pickVerdict(verdictFor(findings), modelVerdicts[0])
    if (mode === 'heuristic' && verdict === 'approve-suggested') {
      verdict = 'comments-only'
    }
    if (plan.coverage.skipped.length > 0 || plan.coverage.oversized.length > 0) {
      notes.push(`未覆盖：跳过 ${plan.coverage.skipped.length} 个文件，超大 ${plan.coverage.oversized.length} 个文件。`)
      if (verdict === 'approve-suggested') verdict = 'comments-only'
    }
    const summary = modelVerdicts.length > 0 && typeof outcomes[0]?.result?.summary === 'string'
      ? outcomes[0].result.summary
      : ''

    const turn = {
      id: turnId,
      key: item?.key ?? null,
      state: 'done',
      mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      computedForHead: head,
      templateVersion: template?.version ?? null,
      sessionId: turnSessionId,
      verdict,
      summary,
      findings,
      coverage: plan.coverage,
      usage,
      error: null,
      note: notes.join('；'),
    }

    await persistTurn(turn, item)
    return turn
  }

  return {
    review,
    runModel,
    resultFromText,
    plan: (input, options = {}) => {
      const files = Array.isArray(input)
        ? input
        : (Array.isArray(input?.files) ? input.files : [])
      return planSegments(files, options)
    },
    validateFindings,
    buildContextFiles,
    heuristicFindings,
    parseDiff,
    buildDiffIndex,
    aggregate,
    verdictFor,
    schema: REVIEW_RESULT_SCHEMA,
  }
}