// ---------------------------------------------------------------------------
// Real-backend journal template on a day Quick Capture creates (#5395).
//
// The journal template used to be copied by the frontend, and only when the
// journal view itself created the day: a day first created by Quick Capture
// (or an agent) stayed empty, and opening it later added nothing because the
// page already existed. The copy now lives in the backend, so this spec makes
// a template, deletes today's page, captures into the (now missing) day
// without ever leaving the capture dialog, and asserts the template arrived
// with the capture when the journal is opened.
//
// Quick Capture's desktop trigger is an OS-level chord the WebDriver cannot
// press, so that capture goes through the phone-width FAB
// (`QuickCaptureFab`, shown below 768px): the window is narrowed for the
// capture and widened back before the journal is read.
//
// The second case presses the default chord at the X server (`pressChord`)
// with the window minimized, the way it is pressed from another app, and
// asserts the capture lands on today.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  expectAbsent,
  navigateTo,
  openNewPage,
  pressChord,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const TEMPLATE = runScopedMarker('wdio-jtpl-template')
const CAPTURE = runScopedMarker('wdio-jtpl-capture')
const TEMPLATE_BLOCK = `[data-testid="block-static"]*=${TEMPLATE}`
const HOTKEY_NOTE = runScopedMarker('wdio-jtpl-hotkey')

/** Today as the local `YYYY-MM-DD` the journal names a day by. */
function todayIso(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function waitForWindowFocus(focused: boolean, why: string): Promise<void> {
  await browser.waitUntil(
    async () => (await browser.execute(() => document.hasFocus())) === focused,
    { timeout: ACTION_TIMEOUT, timeoutMsg: why },
  )
}

describe('Agaric real-backend Quick Capture and the journal template (#5395, #5735)', () => {
  it('a day Quick Capture creates carries the journal template', async () => {
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

    // 3. Capture into the missing day through the phone-width FAB.
    const desktop = await browser.getWindowSize()
    await browser.setWindowSize(600, 900)
    try {
      const fab = $('[data-testid="quick-capture-fab"]')
      await fab.waitForClickable({ timeout: ACTION_TIMEOUT })
      await fab.click()
      const textarea = $('[data-testid="quick-capture-textarea"]')
      await textarea.waitForDisplayed({ timeout: ACTION_TIMEOUT })
      await textarea.setValue(CAPTURE)
      const save = $('[data-testid="quick-capture-save"]')
      await save.waitForClickable({ timeout: ACTION_TIMEOUT })
      await save.click()
      await textarea.waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
    } finally {
      await browser.setWindowSize(desktop.width, desktop.height)
    }

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

  it('the OS hotkey captures onto today from a minimized window', async () => {
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
    const today = $(`section[id="journal-${todayIso()}"]`)
    await today.$(`[data-testid="block-static"]*=${HOTKEY_NOTE}`).waitForDisplayed({
      timeout: NAV_TIMEOUT,
    })
  })
})
