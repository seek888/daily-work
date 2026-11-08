import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SEED_TEMPLATES,
  BUILTIN_TEMPLATE_IDS,
  VARIABLE_WHITELIST,
  OUTPUT_SCHEMA,
  listTemplates,
  getTemplate,
  validateTemplate,
  saveTemplate,
  removeTemplate,
  renderPrompt,
  describeScope,
  matchTemplate,
  createTemplateStore,
  isBuiltinTemplate,
} from '../lib/templates.js'

/**
 * Minimal in-memory store exposing only the `templates` table used here.
 * @param {object[]} seed initial rows.
 * @returns {object} fake store.
 */
function createFakeStore(seed = []) {
  const rows = new Map(seed.map((row) => [row.id, structuredClone(row)]))
  return {
    templates: {
      async list() {
        return [...rows.values()].map((row) => structuredClone(row))
      },
      async get(id) {
        const row = rows.get(id)
        return row === undefined ? undefined : structuredClone(row)
      },
      async put(template) {
        rows.set(template.id, structuredClone(template))
        return structuredClone(template)
      },
      async remove(id) {
        rows.delete(id)
      },
    },
    has(id) {
      return rows.has(id)
    },
  }
}

/**
 * A valid custom template input.
 * @param {object} [overrides] fields to replace.
 * @returns {object} template input.
 */
function validInput(overrides = {}) {
  return {
    id: 'tpl-custom',
    name: '自定义审查',
    role: '审查者，只做审查，不改代码',
    checklist: ['正确性', '错误处理'],
    context: ['mr.meta', 'diff'],
    variables: ['mr.title', 'diff'],
    outputSchema: OUTPUT_SCHEMA,
    model: { provider: 'qianfan', model: 'deepseek-v4.1-flash', temperature: 0.2 },
    scope: { projects: [], paths: [], exclude: [] },
    enabled: true,
    ...overrides,
  }
}

test('SEED_TEMPLATES: three enabled builtins shaped like Template', () => {
  assert.equal(SEED_TEMPLATES.length, 3)
  assert.deepEqual(
    SEED_TEMPLATES.map((template) => template.id),
    ['tpl-review-default', 'tpl-security', 'tpl-summary'],
  )
  assert.deepEqual([...BUILTIN_TEMPLATE_IDS].sort(), SEED_TEMPLATES.map((t) => t.id).sort())

  for (const seed of SEED_TEMPLATES) {
    assert.equal(seed.enabled, true)
    assert.equal(seed.outputSchema, OUTPUT_SCHEMA)
    assert.equal(typeof seed.version, 'number')
    assert.ok(seed.checklist.length > 0)
    assert.ok(seed.variables.length > 0)
    for (const variable of seed.variables) {
      assert.ok(VARIABLE_WHITELIST.includes(variable), `unexpected variable ${variable}`)
    }
    for (const key of [
      'id', 'name', 'version', 'scope', 'role', 'checklist', 'context',
      'variables', 'outputSchema', 'model', 'enabled', 'stats', 'updatedAt',
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(seed, key), `missing ${key}`)
    }
    assert.deepEqual(Object.keys(seed.stats).sort(), ['adopted', 'ignored', 'used'])
    assert.equal(typeof seed.model.provider, 'string')
    assert.equal(typeof seed.model.model, 'string')
    assert.equal(validateTemplate(seed).ok, true, seed.id)
    assert.equal(isBuiltinTemplate(seed.id), true)
  }
})

test('validateTemplate: rejects each contract violation with a field path', () => {
  const cases = [
    [validInput({ id: '' }), 'id'],
    [validInput({ name: '  ' }), 'name'],
    [validInput({ checklist: [] }), 'checklist'],
    [validInput({ checklist: [''] }), 'checklist[0]'],
    [validInput({ variables: ['comment.body'] }), 'variables[0]'],
    [validInput({ variables: 'mr.title' }), 'variables'],
    [validInput({ model: { model: 'm' } }), 'model.provider'],
    [validInput({ model: { provider: 'p' } }), 'model.model'],
    [validInput({ outputSchema: 'Other@1' }), 'outputSchema'],
    [validInput({ scope: { projects: [], paths: 'src/**', exclude: [] } }), 'scope.paths'],
    [validInput({ enabled: 'yes' }), 'enabled'],
  ]

  for (const [input, field] of cases) {
    const result = validateTemplate(input)
    assert.equal(result.ok, false)
    assert.ok(
      result.errors.some((error) => error.field === field),
      `expected an error for ${field}, got ${JSON.stringify(result.errors)}`,
    )
    for (const error of result.errors) {
      assert.equal(typeof error.message, 'string')
      assert.notEqual(error.message, '')
    }
  }
})

test('validateTemplate: accepts bare, wrapped and whitelisted variables', () => {
  assert.equal(validateTemplate(validInput()).ok, true)
  const wrapped = validInput({ variables: ['{{mr.title}}', '{{file:mr}}', 'mr.description', 'files'] })
  assert.equal(validateTemplate(wrapped).ok, true)
})

test('listTemplates / getTemplate round-trip the store', async () => {
  const store = createFakeStore(SEED_TEMPLATES)
  const rows = await listTemplates(store)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].id, 'tpl-review-default')

  const found = await getTemplate(store, 'tpl-security')
  assert.equal(found.name, '安全审查')
  assert.equal(await getTemplate(store, 'missing'), undefined)
  assert.equal(await getTemplate(store, ''), undefined)
})

test('saveTemplate: version bumps only on content change and createdAt is kept', async () => {
  const store = createFakeStore([])
  const first = await saveTemplate(store, validInput(), { now: '2026-11-09T01:00:00.000Z' })
  assert.equal(first.version, 1)
  assert.equal(first.createdAt, '2026-11-09T01:00:00.000Z')
  assert.equal(first.updatedAt, '2026-11-09T01:00:00.000Z')
  assert.equal(first.enabled, true)
  assert.deepEqual(first.stats, { used: 0, adopted: 0, ignored: 0 })
  assert.equal(store.has('tpl-custom'), true)

  const unchanged = await saveTemplate(store, validInput(), { now: '2026-11-09T02:00:00.000Z' })
  assert.equal(unchanged.version, 1)
  assert.equal(unchanged.createdAt, '2026-11-09T01:00:00.000Z')
  assert.equal(unchanged.updatedAt, '2026-11-09T02:00:00.000Z')

  const changed = await saveTemplate(
    store,
    validInput({ checklist: ['正确性', '错误处理', '安全'] }),
    { now: '2026-11-09T03:00:00.000Z' },
  )
  assert.equal(changed.version, 2)
  assert.equal(changed.createdAt, '2026-11-09T01:00:00.000Z')

  const stored = await getTemplate(store, 'tpl-custom')
  assert.equal(stored.version, 2)
  assert.deepEqual(stored.checklist, ['正确性', '错误处理', '安全'])

  const stats = await saveTemplate(
    store,
    // Same reviewable content as the previous save (only stats differ), otherwise
    // a version bump would be legitimate and the assertion meaningless.
    validInput({
      checklist: ['正确性', '错误处理', '安全'],
      stats: { used: 3, adopted: 2, ignored: 1 },
    }),
    { now: '2026-11-09T04:00:00.000Z' },
  )
  assert.equal(stats.version, 2, 'stats alone must not bump the version')
  assert.deepEqual(stats.stats, { used: 3, adopted: 2, ignored: 1 })
})

test('saveTemplate: invalid input throws invalid-template and does not write', async () => {
  const store = createFakeStore([])
  await assert.rejects(
    () => saveTemplate(store, validInput({ outputSchema: 'Other@1' }), { now: '2026-11-09T00:00:00.000Z' }),
    (error) => {
      assert.equal(error.code, 'invalid-template')
      assert.ok(Array.isArray(error.errors))
      assert.ok(error.errors.some((item) => item.field === 'outputSchema'))
      return true
    },
  )
  assert.equal(store.has('tpl-custom'), false)
})

test('removeTemplate: builtins are refused, custom templates are removed', async () => {
  const store = createFakeStore(SEED_TEMPLATES)
  const refused = await removeTemplate(store, 'tpl-review-default')
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'builtin')
  assert.equal(store.has('tpl-review-default'), true)
  assert.equal((await getTemplate(store, 'tpl-review-default')).id, 'tpl-review-default')

  const customStore = createFakeStore([])
  await saveTemplate(customStore, validInput(), { now: '2026-11-09T00:00:00.000Z' })
  const removed = await removeTemplate(customStore, 'tpl-custom')
  assert.equal(removed.ok, true)
  assert.equal(removed.id, 'tpl-custom')
  assert.equal(customStore.has('tpl-custom'), false)
})

test('renderPrompt: resolves file placeholders, filters whitelist, never inlines MR text', () => {
  const template = validInput({
    prompt: '标题见 {{mr.title}}\n\n{{file:mr}}\n\n{{file:diff}}\n\n未知 {{comment.body}}',
  })
  const result = renderPrompt(template, {
    files: { mr: 'C:\\tmp\\dw\\mr.json', diff: '/tmp/dw/diff.patch' },
    'mr.title': 'RAW MR TITLE MUST NOT APPEAR',
  })

  assert.ok(result.text.includes('C:\\tmp\\dw\\mr.json'))
  assert.ok(result.text.includes('/tmp/dw/diff.patch'))
  assert.equal(result.text.includes('RAW MR TITLE MUST NOT APPEAR'), false)
  assert.deepEqual(result.used, ['mr.title', 'file:mr', 'file:diff'])
  assert.deepEqual(result.missing, ['comment.body'])
  assert.deepEqual(result.variables, result.used)
})

test('renderPrompt: unresolved and non-path values are empty and listed as missing', () => {
  const template = validInput({
    prompt: '{{file:mr}} {{file:conventions}} {{mr.description}}',
  })

  const almost = renderPrompt(template, { files: { mr: '/tmp/mr.json' } })
  assert.deepEqual(almost.used, ['file:mr', 'mr.description'])
  assert.deepEqual(almost.missing, ['file:conventions'])
  assert.equal(almost.text.startsWith('/tmp/mr.json'), true)

  const rejected = renderPrompt(
    validInput({ prompt: '{{file:mr}} {{file:diff}} {{file:discussions}}' }),
    {
      files: {
        mr: '{"title":"secret text"}',
        diff: 'line one\nline two',
        discussions: '看起来像一段讨论正文，不是路径',
      },
    },
  )
  assert.deepEqual(rejected.used, [])
  assert.deepEqual(rejected.missing, ['file:mr', 'file:diff', 'file:discussions'])
  assert.equal(rejected.text.trim(), '')
})

test('renderPrompt: seeds compose a path-only prompt', () => {
  const files = {
    mr: '/tmp/dw/mr.json',
    diff: '/tmp/dw/diff.patch',
    discussions: '/tmp/dw/discussions.json',
    conventions: '/tmp/dw/conventions.md',
  }
  const result = renderPrompt(SEED_TEMPLATES[0], { files })
  assert.deepEqual(result.missing, [])
  assert.equal(result.text.includes('# 角色'), true)
  assert.equal(result.text.includes('# 检查清单'), true)
  for (const filePath of Object.values(files)) {
    assert.equal(result.text.includes(filePath), true, filePath)
  }
  assert.equal(result.text.includes('{"'), false)
})

test('describeScope: Chinese applicability summary', () => {
  const summary = describeScope(SEED_TEMPLATES[0])
  assert.match(summary, /全部项目/)
  assert.match(summary, /全部路径/)
  assert.match(summary, /排除/)

  const security = describeScope(SEED_TEMPLATES[1])
  assert.match(security, /src\/\*\*/)
  assert.match(security, /项目：全部项目/)
})

test('matchTemplate: first enabled matching scope, else the default template', () => {
  const security = {
    id: 'tpl-security',
    enabled: true,
    scope: { projects: ['gp/security/*'], paths: ['src/**'], exclude: [] },
  }
  const disabled = {
    id: 'tpl-off',
    enabled: false,
    scope: { projects: [], paths: [], exclude: [] },
  }
  const fallback = {
    id: 'tpl-review-default',
    enabled: true,
    scope: { projects: [], paths: [], exclude: [] },
  }
  const lockInclude = {
    id: 'tpl-lock',
    enabled: true,
    scope: { projects: [], paths: ['**/*.lock'], exclude: [] },
  }
  const excluded = {
    id: 'tpl-exclude-lock',
    enabled: true,
    scope: { projects: [], paths: [], exclude: ['**/*.lock'] },
  }
  const templates = [disabled, security, lockInclude, fallback]

  assert.equal(
    matchTemplate(templates, { project: 'gp/security/api', paths: ['src/auth.js'] }),
    security,
  )
  assert.equal(matchTemplate(templates, { project: 'gp/web', paths: ['src/auth.js'] }), fallback)
  assert.equal(
    matchTemplate(templates, { project: 'gp/security/api', paths: ['docs/readme.md'] }),
    fallback,
  )
  assert.equal(matchTemplate(templates, { project: 'gp/web', paths: ['yarn.lock'] }), lockInclude)
  assert.equal(matchTemplate([disabled], { project: 'x', paths: ['src/a.js'] }), undefined)
  assert.equal(matchTemplate([], {}), undefined)
  assert.equal(
    matchTemplate([excluded, fallback], { project: 'gp/web', paths: ['a.lock'] }),
    fallback,
    'all paths excluded means the scope does not apply',
  )
})

test('createTemplateStore: binds the CRUD facade to one store', async () => {
  const store = createFakeStore([])
  const api = createTemplateStore(store)
  assert.deepEqual(await api.list(), [])
  const saved = await api.save(validInput(), { now: '2026-11-09T00:00:00.000Z' })
  assert.equal(saved.id, 'tpl-custom')
  assert.equal((await api.get('tpl-custom')).name, '自定义审查')
  assert.equal(api.validate(validInput()).ok, true)
  assert.equal(typeof api.renderPrompt, 'function')
  assert.equal(typeof api.describeScope, 'function')
  assert.equal(typeof api.match, 'function')
  const removed = await api.remove('tpl-custom')
  assert.equal(removed.ok, true)
})