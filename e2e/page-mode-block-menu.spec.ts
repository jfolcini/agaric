/**
 * Page mode's block menu (#5972) against the mock backend: a right click on a
 * block opens block mode's menu on it, and each row's effect is read back from
 * the backend, then again after leaving the page and coming back. Also what
 * keeps the webview's own menu (selected text), the menu key and Shift+F10, a
 * selection across blocks, an undo of a delete, and a link's own rows.
 */

import { createRequire } from 'node:module'

import type { Locator, Page } from '@playwright/test'

import { expect, ipc, readClipboard, test, waitForBoot } from './helpers'

const axePath = createRequire(import.meta.url).resolve('axe-core')
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'

interface Seeded {
  pageId: string
  ids: string[]
}

type Row = [depth: number, text: string]

async function seedRows(page: Page, title: string, rows: readonly Row[]): Promise<Seeded> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const ids: string[] = []
  const atDepth: string[] = [pageId]
  for (const [depth, content] of rows) {
    const row = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: atDepth[depth],
      index: null,
      scope: SCOPE,
    })
    atDepth[depth + 1] = row.id
    ids.push(row.id)
  }
  return { pageId, ids }
}

async function openViaPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Escape')
  // Escape leaves page mode's editor for the box around it; a Ctrl+K in the editor is its link's.
  await expect
    .poll(() => page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, EDITOR))
    .toBe(false)
  await page.keyboard.press('Control+k')
  const input = page.locator('[cmdk-input]').first()
  await input.fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
  await expect(page.getByTestId('view-transition-wrapper')).toHaveCSS('opacity', '1')
}

async function openInPageMode(page: Page, title: string, count: number): Promise<void> {
  await openViaPalette(page, title)
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: 'Page' })
    .click()
  await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(count)
}

const block = (page: Page, id: string | undefined): Locator =>
  page.locator(`${EDITOR} [data-page-block-id="${id}"] .page-block-content`)

/** The page as the backend holds it now: live blocks in document order, as `[id, depth, text]`. */
async function backend(page: Page, pageId: string): Promise<Array<[string, number, string]>> {
  const { blocks } = await ipc<{
    blocks: Array<{ id: string; parent_id: string; position: number; content: string | null }>
  }>(page, 'load_page_subtree', { rootBlockId: pageId, scope: SCOPE })
  const out: Array<[string, number, string]> = []
  const walk = (parent: string, depth: number): void => {
    for (const b of blocks
      .filter((x) => x.parent_id === parent)
      .toSorted((x, y) => x.position - y.position)) {
      out.push([b.id, depth, b.content ?? ''])
      walk(b.id, depth + 1)
    }
  }
  walk(pageId, 0)
  return out
}

const menu = (page: Page) => page.getByRole('menu', { name: 'Block actions' })
const item = (page: Page, name: string) => menu(page).getByRole('menuitem', { name })

async function rightClick(page: Page, id: string | undefined): Promise<void> {
  await block(page, id).click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
}

/** Choose a row; the menu closes once its action has run, and the next right click must not find it still open. */
async function pick(page: Page, name: string): Promise<void> {
  await item(page, name).click()
  await expect(menu(page)).toBeHidden()
}

async function arrange(page: Page, name: string): Promise<void> {
  await item(page, 'Move & arrange').click()
  await pick(page, name)
}

/** Leave the page and come back to it, which re-reads it from the backend. */
async function reopen(page: Page, title: string, count: number): Promise<void> {
  await openViaPalette(page, 'Getting Started')
  await openViaPalette(page, title)
  await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(count)
}

const shown = (page: Page) =>
  page
    .locator(`${EDITOR} [data-page-block]`)
    .evaluateAll((els) =>
      els.map((el) => [
        el.getAttribute('data-page-block-id'),
        Number(el.getAttribute('data-depth')),
        el.querySelector('.page-block-content')?.textContent ?? '',
      ]),
    )

/** Put the cursor at the end of block `index`'s text, and focus the document. */
async function caretIn(page: Page, index: number): Promise<void> {
  await page.evaluate(
    ({ selector, index: i }) => {
      const { editor } = document.querySelector(selector) as HTMLElement & {
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
      let pos = 0
      for (let k = 0; k < i; k += 1) pos += editor.state.doc.child(k).nodeSize
      editor.commands.setTextSelection(pos + 2 + editor.state.doc.child(i).firstChild.content.size)
      editor.view.focus()
    },
    { selector: EDITOR, index },
  )
  await expect(page.locator(EDITOR)).toBeFocused()
}

async function selectBlocks(page: Page, from: number, to: number): Promise<void> {
  await page.evaluate(
    ({ selector, from: f, to: t }) => {
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
      editor.commands.setTextSelection({
        from: start(f),
        to: start(t) + editor.state.doc.child(t).textContent.length,
      })
      editor.view.focus()
    },
    { selector: EDITOR, from, to },
  )
}

test.describe('page mode block menu (#5972) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a right click opens the block menu on that block; Indent and Dedent reach the backend and stay, with no axe violations', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const { pageId, ids } = await seedRows(page, 'Menu indent', [
      [0, 'alpha'],
      [0, 'beta'],
      [1, 'gamma'],
      [0, 'delta'],
    ])
    await openInPageMode(page, 'Menu indent', 4)

    await rightClick(page, ids[1])
    await page.addScriptTag({ path: axePath })
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: { run: (el: Element) => Promise<{ violations: Array<{ id: string }> }> }
      }
      const { violations: found } = await axe.run(
        document.querySelector('[role="menu"]') as Element,
      )
      return found.map((v) => v.id)
    })
    expect(violations).toEqual([])
    await arrange(page, 'Indent')
    await expect
      .poll(async () => (await backend(page, pageId)).map((r) => r[1]))
      .toEqual([0, 1, 2, 0])

    await rightClick(page, ids[3])
    await arrange(page, 'Dedent')
    await rightClick(page, ids[2])
    await arrange(page, 'Dedent')
    await expect
      .poll(async () => (await backend(page, pageId)).map((r) => r[1]))
      .toEqual([0, 1, 1, 0])

    await reopen(page, 'Menu indent', 4)
    expect((await shown(page)).map((r) => r[1])).toEqual([0, 1, 1, 0])
  })

  test('Move Up, Move Down, Duplicate and Merge act on the block under the pointer, not the caret', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Menu arrange', [
      [0, 'one '],
      [0, 'two'],
      [1, 'child'],
      [0, 'three'],
    ])
    await openInPageMode(page, 'Menu arrange', 4)
    await caretIn(page, 0)

    await rightClick(page, ids[3])
    await arrange(page, 'Move Up')
    await expect
      .poll(async () => (await backend(page, pageId)).map((r) => r[0]))
      .toEqual([ids[0], ids[3], ids[1], ids[2]])

    await rightClick(page, ids[0])
    await arrange(page, 'Move Down')
    await expect
      .poll(async () => (await backend(page, pageId)).map((r) => r[0]))
      .toEqual([ids[3], ids[0], ids[1], ids[2]])

    await rightClick(page, ids[1])
    await arrange(page, 'Duplicate')
    await expect.poll(async () => (await backend(page, pageId)).length).toBe(6)
    const tree = await backend(page, pageId)
    expect(tree.map((r) => [r[1], r[2]])).toEqual([
      [0, 'three'],
      [0, 'one '],
      [0, 'two'],
      [1, 'child'],
      [0, 'two'],
      [1, 'child'],
    ])

    await rightClick(page, ids[1])
    await arrange(page, 'Merge with previous')
    await expect.poll(async () => (await backend(page, pageId)).length).toBe(5)
    expect((await backend(page, pageId))[1]).toEqual([ids[0], 0, 'one two'])
  })

  test('Delete removes the block with the blocks under it, Ctrl+Z brings them back by id, and a delete stays', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Menu delete', [
      [0, 'keep'],
      [0, 'drop'],
      [1, 'drop child'],
      [0, 'tail'],
    ])
    await openInPageMode(page, 'Menu delete', 4)

    await rightClick(page, ids[1])
    await pick(page, 'Delete')
    await expect
      .poll(async () => (await backend(page, pageId)).map((r) => r[0]))
      .toEqual([ids[0], ids[3]])

    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await backend(page, pageId)).map((r) => r[0])).toEqual(ids)

    await rightClick(page, ids[1])
    await pick(page, 'Delete')
    await expect.poll(async () => (await backend(page, pageId)).length).toBe(2)
    await reopen(page, 'Menu delete', 2)
    expect((await shown(page)).map((r) => r[2])).toEqual(['keep', 'tail'])
  })

  test('Cycle task state and priority set the block’s, and a click inside selected text keeps the webview’s menu', async ({
    page,
  }) => {
    const { ids } = await seedRows(page, 'Menu tasks', [
      [0, 'buy milk'],
      [0, 'call mom'],
    ])
    await openInPageMode(page, 'Menu tasks', 2)
    const state = async (id: string | undefined) =>
      await ipc<{ todo_state: string | null; priority: string | null }>(page, 'get_block', {
        blockId: id,
      })

    await rightClick(page, ids[1])
    await pick(page, 'Set as TODO')
    await expect.poll(async () => (await state(ids[1])).todo_state).toBe('TODO')
    expect((await state(ids[0])).todo_state).toBeNull()
    await expect(
      page.locator(`${EDITOR} [data-page-block-id="${ids[1]}"] [data-testid="task-marker"]`),
    ).toHaveAttribute('aria-label', 'Task: TODO. Click to cycle.')

    await rightClick(page, ids[1])
    await pick(page, 'TODO → DOING')
    await expect.poll(async () => (await state(ids[1])).todo_state).toBe('DOING')

    await rightClick(page, ids[0])
    await pick(page, 'Set priority 1')
    await expect.poll(async () => (await state(ids[0])).priority).toBe('1')

    // A word selected, and the click on it: the page lets the webview's menu through.
    await page.evaluate(() => {
      ;(window as unknown as { __prevented: boolean[] }).__prevented = []
      document.addEventListener('contextmenu', (e) =>
        (window as unknown as { __prevented: boolean[] }).__prevented.push(e.defaultPrevented),
      )
    })
    const onFirstWord = { position: { x: 10, y: 8 } }
    await block(page, ids[0]).locator('p').dblclick(onFirstWord)
    await block(page, ids[0])
      .locator('p')
      .click({ button: 'right', ...onFirstWord })
    await expect(menu(page)).toHaveCount(0)
    expect(
      await page.evaluate(() => (window as unknown as { __prevented: boolean[] }).__prevented),
    ).toEqual([false])

    // Elsewhere in the page: the block menu.
    await rightClick(page, ids[1])
    expect(
      await page.evaluate(() => (window as unknown as { __prevented: boolean[] }).__prevented),
    ).toEqual([false, true])
  })

  test('the menu key and Shift+F10 open the menu on the caret’s block', async ({ page }) => {
    const { pageId, ids } = await seedRows(page, 'Menu keys', [
      [0, 'first'],
      [0, 'second'],
    ])
    await openInPageMode(page, 'Menu keys', 2)
    await caretIn(page, 1)

    await page.keyboard.press('ContextMenu')
    await expect(menu(page)).toBeVisible()
    await pick(page, 'Copy block reference')
    await expect.poll(() => readClipboard(page)).toBe(`((${ids[1]}))`)
    await expect(page.locator(EDITOR)).toBeFocused()

    await caretIn(page, 0)
    await page.keyboard.press('Shift+F10')
    await expect(menu(page)).toBeVisible()
    await pick(page, 'Delete')
    await expect.poll(async () => (await backend(page, pageId)).map((r) => r[0])).toEqual([ids[1]])
  })

  test('a selection across blocks gets the menu in its bulk form: Delete, Indent and Copy act on all of it', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Menu bulk', [
      [0, 'top'],
      [0, 'b one'],
      [1, 'b child'],
      [0, 'b two'],
      [0, 'last'],
    ])
    await openInPageMode(page, 'Menu bulk', 5)

    await selectBlocks(page, 1, 3)
    await rightClick(page, ids[2])
    await arrange(page, 'Indent')
    await expect
      .poll(async () => (await backend(page, pageId)).map((r) => r[1]))
      .toEqual([0, 1, 2, 1, 0])

    await selectBlocks(page, 1, 3)
    await rightClick(page, ids[1])
    await pick(page, 'Copy selection')
    await expect.poll(() => readClipboard(page)).toBe('- b one\n  - b child\n- b two\n')

    await selectBlocks(page, 1, 3)
    await rightClick(page, ids[3])
    await pick(page, 'Delete 3 selected')
    await expect
      .poll(async () => (await backend(page, pageId)).map((r) => r[0]))
      .toEqual([ids[0], ids[4]])
  })

  test('a typed word not saved yet is saved before the row runs, and an empty block’s menu has no reference to copy', async ({
    page,
  }) => {
    const { pageId, ids } = await seedRows(page, 'Menu typing', [[0, 'a']])
    await openInPageMode(page, 'Menu typing', 1)
    await caretIn(page, 0)
    await page.keyboard.type('bc')

    await rightClick(page, ids[0])
    await pick(page, 'Set as TODO')
    await expect.poll(async () => (await backend(page, pageId))[0]?.[2]).toBe('abc')
    await expect
      .poll(
        async () =>
          (await ipc<{ todo_state: string | null }>(page, 'get_block', { blockId: ids[0] }))
            .todo_state,
      )
      .toBe('TODO')

    await caretIn(page, 0)
    await page.keyboard.press('Enter')
    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(2)
    const fresh = (await shown(page))[1]?.[0] as string
    await rightClick(page, fresh)
    await expect(item(page, 'Copy block reference')).toHaveCount(0)
    await expect(item(page, 'Delete')).toBeVisible()
  })

  test('a link’s own rows: a page link opens in a background tab, an external link copies its URL', async ({
    page,
  }) => {
    const target = await seedRows(page, 'Menu target', [[0, 'over there']])
    const { ids } = await seedRows(page, 'Menu links', [
      [0, `go to [[${target.pageId}]]`],
      [0, '[docs](https://example.com/docs)'],
    ])
    await openInPageMode(page, 'Menu links', 2)

    await page.locator(`${EDITOR} [data-testid="block-link-chip"]`).click({ button: 'right' })
    await expect(menu(page)).toBeVisible()
    await item(page, 'Open in new tab').click()
    const tabs = page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab')
    await expect(tabs).toHaveCount(2)
    await expect(tabs.nth(1)).toHaveText(/Menu target/)
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Menu links')

    await block(page, ids[1]).locator('a').click({ button: 'right' })
    await expect(item(page, 'Open link')).toBeVisible()
    await pick(page, 'Copy URL')
    await expect.poll(() => readClipboard(page)).toBe('https://example.com/docs')
  })

  test('Properties and History open on the block they were chosen for', async ({ page }) => {
    const { ids } = await seedRows(page, 'Menu dialogs', [
      [0, 'one'],
      [0, 'two'],
    ])
    await openInPageMode(page, 'Menu dialogs', 2)

    await rightClick(page, ids[1])
    await pick(page, 'Properties...')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()

    await rightClick(page, ids[1])
    await pick(page, 'History')
    await expect(page.getByRole('dialog')).toBeVisible()
  })
})
