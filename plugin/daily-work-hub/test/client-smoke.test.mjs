/**
 * Client bundle smoke test.
 *
 * The previous 0.1.0 install was force-disabled because its client factory threw
 * at load (`exports` / `module` are not injected), which made the host fall back
 * to safe mode. This test reproduces the real bundle in a minimal DOM and asserts
 * that:
 *  - loading it does not throw,
 *  - the factory returns `{ name, inject, apply }`,
 *  - `apply()` registers the localization namespace, the `main` panel and the
 *    `sidebar.panellist` row, and tears them down cleanly.
 * @module test/client-smoke.test
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = join(here, '..', 'client', 'client.js')

/**
 * Minimal React stub: only what evaluating the bundle needs.
 * @returns {object} fake React module.
 */
function fakeReact() {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment',
  }
  for (const hook of ['useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useReducer', 'useLayoutEffect']) {
    React[hook] = (value) => (hook === 'useState' ? [typeof value === 'function' ? value() : value, () => {}] : value)
  }
  React.createContext = () => ({ Provider: 'Provider', Consumer: 'Consumer' })
  /** Minimal class-component base: the bundle declares one error boundary class. */
  React.Component = class Component {
    constructor(props = {}) {
      this.props = props
      this.state = {}
    }

    setState(patch) {
      this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) }
    }

    forceUpdate() {}

    render() {
      return null
    }
  }
  React.PureComponent = React.Component
  return React
}

/**
 * Minimal DOM/document stub good enough for style injection and language sniffing.
 * @returns {{ document: object, window: object }} browser-ish globals.
 */
function fakeBrowser() {
  const appended = []
  const document = {
    baseURI: 'http://127.0.0.1:43129/',
    documentElement: { lang: 'zh-CN', style: {} },
    head: { appendChild: (node) => appended.push(node) },
    body: { appendChild: (node) => appended.push(node) },
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, childNodes: [], textContent: '' }),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const storage = new Map()
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  }
  const window = {
    document,
    localStorage,
    navigator: { language: 'zh-CN', languages: ['zh-CN'] },
    addEventListener: () => {},
    removeEventListener: () => {},
    open: () => null,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  window.window = window
  return { document, window, localStorage, appended }
}

test('client bundle: loads, returns exports, registers and disposes slots', async () => {
  const source = await readFile(CLIENT_FILE, 'utf8')
  const browser = fakeBrowser()
  let loadSpec
  const React = fakeReact()
  const moduleLoader = {
    load: (spec) => {
      loadSpec = spec
    },
  }
  // The bundle addresses the loader through `window`, so it must live there.
  browser.window.__ModuleLoader__ = moduleLoader

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    Date,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    RegExp,
    Map,
    Set,
    Intl,
    AbortController,
    fetch: async () => ({ ok: false, status: 500, text: async () => '{}', json: async () => ({}) }),
    document: browser.document,
    window: browser.window,
    localStorage: browser.localStorage,
    navigator: browser.window.navigator,
    __ModuleLoader__: moduleLoader,
  })
  context.globalThis = context

  assert.doesNotThrow(() => {
    new vm.Script(source, { filename: 'client/client.js' }).runInContext(context)
  }, 'the client bundle must evaluate without throwing')

  assert.ok(loadSpec, 'the bundle must declare itself through window.__ModuleLoader__.load')
  assert.equal(loadSpec.id, 'daily-work-hub')
  assert.equal(typeof loadSpec.factory, 'function')

  let exports
  assert.doesNotThrow(() => {
    exports = loadSpec.factory((name) => {
      if (name === 'react') return React
      throw new Error(`unexpected module request: ${name}`)
    })
  }, 'factory(require) must not reference undeclared exports/module')
  assert.equal(typeof exports.apply, 'function')
  assert.equal(exports.name, 'daily-work-hub')
  assert.deepEqual([...exports.inject], ['slots', 'locale', 'layout'])

  const registered = []
  const injected = []
  const effects = []
  const locales = []
  const disposers = []
  const fakeCtx = {
    effect: (fn, label) => {
      effects.push(label)
      const value = fn()
      disposers.push(typeof value === 'function' ? value : null)
      return value
    },
    locale: {
      register: (namespace, dictionaries) => {
        locales.push({ namespace, dictionaries })
        return () => {}
      },
    },
    slots: {
      inject: (key, callback) => {
        injected.push(key)
        const off = callback()
        return () => {
          if (typeof off === 'function') off()
        }
      },
      register: (meta, component) => {
        registered.push({ meta, component })
        return () => {}
      },
    },
    get: (name) => (name === 'layout' ? { panelInfo: { getSnapshot: () => ({ activePanelId: 'other' }) }, selectPanel: () => {} } : undefined),
  }

  let dispose
  assert.doesNotThrow(() => {
    dispose = exports.apply(fakeCtx)
  }, 'apply() must not throw')

  assert.deepEqual(locales.map((entry) => entry.namespace), ['daily-work-hub'])
  assert.deepEqual(injected, ['main', 'sidebar.panellist'])
  const main = registered.find((entry) => entry.meta.name === 'main')
  const row = registered.find((entry) => entry.meta.name === 'sidebar.panellist')
  assert.ok(main, 'a `main` panel must be registered')
  assert.equal(main.meta.key, 'daily-work-hub')
  assert.equal(typeof main.component, 'function')
  assert.ok(row, 'a `sidebar.panellist` row must be registered')
  assert.equal(row.meta.id, 'daily-work-hub')
  assert.equal(typeof row.component, 'function')

  // The row is a factory component: it must render an element for owner props.
  const icon = row.component({ size: 16, active: false })
  assert.equal(typeof icon, 'object')
  assert.ok(icon !== null)

  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})

test('client bundle: contains no undeclared module globals', async () => {
  const source = await readFile(CLIENT_FILE, 'utf8')
  assert.equal(/\bmodule\.exports\b/.test(source), false, 'must not use module.exports')
  assert.equal(/^\s*exports\./m.test(source), false, 'must not use bare exports.*')
  assert.equal(/^\s*import\s/m.test(source), false, 'must not contain import statements')
  assert.equal(/^\s*export\s/m.test(source), false, 'must not contain export statements')
})