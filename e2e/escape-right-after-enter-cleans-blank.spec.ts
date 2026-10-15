import { expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * Escape pressed right after Enter leaves no blank block behind.
 *
 * On the real backend Escape can land while Enter's `create_block` is still in
 * flight: it acts on the source block and clears focus. Once the create
 * answered, Enter used to focus the new blank block anyway, so the editor came
 * back after Escape and no later focus change ever left the block for the
 * empty-block cleanup. The mock answers synchronously, so the create is held
 * test-side until Escape has landed.
 */

type HoldWindow = Window & {
  __TAURI_INTERNALS__?: Record<string, unknown>
  /** The next `create_block` answer waits for `__releaseCreate`. */
  __holdCreate?: boolean
  __releaseCreate?: () => void
}

const TEXT = 'quick escape'

test('Escape during the create of the block Enter made drops that blank block', async ({
  page,
}) => {
  await waitForBoot(page)
  await navigateToView(page, 'Journal')
  await page.evaluate(() => {
    const w = window as HoldWindow
    const internals = w.__TAURI_INTERNALS__
    if (!internals) throw new Error('no __TAURI_INTERNALS__ to hold create_block in')
    const original = internals['invoke'] as (cmd: string, args: unknown, opts?: unknown) => unknown
    internals['invoke'] = async (cmd: string, args: unknown, opts?: unknown) => {
      const result = await original(cmd, args, opts)
      if (cmd === 'create_block' && w.__holdCreate) {
        w.__holdCreate = false
        await new Promise<void>((resolve) => {
          w.__releaseCreate = resolve
        })
      }
      return result
    }
  })

  // A fresh day: "Add your first block" seeds the day's only block.
  await page.getByRole('button', { name: 'Next day' }).click()
  await page.getByRole('button', { name: 'Add your first block' }).click()
  const rows = page.locator('[data-testid="sortable-block"]')
  const editor = page.locator('[data-testid="block-editor"]')
  await expect(editor).toBeVisible()
  await expect(rows).toHaveCount(1)
  await page.getByRole('textbox', { name: 'Block editor' }).pressSequentially(TEXT, { delay: 10 })

  await page.evaluate(() => {
    ;(window as HoldWindow).__holdCreate = true
  })
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => (window as HoldWindow).__releaseCreate !== undefined)
  await page.keyboard.press('Escape')
  await page.evaluate(() => (window as HoldWindow).__releaseCreate?.())

  await expect(rows.filter({ hasText: TEXT })).toHaveCount(1)
  await expect(editor).toHaveCount(0)
  await expect(rows).toHaveCount(1)

  // Durable: the day re-read from the backend holds only the typed block.
  await navigateToView(page, 'Pages')
  await navigateToView(page, 'Journal')
  await expect(rows.filter({ hasText: TEXT })).toHaveCount(1)
  await expect(rows).toHaveCount(1)
})
