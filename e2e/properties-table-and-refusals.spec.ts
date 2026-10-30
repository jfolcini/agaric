import type { Page } from '@playwright/test'

import {
  activeAlertDialog,
  activePopover,
  clearConsoleErrors,
  expect,
  focusBlock,
  getConsoleErrors,
  ipc,
  navigateToView,
  openPage,
  openSettingsTab,
  reopenPage,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5365, mock lane: the property refusals and the page header's Properties
 * table. Every change is read back through the mock backend, and the ones a
 * page shows are read again after reopening it.
 *
 * Seed (`src/lib/tauri-mock/seed.ts`): `project` is a select of alpha, beta and
 * gamma, carried by both Meetings blocks; `reviewer` is a text definition no
 * block uses; Quick Notes has no properties.
 */

const GS_1 = '0000000000000000000BLOCK01'
const QUICK_NOTES = '00000000000000000000PAGE02'
const MTG_1 = '0000000000000000000BLOCK17'
const MEETINGS = '00000000000000000000PAGE05'

interface PropertyRow {
  key: string
  value_text: string | null
}

interface PropertyDef {
  key: string
  value_type: string
  options: string | null
}

/** The block's stored properties as `key → value_text`. */
async function storedProperties(page: Page, blockId: string): Promise<Record<string, unknown>> {
  const rows = await ipc<PropertyRow[]>(page, 'get_properties', { blockId })
  return Object.fromEntries(rows.map((row) => [row.key, row.value_text]))
}

async function storedOptions(page: Page, key: string): Promise<unknown> {
  const def = await ipc<PropertyDef | null>(page, 'get_property_def', {
    spaceId: 'SPACE_PERSONAL',
    key,
  })
  return def?.options == null ? null : JSON.parse(def.options)
}

function toasts(page: Page, text: string) {
  return page.locator('[data-sonner-toast]').filter({ hasText: text })
}

/** Take the deliberate `logger.error` lines out of the global console gate. */
function expectLoggedThenClear(page: Page, line: string): void {
  expect(getConsoleErrors(page).some((error) => error.includes(line))).toBe(true)
  clearConsoleErrors(page)
}

// ===========================================================================
// An inline `key:: value` the backend refuses
// ===========================================================================

test.describe('Inline property refused by the backend @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  /** Pick `key` through the `::` picker and type `value` after it. */
  async function typePropertyLine(page: Page, key: string, value: string): Promise<void> {
    await page.keyboard.type('::', { delay: 30 })
    await expect(page.getByTestId('suggestion-popup')).toBeVisible()
    await page.keyboard.type(key.slice(0, 4), { delay: 30 })
    await expect(
      page.getByTestId('suggestion-list').getByTestId('suggestion-item').filter({ hasText: key }),
    ).toBeVisible()
    await page.keyboard.press('Enter')
    await page.keyboard.type(value, { delay: 30 })
  }

  /** Enter at the end of the first block: the new, focused block below it. */
  async function newBlockAfterFirst(page: Page): Promise<string> {
    const editor = await focusBlock(page)
    await editor.press('End')
    await editor.press('Enter')
    const editing = page.locator('[data-testid="sortable-block"]:has([data-testid="block-editor"])')
    await expect.poll(() => editing.getAttribute('data-block-id')).not.toBe(GS_1)
    const blockId = await editing.getAttribute('data-block-id')
    if (blockId === null) throw new Error('the new block has no id')
    return blockId
  }

  /** The stored content, or `'deleted'` once `get_block` no longer finds a live row. */
  async function storedContent(page: Page, blockId: string): Promise<string> {
    try {
      return (await ipc<{ content: string }>(page, 'get_block', { blockId })).content
    } catch {
      return 'deleted'
    }
  }

  test('a value outside the select options stays as text, one toast names it, nothing is written', async ({
    page,
  }) => {
    const editor = await focusBlock(page)
    await editor.press('End')
    await editor.press('Shift+Enter')
    await typePropertyLine(page, 'project', 'delta')
    await saveBlock(page, 'Escape')

    const kept = 'Welcome to Agaric! This is your personal knowledge base.\nproject:: delta'
    await expect(toasts(page, 'project:: delta')).toBeVisible()
    await expect.poll(() => storedContent(page, GS_1)).toBe(kept)
    expect(await storedProperties(page, GS_1)).toEqual({})
    // A snapshot, not a retrying count: two toasts stacked at once would
    // otherwise pass once the first one timed out.
    expect(await page.locator('[data-sonner-toast]').count()).toBe(1)

    await reopenPage(page, 'Getting Started')
    await expect(
      page.locator(`[data-testid="block-static"][data-block-id="${GS_1}"]`),
    ).toContainText('project:: delta')
    expect(await storedContent(page, GS_1)).toBe(kept)
    expect(await storedProperties(page, GS_1)).toEqual({})

    expectLoggedThenClear(page, 'Failed to set inline property from :: syntax')
  })

  // #5448 — Escape takes the async property branch, which writes the text
  // only after `set_property` answers; the empty-block cleanup waits for that
  // write instead of deleting the blank, property-less block in the window.
  test('a new block holding only the refused line keeps it after Escape', async ({ page }) => {
    const blockId = await newBlockAfterFirst(page)
    await typePropertyLine(page, 'project', 'delta')
    await page.keyboard.press('Escape')

    await expect(toasts(page, 'project:: delta')).toBeVisible()
    await expect.poll(() => storedContent(page, blockId)).toBe('project:: delta')
    expect(await storedProperties(page, blockId)).toEqual({})

    expectLoggedThenClear(page, 'Failed to set inline property from :: syntax')
  })

  test('a new block holding only an accepted line keeps it as the property after Escape', async ({
    page,
  }) => {
    const blockId = await newBlockAfterFirst(page)
    await typePropertyLine(page, 'context', 'home')
    await page.keyboard.press('Escape')

    await expect.poll(() => storedProperties(page, blockId)).toEqual({ context: 'home' })
    expect(await storedContent(page, blockId)).toBe('')

    await reopenPage(page, 'Getting Started')
    const row = page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
    await expect(row.getByTestId('property-chip').filter({ hasText: 'home' })).toBeVisible()
    expect(await storedContent(page, blockId)).toBe('')
  })
})

// ===========================================================================
// The page header's Properties table
// ===========================================================================

test.describe('Page Properties table @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Quick Notes')
  })

  /** Reopen Quick Notes and expand its table, which mounts collapsed. */
  async function reopenTable(page: Page, count: number): Promise<void> {
    await reopenPage(page, 'Quick Notes')
    await page.getByRole('button', { name: `Properties (${count})`, exact: true }).click()
  }

  test('add from a definition, create a definition, edit and delete each survive reopening', async ({
    page,
  }) => {
    // Add from the existing `reviewer` definition.
    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Add property', exact: true }).click()
    await activePopover(page).getByRole('button', { name: 'Reviewer text', exact: true }).click()
    const reviewer = page.getByRole('textbox', { name: 'reviewer value', exact: true })
    await reviewer.fill('Ana')
    await reviewer.press('Enter')
    await expect(page.getByRole('button', { name: 'Properties (1)', exact: true })).toBeVisible()
    await expect.poll(() => storedProperties(page, QUICK_NOTES)).toEqual({ reviewer: 'Ana' })

    await reopenTable(page, 1)
    await expect(reviewer).toHaveValue('Ana')
    expect(await storedProperties(page, QUICK_NOTES)).toEqual({ reviewer: 'Ana' })

    // Create a new `budget` definition from the same picker.
    await page.getByRole('button', { name: 'Add property', exact: true }).click()
    const picker = activePopover(page)
    await picker.getByRole('textbox', { name: 'Search definitions' }).fill('budget')
    await picker.getByRole('button', { name: /^Create "budget"/ }).click()
    await picker.getByRole('button', { name: 'Create definition', exact: true }).click()
    const budget = page.getByRole('textbox', { name: 'budget value', exact: true })
    await budget.fill('1200')
    await budget.press('Enter')
    await expect(page.getByRole('button', { name: 'Properties (2)', exact: true })).toBeVisible()
    await expect
      .poll(() => storedProperties(page, QUICK_NOTES))
      .toEqual({ reviewer: 'Ana', budget: '1200' })
    expect(
      await ipc<PropertyDef | null>(page, 'get_property_def', {
        spaceId: 'SPACE_PERSONAL',
        key: 'budget',
      }),
    ).toMatchObject({ key: 'budget', value_type: 'text' })

    await reopenTable(page, 2)
    await expect(budget).toHaveValue('1200')
    await expect(reviewer).toHaveValue('Ana')

    // Edit `reviewer`.
    await reviewer.fill('Bea')
    await reviewer.press('Enter')
    await expect
      .poll(() => storedProperties(page, QUICK_NOTES))
      .toEqual({ reviewer: 'Bea', budget: '1200' })

    await reopenTable(page, 2)
    await expect(reviewer).toHaveValue('Bea')

    // Delete `budget`.
    await page.getByRole('button', { name: 'Delete property budget', exact: true }).click()
    const confirm = activeAlertDialog(page)
    await expect(confirm.getByText('Delete this property?')).toBeVisible()
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(budget).toHaveCount(0)
    await expect.poll(() => storedProperties(page, QUICK_NOTES)).toEqual({ reviewer: 'Bea' })

    await reopenTable(page, 1)
    await expect(reviewer).toHaveValue('Bea')
    await expect(budget).toHaveCount(0)
    expect(await storedProperties(page, QUICK_NOTES)).toEqual({ reviewer: 'Bea' })
  })
})

// ===========================================================================
// Editing and deleting a select definition
// ===========================================================================

test.describe('Select definition options and in-use delete @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Properties')
  })

  function projectRow(page: Page) {
    return page
      .getByTestId('settings-panel-properties')
      .getByRole('listitem')
      .filter({ has: page.getByText('Project', { exact: true }) })
  }

  test("edited options are exactly what a block's project chip offers", async ({ page }) => {
    await projectRow(page).getByRole('button', { name: 'Edit options', exact: true }).click()
    const editor = activePopover(page)
    await editor.getByRole('button', { name: 'Remove option gamma', exact: true }).click()
    await editor.getByRole('textbox', { name: 'New option value', exact: true }).fill('delta')
    await editor.getByRole('button', { name: 'Add option', exact: true }).click()
    await editor.getByRole('button', { name: 'Save options', exact: true }).click()
    await expect(editor).toHaveCount(0)
    await expect.poll(() => storedOptions(page, 'project')).toEqual(['alpha', 'beta', 'delta'])

    await openPage(page, 'Meetings')
    const block = page.locator(`[data-testid="sortable-block"][data-block-id="${MTG_1}"]`)
    await block.getByRole('button', { name: 'Project: alpha', exact: true }).click()
    const offered = page.getByRole('listbox', { name: 'Edit property' }).getByRole('option')
    await expect(offered).toHaveText(['alpha', 'beta', 'delta'])
  })

  test('renaming an option renames the values blocks hold, and Undo takes it back', async ({
    page,
  }) => {
    await projectRow(page).getByRole('button', { name: 'Edit options', exact: true }).click()
    const editor = activePopover(page)
    await editor.getByRole('button', { name: 'Rename option alpha', exact: true }).click()
    await editor.getByRole('textbox', { name: 'New name for alpha', exact: true }).fill('apollo')
    await editor.getByRole('button', { name: 'Save option name', exact: true }).click()
    await expect(
      editor.getByRole('button', { name: 'Rename option apollo', exact: true }),
    ).toBeVisible()
    await expect.poll(() => storedOptions(page, 'project')).toEqual(['apollo', 'beta', 'gamma'])
    await expect.poll(() => storedProperties(page, MTG_1)).toMatchObject({ project: 'apollo' })
    await page.keyboard.press('Escape')

    await openPage(page, 'Meetings')
    const block = page.locator(`[data-testid="sortable-block"][data-block-id="${MTG_1}"]`)
    await expect(block.getByRole('button', { name: 'Project: apollo', exact: true })).toBeVisible()

    await toasts(page, 'Renamed alpha to apollo in project')
      .getByRole('button', { name: 'Undo', exact: true })
      .click()
    await expect.poll(() => storedOptions(page, 'project')).toEqual(['alpha', 'beta', 'gamma'])
    await reopenPage(page, 'Meetings')
    await expect(block.getByRole('button', { name: 'Project: alpha', exact: true })).toBeVisible()
    expect(await storedProperties(page, MTG_1)).toMatchObject({ project: 'alpha' })
  })

  test('deleting a definition a block still uses is refused and the definition stays', async ({
    page,
  }) => {
    await projectRow(page)
      .getByRole('button', { name: 'Delete property project', exact: true })
      .click()
    const confirm = activeAlertDialog(page)
    await expect(confirm.getByText('Delete this property definition?')).toBeVisible()
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect(
      toasts(
        page,
        "Can't delete 'project': 2 block(s) still use it. Remove the property from them first.",
      ),
    ).toBeVisible()
    await expect(projectRow(page)).toBeVisible()
    expect(await storedOptions(page, 'project')).toEqual(['alpha', 'beta', 'gamma'])
    expect(await storedProperties(page, MTG_1)).toMatchObject({ project: 'alpha' })

    expectLoggedThenClear(page, 'property.errorDelete')
  })
})

// ===========================================================================
// Renaming an option from the page's own Properties table
// ===========================================================================

test.describe('Select option renamed from the page Properties table @editor', () => {
  test('the chips on the open page follow the rename and its Undo', async ({ page }) => {
    await waitForBoot(page)
    await ipc(page, 'set_property', {
      blockId: MEETINGS,
      key: 'project',
      value: { value_text: 'alpha' },
    })
    await openPage(page, 'Meetings')
    await page.getByRole('button', { name: /^Properties/ }).click()
    const block = page.locator(`[data-testid="sortable-block"][data-block-id="${MTG_1}"]`)
    await expect(block.getByRole('button', { name: 'Project: alpha', exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Edit options for project', exact: true }).click()
    const editor = activePopover(page)
    await editor.getByRole('button', { name: 'Rename option alpha', exact: true }).click()
    await editor.getByRole('textbox', { name: 'New name for alpha', exact: true }).fill('apollo')
    await editor.getByRole('button', { name: 'Save option name', exact: true }).click()

    // The same page, not reopened: its block chip and its own value follow.
    await expect(block.getByRole('button', { name: 'Project: apollo', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('combobox', { name: 'project value', exact: true })).toHaveText(
      'apollo',
    )
    expect(await storedProperties(page, MTG_1)).toMatchObject({ project: 'apollo' })
    expect(await storedProperties(page, MEETINGS)).toMatchObject({ project: 'apollo' })

    await toasts(page, 'Renamed alpha to apollo in project')
      .getByRole('button', { name: 'Undo', exact: true })
      .click()
    await expect(block.getByRole('button', { name: 'Project: alpha', exact: true })).toBeVisible()
    await expect.poll(() => storedOptions(page, 'project')).toEqual(['alpha', 'beta', 'gamma'])
    expect(await storedProperties(page, MTG_1)).toMatchObject({ project: 'alpha' })
  })
})
