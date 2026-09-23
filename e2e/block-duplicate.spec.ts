import type { Page } from '@playwright/test'

import { blurEditors, expect, focusBlockById, reopenPage, test, waitForBoot } from './helpers'

/**
 * E2E for Duplicate (#976 item 13, #5140 Phase 3a) through its two UI entry
 * points: the `Ctrl+Shift+J` chord and the block context-menu row.
 *
 * Duplicate used to serialize the subtree to an indented-markdown outline and
 * paste it back, so a multi-line block came back as one block per line and
 * every copy lost its task state, priority, dates, list style and properties.
 * It is now one `duplicate_block` command that copies rows. Every assertion
 * reads the mock backend back (`list_blocks`) or re-renders the page, never
 * which IPC fired.
 */

const PAGE = 'Getting Started'
const PAGE_ID = '00000000000000000000PAGE01'
const GS1 = '0000000000000000000BLOCK01'
const GS3 = '0000000000000000000BLOCK03'
const FENCED = '```\nfirst line\nsecond line\n```'
const CHILD_TEXT = 'a child that travels with its parent'

interface Row {
  id: string
  content: string | null
  todo_state: string | null
  priority: string | null
}

function ipc<T>(page: Page, cmd: string, args: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    ({ c, a }) => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke
      return invoke(c, a)
    },
    { c: cmd, a: args },
  ) as Promise<T>
}

async function childrenOf(page: Page, parentId: string): Promise<Row[]> {
  const resp = await ipc<{ items: Row[] }>(page, 'list_blocks', {
    request: { parentId, limit: 100 },
  })
  return resp.items
}

/** The sibling that sits right after `id` among the page's top-level blocks. */
async function nextSiblingOf(page: Page, id: string): Promise<Row | undefined> {
  const rows = await childrenOf(page, PAGE_ID)
  return rows[rows.findIndex((r) => r.id === id) + 1]
}

async function addChild(page: Page, parentId: string, content: string): Promise<string> {
  const row = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'content',
    content,
    parentId,
    index: null,
    scope: { kind: 'global' },
    blockId: null,
  })
  return row.id
}

test.describe('Duplicate block (#5140 Phase 3a)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+Shift+J on a two-line fenced code block makes ONE copy with identical content', async ({
    page,
  }) => {
    await ipc(page, 'edit_block', { blockId: GS1, toText: FENCED })
    await reopenPage(page, PAGE)
    const before = await childrenOf(page, PAGE_ID)

    await focusBlockById(page, GS1)
    await page.keyboard.press('Control+Shift+J')

    await expect.poll(async () => (await childrenOf(page, PAGE_ID)).length).toBe(before.length + 1)
    const original = before.find((r) => r.id === GS1)
    const copy = await nextSiblingOf(page, GS1)
    expect(original?.content).toContain('first line\nsecond line')
    expect(copy?.id).not.toBe(GS1)
    expect(copy?.content).toBe(original?.content)
    expect(await childrenOf(page, copy?.id ?? '')).toEqual([])

    // The original keeps the editor across the reopen, so count the code
    // elements (static or editing) rather than the static rows.
    await reopenPage(page, PAGE)
    await expect(
      page.getByRole('list', { name: 'Block tree' }).locator('code', { hasText: 'second line' }),
    ).toHaveCount(2)
  })

  test('the context-menu Duplicate row keeps TODO, the priority and the child', async ({
    page,
  }) => {
    await ipc(page, 'set_todo_state', { blockId: GS3, state: 'TODO' })
    await ipc(page, 'set_priority', { blockId: GS3, level: '1' })
    const originalChild = await addChild(page, GS3, CHILD_TEXT)
    await reopenPage(page, PAGE)
    const before = await childrenOf(page, PAGE_ID)

    await page
      .locator(`[data-testid="block-static"][data-block-id="${GS3}"]`)
      .click({ button: 'right', position: { x: 6, y: 6 } })
    const menu = page.getByRole('menu', { name: 'Block actions' }).last()
    await menu.getByRole('menuitem', { name: 'Move & arrange' }).click()
    await menu.getByRole('menuitem', { name: 'Duplicate' }).click()

    await expect.poll(async () => (await childrenOf(page, PAGE_ID)).length).toBe(before.length + 1)
    const original = before.find((r) => r.id === GS3)
    const copy = await nextSiblingOf(page, GS3)
    expect(copy?.id).not.toBe(GS3)
    expect(copy?.content).toBe(original?.content)
    expect(copy?.todo_state).toBe('TODO')
    expect(copy?.priority).toBe('1')
    const copyChildren = await childrenOf(page, copy?.id ?? '')
    expect(copyChildren.map((r) => r.content)).toEqual([CHILD_TEXT])
    expect(copyChildren[0]?.id).not.toBe(originalChild)
  })

  test('one Ctrl+Z after a duplicate removes the whole copy', async ({ page }) => {
    const originalChild = await addChild(page, GS3, CHILD_TEXT)
    await reopenPage(page, PAGE)
    const before = await childrenOf(page, PAGE_ID)

    await focusBlockById(page, GS3)
    await page.keyboard.press('Control+Shift+J')
    await expect.poll(async () => (await childrenOf(page, PAGE_ID)).length).toBe(before.length + 1)
    const copy = await nextSiblingOf(page, GS3)
    const copyChild = (await childrenOf(page, copy?.id ?? ''))[0]
    expect(copyChild?.content).toBe(CHILD_TEXT)

    await blurEditors(page)
    await page.keyboard.press('Control+z')
    await expect(page.getByLabel('Notifications alt+T').getByText(/Und(one|id)/)).toBeVisible()

    await expect
      .poll(async () => (await childrenOf(page, PAGE_ID)).map((r) => r.id))
      .toEqual(before.map((r) => r.id))
    expect((await childrenOf(page, GS3)).map((r) => r.id)).toEqual([originalChild])
    expect(await childrenOf(page, copy?.id ?? '')).toEqual([])

    await reopenPage(page, PAGE)
    await expect(
      page.locator(`[data-testid="sortable-block"][data-block-id="${GS3}"]`),
    ).toHaveCount(1)
    await expect(
      page.locator(`[data-testid="sortable-block"][data-block-id="${copy?.id}"]`),
    ).toHaveCount(0)
  })
})
