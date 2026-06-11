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
 *  - unmodeled `plugin:*` commands THROW (mirroring the runtime rejection)
 *    and log a structured warning;
 *  - modeled `plugin:*` commands (PLUGIN_HANDLERS) resolve without warning;
 *  - unknown NON-plugin commands keep the warn-and-return-`null` drift
 *    signal (FE-H-13, asserted in `handlers-drift.test.ts`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from '../../logger'
import { dispatch, PLUGIN_HANDLERS } from '../handlers'

vi.mock('../../logger', () => ({
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
    expect(() => dispatch(cmd, {})).toThrowError(`plugin ${pluginName} not found`)
  })

  it('logs a structured warning naming the rejected command', () => {
    const warned = vi.mocked(logger.warn)
    expect(() => dispatch('plugin:autostart|is_enabled', {})).toThrowError()
    expect(warned).toHaveBeenCalledWith(
      'TauriMock',
      'unmodeled plugin command — rejecting like the real runtime',
      { command: 'plugin:autostart|is_enabled' },
    )
  })

  it('a plugin command with no | separator still rejects with the full name', () => {
    expect(() => dispatch('plugin:bogus', {})).toThrowError('plugin bogus not found')
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
    'plugin:deep-link|get_current',
    'plugin:clipboard-manager|write_text',
    'plugin:shell|open',
    'plugin:opener|open_url',
    'plugin:global-shortcut|register',
    'plugin:global-shortcut|unregister',
  ])('%s resolves null without warning', (cmd) => {
    expect(dispatch(cmd, {})).toBeNull()
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled()
  })

  it('plugin:global-shortcut|is_registered resolves false (no chord ever bound in the mock)', () => {
    expect(dispatch('plugin:global-shortcut|is_registered', { shortcut: 'CmdOrCtrl+Alt+N' })).toBe(
      false,
    )
  })

  it('every PLUGIN_HANDLERS key is plugin:-prefixed (app commands belong in HANDLERS)', () => {
    for (const key of Object.keys(PLUGIN_HANDLERS)) {
      expect(key.startsWith('plugin:')).toBe(true)
    }
  })
})
