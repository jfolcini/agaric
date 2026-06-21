import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

/**
 * E2E for #1439 — convert pasted clipboard HTML to Agaric markdown.
 *
 * What the browser proves that unit tests cannot: a real `paste` ClipboardEvent
 * carrying a `text/html` DataTransfer, dispatched onto the live contenteditable,
 * is routed through ProseMirror's `handlePaste` (the new `HtmlPaste` plugin),
 * lazily loads Turndown, converts the fragment, and materializes STRUCTURED
 * blocks via the focused BlockTree's `pasteBlocks` — not literal HTML/markdown
 * text. It also guards the no-regression contract: a paste with NO `text/html`
 * falls through to the existing task-paste / external-link / plain-text path.
 *
 * The conversion + block-tree shaping are covered deterministically by the unit
 * tests (`src/editor/__tests__/html-to-blocks.test.ts`); this spec drives the
 * live wiring end to end.
 */

const PAGE = 'Getting Started'

type Editor = import('@playwright/test').Locator

/** Dispatch a native paste carrying `text/html` (+ a `text/plain` fallback). */
async function pasteHtml(editor: Editor, html: string, plain = ''): Promise<void> {
  await editor.evaluate(
    (el, { htmlValue, plainValue }) => {
      const data = new DataTransfer()
      data.setData('text/html', htmlValue)
      if (plainValue) data.setData('text/plain', plainValue)
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    },
    { htmlValue: html, plainValue: plain },
  )
}

/** Dispatch a native paste of `text/plain` only (no HTML). */
async function pasteText(editor: Editor, text: string): Promise<void> {
  await editor.evaluate((el, value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, text)
}

/** Open a fresh EMPTY block after block 0 and return its live editor locator. */
async function freshBlock(page: import('@playwright/test').Page): Promise<Editor> {
  const editor = await focusBlock(page, 0)
  await editor.press('End')
  await editor.press('Enter')
  const live = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
  await expect(live.locator('p.is-editor-empty')).toBeVisible()
  return live
}

function rowsWithText(page: import('@playwright/test').Page, token: string) {
  return page.locator('[data-testid="sortable-block"]').filter({ hasText: token })
}

test.describe('HTML paste → markdown blocks (#1439)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('pastes a formatted web snippet as STRUCTURED blocks (not literal text)', async ({
    page,
  }) => {
    const editor = await freshBlock(page)

    const html =
      '<h2>My Heading</h2>' +
      '<p>A paragraph with <b>bold</b> text and a <a href="https://example.com">link</a>.</p>' +
      '<ul><li>first item</li><li>second item</li></ul>'

    await pasteHtml(editor, html, 'My Heading\nA paragraph...\nfirst item\nsecond item')

    // The heading became its OWN block rendered as a heading element (not the
    // literal text "## My Heading").
    await expect(page.locator('h2', { hasText: 'My Heading' })).toBeVisible()
    // The list items materialized as separate blocks.
    await expect.poll(async () => await rowsWithText(page, 'first item').count()).toBeGreaterThan(0)
    await expect
      .poll(async () => await rowsWithText(page, 'second item').count())
      .toBeGreaterThan(0)
    // The bold run rendered as a real <strong>, and the link as the static
    // external-link span (the read-mode renderer emits a `data-href` span, not
    // an `<a>`) — proving conversion ran (not literal markdown text).
    await expect(page.locator('strong', { hasText: 'bold' })).toBeVisible()
    await expect(
      page.locator('[data-testid="external-link"][data-href="https://example.com"]'),
    ).toBeVisible()
    // No literal markdown syntax leaked into the rendered blocks.
    await expect(
      page.locator('[data-testid="sortable-block"]').filter({ hasText: '## My Heading' }),
    ).toHaveCount(0)
  })

  test('a javascript: link is de-linked to plain text (security)', async ({ page }) => {
    const editor = await freshBlock(page)
    await pasteHtml(
      editor,
      '<p>danger <a href="javascript:alert(1)">click me</a> end</p>',
      'danger click me end',
    )
    // The text survives, but no link element with a javascript: href is ever
    // created (de-linked at conversion time; the renderer also re-validates).
    await expect.poll(async () => await rowsWithText(page, 'click me').count()).toBeGreaterThan(0)
    await expect(page.locator('[data-href^="javascript:"]')).toHaveCount(0)
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0)
  })

  test('pastes a Phase 2 snippet (table + code + image + task) as STRUCTURED blocks', async ({
    page,
  }) => {
    const editor = await freshBlock(page)

    const html =
      '<table><thead><tr><th>Name</th><th>Qty</th></tr></thead>' +
      '<tbody><tr><td>Apples</td><td>3</td></tr></tbody></table>' +
      '<pre><code class="language-js">const answer = 42</code></pre>' +
      '<img src="https://example.com/pic.png" alt="a picture">' +
      '<ul><li><input type="checkbox"> open task</li>' +
      '<li><input type="checkbox" checked> finished task</li></ul>'

    await pasteHtml(editor, html, 'Name Qty Apples 3 const answer = 42 open task finished task')

    // Table → a real <table> with the header + data cell text.
    await expect(page.locator('table th', { hasText: 'Name' })).toBeVisible()
    await expect(page.locator('table td', { hasText: 'Apples' })).toBeVisible()

    // Fenced code → a <pre><code> carrying the raw code (not literal ``` text).
    await expect(page.locator('pre code', { hasText: 'const answer = 42' })).toBeVisible()
    await expect(
      page.locator('[data-testid="sortable-block"]').filter({ hasText: '```js' }),
    ).toHaveCount(0)

    // Image → the `![alt](src)` parsed to an image node; the static read-mode
    // renderer shows the external-image privacy placeholder (gated, no network
    // request), labelled with the source domain. Its presence proves an image
    // node was produced (not literal `![…](…)` text).
    await expect(page.locator('[data-testid="image-external-blocked"]').first()).toBeVisible()
    await expect(
      page.locator('[data-testid="image-external-domain"]', { hasText: 'example.com' }),
    ).toBeVisible()

    // Task list → two separate task blocks. The `- [ ]` / `- [x]` markers are
    // CONSUMED by the parser (recognised as tasks, not literal bullets), so the
    // rendered rows show only the labels — never the literal `- [ ]` text.
    await expect.poll(async () => await rowsWithText(page, 'open task').count()).toBeGreaterThan(0)
    await expect
      .poll(async () => await rowsWithText(page, 'finished task').count())
      .toBeGreaterThan(0)
    await expect(rowsWithText(page, 'open task').first()).not.toContainText('- [ ]')
    await expect(rowsWithText(page, 'finished task').first()).not.toContainText('- [x]')
  })

  test('a javascript: image src is dropped (security)', async ({ page }) => {
    const editor = await freshBlock(page)
    await pasteHtml(
      editor,
      '<p>before</p><img src="javascript:alert(1)" alt="evil"><p>after</p>',
      'before after',
    )
    // The surrounding paragraphs land, but the unsafe image is dropped at
    // conversion time — no image node and no javascript: src ever reach the DOM.
    await expect.poll(async () => await rowsWithText(page, 'before').count()).toBeGreaterThan(0)
    await expect(page.locator('img[src^="javascript:"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="image-external-blocked"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="image-rendered"]')).toHaveCount(0)
  })

  test('plain-text paste (no HTML) is unaffected — falls through (no regression)', async ({
    page,
  }) => {
    const editor = await freshBlock(page)
    await pasteText(editor, 'just ordinary pasted text')
    // Plain text lands in the focused block verbatim — HtmlPaste returned false.
    await expect(editor).toContainText('just ordinary pasted text')
  })

  test('task paste still works when only text/plain is present (no regression)', async ({
    page,
  }) => {
    const editor = await freshBlock(page)
    await pasteText(editor, '- [ ] paste me')
    // TaskPaste still owns the bare-cursor task line (HtmlPaste saw no HTML).
    await expect(editor.locator('p[data-todo-state="TODO"]')).toBeVisible()
    await expect(editor).toContainText('paste me')
    await expect(editor).not.toContainText('- [ ]')
  })

  test('URL paste still autolinks when only text/plain is present (no regression)', async ({
    page,
  }) => {
    const editor = await freshBlock(page)
    await pasteText(editor, 'https://agaric.example')
    // ExternalLink's paste-to-link still fires (HtmlPaste saw no HTML).
    await expect(editor.locator('a[href="https://agaric.example"]')).toBeVisible()
  })
})
