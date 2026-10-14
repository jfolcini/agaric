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
// press, so the capture goes through the phone-width FAB
// (`QuickCaptureFab`, shown below 768px): the window is narrowed for the
// capture and widened back before the journal is read.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  expectAbsent,
  navigateTo,
  openNewPage,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const TEMPLATE = runScopedMarker('wdio-jtpl-template')
const CAPTURE = runScopedMarker('wdio-jtpl-capture')
const TEMPLATE_BLOCK = `[data-testid="block-static"]*=${TEMPLATE}`

describe('Agaric real-backend journal template on a Quick Capture day (#5395)', () => {
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
})
