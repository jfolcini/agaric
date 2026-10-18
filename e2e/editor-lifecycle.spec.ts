import { devices } from '@playwright/test'

import {
  createPageFromPagesView,
  deleteBlockViaContextMenu,
  expect,
  focusBlockById,
  navigateToView,
  openPageMobile,
  replaceEditorText,
  test,
  waitForBoot,
} from './helpers'

const SEED_GS_1 = '0000000000000000000BLOCK01'
const SEED_GS_2 = '0000000000000000000BLOCK02'
const SEED_GS_3 = '0000000000000000000BLOCK03'
const SEED_GS_4 = '0000000000000000000BLOCK04'

/**
 * Editor lifecycle: CRUD operations, navigation, persistence.
 * All block operations use the "Getting Started" seed page.
 *
 * Key selectors:
 * Static blocks: `[data-testid="block-static"]` div (passive container after no role/aria-label)
 * - TipTap editor: `[role="textbox"][aria-label="Block editor"]` (contenteditable)
 * - Sortable wrapper: `[data-testid="sortable-block"]`
 * - Enter saves; Escape saves and selects the block.
 */

async function openGettingStarted(page: import('@playwright/test').Page) {
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Pages', exact: true })
    .click()
  // Scope to the page list so we don't match the page-title textbox or a
  // block-link-chip that also renders "Getting Started" (strict-mode
  // Violation under parallel load — flake, session 679).
  await page.locator('[data-page-item]').filter({ hasText: 'Getting Started' }).first().click()
  await expect(page.locator('[aria-label="Page title"]')).toBeVisible({ timeout: 5000 })
}

/** Click "Add block", wait for the TipTap editor to appear, type text, press Enter to save. */
async function addBlock(page: import('@playwright/test').Page, text: string) {
  await page.getByRole('button', { name: /add block/i }).click()
  const editor = page.getByRole('textbox', { name: 'Block editor' })
  await expect(editor).toBeVisible({ timeout: 5000 })
  await editor.pressSequentially(text, { delay: 30 })
  await editor.press('Enter')
  // Wait for the static block with the new text to appear
  await expect(page.getByText(text)).toBeVisible()
  // Enter saves the just-typed block AND opens a fresh empty sibling
  // editor (`use-block-keyboard.ts` "Enter: save + create new sibling"). The
  // tests care about the content block only; dismiss the empty sibling with
  // Escape so it doesn't count toward the sortable-block total.
  const freshEditor = page.getByRole('textbox', { name: 'Block editor' })
  if (await freshEditor.isVisible().catch(() => false)) {
    await freshEditor.press('Escape')
  }
}

test.describe('Editor lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
  })

  test('Getting Started page loads with seed blocks', async ({ page }) => {
    await openGettingStarted(page)
    // Seed page has blocks — verify at least one is visible
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('creates a block via the Add block button', async ({ page }) => {
    await openGettingStarted(page)
    const initialCount = await page.locator('[data-testid="sortable-block"]').count()

    await addBlock(page, 'Hello from E2E')

    // Verify block count increased
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(initialCount + 1)
    await expect(page.getByText('Hello from E2E')).toBeVisible()
  })

  test('creates multiple blocks', async ({ page }) => {
    await openGettingStarted(page)
    const initialCount = await page.locator('[data-testid="sortable-block"]').count()

    await addBlock(page, 'Block A')
    await addBlock(page, 'Block B')

    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(initialCount + 2)
    await expect(page.getByText('Block A')).toBeVisible()
    await expect(page.getByText('Block B')).toBeVisible()
  })

  test('clicks a block to edit it inline', async ({ page }) => {
    await openGettingStarted(page)

    // Click the first seed block to focus it. Static blocks are passive
    // Div containers, located via data-testid.
    const firstBlock = page.locator('[data-testid="block-static"]').first()
    const originalText = (await firstBlock.textContent())?.trim()
    if (!originalText) throw new Error('seed block had no text content')
    await firstBlock.click()

    // TipTap editor should appear
    const editor = page.getByRole('textbox', { name: 'Block editor' })
    await expect(editor).toBeVisible()

    // Escape leaves the block without changing it
    await editor.press('Escape')
    await expect(page.getByText(originalText)).toBeVisible()
  })

  test('a click on a lower block while editing moves the editor there and saves', async ({
    page,
  }) => {
    await openGettingStarted(page)
    const statics = page.locator('[data-testid="block-static"]')
    const lastId = await statics.last().getAttribute('data-block-id')
    await statics.first().click()
    const editor = page.getByRole('textbox', { name: 'Block editor' })
    await expect(editor).toBeVisible()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('edited before moving')
    await expect(editor).toHaveText('edited before moving')

    // The press must not collapse the edited block before the release, or the
    // rows below move up under the pointer and the click is lost.
    await statics.last().click()

    await expect(
      page.locator(`[data-testid="block-editor"][data-block-id="${lastId}"]`),
    ).toBeVisible()
    await expect(statics.first()).toHaveText('edited before moving')
    // The moved editor keeps keyboard focus: typing lands in the clicked block.
    await page.keyboard.press('Control+a')
    await page.keyboard.type('typed after moving')
    await expect(editor).toHaveText('typed after moving')
  })

  // The press blurs the editor; had its block left edit mode then, the rows
  // below would move up by the toolbar's height before the release.
  for (const chip of [
    {
      kind: 'link',
      edited: SEED_GS_1,
      below: SEED_GS_2,
      testId: 'block-link-chip',
      to: 'Quick Notes',
    },
    { kind: 'tag', edited: SEED_GS_3, below: SEED_GS_4, testId: 'tag-ref-chip', to: 'work' },
  ]) {
    test(`a click on a ${chip.kind} chip in the block below the edited one follows it`, async ({
      page,
    }) => {
      await openGettingStarted(page)
      await focusBlockById(page, chip.edited)
      await replaceEditorText(page, 'saved before following')
      await expect(page.getByTestId('formatting-toolbar')).toBeVisible()

      await page
        .locator(`[data-testid="block-static"][data-block-id="${chip.below}"]`)
        .getByTestId(chip.testId)
        .filter({ hasText: chip.to })
        .click()

      await expect(page.locator('[aria-label="Page title"]')).toHaveText(chip.to)
      await openGettingStarted(page)
      await expect(
        page.locator(`[data-testid="block-static"][data-block-id="${chip.edited}"]`),
      ).toHaveText('saved before following')
    })
  }

  test('deletes a block via the delete button', async ({ page }) => {
    await openGettingStarted(page)

    // Create a block to delete
    await addBlock(page, 'Delete me')

    // Delete the block via the context menu
    const block = page.locator('[data-testid="sortable-block"]').filter({ hasText: 'Delete me' })
    await deleteBlockViaContextMenu(page, block)

    // Verify block is gone
    await expect(page.getByText('Delete me')).not.toBeVisible()
  })

  test('navigates between views', async ({ page }) => {
    // Use the dedicated `header-label` testid (the App.tsx shell header)
    // so the assertions are unambiguous — TrashView, SettingsView, and
    // friends now render their own `<header>` via `FeaturePageHeader`,
    // which made the previous `locator('header').getByText(...)` race
    // against an `<h1>` carrying the same text inside a sibling `<header>`.
    const headerLabel = page.getByTestId('header-label')

    // Navigate to Tags
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Tags', exact: true })
      .click()
    await expect(headerLabel).toHaveText('Tags')

    // Navigate to Trash (Pages header button)
    await navigateToView(page, 'Trash')
    await expect(headerLabel).toHaveText('Trash')

    // Navigate to Status (a Settings tab)
    await navigateToView(page, 'Status')
    await expect(headerLabel).toHaveText('Settings')
    await expect(page.getByTestId('settings-panel-status')).toBeVisible()

    // (Conflicts nav-item removed in Session 700 / Phase 5.)

    // Navigate back to Journal (no header label — has mode tabs instead)
    await page.getByRole('button', { name: 'Journal', exact: true }).click()
    await expect(page.getByRole('tab', { name: /daily/i })).toBeVisible()
  })

  test('pages view allows creating a new page', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Pages', exact: true })
      .click()
    await expect(page.getByTestId('header-label')).toHaveText('Pages')

    // The New page dialog creates the page and opens it.
    await createPageFromPagesView(page, 'E2E Test Page')
  })

  test('blocks persist within the same page session', async ({ page }) => {
    await openGettingStarted(page)

    await addBlock(page, 'Persistent block')

    // Navigate away and back
    await page.getByRole('button', { name: 'Journal', exact: true }).click()
    await expect(page.getByRole('tab', { name: /daily/i })).toBeVisible()

    await openGettingStarted(page)

    // Block should still be there (mock state persists within session)
    await expect(page.getByText('Persistent block')).toBeVisible()
  })

  test('handles special characters in block content', async ({ page }) => {
    await openGettingStarted(page)

    await addBlock(page, 'Special: & "quotes" \'apos\'')

    await expect(page.getByText('Special: & "quotes" \'apos\'')).toBeVisible()
  })

  test('mock resets on page reload (test isolation)', async ({ page }) => {
    await openGettingStarted(page)

    await addBlock(page, 'Session block')

    // Reload the page — mock state resets.
    // Under heavy parallel load the dev server can still be serving stale
    // bundles when reload resolves; wait for the network to settle so the
    // App shell is fully hydrated before asserting (flake).
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible({
      timeout: 10000,
    })

    // Navigate back to Getting Started
    await openGettingStarted(page)

    // The session block should be gone (mock reset)
    await expect(page.getByText('Session block')).not.toBeVisible()
    // But seed blocks should be back
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })
})

// A mouse press that blurs the editor keeps its block in edit mode until the
// press ends, so the click lands where it was pressed (#5807); a key leaves at
// once.
test.describe('Editor blur by a press or a key', () => {
  const editorRow = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="block-editor"]')
  const staticRow = (page: import('@playwright/test').Page, blockId: string) =>
    page.locator(`[data-testid="block-static"][data-block-id="${blockId}"]`)

  test.beforeEach(async ({ page }) => {
    // Tab moves focus instead of indenting, so it can leave the editor.
    await page.addInitScript(() => localStorage.setItem('agaric-tab-indents-blocks', 'false'))
    await waitForBoot(page)
  })

  test('Tab leaves the editor at once, and the edit is saved', async ({ page }) => {
    await openGettingStarted(page)
    await focusBlockById(page, SEED_GS_1)
    await replaceEditorText(page, 'left by Tab')

    await page.keyboard.press('Tab')

    await expect(editorRow(page)).toHaveCount(0)
    await openGettingStarted(page)
    await expect(staticRow(page, SEED_GS_1)).toHaveText('left by Tab')
  })

  test('a drag-select from inside the editor that ends outside it keeps the editor', async ({
    page,
  }) => {
    await openGettingStarted(page)
    const editor = await focusBlockById(page, SEED_GS_1)
    await replaceEditorText(page, 'selected by dragging')
    const from = await editor.boundingBox()
    const to = await staticRow(page, SEED_GS_3).boundingBox()
    if (!from || !to) throw new Error('no layout box')

    // From before the first character to a block below: the whole text.
    await page.mouse.move(from.x + 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 })
    await page.mouse.up()

    await expect(editor).toBeFocused()
    await page.keyboard.insertText('replaced')
    await expect(editor).toHaveText('replaced')
    // The press ended with the release: a key still leaves at once.
    await page.keyboard.press('Tab')
    await expect(editorRow(page)).toHaveCount(0)
    await expect(staticRow(page, SEED_GS_1)).toHaveText('replaced')
  })

  test('a press released outside the window ends the edit', async ({ page }) => {
    await openGettingStarted(page)
    await focusBlockById(page, SEED_GS_1)
    await replaceEditorText(page, 'released outside')
    const chip = await staticRow(page, SEED_GS_2).getByTestId('block-link-chip').boundingBox()
    if (!chip) throw new Error('no layout box')

    await page.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2)
    await page.mouse.down()
    await expect(editorRow(page)).toHaveCount(1)
    await page.mouse.move(-20, -20, { steps: 3 })
    await page.mouse.up()

    await expect(editorRow(page)).toHaveCount(0)
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
    await expect(staticRow(page, SEED_GS_1)).toHaveText('released outside')
  })

  test('a click on a block in another journal day moves the editor there, and typing lands', async ({
    page,
  }) => {
    await page.getByRole('tab', { name: 'Weekly view' }).click()
    const emptyDays = page.locator('section[id^="journal-"]', { hasText: 'No blocks for' })
    const [upperId, lowerId] = await Promise.all([
      emptyDays.nth(0).getAttribute('id'),
      emptyDays.nth(1).getAttribute('id'),
    ])
    const upper = page.locator(`section[id="${upperId}"]`)
    const lower = page.locator(`section[id="${lowerId}"]`)

    await lower.getByRole('button', { name: 'Add block', exact: true }).click()
    await expect(lower.getByRole('textbox', { name: 'Block editor' })).toBeFocused()
    await page.keyboard.insertText('lower day')
    await page.keyboard.press('Escape')
    const lowerBlock = lower.locator('[data-testid="block-static"]')
    await expect(lowerBlock).toHaveText('lower day')

    await upper.scrollIntoViewIfNeeded()
    await upper.getByRole('button', { name: 'Add block', exact: true }).click()
    await expect(upper.getByRole('textbox', { name: 'Block editor' })).toBeFocused()
    await page.keyboard.insertText('upper day')
    await expect(upper.getByTestId('formatting-toolbar')).toBeVisible()

    await lowerBlock.click()

    const lowerEditor = lower.getByRole('textbox', { name: 'Block editor' })
    await expect(lowerEditor).toBeFocused()
    await replaceEditorText(page, 'typed after moving')
    await expect(lowerEditor).toHaveText('typed after moving')
    await expect(upper.locator('[data-testid="block-static"]')).toHaveText('upper day')
    await page.keyboard.press('Escape')
    await navigateToView(page, 'Pages')
    await navigateToView(page, 'Journal')
    await page.getByRole('tab', { name: 'Weekly view' }).click()
    await expect(lower.locator('[data-testid="block-static"]')).toHaveText('typed after moving')
    await expect(upper.locator('[data-testid="block-static"]')).toHaveText('upper day')
  })
})

const { defaultBrowserType: _, ...pixel7 } = devices['Pixel 7']

test.describe('Editor lifecycle on touch', () => {
  test.use(pixel7)

  // A one-line edit, so the edited block is as short as the editor makes it:
  // a press that blurs the editor must not resize it, or the rows below move
  // under the finger and the release lands on another element.
  async function editFirstBlockToOneLine(page: import('@playwright/test').Page) {
    await waitForBoot(page)
    await openPageMobile(page, 'Getting Started')
    await page
      .locator('[data-testid="block-static"]')
      .first()
      .tap({ position: { x: 4, y: 4 } })
    const editor = page.getByRole('textbox', { name: 'Block editor' })
    await expect(editor).toBeVisible()
    await replaceEditorText(page, 'Short')
    await expect(editor).toHaveText('Short')
    return editor
  }

  test('a tap on the block below moves the editor there and saves', async ({ page }) => {
    const editor = await editFirstBlockToOneLine(page)
    const below = page.locator('[data-testid="block-static"]').first()
    const belowId = await below.getAttribute('data-block-id')

    // Its top edge, the part a resize of the edited block would move away.
    await below.tap({ position: { x: 4, y: 4 } })

    await expect(
      page.locator(`[data-testid="block-editor"][data-block-id="${belowId}"]`),
    ).toBeVisible()
    await expect(page.locator('[data-testid="block-static"]').first()).toHaveText('Short')
    await replaceEditorText(page, 'typed after moving')
    await expect(editor).toHaveText('typed after moving')
  })

  test('a tap on a link chip in the block below follows the link', async ({ page }) => {
    await editFirstBlockToOneLine(page)
    const chip = page
      .locator('[data-testid="block-static"] [data-testid="block-link-chip"]')
      .first()
    await expect(chip).toHaveText('Quick Notes')

    // A chip press still blurs the editor, so its upper part is what a resize
    // of the edited block would move from under the finger.
    await chip.tap({ position: { x: 4, y: 2 } })

    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Quick Notes')
  })
})
