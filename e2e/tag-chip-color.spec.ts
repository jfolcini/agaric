import type { Locator, Page } from '@playwright/test'

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
 * A colour picked for a tag in the Tags view paints that tag's chips: the
 * static chip, the editor chip and the chip on the tag's own page, and it is
 * still there after navigating away and back. In `e2e/` because the colour is
 * device-local and its paint is CSS that only a browser computes.
 *
 * Seed (`SEED_IDS` in `src/lib/tauri-mock/seed.ts`): BLOCK_GS_4 on "Getting
 * Started" carries a `work` chip.
 */

const GS_4 = '0000000000000000000BLOCK04'

interface Paint {
  color: string
  backgroundColor: string
}

/** A rose chip's paint as `tagColorStyle` (`src/lib/tag-colors.ts`) defines it. */
function rosePaint(page: Page): Promise<Paint> {
  return page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.setProperty('--tag-color', 'var(--accent-rose)')
    probe.style.color = 'color-mix(in oklab, var(--tag-color) 50%, var(--foreground))'
    probe.style.backgroundColor = 'color-mix(in oklab, var(--tag-color) 15%, transparent)'
    document.body.append(probe)
    const { color, backgroundColor } = getComputedStyle(probe)
    probe.remove()
    return { color, backgroundColor }
  })
}

async function expectPainted(chip: Locator, paint: Paint): Promise<void> {
  await expect(chip).toHaveCSS('color', paint.color)
  await expect(chip).toHaveCSS('background-color', paint.backgroundColor)
}

function workChip(scope: Locator): Locator {
  return scope.getByTestId('tag-ref-chip').filter({ hasText: 'work' })
}

test('a tag colour picked in the Tags view paints its chips @editor @pages', async ({ page }) => {
  await waitForBoot(page)
  await navigateToView(page, 'Tags')
  const row = page.getByRole('listitem').filter({ has: page.getByTestId('tag-item-work') })
  await row.getByRole('button', { name: 'Set tag color', exact: true }).click()
  await activePopover(page).getByRole('button', { name: 'rose', exact: true }).click()

  await openPage(page, 'Getting Started')
  const paint = await rosePaint(page)
  const staticBlock = page.locator(`[data-testid="block-static"][data-block-id="${GS_4}"]`)
  await expectPainted(workChip(staticBlock), paint)

  const editor = await focusBlockById(page, GS_4)
  await expectPainted(workChip(editor), paint)

  await navigateToView(page, 'Tags')
  await page.getByTestId('tag-item-work').click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText('work')
  const tagged = page.getByRole('region', { name: 'Blocks', exact: true })
  await expectPainted(workChip(tagged.locator(`[data-backlink-item="${GS_4}"]`)), paint)

  await tagged.getByRole('link', { name: 'Getting Started', exact: true }).click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
  await expectPainted(workChip(staticBlock), paint)
})
