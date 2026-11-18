import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import { blockRow } from './domain'
import { blurEditors, expect, focusBlockById, ipc, reopenPage, test, waitForBoot } from './helpers'

/**
 * E2E for Duplicate (#976 item 13, #5140 Phase 3a) through its two UI entry
 * points: the `Ctrl+Shift+J` chord and the block context-menu row.
 *
 * Duplicate used to serialize the subtree to an indented-markdown outline and
 * paste it back, so a multi-line block came back as one block per line and
 * every copy lost its task state, priority, dates, list style and properties.
 * It is now one `duplicate_block` command that copies rows. Every assertion
 * reads the backend back (`list_blocks`) or re-renders the page, never
 * which IPC fired.
 */

const PAGE = 'Getting Started'
const PAGE_ID = '00000000000000000000PAGE01'
const GS1 = '0000000000000000000B10CK01'
const GS3 = '0000000000000000000B10CK03'
const FENCED = '```\nfirst line\nsecond line\n```'
const CHILD_TEXT = 'a child that travels with its parent'

interface Row {
  id: string
  content: string | null
  todo_state: string | null
  priority: string | null
}

async function childrenOf(page: Page, parentId: string): Promise<Row[]> {
  const resp = await ipc<{ items: Row[] }>(page, 'list_blocks', {
    request: { parentId, limit: 100 },
    scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
  })
  return resp.items
}

/** The sibling that sits right after `id` among the page's top-level blocks. */
async function nextSiblingOf(page: Page, id: string): Promise<Row | undefined> {
  const rows = await childrenOf(page, PAGE_ID)
  return rows[rows.findIndex((r) => r.id === id) + 1]
}

const text = (value_text: string) => ({
  value_text,
  value_num: null,
  value_date: null,
  value_ref: null,
  value_bool: null,
})

/** The value of property `key` the backend holds for block `blockId`, or null. */
async function propertyOf(page: Page, blockId: string, key: string): Promise<string | null> {
  const props = await ipc<Array<{ key: string; value_text: string | null }>>(
    page,
    'get_properties',
    { blockId },
  )
  return props.find((p) => p.key === key)?.value_text ?? null
}

/** Duplicate block `id` with Ctrl+Shift+J; resolves to the copy, read back from the backend. */
async function duplicateByChord(page: Page, id: string): Promise<Row> {
  const before = (await childrenOf(page, PAGE_ID)).length
  await focusBlockById(page, id)
  await page.keyboard.press('Control+Shift+J')
  await expect.poll(async () => (await childrenOf(page, PAGE_ID)).length).toBe(before + 1)
  await blurEditors(page)
  const copy = await nextSiblingOf(page, id)
  expect(copy?.id).not.toBe(id)
  return copy as Row
}

async function addChild(page: Page, parentId: string, content: string): Promise<string> {
  const row = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'content',
    content,
    parentId,
    index: null,
    scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
    blockId: null,
  })
  return row.id
}

test.describe('Duplicate block (#5140 Phase 3a) @editor', () => {
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

  // The command copies through the Document buffer (#6190), where a bulleted
  // block is a `- ` item and a task `- [ ] x`: only the real render and read show
  // that the copy keeps its kind.
  test('Ctrl+Shift+J copies a bulleted block bulleted and a task as a task (#6190)', async ({
    page,
  }) => {
    await ipc(page, 'set_property', { blockId: GS1, key: 'listStyle', value: text('bullet') })
    await ipc(page, 'set_todo_state', { blockId: GS3, state: 'TODO' })
    await reopenPage(page, PAGE)

    const bullet = await duplicateByChord(page, GS1)
    const task = await duplicateByChord(page, GS3)
    for (const id of [GS1, bullet.id]) {
      expect(await propertyOf(page, id, 'listStyle')).toBe('bullet')
    }
    expect(task.todo_state).toBe('TODO')
    expect(await propertyOf(page, task.id, 'listStyle')).toBeNull()

    await reopenPage(page, PAGE)
    for (const id of [GS1, bullet.id]) {
      await expect(blockRow(page, id).getByTestId('list-marker')).toBeVisible()
    }
    for (const id of [GS3, task.id]) {
      await expect(blockRow(page, id).getByTestId('task-checkbox-todo')).toBeVisible()
    }
  })

  // The buffer used to leave the recurrence rule out (#5160 P4), so the copy of
  // a weekly task was a task that did not repeat.
  test('the Ctrl+Shift+J copy of a weekly task repeats weekly', async ({ page }) => {
    await ipc(page, 'set_todo_state', { blockId: GS3, state: 'TODO' })
    await ipc(page, 'set_property', { blockId: GS3, key: 'repeat', value: text('+1w') })
    await reopenPage(page, PAGE)
    await expect(blockRow(page, GS3).locator('.repeat-indicator')).toBeVisible()

    const copy = await duplicateByChord(page, GS3)
    expect(copy.todo_state).toBe('TODO')
    expect(await propertyOf(page, copy.id, 'repeat')).toBe('+1w')

    await reopenPage(page, PAGE)
    await expect(blockRow(page, copy.id).locator('.repeat-indicator')).toBeVisible()
  })
})
