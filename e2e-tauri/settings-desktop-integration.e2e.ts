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
// Two cases press the default chord before the rebind: a day Quick Capture
// creates carries the journal template (#5395), whose copy lives in the backend
// (it used to be the journal view's, so a day first created by Quick Capture or
// an agent stayed empty); the case makes a template, deletes today's page and
// captures into the missing day without leaving the dialog. And the chord
// pressed with the window minimized, the way it is pressed from another app,
// raises it and captures onto today (#5735).
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  expectAbsent,
  isoDay,
  navigateTo,
  openNewPage,
  openSettingsTab,
  pressChord,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const APP =
  process.env['TAURI_APP_BINARY'] ??
  path.resolve(import.meta.dirname, '..', 'src-tauri', 'target', 'debug', 'agaric')
const AUTOSTART_ENTRY = path.join(os.homedir(), '.config', 'autostart', 'Agaric.desktop')
// Not `*.desktop`, so the session never starts it while it is set aside.
const AUTOSTART_BACKUP = `${AUTOSTART_ENTRY}.wdio-backup`
const AUTOSTART_SWITCH = '#autostart-toggle'

const TEMPLATE = runScopedMarker('wdio-jtpl-template')
const CAPTURE = runScopedMarker('wdio-jtpl-capture')
const TEMPLATE_BLOCK = `[data-testid="block-static"]*=${TEMPLATE}`
const HOTKEY_NOTE = runScopedMarker('wdio-jtpl-hotkey')

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

async function waitForWindowFocus(focused: boolean, why: string): Promise<void> {
  await browser.waitUntil(
    async () => (await browser.execute(() => document.hasFocus())) === focused,
    { timeout: ACTION_TIMEOUT, timeoutMsg: why },
  )
}

describe('Agaric real-backend Settings rows that reach the OS (#5741) @settings @editor @journal', () => {
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

  it('a day Quick Capture creates carries the journal template (#5395)', async () => {
    await waitForAppReady()

    // 1. The template: a page with one block, flagged from the page kebab.
    await openNewPage()
    await typeMarkerVerified(TEMPLATE)
    const kebab = $('button[aria-label="Page actions"]')
    await kebab.waitForClickable({ timeout: ACTION_TIMEOUT })
    await kebab.click()
    const setTemplate = $('button*=Set as journal template')
    await setTemplate.waitForClickable({ timeout: ACTION_TIMEOUT })
    await setTemplate.click()
    await waitForToast('Set as journal template')

    // 2. Today's page was auto-created at boot, before the template existed:
    //    delete it so Quick Capture is the one to create the day.
    await navigateTo('Journal')
    const deletePage = $('button[aria-label="Delete page"]')
    await deletePage.waitForClickable({ timeout: ACTION_TIMEOUT })
    await deletePage.click()
    const confirm = $('[role="alertdialog"]').$('button*=Delete page')
    await confirm.waitForClickable({ timeout: ACTION_TIMEOUT })
    await confirm.click()
    await $('h2*=No blocks for').waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await expectAbsent(TEMPLATE_BLOCK, 'the template block before the capture')

    // 3. Capture into the missing day through the OS chord. The phone-width
    //    FAB shows on a touch screen only, which this webview has not.
    pressChord('ctrl+alt+n')
    const textarea = $('[data-testid="quick-capture-textarea"]')
    await textarea.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await textarea.setValue(CAPTURE)
    const save = $('[data-testid="quick-capture-save"]')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await textarea.waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })

    // 4. The day, re-read after a nav round-trip: the template first, the
    //    capture after it.
    await navigateTo('Pages')
    await navigateTo('Journal')
    const template = blockStaticByMarker(TEMPLATE)
    await template.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const capture = blockStaticByMarker(CAPTURE)
    await capture.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const order = await browser.execute(
      (t: string, c: string) => {
        const rows = [...document.querySelectorAll('[data-testid="block-static"]')]
        return [
          rows.findIndex((r) => r.textContent?.includes(t)),
          rows.findIndex((r) => r.textContent?.includes(c)),
        ]
      },
      TEMPLATE,
      CAPTURE,
    )
    const [templateAt = -1, captureAt = -1] = order
    expect(templateAt).toBeGreaterThanOrEqual(0)
    expect(captureAt).toBeGreaterThan(templateAt)
  })

  it('the OS hotkey captures onto today from a minimized window (#5735)', async () => {
    await waitForAppReady()
    execFileSync('xdotool', ['getactivewindow', 'windowminimize'])
    await waitForWindowFocus(false, 'the app window still has focus after minimizing it')

    pressChord('ctrl+alt+n')
    await $('[data-testid="quick-capture-dialog"]').waitForExist({ timeout: ACTION_TIMEOUT })
    await waitForWindowFocus(true, 'the hotkey opened Quick Capture without raising the window')
    const textarea = '[data-testid="quick-capture-textarea"]'
    await $(textarea).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await typeInputVerified(textarea, HOTKEY_NOTE)
    const save = $('[data-testid="quick-capture-save"]')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await $(textarea).waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })

    await navigateTo('Pages')
    await navigateTo('Journal')
    const today = $(`section[id="journal-${isoDay(new Date())}"]`)
    await today.$(`[data-testid="block-static"]*=${HOTKEY_NOTE}`).waitForDisplayed({
      timeout: NAV_TIMEOUT,
    })
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
