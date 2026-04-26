/**
 * E2E coverage for BUG-1 — page creation flows route through the
 * `create_page_in_space` IPC so every new page lands with its `space`
 * property set atomically.
 *
 * The bug this spec guards against:
 *
 *   Pages created via `createBlock({ blockType: 'page' })` (without a
 *   space ULID) used to materialize in the blocks table without a
 *   `space` ref property. The PageBrowser's `list_blocks(blockType=page,
 *   spaceId=<active>)` query then silently skipped them and the user
 *   saw a Pages list shorter than reality. The journal day flow was
 *   the worst offender — every "Add block to today" leaked a page —
 *   followed by templates and the Welcome modal's onboarding samples.
 *
 * After the fix, all three callsites route through `createPageInSpace`
 * (frontend wrapper for the `create_page_in_space` Tauri IPC), and the
 * backend `create_block` IPC refuses `block_type='page'` without a
 * `space_id` argument as a defence-in-depth chokepoint.
 *
 * Each test below exercises one of the three production callsites
 * (JournalPage, TemplatesView, WelcomeModal) end-to-end, then asserts
 * the new page appears in the PageBrowser list.
 */

import { expect, test, waitForBoot } from './helpers'

/** Open the Pages view via the sidebar nav button. */
async function openPagesView(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Pages', exact: true }).click()
  await expect(page.getByRole('listbox')).toBeVisible()
}

/** Open the Templates view via the sidebar nav button. */
async function openTemplatesView(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Templates', exact: true }).click()
}

/** Open the Journal view via the sidebar nav button. */
async function openJournalView(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Journal', exact: true }).click()
}

test.describe('BUG-1 — page creation routes through create_page_in_space', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage so the WelcomeModal is allowed to render in the
    // welcome-flow test, and so cross-test mutations cannot bleed.
    await page.evaluate(() => window.localStorage.clear()).catch(() => {})
    await waitForBoot(page)
  })

  test('Welcome onboarding sample pages land in the active space PageBrowser list', async ({
    page,
  }) => {
    // Re-clear localStorage post-boot so the WelcomeModal flag is fresh
    // — `waitForBoot` can race with the modal's effect.
    await page.evaluate(() => window.localStorage.removeItem('agaric-onboarding-done'))
    await page.reload()
    await waitForBoot(page)

    // The modal renders on first boot. Click "Create sample pages".
    const sampleBtn = page.getByRole('button', { name: 'Create sample pages' })
    await expect(sampleBtn).toBeVisible()
    await sampleBtn.click()

    // The modal dismisses on success.
    await expect(sampleBtn).not.toBeVisible()

    // Both onboarding pages must show up in the active space's PageBrowser.
    await openPagesView(page)
    await expect(page.getByRole('option', { name: /Getting Started/ }).first()).toBeVisible()
    await expect(page.getByRole('option', { name: /Quick Tips/ }).first()).toBeVisible()
  })

  test('Journal "Add block to today" page lands in the active space PageBrowser list', async ({
    page,
  }) => {
    // Today's daily page is auto-created on Journal mount — that is the
    // production path under test (BUG-1 used to leak it). Wait for the
    // BlockTree to render to confirm the page exists.
    await openJournalView(page)
    await expect(page.locator('[data-testid="block-tree"]').first()).toBeVisible()

    // Format today's date YYYY-MM-DD so we can find it by content.
    const todayStr = await page.evaluate(() => {
      const d = new Date()
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      return `${y}-${m}-${day}`
    })

    // Open Pages — today's journal page must appear in the list.
    await openPagesView(page)
    // Match by exact date string in the page-list option name.
    await expect(page.getByRole('option', { name: new RegExp(todayStr) }).first()).toBeVisible()
  })

  test('Template created via Templates view lands in the active space PageBrowser list', async ({
    page,
  }) => {
    await openTemplatesView(page)

    const input = page.getByPlaceholder('New template name...')
    await expect(input).toBeVisible()
    await input.fill('Project Brief Template')

    const createBtn = page.getByRole('button', { name: /create template/i })
    await createBtn.click()

    // The new template appears in the Templates list (handleCreateTemplate
    // optimistically prepends it to the rendered list).
    await expect(page.getByText('Project Brief Template').first()).toBeVisible()

    // And it surfaces in the PageBrowser list scoped to the active space —
    // proving the new page carries the `space` property
    // (BUG-1 regression net: pre-fix, this assertion failed because the
    // template page was unscoped and the scoped `list_blocks` skipped it).
    await openPagesView(page)
    await expect(page.getByRole('option', { name: /Project Brief Template/ }).first()).toBeVisible()
  })
})
