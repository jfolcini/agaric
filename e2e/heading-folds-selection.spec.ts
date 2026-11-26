import type { Locator, Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeAlertDialog,
  activeMenu,
  blurEditors,
  expect,
  ipc,
  openPage,
  readClipboard,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * #7040 decision 30 — a selection that holds a folded heading takes the
 * section the fold hides with it, as the heading's drag does: a batch delete,
 * a cut, and a bulk indent. One Undo puts it all back. Checked on the order the
 * backend stores, after navigating away and back.
 */

const PAGE = 'Heading Fold Selection'
const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }

interface Ids {
  pageId: string
  p: string
  one: string
  oneA: string
  oneB: string
  two: string
  twoA: string
}

async function add(page: Page, parentId: string, content: string): Promise<string> {
  const row = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'content',
    content,
    parentId,
    index: null,
    scope: SCOPE,
    blockId: null,
  })
  return row.id
}

/** `p`, `## One`, `one a`, `one b`, `## Two`, `two a`, all at the top level. */
async function seed(page: Page): Promise<Ids> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: PAGE,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  const p = await add(page, pageId, 'p')
  const one = await add(page, pageId, '## One')
  const oneA = await add(page, pageId, 'one a')
  const oneB = await add(page, pageId, 'one b')
  const two = await add(page, pageId, '## Two')
  const twoA = await add(page, pageId, 'two a')
  return { pageId, p, one, oneA, oneB, two, twoA }
}

/** The ids the backend holds under `parentId`, in stored order. */
async function stored(page: Page, parentId: string): Promise<string[]> {
  const resp = await ipc<{ items: { id: string }[] }>(page, 'list_blocks', {
    request: { parentId, limit: 100 },
    scope: SCOPE,
  })
  return resp.items.map((item) => item.id)
}

const row = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`)

/** Ctrl+Click each block's padding corner, which a chip or link never covers. */
async function select(page: Page, ids: string[]): Promise<void> {
  for (const id of ids) {
    await row(page, id)
      .locator('[data-testid="block-static"]')
      .click({ modifiers: ['Control'], position: { x: 6, y: 6 } })
  }
}

test.describe('A selection with a folded heading @editor', () => {
  let ids: Ids
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    ids = await seed(page)
    await openPage(page, PAGE)
    await expect(row(page, ids.twoA)).toBeVisible()
    await row(page, ids.one).hover()
    await row(page, ids.one).getByTestId('collapse-toggle').click()
    await expect(row(page, ids.oneA)).toHaveCount(0)
  })

  test('a batch delete takes the section, and one Undo brings it all back', async ({ page }) => {
    const { pageId, p, one, oneA, oneB, two, twoA } = ids
    await select(page, [one, two])
    await expect(page.getByTestId('batch-toolbar')).toContainText('2 selected')

    await page.getByTestId('batch-toolbar').getByRole('button', { name: 'Delete' }).click()
    await activeAlertDialog(page).getByRole('button', { name: 'Yes, delete', exact: true }).click()
    await expect.poll(() => stored(page, pageId)).toEqual([p, twoA])

    await blurEditors(page)
    await page.keyboard.press('Control+z')
    await expect.poll(() => stored(page, pageId)).toEqual([p, one, oneA, oneB, two, twoA])

    await reopenPage(page, PAGE)
    await expect(row(page, twoA)).toBeVisible()
    await expect(row(page, oneA)).toHaveCount(0)
    expect(await stored(page, pageId)).toEqual([p, one, oneA, oneB, two, twoA])
  })

  test('a cut puts the section on the clipboard and takes it away, and one Undo brings it back', async ({
    context,
    page,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const { pageId, p, one, oneA, oneB, two, twoA } = ids
    await blurEditors(page)
    await select(page, [one])

    await page.keyboard.press('Control+x')
    await expect.poll(() => stored(page, pageId)).toEqual([p, two, twoA])
    const clipboard = await readClipboard(page)
    expect(clipboard).toContain('One')
    expect(clipboard).toContain('one a')
    expect(clipboard).toContain('one b')
    expect(clipboard).not.toContain('two a')

    await page.keyboard.press('Control+z')
    await expect.poll(() => stored(page, pageId)).toEqual([p, one, oneA, oneB, two, twoA])

    await reopenPage(page, PAGE)
    await expect(row(page, twoA)).toBeVisible()
    expect(await stored(page, pageId)).toEqual([p, one, oneA, oneB, two, twoA])
  })

  test('a bulk indent takes the section under the block above, and one Undo puts it back', async ({
    page,
  }) => {
    const { pageId, p, one, oneA, oneB, two, twoA } = ids
    await select(page, [one, two])

    await row(page, two).locator('[data-testid="block-static"]').click({ button: 'right' })
    const menu = activeMenu(page)
    await menu.getByRole('menuitem', { name: 'Move & arrange' }).click()
    await menu.getByRole('menuitem', { name: /^Indent/ }).click()
    await expect(menu).toHaveCount(0)
    await expect.poll(() => stored(page, p)).toEqual([one, oneA, oneB, two])
    expect(await stored(page, pageId)).toEqual([p, twoA])

    await blurEditors(page)
    await page.keyboard.press('Control+z')
    await expect.poll(() => stored(page, pageId)).toEqual([p, one, oneA, oneB, two, twoA])

    await reopenPage(page, PAGE)
    await expect(row(page, twoA)).toBeVisible()
    expect(await stored(page, p)).toEqual([])
  })
})
