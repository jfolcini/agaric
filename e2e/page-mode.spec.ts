/**
 * Page mode (#5691) against the mock backend, on a 200-block page: the page as
 * one document, its keys, its continuous save read back from the backend, undo
 * restoring a deleted block by id, the switch back to blocks, and axe. Then
 * what keeps the page whole: changes made elsewhere (an edit, a block created,
 * moved or deleted, one deleted while typed in), cut and paste as a move,
 * paragraphs pasted from outside, Shift+Tab as block mode's, and the text saved
 * before an export and before leaving. Then what behaves as block mode: chips,
 * the `[[`, `#` and `((` pickers, and the slash menu and `::` and `{{` pickers.
 */

import { createRequire } from 'node:module'

import type { Page } from '@playwright/test'

import {
  activeSuggestionPopup,
  emitMockEvent,
  expect,
  focusBlockById,
  getInvokeCalls,
  installIpcRecorder,
  ipc,
  readClipboard,
  replaceEditorText,
  test,
  waitForBoot,
} from './helpers'

const axePath = createRequire(import.meta.url).resolve('axe-core')
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'
/** A 1×1 PNG, enough for the browser to decode as an image. */
const PNG_1X1 = [
  ...Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
]
/** The mock's seeded `work` tag (`src/lib/tauri-mock/seed.ts`). */
const SEED_TAG_WORK = '000000000000000000000TAG01'
/** The mock's seeded first block of Getting Started. */
const SEED_BLOCK_GS_1 = '0000000000000000000BLOCK01'

interface MockWindow {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
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
  // The pane fades in after a page opens; axe blends the fade into the text colours.
  await expect(page.getByTestId('view-transition-wrapper')).toHaveCSS('opacity', '1')
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

/** The page-mode document as shown: each block's id, depth and text, without its badge or chips. */
function shown(page: Page): Promise<DocBlock[]> {
  return page.locator(`${EDITOR} [data-page-block]`).evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute('data-page-block-id') ?? '',
      depth: Number(el.getAttribute('data-depth')),
      text: el.querySelector('.page-block-content')?.textContent ?? '',
    })),
  )
}

/** The page as the backend holds it now: live blocks in document order, with depth. */
async function backend(page: Page, pageId: string): Promise<DocBlock[]> {
  const { blocks } = await ipc<{
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
      // ProseMirror puts its own selection back 20 ms after a focus if the DOM's
      // differs (`editHandlers.focus`). Keys sent at machine speed starve that
      // timer past a later arrow, whose move it then undoes. A 20 ms timer set
      // after the focus runs after ProseMirror's.
      return new Promise((resolve) => setTimeout(resolve, 20))
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

test.describe('page mode (#5691) @editor @pages', () => {
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

    await ipc(page, 'edit_block', { blockId: seeded.ids[7], toText: 'block 7, from a peer' })
    await emitMockEvent(page, 'sync:complete', {
      type: 'complete',
      remote_device_id: 'device-b',
      ops_received: 1,
      ops_sent: 0,
      changed_blocks: 1,
      changed_page_ids: [seeded.pageId],
    })

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

    // Block mode opens with the block the cursor was in being edited.
    await expect(page.locator('[data-testid="block-editor"] [contenteditable="true"]')).toHaveText(
      'block 2 typed',
    )
    await expect(modeSwitch(page, 'Blocks')).toHaveAttribute('aria-checked', 'true')
    expect((await backend(page, seeded.pageId))[2]?.text).toBe('block 2 typed')
  })
})

/** A page titled `title` holding `rows` (`[depth, text]`), in order; resolves its id and the blocks' ids. */
async function seedRows(
  page: Page,
  title: string,
  rows: ReadonlyArray<[number, string]>,
): Promise<Seeded> {
  return page.evaluate(
    async ({ title: t, rows: r, scope }) => {
      const call = (cmd: string, args: Record<string, unknown>) =>
        (window as unknown as MockWindow).__TAURI_INTERNALS__.invoke(cmd, args)
      const pageId = (await call('create_page_in_space', {
        parentId: null,
        content: t,
        spaceId: scope.space_id,
      })) as string
      const ids: string[] = []
      const atDepth: string[] = []
      for (const [depth, content] of r) {
        const parentId = depth === 0 ? pageId : atDepth[depth - 1]
        const row = (await call('create_block', {
          blockType: 'content',
          content,
          parentId,
          index: null,
          scope,
        })) as { id: string }
        atDepth[depth] = row.id
        ids.push(row.id)
      }
      return { pageId, ids }
    },
    { title, rows, scope: SCOPE },
  )
}

/** What a sync that changed `pageId` tells the app, as `sync-events` delivers it. */
async function syncedPage(page: Page, pageId: string): Promise<void> {
  await emitMockEvent(page, 'sync:complete', {
    type: 'complete',
    remote_device_id: 'device-b',
    ops_received: 1,
    ops_sent: 0,
    changed_blocks: 1,
    changed_page_ids: [pageId],
  })
}

/** Select from block `from`'s start to block `to`'s start (or end), as a drag would. */
async function selectBlocks(page: Page, from: number, to: number, toEnd = false): Promise<void> {
  await page.evaluate(
    ({ selector, from: f, to: t, toEnd: end }) => {
      const { editor } = document.querySelector(selector) as HTMLElement & {
        editor: {
          state: { doc: { child: (n: number) => { nodeSize: number; textContent: string } } }
          commands: { setTextSelection: (range: { from: number; to: number }) => boolean }
          view: { focus: () => void }
        }
      }
      const start = (i: number) => {
        let pos = 0
        for (let k = 0; k < i; k += 1) pos += editor.state.doc.child(k).nodeSize
        return pos + 2
      }
      const toPos = start(t) + (end ? editor.state.doc.child(t).textContent.length : 0)
      editor.commands.setTextSelection({ from: start(f), to: toPos })
      editor.view.focus()
    },
    { selector: EDITOR, from, to, toEnd },
  )
}

/** Paste `text` from outside the app: a clipboard holding only plain text. */
async function pasteFromOutside(page: Page, text: string): Promise<void> {
  await page.locator(EDITOR).evaluate((dom, plain) => {
    const data = new DataTransfer()
    data.setData('text/plain', plain)
    dom.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, text)
}

test.describe('page mode keeps the page whole (#5691) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a block a peer created, moved or deleted shows that way, and saves nothing back', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Peers change it', [
      [0, 'alpha'],
      [0, 'beta'],
      [0, 'gamma'],
      [0, 'delta'],
    ])
    await openInPageMode(page, 'Peers change it', 4)

    const created = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content: 'from a peer',
      parentId: pageId,
      index: 1,
      scope: SCOPE,
    })
    await ipc(page, 'move_block', { blockId: ids[0], newParentId: ids[3], newIndex: 0 })
    await ipc(page, 'delete_block', { blockId: ids[2] })
    await syncedPage(page, pageId)

    await expect
      .poll(() => shown(page))
      .toEqual([
        { id: created.id, depth: 0, text: 'from a peer' },
        { id: ids[1], depth: 0, text: 'beta' },
        { id: ids[3], depth: 0, text: 'delta' },
        { id: ids[0], depth: 1, text: 'alpha' },
      ])
    await installIpcRecorder(page)
    await caret(page, 0, 'end')
    await page.keyboard.type('!')
    await expect.poll(async () => (await backend(page, pageId))[0]?.text).toBe('from a peer!')
    expect(await backend(page, pageId)).toEqual(await shown(page))
    for (const cmd of ['create_block', 'move_block', 'delete_block', 'restore_block']) {
      expect(await getInvokeCalls(page, cmd)).toEqual([])
    }
  })

  test('a block deleted elsewhere while typed in keeps the text, as a new block, and says so', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Deleted under me', [
      [0, 'alpha'],
      [0, 'beta'],
    ])
    await openInPageMode(page, 'Deleted under me', 2)
    await caret(page, 1, 'end')

    await page.keyboard.type(' typed')
    await ipc(page, 'delete_block', { blockId: ids[1] })
    await syncedPage(page, pageId)

    await expect(
      page.getByText(
        'A block you were editing was deleted elsewhere. Your text is kept as a new block.',
      ),
    ).toBeVisible()
    await expect
      .poll(async () => (await backend(page, pageId)).map((b) => b.text))
      .toEqual(['alpha', 'beta typed'])
    const kept = (await backend(page, pageId))[1]
    expect(kept?.id).not.toBe(ids[1])
    expect((await shown(page))[1]).toEqual(kept)
  })

  test('cut and paste moves blocks: their ids, and a reference to one, survive', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Cut and paste', [
      [0, 'alpha'],
      [0, 'beta'],
      [0, 'gamma'],
      [0, 'delta'],
    ])
    await ipc(page, 'edit_block', { blockId: ids[3], toText: `see ((${ids[1]}))` })
    await openInPageMode(page, 'Cut and paste', 4)
    await installIpcRecorder(page)

    await selectBlocks(page, 1, 2)
    await page.keyboard.press('Control+x')
    await expect
      .poll(async () => (await shown(page)).map((b) => b.text))
      .toEqual(['alpha', 'gamma', expect.stringContaining('see')])
    await caret(page, 0, 0)
    await page.keyboard.press('Control+v')

    await expect
      .poll(async () => (await backend(page, pageId)).map((b) => [b.id, b.text]))
      .toEqual([
        [ids[1], 'beta'],
        [ids[0], 'alpha'],
        [ids[2], 'gamma'],
        [ids[3], `see ((${ids[1]}))`],
      ])
    expect(await getInvokeCalls(page, 'create_block')).toEqual([])
    await expect(page.locator(`${EDITOR} [data-testid="block-ref-chip"]`)).toHaveText('beta')
  })

  test('paragraphs pasted from outside become blocks, at the depth pasted into', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Pasted from outside', [
      [0, 'alpha'],
      [1, 'beta'],
    ])
    await openInPageMode(page, 'Pasted from outside', 2)
    await caret(page, 1, 'end')

    await pasteFromOutside(page, ' one\n\ntwo\nthree')

    await expect
      .poll(async () => (await backend(page, pageId)).map((b) => [b.depth, b.text]))
      .toEqual([
        [0, 'alpha'],
        [1, 'beta one'],
        [1, 'two'],
        [1, 'three'],
      ])
    expect((await backend(page, pageId))[1]?.id).toBe(ids[1])
  })

  test('Shift+Tab moves a block out past the blocks after it, as block mode does', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Out past siblings', [
      [0, 'parent'],
      [1, 'first child'],
      [1, 'second child'],
    ])
    await openInPageMode(page, 'Out past siblings', 3)
    await caret(page, 1, 2)

    await page.keyboard.press('Shift+Tab')

    await expect
      .poll(async () => (await backend(page, pageId)).map((b) => [b.id, b.depth]))
      .toEqual([
        [ids[0], 0],
        [ids[2], 1],
        [ids[1], 0],
      ])
    expect(await cursor(page)).toEqual({ index: 2, offset: 2 })
  })

  test('text typed just before an export is in it, and text typed before leaving is saved', async ({
    page,
  }) => {
    const { pageId } = await seedRows(page, 'Export and leave', [[0, 'alpha']])
    await openInPageMode(page, 'Export and leave', 1)
    await caret(page, 0, 'end')

    await page.keyboard.type(' exported')
    await page.keyboard.press('Control+Shift+E')
    await expect.poll(() => readClipboard(page)).toContain('alpha exported')

    await page.keyboard.type(' left')
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Tags', exact: true })
      .click()
    await expect
      .poll(async () => (await backend(page, pageId))[0]?.text)
      .toBe('alpha exported left')
  })
})

test.describe('page mode behaves as block mode (#5691) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a page link chip opens its page, and a reference to a block here moves the cursor to it', async ({
    page,
  }) => {
    const target = await seedRows(page, 'Chip target', [[0, 'over there']])
    const { ids } = await seedRows(page, 'Chips', [
      [0, `go to [[${target.pageId}]]`],
      [0, 'middle'],
      [0, 'the referenced one'],
    ])
    await ipc(page, 'edit_block', { blockId: ids[1], toText: `see ((${ids[2]}))` })
    await openInPageMode(page, 'Chips', 3)

    await page.locator(`${EDITOR} [data-testid="block-ref-chip"]`).dispatchEvent('click')
    await expect.poll(async () => (await cursor(page)).index).toBe(2)

    await page.locator(`${EDITOR} [data-testid="block-link-chip"]`).dispatchEvent('click')
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Chip target')
  })

  test('the [[, # and (( pickers insert chips, which save as block mode writes them', async ({
    page,
  }) => {
    const target = await seedRows(page, 'Picked page', [[0, 'x']])
    const { pageId, ids } = await seedRows(page, 'Pickers', [
      [0, 'one'],
      [0, 'the block to pick'],
    ])
    await openInPageMode(page, 'Pickers', 2)
    await caret(page, 0, 'end')

    await page.keyboard.type(' [[Picked pa')
    await expect(activeSuggestionPopup(page)).toBeVisible()
    await page.keyboard.press('Enter')
    await page.keyboard.type(' #work')
    await expect(activeSuggestionPopup(page)).toBeVisible()
    await page.keyboard.press('Enter')
    await page.keyboard.type(' ((block to pi')
    await expect(activeSuggestionPopup(page)).toBeVisible()
    await page.keyboard.press('Enter')

    await expect
      .poll(async () => (await backend(page, pageId))[0]?.text)
      .toBe(`one [[${target.pageId}]] #[${SEED_TAG_WORK}] ((${ids[1]}))`)
  })

  test('a #name typed and left for the next block becomes the tag, and stays one', async ({
    page,
  }) => {
    // axe reads colours, which a fade in progress makes wrong.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const { pageId, ids } = await seedRows(page, 'Typed tags', [
      [0, 'one'],
      [0, 'two'],
    ])
    await openInPageMode(page, 'Typed tags', 2)
    await caret(page, 0, 'end')

    await page.keyboard.type(' #newtag')
    await expect(activeSuggestionPopup(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(activeSuggestionPopup(page)).toBeHidden()
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await cursor(page)).index).toBe(1)

    const chip = page.locator(
      `${EDITOR} [data-page-block-id="${ids[0]}"] [data-testid="tag-ref-chip"]`,
    )
    await expect(chip).toHaveText('newtag')
    const tags = await ipc<Array<{ tag_id: string; name: string }>>(
      page,
      'list_all_tags_in_space',
      { scope: SCOPE },
    )
    const tagId = tags.find((tag) => tag.name === 'newtag')?.tag_id
    expect((await backend(page, pageId))[0]?.text).toBe(`one #[${tagId}]`)

    // Escape leaves the document a frame later (TipTap's blur); the palette's Ctrl+K must not reach it.
    await page.keyboard.press('Escape')
    await expect(page.locator(EDITOR)).not.toBeFocused()
    await openViaPalette(page, 'Getting Started')
    await openViaPalette(page, 'Typed tags')
    await expect(page.locator('.page-editor [data-testid="tag-ref-chip"]')).toHaveText('newtag')
    await page.addScriptTag({ path: axePath })
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: { run: (el: Element) => Promise<{ violations: Array<{ id: string }> }> }
      }
      const { violations: found } = await axe.run(document.querySelector('.page-editor') as Element)
      return found.map((v) => v.id)
    })
    expect(violations).toEqual([])
  })

  // The press on the switch blurs the block being edited, which stays in edit
  // mode until the release (#5807): its text is saved, and page mode opens with
  // the cursor in it, which nothing the press held back takes away.
  test('Page pressed while a block is edited opens page mode with the cursor in that block', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Switch while editing', [
      [0, 'one'],
      [0, 'two'],
    ])
    await openViaPalette(page, 'Switch while editing')
    await focusBlockById(page, ids[1] as string)
    await replaceEditorText(page, 'two edited')

    await modeSwitch(page, 'Page').click()

    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(2)
    await expect(page.locator(EDITOR)).toBeFocused()
    await expect.poll(() => cursor(page)).toEqual({ index: 1, offset: 0 })
    await page.keyboard.type('x ')
    await expect.poll(async () => (await backend(page, pageId))[1]?.text).toBe('x two edited')
  })

  test('a page of tasks opens in page mode; a click, Ctrl+Enter and a typed marker set them, and they stay', async ({
    page,
  }) => {
    // axe reads colours, which a fade in progress makes wrong.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const { pageId, ids } = await seedRows(page, 'Page tasks', [
      [0, 'buy milk'],
      [0, 'call mom'],
      [0, 'shipped'],
      [0, 'plain'],
    ])
    await ipc(page, 'set_todo_state', { blockId: ids[0], state: 'TODO' })
    await ipc(page, 'set_todo_state', { blockId: ids[2], state: 'DONE' })
    await openInPageMode(page, 'Page tasks', 4)
    const marker = (id: string | undefined) =>
      page.locator(`${EDITOR} [data-page-block-id="${id}"] [data-testid="task-marker"]`)
    const label = (state: string) => `Task: ${state}. Click to cycle.`
    const state = async (id: string | undefined) =>
      (await ipc<{ todo_state: string | null }>(page, 'get_block', { blockId: id })).todo_state

    await expect(marker(ids[0])).toHaveAttribute('aria-label', label('TODO'))
    await expect(marker(ids[2])).toHaveAttribute('aria-label', label('DONE'))
    await expect(marker(ids[3])).toHaveCount(0)
    await expect(
      page.locator(`${EDITOR} [data-page-block-id="${ids[2]}"] .page-block-content`),
    ).toHaveCSS('text-decoration-line', 'line-through')

    await marker(ids[0]).click()
    await expect(marker(ids[0])).toHaveAttribute('aria-label', label('DOING'))
    await expect.poll(() => state(ids[0])).toBe('DOING')

    await caret(page, 3, 'end')
    await page.keyboard.press('Control+Enter')
    await expect(marker(ids[3])).toHaveAttribute('aria-label', label('TODO'))
    await expect.poll(() => state(ids[3])).toBe('TODO')

    await caret(page, 1, 0)
    await page.keyboard.type('[ ] ')
    await expect.poll(async () => (await shown(page))[1]?.text).toBe('[ ] call mom')
    await expect(marker(ids[1])).toHaveCount(0)
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await cursor(page)).index).toBe(2)
    await expect(marker(ids[1])).toHaveAttribute('aria-label', label('TODO'))
    await expect.poll(async () => (await backend(page, pageId))[1]?.text).toBe('call mom')
    expect((await shown(page))[1]?.text).toBe('call mom')
    expect(await state(ids[1])).toBe('TODO')

    // Escape leaves the document a frame later (TipTap's blur); the palette's Ctrl+K must not reach it.
    await page.keyboard.press('Escape')
    await expect(page.locator(EDITOR)).not.toBeFocused()
    await openViaPalette(page, 'Getting Started')
    await openViaPalette(page, 'Page tasks')
    await expect(marker(ids[0])).toHaveAttribute('aria-label', label('DOING'))
    await expect(marker(ids[1])).toHaveAttribute('aria-label', label('TODO'))
    await expect(marker(ids[2])).toHaveAttribute('aria-label', label('DONE'))
    await expect(marker(ids[3])).toHaveAttribute('aria-label', label('TODO'))
    expect((await shown(page)).map((b) => b.text)).toEqual([
      'buy milk',
      'call mom',
      'shipped',
      'plain',
    ])
    await page.addScriptTag({ path: axePath })
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: { run: (el: Element) => Promise<{ violations: Array<{ id: string }> }> }
      }
      const { violations: found } = await axe.run(document.querySelector('.page-editor') as Element)
      return found.map((v) => v.id)
    })
    expect(violations).toEqual([])
  })

  test('a page of priorities and dates opens in page mode; the keys, the badge and the picker set them, and they stay', async ({
    page,
  }) => {
    // axe reads colours, which a fade in progress makes wrong.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const { pageId, ids } = await seedRows(page, 'Page dates', [
      [0, 'pay rent'],
      [0, 'plan trip'],
      [0, 'plain'],
    ])
    await ipc(page, 'set_todo_state', { blockId: ids[0], state: 'TODO' })
    await ipc(page, 'set_priority', { blockId: ids[0], level: '1' })
    await ipc(page, 'set_due_date', { blockId: ids[0], date: '2026-10-20' })
    await ipc(page, 'set_scheduled_date', { blockId: ids[1], date: '2026-11-01' })
    await openInPageMode(page, 'Page dates', 3)
    const inBlock = (id: string | undefined, selector: string) =>
      page.locator(`${EDITOR} [data-page-block-id="${id}"] ${selector}`)
    const badge = (id: string | undefined) => inBlock(id, '[data-testid="priority-badge"]')
    const row = (id: string | undefined) =>
      ipc<{ priority: string | null; due_date: string | null; scheduled_date: string | null }>(
        page,
        'get_block',
        { blockId: id },
      )

    await expect(badge(ids[0])).toHaveText('P1')
    await expect(inBlock(ids[0], '.due-date-chip')).toHaveText('Oct 20')
    await expect(inBlock(ids[1], '.scheduled-chip')).toHaveText('Nov 1')
    await expect(inBlock(ids[2], '.block-metadata-row')).toHaveCount(0)
    // Under the text, lined up with it, as block mode draws the row.
    const textBox = await inBlock(ids[0], '.page-block-content').boundingBox()
    const rowBox = await inBlock(ids[0], '.block-metadata-row').boundingBox()
    expect(rowBox?.x).toBe(textBox?.x)
    expect(rowBox?.y).toBeGreaterThanOrEqual((textBox?.y ?? 0) + (textBox?.height ?? 0))

    // The row is not text: the arrows step over it.
    await caret(page, 0, 'end')
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await cursor(page)).index).toBe(1)
    await page.keyboard.press('ArrowUp')
    await expect.poll(async () => (await cursor(page)).index).toBe(0)

    // The priority keys, on the block the caret is in.
    await caret(page, 2, 'end')
    await page.keyboard.press('Control+Shift+2')
    await expect(badge(ids[2])).toHaveText('P2')
    await expect.poll(async () => (await row(ids[2])).priority).toBe('2')

    // The badge cycles, and the caret stays where it was.
    await badge(ids[0]).click()
    await expect(badge(ids[0])).toHaveText('P2')
    await expect.poll(async () => (await row(ids[0])).priority).toBe('2')
    expect(await cursor(page)).toEqual({ index: 2, offset: 5 })

    // A chip opens block mode's date picker; the date typed there is the block's.
    await inBlock(ids[0], '.due-date-chip').click()
    const picker = page.getByTestId('date-picker-popup')
    await picker.getByRole('textbox', { name: 'Type a date' }).fill('2026-12-24')
    await page.keyboard.press('Enter')
    await expect(picker).toHaveCount(0)
    await expect(inBlock(ids[0], '.due-date-chip')).toHaveText('Dec 24')
    await expect.poll(async () => (await row(ids[0])).due_date).toBe('2026-12-24')
    await expect(page.locator(EDITOR)).toBeFocused()
    expect(await cursor(page)).toEqual({ index: 2, offset: 5 })
    expect((await shown(page)).map((b) => b.text)).toEqual(['pay rent', 'plan trip', 'plain'])

    // Escape leaves the document a frame later (TipTap's blur); the palette's Ctrl+K must not reach it.
    await page.keyboard.press('Escape')
    await expect(page.locator(EDITOR)).not.toBeFocused()
    await openViaPalette(page, 'Getting Started')
    await openViaPalette(page, 'Page dates')
    // The switch is the page on screen's: choose Page again.
    await modeSwitch(page, 'Page').click()
    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(3)
    await expect(badge(ids[0])).toHaveText('P2')
    await expect(badge(ids[2])).toHaveText('P2')
    await expect(inBlock(ids[0], '.due-date-chip')).toHaveText('Dec 24')
    await expect(inBlock(ids[1], '.scheduled-chip')).toHaveText('Nov 1')
    expect(await row(ids[1])).toMatchObject({ priority: null, scheduled_date: '2026-11-01' })
    expect(await backend(page, pageId)).toEqual(await shown(page))
    await page.addScriptTag({ path: axePath })
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: { run: (el: Element) => Promise<{ violations: Array<{ id: string }> }> }
      }
      const { violations: found } = await axe.run(document.querySelector('.page-editor') as Element)
      return found.map((v) => v.id)
    })
    expect(violations).toEqual([])
  })

  test('a page of properties and a repeating task opens in page mode; a chip and a typed line set them, and they stay', async ({
    page,
  }) => {
    // axe reads colours, which a fade in progress makes wrong.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const { pageId, ids } = await seedRows(page, 'Page properties', [
      [0, 'water plants'],
      [0, 'call mom'],
      [0, 'plain'],
    ])
    const text = (value: string) => ({
      value_text: value,
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    })
    await ipc(page, 'set_todo_state', { blockId: ids[0], state: 'TODO' })
    await ipc(page, 'set_due_date', { blockId: ids[0], date: '2026-10-20' })
    await ipc(page, 'set_property', { blockId: ids[0], key: 'repeat', value: text('+1w') })
    await ipc(page, 'set_property', { blockId: ids[1], key: 'assignee', value: text('Ana') })
    await openInPageMode(page, 'Page properties', 3)
    const inBlock = (id: string | undefined, selector: string) =>
      page.locator(`${EDITOR} [data-page-block-id="${id}"] ${selector}`)
    const chips = (id: string | undefined) => inBlock(id, '[data-testid="property-chip"]')
    const props = async (id: string | undefined) =>
      Object.fromEntries(
        (
          await ipc<Array<{ key: string; value_text: string | null }>>(page, 'get_properties', {
            blockId: id,
          })
        )
          .filter((row) => !['created_at', 'completed_at'].includes(row.key))
          .map((row) => [row.key, row.value_text]),
      )

    await expect(inBlock(ids[0], '.repeat-indicator')).toHaveAttribute('aria-label', 'Repeats +1w')
    await expect(inBlock(ids[0], '.due-date-chip')).toHaveText('Oct 20')
    await expect(chips(ids[1])).toHaveAttribute('aria-label', 'Assignee: Ana')
    await expect(inBlock(ids[2], '.block-metadata-row')).toHaveCount(0)

    // A chip opens block mode's property editor; the value typed there is the block's.
    await caret(page, 2, 'end')
    await chips(ids[1]).getByRole('button', { name: 'Assignee: Ana' }).click()
    const field = page.getByRole('textbox', { name: 'Edit property' })
    await field.fill('Bo')
    await page.keyboard.press('Enter')
    await expect(field).toHaveCount(0)
    await expect(chips(ids[1])).toHaveAttribute('aria-label', 'Assignee: Bo')
    await expect.poll(() => props(ids[1])).toEqual({ assignee: 'Bo' })
    await expect(page.locator(EDITOR)).toBeFocused()
    expect(await cursor(page)).toEqual({ index: 2, offset: 5 })

    // A `key:: value` line typed on a line of its own is the block's property once left.
    await caret(page, 1, 'end')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('status:: done')
    await expect.poll(async () => (await shown(page))[1]?.text).toBe('call momstatus:: done')
    await expect(chips(ids[1])).toHaveCount(1)
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await cursor(page)).index).toBe(2)
    await expect(chips(ids[1])).toHaveCount(2)
    await expect(chips(ids[1]).nth(1)).toHaveAttribute('aria-label', 'Status: done')
    await expect.poll(async () => (await backend(page, pageId))[1]?.text).toBe('call mom')
    expect((await shown(page))[1]?.text).toBe('call mom')
    expect(await props(ids[1])).toEqual({ assignee: 'Bo', status: 'done' })

    // Escape leaves the document a frame later (TipTap's blur); the palette's Ctrl+K must not reach it.
    await page.keyboard.press('Escape')
    await expect(page.locator(EDITOR)).not.toBeFocused()
    await openViaPalette(page, 'Getting Started')
    await openViaPalette(page, 'Page properties')
    // The switch is the page on screen's: choose Page again.
    await modeSwitch(page, 'Page').click()
    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(3)
    await expect(chips(ids[1]).nth(0)).toHaveAttribute('aria-label', 'Assignee: Bo')
    await expect(chips(ids[1]).nth(1)).toHaveAttribute('aria-label', 'Status: done')
    await expect(inBlock(ids[0], '.repeat-indicator')).toHaveAttribute('aria-label', 'Repeats +1w')
    expect(await backend(page, pageId)).toEqual(await shown(page))
    await page.addScriptTag({ path: axePath })
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: { run: (el: Element) => Promise<{ violations: Array<{ id: string }> }> }
      }
      const { violations: found } = await axe.run(document.querySelector('.page-editor') as Element)
      return found.map((v) => v.id)
    })
    expect(violations).toEqual([])
  })

  // Below 640px the priority badge pads taller; at a smaller font a date chip is shorter than a property chip.
  for (const [width, fontSize] of [
    [1280, '16px'],
    [600, '16px'],
    [1280, '14px'],
  ] as const) {
    test(`a long page mounts a block’s controls as it nears the view, and nothing moves as they do, ${width}px wide, ${fontSize} text`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: page.viewportSize()?.height ?? 720 })
      // As Settings › Appearance sets it (`useFontSize`).
      await page.evaluate((size) => {
        document.documentElement.style.setProperty('--agaric-font-size', size)
      }, fontSize)
      // axe reads colours, which a fade in progress makes wrong.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const count = 200
      const { ids } = await seedPage(page, 'Long tasks', count)
      // Every block a task, TODO and DONE in turn, with a priority and a due date, a due and a
      // scheduled date, a priority, or neither; every eighth from the first and the fourth with a
      // property too.
      await page.evaluate(async (blockIds) => {
        const call = (cmd: string, args: Record<string, unknown>) =>
          (window as unknown as MockWindow).__TAURI_INTERNALS__.invoke(cmd, args)
        for (const [i, id] of blockIds.entries()) {
          await call('set_todo_state', { blockId: id, state: i % 2 === 0 ? 'TODO' : 'DONE' })
          if (i % 4 !== 1 && i % 4 !== 3) await call('set_priority', { blockId: id, level: '1' })
          if (i % 4 < 2) await call('set_due_date', { blockId: id, date: '2026-10-20' })
          if (i % 4 === 1) await call('set_scheduled_date', { blockId: id, date: '2026-10-21' })
          if (i % 8 === 0 || i % 8 === 3) {
            await call('set_property', {
              blockId: id,
              key: 'assignee',
              value: {
                value_text: 'Ana',
                value_num: null,
                value_date: null,
                value_ref: null,
                value_bool: null,
              },
            })
          }
        }
      }, ids)
      await openInPageMode(page, 'Long tasks', count)
      const block = (i: number) => page.locator(`${EDITOR} [data-page-block-id="${ids[i]}"]`)
      const marker = (i: number) => block(i).locator('[data-testid="task-marker"]')
      const label = (state: string) => `Task: ${state}. Click to cycle.`
      const last = count - 1

      await expect(marker(0)).toHaveAttribute('aria-label', label('TODO'))
      // The bottom is pages away: its controls are empty boxes, the checkbox's naming the state.
      await expect(marker(last)).toHaveCount(0)
      await expect(block(last).locator('.page-block-controls')).toHaveAttribute(
        'aria-label',
        'DONE (Ctrl+Enter to cycle)',
      )
      // Where the last blocks sit in the document, and how tall each is, before they mount.
      const from = count - 20
      const geometry = () =>
        page.evaluate(
          ({ selector, from: f }) => {
            const editor = document.querySelector(selector) as HTMLElement
            const top = editor.getBoundingClientRect().top
            return [...editor.querySelectorAll(':scope > [data-page-block]')].slice(f).map((el) => {
              const box = el.getBoundingClientRect()
              return { top: box.top - top, height: box.height }
            })
          },
          { selector: EDITOR, from },
        )
      const before = await geometry()

      await block(last).scrollIntoViewIfNeeded()

      await expect(marker(last)).toHaveAttribute('aria-label', label('DONE'))
      // Above the view, inside the screen of lead the scroller gives as the observer's root.
      await expect(marker(from)).toHaveAttribute('aria-label', label('TODO'))
      await expect(
        page.locator(
          `${EDITOR} > [data-page-block]:nth-child(n+${from + 1}) .page-block-metadata:empty`,
        ),
      ).toHaveCount(0)
      expect(await geometry()).toEqual(before)
      // Each as the backend holds it; a block in the middle is still not mounted.
      await expect(block(last - 3).locator('[data-testid="priority-badge"]')).toHaveText('P1')
      await expect(block(last - 3).locator('.due-date-chip')).toHaveText('Oct 20')
      await expect(block(last - 2).locator('.due-date-chip')).toHaveText('Oct 20')
      await expect(block(last - 2).locator('.scheduled-chip')).toHaveText('Oct 21')
      await expect(block(last - 2).locator('[data-testid="priority-badge"]')).toHaveCount(0)
      await expect(block(last - 1).locator('[data-testid="priority-badge"]')).toHaveText('P1')
      await expect(block(last).locator('.page-block-metadata')).toHaveCount(0)
      // A property alone, and with a priority and a due date.
      await expect(block(last - 4).locator('[data-testid="property-chip"]')).toHaveAttribute(
        'aria-label',
        'Assignee: Ana',
      )
      await expect(block(last - 4).locator('[data-testid="priority-badge"]')).toHaveCount(0)
      await expect(block(last - 7).locator('[data-testid="property-chip"]')).toHaveAttribute(
        'aria-label',
        'Assignee: Ana',
      )
      await expect(block(last - 7).locator('[data-testid="priority-badge"]')).toHaveText('P1')
      await expect(marker(count / 2)).toHaveCount(0)

      await page.addScriptTag({ path: axePath })
      const violations = await page.evaluate(async () => {
        const { axe } = window as unknown as {
          axe: { run: (el: Element) => Promise<{ violations: Array<{ id: string }> }> }
        }
        const { violations: found } = await axe.run(
          document.querySelector('.page-editor') as Element,
        )
        return found.map((v) => v.id)
      })
      expect(violations).toEqual([])
    })
  }

  test('a page of bullet and numbered blocks opens in page mode; `1. `, Enter and Enter again make and leave a list, and it stays', async ({
    page,
  }) => {
    // axe reads colours, which a fade in progress makes wrong.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const { pageId, ids } = await seedRows(page, 'Page lists', [
      [0, 'buy'],
      [0, 'one'],
      [1, 'sub'],
      [0, 'two'],
      [0, 'notes'],
    ])
    const listStyle = (value: string) => ({
      value_text: value,
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    })
    await ipc(page, 'set_property', {
      blockId: ids[0],
      key: 'listStyle',
      value: listStyle('bullet'),
    })
    for (const id of ids.slice(1, 4)) {
      await ipc(page, 'set_property', {
        blockId: id,
        key: 'listStyle',
        value: listStyle('ordered'),
      })
    }
    const styleOf = async (id: string) =>
      (
        await ipc<Array<{ key: string; value_text: string | null }>>(page, 'get_properties', {
          blockId: id,
        })
      ).find((row) => row.key === 'listStyle')?.value_text ?? null
    const markers = () =>
      page
        .locator(`${EDITOR} [data-page-block]`)
        .evaluateAll((els) =>
          els.map(
            (el) => el.querySelector(':scope > [data-testid="list-marker"]')?.textContent ?? '',
          ),
        )
    await openInPageMode(page, 'Page lists', 5)
    await expect.poll(markers).toEqual(['•', '1.', '1.', '2.', ''])

    // The marker leads the text's first line, left of it, as block mode draws it.
    const line = await page.evaluate((selector) => {
      const block = document.querySelector(`${selector} [data-page-block]:nth-child(2)`)
      const marker = block?.querySelector(':scope > [data-testid="list-marker"]')?.firstChild
      const text = block?.querySelector('.page-block-content p')?.firstChild
      if (!marker || !text) return null
      const glyph = (node: Node) => {
        const range = document.createRange()
        range.setStart(node, 0)
        range.setEnd(node, 1)
        return range.getBoundingClientRect()
      }
      const m = glyph(marker)
      const t = glyph(text)
      return { gap: t.left - m.right, baseline: Math.abs(t.bottom - m.bottom) }
    }, EDITOR)
    expect(line?.gap).toBeGreaterThan(0)
    expect(line?.baseline).toBeLessThan(1)

    await caret(page, 4, 'end')
    await page.keyboard.press('Enter')
    await page.keyboard.type('1. first')
    await page.keyboard.press('Enter')
    await page.keyboard.type('second')
    await expect
      .poll(async () => (await shown(page)).map((b) => b.text))
      .toEqual(['buy', 'one', 'sub', 'two', 'notes', 'first', 'second'])
    await expect.poll(markers).toEqual(['•', '1.', '1.', '2.', '', '1.', '2.'])
    await page.keyboard.press('Enter')
    await expect.poll(markers).toEqual(['•', '1.', '1.', '2.', '', '1.', '2.', '3.'])
    // The empty item's placeholder follows its marker rather than running under it.
    const empty = page.locator(`${EDITOR} [data-page-block]`).nth(7)
    await expect(empty.locator('p.is-editor-empty')).toHaveCount(1)
    const markerBox = await empty.locator(':scope > [data-testid="list-marker"]').boundingBox()
    const emptyBox = await empty.locator('p.is-editor-empty').boundingBox()
    expect(emptyBox?.x).toBeGreaterThanOrEqual((markerBox?.x ?? 0) + (markerBox?.width ?? 0))
    // Enter on the empty third item leaves the list instead of making a fourth.
    await page.keyboard.press('Enter')
    await expect.poll(markers).toEqual(['•', '1.', '1.', '2.', '', '1.', '2.', ''])
    await page.keyboard.type('done')
    await expect
      .poll(async () => (await backend(page, pageId)).map((b) => b.text))
      .toEqual(['buy', 'one', 'sub', 'two', 'notes', 'first', 'second', 'done'])
    const made = (await shown(page)).slice(5).map((b) => b.id)
    await expect.poll(() => Promise.all(made.map(styleOf))).toEqual(['ordered', 'ordered', null])

    // A click on a marker puts the caret at the start of its block's text.
    const clicked = await page
      .locator(`${EDITOR} [data-page-block]`)
      .nth(3)
      .locator(':scope > [data-testid="list-marker"]')
      .boundingBox()
    await page.mouse.click(
      (clicked?.x ?? 0) + (clicked?.width ?? 0) / 2,
      (clicked?.y ?? 0) + (clicked?.height ?? 0) / 2,
    )
    await expect.poll(() => cursor(page)).toEqual({ index: 3, offset: 0 })

    // Escape leaves the document a frame later (TipTap's blur); the palette's Ctrl+K must not reach it.
    await page.keyboard.press('Escape')
    await expect(page.locator(EDITOR)).not.toBeFocused()
    await openViaPalette(page, 'Getting Started')
    await openViaPalette(page, 'Page lists')
    // The switch is the page on screen's: choose Page again.
    await modeSwitch(page, 'Page').click()
    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(8)
    await expect.poll(markers).toEqual(['•', '1.', '1.', '2.', '', '1.', '2.', ''])
    expect(await backend(page, pageId)).toEqual(await shown(page))
    await page.addScriptTag({ path: axePath })
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: { run: (el: Element) => Promise<{ violations: Array<{ id: string }> }> }
      }
      const { violations: found } = await axe.run(document.querySelector('.page-editor') as Element)
      return found.map((v) => v.id)
    })
    expect(violations).toEqual([])
  })

  test('a page with attachments opens in page mode; an image opens full screen, a dropped file attaches, and they stay', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const { pageId, ids } = await seedRows(page, 'Page attachments', [
      [0, 'photo'],
      [0, 'notes'],
      [0, 'plain'],
    ])
    await ipc(page, 'add_attachment_with_bytes', {
      blockId: ids[0],
      filename: 'photo.png',
      mimeType: 'image/png',
      bytes: PNG_1X1,
    })
    await ipc(page, 'add_attachment_with_bytes', {
      blockId: ids[1],
      filename: 'notes.txt',
      mimeType: 'text/plain',
      bytes: [...Buffer.from('hello')],
    })
    await installIpcRecorder(page)
    await openInPageMode(page, 'Page attachments', 3)
    const inBlock = (id: string | undefined, selector: string) =>
      page.locator(`${EDITOR} [data-page-block-id="${id}"] ${selector}`)
    const files = async (id: string | undefined) =>
      (await ipc<Array<{ filename: string }>>(page, 'list_attachments', { blockId: id })).map(
        (row) => row.filename,
      )

    const image = inBlock(ids[0], 'img[alt="photo.png"]')
    await expect(image).toBeVisible()
    await expect(inBlock(ids[1], '[data-testid="markdown-attachment-body"]')).toHaveText('hello')
    await expect(inBlock(ids[0], '[data-testid="attachment-badge"]')).toHaveAttribute(
      'aria-label',
      '1 attachment',
    )
    await expect(inBlock(ids[2], '.page-block-metadata')).toHaveCount(0)
    // The image's size and caption come from the page's one read, not a read per block.
    for (const call of await getInvokeCalls(page, 'get_batch_properties')) {
      expect(call['blockIds']).toHaveLength(3)
    }

    // The image opens full screen, as in block mode.
    await inBlock(ids[0], '[aria-label="Open image photo.png in full screen"]').click()
    const lightbox = page.getByRole('dialog', { name: 'photo.png' })
    await expect(lightbox).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(lightbox).toHaveCount(0)

    // A file dropped on a block is attached to it, as block mode attaches it.
    await inBlock(ids[2], 'p').evaluate((el) => {
      const data = new DataTransfer()
      data.items.add(new File(['dropped'], 'dropped.txt', { type: 'text/plain' }))
      const { left, top } = el.getBoundingClientRect()
      const init = {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
        clientX: left + 2,
        clientY: top + 2,
      }
      el.dispatchEvent(new DragEvent('dragover', init))
      el.dispatchEvent(new DragEvent('drop', init))
    })
    await expect.poll(() => files(ids[2])).toEqual(['dropped.txt'])
    await expect(inBlock(ids[2], '[data-testid="markdown-attachment-body"]')).toHaveText('dropped')
    expect((await shown(page)).map((block) => block.text)).toEqual(['photo', 'notes', 'plain'])

    await openViaPalette(page, 'Getting Started')
    await openViaPalette(page, 'Page attachments')
    // The switch is the page on screen's: choose Page again.
    await modeSwitch(page, 'Page').click()
    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(3)
    await expect(inBlock(ids[0], 'img[alt="photo.png"]')).toBeVisible()
    await expect(inBlock(ids[2], '[data-testid="markdown-attachment-body"]')).toHaveText('dropped')
    expect(await backend(page, pageId)).toEqual(await shown(page))
    await page.addScriptTag({ path: axePath })
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: { run: (el: Element) => Promise<{ violations: Array<{ id: string }> }> }
      }
      const { violations: found } = await axe.run(document.querySelector('.page-editor') as Element)
      return found.map((v) => v.id)
    })
    expect(violations).toEqual([])
  })

  test('an image dragged to a new size keeps it once Tab draws its block anew', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Page image size', [
      [0, 'first'],
      [0, 'photo'],
    ])
    await ipc(page, 'add_attachment_with_bytes', {
      blockId: ids[1],
      filename: 'photo.png',
      mimeType: 'image/png',
      bytes: PNG_1X1,
    })
    await openInPageMode(page, 'Page image size', 2)
    const inPhoto = (selector: string) =>
      page.locator(`${EDITOR} [data-page-block-id="${ids[1]}"] ${selector}`)
    const width = () =>
      inPhoto('[data-testid="image-resize-wrapper"]').evaluate(
        (el) => (el as HTMLElement).style.maxWidth,
      )
    await expect(inPhoto('img[alt="photo.png"]')).toBeVisible()
    expect(await width()).toBe('100%')

    // Centred, the image grows both ways: a quarter of the row is the handle an eighth past its middle.
    const row = await inPhoto('[data-testid="attachment-section"]').boundingBox()
    await inPhoto('[data-testid="image-resize-wrapper"]').hover()
    const handle = await inPhoto('[data-testid="image-resize-handle"]').boundingBox()
    if (row === null || handle === null) throw new Error('the image row has no layout box')
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(row.x + row.width * 0.625, handle.y + handle.height / 2, { steps: 5 })
    await page.mouse.up()
    await expect.poll(width).toBe('25%')
    await expect
      .poll(async () => {
        const rows = await ipc<Array<{ key: string; value_text: string | null }>>(
          page,
          'get_properties',
          { blockId: ids[1] },
        )
        return rows.find((r) => r.key === 'image_width')?.value_text
      })
      .toBe('25')

    await caret(page, 1, 'end')
    await page.keyboard.press('Tab')
    await expect.poll(async () => (await backend(page, pageId))[1]?.depth).toBe(1)
    await expect(inPhoto('img[alt="photo.png"]')).toBeVisible()
    await expect.poll(width).toBe('25%')
  })

  test('a page with a query and an embed opens in page mode; the caret reveals their text, an edited query shows its results, and they stay', async ({
    page,
  }) => {
    const welcome = 'Welcome to Agaric! This is your personal knowledge base.'
    const embed = `{{embed ((${SEED_BLOCK_GS_1}))}}`
    const { pageId, ids } = await seedRows(page, 'Page queries', [
      [0, 'first'],
      [0, '{{query tag:work}}'],
      [0, embed],
      [0, 'last'],
    ])
    /** Where the query's results and the embed are drawn, to the pixel. */
    const boxes = () =>
      page.evaluate(() =>
        ['query-result', 'embed-container'].map((id) => {
          const box = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect()
          return [box?.x, box?.y, box?.width, box?.height].map((v) => Math.round(v ?? -1))
        }),
      )
    await openViaPalette(page, 'Page queries')
    await expect(page.getByTestId('query-result')).toContainText('4 results')
    await expect(page.getByTestId('embed-container')).toContainText(welcome)
    const inBlockMode = await boxes()
    await modeSwitch(page, 'Page').click()
    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(4)
    const inBlock = (id: string | undefined, selector: string) =>
      page.locator(`${EDITOR} [data-page-block-id="${id}"] ${selector}`)
    const query = inBlock(ids[1], '[data-testid="query-result"]')
    const results = inBlock(ids[1], '[data-testid="query-result-item"]')
    const axeViolations = async (): Promise<string[]> => {
      await page.addScriptTag({ path: axePath })
      return page.evaluate(async () => {
        const { axe } = window as unknown as {
          axe: { run: (el: Element) => Promise<{ violations: Array<{ id: string }> }> }
        }
        const { violations } = await axe.run(document.querySelector('.page-editor') as Element)
        return violations.map((v) => v.id)
      })
    }

    // Block mode's static view: the results and the embedded block, in place of the text.
    await expect(query).toContainText('4 results')
    await expect(results).toHaveCount(4)
    await expect(inBlock(ids[2], '[data-testid="embed-container"]')).toContainText(welcome)
    await expect(inBlock(ids[1], '.page-block-content')).toBeHidden()
    await expect(inBlock(ids[2], '.page-block-content')).toBeHidden()
    expect(await boxes()).toEqual(inBlockMode)
    expect(await axeViolations()).toEqual([])

    // The arrows step into the text, which shows in place of the results while the caret is in it.
    await caret(page, 0, 'end')
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => cursor(page)).toEqual({ index: 1, offset: 0 })
    await expect(inBlock(ids[1], '.page-block-content')).toHaveText('{{query tag:work}}')
    await expect(query).toBeHidden()
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await cursor(page)).index).toBe(2)
    await expect(inBlock(ids[2], '.page-block-content')).toBeVisible()
    await expect(query).toBeVisible()
    await page.keyboard.press('ArrowUp')
    await expect.poll(async () => (await cursor(page)).index).toBe(1)

    // An edit of the query shows in its results once the caret leaves it.
    await caret(page, 1, 16)
    for (let i = 0; i < 'work'.length; i += 1) await page.keyboard.press('Backspace')
    await page.keyboard.type('personal')
    await expect(inBlock(ids[1], '.page-block-content')).toHaveText('{{query tag:personal}}')
    await caret(page, 3, 'end')
    await expect(query).toContainText('2 results')
    await expect(results.filter({ hasText: 'Buy groceries' })).toHaveCount(1)
    await expect
      .poll(async () => (await backend(page, pageId)).map((b) => b.text))
      .toEqual(['first', '{{query tag:personal}}', embed, 'last'])

    // Escape leaves the document a frame later (TipTap's blur); the palette's Ctrl+K must not reach it.
    await page.keyboard.press('Escape')
    await expect(page.locator(EDITOR)).not.toBeFocused()
    await openViaPalette(page, 'Getting Started')
    await openViaPalette(page, 'Page queries')
    // The switch is the page on screen's: choose Page again.
    await modeSwitch(page, 'Page').click()
    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(4)
    await expect(query).toContainText('2 results')
    await expect(results.filter({ hasText: 'Buy groceries' })).toHaveCount(1)
    await expect(inBlock(ids[2], '[data-testid="embed-container"]')).toContainText(welcome)
    await expect(inBlock(ids[1], '.page-block-content')).toHaveText('{{query tag:personal}}')
    expect(await axeViolations()).toEqual([])
  })

  test('an open picker keeps its arrows beside a query or an embed: the highlight moves, and the caret and the typed name stay', async ({
    page,
  }) => {
    const { pageId } = await seedRows(page, 'Picker beside', [
      [0, 'first'],
      [0, '{{query tag:work}}'],
      [0, `{{embed ((${SEED_BLOCK_GS_1}))}}`],
      [0, 'last'],
    ])
    await openInPageMode(page, 'Picker beside', 4)
    const highlighted = activeSuggestionPopup(page).locator(
      '[data-testid="suggestion-item"][aria-selected="true"]',
    )
    const tagNames = async () =>
      (await ipc<Array<{ name: string }>>(page, 'list_all_tags_in_space', { scope: SCOPE })).map(
        (tag) => tag.name,
      )

    // ArrowDown above the query: the picker's, not a step into the query's text.
    await caret(page, 0, 'end')
    await page.keyboard.type(' #wo')
    await expect(highlighted).toHaveCount(1)
    const first = (await highlighted.textContent()) ?? ''
    await page.keyboard.press('ArrowDown')
    await expect(highlighted).not.toHaveText(first)
    expect((await cursor(page)).index).toBe(0)
    await page.keyboard.press('Escape')
    await expect(activeSuggestionPopup(page)).toHaveCount(0)
    await expect.poll(async () => (await backend(page, pageId))[0]?.text).toBe('first #wo')
    expect(await tagNames()).not.toContain('wo')

    // ArrowUp below the embed, likewise.
    await caret(page, 3, 'end')
    await page.keyboard.type(' #wo')
    await expect(highlighted).toHaveCount(1)
    const top = (await highlighted.textContent()) ?? ''
    await page.keyboard.press('ArrowUp')
    await expect(highlighted).not.toHaveText(top)
    expect((await cursor(page)).index).toBe(3)
  })

  test('the slash menu sets a task and gives an undated block its date, the drawer clears one, Escape writes nothing, and they stay', async ({
    page,
  }) => {
    // axe reads colours, which a fade in progress makes wrong.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const { pageId, ids } = await seedRows(page, 'Page slash', [
      [0, 'pay rent'],
      [0, 'plan trip'],
      [0, 'plain'],
    ])
    await ipc(page, 'set_due_date', { blockId: ids[1], date: '2026-11-01' })
    await openInPageMode(page, 'Page slash', 3)
    const inBlock = (id: string | undefined, selector: string) =>
      page.locator(`${EDITOR} [data-page-block-id="${id}"] ${selector}`)
    const marker = (id: string | undefined) => inBlock(id, '[data-testid="task-marker"]')
    const menu = activeSuggestionPopup(page)
    const row = (id: string | undefined) =>
      ipc<{ todo_state: string | null; due_date: string | null }>(page, 'get_block', {
        blockId: id,
      })

    // Escape closes the menu and leaves the caret, writing nothing but the text.
    await caret(page, 2, 'end')
    await page.keyboard.type(' /to')
    await expect(menu.locator('#suggestion-todo')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(page.locator(EDITOR)).toBeFocused()
    await expect.poll(async () => (await backend(page, pageId))[2]?.text).toBe('plain /to')
    expect(await row(ids[2])).toMatchObject({ todo_state: null, due_date: null })
    for (let i = 0; i < ' /to'.length; i += 1) await page.keyboard.press('Backspace')

    // Enter picks from the open menu: the task is the caret's block's, and no block splits.
    await caret(page, 0, 'end')
    await page.keyboard.type(' /todo')
    await expect(menu.locator('#suggestion-todo')).toHaveAttribute('aria-selected', 'true')
    await page.addScriptTag({ path: axePath })
    const menuViolations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: { run: (el: Element) => Promise<{ violations: Array<{ id: string }> }> }
      }
      const popup = document.querySelector('[data-testid="suggestion-popup"]') as Element
      return (await axe.run(popup)).violations.map((v) => v.id)
    })
    expect(menuViolations).toEqual([])
    await page.keyboard.press('Enter')
    await expect(menu).toHaveCount(0)
    await expect(marker(ids[0])).toHaveAttribute('aria-label', 'Task: TODO. Click to cycle.')
    await expect.poll(async () => (await row(ids[0])).todo_state).toBe('TODO')
    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(3)

    // /due on a block with no date: block mode's picker, and the date is the block's.
    await caret(page, 2, 'end')
    await page.keyboard.type(' /due')
    await menu.locator('#suggestion-due').click()
    const picker = page.getByTestId('date-picker-popup')
    await picker.getByRole('textbox', { name: 'Type a date' }).fill('2026-12-24')
    await page.keyboard.press('Enter')
    await expect(picker).toHaveCount(0)
    await expect(inBlock(ids[2], '.due-date-chip')).toHaveText('Dec 24')
    await expect.poll(async () => (await row(ids[2])).due_date).toBe('2026-12-24')

    // /attach opens the file dialog as it is picked; the image is the block's, and, as block
    // mode's /attach, not in its text (the rows read at the end).
    await caret(page, 1, 'end')
    await page.keyboard.type(' /attach')
    const chooser = page.waitForEvent('filechooser')
    await menu.locator('#suggestion-attach').click()
    await (
      await chooser
    ).setFiles({
      name: 'trip.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    })
    await expect
      .poll(async () =>
        (await ipc<Array<{ filename: string }>>(page, 'list_attachments', { blockId: ids[1] })).map(
          (attachment) => attachment.filename,
        ),
      )
      .toEqual(['trip.png'])

    // The drawer clears a date.
    await caret(page, 1, 'end')
    await page.keyboard.press('Control+Shift+P')
    const drawer = page.getByRole('dialog', { name: 'Block Properties' })
    await drawer.getByRole('button', { name: 'Clear due date' }).click()
    await expect.poll(async () => (await row(ids[1])).due_date).toBeNull()
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expect(inBlock(ids[1], '.due-date-chip')).toHaveCount(0)

    // Escape leaves the document a frame later (TipTap's blur); the palette's Ctrl+K must not reach it.
    await page.keyboard.press('Escape')
    await expect(page.locator(EDITOR)).not.toBeFocused()
    await openViaPalette(page, 'Getting Started')
    await openViaPalette(page, 'Page slash')
    // The switch is the page on screen's: choose Page again.
    await modeSwitch(page, 'Page').click()
    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(3)
    await expect(marker(ids[0])).toHaveAttribute('aria-label', 'Task: TODO. Click to cycle.')
    await expect(inBlock(ids[2], '.due-date-chip')).toHaveText('Dec 24')
    await expect(inBlock(ids[1], '.due-date-chip')).toHaveCount(0)
    expect(await row(ids[1])).toMatchObject({ todo_state: null, due_date: null })
    expect(await row(ids[2])).toMatchObject({ todo_state: null, due_date: '2026-12-24' })
    expect((await backend(page, pageId)).map((b) => b.text)).toEqual([
      'pay rent ',
      'plan trip ',
      'plain ',
    ])
  })

  test('the :: picker gives a property, and the {{ picker a query whose results show once left, and they stay', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Page pickers', [
      [0, 'first'],
      [0, 'call mom'],
      [0, 'last'],
    ])
    await ipc(page, 'set_property', {
      blockId: ids[0],
      key: 'assignee',
      value: {
        value_text: 'Bo',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    await openInPageMode(page, 'Page pickers', 3)
    const inBlock = (id: string | undefined, selector: string) =>
      page.locator(`${EDITOR} [data-page-block-id="${id}"] ${selector}`)
    const menu = activeSuggestionPopup(page)

    // `::` lists the keys; the pick is a `key:: ` line, the property once the caret leaves.
    await caret(page, 1, 'end')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('::assi')
    await menu.locator('#suggestion-assignee').click()
    await page.keyboard.type('Ana')
    await expect.poll(async () => (await shown(page))[1]?.text).toBe('call momassignee:: Ana')
    await page.keyboard.press('ArrowDown')
    await expect(inBlock(ids[1], '[data-testid="property-chip"]')).toHaveAttribute(
      'aria-label',
      'Assignee: Ana',
    )
    await expect.poll(async () => (await backend(page, pageId))[1]?.text).toBe('call mom')

    // `{{` then Insert query: block mode's builder, whose query is the block's.
    await caret(page, 2, 'end')
    await page.keyboard.press('Enter')
    await page.keyboard.type('{{')
    await expect(menu.locator('#suggestion-query')).toBeVisible()
    await page.keyboard.press('Enter')
    await page.getByLabel('Tag prefix').fill('work')
    await page.getByRole('button', { name: 'Insert Query' }).click()
    const added = (await shown(page))[3]?.id
    await expect
      .poll(async () => (await backend(page, pageId))[3]?.text)
      .toBe('{{query type:tag expr:work}}')
    await caret(page, 0, 'end')
    await expect(inBlock(added, '[data-testid="query-result"]')).toContainText('4 results')

    // Escape leaves the document a frame later (TipTap's blur); the palette's Ctrl+K must not reach it.
    await page.keyboard.press('Escape')
    await expect(page.locator(EDITOR)).not.toBeFocused()
    await openViaPalette(page, 'Getting Started')
    await openViaPalette(page, 'Page pickers')
    await modeSwitch(page, 'Page').click()
    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(4)
    await expect(inBlock(ids[1], '[data-testid="property-chip"]')).toHaveAttribute(
      'aria-label',
      'Assignee: Ana',
    )
    await expect(inBlock(added, '[data-testid="query-result"]')).toContainText('4 results')
    expect((await backend(page, pageId)).map((b) => b.text)).toEqual([
      'first',
      'call mom',
      'last',
      '{{query type:tag expr:work}}',
    ])
  })

  test('a slash command leaves the backend as block mode’s does', async ({ page }) => {
    const pages = {
      blocks: await seedRows(page, 'Slash in blocks', [
        [0, 'buy milk'],
        [0, 'call mom'],
      ]),
      page: await seedRows(page, 'Slash in page', [
        [0, 'buy milk'],
        [0, 'call mom'],
      ]),
    }
    const menu = activeSuggestionPopup(page)
    const rows = (seeded: Seeded) =>
      Promise.all(
        seeded.ids.map(async (id) => {
          const row = await ipc<{ content: string; todo_state: string | null }>(page, 'get_block', {
            blockId: id,
          })
          return [row.content, row.todo_state]
        }),
      )

    await openViaPalette(page, 'Slash in blocks')
    for (const [i, command] of ['todo', 'h2'].entries()) {
      await focusBlockById(page, pages.blocks.ids[i] as string)
      await page.keyboard.press('End')
      await page.keyboard.type(` /${command}`)
      await menu.locator(`#suggestion-${command}`).click()
      await expect(menu).toHaveCount(0)
      await page.keyboard.press('Escape')
    }

    await openViaPalette(page, 'Slash in page')
    await modeSwitch(page, 'Page').click()
    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(2)
    for (const [i, command] of ['todo', 'h2'].entries()) {
      await caret(page, i, 'end')
      await page.keyboard.type(` /${command}`)
      await menu.locator(`#suggestion-${command}`).click()
      await expect(menu).toHaveCount(0)
    }
    await page.keyboard.press('Escape')

    await expect.poll(() => rows(pages.page)).toEqual(await rows(pages.blocks))
    expect(await rows(pages.blocks)).toEqual([
      ['buy milk ', 'TODO'],
      ['## call mom ', null],
    ])
  })
})
