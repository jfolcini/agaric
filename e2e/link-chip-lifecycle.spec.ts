import {
  activeAlertDialog,
  activeSuggestionList,
  blurEditors,
  deleteBlockViaContextMenu,
  expect,
  focusBlockById,
  navigateToView,
  openPage,
  showJournalPages,
  test,
  waitForBoot,
} from './helpers'

/**
 * Link chips follow their target's lifecycle (#5245, #5246, #5247, #5248).
 *
 * A `[[page]]` / `((block))` chip renders from the resolve cache, so every
 * test first renders the chip (warming the cache), then changes the target
 * somewhere the chip's page is not looking, then comes back to it. A chip that
 * only resolved after the change would pass whether or not the cache followed.
 *
 * Seed (src/lib/tauri-mock/seed.ts): Getting Started's GS_2 links
 * `[[Quick Notes]]`; Quick Notes' QN_1 links `[[Getting Started]]`; today's
 * journal page holds "Morning standup notes go here".
 */

const PAGE_GETTING_STARTED = '00000000000000000000PAGE01'
const BLOCK_GS_1 = '0000000000000000000BLOCK01'
const BLOCK_GS_2 = '0000000000000000000BLOCK02'
const BLOCK_GS_3 = '0000000000000000000BLOCK03'
const BLOCK_QN_1 = '0000000000000000000BLOCK08'
const BLOCK_QN_2 = '0000000000000000000BLOCK09'
const BLOCK_PROJ_1 = '0000000000000000000BLOCK13'
const PAGE_QUICK_NOTES = '00000000000000000000PAGE02'
const GS_1_TEXT = 'Welcome to Agaric! This is your personal knowledge base.'

type Page = import('@playwright/test').Page

interface MockWindow extends Window {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
  __emitMockEvent?: (event: string, payload?: unknown) => Promise<void>
}

/** Rewrite a block straight through the mock backend, as a peer or setup step would. */
async function editViaBackend(page: Page, blockId: string, toText: string): Promise<void> {
  await page.evaluate(
    ([id, text]) =>
      (window as unknown as MockWindow).__TAURI_INTERNALS__.invoke('edit_block', {
        blockId: id,
        toText: text,
      }),
    [blockId, toText] as const,
  )
}

/** The rendered (static) chip inside block `blockId`. */
function chipIn(page: Page, blockId: string, kind: 'block-link-chip' | 'block-ref-chip') {
  return page.locator(
    `[data-testid="block-static"][data-block-id="${blockId}"] [data-testid="${kind}"]`,
  )
}

async function openPagesView(page: Page): Promise<void> {
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Pages', exact: true })
    .click()
  await expect(page.getByRole('grid')).toBeVisible()
}

/** `openPage`, scoped to the Pages view's rows: once visited, a page is in the recents strip too. */
async function openFromPageList(page: Page, title: string): Promise<void> {
  await openPagesView(page)
  await page.locator('[data-page-item]').getByText(title, { exact: true }).click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

async function restoreAllFromTrash(page: Page): Promise<void> {
  await navigateToView(page, 'Trash')
  await page.getByTestId('trash-restore-all-btn').click()
  await activeAlertDialog(page).getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(page.getByText('Nothing in trash. Deleted items will appear here.')).toBeVisible()
}

test.describe('link chips follow their target', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a ((block)) chip shows the target block’s edited text (#5245)', async ({ page }) => {
    await editViaBackend(page, BLOCK_GS_3, `see ((${BLOCK_GS_1}))`)
    await openPage(page, 'Getting Started')
    const chip = chipIn(page, BLOCK_GS_3, 'block-ref-chip')
    await expect(chip).toContainText(GS_1_TEXT)

    await focusBlockById(page, BLOCK_GS_1)
    await page.keyboard.press('End')
    await page.keyboard.press('Shift+Home')
    await page.keyboard.type('Buy oat milk')
    await blurEditors(page)

    await expect(chip).toContainText('Buy oat milk')
    await expect(chip).not.toContainText('Welcome')
  })

  test('a ((block)) chip follows a peer’s edit to a block on another page (#5245)', async ({
    page,
  }) => {
    await editViaBackend(page, BLOCK_QN_2, `see ((${BLOCK_GS_1}))`)
    await openPage(page, 'Quick Notes')
    const chip = chipIn(page, BLOCK_QN_2, 'block-ref-chip')
    await expect(chip).toContainText(GS_1_TEXT)

    await editViaBackend(page, BLOCK_GS_1, 'Buy oat milk')
    await page.evaluate(
      (pageId) =>
        (window as unknown as MockWindow).__emitMockEvent?.('sync:complete', {
          type: 'complete',
          remote_device_id: 'device-b',
          ops_received: 1,
          ops_sent: 0,
          changed_blocks: 1,
          changed_page_ids: [pageId],
        }),
      PAGE_GETTING_STARTED,
    )

    await expect(chip).toContainText('Buy oat milk')
  })

  test('chips render deleted while their target is in the trash, live once restored (#5246)', async ({
    page,
  }) => {
    await editViaBackend(page, BLOCK_PROJ_1, `see ((${BLOCK_GS_1}))`)
    const refChip = () => chipIn(page, BLOCK_PROJ_1, 'block-ref-chip')
    const linkChip = () => chipIn(page, BLOCK_GS_2, 'block-link-chip')

    // Render both chips live first, so the cache holds them before the trash.
    await openPage(page, 'Projects')
    await expect(refChip()).toContainText(GS_1_TEXT)
    await expect(refChip()).not.toContainText('(deleted)')
    await openPage(page, 'Getting Started')
    await expect(linkChip()).not.toHaveAttribute('aria-label')

    // Trash the ((block)) target in its own tree, the [[page]] target from the
    // Pages view's multi-select.
    await deleteBlockViaContextMenu(
      page,
      page.locator('[data-testid="sortable-block"]').filter({ hasText: GS_1_TEXT }),
    )
    await expect(page.getByText(GS_1_TEXT)).toHaveCount(0)
    await openPagesView(page)
    await page.getByTestId(`page-select-${PAGE_QUICK_NOTES}`).click()
    await page.getByTestId('page-batch-trash-btn').click()
    await activeAlertDialog(page).getByRole('button', { name: 'Move to Trash' }).click()
    await expect(page.locator('[data-page-item]').filter({ hasText: 'Quick Notes' })).toHaveCount(0)

    await openFromPageList(page, 'Projects')
    await expect(refChip()).toContainText('(deleted)')
    await openFromPageList(page, 'Getting Started')
    await expect(linkChip()).toHaveAttribute('aria-label', 'Quick Notes (deleted)')
    // Computed, not class presence: the live chip's underline rule ties on
    // specificity with the deleted rule, so only source order keeps the strike.
    await expect(linkChip()).toHaveCSS('text-decoration-line', 'line-through')

    await restoreAllFromTrash(page)

    // Projects first: opening Getting Started would reload GS_1 itself.
    await openFromPageList(page, 'Projects')
    await expect(refChip()).toContainText(GS_1_TEXT)
    await expect(refChip()).not.toContainText('(deleted)')
    await openFromPageList(page, 'Getting Started')
    await expect(linkChip()).not.toHaveAttribute('aria-label')
    await expect(linkChip()).toHaveCSS('text-decoration-line', 'underline')
  })

  test('a journal page restored from the trash shows on the journal again (#5247)', async ({
    page,
  }) => {
    const today = await page.evaluate(() => {
      const d = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    })
    /** Today's day section on the journal, scrolled into view so it mounts. */
    async function todaysStandup() {
      const section = page.locator(`#journal-${today}`)
      await section.scrollIntoViewIfNeeded()
      return section.getByText('Morning standup notes go here')
    }
    // Weekly mode: the daily view would auto-create a fresh page for today.
    await page.getByRole('tab', { name: 'Weekly view' }).click()
    await expect(await todaysStandup()).toBeVisible()

    await openPagesView(page)
    await showJournalPages(page)
    const row = page.locator('[data-page-item]').filter({ hasText: today })
    await row.getByRole('button', { name: 'Delete page' }).click()
    await activeAlertDialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(row).toHaveCount(0)

    // The journal now caches a page map without today's page.
    await page.getByRole('button', { name: 'Journal', exact: true }).click()
    await expect(await todaysStandup()).toHaveCount(0)

    await restoreAllFromTrash(page)

    await page.getByRole('button', { name: 'Journal', exact: true }).click()
    await expect(await todaysStandup()).toBeVisible()
  })

  test('a page moved to another space leaves the origin’s [[ picker and its chips break (#5248)', async ({
    page,
  }) => {
    // A second space to move into.
    await page.getByRole('combobox', { name: 'Switch space', exact: true }).click()
    await page.mouse.move(0, 0)
    await page.getByRole('option', { name: 'Manage spaces…', exact: true }).click()
    const manage = page.getByTestId('space-manage-dialog')
    await manage.getByRole('button', { name: 'Create new space', exact: true }).click()
    await manage.getByPlaceholder('New space name').fill('Work')
    await manage.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(manage.getByRole('textbox', { name: 'Rename space' }).last()).toHaveValue('Work')
    await manage.getByRole('button', { name: 'Close', exact: true }).click()

    // Warm the origin's `[[` picker, then put the text back. The tree (and the
    // picker cache it owns) stays mounted across in-editor link navigation.
    await openPage(page, 'Quick Notes')
    await focusBlockById(page, BLOCK_QN_2)
    await page.keyboard.press('End')
    await page.keyboard.type(' [[', { delay: 30 })
    const pickerItem = (name: string) =>
      activeSuggestionList(page).locator('[data-testid="suggestion-item"]', { hasText: name })
    await expect(pickerItem('Getting Started')).toBeVisible()
    await page.keyboard.press('Escape')
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace')
    await blurEditors(page)

    // Follow the link to Getting Started and move it out; the tab pops back.
    await chipIn(page, BLOCK_QN_1, 'block-link-chip').click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Move to space', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Work', exact: true }).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Quick Notes')

    // Broken as in a fresh session: the unresolved label, not the title marked deleted.
    const movedChip = chipIn(page, BLOCK_QN_1, 'block-link-chip')
    await expect(movedChip).toHaveAttribute(
      'aria-label',
      `[[${PAGE_GETTING_STARTED.slice(0, 8)}...]] (deleted)`,
    )
    await expect(movedChip).not.toContainText('Getting Started')
    await focusBlockById(page, BLOCK_QN_2)
    await page.keyboard.press('End')
    await page.keyboard.type(' [[', { delay: 30 })
    await expect(pickerItem('Quick Notes')).toBeVisible()
    await expect(pickerItem('Getting Started')).toHaveCount(0)
  })
})
