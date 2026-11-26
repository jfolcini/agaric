/**
 * #760 — plugin-command rejection semantics for the tauri-mock dispatcher.
 *
 * The real Tauri runtime REJECTS an invoke against an unregistered plugin
 * ("plugin <name> not found"). Before #760 the mock returned `null` for
 * every unknown command INCLUDING `plugin:*`, so the designed degradation
 * branches (AutostartRow's rejection→hide, `ensureNotificationPermission`'s
 * catch→`false`, the updater boot check's silent-warn path) were never
 * exercised in browser dev / Playwright.
 *
 * Contract under test:
 *  - unmodeled `plugin:*` commands THROW (mirroring the runtime rejection);
 *    an unknown plugin logs a structured warning, one rejected by design
 *    does not;
 *  - modeled `plugin:*` commands (PLUGIN_HANDLERS) resolve without warning;
 *  - unknown NON-plugin commands keep the warn-and-return-`null` drift
 *    signal (FE-H-13, asserted in `handlers-drift.test.ts`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from '@/lib/logger'
import { dispatch, PLUGIN_HANDLERS } from '@/lib/tauri-mock/handlers'
import { MOCK_APP_VERSION } from '@/lib/tauri-mock/seed'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

describe('dispatch — unmodeled plugin:* commands reject (#760)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    // AutostartRow's rejection→hide branch (mobile / browser-dev path).
    ['plugin:autostart|is_enabled', 'autostart'],
    ['plugin:autostart|enable', 'autostart'],
    ['plugin:autostart|disable', 'autostart'],
    // ensureNotificationPermission's catch→false degradation.
    ['plugin:notification|is_permission_granted', 'notification'],
    ['plugin:notification|request_permission', 'notification'],
    // Updater boot check's silent-warn path — `null` would otherwise fake
    // a successful "no update" round-trip.
    ['plugin:updater|check', 'updater'],
    // relaunchApp's window.location.reload() fallback.
    ['plugin:process|restart', 'process'],
  ])('%s throws "plugin %s not found"', (cmd, pluginName) => {
    expect(() => dispatch(cmd, {})).toThrow(`plugin ${pluginName} not found`)
  })

  it('warns of drift for a plugin it does not know, naming the command', () => {
    const warned = vi.mocked(logger.warn)
    expect(() => dispatch('plugin:bogus|run', {})).toThrow('plugin bogus not found')
    expect(warned).toHaveBeenCalledWith(
      'TauriMock',
      'unmodeled plugin command — rejecting like the real runtime',
      { command: 'plugin:bogus|run' },
    )
  })

  it.each([
    'plugin:autostart|is_enabled',
    'plugin:notification|is_permission_granted',
    'plugin:updater|check',
    'plugin:process|restart',
  ])('rejects %s by design, without a drift warning', (cmd) => {
    expect(() => dispatch(cmd, {})).toThrow()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('a plugin command with no | separator still rejects with the full name', () => {
    expect(() => dispatch('plugin:bogus', {})).toThrow('plugin bogus not found')
  })
})

describe('dispatch — modeled plugin:* commands resolve (#760)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('plugin:event|listen returns a fresh numeric event id per call', () => {
    const first = dispatch('plugin:event|listen', { event: 'sync-status', handler: 1 })
    const second = dispatch('plugin:event|listen', { event: 'sync-status', handler: 2 })
    expect(typeof first).toBe('number')
    expect(typeof second).toBe('number')
    expect(second).not.toBe(first)
  })

  it.each([
    'plugin:event|unlisten',
    'plugin:event|emit',
    'plugin:app|register_listener',
    'plugin:app|remove_listener',
    'plugin:window|set_title',
    'plugin:webview|set_webview_zoom',
    'plugin:deep-link|get_current',
    'plugin:clipboard-manager|write_text',
    'plugin:opener|open_url',
    'plugin:global-shortcut|register',
    'plugin:global-shortcut|unregister',
  ])('%s resolves null without warning', (cmd) => {
    expect(dispatch(cmd, {})).toBeNull()
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled()
  })

  it('plugin:app|version answers the mock app version, as getVersion() does on a build', () => {
    expect(dispatch('plugin:app|version', {})).toBe(MOCK_APP_VERSION)
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled()
  })

  it('plugin:window|title answers the title set_title last gave the window', () => {
    dispatch('plugin:window|set_title', { label: 'main', value: 'Notes · Work · Agaric' })
    expect(dispatch('plugin:window|title', { label: 'main' })).toBe('Notes · Work · Agaric')
    dispatch('plugin:window|set_title', { label: 'main', value: 'Pages · Work · Agaric' })
    expect(dispatch('plugin:window|title', { label: 'main' })).toBe('Pages · Work · Agaric')
  })

  it('every PLUGIN_HANDLERS key is plugin:-prefixed (app commands belong in HANDLERS)', () => {
    for (const key of Object.keys(PLUGIN_HANDLERS)) {
      expect(key.startsWith('plugin:')).toBe(true)
    }
  })
})
