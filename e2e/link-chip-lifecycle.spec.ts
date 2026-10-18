import {
  activeAlertDialog,
  activeSuggestionList,
  blurEditors,
  deleteBlockViaContextMenu,
  expect,
  focusBlockById,
  ipc,
  navigateToView,
  openPage,
  reopenPage,
  replaceEditorText,
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
 *
 * A broken chip removes itself when clicked (#5736), from a static block, the
 * block's editor and page mode; the mock shows each write failing to land.
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
const QN_1_TEXT = `These notes complement the [[${PAGE_GETTING_STARTED}]] guide.`
const QN_1_UNLINKED = 'These notes complement the  guide.'
/** A broken chip's name: its label, then what activating it does. */
const brokenName = (label: string) => `${label} (remove broken link)`
const MOVED_LABEL = `[[${PAGE_GETTING_STARTED.slice(0, 8)}...]]`

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

/** A second space, named `name`, to move pages into. */
async function createSpace(page: Page, name: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Switch space', exact: true }).click()
  await page.mouse.move(0, 0)
  await page.getByRole('option', { name: 'Manage spaces…', exact: true }).click()
  const spaces = page.getByTestId('settings-panel-spaces')
  await spaces.getByRole('button', { name: 'Create new space', exact: true }).click()
  await spaces.getByPlaceholder('New space name').fill(name)
  await spaces.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(spaces.getByRole('textbox', { name: 'Rename space' }).last()).toHaveValue(name)
}

/** From Quick Notes: follow QN_1's chip to Getting Started and move it to `space`; the tab pops back. */
async function moveGettingStartedTo(page: Page, space: string): Promise<void> {
  await chipIn(page, BLOCK_QN_1, 'block-link-chip').click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
  await page.getByRole('button', { name: 'Page actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Move to space', exact: true }).click()
  await page.getByRole('menuitem', { name: space, exact: true }).click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText('Quick Notes')
}

/**
 * The "Broken link removed" toast the last removal raised: sonner prepends, so
 * it is the front toast, and an earlier removal's toast can still be alive behind it.
 */
function removedToast(page: Page) {
  return page
    .locator('[data-sonner-toast][data-front="true"]')
    .filter({ hasText: 'Broken link removed' })
}

/** QN_1's content as the backend holds it. */
async function qn1Content(page: Page): Promise<string | null> {
  return (await ipc<{ content: string | null }>(page, 'get_block', { blockId: BLOCK_QN_1 })).content
}

async function restoreAllFromTrash(page: Page): Promise<void> {
  await navigateToView(page, 'Trash')
  await page.getByTestId('trash-restore-all-btn').click()
  await activeAlertDialog(page).getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(page.getByText('Nothing in trash. Deleted items will appear here.')).toBeVisible()
}

test.describe('link chips follow their target @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a ((block)) chip shows the target block’s edited text (#5245)', async ({ page }) => {
    await editViaBackend(page, BLOCK_GS_3, `see ((${BLOCK_GS_1}))`)
    await openPage(page, 'Getting Started')
    const chip = chipIn(page, BLOCK_GS_3, 'block-ref-chip')
    await expect(chip).toContainText(GS_1_TEXT)

    await focusBlockById(page, BLOCK_GS_1)
    await replaceEditorText(page, 'Buy oat milk')
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
    await expect(linkChip()).toHaveAccessibleName(brokenName('Quick Notes'))
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
    await createSpace(page, 'Work')

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

    await moveGettingStartedTo(page, 'Work')

    // Broken as in a fresh session: the unresolved label, not the title marked deleted.
    const movedChip = chipIn(page, BLOCK_QN_1, 'block-link-chip')
    await expect(movedChip).toHaveAccessibleName(brokenName(MOVED_LABEL))
    await expect(movedChip).not.toContainText('Getting Started')
    await focusBlockById(page, BLOCK_QN_2)
    await page.keyboard.press('End')
    await page.keyboard.type(' [[', { delay: 30 })
    await expect(pickerItem('Quick Notes')).toBeVisible()
    await expect(pickerItem('Getting Started')).toHaveCount(0)
  })
})

test.describe('a broken chip removes itself when clicked (#5736) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await createSpace(page, 'Work')
    await openPage(page, 'Quick Notes')
    await moveGettingStartedTo(page, 'Work')
  })

  test('from a static block: the link goes, and page-level Ctrl+Z or the toast’s Undo brings it back', async ({
    page,
  }) => {
    const block = page.locator(`[data-testid="block-static"][data-block-id="${BLOCK_QN_1}"]`)
    const chip = chipIn(page, BLOCK_QN_1, 'block-link-chip')
    await chip.hover()
    await expect(
      page.getByRole('tooltip', { name: 'Broken link or in another space — click to remove' }),
    ).toBeVisible()
    await page.getByRole('button', { name: brokenName(MOVED_LABEL), exact: true }).click()
    await expect(removedToast(page)).toBeVisible()
    await expect(chip).toHaveCount(0)
    await expect(
      page.locator(`[data-block-id="${BLOCK_QN_1}"] [data-context-trigger="true"]`),
    ).toBeFocused()

    await reopenPage(page, 'Quick Notes')
    await expect(block).toHaveText(QN_1_UNLINKED)
    await expect(chip).toHaveCount(0)
    expect(await qn1Content(page)).toBe(QN_1_UNLINKED)

    await blurEditors(page)
    await page.keyboard.press('Control+z')
    await expect(chip).toHaveCount(1)
    await reopenPage(page, 'Quick Notes')
    await expect(chip).toHaveAccessibleName(brokenName(MOVED_LABEL))
    expect(await qn1Content(page)).toBe(QN_1_TEXT)

    await chip.click()
    await expect(chip).toHaveCount(0)
    await removedToast(page).getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(chip).toHaveCount(1)
    await reopenPage(page, 'Quick Notes')
    await expect(chip).toHaveAccessibleName(brokenName(MOVED_LABEL))
    expect(await qn1Content(page)).toBe(QN_1_TEXT)
  })

  test('from the block’s editor: the link goes, Ctrl+Z there brings it back, and a removal saves', async ({
    page,
  }) => {
    await focusBlockById(page, BLOCK_QN_1)
    const editorChip = page.locator('[data-testid="block-editor"] [data-testid="block-link-chip"]')
    // An atomic NodeView gets no DOM click from headless Chromium (e2e/AGENTS.md).
    await editorChip.dispatchEvent('click')
    await expect(removedToast(page)).toBeVisible()
    await expect(editorChip).toHaveCount(0)
    await page.keyboard.press('Control+z')
    await expect(editorChip).toHaveCount(1)

    await editorChip.dispatchEvent('click')
    await expect(editorChip).toHaveCount(0)
    await blurEditors(page)
    await reopenPage(page, 'Quick Notes')
    await expect(chipIn(page, BLOCK_QN_1, 'block-link-chip')).toHaveCount(0)
    expect(await qn1Content(page)).toBe(QN_1_UNLINKED)
  })

  test('from page mode: the link goes, Ctrl+Z brings it back, and a removal saves', async ({
    page,
  }) => {
    await page
      .getByRole('radiogroup', { name: 'Editing mode' })
      .getByRole('radio', { name: 'Page' })
      .click()
    const pageDocument = page.locator('[data-testid="page-mode-editor"]')
    const pageChip = pageDocument.locator('[data-testid="block-link-chip"]')
    await pageDocument.focus()
    await expect(pageDocument).toBeFocused()
    await pageChip.dispatchEvent('click')
    await expect(removedToast(page)).toBeVisible()
    await expect(pageChip).toHaveCount(0)
    await page.keyboard.press('Control+z')
    await expect(pageChip).toHaveCount(1)

    await pageChip.dispatchEvent('click')
    await expect(pageChip).toHaveCount(0)
    await expect.poll(() => qn1Content(page)).toBe(QN_1_UNLINKED)
  })
})
