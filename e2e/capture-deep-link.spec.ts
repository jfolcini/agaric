import type { Page } from '@playwright/test'

import {
  clearConsoleErrors,
  emitMockEvent,
  expect,
  navigateToView,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E — `agaric://capture?text=…` opens Quick Capture holding the text (#6555).
 *
 * The link never saves: the user presses Capture, and the block lands in
 * today's journal. Two deliveries reach the dialog:
 *   - app running: the Rust router's `deeplink:capture` event, fired here
 *     through `__emitMockEvent`;
 *   - app launched by the link: the launch URL `useDeepLinkRouter` backfills
 *     from `getCurrent()`, which the mock answers from
 *     `localStorage['__mockLaunchUrl']`, set before boot.
 */

const field = (page: Page) => page.getByRole('textbox', { name: 'Quick capture content' })
const dialog = (page: Page) => page.getByTestId('quick-capture-dialog')

/** Leave the journal and come back, so what it shows is re-queried. */
async function reopenJournal(page: Page): Promise<void> {
  await navigateToView(page, 'Pages')
  await navigateToView(page, 'Journal')
}

test.describe('capture deep link (#6555) @journal @boot', () => {
  test('a link opens Quick Capture holding its text; only Capture saves it', async ({ page }) => {
    const text = 'Read later: the capture link'
    await waitForBoot(page)

    await emitMockEvent(page, 'deeplink:capture', { kind: 'prefill', text })
    await expect(field(page)).toHaveValue(text)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toBeHidden()
    await reopenJournal(page)
    await expect(page.getByText(text, { exact: true })).toHaveCount(0)

    await emitMockEvent(page, 'deeplink:capture', { kind: 'prefill', text })
    await expect(field(page)).toHaveValue(text)
    await dialog(page).getByRole('button', { name: 'Capture', exact: true }).click()
    await expect(page.getByText("Captured to today's journal")).toBeVisible()
    await reopenJournal(page)
    await expect(page.getByText(text, { exact: true })).toBeVisible()
  })

  test('a link that launches the app opens Quick Capture once it has booted', async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem('__mockLaunchUrl', 'agaric://capture?text=Captured%20on%20launch'),
    )
    await waitForBoot(page)

    await expect(field(page)).toHaveValue('Captured on launch')
    await dialog(page).getByRole('button', { name: 'Capture', exact: true }).click()
    await expect(page.getByText("Captured to today's journal")).toBeVisible()
    await reopenJournal(page)
    await expect(page.getByText('Captured on launch', { exact: true })).toBeVisible()
  })
})

test.describe('a toast over an open dialog (#7165) @journal', () => {
  test('its close button dismisses the toast and leaves the dialog open @mock-only', async ({
    page,
  }) => {
    await waitForBoot(page)
    await page.evaluate(() =>
      (
        window as unknown as { __injectMockError: (cmd: string, msg: string) => void }
      ).__injectMockError('quick_capture_block', 'disk full'),
    )
    await emitMockEvent(page, 'deeplink:capture', { kind: 'prefill', text: 'Will fail' })
    await dialog(page).getByRole('button', { name: 'Capture', exact: true }).click()
    const failure = page.locator('[data-sonner-toast]', { hasText: "Couldn't save quick capture" })
    await expect(failure).toBeVisible()
    clearConsoleErrors(page)

    // A press where the button is drawn, once the toast has slid in: under a
    // modal the body takes no pointer events.
    await failure.evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((slide) => slide.finished)),
    )
    const close = await failure.locator('[data-close-button]').boundingBox()
    expect(close).not.toBeNull()
    await page.mouse.click(
      (close?.x ?? 0) + (close?.width ?? 0) / 2,
      (close?.y ?? 0) + (close?.height ?? 0) / 2,
    )
    await expect(failure).toBeHidden()
    await expect(dialog(page)).toBeVisible()
    await expect(field(page)).toHaveValue('Will fail')
  })
})
