import type { Locator } from '@playwright/test'

import {
  activePopover,
  expect,
  focusBlockById,
  navigateToView,
  openPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * A custom hex typed into the Tags view's colour popover colours the tag, keeps
 * the popover open for tuning, and is still there after navigating away and
 * back, on the badge and on the tag's chip in a block. On the mock lane, not
 * `REAL_BACKEND_SPECS`: the colour lives in localStorage and the frontend.
 *
 * Seed (`SEED_IDS` in `src/lib/tauri-mock/seed.ts`): BLOCK_GS_4 on "Getting
 * Started" carries a `work` chip.
 */

const GS_4 = '0000000000000000000B10CK04'
const TEAL = '#1e8a7a'

/** The colour `tagColorStyle` paints a chip or badge in. */
function tagColor(el: Locator): () => Promise<string> {
  return () => el.evaluate((node: HTMLElement) => node.style.getPropertyValue('--tag-color'))
}

test('a custom tag colour typed as hex paints its badge and chips @pages @editor', async ({
  page,
}) => {
  await waitForBoot(page)
  await navigateToView(page, 'Tags')
  const row = page.getByRole('listitem').filter({ has: page.getByTestId('tag-item-work') })
  const badge = page.getByTestId('tag-item-work').locator('[data-slot="badge"]')

  await row.hover()
  await row.getByRole('button', { name: 'Set tag color', exact: true }).click()
  const popover = activePopover(page)
  await popover.getByRole('button', { name: 'Custom color', exact: true }).click()
  const hex = popover.getByRole('textbox', { name: 'Hex color', exact: true })
  await hex.fill('1E8A7A')
  await hex.press('Enter')

  await expect(hex).toHaveValue(TEAL)
  await expect.poll(tagColor(badge)).toBe(TEAL)
  await expect(popover.getByRole('radiogroup', { name: 'Color palette' })).toBeVisible()
  await page.keyboard.press('Escape')

  await openPage(page, 'Getting Started')
  const staticChip = page
    .locator(`[data-testid="block-static"][data-block-id="${GS_4}"]`)
    .getByTestId('tag-ref-chip')
    .filter({ hasText: 'work' })
  await expect.poll(tagColor(staticChip)).toBe(TEAL)
  const editorChip = (await focusBlockById(page, GS_4))
    .getByTestId('tag-ref-chip')
    .filter({ hasText: 'work' })
  await expect.poll(tagColor(editorChip)).toBe(TEAL)

  await navigateToView(page, 'Tags')
  await expect.poll(tagColor(badge)).toBe(TEAL)
})
