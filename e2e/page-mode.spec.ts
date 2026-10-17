/**
 * Page mode (#5691) on a 200-block page against the mock backend: the page
 * as one document, its keys, its continuous save read back from the backend,
 * undo restoring a deleted block by id, a peer's edit patched in place, the
 * switch back to blocks, the block cap, and axe on the page-mode surface.
 */

import { createRequire } from 'node:module'

import type { Page } from '@playwright/test'

import { expect, installIpcRecorder, getInvokeCalls, test, waitForBoot } from './helpers'

const axePath = createRequire(import.meta.url).resolve('axe-core')
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'

interface MockWindow {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
  __emitMockEvent?: (event: string, payload?: unknown) => Promise<void>
}

/** Call the backend as a peer or a test does: no local command, no event. */
function invoke<T>(page: Page, cmd: string, args: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    ({ cmd: c, args: a }) => (window as unknown as MockWindow).__TAURI_INTERNALS__.invoke(c, a),
    { cmd, args },
  ) as Promise<T>
}

interface Seeded {
  pageId: string
  /** Block ids in document order. */
  ids: string[]
}

/**
 * A page titled `title` holding `count` blocks, `block 0` … `block N`; every
 * fifth block sits under the one before it.
 */
async function seedPage(page: Page, title: string, count: number): Promise<Seeded> {
  return page.evaluate(
    async ({ title: t, count: n, scope }) => {
      const call = (cmd: string, args: Record<string, unknown>) =>
        (window as unknown as MockWindow).__TAURI_INTERNALS__.invoke(cmd, args)
      const pageId = (await call('create_page_in_space', {
        parentId: null,
        content: t,
        spaceId: scope.space_id,
      })) as string
      const nested = (i: number) => i % 5 === 4
      const top = (await call('create_blocks_batch', {
        specs: Array.from({ length: n }, (_, i) => i)
          .filter((i) => !nested(i))
          .map((i) => ({
            blockType: 'content',
            content: `block ${i}`,
            parentId: pageId,
            position: null,
          })),
      })) as { blocks: Array<{ id: string; content: string }> }
      const byText = new Map(top.blocks.map((b) => [b.content, b.id]))
      const children = (await call('create_blocks_batch', {
        specs: Array.from({ length: n }, (_, i) => i)
          .filter(nested)
          .map((i) => ({
            blockType: 'content',
            content: `block ${i}`,
            parentId: byText.get(`block ${i - 1}`),
            position: null,
          })),
      })) as { blocks: Array<{ id: string; content: string }> }
      for (const b of children.blocks) byText.set(b.content, b.id)
      return {
        pageId,
        ids: Array.from({ length: n }, (_, i) => byText.get(`block ${i}`) as string),
      }
    },
    { title, count, scope: SCOPE },
  )
}

async function openViaPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+k')
  const input = page.locator('[cmdk-input]').first()
  await input.fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

function modeSwitch(page: Page, name: 'Blocks' | 'Page') {
  return page.getByRole('radiogroup', { name: 'Editing mode' }).getByRole('radio', { name })
}

async function openInPageMode(page: Page, title: string, count: number): Promise<void> {
  await openViaPalette(page, title)
  await modeSwitch(page, 'Page').click()
  await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(count)
}

interface DocBlock {
  id: string
  depth: number
  text: string
}

/** The page-mode document as shown: each block's id, depth and text. */
function shown(page: Page): Promise<DocBlock[]> {
  return page.locator(`${EDITOR} [data-page-block]`).evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute('data-page-block-id') ?? '',
      depth: Number(el.getAttribute('data-depth')),
      text: el.textContent ?? '',
    })),
  )
}

/** The page as the backend holds it now: live blocks in document order, with depth. */
async function backend(page: Page, pageId: string): Promise<DocBlock[]> {
  const { blocks } = await invoke<{
    blocks: Array<{ id: string; parent_id: string; position: number; content: string | null }>
  }>(page, 'load_page_subtree', { rootBlockId: pageId, scope: SCOPE })
  const children = new Map<string, typeof blocks>()
  for (const b of blocks) children.set(b.parent_id, [...(children.get(b.parent_id) ?? []), b])
  const out: DocBlock[] = []
  const walk = (parent: string, depth: number): void => {
    for (const b of (children.get(parent) ?? []).toSorted((x, y) => x.position - y.position)) {
      out.push({ id: b.id, depth, text: b.content ?? '' })
      walk(b.id, depth + 1)
    }
  }
  walk(pageId, 0)
  return out
}

/** Put the cursor `offset` characters into block `index`'s text, and focus the document. */
async function caret(page: Page, index: number, offset: number | 'end'): Promise<void> {
  await page.evaluate(
    ({ selector, index: i, offset: o }) => {
      const dom = document.querySelector(selector) as HTMLElement & {
        editor: {
          state: {
            doc: {
              child: (n: number) => { nodeSize: number; firstChild: { content: { size: number } } }
            }
          }
          commands: { setTextSelection: (pos: number) => boolean }
          view: { focus: () => void }
        }
      }
      const { editor } = dom
      let pos = 0
      for (let k = 0; k < i; k += 1) pos += editor.state.doc.child(k).nodeSize
      const length = editor.state.doc.child(i).firstChild.content.size
      editor.commands.setTextSelection(pos + 2 + (o === 'end' ? length : o))
      editor.view.focus()
    },
    { selector: EDITOR, index, offset },
  )
  await expect(page.locator(EDITOR)).toBeFocused()
}

/** The block the cursor is in, and how far into its text. */
function cursor(page: Page): Promise<{ index: number; offset: number }> {
  return page.evaluate((selector) => {
    const { editor } = document.querySelector(selector) as HTMLElement & {
      editor: {
        state: { selection: { $from: { index: (d: number) => number; parentOffset: number } } }
      }
    }
    const { $from } = editor.state.selection
    return { index: $from.index(0), offset: $from.parentOffset }
  }, EDITOR)
}

test.describe('page mode (#5691)', () => {
  let seeded: Seeded

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    seeded = await seedPage(page, 'Page mode spike', 200)
    await openInPageMode(page, 'Page mode spike', 200)
  })

  test('shows the 200 blocks as one document, nested as they are, with no axe violations', async ({
    page,
  }) => {
    const blocks = await shown(page)
    expect(blocks.map((b) => b.id)).toEqual(seeded.ids)
    expect(blocks.filter((b) => b.depth === 1)).toHaveLength(40)
    expect(blocks[4]).toEqual({ id: seeded.ids[4], depth: 1, text: 'block 4' })
    await expect(modeSwitch(page, 'Page')).toHaveAttribute('aria-checked', 'true')

    await page.addScriptTag({ path: axePath })
    const violations = await page.evaluate(async () => {
      const run = (
        window as unknown as {
          axe: {
            run: (el: Element) => Promise<{ violations: Array<{ id: string; nodes: unknown[] }> }>
          }
        }
      ).axe.run
      const found: Array<{ id: string; count: number }> = []
      // The switch may sit in the app header, outside the page's own column.
      for (const selector of ['.page-editor', '[role="radiogroup"]']) {
        // axe allows one run at a time.
        const { violations: list } = await run(document.querySelector(selector) as Element)
        found.push(...list.map((v) => ({ id: v.id, count: v.nodes.length })))
      }
      return found
    })
    expect(violations).toEqual([])
  })

  test('typing saves after a pause, and only the block typed in', async ({ page }) => {
    await installIpcRecorder(page)
    await caret(page, 10, 'end')

    await page.keyboard.type(' more', { delay: 30 })

    await expect
      .poll(async () => (await backend(page, seeded.pageId))[10]?.text)
      .toBe('block 10 more')
    expect(await getInvokeCalls(page, 'edit_block')).toEqual([
      { blockId: seeded.ids[10], toText: 'block 10 more' },
    ])
  })

  test('Enter, Tab, Shift+Tab and Backspace each reach the backend', async ({ page }) => {
    await caret(page, 20, 3)
    await page.keyboard.press('Enter')
    const split = (await shown(page))[21] as DocBlock
    expect(split.text).toBe('ck 20')
    await expect
      .poll(async () => (await backend(page, seeded.pageId)).slice(20, 22))
      .toEqual([
        { id: seeded.ids[20], depth: 0, text: 'blo' },
        { id: split.id, depth: 0, text: 'ck 20' },
      ])

    await page.keyboard.press('Tab')
    await expect.poll(async () => (await backend(page, seeded.pageId))[21]?.depth).toBe(1)
    await page.keyboard.press('Shift+Tab')
    await expect.poll(async () => (await backend(page, seeded.pageId))[21]?.depth).toBe(0)

    await caret(page, 21, 0)
    await page.keyboard.press('Backspace')
    await expect
      .poll(async () => (await backend(page, seeded.pageId)).slice(20, 22).map((b) => b.id))
      .toEqual([seeded.ids[20], seeded.ids[21]])
    expect((await backend(page, seeded.pageId))[20]?.text).toBe('block 20')
  })

  test('arrows move the cursor across blocks', async ({ page }) => {
    await caret(page, 0, 'end')

    // ProseMirror reads a native caret move on the next `selectionchange`.
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await cursor(page)).index).toBe(1)
    await page.keyboard.press('End')
    await expect.poll(() => cursor(page)).toEqual({ index: 1, offset: 'block 1'.length })
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => cursor(page)).toEqual({ index: 2, offset: 0 })
    await page.keyboard.press('ArrowUp')
    await expect.poll(async () => (await cursor(page)).index).toBe(1)
  })

  test('an undo that brings back a deleted block restores it by its id', async ({ page }) => {
    await installIpcRecorder(page)
    await caret(page, 31, 0)
    await page.keyboard.press('Backspace')
    await expect
      .poll(async () => (await backend(page, seeded.pageId)).map((b) => b.id))
      .not.toContain(seeded.ids[31])

    await page.keyboard.press('Control+z')

    await expect
      .poll(async () => (await backend(page, seeded.pageId)).slice(30, 32))
      .toEqual([
        { id: seeded.ids[30], depth: 0, text: 'block 30' },
        { id: seeded.ids[31], depth: 0, text: 'block 31' },
      ])
    expect(await getInvokeCalls(page, 'restore_block')).toEqual([
      expect.objectContaining({ blockId: seeded.ids[31] }),
    ])
    expect(await getInvokeCalls(page, 'create_block')).toEqual([])
  })

  test('a peer’s edit shows in place, outside undo, and the cursor stays put', async ({ page }) => {
    await caret(page, 5, 3)
    await page.keyboard.type('X')
    await expect.poll(async () => (await backend(page, seeded.pageId))[5]?.text).toBe('bloXck 5')

    await invoke(page, 'edit_block', { blockId: seeded.ids[7], toText: 'block 7, from a peer' })
    await page.evaluate(
      (payload) => (window as unknown as MockWindow).__emitMockEvent?.('sync:complete', payload),
      {
        type: 'complete',
        remote_device_id: 'device-b',
        ops_received: 1,
        ops_sent: 0,
        changed_blocks: 1,
        changed_page_ids: [seeded.pageId],
      },
    )

    await expect(page.locator(`[data-page-block-id="${seeded.ids[7]}"]`)).toHaveText(
      'block 7, from a peer',
    )
    expect(await cursor(page)).toEqual({ index: 5, offset: 4 })

    await page.keyboard.press('Control+z')
    await expect(page.locator(`[data-page-block-id="${seeded.ids[5]}"]`)).toHaveText('block 5')
    await expect(page.locator(`[data-page-block-id="${seeded.ids[7]}"]`)).toHaveText(
      'block 7, from a peer',
    )
    await expect.poll(async () => (await backend(page, seeded.pageId))[5]?.text).toBe('block 5')
    expect((await backend(page, seeded.pageId))[7]?.text).toBe('block 7, from a peer')
  })

  test('switching back to blocks saves the text typed just before', async ({ page }) => {
    await caret(page, 2, 'end')
    await page.keyboard.type(' typed')

    await modeSwitch(page, 'Blocks').click()

    await expect(
      page.locator('[data-testid="block-static"]').filter({ hasText: 'block 2 typed' }),
    ).toBeVisible()
    await expect(modeSwitch(page, 'Blocks')).toHaveAttribute('aria-checked', 'true')
    expect((await backend(page, seeded.pageId))[2]?.text).toBe('block 2 typed')
  })
})

test('a page over the 500-block cap stays in block mode, and says why', async ({ page }) => {
  await waitForBoot(page)
  await seedPage(page, 'Page mode over the cap', 501)
  await openViaPalette(page, 'Page mode over the cap')

  await modeSwitch(page, 'Page').click()

  await expect(
    page.getByText('Page mode opens pages of up to 500 blocks. This page has 501'),
  ).toBeVisible()
  await expect(page.locator('[data-testid="block-static"]').first()).toBeVisible()
  await expect(page.locator(EDITOR)).toHaveCount(0)
  await expect(modeSwitch(page, 'Blocks')).toHaveAttribute('aria-checked', 'true')
})
