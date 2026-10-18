// ---------------------------------------------------------------------------
// Real-backend Settings rows that reach outside the app (#5741): launch at
// login and the Quick Capture system-wide hotkey. The mock implements
// neither plugin, so only this lane shows the OS side of either.
//
// Launch at login: `tauri-plugin-autostart` writes the XDG autostart entry
// `~/.config/autostart/Agaric.desktop` under the REAL home (`auto-launch`
// resolves it with `dirs::home_dir()`, which the sandbox's XDG variables do
// not move), so a developer's own entry is moved aside for the run and put
// back after it.
//
// Quick Capture: `tauri-plugin-global-shortcut` grabs the chord at the X
// server, so the spec presses it there with `xdotool` (XTEST), not through
// WebDriver, whose keys go only to the focused webview. The plugin's
// `is_registered` is not granted to the window (`capabilities/desktop.json`),
// so the wait for the new binding is the dialog itself. The chosen chord lives
// in the webview's localStorage, which sits in this file's sandbox, and the
// grab ends with the app, so nothing is restored afterwards.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  navigateTo,
  openSettingsTab,
  pressChord,
  typeInputVerified,
  waitForAppReady,
} from './helpers'

const APP =
  process.env['TAURI_APP_BINARY'] ??
  path.resolve(import.meta.dirname, '..', 'src-tauri', 'target', 'debug', 'agaric')
const AUTOSTART_ENTRY = path.join(os.homedir(), '.config', 'autostart', 'Agaric.desktop')
// Not `*.desktop`, so the session never starts it while it is set aside.
const AUTOSTART_BACKUP = `${AUTOSTART_ENTRY}.wdio-backup`
const AUTOSTART_SWITCH = '#autostart-toggle'

const QUICK_CAPTURE_DIALOG = '[data-testid="quick-capture-dialog"]'
const BINDING = '[data-testid="quick-capture-shortcut-binding"]'
const NEW_CHORD = 'Ctrl+Alt+J'
// How long a chord press is given to open the dialog; the new chord is held
// to the same window, so the old chord's silence within it means something.
const CHORD_WINDOW_MS = 5_000

/** Whether the Quick Capture dialog opens within `CHORD_WINDOW_MS` of pressing `chord`. */
async function chordOpensDialog(chord: string): Promise<boolean> {
  pressChord(chord)
  return $(QUICK_CAPTURE_DIALOG)
    .waitForDisplayed({ timeout: CHORD_WINDOW_MS })
    .then(
      () => true,
      () => false,
    )
}

async function closeQuickCapture(): Promise<void> {
  const cancel = $('[data-testid="quick-capture-cancel"]')
  await cancel.waitForClickable({ timeout: ACTION_TIMEOUT })
  await cancel.click()
  await $(QUICK_CAPTURE_DIALOG).waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
}

/** Click the launch-at-login switch and wait until it reads `checked` with its round-trip done. */
async function toggleAutostart(checked: boolean): Promise<void> {
  const toggle = $(AUTOSTART_SWITCH)
  await toggle.waitForClickable({ timeout: ACTION_TIMEOUT })
  await toggle.click()
  await browser.waitUntil(
    async () =>
      (await toggle.getAttribute('aria-checked')) === String(checked) && (await toggle.isEnabled()),
    {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `the launch-at-login switch never settled at ${checked}`,
    },
  )
}

/** The re-mounted General tab's launch-at-login switch state, once `is_enabled` has answered. */
async function autostartShownAfterRoundTrip(): Promise<string | null> {
  await navigateTo('Journal')
  await openSettingsTab('general')
  const toggle = $(AUTOSTART_SWITCH)
  await toggle.waitForDisplayed({ timeout: NAV_TIMEOUT })
  return toggle.getAttribute('aria-checked')
}

describe('Agaric real-backend Settings rows that reach the OS (#5741) @settings', () => {
  before(async () => {
    // A backup left by a killed run is the developer's entry; the entry beside it is that run's.
    if (existsSync(AUTOSTART_BACKUP)) rmSync(AUTOSTART_ENTRY, { force: true })
    else if (existsSync(AUTOSTART_ENTRY)) renameSync(AUTOSTART_ENTRY, AUTOSTART_BACKUP)
    await waitForAppReady()
  })

  after(() => {
    rmSync(AUTOSTART_ENTRY, { force: true })
    if (existsSync(AUTOSTART_BACKUP)) renameSync(AUTOSTART_BACKUP, AUTOSTART_ENTRY)
  })

  it('launch at login writes the autostart entry for this binary and removes it again', async () => {
    await openSettingsTab('general')
    await $(AUTOSTART_SWITCH).waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await $(AUTOSTART_SWITCH).getAttribute('aria-checked')).toBe('false')

    await toggleAutostart(true)
    await browser.waitUntil(() => Promise.resolve(existsSync(AUTOSTART_ENTRY)), {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `the switch is on, but ${AUTOSTART_ENTRY} was never written`,
    })
    const exec = readFileSync(AUTOSTART_ENTRY, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('Exec='))
    expect(exec).toBe(`Exec=${realpathSync(APP)} --silent`)
    expect(await autostartShownAfterRoundTrip()).toBe('true')

    await toggleAutostart(false)
    await browser.waitUntil(() => Promise.resolve(!existsSync(AUTOSTART_ENTRY)), {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `the switch is off, but ${AUTOSTART_ENTRY} is still there`,
    })
    expect(await autostartShownAfterRoundTrip()).toBe('false')
  })

  it('a rebound Quick Capture hotkey opens the dialog system-wide and the old one no longer does', async () => {
    await openSettingsTab('keyboard')
    await $(BINDING).waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await $(BINDING).getText()).toBe('Ctrl+Alt+N')

    const edit = $('[data-testid="quick-capture-shortcut-edit"]')
    await edit.waitForClickable({ timeout: ACTION_TIMEOUT })
    await edit.click()
    const input = '[data-testid="quick-capture-shortcut-input"]'
    await $(input).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await $(input).click()
    await browser.keys(['Control', 'a'])
    await browser.keys(['Delete'])
    await typeInputVerified(input, NEW_CHORD)
    await $('[data-testid="quick-capture-shortcut-save"]').click()
    await browser.waitUntil(async () => (await $(BINDING).getText()) === NEW_CHORD, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `the row never showed the saved chord ${NEW_CHORD}`,
    })

    await navigateTo('Journal')
    await openSettingsTab('keyboard')
    await $(BINDING).waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await $(BINDING).getText()).toBe(NEW_CHORD)

    // The live binding moves after Save resolves (`useQuickCaptureShortcut`
    // re-registers on the storage event), so press until it has.
    await browser.waitUntil(() => chordOpensDialog('ctrl+alt+j'), {
      timeout: NAV_TIMEOUT,
      interval: 1_000,
      timeoutMsg: `${NEW_CHORD} pressed at the X server never opened Quick Capture`,
    })
    await closeQuickCapture()

    expect(await chordOpensDialog('ctrl+alt+n')).toBe(false)
    expect(await chordOpensDialog('ctrl+alt+j')).toBe(true)
    await closeQuickCapture()
  })
})
