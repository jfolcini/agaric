/**
 * Page mode (#5691) on the mock backend: a seeded page, the Blocks | Page
 * switch, the document as shown and as the backend holds it, and the caret.
 * `e2e-tauri/page-mode.ts` is the real-backend twin.
 */

import type { Page } from '@playwright/test'

import { expect, ipc } from './helpers'

export const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
export const PAGE_EDITOR = '[data-testid="page-mode-editor"]'

interface MockWindow {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
}

export interface SeededPage {
  pageId: string
  /** Block ids in document order. */
  ids: string[]
}

export interface DocBlock {
  id: string
  depth: number
  text: string
}

/** A page titled `title` holding one block per `[depth, content]` row, in order. */
export function seedPage(
  page: Page,
  title: string,
  rows: ReadonlyArray<readonly [number, string]>,
): Promise<SeededPage> {
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
        const row = (await call('create_block', {
          blockType: 'content',
          content,
          parentId: depth === 0 ? pageId : atDepth[depth - 1],
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

/** Open the page titled `title` through the palette, from whatever view is shown. */
export async function openPageByTitle(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

export function modeSwitch(page: Page, name: 'Blocks' | 'Page') {
  return page.getByRole('radiogroup', { name: 'Editing mode' }).getByRole('radio', { name })
}

/** Open the page titled `title` and switch it to page mode, its `count` blocks shown. */
export async function openInPageMode(page: Page, title: string, count: number): Promise<void> {
  await openPageByTitle(page, title)
  await modeSwitch(page, 'Page').click()
  await expect(page.locator(`${PAGE_EDITOR} [data-page-block]`)).toHaveCount(count)
}

/** The page-mode document as shown: each block's id, depth and text, without its badge or chips. */
export function shownBlocks(page: Page): Promise<DocBlock[]> {
  return page.locator(`${PAGE_EDITOR} [data-page-block]`).evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute('data-page-block-id') ?? '',
      depth: Number(el.getAttribute('data-depth')),
      text: el.querySelector('.page-block-content')?.textContent ?? '',
    })),
  )
}

/** The page as the backend holds it now: live blocks in document order, with depth. */
export async function backendBlocks(page: Page, pageId: string): Promise<DocBlock[]> {
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

/** The backend's texts of the page's blocks, in document order. */
export async function backendTexts(page: Page, pageId: string): Promise<string[]> {
  return (await backendBlocks(page, pageId)).map((b) => b.text)
}

interface PageModeDom extends HTMLElement {
  editor: {
    state: {
      doc: {
        child: (n: number) => { nodeSize: number; firstChild: { content: { size: number } } }
      }
      selection: { $from: { index: (d: number) => number; parentOffset: number } }
    }
    commands: { setTextSelection: (pos: number | { from: number; to: number }) => boolean }
    view: { focus: () => void }
  }
}

/**
 * Put the cursor `offset` characters into block `index`'s text (or at its end), and focus the
 * document; with `to`, select from there to `to.offset` in block `to.index`.
 */
export async function caret(
  page: Page,
  index: number,
  offset: number | 'end',
  to?: { index: number; offset: number | 'end' },
): Promise<void> {
  await page.evaluate(
    ({ selector, from, until }) => {
      const { editor } = document.querySelector(selector) as PageModeDom
      const at = (i: number, o: number | 'end'): number => {
        let pos = 0
        for (let k = 0; k < i; k += 1) pos += editor.state.doc.child(k).nodeSize
        const length = editor.state.doc.child(i).firstChild.content.size
        return pos + 2 + (o === 'end' ? length : o)
      }
      const head = at(from.index, from.offset)
      editor.commands.setTextSelection(
        until === null ? head : { from: head, to: at(until.index, until.offset) },
      )
      editor.view.focus()
      // ProseMirror puts its own selection back 20 ms after a focus if the DOM's
      // differs (`editHandlers.focus`). Keys sent at machine speed starve that
      // timer past a later arrow, whose move it then undoes. A 20 ms timer set
      // after the focus runs after ProseMirror's.
      return new Promise((resolve) => setTimeout(resolve, 20))
    },
    { selector: PAGE_EDITOR, from: { index, offset }, until: to ?? null },
  )
  await expect(page.locator(PAGE_EDITOR)).toBeFocused()
}

/** The block the cursor is in, and how far into its text. */
export function cursor(page: Page): Promise<{ index: number; offset: number }> {
  return page.evaluate((selector) => {
    const { $from } = (document.querySelector(selector) as PageModeDom).editor.state.selection
    return { index: $from.index(0), offset: $from.parentOffset }
  }, PAGE_EDITOR)
}
