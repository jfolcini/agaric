import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import { blockRow } from './domain'
import {
  expect,
  focusBlockById,
  ipc,
  openPage,
  reopenPage,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5160 D8 / N7: typing `#project` and a space, or `#[[multi word]]`, in a
 * block makes the tag. The block is stored with `#[ULID]` and the tag exists;
 * both are read back from the mock backend. Follow-up 7a: a `#name` still text
 * when the block is saved (the picker dismissed) is made the tag then.
 */

const PAGE = 'Getting Started'
const GS1 = '0000000000000000000B10CK01'
const GS2 = '0000000000000000000B10CK02'
const TAG_REF = /#\[([0-9A-Z]{26})\]/g

interface TagRow {
  tag_id: string
  name: string
}

async function storedContent(page: Page): Promise<string> {
  return (await ipc<{ content: string }>(page, 'get_block', { blockId: GS1 })).content
}

async function tagNames(page: Page): Promise<Map<string, string>> {
  const rows = await ipc<TagRow[]>(page, 'list_all_tags_in_space', {
    scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
  })
  return new Map(rows.map((row) => [row.tag_id, row.name]))
}

test.describe('Typing # makes a tag (#5160 D8) @editor @pages', () => {
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
    // #6278 I4 — a new tag name holds no whitespace.
    expect(ids.map((id) => names.get(id))).toEqual(['project', 'multi-word'])
  })

  test('a #name left as text by Escape is a tag once Enter saves the block', async ({ page }) => {
    const editor = await focusBlockById(page, GS1)
    await editor.press('End')
    await page.keyboard.type(' #later', { delay: 30 })
    await page.keyboard.press('Escape')
    await expect(editor.locator('[data-testid="tag-ref-chip"]')).toHaveCount(0)
    await saveBlock(page)

    await expect.poll(() => storedContent(page)).toMatch(/^Plan #\[[0-9A-Z]{26}\]$/)
    const [id] = [...(await storedContent(page)).matchAll(TAG_REF)].map((m) => m[1] as string)
    expect((await tagNames(page)).get(id as string)).toBe('later')
  })

  test('a #name left as text is the existing tag once a click away saves the block', async ({
    page,
  }) => {
    const editor = await focusBlockById(page, GS1)
    await editor.press('End')
    await page.keyboard.type(' #Work', { delay: 30 })
    await page.keyboard.press('Escape')
    await page.locator(`[data-testid="block-static"][data-block-id="${GS2}"]`).click()

    await expect.poll(() => storedContent(page)).toMatch(/^Plan #\[[0-9A-Z]{26}\]$/)
    const [id] = [...(await storedContent(page)).matchAll(TAG_REF)].map((m) => m[1] as string)
    expect((await tagNames(page)).get(id as string)).toBe('work')
  })

  test('a #name made a tag after the page reopened shows as the tag (#6953)', async ({ page }) => {
    const editor = await focusBlockById(page, GS1)
    await editor.press('End')
    await page.keyboard.type(' #newtagname', { delay: 30 })
    await page.keyboard.press('Escape')
    // The new tag is created only after the page has been read again.
    await page.evaluate(() => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, ...rest: unknown[]) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__
      const invoke = internals.invoke.bind(internals)
      internals.invoke = async (cmd, ...rest) => {
        if (cmd === 'create_block') await new Promise((resolve) => setTimeout(resolve, 500))
        return invoke(cmd, ...rest)
      }
    })
    await saveBlock(page, 'Escape')
    await reopenPage(page, PAGE)

    await expect(blockRow(page, GS1).getByTestId('tag-ref-chip')).toHaveText('newtagname')
    expect(await storedContent(page)).toMatch(/^Plan #\[[0-9A-Z]{26}\]$/)
  })

  test('a #name made a tag after the reopened page has read its blocks shows as the tag (#6953)', async ({
    page,
  }) => {
    const editor = await focusBlockById(page, GS1)
    await editor.press('End')
    await page.keyboard.type(' #loadingtag', { delay: 30 })
    await page.keyboard.press('Escape')
    // The leave's writes wait until the reopened page has read its blocks, so that read predates
    // both the typed text and the rewrite.
    await page.evaluate((pageId) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, ...rest: unknown[]) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__
      const invoke = internals.invoke.bind(internals)
      let pageRead: () => void = () => undefined
      const read = new Promise<void>((resolve) => {
        pageRead = resolve
      })
      internals.invoke = async (cmd, ...rest) => {
        const args = rest[0] as { rootBlockId?: string } | undefined
        if (cmd === 'edit_block') {
          await read
          return invoke(cmd, ...rest)
        }
        const answer = await invoke(cmd, ...rest)
        if (cmd === 'load_page_subtree' && args?.rootBlockId === pageId) pageRead()
        return answer
      }
    }, SEED_IDS.PAGE_GETTING_STARTED)
    await saveBlock(page, 'Escape')
    await reopenPage(page, PAGE)

    await expect(blockRow(page, GS1).getByTestId('tag-ref-chip')).toHaveText('loadingtag')
    expect(await storedContent(page)).toMatch(/^Plan #\[[0-9A-Z]{26}\]$/)
  })
})
