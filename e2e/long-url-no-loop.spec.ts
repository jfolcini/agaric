import {
  expect,
  focusBlock,
  getConsoleErrors,
  installIpcRecorder,
  openPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * #1489 — typing/pasting a very long single-line URL (or any long unbroken
 * token) into a block used to drive `EditableBlock`'s `setLiveContent` into a
 * React "Maximum update depth exceeded" loop. The loop is a real-browser
 * layout feedback effect that jsdom cannot reproduce (serialization is
 * idempotent and React already dedups identical state values), so this e2e is
 * the authoritative regression guard.
 *
 * The global `afterEach` in helpers.ts runs `expectNoConsoleErrors`, which
 * fails on the "Maximum update depth exceeded" React error. We also assert it
 * explicitly here so the failure message names the exact regression.
 */

const PAGE = 'Getting Started'

// A long unbroken token: long enough to force horizontal overflow / wrapping
// measurement in a real layout, which is what triggered the original loop.
// Kept to a few hundred chars so char-by-char typing stays inside the e2e
// timeout while still reliably reproducing the pre-fix loop.
const LONG_URL = `https://example.com/${'a'.repeat(300)}?q=${'b'.repeat(120)}`

test.describe('Long single-line URL does not loop the editor (#1489)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  test('typing a very long URL into a block does not throw a max-update-depth loop', async ({
    page,
  }) => {
    await openPage(page, PAGE)

    const editor = await focusBlock(page, 0)
    await editor.press('End')

    // `pressSequentially` types char-by-char, exercising the autolink + live
    // markdown-change path on every keystroke — the exact path that looped.
    await editor.pressSequentially(LONG_URL, { delay: 0 })

    // Let any deferred layout / transaction settling occur. If the loop were
    // present, this window is where React would tip over.
    await page.waitForTimeout(500)

    const errors = getConsoleErrors(page)
    const loopErrors = errors.filter((e) => e.includes('Maximum update depth'))
    expect(loopErrors, `max-update-depth loop on long URL:\n${loopErrors.join('\n')}`).toEqual([])

    // The editor is still alive and shows the typed text.
    await expect(editor).toContainText('example.com')
  })

  test('a [text](url) markdown link with a long URL does not loop', async ({ page }) => {
    await openPage(page, PAGE)

    const editor = await focusBlock(page, 0)
    await editor.press('End')

    // The issue reproduces with a plain markdown link too, not just bare URLs.
    await editor.pressSequentially(`[link](${LONG_URL})`, { delay: 0 })
    await page.waitForTimeout(500)

    const errors = getConsoleErrors(page)
    const loopErrors = errors.filter((e) => e.includes('Maximum update depth'))
    expect(
      loopErrors,
      `max-update-depth loop on long markdown link:\n${loopErrors.join('\n')}`,
    ).toEqual([])
    await expect(editor).toContainText('link')
  })
})
