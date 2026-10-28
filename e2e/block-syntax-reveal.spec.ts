/**
 * #5691 — "Show Markdown syntax around the cursor" for the block constructs:
 * a callout's `> [!TYPE]`, a quote's `>`, a code block's fences and display
 * math's `$$` show while the cursor is in (or on) them and hide once it
 * leaves, in page mode and in block mode. The caret stays where it was as the
 * syntax comes and goes, and what is typed inside is saved as the block's
 * Markdown, never with the syntax drawn.
 */

import { createRequire } from 'node:module'

import type { Locator, Page } from '@playwright/test'

import {
  expect,
  focusBlockById,
  ipc,
  navigateToView,
  openPage,
  openSettingsTab,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

const axePath = createRequire(import.meta.url).resolve('axe-core')
const SPACE = 'SPACE_PERSONAL'
const PAGE_EDITOR = '[data-testid="page-mode-editor"]'
const BLOCK_EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const TITLE = 'Block syntax reveal'
const CONTENTS = [
  'plain start',
  '> [!NOTE] tip',
  '> quoted',
  '```ts\nlet a = 1\n```',
  '$$\nx^2\n$$',
  'plain end',
]

async function setReveal(page: Page, on: boolean): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Editor')
  const toggle = page.getByRole('switch', { name: 'Show Markdown syntax around the cursor' })
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(on))
}

/** A page of `CONTENTS`, one top-level block each; resolves the blocks' ids, in order. */
async function seedPage(page: Page): Promise<string[]> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: TITLE,
    spaceId: SPACE,
  })
  const { blocks } = await ipc<{ blocks: Array<{ id: string }> }>(page, 'create_blocks_batch', {
    specs: CONTENTS.map((content) => ({
      blockType: 'content',
      content,
      parentId: pageId,
      position: null,
    })),
  })
  return blocks.map((b) => b.id)
}

async function openInPageMode(page: Page): Promise<void> {
  await openPage(page, TITLE)
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: 'Page' })
    .click()
  await expect(page.locator(`${PAGE_EDITOR} [data-page-block]`)).toHaveCount(CONTENTS.length)
}

/** Put the caret `offset` characters past the start of `text` in the editor at `selector`, and focus it. */
async function caretAt(page: Page, selector: string, text: string, offset = 0): Promise<void> {
  await page.evaluate(
    ({ selector: sel, text: t, offset: o }) => {
      interface PMNode {
        isText: boolean
        text?: string
      }
      const { editor } = document.querySelector(sel) as HTMLElement & {
        editor: {
          state: {
            doc: { descendants: (f: (node: PMNode, pos: number) => boolean) => void }
          }
          commands: { setTextSelection: (pos: number) => boolean }
          view: { focus: () => void }
        }
      }
      let found = -1
      editor.state.doc.descendants((node, pos) => {
        const at = node.isText ? (node.text ?? '').indexOf(t) : -1
        if (found < 0 && at >= 0) found = pos + at
        return found < 0
      })
      if (found < 0) throw new Error(`no ${t} in the editor`)
      editor.commands.setTextSelection(found + o)
      editor.view.focus()
      // ProseMirror puts its own selection back 20 ms after a focus if the DOM's differs.
      return new Promise((resolve) => setTimeout(resolve, 20))
    },
    { selector, text, offset },
  )
}

/** The text of the textblock the caret is in, and how far into it. */
function cursor(page: Page, selector: string): Promise<{ text: string; offset: number }> {
  return page.evaluate((sel) => {
    const { editor } = document.querySelector(sel) as HTMLElement & {
      editor: {
        state: { selection: { $from: { parent: { textContent: string }; parentOffset: number } } }
      }
    }
    const { $from } = editor.state.selection
    return { text: $from.parent.textContent, offset: $from.parentOffset }
  }, selector)
}

/**
 * The construct syntax drawn, as the user reads it, in document order: the
 * widgets' text, and the lines a code block or display math draws above and
 * below itself as generated content.
 */
function shownSyntax(page: Page): Promise<string[]> {
  return page.locator('.md-reveal-syntax-marker, .md-reveal-block-syntax').evaluateAll((els) =>
    els.flatMap((el) => {
      if (!el.classList.contains('md-reveal-block-syntax')) return [el.textContent ?? '']
      // The computed `content` is `"```ts" / ""`: the drawn string, then its empty alt text.
      return (['::before', '::after'] as const).map((pseudo) => {
        const drawn = /^"((?:[^"\\]|\\.)*)"/.exec(getComputedStyle(el, pseudo).content)
        return drawn?.[1]?.replace(/\\(.)/g, '$1') ?? ''
      })
    }),
  )
}

/** The box of the first `char` in `text`'s text node in the editor at `selector`. */
function charBox(
  page: Page,
  selector: string,
  text: string,
  char: string,
): Promise<{ x: number; y: number; height: number }> {
  return page.evaluate(
    ({ selector: sel, text: t, char: c }) => {
      const root = document.querySelector(sel)
      if (!root) throw new Error(`no ${sel}`)
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const content = node.textContent ?? ''
        if (!content.includes(t)) continue
        const at = content.indexOf(t) + t.indexOf(c)
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + 1)
        const box = range.getBoundingClientRect()
        return { x: box.left, y: box.top, height: box.height }
      }
      throw new Error(`no ${t} drawn`)
    },
    { selector, text, char },
  )
}

/** Where the browser draws the caret. */
function caretBox(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const range = window.getSelection()?.getRangeAt(0)
    if (!range) throw new Error('no caret')
    const box = range.getClientRects()[0] ?? range.getBoundingClientRect()
    return { x: box.left, y: box.top }
  })
}

/**
 * `pre` draws its fences on lines of their own, right above and right below
 * its box, in the room its margins leave, and `block`, the block holding it,
 * reads as the code alone: a WebDriver read-back of the editor sees no fence.
 */
async function expectFencesAround(pre: Locator, block: Locator, code: string): Promise<void> {
  const layout = await pre.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const own = getComputedStyle(el)
    const line = (pseudo: '::before' | '::after') => {
      const style = getComputedStyle(el, pseudo)
      return { position: style.position, height: Number.parseFloat(style.lineHeight) }
    }
    return {
      before: line('::before'),
      after: line('::after'),
      margins: [own.marginTop, own.marginBottom].map(Number.parseFloat),
      height: box.height,
    }
  })
  expect(layout.before.position).toBe('absolute')
  expect(layout.after.position).toBe('absolute')
  expect(layout.margins).toEqual([layout.before.height, layout.after.height])
  await expect(block).toHaveText(code, { useInnerText: true })
}

/** Each block's content as the backend holds it, re-read one by one. */
function stored(page: Page, ids: readonly string[]): Promise<string[]> {
  return Promise.all(
    ids.map(
      async (blockId) => (await ipc<{ content: string }>(page, 'get_block', { blockId })).content,
    ),
  )
}

test.describe('block syntax revealed around the cursor in page mode (#5691) @editor @markdown @pages', () => {
  let ids: string[] = []

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await setReveal(page, true)
    ids = await seedPage(page)
    await openInPageMode(page)
  })

  test('a callout, a quote, a code block and display math each show their syntax while the cursor is on them, and hide it once it leaves', async ({
    page,
  }) => {
    await caretAt(page, PAGE_EDITOR, 'plain start', 2)
    expect(await shownSyntax(page)).toEqual([])
    await caretAt(page, PAGE_EDITOR, 'tip', 1)
    expect(await shownSyntax(page)).toEqual(['> [!NOTE] '])
    await caretAt(page, PAGE_EDITOR, 'quoted', 1)
    expect(await shownSyntax(page)).toEqual(['> '])

    await caretAt(page, PAGE_EDITOR, 'let a', 2)
    expect(await shownSyntax(page)).toEqual(['```ts', '```'])
    const preFirst = page.locator(`${PAGE_EDITOR} pre`).first()
    await expectFencesAround(
      preFirst,
      preFirst.locator('xpath=ancestor::*[@data-page-block][1]'),
      'let a = 1',
    )

    // ArrowRight off the code's end selects the display math after it.
    await caretAt(page, PAGE_EDITOR, '= 1', 3)
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => shownSyntax(page)).toEqual(['$$', '$$'])

    await caretAt(page, PAGE_EDITOR, 'plain end', 2)
    expect(await shownSyntax(page)).toEqual([])

    await page.addScriptTag({ path: axePath })
    for (const [text, drawn] of [
      ['tip', ['> [!NOTE] ']],
      ['let', ['```ts', '```']],
    ] as const) {
      await caretAt(page, PAGE_EDITOR, text, 1)
      expect(await shownSyntax(page)).toEqual(drawn)
      // The code block's bubble fades in under the caret: measure it at rest.
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
      const violations = await page.evaluate(async () => {
        // @ts-expect-error injected global
        const results = await window.axe.run({ include: [['.page-editor']] })
        return results.violations.map((v: { id: string }) => v.id)
      })
      expect(violations).toEqual([])
    }
  })

  test('the caret stays where it was as the syntax comes and goes, and the arrows cross the fence lines', async ({
    page,
  }) => {
    // A click on the `u` of `quoted` before its `> ` is drawn: the caret stays before the `u`.
    await caretAt(page, PAGE_EDITOR, 'plain start', 0)
    const u = await charBox(page, PAGE_EDITOR, 'quoted', 'u')
    await page.mouse.click(u.x + 1, u.y + u.height / 2)
    await expect(page.getByTestId('md-reveal-syntax-marker')).toHaveText(['> '])
    expect(await cursor(page, PAGE_EDITOR)).toEqual({ text: 'quoted', offset: 1 })

    // At the quote's start the caret is drawn right of `> `, where typing goes.
    await caretAt(page, PAGE_EDITOR, 'quoted', 0)
    const marker = await page.getByTestId('md-reveal-syntax-marker').boundingBox()
    if (!marker) throw new Error('the `> ` run has no layout box')
    expect((await caretBox(page)).x).toBeGreaterThanOrEqual(marker.x + marker.width - 1)

    // From the code's first line, ArrowUp leaves the code over its opening fence.
    await caretAt(page, PAGE_EDITOR, 'let a', 0)
    await page.keyboard.press('ArrowUp')
    await expect.poll(async () => (await cursor(page, PAGE_EDITOR)).text).toBe('quoted')
    // And back down, into the code below its opening fence.
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await cursor(page, PAGE_EDITOR)).text).toBe('let a = 1')
    expect(await shownSyntax(page)).toEqual(['```ts', '```'])
  })

  test('a code block typed with ``` shows its fences around it, and what is typed in it, highlighted as it goes, is code in order', async ({
    page,
  }) => {
    await caretAt(page, PAGE_EDITOR, 'plain end', 9)
    await page.keyboard.press('Enter')
    await page.keyboard.type('```js ')
    expect(await shownSyntax(page)).toEqual(['```js', '```'])
    // `const` turns into a highlighted keyword under the caret, and the typing goes on after it.
    await page.keyboard.type('const x = 42')
    await page.keyboard.press('Enter')
    await page.keyboard.type('d')
    expect(await cursor(page, PAGE_EDITOR)).toEqual({ text: 'const x = 42\nd', offset: 14 })
    const preLast = page.locator(`${PAGE_EDITOR} pre`).last()
    await expectFencesAround(
      preLast,
      preLast.locator('xpath=ancestor::*[@data-page-block][1]'),
      'const x = 42\nd',
    )

    const id = await page
      .locator(`${PAGE_EDITOR} [data-page-block]`)
      .last()
      .getAttribute('data-page-block-id')
    if (!id) throw new Error('the new block has no id')
    await caretAt(page, PAGE_EDITOR, 'plain start', 0)
    await expect.poll(() => stored(page, [id])).toEqual(['```js\nconst x = 42\nd\n```'])
    await reopenPage(page, TITLE)
    await expect(page.getByTestId('block-static')).toHaveCount(CONTENTS.length + 1)
    expect(await stored(page, [id])).toEqual(['```js\nconst x = 42\nd\n```'])
  })

  test('what is typed inside each construct is saved as its Markdown, with no drawn syntax', async ({
    page,
  }) => {
    await caretAt(page, PAGE_EDITOR, 'tip', 3)
    await page.keyboard.type('s')
    await caretAt(page, PAGE_EDITOR, 'quoted', 0)
    await page.keyboard.type('X')
    await caretAt(page, PAGE_EDITOR, 'let a', 3)
    await page.keyboard.type('Y')
    await caretAt(page, PAGE_EDITOR, 'plain end', 0)
    expect(await shownSyntax(page)).toEqual([])

    const saved = [
      'plain start',
      '> [!NOTE] tips',
      '> Xquoted',
      '```ts\nletY a = 1\n```',
      '$$\nx^2\n$$',
      'plain end',
    ]
    await expect.poll(() => stored(page, ids)).toEqual(saved)
    // The page reopens in blocks, the mode the setting gives it.
    await reopenPage(page, TITLE)
    await expect(page.getByTestId('block-static')).toHaveCount(CONTENTS.length)
    expect(await stored(page, ids)).toEqual(saved)
  })
})

test.describe('block syntax revealed around the cursor in block mode (#5691) @editor @markdown', () => {
  let ids: string[] = []

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await setReveal(page, true)
    ids = await seedPage(page)
    await openPage(page, TITLE)
  })

  test('the focused block shows its construct’s syntax, hidden again once another block is focused, and typing is saved', async ({
    page,
  }) => {
    const [, callout, quote, code, math, plain] = ids
    if (!callout || !quote || !code || !math || !plain) throw new Error('the page was not seeded')
    await focusBlockById(page, callout)
    await caretAt(page, BLOCK_EDITOR, 'tip', 3)
    await expect(page.getByTestId('md-reveal-syntax-marker')).toHaveText(['> [!NOTE] '])
    await page.keyboard.type('s')

    await focusBlockById(page, quote)
    await caretAt(page, BLOCK_EDITOR, 'quoted', 0)
    await expect(page.getByTestId('md-reveal-syntax-marker')).toHaveText(['> '])
    const marker = await page.getByTestId('md-reveal-syntax-marker').boundingBox()
    if (!marker) throw new Error('the `> ` run has no layout box')
    expect((await caretBox(page)).x).toBeGreaterThanOrEqual(marker.x + marker.width - 1)
    await page.keyboard.type('X')

    await focusBlockById(page, code)
    await caretAt(page, BLOCK_EDITOR, 'let a', 3)
    expect(await shownSyntax(page)).toEqual(['```ts', '```'])
    await expectFencesAround(
      page.locator(`${BLOCK_EDITOR} pre`),
      page.locator(BLOCK_EDITOR),
      'let a = 1',
    )
    await page.keyboard.type('Y')

    await focusBlockById(page, math)
    await expect.poll(() => shownSyntax(page)).toEqual(['$$', '$$'])

    await focusBlockById(page, plain)
    await expect.poll(() => shownSyntax(page)).toEqual([])

    const saved = [
      'plain start',
      '> [!NOTE] tips',
      '> Xquoted',
      '```ts\nletY a = 1\n```',
      '$$\nx^2\n$$',
      'plain end',
    ]
    await expect.poll(() => stored(page, ids)).toEqual(saved)
    await reopenPage(page, TITLE)
    await expect(page.getByTestId('block-static')).toHaveCount(CONTENTS.length)
    expect(await stored(page, ids)).toEqual(saved)
  })
})
