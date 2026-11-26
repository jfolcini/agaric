import type { Locator, Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import { dragBlock, expect, ipc, openPage, reopenPage, test, waitForBoot } from './helpers'

/**
 * #7040 S5b — a folded heading's drag carries the section it hides, in one
 * batch move that one Undo takes back; an unfolded heading's drag moves just
 * its own line. Checked on the order the backend stores, after navigating away
 * and back.
 */

const PAGE = 'Heading Fold Drag'
const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }

interface Ids {
  pageId: string
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

/** `## One`, `one a`, `one b`, `## Two`, `two a`, all at the top level. */
async function seed(page: Page): Promise<Ids> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: PAGE,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  const one = await add(page, pageId, '## One')
  const oneA = await add(page, pageId, 'one a')
  const oneB = await add(page, pageId, 'one b')
  const two = await add(page, pageId, '## Two')
  const twoA = await add(page, pageId, 'two a')
  return { pageId, one, oneA, oneB, two, twoA }
}

/** The ids the backend holds under `parentId`, in stored order. */
async function stored(page: Page, parentId: string): Promise<string[]> {
  const resp = await ipc<{ items: { id: string }[] }>(page, 'list_blocks', {
    request: { parentId, limit: 100 },
    scope: SCOPE,
  })
  return resp.items.map((item) => item.id)
}

const row = (page: Page, id: string): Locator => page.locator(`li[data-block-id="${id}"]`)

/** The ids of the rows shown, in order. */
function shown(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-block"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-block-id') ?? ''))
}

/** Drag block `id` by its handle onto block `onto`. */
async function drag(page: Page, id: string, onto: string): Promise<void> {
  const source = page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`)
  await source.hover()
  const handle = source.locator('[data-testid="drag-handle"]')
  await expect(handle).toBeVisible()
  await dragBlock(
    page,
    handle,
    page.locator(`[data-testid="sortable-block"][data-block-id="${onto}"]`),
  )
}

test.describe('Dragging a heading @editor', () => {
  let ids: Ids
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    ids = await seed(page)
    await openPage(page, PAGE)
    await expect(row(page, ids.twoA)).toBeVisible()
  })

  test('a folded heading carries its section, and one Undo puts it back', async ({ page }) => {
    const { pageId, one, oneA, oneB, two, twoA } = ids
    await row(page, one).hover()
    await row(page, one).getByTestId('collapse-toggle').click()
    await expect.poll(() => shown(page)).toEqual([one, two, twoA])

    await drag(page, one, twoA)
    await expect.poll(() => stored(page, pageId)).toEqual([two, twoA, one, oneA, oneB])
    await expect.poll(() => shown(page)).toEqual([two, twoA, one])

    await page.keyboard.press('Control+z')
    await expect.poll(() => stored(page, pageId)).toEqual([one, oneA, oneB, two, twoA])

    await reopenPage(page, PAGE)
    await expect.poll(() => shown(page)).toEqual([one, two, twoA])
    expect(await stored(page, pageId)).toEqual([one, oneA, oneB, two, twoA])
  })

  test('an unfolded heading moves just its own line', async ({ page }) => {
    const { pageId, one, oneA, oneB, two, twoA } = ids
    await drag(page, one, twoA)
    await expect.poll(() => stored(page, pageId)).toEqual([oneA, oneB, two, twoA, one])

    await reopenPage(page, PAGE)
    await expect.poll(() => shown(page)).toEqual([oneA, oneB, two, twoA, one])
  })
})
