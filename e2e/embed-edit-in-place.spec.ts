import type { Page } from '@playwright/test'

import {
  activeSuggestionList,
  expect,
  openPage,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

/**
 * `{{embed …}}` edit-in-place, behind the per-embed unlock (#4550, phase 2).
 *
 * The durable effect this spec is here for: an edit made INSIDE an embed on
 * one page lands on the page that actually owns the block. So it does not
 * assert on the embed's own rendering after typing — that would pass even if
 * the write went nowhere but the local store — it navigates to the SOURCE
 * page and reads the block there, then comes back.
 *
 * It also pins invariant 4 at runtime: while a row inside the embed is being
 * edited there is exactly ONE editing surface in the document, the host
 * tree's. A second `<EditorContent>` mounted by the embed would show up here
 * as two.
 *
 * Seed data (`src/lib/tauri-mock/seed.ts`):
 *   PAGE_GETTING_STARTED ("Getting Started") — GS_1 is
 *     "Welcome to Agaric! This is your personal knowledge base."
 *   PAGE_QUICK_NOTES ("Quick Notes") — the host page used below.
 */

const EDITED = 'Edited from inside the embed'

/**
 * Blur the roving editor WITHOUT the `blurEditors` helper's leading Escape:
 * Escape is the discard-edit chord, and every edit this spec makes is the
 * thing under test.
 */
async function blurWithoutDiscarding(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await expect(page.locator('[data-testid="block-editor"]')).toHaveCount(0)
}

/** Write `{{embed ((GS_1))}}` into the focused block via the /embed picker. */
async function insertEmbedOfWelcomeBlock(page: Page): Promise<void> {
  await typeSlashCommand(page, 'embed')
  await page.keyboard.press('Enter')

  // `/embed` inserts the `{{embed ` trigger, which re-opens the same picker in
  // embed mode listing block and page targets.
  const targets = activeSuggestionList(page)
  await expect(targets).toBeVisible()
  await page.keyboard.type('Welcome')
  await expect(targets.locator('[data-testid="suggestion-item"]').first()).toBeVisible()
  await page.keyboard.press('Enter')
}

test.describe('embed edit-in-place', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('unlocking an embed edits the block on its own page, and the edit survives navigation', async ({
    page,
  }) => {
    await openPage(page, 'Quick Notes')
    // A fresh, empty block: an embed token has to be the block's ENTIRE
    // content (`parseEmbedToken` is anchored), so it cannot share a row.
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('[data-testid="block-editor"]')).toHaveCount(1)
    await insertEmbedOfWelcomeBlock(page)
    await blurWithoutDiscarding(page)

    const embed = page.locator('[data-testid="embed-container"]').first()
    await expect(embed).toBeVisible()
    const embeddedRow = embed.getByText('Welcome to Agaric!', { exact: false })
    await expect(embeddedRow).toBeVisible()

    // Locked: the row is inert — clicking it mounts nothing.
    await embeddedRow.click()
    await expect(page.locator('[data-testid="block-editor"]')).toHaveCount(0)

    await embed.getByRole('button', { name: 'Edit this embed in place' }).click()
    await expect(embed).toHaveClass(/embed-unlocked/)

    await embeddedRow.click()
    const editors = page.locator('[data-testid="block-editor"]')
    // Invariant 4 at runtime: the embed borrowed the host tree's roving
    // instance rather than mounting one of its own.
    await expect(editors).toHaveCount(1)
    const surface = editors.locator('[contenteditable="true"]')
    await expect(surface).toBeVisible()

    await page.keyboard.press('Control+a')
    await page.keyboard.type(EDITED)
    await blurWithoutDiscarding(page)
    await expect(embed.getByText(EDITED)).toBeVisible()

    // The durable effect: the write went to the EMBEDDED block's own page.
    await openPage(page, 'Getting Started')
    await expect(page.getByText(EDITED)).toBeVisible()

    // …and back. The embed re-renders the source's current content, and it
    // comes back LOCKED — the unlock is session-scoped and never persisted.
    // Back via the quick-access bar: by now "Quick Notes" also appears there,
    // so `openPage`'s exact-text click would hit two candidates.
    await page.getByTestId('quick-access-bar').getByRole('button', { name: 'Quick Notes' }).click()
    await expect(page.locator('[aria-label="Page title"]')).toContainText('Quick Notes')
    const embedAgain = page.locator('[data-testid="embed-container"]').first()
    await expect(embedAgain.getByText(EDITED)).toBeVisible()
    await expect(embedAgain).not.toHaveClass(/embed-unlocked/)
  })
})
