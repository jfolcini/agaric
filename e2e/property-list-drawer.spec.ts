import type { Locator, Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeMenu,
  activePopover,
  activeRoleDialog,
  activeSheet,
  expect,
  focusBlock,
  focusBlockById,
  ipc,
  navigateToView,
  openPage,
  openSettingsTab,
  reopenPage,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

/**
 * #6741, mock lane: a select defined in Settings › Properties to hold several
 * values is edited in the block drawer as its items, one chip each, and the
 * items it holds are the ones read back after leaving the page and coming back.
 * A block's lists survive Duplicate, which copies through the Document buffer's
 * `key:: a, "b, c"` line, and `/template`, which copies rows; a ref item stays
 * its block id.
 */

const GS_1 = '0000000000000000000B10CK01'

function blockRow(page: Page, blockId: string): Locator {
  return page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
}

async function openBlockDrawer(page: Page, blockId: string): Promise<Locator> {
  await blockRow(page, blockId).click({ button: 'right' })
  await activeMenu(page)
    .getByRole('menuitem', { name: /^Properties/ })
    .click()
  const sheet = activeSheet(page)
  await expect(sheet.getByText('Block properties')).toBeVisible()
  return sheet
}

/** Pick `option` in the list's add control, which goes back to its placeholder once added. */
async function addItem(page: Page, sheet: Locator, option: string): Promise<void> {
  await sheet.getByRole('combobox', { name: 'Add an item to stages', exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
  await expect(sheet.getByRole('button', { name: `Remove ${option}`, exact: true })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

test.describe('A property that holds several values @editor', () => {
  test('two items added in the drawer are both there after reopening the page', async ({
    page,
  }) => {
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Properties')
    const panel = page.locator('[data-testid="settings-panel-properties"]')
    await panel.getByRole('textbox', { name: 'Property key', exact: true }).fill('stages')
    await panel.getByRole('combobox', { name: 'Type', exact: true }).click()
    await page.getByRole('option', { name: 'select', exact: true }).click()
    await panel
      .getByRole('textbox', { name: 'Options, comma-separated', exact: true })
      .fill('draft, review, final')
    await panel.getByRole('checkbox', { name: 'Holds several values', exact: true }).check()
    await panel.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(panel.locator('ul > li', { hasText: 'Stages' })).toContainText('several values')

    await openPage(page, 'Getting Started')
    let sheet = await openBlockDrawer(page, GS_1)
    await sheet.getByRole('button', { name: 'Add property', exact: true }).click()
    await activePopover(page)
      .getByRole('button', { name: /^Stages/ })
      .click()
    await addItem(page, sheet, 'draft')
    await addItem(page, sheet, 'review')
    await sheet.getByRole('button', { name: 'Close', exact: true }).click()

    await reopenPage(page, 'Getting Started')
    await expect(blockRow(page, GS_1).getByTestId('property-chip')).toHaveText([
      'Stages:draft, review',
    ])
    sheet = await openBlockDrawer(page, GS_1)
    const items = sheet.getByRole('group', { name: 'stages value', exact: true })
    await expect(items.getByRole('button', { name: /^Remove / })).toHaveCount(2)
    await expect(items.getByRole('button', { name: 'Remove draft', exact: true })).toBeVisible()
    await expect(items.getByRole('button', { name: 'Remove review', exact: true })).toBeVisible()
  })
})

const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }
/** One item holds a comma, which the buffer line must quote. */
const STAGE_ITEMS = ['draft', 'review, final']

interface Child {
  id: string
  content: string | null
}

async function children(page: Page, parentId: string): Promise<Child[]> {
  const { items } = await ipc<{ items: Child[] }>(page, 'list_blocks', {
    request: { parentId, limit: 100 },
    scope: SCOPE,
  })
  return items
}

/** The `steps` and `links` lists block `blockId` holds, as the backend stores them. */
async function listsOf(page: Page, blockId: string): Promise<Record<string, unknown>> {
  const rows = await ipc<Array<{ key: string; value_list?: unknown[] | null }>>(
    page,
    'get_properties',
    { blockId },
  )
  const list = (key: string) => rows.find((row) => row.key === key)?.value_list ?? null
  return { steps: list('steps'), links: list('links') }
}

/** Define `steps` (text) and `links` (ref) as lists, and give a new block under `parentId` both. */
async function seedListBlock(page: Page, parentId: string, content: string) {
  for (const [key, valueType] of [
    ['steps', 'text'],
    ['links', 'ref'],
  ]) {
    await ipc(page, 'create_property_def', {
      spaceId: SCOPE.space_id,
      key,
      valueType,
      options: null,
      multiple: true,
    })
  }
  // A seeded page: the mock's minted ids are not ULIDs, which a ref item must be.
  const targetId = '00000000000000000000PAGE02'
  const { id } = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'content',
    content,
    parentId,
    index: null,
    scope: SCOPE,
    blockId: null,
  })
  const empty = { value_text: null, value_num: null, value_date: null, value_ref: null }
  for (const [key, items] of [
    ['steps', STAGE_ITEMS],
    ['links', [targetId]],
  ] as const) {
    await ipc(page, 'set_property', {
      blockId: id,
      key,
      value: { ...empty, value_bool: null, value_list: items },
    })
  }
  return { blockId: id, want: { steps: STAGE_ITEMS, links: [targetId] } }
}

test.describe('A block’s lists copied by Duplicate and /template (#6741) @editor @pages', () => {
  test('a duplicated block holds the same lists, its ref list by block id', async ({ page }) => {
    const projects = '00000000000000000000PAGE04'
    const { blockId, want } = await seedListBlock(page, projects, 'Listed original')
    await openPage(page, 'Projects')
    const before = await children(page, projects)
    await focusBlockById(page, blockId)
    await page.keyboard.press('Control+Shift+J')
    await expect.poll(async () => (await children(page, projects)).length).toBe(before.length + 1)

    const copies = (await children(page, projects)).filter((c) => c.content === 'Listed original')
    expect(copies).toHaveLength(2)
    for (const copy of copies) expect(await listsOf(page, copy.id)).toEqual(want)
    await reopenPage(page, 'Projects')
    await expect(
      page.getByTestId('sortable-block').filter({ hasText: 'Listed original' }),
    ).toHaveCount(2)
  })

  test('a template block holding the lists is inserted holding them', async ({ page }) => {
    const template = '00000000000000000000PAGE06'
    const { want } = await seedListBlock(page, template, 'Listed template line')
    await openPage(page, 'Getting Started')
    await focusBlock(page)
    await typeSlashCommand(page, 'template')
    await page.keyboard.press('Enter')
    await activeRoleDialog(page).getByText('Meeting Notes Template').click()
    await expect(page.getByText('Template inserted')).toBeVisible()

    const gettingStarted = '00000000000000000000PAGE01'
    await expect
      .poll(async () =>
        (await children(page, gettingStarted)).filter((c) => c.content === 'Listed template line'),
      )
      .toHaveLength(1)
    const copy = (await children(page, gettingStarted)).find(
      (c) => c.content === 'Listed template line',
    )
    expect(await listsOf(page, copy?.id ?? '')).toEqual(want)
    await reopenPage(page, 'Getting Started')
    await expect(page.getByText('Listed template line')).toBeVisible()
  })
})
