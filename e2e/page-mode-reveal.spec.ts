/**
 * #5974 — "Show Markdown syntax around the cursor" in page mode: the page's
 * one editable surface draws the markers of the mark, heading or link the
 * caret is in, as block mode does. Backspace after a marker at a block's start
 * removes the mark instead of joining the block, the arrows cross a marker and
 * then leave the block, a selection across blocks reveals nothing, and what is
 * saved never holds a marker, which leaving the page and coming back shows.
 */

import { createRequire } from 'node:module'

import type { Page } from '@playwright/test'

import {
  expect,
  ipc,
  navigateToView,
  openSettingsTab,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

const axePath = createRequire(import.meta.url).resolve('axe-core')
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'
const TITLE = 'Reveal in page mode'
const LINK = 'https://example.com'
const CONTENTS = ['first **bold**', '**bold** end', '## Title', `see [label](${LINK}) x`]

async function setReveal(page: Page, on: boolean): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Editor')
  const toggle = page.getByRole('switch', { name: 'Show Markdown syntax around the cursor' })
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(on))
}

/** A page of `CONTENTS`, one top-level block each; resolves its id. */
async function seedPage(page: Page): Promise<string> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: TITLE,
    spaceId: SCOPE.space_id,
  })
  await ipc(page, 'create_blocks_batch', {
    specs: CONTENTS.map((content) => ({
      blockType: 'content',
      content,
      parentId: pageId,
      position: null,
    })),
  })
  return pageId
}

async function openInPageMode(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+k')
  const input = page.locator('[cmdk-input]').first()
  await input.fill(TITLE)
  await page.locator('[cmdk-item]').filter({ hasText: TITLE }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(TITLE)
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: 'Page' })
    .click()
  await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(CONTENTS.length)
}

/** Put the caret `offset` characters into block `index`'s text and focus the page. */
async function caret(page: Page, index: number, offset: number): Promise<void> {
  await page.evaluate(
    ({ selector, index: i, offset: o }) => {
      const { editor } = document.querySelector(selector) as HTMLElement & {
        editor: {
          state: { doc: { child: (n: number) => { nodeSize: number } } }
          commands: { setTextSelection: (pos: number) => boolean }
          view: { focus: () => void }
        }
      }
      let pos = 0
      for (let k = 0; k < i; k += 1) pos += editor.state.doc.child(k).nodeSize
      editor.commands.setTextSelection(pos + 2 + o)
      editor.view.focus()
      // ProseMirror puts its own selection back 20 ms after a focus if the DOM's differs.
      return new Promise((resolve) => setTimeout(resolve, 20))
    },
    { selector: EDITOR, index, offset },
  )
  await expect(page.locator(EDITOR)).toBeFocused()
}

/** The block the caret is in, and how far into its text. */
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

/** The revealed markers as the user reads them. */
function shownMarkers(page: Page): Promise<string[]> {
  return page.getByTestId('md-reveal-marker').evaluateAll((els) => els.map((el) => el.textContent))
}

/** The page's blocks as the backend holds them now, in order. */
async function stored(page: Page, pageId: string): Promise<string[]> {
  const { blocks } = await ipc<{
    blocks: Array<{ parent_id: string; position: number; content: string | null }>
  }>(page, 'load_page_subtree', { rootBlockId: pageId, scope: SCOPE })
  return blocks
    .filter((b) => b.parent_id === pageId)
    .toSorted((a, b) => a.position - b.position)
    .map((b) => b.content ?? '')
}

/** The text of each block as shown. */
function shownText(page: Page): Promise<string[]> {
  return page
    .locator(`${EDITOR} [data-page-block] .page-block-content`)
    .evaluateAll((els) => els.map((el) => el.textContent ?? '').map((t) => t.replace(/\s+/g, ' ')))
}

/** The box of the `nth` `char` of block `index`'s text, markers not counted. */
function charBox(
  page: Page,
  index: number,
  char: string,
  nth = 0,
): Promise<{ x: number; y: number; height: number }> {
  return page.evaluate(
    ({ selector, index: i, char: c, nth: n }) => {
      const block = document.querySelectorAll(`${selector} [data-page-block]`)[i]
      if (!block) throw new Error(`no block ${i}`)
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      let seen = 0
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest('[data-testid^="md-reveal"]')) continue
        const text = node.textContent ?? ''
        for (let at = text.indexOf(c); at >= 0; at = text.indexOf(c, at + 1)) {
          if (seen++ < n) continue
          const range = document.createRange()
          range.setStart(node, at)
          range.setEnd(node, at + 1)
          const box = range.getBoundingClientRect()
          return { x: box.left, y: box.top, height: box.height }
        }
      }
      throw new Error(`no ${c} #${n} in block ${i}`)
    },
    { selector: EDITOR, index, char, nth },
  )
}

/** The text the editor's selection holds. */
function selectedText(page: Page): Promise<string> {
  return page.evaluate((selector) => {
    const { editor } = document.querySelector(selector) as HTMLElement & {
      editor: {
        state: {
          selection: { from: number; to: number }
          doc: { textBetween: (from: number, to: number) => string }
        }
      }
    }
    const { from, to } = editor.state.selection
    return editor.state.doc.textBetween(from, to)
  }, EDITOR)
}

/** Press the mouse just inside the left edge of `from`, and drag to just inside the left edge of `to`. */
async function drag(
  page: Page,
  from: { x: number; y: number; height: number },
  to: { x: number; y: number; height: number },
): Promise<void> {
  await page.mouse.move(from.x + 1, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + 1, to.y + to.height / 2, { steps: 10 })
  await page.mouse.up()
}

test.describe('Markdown syntax revealed around the cursor in page mode (#5974) @editor @markdown @pages', () => {
  let pageId = ''

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await setReveal(page, true)
    pageId = await seedPage(page)
    await openInPageMode(page)
  })

  test('draws the markers of bold, a heading and a link around the caret, and none elsewhere', async ({
    page,
  }) => {
    await caret(page, 0, 2)
    expect(await shownMarkers(page)).toEqual([])
    await caret(page, 1, 2)
    expect(await shownMarkers(page)).toEqual(['**', '**'])
    await caret(page, 2, 2)
    expect(await shownMarkers(page)).toEqual(['## '])
    await caret(page, 3, 6)
    expect(await shownMarkers(page)).toEqual(['[', `](${LINK})`])
    await page.addScriptTag({ path: axePath })
    const violations = await page.evaluate(async () => {
      // @ts-expect-error injected global
      const results = await window.axe.run(document.querySelector('.page-editor'))
      return results.violations.map((v: { id: string }) => v.id)
    })
    expect(violations).toEqual([])
  })

  test('Backspace after a marker at a block’s start removes the mark without a join, and it is saved', async ({
    page,
  }) => {
    // `|bold` at the block's start, inside the bold, right of its opening marker.
    await caret(page, 1, 0)
    expect(await shownMarkers(page)).toEqual(['**', '**'])
    await page.keyboard.press('Backspace')
    expect(await shownText(page)).toEqual(['first bold', 'bold end', 'Title', 'see label x'])
    await expect(page.locator(`${EDITOR} strong`)).toHaveCount(1)

    // `## |Title`: the # run goes to level 1, then to a paragraph.
    await caret(page, 2, 0)
    expect(await shownMarkers(page)).toEqual(['## '])
    await page.keyboard.press('Backspace')
    await expect(page.locator(`${EDITOR} h1`)).toContainText('Title')
    expect(await shownMarkers(page)).toEqual(['# '])
    await page.keyboard.press('Backspace')
    await expect(page.locator(`${EDITOR} h1, ${EDITOR} h2`)).toHaveCount(0)
    expect(await shownText(page)).toEqual(['first bold', 'bold end', 'Title', 'see label x'])

    // `see |[label]`, over the `[`, then Backspace unlinks the label.
    await caret(page, 3, 4)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Backspace')
    await expect(page.locator(`${EDITOR} a`)).toHaveCount(0)

    // Leave the page and come back: the backend holds the unmarked text, and no marker.
    const saved = ['first **bold**', 'bold end', 'Title', 'see label x']
    await expect.poll(() => stored(page, pageId)).toEqual(saved)
    await reopenPage(page, TITLE)
    await expect(page.getByTestId('block-static')).toHaveCount(4)
    expect(await stored(page, pageId)).toEqual(saved)
  })

  test('one undo brings a marker back, whatever was typed in another block before it', async ({
    page,
  }) => {
    await caret(page, 0, 0)
    await page.keyboard.type('!')
    await caret(page, 1, 0)
    await page.keyboard.press('Backspace')
    const block = page.locator(`${EDITOR} [data-page-block]`).nth(1)
    await expect(block.locator('strong')).toHaveCount(0)
    await page.keyboard.press('Control+z')
    await expect(block.locator('strong')).toHaveText('bold')
    // The caret is back in the bold, so its markers are drawn; the typed `!` is still there.
    expect(await shownText(page)).toEqual(['!first bold', '**bold** end', 'Title', 'see label x'])
  })

  test('ArrowRight at a block’s end steps out of the mark, and the next one leaves the block', async ({
    page,
  }) => {
    // `first bold|`: inside the bold at the block's end.
    await caret(page, 0, 10)
    expect(await shownMarkers(page)).toEqual(['**', '**'])
    await page.keyboard.press('ArrowRight')
    expect(await cursor(page)).toEqual({ index: 0, offset: 10 })
    await page.keyboard.type('X')
    expect((await shownText(page))[0]).toBe('first boldX')
    await expect(page.locator(`${EDITOR} strong`).first()).toHaveText('bold')
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => cursor(page)).toEqual({ index: 1, offset: 0 })
  })

  test('a click past the closing marker types outside the bold, and on its near half inside', async ({
    page,
  }) => {
    const closing = page.getByTestId('md-reveal-marker').nth(1)
    const block = page.locator(`${EDITOR} [data-page-block]`).nth(0)
    await caret(page, 0, 8)
    await expect(page.getByTestId('md-reveal-marker')).toHaveCount(2)
    let box = await closing.boundingBox()
    if (!box) throw new Error('the closing marker has no layout box')
    await page.mouse.click(box.x + box.width + 1, box.y + box.height / 2)
    await page.keyboard.type('X')
    await expect(block.locator('strong')).toHaveText('bold')
    expect((await shownText(page))[0]).toBe('first boldX')

    await caret(page, 0, 8)
    await expect(page.getByTestId('md-reveal-marker')).toHaveCount(2)
    box = await closing.boundingBox()
    if (!box) throw new Error('the closing marker has no layout box')
    await page.mouse.click(box.x + 1, box.y + box.height / 2)
    await page.keyboard.type('Y')
    await expect(block.locator('strong')).toHaveText('boldY')
  })

  test('a selection across blocks reveals nothing', async ({ page }) => {
    await caret(page, 1, 2)
    expect(await shownMarkers(page)).toEqual(['**', '**'])
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')
    await expect.poll(() => shownMarkers(page)).toEqual([])
    await page.keyboard.press('Control+a')
    await expect.poll(() => shownMarkers(page)).toEqual([])
  })

  test('a mouse drag that starts in bold, a link or a heading not yet revealed selects what it covered', async ({
    page,
  }) => {
    // `**bold** end`, from the `o` of bold to the `n` of end: the markers appear only on release.
    await caret(page, 0, 0)
    await drag(page, await charBox(page, 1, 'o'), await charBox(page, 1, 'n'))
    await expect.poll(() => selectedText(page)).toBe('old e')
    await expect(page.getByTestId('md-reveal-marker')).toHaveText(['**', '**'])

    await caret(page, 0, 0)
    await drag(page, await charBox(page, 3, 'a'), await charBox(page, 3, 'x'))
    await expect.poll(() => selectedText(page)).toBe('abel ')

    await caret(page, 0, 0)
    await drag(page, await charBox(page, 2, 'i'), await charBox(page, 2, 'e'))
    await expect.poll(() => selectedText(page)).toBe('itl')
  })

  test('a click still puts the caret where it lands and reveals there, and a double click selects the word', async ({
    page,
  }) => {
    await caret(page, 0, 0)
    // The left edge of `l` in `**bold** end`: the caret lands before it, `bo|ld`.
    const l = await charBox(page, 1, 'l')
    await page.mouse.click(l.x + 1, l.y + l.height / 2)
    await expect(page.getByTestId('md-reveal-marker')).toHaveText(['**', '**'])
    expect(await cursor(page)).toEqual({ index: 1, offset: 2 })

    // `first **bold**`, on the `o`: the first click's markers shift the word, which stays under the pointer.
    await caret(page, 3, 0)
    const o = await charBox(page, 0, 'o')
    await page.mouse.dblclick(o.x + 2, o.y + o.height / 2)
    await expect.poll(() => selectedText(page)).toBe('bold')
  })

  test('draws nothing once focus leaves the page, and the caret’s markers again once it is back', async ({
    page,
  }) => {
    await caret(page, 1, 2)
    await expect(page.getByTestId('md-reveal-marker')).toHaveText(['**', '**'])
    await page.locator('[aria-label="Page title"]').click()
    await expect(page.locator('[aria-label="Page title"]')).toBeFocused()
    await expect(page.getByTestId('md-reveal-marker')).toHaveCount(0)

    await caret(page, 2, 2)
    await expect(page.getByTestId('md-reveal-marker')).toHaveText(['## '])
    await page.keyboard.press('Escape')
    await expect(page.locator(EDITOR)).not.toBeFocused()
    await expect(page.getByTestId('md-reveal-marker')).toHaveCount(0)
    await caret(page, 2, 2)
    await expect(page.getByTestId('md-reveal-marker')).toHaveText(['## '])
  })

  test('End lands past the closing marker at the line’s end, and ArrowRight into a block left of its opening one', async ({
    page,
  }) => {
    // `first **bo|ld**`, then End: past the closing marker, so typing is not bold.
    await caret(page, 0, 8)
    await page.keyboard.press('End')
    await page.keyboard.type('X')
    expect((await shownText(page))[0]).toBe('first boldX')
    await expect(page.locator(EDITOR).locator('strong').first()).toHaveText('bold')

    // From `first boldX|` into `**bold** end`, left of its opening marker: typing is not bold.
    await caret(page, 0, 11)
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => cursor(page)).toEqual({ index: 1, offset: 0 })
    await page.keyboard.type('Z')
    expect((await shownText(page))[1]).toBe('Z**bold** end')
    await expect
      .poll(() => stored(page, pageId))
      .toEqual(['first **bold**X', 'Z**bold** end', '## Title', `see [label](${LINK}) x`])
  })

  test('ArrowLeft into a block ending in bold lands past its closing marker', async ({ page }) => {
    // `**|bold** end`: over the opening marker, then into `first **bold**|`.
    await caret(page, 1, 0)
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => cursor(page)).toEqual({ index: 0, offset: 10 })
    await page.keyboard.type('Y')
    expect((await shownText(page))[0]).toBe('first boldY')
    await expect(page.locator(EDITOR).locator('strong').first()).toHaveText('bold')
    await expect
      .poll(() => stored(page, pageId))
      .toEqual(['first **bold**Y', '**bold** end', '## Title', `see [label](${LINK}) x`])
  })

  test('with the setting off, no marker is drawn', async ({ page }) => {
    await caret(page, 1, 2)
    expect(await shownMarkers(page)).toEqual(['**', '**'])
    await setReveal(page, false)
    await openInPageMode(page)
    await caret(page, 1, 2)
    expect(await shownMarkers(page)).toEqual([])
  })
})
