import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  REVIEW_RESULT_SCHEMA,
  parseDiff,
  buildDiffIndex,
  planSegments,
  buildContextFiles,
  heuristicFindings,
  validateFindings,
  aggregate,
  verdictFor,
  resultFromText,
  createReviewer,
} from '../lib/review.js'

const DIFF = [
  'diff --git a/src/order.js b/src/order.js',
  'index 1111111..2222222 100644',
  '--- a/src/order.js',
  '+++ b/src/order.js',
  '@@ -1,2 +1,5 @@',
  ' function total(items) {',
  '-  return items.length',
  "+  console.log('debug', items)",
  "+  const API_KEY = 'sk-live-1234567890abcdef'",
  '+  return items.length',
  '+}',
  '@@ -10,2 +14,3 @@',
  ' function other() {',
  '+  // TODO: remove this',
  ' }',
  'diff --git a/src/new.js b/src/new.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.js',
  '@@ -0,0 +1,4 @@',
  "+export const answer = () => eval('1+1')",
  '+debugger',
  '+const node = document.body',
  "+node.innerHTML = '<b>x</b>'",
  '\\ No newline at end of file',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-one',
  '-two',
  'diff --git a/package-lock.json b/package-lock.json',
  'index 333..444 100644',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n')

const HEURISTIC_DIFF = [
  'diff --git a/src/hot.js b/src/hot.js',
  '--- a/src/hot.js',
  '+++ b/src/hot.js',
  '@@ -1 +1,8 @@',
  ' const start = 1',
  "+console.log('debug')",
  '+// TODO: clean up',
  '+debugger',
  "+const code = eval('1+1')",
  "+el.innerHTML = '<b>x</b>'",
  "+const API_KEY = 'sk-live-1234567890abcdef'",
  '+try { risky() } catch {}',
  'diff --git a/src/types.ts b/src/types.ts',
  '--- /dev/null',
  '+++ b/src/types.ts',
  '@@ -0,0 +1 @@',
  '+const value: any = input',
  'diff --git a/test/hot.test.js b/test/hot.test.js',
  '--- /dev/null',
  '+++ b/test/hot.test.js',
  '@@ -0,0 +1 @@',
  "+it.only('x', () => {})",
  'diff --git a/src/lonely.js b/src/lonely.js',
  '--- /dev/null',
  '+++ b/src/lonely.js',
  '@@ -0,0 +1 @@',
  '+export const lonely = 1',
  '',
].join('\n')

const REVIEW_DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,2 +1,4 @@',
  ' const app = createApp()',
  "+console.log('boot')",
  "+app.get('/', handler)",
  ' return app',
  '',
].join('\n')

/**
 * Build a synthetic parsed file of a given character size.
 * @param {string} filePath path.
 * @param {number} size approximate content characters.
 * @returns {object} parsed-file lookalike.
 */
function syntheticFile(filePath, size) {
  return {
    oldPath: filePath,
    newPath: filePath,
    newFile: false,
    deletedFile: false,
    generated: false,
    tooLarge: false,
    additions: 1,
    deletions: 0,
    hunks: [{
      header: '@@ -1 +1 @@',
      lines: [{ type: '+', text: 'x'.repeat(size), newLine: 1, oldLine: null }],
    }],
  }
}

/**
 * Findings helpers for the validation/aggregation cases.
 * @param {object} overrides fields to override.
 * @returns {object} finding.
 */
function finding(overrides = {}) {
  return {
    severity: 'low',
    file: 'src/order.js',
    line: 2,
    title: '问题',
    evidence: "console.log('debug', items)",
    suggestion: '修复',
    adopted: 'pending',
    ...overrides,
  }
}

/**
 * Minimal fake store exposing exactly the methods the reviewer calls.
 * @param {object[]} items initial work items.
 * @returns {object} fake store.
 */
function createFakeStore(items = []) {
  const turns = new Map()
  const itemRows = new Map(items.map((item) => [item.key, structuredClone(item)]))
  return {
    turns: {
      async put(turn) {
        turns.set(turn.id, structuredClone(turn))
        return turn
      },
      async get(id) {
        const turn = turns.get(id)
        return turn === undefined ? undefined : structuredClone(turn)
      },
      async list() {
        return [...turns.values()].map((turn) => structuredClone(turn))
      },
    },
    items: {
      async get(key) {
        const item = itemRows.get(key)
        return item === undefined ? undefined : structuredClone(item)
      },
      async patch(key, fn) {
        const current = itemRows.get(key)
        if (current === undefined) throw new Error(`missing item ${key}`)
        const next = fn(structuredClone(current))
        itemRows.set(key, structuredClone(next))
        return next
      },
    },
    turnCount() {
      return turns.size
    },
  }
}

/**
 * Duck-typed GitLab client used by `review()`.
 * @param {string} diff diff text returned by getDiffs.
 * @param {string[]} calls call log.
 * @returns {object} fake gitlab.
 */
function createFakeGitlab(diff, calls = []) {
  return {
    async getMergeRequest(item) {
      calls.push('getMergeRequest')
      return { title: 'Fix boot', description: 'DESC', headSha: item.headSha }
    },
    async getDiffs() {
      calls.push('getDiffs')
      return diff
    },
    async getDiscussions() {
      calls.push('getDiscussions')
      return [{ body: 'COMMENT BODY' }]
    },
    async getApprovals() {
      calls.push('getApprovals')
      return { approved: 0 }
    },
    async getPipelines() {
      calls.push('getPipelines')
      return [{ status: 'success' }]
    },
  }
}

/**
 * A work item fixture.
 * @returns {object} item.
 */
function createItem() {
  return {
    key: 'gitlab:default|gp/app#1',
    source: 'gitlab:default',
    kind: 'mr',
    subject: 'gp/app#1',
    project: 'gp/app',
    iid: 1,
    title: 'Fix boot',
    author: 'alice',
    link: 'https://gitlab.example.com/gp/app/-/merge_requests/1',
    headSha: 'sha1',
    baseSha: 'sha0',
    findings: [],
    lastTurn: null,
  }
}

test('parseDiff: files, flags, additions/deletions and line numbering', () => {
  const files = parseDiff(DIFF)
  assert.equal(files.length, 4)
  assert.deepEqual(
    files.map((file) => file.newPath ?? file.oldPath),
    ['src/order.js', 'src/new.js', 'old.txt', 'package-lock.json'],
  )

  const [order, created, removed, lock] = files
  assert.equal(order.newFile, false)
  assert.equal(order.deletedFile, false)
  assert.equal(order.additions, 5)
  assert.equal(order.deletions, 1)
  assert.equal(order.generated, false)

  assert.equal(created.newFile, true)
  assert.equal(created.deletedFile, false)
  assert.equal(created.additions, 4)
  assert.equal(created.deletions, 0)

  assert.equal(removed.deletedFile, true)
  assert.equal(removed.newFile, false)
  assert.equal(removed.oldPath, 'old.txt')
  assert.equal(removed.newPath, null)
  assert.equal(removed.additions, 0)
  assert.equal(removed.deletions, 2)

  assert.equal(lock.generated, true)
  assert.equal(lock.additions, 1)
  assert.equal(lock.deletions, 1)

  const first = order.hunks[0]
  assert.equal(first.header, '@@ -1,2 +1,5 @@')
  assert.deepEqual(first.lines.map((line) => line.type), [' ', '-', '+', '+', '+', '+'])

  const context = first.lines[0]
  assert.equal(context.text, ' function total(items) {'.slice(1))
  assert.equal(context.newLine, 1)
  assert.equal(context.oldLine, 1)

  const removedLine = first.lines[1]
  assert.equal(removedLine.newLine, null)
  assert.equal(removedLine.oldLine, 2)

  assert.deepEqual(
    first.lines.slice(2).map((line) => line.newLine),
    [2, 3, 4, 5],
  )
  assert.equal(first.lines[2].oldLine, null)
  assert.equal(first.lines[2].text, "  console.log('debug', items)")

  assert.equal(order.hunks[1].header, '@@ -10,2 +14,3 @@')
  assert.equal(order.hunks[1].lines[1].newLine, 15)
  assert.equal(order.hunks[1].lines[1].text, '  // TODO: remove this')

  assert.equal(created.hunks[0].lines.length, 4, 'no-newline marker must not become a diff line')
})

test('parseDiff: bare headers, CRLF, and malformed input', () => {
  const bare = ['--- a/a.js', '+++ b/a.js', '@@ -1 +1 @@', '-old', '+new'].join('\n')
  const bareFiles = parseDiff(bare)
  assert.equal(bareFiles.length, 1)
  assert.equal(bareFiles[0].oldPath, 'a.js')
  assert.equal(bareFiles[0].newPath, 'a.js')
  assert.equal(bareFiles[0].additions, 1)
  assert.equal(bareFiles[0].deletions, 1)

  const crlf = parseDiff(DIFF.replace(/\n/g, '\r\n'))
  assert.equal(crlf.length, 4)
  assert.equal(crlf[0].additions, 5)

  assert.deepEqual(parseDiff(''), [])
  assert.deepEqual(parseDiff('this is not a diff'), [])
  assert.deepEqual(parseDiff(undefined), [])
  assert.deepEqual(parseDiff(null), [])
})

test('buildDiffIndex: added/removed/context keys and kinds', () => {
  const index = buildDiffIndex(parseDiff(DIFF))
  assert.equal(index.size > 0, true)

  const added = index.get('src/order.js:2')
  assert.equal(added.kind, 'added')
  assert.equal(added.path, 'src/order.js')
  assert.equal(added.line, 2)
  assert.equal(added.text, "  console.log('debug', items)")

  assert.equal(index.get('src/order.js:1').kind, 'context')
  assert.equal(index.get('old.txt:1').kind, 'removed')
  // `-one` is the removed line; `text` is the content after the diff marker.
  assert.equal(index.get('old.txt:1').text, 'one')
  assert.equal(index.get('src/new.js:1').kind, 'added')
  assert.equal(index.has('old.txt:99'), false)
})

test('planSegments: priority order, oversized isolation and honest coverage', () => {
  const files = [
    syntheticFile('test/a.test.js', 500),
    syntheticFile('config/app.json', 500),
    syntheticFile('src/core.js', 1000),
    syntheticFile('pnpm-lock.yaml', 500),
    syntheticFile('src/huge.js', 5000),
  ]

  const plan = planSegments(files, { maxChars: 2000, maxSegments: 4 })
  assert.equal(plan.segments.length, 3)

  assert.equal(plan.segments[0].reason, 'core')
  assert.deepEqual(plan.segments[0].files, ['src/core.js'])
  assert.equal(plan.segments[0].oversized, false)

  assert.equal(plan.segments[1].oversized, true)
  assert.deepEqual(plan.segments[1].files, ['src/huge.js'])
  assert.equal(plan.segments[1].files.length, 1)

  assert.equal(plan.segments[2].reason, 'config')
  assert.deepEqual(plan.segments[2].files, ['config/app.json', 'test/a.test.js', 'pnpm-lock.yaml'])

  assert.deepEqual(plan.coverage.oversized, ['src/huge.js'])
  assert.deepEqual(plan.coverage.covered, [
    'src/core.js',
    'config/app.json',
    'test/a.test.js',
    'pnpm-lock.yaml',
  ])
  assert.deepEqual(plan.coverage.skipped, [])

  const allPaths = new Set(files.map((file) => file.newPath))
  const buckets = [
    ...plan.coverage.covered,
    ...plan.coverage.skipped,
    ...plan.coverage.oversized,
  ]
  assert.equal(buckets.length, files.length)
  assert.equal(new Set(buckets).size, buckets.length, 'coverage buckets must not overlap')
  for (const filePath of buckets) assert.equal(allPaths.has(filePath), true)
})

test('planSegments: maxSegments truncation lists skipped files explicitly', () => {
  const files = [
    syntheticFile('test/a.test.js', 500),
    syntheticFile('config/app.json', 500),
    syntheticFile('src/core.js', 1000),
    syntheticFile('pnpm-lock.yaml', 500),
    syntheticFile('src/huge.js', 5000),
  ]
  const plan = planSegments(files, { maxChars: 6000, maxSegments: 1 })
  assert.equal(plan.segments.length, 1)
  assert.deepEqual(plan.segments[0].files, ['src/core.js'])
  assert.equal(plan.coverage.covered.length, 1)
  assert.equal(plan.coverage.oversized.length, 0)
  assert.deepEqual(plan.coverage.skipped, [
    'src/huge.js',
    'config/app.json',
    'test/a.test.js',
    'pnpm-lock.yaml',
  ])
})

test('heuristicFindings: hits every local rule with verbatim evidence and no blockers', () => {
  const files = parseDiff(HEURISTIC_DIFF)
  const findings = heuristicFindings(files, {})
  const titles = findings.map((item) => item.title)

  for (const expected of [
    '残留 console 调试输出',
    '新增 TODO/FIXME 标记',
    '新增 debugger 语句',
    '使用 eval 执行动态代码',
    '直接赋值 innerHTML',
    '疑似硬编码密钥',
    'catch 块静默吞掉异常',
    '使用 any 削弱类型检查',
    '测试残留 .only 焦点',
    '缺少对应测试改动',
  ]) {
    assert.ok(titles.includes(expected), `missing rule ${expected}`)
  }

  assert.equal(findings.filter((item) => item.severity === 'blocker').length, 0)
  for (const item of findings) {
    assert.equal(typeof item.suggestion, 'string')
    assert.notEqual(item.suggestion, '')
    assert.equal(item.adopted, 'pending')
    assert.ok(['blocker', 'high', 'medium', 'low'].includes(item.severity))
  }

  const key = findings.find((item) => item.title === '疑似硬编码密钥')
  assert.equal(key.severity, 'high')
  assert.equal(key.file, 'src/hot.js')
  assert.equal(key.line, 7)
  assert.equal(key.evidence, "const API_KEY = 'sk-live-1234567890abcdef'")

  const missingTests = findings.find(
    (item) => item.title === '缺少对应测试改动' && item.file === 'src/lonely.js',
  )
  assert.ok(missingTests)
  assert.equal(missingTests.evidence, 'export const lonely = 1')

  const validation = validateFindings(findings, buildDiffIndex(files))
  assert.equal(validation.ok, true, JSON.stringify(validation.errors))
  assert.equal(validation.findings.length, findings.length)
})

test('heuristicFindings: is deterministic and conservative on trivia', () => {
  const files = parseDiff([
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -0,0 +1,2 @@',
    "+console.log('x')",
    '+// FIXME later',
    '',
  ].join('\n'))
  const first = heuristicFindings(files, {})
  const second = heuristicFindings(files, {})
  assert.deepEqual(first, second)
  assert.ok(first.length > 0)
  assert.ok(first.every((item) => item.severity === 'low'))
})

test('validateFindings: rejects unprovable findings and verdict conflicts', () => {
  const index = buildDiffIndex(parseDiff(DIFF))

  const accepted = validateFindings([finding()], index, { verdict: 'comments-only' })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.findings.length, 1)
  assert.equal(typeof accepted.findings[0].line, 'number')
  assert.equal(accepted.findings[0].line, 2)

  const outside = validateFindings([finding({ line: 99 })], index)
  assert.equal(outside.ok, false)
  assert.deepEqual(outside.findings, [])
  assert.ok(outside.errors.some((error) => error.code === 'line-outside-diff'))

  const badEvidence = validateFindings(
    [finding({ evidence: "  console.log('definitely not here')" })],
    index,
  )
  assert.equal(badEvidence.ok, false)
  assert.equal(badEvidence.findings.length, 0)
  assert.ok(badEvidence.errors.some((error) => error.code === 'evidence-not-found'))

  const unknownPath = validateFindings(
    [finding({ file: 'src/not-in-diff.js' })],
    index,
  )
  assert.equal(unknownPath.ok, false)
  assert.ok(unknownPath.errors.some((error) => error.code === 'unknown-path'))

  const badLine = validateFindings([finding({ line: 'abc' })], index)
  assert.equal(badLine.ok, false)
  assert.ok(badLine.errors.some((error) => error.code === 'bad-line'))

  const blocker = finding({
    severity: 'blocker',
    title: '密钥',
    line: 3,
    evidence: "  const API_KEY = 'sk-live-1234567890abcdef'",
  })
  const approveWithBlocker = validateFindings([blocker], index, { verdict: 'approve-suggested' })
  assert.equal(approveWithBlocker.ok, false)
  assert.ok(approveWithBlocker.errors.some((error) => error.code === 'verdict-mismatch'))
  assert.equal(approveWithBlocker.findings.length, 1, 'valid findings survive verdict errors')

  const requestChanges = validateFindings([blocker], index, { verdict: 'request-changes-suggested' })
  assert.equal(requestChanges.ok, true)

  const removedLine = validateFindings(
    [finding({ file: 'old.txt', line: 1, evidence: ' one' })],
    index,
  )
  assert.equal(removedLine.ok, true)
})

test('aggregate: dedupe by path:line:title, suppress ignored ids, order by severity', () => {
  const findings = [
    { severity: 'low', file: 'z.js', line: 10, title: 'B', evidence: 'x', suggestion: '', adopted: 'pending' },
    { severity: 'medium', file: 'a.js', line: 5, title: 'A', evidence: 'x', suggestion: '', adopted: 'pending' },
    { severity: 'high', file: 'a.js', line: 5, title: 'A ', evidence: 'x', suggestion: '', adopted: 'pending' },
    { severity: 'blocker', file: 'a.js', line: 1, title: 'C', evidence: 'x', suggestion: '', adopted: 'pending' },
  ]

  const aggregated = aggregate(findings, [])
  assert.equal(aggregated.length, 3)
  assert.deepEqual(aggregated.map((item) => item.severity), ['blocker', 'high', 'low'])
  assert.deepEqual(aggregated.map((item) => item.title), ['C', 'A', 'B'])
  assert.equal(aggregated[1].severity, 'high', 'dedupe keeps the higher severity')

  const suppressed = aggregate(findings, [
    { severity: 'blocker', file: 'a.js', line: 1, title: 'C', adopted: 'ignored' },
  ])
  assert.equal(suppressed.length, 2)
  assert.equal(suppressed.some((item) => item.title === 'C'), false)

  const suppressedByIds = aggregate(findings, new Set(['z.js:10:B']))
  assert.equal(suppressedByIds.length, 2)
  assert.equal(suppressedByIds.some((item) => item.title === 'B'), false)
})

test('verdictFor: deterministic severity policy', () => {
  assert.equal(verdictFor([]), 'approve-suggested')
  assert.equal(verdictFor([{ severity: 'low' }]), 'approve-suggested')
  assert.equal(verdictFor([{ severity: 'medium' }]), 'comments-only')
  assert.equal(verdictFor([{ severity: 'high' }]), 'comments-only')
  assert.equal(verdictFor([{ severity: 'high' }, { severity: 'high' }]), 'request-changes-suggested')
  assert.equal(verdictFor([{ severity: 'blocker' }]), 'request-changes-suggested')
})

test('resultFromText: bare JSON, fenced JSON, review-result block, garbage', () => {
  const payload = { verdict: 'comments-only', summary: '结论', findings: [] }

  assert.deepEqual(resultFromText(JSON.stringify(payload)), payload)
  assert.deepEqual(resultFromText(`文本\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`), payload)
  assert.deepEqual(
    resultFromText(`<review-result>${JSON.stringify(payload)}</review-result>`),
    payload,
  )
  assert.deepEqual(
    resultFromText(`前缀 {"verdict":"comments-only","summary":"x","findings":[]} 后缀`),
    { verdict: 'comments-only', summary: 'x', findings: [] },
  )

  assert.equal(resultFromText('not json at all'), undefined)
  assert.equal(resultFromText(''), undefined)
  assert.equal(resultFromText(undefined), undefined)
  assert.equal(resultFromText('{"broken": '), undefined)
})

test('REVIEW_RESULT_SCHEMA: narrow object schema with all fields required', () => {
  assert.equal(REVIEW_RESULT_SCHEMA.type, 'object')
  assert.equal(REVIEW_RESULT_SCHEMA.additionalProperties, false)
  assert.deepEqual([...REVIEW_RESULT_SCHEMA.required], ['verdict', 'summary', 'findings'])
  assert.deepEqual(
    [...REVIEW_RESULT_SCHEMA.properties.verdict.enum],
    ['approve-suggested', 'comments-only', 'request-changes-suggested'],
  )

  const items = REVIEW_RESULT_SCHEMA.properties.findings.items
  assert.equal(items.type, 'object')
  assert.equal(items.additionalProperties, false)
  assert.deepEqual(
    [...items.required],
    ['file', 'line', 'severity', 'title', 'evidence', 'suggestion'],
  )
  assert.equal(items.properties.file.type, 'string')
  assert.equal(items.properties.line.type, 'string')
  assert.deepEqual([...items.properties.severity.enum], ['blocker', 'high', 'medium', 'low'])
  for (const key of ['title', 'evidence', 'suggestion']) {
    assert.equal(items.properties[key].type, 'string')
  }
})

test('buildContextFiles: writes data files under tmp and returns only paths', () => {
  const files = parseDiff(DIFF)
  const turnId = `test-context-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  const context = buildContextFiles(createItem(), {
    turnId,
    files,
    diff: DIFF,
    discussions: [{ body: 'COMMENT TEXT' }],
    conventions: '# 约定\n- 不使用分号',
    mr: { title: 'RAW TITLE', description: 'RAW DESCRIPTION' },
  })

  try {
    assert.equal(context.turnId, turnId)
    assert.equal(context.dir, path.join(os.tmpdir(), 'daily-work-hub', 'turns', turnId))
    for (const filePath of Object.values(context.files)) {
      assert.equal(fs.existsSync(filePath), true, filePath)
      assert.equal(filePath.startsWith(context.dir), true)
    }

    const mr = JSON.parse(fs.readFileSync(context.files.mr, 'utf8'))
    assert.equal(mr.project, 'gp/app')
    assert.equal(mr.iid, 1)
    assert.equal(mr.title, 'RAW TITLE')
    assert.equal(mr.description, 'RAW DESCRIPTION')
    assert.equal(mr.changedFiles.length, 4)
    assert.deepEqual(
      mr.changedFiles.map((entry) => entry.path),
      ['src/order.js', 'src/new.js', 'old.txt', 'package-lock.json'],
    )

    assert.equal(fs.readFileSync(context.files.diff, 'utf8'), DIFF)
    const discussions = JSON.parse(fs.readFileSync(context.files.discussions, 'utf8'))
    assert.equal(discussions.discussions[0].body, 'COMMENT TEXT')
    assert.match(fs.readFileSync(context.files.conventions, 'utf8'), /不使用分号/)
  } finally {
    fs.rmSync(context.dir, { recursive: true, force: true })
  }
})

test('reviewer.review: session output persists a Turn and patches lastTurn/findings', async () => {
  const item = createItem()
  const store = createFakeStore([item])
  const calls = []
  const reviewer = createReviewer({
    store,
    gitlab: createFakeGitlab(REVIEW_DIFF, calls),
    config: { reviewConcurrency: 2 },
  })

  const prompts = []
  const runner = {
    async session({ prompt, sessionId }) {
      prompts.push({ prompt, sessionId })
      return JSON.stringify({
        verdict: 'comments-only',
        summary: '有调试输出残留。',
        findings: [{
          file: 'src/app.js',
          line: '2',
          severity: 'low',
          title: '残留 console.log',
          evidence: "console.log('boot')",
          suggestion: '删除调试输出。',
        }],
      })
    },
  }

  const turn = await reviewer.review(createItem(), { runner })
  try {
    assert.equal(turn.state, 'done')
    assert.equal(turn.mode, 'session')
    assert.equal(turn.verdict, 'comments-only')
    assert.equal(turn.summary, '有调试输出残留。')
    assert.equal(turn.computedForHead, 'sha1')
    assert.equal(turn.templateVersion, 1)
    assert.equal(turn.sessionId, `dw-${turn.id}`)
    assert.equal(turn.findings.length, 1)
    assert.equal(turn.findings[0].line, 2)
    assert.deepEqual(turn.coverage, { covered: ['src/app.js'], skipped: [], oversized: [] })
    assert.deepEqual(calls, [
      'getMergeRequest',
      'getDiffs',
      'getDiscussions',
      'getApprovals',
      'getPipelines',
    ])
    assert.equal(store.turnCount(), 1)

    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].sessionId, `dw-${turn.id}`)
    assert.match(prompts[0].prompt, /src\/app\.js/)
    assert.match(prompts[0].prompt, /mr\.json/)
    assert.equal(prompts[0].prompt.includes("console.log('boot')"), false)
    assert.equal(prompts[0].prompt.includes('DESC'), false)
    assert.equal(prompts[0].prompt.includes('COMMENT BODY'), false)

    const stored = await store.turns.get(turn.id)
    assert.equal(stored.mode, 'session')
    assert.equal(stored.findings.length, 1)

    const patched = await store.items.get(item.key)
    assert.deepEqual(Object.keys(patched.lastTurn), [
      'id',
      'verdict',
      'computedForHead',
      'finishedAt',
      'templateVersion',
    ])
    assert.equal(patched.lastTurn.id, turn.id)
    assert.equal(patched.lastTurn.verdict, 'comments-only')
    assert.equal(patched.lastTurn.computedForHead, 'sha1')
    assert.equal(patched.lastTurn.templateVersion, 1)
    assert.equal(patched.findings.length, 1)
  } finally {
    fs.rmSync(path.join(os.tmpdir(), 'daily-work-hub', 'turns', turn.id), {
      recursive: true,
      force: true,
    })
  }
})

test('reviewer.review: broken model output degrades to heuristic without throwing', async () => {
  const item = createItem()
  const store = createFakeStore([item])
  const reviewer = createReviewer({
    store,
    gitlab: createFakeGitlab(REVIEW_DIFF),
    logger: { warn() {} },
  })

  const runner = {
    async subagent() {
      throw new Error('subagent-offline')
    },
    async session() {
      return '抱歉，我无法输出 JSON。'
    },
  }

  const turn = await reviewer.review(createItem(), { runner })
  try {
    assert.equal(turn.state, 'done')
    assert.equal(turn.mode, 'heuristic')
    assert.match(turn.note, /未做语义审查/)
    assert.match(turn.note, /subagent-offline/)
    assert.match(turn.note, /输出不是合法 ReviewResult JSON/)
    assert.ok(turn.findings.some((finding) => finding.title === '残留 console 调试输出'))
    assert.equal(turn.findings.some((finding) => finding.severity === 'blocker'), false)
    assert.equal(turn.verdict, 'comments-only', 'heuristic-only review must not suggest approve')

    const stored = await store.turns.get(turn.id)
    assert.equal(stored.mode, 'heuristic')
    assert.equal(store.turnCount(), 1)
  } finally {
    fs.rmSync(path.join(os.tmpdir(), 'daily-work-hub', 'turns', turn.id), {
      recursive: true,
      force: true,
    })
  }
})

test('reviewer.review: payload skips GitLab fetching', async () => {
  const item = createItem()
  const store = createFakeStore([item])
  const calls = []
  const reviewer = createReviewer({
    store,
    gitlab: {
      async getMergeRequest() {
        calls.push('getMergeRequest')
        throw new Error('must not fetch')
      },
    },
  })

  const turn = await reviewer.review(createItem(), {
    payload: {
      diff: REVIEW_DIFF,
      mr: { title: 'Provided' },
      discussions: [],
      conventions: '',
    },
    runner: {
      async session() {
        return JSON.stringify({ verdict: 'approve-suggested', summary: '', findings: [] })
      },
    },
  })
  try {
    assert.equal(turn.state, 'done')
    assert.equal(turn.mode, 'session')
    assert.equal(turn.findings.length, 0)
    assert.deepEqual(calls, [])
  } finally {
    fs.rmSync(path.join(os.tmpdir(), 'daily-work-hub', 'turns', turn.id), {
      recursive: true,
      force: true,
    })
  }
})

test('reviewer.runModel: never throws when every channel fails', async () => {
  const reviewer = createReviewer({})
  const outcome = await reviewer.runModel({
    prompt: '审查一下',
    runner: {
      async subagent() {
        throw new Error('boom')
      },
      async session() {
        return 'nope'
      },
    },
  })
  assert.equal(outcome.mode, 'heuristic')
  assert.match(outcome.note, /未做语义审查/)
  assert.deepEqual(outcome.failures.length, 2)
})

test('reviewer: pure helpers are exposed for routes and tests', () => {
  const reviewer = createReviewer({})
  const files = parseDiff(REVIEW_DIFF)
  const plan = reviewer.plan(files, { maxChars: 1000 })
  assert.deepEqual(plan.coverage.covered, ['src/app.js'])
  assert.equal(reviewer.schema, REVIEW_RESULT_SCHEMA)
  assert.equal(reviewer.parseDiff(DIFF).length, 4)
  assert.equal(typeof reviewer.buildContextFiles, 'function')
  assert.equal(typeof reviewer.validateFindings, 'function')
  assert.equal(typeof reviewer.heuristicFindings, 'function')
})