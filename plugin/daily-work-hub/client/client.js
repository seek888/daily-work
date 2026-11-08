/**
 * daily-work-hub — Client half (plain-JS dynamic bundle, no build step).
 *
 * Format: `window.__ModuleLoader__.load({ id, factory })` where `factory` gets a
 * `require` bound to the host's module table. Only React is required here:
 * requiring Harness Client packages (ui-primitives etc.) is discouraged by the
 * plugin practices — they change without notice and a throw blanks the slot.
 *
 * M0 scope: one full-page panel (main key) + one sidebar row + a ping readout.
 */
window.__ModuleLoader__.load({
  id: 'daily-work-hub',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** Panel id — also the `main` slot key and the `sidebar.panellist` id. */
    const PANEL_ID = 'daily-work-hub'
    /** Services this half actually calls; everything else is looked up lazily. */
    const inject = ['slots']

    /** Endpoint registered by the Host half (`/api/daily-work/ping`). */
    const PING = 'api/daily-work/ping'

    /**
     * Resolve a plugin route against the page the UI is served from.
     * Root-absolute paths break under a reverse-proxy mount prefix, so anchor on
     * `document.baseURI` (the directory DSH serves its UI from).
     * @param {string} path route relative to the app root.
     * @returns {string} URL usable from `fetch`.
     */
    function api(path) {
      const relative = path.replace(/^\/+/, '')
      if (typeof document === 'undefined') return `/${relative}`
      return new URL(relative, document.baseURI).pathname
    }

    /** Small self-drawn icon: an inbox stack with an unread dot. */
    function HubIcon({ size, active }) {
      const dot = active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-bg-danger)'
      return h(
        'span',
        { style: { position: 'relative', display: 'inline-flex', width: size, height: size } },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            style: { color: 'var(--dsw-alias-label-secondary)' },
          },
          // tray body
          h('path', { d: 'M2.2 9.2h3l1 1.6h3.6l1-1.6h3' }),
          // tray bowl
          h('path', { d: 'M2.2 9.2 4 3.4h8l1.8 5.8v2.2a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2z' }),
        ),
        h('span', {
          style: {
            position: 'absolute',
            top: -1,
            right: -1,
            width: 5,
            height: 5,
            borderRadius: 3,
            background: dot,
          },
        }),
      )
    }

    /** One label/value row. */
    function Row({ label, value }) {
      return h(
        'div',
        { style: { display: 'flex', gap: 12, padding: '6px 0', fontSize: 13 } },
        h('span', { style: { width: 120, color: 'var(--dsw-alias-label-secondary)', flex: 'none' } }, label),
        h('span', { style: { color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-all' } }, value),
      )
    }

    /** The full-page panel. */
    function HubPanel() {
      const [state, setState] = React.useState({ phase: 'loading', body: null, error: null })

      const ping = React.useCallback(async () => {
        setState({ phase: 'loading', body: null, error: null })
        try {
          const response = await fetch(api(PING), { cache: 'no-store' })
          const text = await response.text()
          let body = null
          try {
            body = text === '' ? null : JSON.parse(text)
          } catch {
            body = null
          }
          if (!response.ok) {
            setState({
              phase: 'error',
              body,
              error: `HTTP ${response.status} ${body?.error ?? ''}`.trim(),
            })
            return
          }
          setState({ phase: 'ok', body, error: null })
        } catch (error) {
          setState({ phase: 'error', body: null, error: String(error?.message ?? error) })
        }
      }, [])

      React.useEffect(() => {
        void ping()
      }, [ping])

      const badge = {
        loading: { text: '检测中…', color: 'var(--dsw-alias-label-secondary)' },
        ok: { text: '已连通', color: 'var(--dsw-alias-label-primary)' },
        error: { text: '未连通', color: 'var(--dsw-alias-bg-danger)' },
      }[state.phase]

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            height: '100%',
            overflow: 'auto',
            padding: '24px 32px',
            background: 'var(--dsw-alias-bg-base)',
            color: 'var(--dsw-alias-label-primary)',
            boxSizing: 'border-box',
          },
        },
        h(
          'header',
          { style: { display: 'flex', alignItems: 'baseline', gap: 12 } },
          h('h1', { style: { margin: 0, fontSize: 20, fontWeight: 600 } }, '日常工作台'),
          h('span', { style: { fontSize: 12, color: badge.color, fontWeight: 500 } }, badge.text),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              type: 'button',
              onClick: () => void ping(),
              style: {
                cursor: 'pointer',
                border: '1px solid var(--dsw-alias-border-l3)',
                background: 'var(--dsw-alias-bg-elevated)',
                color: 'var(--dsw-alias-label-primary)',
                borderRadius: 6,
                padding: '4px 12px',
                fontSize: 13,
              },
            },
            '重新检测',
          ),
        ),
        h(
          'p',
          { style: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } },
          'M0 骨架：验证 Host 路由 + 面板接入。GitLab 轮询、审查队列、一键 AI 审查为后续里程碑。',
        ),
        h(
          'section',
          {
            style: {
              border: '1px solid var(--dsw-alias-border-l3)',
              borderRadius: 8,
              padding: '12px 16px',
              background: 'var(--dsw-alias-bg-elevated)',
            },
          },
          h(Row, { label: 'Host 路由', value: api(PING) }),
          h(Row, { label: '状态', value: badge.text }),
          h(Row, { label: '版本', value: state.body?.version ?? '—' }),
          h(Row, { label: '实例', value: state.body?.instance ?? '—' }),
          h(Row, { label: '轮询间隔', value: state.body?.pollIntervalSec === undefined ? '—' : `${state.body.pollIntervalSec}s` }),
          h(Row, { label: 'Host 时间', value: state.body?.time ?? '—' }),
          state.error !== null && h(Row, { label: '错误', value: state.error }),
        ),
        h(
          'section',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h(
            'button',
            {
              type: 'button',
              onClick: () => {
                // Placeholder on purpose: M1 creates a real Session through the
                // Host (`ctx.agents.create` + `agent.followup`) and switches the
                // centre column back with `ctx.layout.selectPanel(null)`.
                console.info(
                  '[daily-work-hub] “测试起会话”是占位按钮：M1 将由 Host 用 agents.create 建真实会话，',
                  '并经 layout.selectPanel(null) 把中央面板切回 Conversation。',
                )
              },
              style: {
                cursor: 'pointer',
                border: '1px solid var(--dsw-alias-border-l3)',
                background: 'var(--dsw-alias-bg-base)',
                color: 'var(--dsw-alias-label-primary)',
                borderRadius: 6,
                padding: '6px 12px',
                fontSize: 13,
              },
            },
            '测试起会话（占位）',
          ),
          h(
            'span',
            { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            '当前只打印控制台说明，不创建会话。',
          ),
        ),
      )
    }

    /**
     * Client plugin body.
     * @param {any} ctx client root context.
     */
    function apply(ctx) {
      // Panel first: `layout.selectPanel(id)` throws unless a `main` entry with
      // that key is registered, so the panel registration must stay ahead of any
      // programmatic switch.
      const offPanel = ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
          },
          HubPanel,
        ),
      )

      const offRow = ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 1,
            label: () => '日常工作台',
          },
          // owner props from PanelRow: `{ size, active }` (16/18px, selection flag).
          (owner = {}) => h(HubIcon, { size: owner.size ?? 16, active: owner.active === true }),
        ),
      )

      return () => {
        // Order matters: if this panel is the active one, clear the selection
        // before its `main` entry disappears, or the centre column keeps an id
        // that no longer resolves.
        const layout = ctx.get('layout')
        try {
          if (layout?.panelInfo?.getSnapshot?.().activePanelId === PANEL_ID) layout.selectPanel(null)
        } catch {
          /* layout may already be gone during teardown */
        }
        if (typeof offRow === 'function') offRow()
        if (typeof offPanel === 'function') offPanel()
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})