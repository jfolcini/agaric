import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  blurEditors,
  clearInvokeCalls,
  expect,
  focusBlock,
  focusBlockById,
  getInvokeCalls,
  installIpcRecorder,
  ipc,
  openPage,
  reopenPage,
  replaceEditorText,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E for the keyboard structure keys: indent / dedent / move up / move down,
 * and the Enter split and Backspace merge (#5365).
 *
 * Seed: "Getting Started" holds GS_1…GS_5 at its top level, in that order.
 *
 * Every move is checked on the order and nesting the backend stores
 * (`list_blocks`), read back through IPC: the mock accepts `move_block` slots
 * the real backend rejects, so only a stored read shows a wrong slot on the
 * bridge. The recorder pins what a stored read cannot: one `move_block` per
 * key, and none for a no-op.
 */

const PAGE = 'Getting Started'
const PAGE_ID = SEED_IDS.PAGE_GETTING_STARTED
const GS1 = SEED_IDS.BLOCK_GS_1
const GS2 = SEED_IDS.BLOCK_GS_2
const GS3 = SEED_IDS.BLOCK_GS_3
const GS4 = SEED_IDS.BLOCK_GS_4
const GS5 = SEED_IDS.BLOCK_GS_5
const SEED_ORDER = [GS1, GS2, GS3, GS4, GS5]
const GS3_TEXT = 'Create new blocks by pressing Enter at the end of any block.'

interface Row {
  id: string
  content: string | null
}

/** The rows the backend holds under `parentId`, in stored order. */
async function storedRows(page: Page, parentId: string): Promise<Row[]> {
  const resp = await ipc<{ items: Row[] }>(page, 'list_blocks', {
    request: { parentId, limit: 100 },
    scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
  })
  return resp.items
}

/** The ids the backend holds under `parentId`, in stored order. */
async function storedChildren(page: Page, parentId: string): Promise<string[]> {
  return (await storedRows(page, parentId)).map((row) => row.id)
}

/** Each rendered row as `id@level`, in document order. */
function shownOutline(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-block"]')
    .evaluateAll((els) =>
      els.map(
        (el) =>
          `${el.getAttribute('data-block-id')}@${el.closest('li[aria-level]')?.getAttribute('aria-level')}`,
      ),
    )
}

/** Wait until the backend holds exactly `top` under the page and `children` under each parent. */
async function expectStored(
  page: Page,
  top: string[],
  children: Record<string, string[]> = {},
): Promise<void> {
  await expect.poll(() => storedChildren(page, PAGE_ID)).toEqual(top)
  for (const [parent, ids] of Object.entries(children)) {
    expect(await storedChildren(page, parent)).toEqual(ids)
  }
}

test.describe('Keyboard block movement @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  test('Ctrl+Shift+ArrowRight indents under the previous sibling', async ({ page }) => {
    await openPage(page, PAGE)
    await focusBlockById(page, GS3)
    await clearInvokeCalls(page)
    await page.keyboard.press('Control+Shift+ArrowRight')

    await expectStored(page, [GS1, GS2, GS4, GS5], { [GS2]: [GS3] })
    expect(await getInvokeCalls(page, 'move_block')).toHaveLength(1)
  })

  test('Ctrl+Shift+ArrowLeft dedents back to the root level, after its old parent', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    await focusBlockById(page, GS3)
    await page.keyboard.press('Control+Shift+ArrowRight')
    await expectStored(page, [GS1, GS2, GS4, GS5], { [GS2]: [GS3] })

    await clearInvokeCalls(page)
    await page.keyboard.press('Control+Shift+ArrowLeft')
    await expectStored(page, SEED_ORDER, { [GS2]: [] })
    expect(await getInvokeCalls(page, 'move_block')).toHaveLength(1)
  })

  // Pre-#400 this sent `position - 1 = -1`, which the real backend rejected.
  test('moving the 2nd block up puts it first', async ({ page }) => {
    await openPage(page, PAGE)
    await focusBlockById(page, GS2)
    await clearInvokeCalls(page)
    await page.keyboard.press('Control+Shift+ArrowUp')

    await expectStored(page, [GS2, GS1, GS3, GS4, GS5])
    expect(await getInvokeCalls(page, 'move_block')).toHaveLength(1)
  })

  test('moving the FIRST block up is a no-op (no move_block IPC)', async ({ page }) => {
    await openPage(page, PAGE)
    await focusBlock(page, 0) // GS_1
    await clearInvokeCalls(page)
    await page.keyboard.press('Control+Shift+ArrowUp')

    // Give the handler a beat; assert nothing was sent.
    await page.waitForTimeout(200)
    expect(await getInvokeCalls(page, 'move_block')).toHaveLength(0)
    expect(await storedChildren(page, PAGE_ID)).toEqual(SEED_ORDER)
  })

  // Pre-#400 this sent a position colliding with GS_3, so the ULID, not the
  // intent, decided the order.
  test('moving a block down swaps it past the next sibling', async ({ page }) => {
    await openPage(page, PAGE)
    await focusBlockById(page, GS1)
    await clearInvokeCalls(page)
    await page.keyboard.press('Control+Shift+ArrowDown')

    await expectStored(page, [GS2, GS1, GS3, GS4, GS5])
    expect(await getInvokeCalls(page, 'move_block')).toHaveLength(1)
  })

  test('moving the LAST block down is a no-op (no move_block IPC)', async ({ page }) => {
    await openPage(page, PAGE)
    await focusBlock(page, 4) // GS_5
    await clearInvokeCalls(page)
    await page.keyboard.press('Control+Shift+ArrowDown')

    // Give the handler a beat; assert nothing was sent.
    await page.waitForTimeout(200)
    expect(await getInvokeCalls(page, 'move_block')).toHaveLength(0)
    expect(await storedChildren(page, PAGE_ID)).toEqual(SEED_ORDER)
  })

  test('Tab indents and Shift+Tab dedents, as stored and shown after a reopen', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    await focusBlockById(page, GS3)
    await page.keyboard.press('Tab')
    await expectStored(page, [GS1, GS2, GS4, GS5], { [GS2]: [GS3] })

    await reopenPage(page, PAGE)
    await expect
      .poll(() => shownOutline(page))
      .toEqual([`${GS1}@1`, `${GS2}@1`, `${GS3}@2`, `${GS4}@1`, `${GS5}@1`])

    await focusBlockById(page, GS3)
    await page.keyboard.press('Shift+Tab')
    await expectStored(page, SEED_ORDER, { [GS2]: [] })
    // The editor stays in the block it moved.
    await expect(page.locator(`[data-testid="block-editor"][data-block-id="${GS3}"]`)).toBeVisible()

    await reopenPage(page, PAGE)
    await expect.poll(() => shownOutline(page)).toEqual(SEED_ORDER.map((id) => `${id}@1`))
  })

  // ── An in-flight edit survives the restructure ─────────────────────────

  /** Each chord must carry the text typed since the last commit. */
  const EDITED = 'GS_3 edited before the move'

  for (const [name, key] of [
    ['Ctrl+Shift+ArrowRight (indent)', 'Control+Shift+ArrowRight'],
    ['Ctrl+Shift+ArrowLeft (dedent)', 'Control+Shift+ArrowLeft'],
    ['Ctrl+Shift+ArrowUp (move up)', 'Control+Shift+ArrowUp'],
    ['Ctrl+Shift+ArrowDown (move down)', 'Control+Shift+ArrowDown'],
  ] as const) {
    test(`${name} keeps an uncommitted edit`, async ({ page }) => {
      await openPage(page, PAGE)
      await focusBlockById(page, GS3)
      await replaceEditorText(page, EDITED)
      await page.keyboard.press(key)

      // The editor stays on the same block, so the text must still be there.
      await expect(page.locator('[data-testid="block-editor"]')).toContainText(EDITED)

      // And it must be what the backend actually holds: navigate away (which
      // blurs and flushes) and re-fetch the page.
      await reopenPage(page, PAGE)
      await expect(page.locator(`[data-block-id="${GS3}"]`).first()).toContainText(EDITED)
    })
  }

  // ── Subtree integrity: moving a parent carries its child ───────────────

  test('moving a parent up carries its indented child with it', async ({ page }) => {
    await openPage(page, PAGE)
    await focusBlockById(page, GS3)
    await page.keyboard.press('Control+Shift+ArrowRight')
    await expectStored(page, [GS1, GS2, GS4, GS5], { [GS2]: [GS3] })

    // Move GS_2 up. GS_3 (its child) must stay its child, directly below it.
    await focusBlockById(page, GS2)
    await page.keyboard.press('Control+Shift+ArrowUp')

    await expectStored(page, [GS2, GS1, GS4, GS5], { [GS2]: [GS3] })
    await expect
      .poll(() => shownOutline(page))
      .toEqual([`${GS2}@1`, `${GS3}@2`, `${GS1}@1`, `${GS4}@1`, `${GS5}@1`])
  })
})

// The split is one `split_block` (a create and an edit in one transaction), the
// merge one `merge_blocks` (an edit, a move per child and a delete); each is one
// page undo entry (#6531).
test.describe('Enter split and Backspace merge, as stored (#5365) @editor', () => {
  const LEFT = 'Create new blocks '
  const RIGHT = 'by pressing Enter at the end of any block.'
  const CHILD = 'a child the merge carries'

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Enter mid-text splits a block and Backspace at its start merges it back, durably', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    await focusBlockById(page, GS3)
    await selectEditorRange(page, LEFT.length, LEFT.length)
    await page.keyboard.press('Enter')

    await expect.poll(async () => (await storedChildren(page, PAGE_ID)).length).toBe(6)
    const split = await storedRows(page, PAGE_ID)
    const newId = split[3]?.id as string
    expect(split.map((row) => row.id)).toEqual([GS1, GS2, GS3, newId, GS4, GS5])
    expect([split[2]?.content, split[3]?.content]).toEqual([LEFT, RIGHT])

    await reopenPage(page, PAGE)
    await focusBlockById(page, newId)
    await selectEditorRange(page, 0, 0)
    await page.keyboard.press('Backspace')

    await expectStored(page, SEED_ORDER)
    await reopenPage(page, PAGE)
    await expect.poll(() => shownOutline(page)).toEqual(SEED_ORDER.map((id) => `${id}@1`))
    expect((await storedRows(page, PAGE_ID))[2]?.content).toBe(GS3_TEXT)
  })

  test('one Ctrl+Z takes back a split, and one a merge with the child it moved (#6531)', async ({
    page,
  }) => {
    const child = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content: CHILD,
      parentId: GS4,
      index: null,
      scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
      blockId: null,
    })
    await openPage(page, PAGE)

    await focusBlockById(page, GS3)
    await selectEditorRange(page, LEFT.length, LEFT.length)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await storedChildren(page, PAGE_ID)).length).toBe(6)
    await blurEditors(page)
    await page.keyboard.press('Control+z')
    await expectStored(page, SEED_ORDER)
    expect((await storedRows(page, PAGE_ID))[2]?.content).toBe(GS3_TEXT)

    // Backspace at GS_4's start joins it into GS_3, which takes its child.
    await reopenPage(page, PAGE)
    await focusBlockById(page, GS4)
    await selectEditorRange(page, 0, 0)
    await page.keyboard.press('Backspace')
    await expectStored(page, [GS1, GS2, GS3, GS5], { [GS3]: [child.id] })
    await blurEditors(page)
    await page.keyboard.press('Control+z')
    await expectStored(page, SEED_ORDER, { [GS3]: [], [GS4]: [child.id] })
    expect((await storedRows(page, PAGE_ID))[2]?.content).toBe(GS3_TEXT)

    await reopenPage(page, PAGE)
    await expect
      .poll(() => shownOutline(page))
      .toEqual([`${GS1}@1`, `${GS2}@1`, `${GS3}@1`, `${GS4}@1`, `${child.id}@2`, `${GS5}@1`])
  })
})
