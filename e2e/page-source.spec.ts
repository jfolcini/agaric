import { activeDialog, expect, openPage, readClipboard, test, waitForBoot } from './helpers'

/**
 * E2E wiring spec for the "View as Markdown" page-source dialog (#5140 Phase 2).
 *
 * `PageSourceDialog` and the mock's `get_page_source` handler are unit-tested
 * on their own; nothing exercises the full UI path — kebab → menu item →
 * dialog → IPC → Copy → clipboard. This spec covers only that wiring, not the
 * markdown grammar itself (the mock handler is a DELIBERATE APPROXIMATION per
 * its own comment in `src/lib/tauri-mock/handlers/pages.ts`, and the real
 * grammar is a Rust concern).
 */

const PAGE = 'Getting Started'
// Seed: BLOCK_GS_1 ("Welcome to Agaric! ...") is PAGE_GETTING_STARTED's first
// child (position 0), rendered by `get_page_source` at depth 0 as
// `- <content> ^<id>` (seed.ts / handlers/pages.ts).
const GS1_SOURCE_LINE =
  '- Welcome to Agaric! This is your personal knowledge base. ^0000000000000000000BLOCK01'

test.describe('View as Markdown dialog (#5140 Phase 2)', () => {
  test.beforeEach(async ({ context, page }) => {
    // The Copy button writes through the real clipboard plugin (see
    // `readClipboard`); Chromium rejects that without explicit permission.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await waitForBoot(page)
    await openPage(page, PAGE)
  })

  test('opens from the page kebab, shows the markdown buffer, and copies it', async ({ page }) => {
    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'View as Markdown', exact: true }).click()

    const dialog = activeDialog(page)
    await expect(dialog.getByTestId('page-source-content')).toContainText(GS1_SOURCE_LINE)

    await dialog.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect.poll(() => readClipboard(page)).toContain(GS1_SOURCE_LINE)
  })
})
