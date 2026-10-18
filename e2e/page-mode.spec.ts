/**
 * Page mode (#5691) against the mock backend, on a 200-block page: the page as
 * one document, its keys, its continuous save read back from the backend, undo
 * restoring a deleted block by id, the switch back to blocks, and axe. Then
 * what keeps the page whole: changes made elsewhere (an edit, a block created,
 * moved or deleted, one deleted while typed in), cut and paste as a move,
 * paragraphs pasted from outside, Shift+Tab as block mode's, and the text saved
 * before an export and before leaving. Then what behaves as block mode: chips,
 * the `[[`, `#` and `((` pickers, and `/` and `::` as plain text.
 */

import { createRequire } from 'node:module'

import type { Page } from '@playwright/test'

import {
  activeSuggestionPopup,
  emitMockEvent,
  expect,
  getInvokeCalls,
  installIpcRecorder,
  ipc,
  readClipboard,
  test,
  waitForBoot,
} from './helpers'

const axePath = createRequire(import.meta.url).resolve('axe-core')
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'
/** The mock's seeded `work` tag (`src/lib/tauri-mock/seed.ts`). */
const SEED_TAG_WORK = '000000000000000000000TAG01'

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

test.describe('page mode keeps the page whole (#5691)', () => {
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

test.describe('page mode behaves as block mode (#5691)', () => {
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
    // Closing the picker redraws the text the caret is in; a native arrow pressed
    // before that frame is taken back by ProseMirror's own selection.
    await expect(activeSuggestionPopup(page)).toBeHidden()
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    await page.keyboard.press('ArrowDown')

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
    // An arrow pressed in the frame the last key is drawn in is taken back by ProseMirror's selection.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    await page.keyboard.press('ArrowDown')
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
    await invoke(page, 'set_todo_state', { blockId: ids[0], state: 'TODO' })
    await invoke(page, 'set_priority', { blockId: ids[0], level: '1' })
    await invoke(page, 'set_due_date', { blockId: ids[0], date: '2026-10-20' })
    await invoke(page, 'set_scheduled_date', { blockId: ids[1], date: '2026-11-01' })
    await openInPageMode(page, 'Page dates', 3)
    const inBlock = (id: string | undefined, selector: string) =>
      page.locator(`${EDITOR} [data-page-block-id="${id}"] ${selector}`)
    const badge = (id: string | undefined) => inBlock(id, '[data-testid="priority-badge"]')
    const row = (id: string | undefined) =>
      invoke<{ priority: string | null; due_date: string | null; scheduled_date: string | null }>(
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

  test('/ and :: are plain text: no menu or picker takes Enter, which splits the block', async ({
    page,
  }) => {
    const { pageId } = await seedRows(page, 'Plain triggers', [[0, 'one']])
    await openInPageMode(page, 'Plain triggers', 1)
    await caret(page, 0, 'end')
    // Whether a suggestion popup ever opens while typing, not only at the end.
    await page.evaluate(() => {
      const seen = { popup: false }
      Object.assign(window, { __popupSeen__: seen })
      new MutationObserver(() => {
        seen.popup ||= document.querySelector('[data-testid="suggestion-popup"]') !== null
      }).observe(document.body, { childList: true, subtree: true })
    })

    await page.keyboard.type(' /x')
    await page.keyboard.press('Enter')
    await page.keyboard.type('two key::')
    await page.keyboard.press('Enter')
    await page.keyboard.type('three')

    await expect
      .poll(async () => (await backend(page, pageId)).map((b) => b.text))
      .toEqual(['one /x', 'two key::', 'three'])
    expect(
      await page.evaluate(
        () => (window as unknown as { __popupSeen__: { popup: boolean } }).__popupSeen__.popup,
      ),
    ).toBe(false)
  })
})
