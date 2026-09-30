import type { Page } from '@playwright/test'

import { expect, focusBlockById, openPage, saveBlock, test, waitForBoot } from './helpers'

/**
 * #5160 D8 / N7: typing `#project` and a space, or `#[[multi word]]`, in a
 * block makes the tag. The block is stored with `#[ULID]` and the tag exists;
 * both are read back from the mock backend.
 */

const PAGE = 'Getting Started'
const GS1 = '0000000000000000000BLOCK01'
const TAG_REF = /#\[([0-9A-Z]{26})\]/g

interface TagRow {
  tag_id: string
  name: string
}

function ipc<T>(page: Page, cmd: string, args: unknown): Promise<T> {
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

async function storedContent(page: Page): Promise<string> {
  return (await ipc<{ content: string }>(page, 'get_block', { blockId: GS1 })).content
}

async function tagNames(page: Page): Promise<Map<string, string>> {
  const rows = await ipc<TagRow[]>(page, 'list_all_tags_in_space', {
    scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
  })
  return new Map(rows.map((row) => [row.tag_id, row.name]))
}

test.describe('Typing # makes a tag (#5160 D8)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await ipc(page, 'edit_block', { blockId: GS1, toText: 'Plan' })
    await openPage(page, PAGE)
  })

  test('#project and a space, and #[[multi word]], are stored as tags', async ({ page }) => {
    const editor = await focusBlockById(page, GS1)
    await editor.press('End')
    await page.keyboard.type(' #project and #[[multi word]] done', { delay: 30 })
    await expect(editor.locator('[data-testid="tag-ref-chip"]')).toHaveCount(2)
    await saveBlock(page)

    await expect
      .poll(() => storedContent(page))
      .toMatch(/^Plan #\[[0-9A-Z]{26}\] and #\[[0-9A-Z]{26}\] done$/)
    const ids = [...(await storedContent(page)).matchAll(TAG_REF)].map((m) => m[1] as string)
    const names = await tagNames(page)
    expect(ids.map((id) => names.get(id))).toEqual(['project', 'multi word'])
  })
})
