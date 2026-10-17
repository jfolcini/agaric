/**
 * #5689 — "Show Markdown syntax around the cursor": turned on in Settings ›
 * Editor, the block editor shows the markers of the mark, heading or link the
 * caret is in. A marker is deleted or crossed as one unit, a heading's `#` run
 * changes its level, a link's URL is edited in place, the stored block and
 * the clipboard never carry a marker, chips stay chips, and an IME
 * composition leaves the markers in place until it ends.
 */

import { createRequire } from 'node:module'

import type { Page } from '@playwright/test'

import {
  expect,
  focusBlock,
  navigateToView,
  openPage,
  openSettingsTab,
  reopenPage,
  replaceEditorText,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

// The bundled axe-core, injected into the page (`pages-view.spec.ts`).
const axePath = createRequire(import.meta.url).resolve('axe-core')

const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

async function setReveal(page: Page, on: boolean): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Editor')
  const toggle = page.getByRole('switch', { name: 'Show Markdown syntax around the cursor' })
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(on))
}

/** Retype block 2 as `text`, through the keyboard so the input rules make the marks. */
async function typeBlock(page: Page, text: string): Promise<void> {
  await focusBlock(page, 2)
  await replaceEditorText(page, '')
  await page.keyboard.type(text)
}

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
  await setReveal(page, true)
  await openPage(page, 'Getting Started')
})

test('the caret in bold text reveals its markers, and they never reach the clipboard or the stored block', async ({
  page,
}) => {
  await typeBlock(page, 'Make **bold** end')
  const editor = page.locator(EDITOR)
  await expect(editor.locator('strong')).toHaveText('bold')
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(0)

  // `Make bo|ld end`: inside the bold text.
  await selectEditorRange(page, 7, 7)
  await expect(page.getByTestId('md-reveal-marker')).toHaveText(['**', '**'])
  await expect(editor).toHaveText('Make **bold** end')

  // A selection across both markers copies the text and its formatting, not the markers.
  await page.evaluate(() => {
    document.addEventListener('copy', (e) => {
      document.body.dataset['copied'] = e.clipboardData?.getData('text/plain') ?? ''
    })
  })
  // `Make **bold** end`, selected from drawn offset 3 to 15, markers counted.
  await selectEditorRange(page, 3, 15)
  await page.keyboard.press('Control+c')
  await expect(page.locator('body')).toHaveAttribute('data-copied', 'e bold e')

  await page.keyboard.press('Escape')
  const stored = page.locator('[data-testid="block-static"]').nth(2)
  await expect(stored).toHaveText('Make bold end')
  await expect(stored.locator('strong')).toHaveText('bold')
  await reopenPage(page, 'Getting Started')
  await expect(page.locator('[data-testid="block-static"]').nth(2)).toHaveText('Make bold end')
})

test('Delete before a revealed marker removes the bold from its whole range', async ({ page }) => {
  await typeBlock(page, 'Make **bold** end')
  await selectEditorRange(page, 7, 7)
  await expect(page.getByTestId('md-reveal-marker')).toHaveText(['**', '**'])

  // `Make |**bold**`: the end of `Make ` is the bold start, outside its markers.
  await selectEditorRange(page, 5, 5)
  await page.keyboard.press('Delete')
  const editor = page.locator(EDITOR)
  await expect(editor.locator('strong')).toHaveCount(0)
  await expect(editor).toHaveText('Make bold end')
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(0)
})

test('Backspace after the opening marker at the block start removes the bold in one undo step, without a merge', async ({
  page,
}) => {
  await typeBlock(page, '**bold** rest')
  const editor = page.locator(EDITOR)
  const blocks = page.locator('[data-testid="block-static"]')
  const staticCount = await blocks.count()
  // The block start types bold, so the caret is inside the markers: `**|bold** rest`.
  await editor.evaluate((el) =>
    (
      el as HTMLElement & { editor: { commands: { setTextSelection: (pos: number) => boolean } } }
    ).editor.commands.setTextSelection(1),
  )
  await expect(editor).toHaveText('**bold** rest')

  await page.keyboard.press('Backspace')
  await expect(editor.locator('strong')).toHaveCount(0)
  await expect(editor).toHaveText('bold rest')
  await expect(blocks).toHaveCount(staticCount)

  await page.keyboard.press('Control+z')
  await expect(editor.locator('strong')).toHaveText('bold')
  await expect(editor).toHaveText('**bold** rest')
})

test('a click past a marker types outside the bold, and a click on its near half inside', async ({
  page,
}) => {
  await typeBlock(page, 'Make **bold** rest')
  const editor = page.locator(EDITOR)
  const opening = page.getByTestId('md-reveal-marker').nth(0)
  const closing = page.getByTestId('md-reveal-marker').nth(1)

  await selectEditorRange(page, 7, 7)
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(2)
  let box = await closing.boundingBox()
  if (!box) throw new Error('the closing marker has no layout box')
  await page.mouse.click(box.x + box.width + 1, box.y + box.height / 2)
  await page.keyboard.type('X')
  await expect(editor.locator('strong')).toHaveText('bold')
  await expect(editor).toHaveText('Make boldX rest')

  await selectEditorRange(page, 7, 7)
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(2)
  box = await closing.boundingBox()
  if (!box) throw new Error('the closing marker has no layout box')
  await page.mouse.click(box.x + 1, box.y + box.height / 2)
  await page.keyboard.type('Y')
  await expect(editor.locator('strong')).toHaveText('boldY')

  // The near half of the opening marker is outside the bold. `Make **b|oldY**X rest`, markers drawn.
  await selectEditorRange(page, 8, 8)
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(2)
  box = await opening.boundingBox()
  if (!box) throw new Error('the opening marker has no layout box')
  await page.mouse.click(box.x + 1, box.y + box.height / 2)
  await page.keyboard.type('Z')
  await expect(editor.locator('strong')).toHaveText('boldY')
  await expect(editor).toHaveText('Make Z**boldY**X rest')
})

test('ArrowRight at the end of a block steps past the closing marker before it leaves the block', async ({
  page,
}) => {
  await typeBlock(page, 'Make **bold**')
  const editor = page.locator(EDITOR)
  // The input rule leaves the caret past the closing marker; step back inside, then out again.
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowRight')
  await expect(editor).toBeFocused()
  await page.keyboard.type('X')
  await expect(editor.locator('strong')).toHaveText('bold')
  await expect(editor).toHaveText('Make boldX')
})

test('an IME composition beside a marker leaves the markers in place until it ends', async ({
  page,
}) => {
  await typeBlock(page, 'Make **bold** rest')
  const editor = page.locator(EDITOR)
  const markers = page.getByTestId('md-reveal-marker')
  await selectEditorRange(page, 7, 7)
  await expect(markers).toHaveText(['**', '**'])
  // `Make **bold|** rest` with the markers drawn, then past the closing marker.
  await selectEditorRange(page, 11, 11)
  await page.keyboard.press('ArrowRight')

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'k', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.imeSetComposition', { text: 'ka', selectionStart: 2, selectionEnd: 2 })
  // The caret has left the bold run, but a composition keeps the markers where they were.
  await expect(markers).toHaveText(['**', '**'])
  await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 })
  await expect(markers).toHaveText(['**', '**'])

  await cdp.send('Input.insertText', { text: 'か' })
  await expect(markers).toHaveCount(0)
  await expect(editor).toHaveText('Make boldか rest')
  await expect(editor.locator('strong')).toHaveText('bold')
})

test('turning the preference off removes the markers', async ({ page }) => {
  await typeBlock(page, 'Make **bold** rest')
  await selectEditorRange(page, 7, 7)
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(2)
  await page.keyboard.press('Escape')

  await setReveal(page, false)
  await openPage(page, 'Getting Started')
  await focusBlock(page, 2)
  await selectEditorRange(page, 7, 7)
  await expect(page.locator(EDITOR).locator('strong')).toHaveText('bold')
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(0)
})

/** Put the caret at document position `pos` through the editor's own API. */
async function setCaret(page: Page, pos: number): Promise<void> {
  await page
    .locator(EDITOR)
    .evaluate(
      (el, at) =>
        (
          el as HTMLElement & { editor: { commands: { setTextSelection: (p: number) => boolean } } }
        ).editor.commands.setTextSelection(at),
      pos,
    )
}

/** The editor's caret position. */
async function caret(page: Page): Promise<number> {
  return page
    .locator(EDITOR)
    .evaluate(
      (el) =>
        (el as HTMLElement & { editor: { state: { selection: { from: number } } } }).editor.state
          .selection.from,
    )
}

/** A native caret move, then the editor catching up with it: it reads the move a moment later. */
async function moveCaret(page: Page, key: string, to: number): Promise<void> {
  await page.keyboard.press(key)
  await expect.poll(() => caret(page)).toBe(to)
}

/** The revealed markers as the user reads them, a link's URL field read as its value. */
async function shownMarkers(page: Page): Promise<string[]> {
  return page
    .getByTestId('md-reveal-marker')
    .evaluateAll((els) =>
      els.map((el) =>
        [...el.childNodes]
          .map(
            (n) => (n instanceof HTMLElement && n.querySelector('input')?.value) || n.textContent,
          )
          .join(''),
      ),
    )
}

/** Block 2 of Getting Started, the one `typeBlock` edits, once it is static again. */
const stored = (page: Page) =>
  page.locator('[data-testid="block-static"][data-block-id="0000000000000000000BLOCK03"]')

/** The editor's text as the user reads it, a link's URL field read as its value. */
async function shownText(page: Page): Promise<string> {
  return page.locator(EDITOR).evaluate((root) => {
    const shown = (node: Node): string =>
      node instanceof HTMLInputElement
        ? node.value
        : node.nodeType === Node.TEXT_NODE
          ? (node.textContent ?? '')
          : [...node.childNodes].map(shown).join('')
    return shown(root)
  })
}
const urlField = (page: Page) => page.getByRole('textbox', { name: 'Link URL' })

test('each heading level shows its # run while the caret is in the heading, and is saved', async ({
  page,
}) => {
  for (let level = 1; level <= 6; level++) {
    const hashes = '#'.repeat(level)
    await typeBlock(page, `${hashes} Title`)
    const editor = page.locator(EDITOR)
    await expect(editor.locator(`h${level}`)).toHaveText(`${hashes} Title`)
    expect(await shownMarkers(page)).toEqual([`${hashes} `])
    await page.keyboard.press('Escape')
    await expect(stored(page).locator(`h${level}`)).toHaveText('Title')
    await expect(page.getByTestId('md-reveal-marker')).toHaveCount(0)
  }
})

test('Backspace after the # run lowers a heading, and # left of it raises one, each in one undo step', async ({
  page,
}) => {
  await typeBlock(page, '## Title')
  const editor = page.locator(EDITOR)
  // `## |Title`: the caret at the start of the text, right of the run.
  await setCaret(page, 1)
  await page.keyboard.press('Backspace')
  await expect(editor.locator('h1')).toHaveText('# Title')
  await page.keyboard.press('Control+z')
  await expect(editor.locator('h2')).toHaveText('## Title')

  // ArrowLeft crosses the run: `|## Title`, where `#` joins it.
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('#')
  await expect(editor.locator('h3')).toHaveText('### Title')
  await page.keyboard.type('#')
  await expect(editor.locator('h4')).toHaveText('#### Title')
  await page.keyboard.press('Control+z')
  await expect(editor.locator('h3')).toHaveText('### Title')
  // Delete takes one `#` from the right.
  await page.keyboard.press('Delete')
  await expect(editor.locator('h2')).toHaveText('## Title')
  // ArrowRight steps back to the text start, where `#` is text again.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type('X')
  await expect(editor.locator('h2')).toHaveText('## XTitle')

  await page.keyboard.press('Escape')
  await expect(stored(page).locator('h2')).toHaveText('XTitle')
  await reopenPage(page, 'Getting Started')
  await expect(stored(page).locator('h2')).toHaveText('XTitle')
})

test('Backspace through a heading’s # run leaves a paragraph without merging blocks', async ({
  page,
}) => {
  await typeBlock(page, '## Title')
  const blocks = page.locator('[data-testid="block-static"]')
  const staticCount = await blocks.count()
  await setCaret(page, 1)
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  const editor = page.locator(EDITOR)
  await expect(editor.locator('h1, h2')).toHaveCount(0)
  await expect(editor).toHaveText('Title')
  await expect(blocks).toHaveCount(staticCount)
})

test('a click on the near half of the # run puts the caret left of it, and on the far half right of it', async ({
  page,
}) => {
  await typeBlock(page, '## Title')
  const editor = page.locator(EDITOR)
  const run = page.getByTestId('md-reveal-marker')
  let box = await run.boundingBox()
  if (!box) throw new Error('the # run has no layout box')
  await page.mouse.click(box.x + 2, box.y + box.height / 2)
  await page.keyboard.type('#')
  await expect(editor.locator('h3')).toHaveText('### Title')

  box = await run.boundingBox()
  if (!box) throw new Error('the # run has no layout box')
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2)
  await page.keyboard.type('X')
  await expect(editor.locator('h3')).toHaveText('### XTitle')
})

test('deleting [ or ](url) unlinks the label, in one undo step', async ({ page }) => {
  await typeBlock(page, 'see [label](https://example.com) end')
  const editor = page.locator(EDITOR)
  await expect(editor.locator('a')).toHaveText('label')
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com')

  // `see la|bel end`, then ArrowLeft twice onto the label start, inside the `[`.
  await selectEditorRange(page, 6, 6)
  expect(await shownMarkers(page)).toEqual(['[', '](https://example.com)'])
  await moveCaret(page, 'ArrowLeft', 6)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Backspace')
  await expect(editor.locator('a')).toHaveCount(0)
  await expect(editor).toHaveText('see label end')
  await page.keyboard.press('Control+z')
  await expect(editor.locator('a')).toHaveText('label')

  // `see label|](url)`: inside the link's end, Delete takes the `](url)`.
  await setCaret(page, 10)
  await page.keyboard.press('Delete')
  await expect(editor.locator('a')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(stored(page)).toHaveText('see label end')
  await expect(stored(page).getByTestId('external-link')).toHaveCount(0)
})

test('the URL field: the arrows walk into it, Enter sets the URL, Escape restores it, and the URL is saved', async ({
  page,
}) => {
  await typeBlock(page, 'see [label](https://example.com) end')
  const editor = page.locator(EDITOR)
  await expect(editor.locator('a')).toHaveText('label')

  // `see label|`, inside the link's end: ArrowRight enters the URL at its start.
  await setCaret(page, 10)
  await page.keyboard.press('ArrowRight')
  const field = urlField(page)
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('https://example.com')
  expect(await field.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(0)
  // The field is as wide as its URL, which it shows whole.
  expect(await field.evaluate((el: HTMLInputElement) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  )

  // Escape leaves it unchanged, the caret back at the end of the label.
  await page.keyboard.press('Control+a')
  await page.keyboard.type('nothing.example')
  await page.keyboard.press('Escape')
  await expect(editor).toBeFocused()
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com')
  await page.keyboard.type('Y')
  await expect(editor.locator('a')).toHaveText('labelY')

  // From past the link, ArrowLeft enters the URL at its end.
  await setCaret(page, 12)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(field).toBeFocused()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('example.org/new')
  await page.keyboard.press('Enter')
  await expect(editor).toBeFocused()
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.org/new')
  // Past the `](url)`: typing is not linked.
  await page.keyboard.type('X')
  await expect(editor.locator('a')).toHaveText('labelY')
  expect(await shownText(page)).toBe('see labelYX end')

  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com')
  await page.keyboard.press('Control+y')
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.org/new')

  await page.keyboard.press('Escape')
  const link = stored(page).getByTestId('external-link')
  await expect(link).toContainText('labelY')
  await expect(link).toHaveAttribute('data-href', 'https://example.org/new')
  await reopenPage(page, 'Getting Started')
  await expect(stored(page).getByTestId('external-link')).toHaveAttribute(
    'data-href',
    'https://example.org/new',
  )
})

test('an invalid URL is refused in the field, and a click elsewhere leaves the link as it was', async ({
  page,
}) => {
  await typeBlock(page, 'see [label](https://example.com) end')
  await setCaret(page, 10)
  await page.keyboard.press('ArrowRight')
  const field = urlField(page)
  await page.keyboard.press('Control+a')
  await page.keyboard.type('javascript:alert(1)')
  await page.keyboard.press('Enter')
  await expect(field).toBeFocused()
  await expect(field).toHaveAttribute('aria-invalid', 'true')

  await page.locator(EDITOR).locator('a').click()
  await expect(page.locator(EDITOR).locator('a')).toHaveAttribute('href', 'https://example.com')
  await expect(field).toHaveValue('https://example.com')
})

test('a URL edited in the field and left by a click elsewhere is saved', async ({ page }) => {
  await typeBlock(page, 'see [label](https://example.com) end')
  await setCaret(page, 10)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Control+a')
  await page.keyboard.type('https://example.net/')
  // A click on another block leaves the editor: the URL is set before the block saves.
  await page.locator('[data-testid="block-static"]').first().click()
  await expect(stored(page).getByTestId('external-link')).toHaveAttribute(
    'data-href',
    'https://example.net/',
  )
})

test('a long URL field stays within a phone-width line, scrolled to where the caret enters', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await typeBlock(page, `see [label](https://example.com/${'long-path-segment/'.repeat(8)}) end`)
  await setCaret(page, 7)
  const field = urlField(page)
  await expect(field).toBeVisible()
  const scrolled = () => field.evaluate((el: HTMLInputElement) => el.scrollLeft)
  // Into the field from the label, at its start; from past the link, at its end.
  await setCaret(page, 10)
  await page.keyboard.press('ArrowRight')
  await expect(field).toBeFocused()
  expect(await scrolled()).toBe(0)
  await page.keyboard.press('Escape')
  await setCaret(page, 11)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(field).toBeFocused()
  expect(await scrolled()).toBeGreaterThan(0)
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    editor: (() => {
      const el = document.querySelector('[data-testid="block-editor"] [contenteditable="true"]')
      return el ? el.scrollWidth - el.clientWidth : -1
    })(),
  }))
  expect(overflow).toEqual({ page: 0, editor: 0 })
})

test('a bare URL reveals nothing', async ({ page }) => {
  await typeBlock(page, 'go https://example.com now')
  const editor = page.locator(EDITOR)
  await expect(editor.locator('a')).toHaveText('https://example.com')
  await selectEditorRange(page, 8, 8)
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(0)
})

test('chips stay chips: no syntax beside a tag, and the arrows step over it', async ({ page }) => {
  // GS_4: `Try tagging blocks with #[work] or #[personal] to organize your notes.`
  const block = page.locator('[data-testid="block-static"]').nth(3)
  const before = (await block.textContent()) ?? ''
  await focusBlock(page, 3)
  const editor = page.locator(EDITOR)
  const tagPos = await editor.evaluate((el) => {
    interface Doc {
      descendants: (f: (node: { type: { name: string } }, pos: number) => boolean) => void
    }
    const { doc } = (el as HTMLElement & { editor: { state: { doc: Doc } } }).editor.state
    let at = -1
    doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === 'tag_ref') at = pos
      return at < 0
    })
    return at
  })
  for (const pos of [tagPos, tagPos + 1]) {
    await setCaret(page, pos)
    await expect(page.getByTestId('md-reveal-marker')).toHaveCount(0)
  }
  // Past the chip, ArrowLeft lands before it: the chip is one step.
  await setCaret(page, tagPos + 1)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => caret(page)).toBe(tagPos)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="block-static"]').nth(3)).toHaveText(before)
})

test('axe finds no violation with a heading’s # run, a link’s syntax and its URL field drawn', async ({
  page,
}) => {
  await typeBlock(page, '## see [label](https://example.com) **bold**')
  await setCaret(page, 7)
  expect(await shownMarkers(page)).toEqual(['## ', '[', '](https://example.com)'])
  await page.addScriptTag({ path: axePath })
  const violations = await page.evaluate(async () => {
    // @ts-expect-error injected global
    const results = await window.axe.run(document.querySelector('[data-testid="block-editor"]'))
    return results.violations.map((v: { id: string; nodes: unknown[] }) => ({
      id: v.id,
      count: v.nodes.length,
    }))
  })
  expect(violations).toEqual([])
  await moveCaret(page, 'ArrowRight', 8)
  await moveCaret(page, 'ArrowRight', 9)
  await moveCaret(page, 'ArrowRight', 10)
  await page.keyboard.press('ArrowRight')
  await expect(urlField(page)).toBeFocused()
  const focused = await page.evaluate(async () => {
    // @ts-expect-error injected global
    const results = await window.axe.run(document.querySelector('[data-testid="block-editor"]'))
    return results.violations.map((v: { id: string }) => v.id)
  })
  expect(focused).toEqual([])
})

test('an IME composition past a link in a heading leaves its markers in place until it ends', async ({
  page,
}) => {
  await typeBlock(page, '## see [label](https://example.com) rest')
  const markers = page.getByTestId('md-reveal-marker')
  // `## see [label](url) |rest`, then ArrowLeft onto the link's end, past its `](url)`.
  await setCaret(page, 11)
  await expect(markers).toHaveCount(1)
  await page.keyboard.press('ArrowLeft')
  expect(await shownMarkers(page)).toEqual(['## ', '[', '](https://example.com)'])

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'k', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 })
  // The caret has left the link, but a composition keeps the markers where they were.
  expect(await shownMarkers(page)).toEqual(['## ', '[', '](https://example.com)'])
  await cdp.send('Input.insertText', { text: 'か' })
  await expect(markers).toHaveText(['##'])
  await expect(page.locator(EDITOR).locator('a')).toHaveText('label')
  expect(await shownText(page)).toBe('## see labelか rest')
})
