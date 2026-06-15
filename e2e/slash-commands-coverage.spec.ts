import {
  expect,
  focusBlock,
  openPage,
  reopenPage,
  saveBlock,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

/**
 * E2E coverage for slash-menu commands that were e2e-untested before #1169.
 *
 * The base `slash-commands.spec.ts` already covers tasks (/todo /doing /done),
 * priorities, headings 1–2, and the date picker; `markdown-syntax.spec.ts` and
 * `selection-bubble.spec.ts` cover the mark *effects* (bold/italic/code) via
 * typed markdown and the bubble menu. This file fills the slash-menu gaps:
 *
 *   - Headings 3–6   → <h3>..<h6>            (1–2 are in slash-commands.spec.ts)
 *   - /quote         → <blockquote>
 *   - /divider       → <hr>
 *   - /numbered-list → <ol>
 *   - /turn …        → turn-into conversions (Text, Heading 1, Code block, Quote)
 *
 * Each test drives the command through the real / picker (type `/`, filter,
 * select the item by its rendered label / id), asserts the user-visible
 * rendered DOM (real tags — never @tiptap/pm editor internals, per the
 * instanceof footgun), saves, and then RE-OPENS the page (Status → back via
 * `reopenPage`, which forces a fresh fetch from the Tauri mock) to prove the
 * structure round-trips through persistence.
 *
 * Why no mark commands here (/bold /italic /code /strike /highlight):
 *   The slash menu only opens at a COLLAPSED caret — TipTap's Suggestion
 *   plugin fires on the typed `/`, which replaces/clears any active text
 *   selection, and the menu closes the moment the selection moves off the
 *   slash query range. The mark handler (`useSlashCommandMarks`) toggles the
 *   mark only when `from !== to`; at a collapsed caret it instead inserts the
 *   Markdown delimiter pair (e.g. `**` `**`) as literal text, which does NOT
 *   render as <strong>/<em>/<mark>/<s>/<code>. So there is no slash-menu path
 *   that applies a mark to a selection in this harness. The mark *effects* are
 *   already covered via Ctrl+B/I/E (markdown-syntax.spec.ts) and the bubble
 *   menu (selection-bubble.spec.ts). A slash-menu mark test is a separate
 *   slice and would need a product affordance that preserves the selection
 *   across the `/` trigger. See the #1169 follow-up note.
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_GETTING_STARTED ("Getting Started") — 5 child blocks; GS_1 is the
 *   first, editable, plain-paragraph block these tests mutate.
 */

const firstBlock = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid="sortable-block"]').first()
const firstStatic = (page: import('@playwright/test').Page) =>
  firstBlock(page).locator('[data-testid="block-static"]')

// ===========================================================================
// 1. Heading commands 3–6 (slash menu) — h1/h2 live in slash-commands.spec.ts
// ===========================================================================

test.describe('Slash headings 3–6', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  // The heading items carry stable ids (`#suggestion-h3` … `#suggestion-h6`),
  // so we pin the exact level rather than relying on "Heading N" substring
  // order (which `hasText` matches loosely).
  for (const level of [3, 4, 5, 6] as const) {
    test(`/h${level} sets <h${level}> and persists through reopen`, async ({ page }) => {
      await focusBlock(page)

      const list = await typeSlashCommand(page, 'heading')
      const item = list.locator(`#suggestion-h${level}`)
      await expect(item).toBeVisible()
      await item.click()

      // Editor re-mounts with the `#`-prefixed heading; wait for it to settle.
      await expect(
        page.locator('[data-testid="block-editor"] [contenteditable="true"]'),
      ).toBeVisible()

      // Save (Enter) and assert the static render carries the heading tag.
      await saveBlock(page)
      await expect(firstStatic(page).locator(`h${level}`)).toBeVisible()

      // Re-open the page (fresh fetch from the mock) — the heading must survive.
      await reopenPage(page, 'Getting Started')
      await expect(firstStatic(page).locator(`h${level}`)).toBeVisible()
    })
  }
})

// ===========================================================================
// 2. Structural inserts via the slash menu
// ===========================================================================

test.describe('Slash structural inserts', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('/quote wraps the block in a <blockquote> and persists', async ({ page }) => {
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('quote me')

    const list = await typeSlashCommand(page, 'quote')
    const item = list.locator('[data-testid="suggestion-item"]', { hasText: 'QUOTE' }).first()
    await expect(item).toBeVisible()
    await item.click()

    // Live editor now renders a blockquote around the text.
    await expect(editor.locator('blockquote')).toBeVisible()

    await saveBlock(page)
    await expect(firstStatic(page).locator('blockquote')).toBeVisible()
    await expect(firstStatic(page).locator('blockquote')).toContainText('quote me')

    await reopenPage(page, 'Getting Started')
    await expect(firstStatic(page).locator('blockquote')).toBeVisible()
    await expect(firstStatic(page).locator('blockquote')).toContainText('quote me')
  })

  test('/divider inserts an <hr> and persists', async ({ page }) => {
    await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('above the rule')

    const list = await typeSlashCommand(page, 'divider')
    const item = list.locator('[data-testid="suggestion-item"]', { hasText: 'DIVIDER' }).first()
    await expect(item).toBeVisible()
    await item.click()

    // The horizontal rule renders with a dedicated test id in static view.
    const rule = page.locator('[data-testid="horizontal-rule"]')

    await saveBlock(page)
    await expect(rule).toHaveCount(1)

    await reopenPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="horizontal-rule"]')).toHaveCount(1)
  })

  test('/numbered-list turns the block into an <ol> and persists', async ({ page }) => {
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('first item')

    const list = await typeSlashCommand(page, 'numbered')
    const item = list.locator('[data-testid="suggestion-item"]', { hasText: 'NUMBERED' }).first()
    await expect(item).toBeVisible()
    await item.click()

    await expect(editor.locator('ol li')).toBeVisible()

    await saveBlock(page)
    await expect(firstStatic(page).locator('ol')).toBeVisible()
    await expect(firstStatic(page).locator('ol li')).toContainText('first item')

    await reopenPage(page, 'Getting Started')
    await expect(firstStatic(page).locator('ol')).toBeVisible()
    await expect(firstStatic(page).locator('ol li')).toContainText('first item')
  })
})

// ===========================================================================
// 3. Turn-into conversions via the slash menu (/turn …)
// ===========================================================================
//
// Typing `/turn` surfaces the inline-expanded TURN_INTO_COMMANDS list
// ("TURN INTO Text", "TURN INTO Heading 1", "TURN INTO Code block",
// "TURN INTO Quote", …). The base `/turn` parent row ("TURN INTO — Convert …")
// is a no-op label, so each test picks the concrete target by its label text.
// Each conversion runs on an EXISTING block's content.

test.describe('Slash turn-into conversions', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  /** Type fresh content into the first block, open `/turn`, pick `label`. */
  async function turnInto(page: import('@playwright/test').Page, text: string, label: string) {
    await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.type(text)
    const list = await typeSlashCommand(page, 'turn')
    // `hasText` is a substring match; the concrete target rows ("TURN INTO
    // Heading 1", …) and the parent "TURN INTO — Convert this block…" both
    // contain "TURN INTO". Filtering on the target word ("Heading 1", "Code
    // block", "Quote", "Text") disambiguates. The parent row's text is
    // "Convert this block to another type" — it does not contain those words.
    const item = list.locator('[data-testid="suggestion-item"]', { hasText: label }).first()
    await expect(item).toBeVisible()
    await item.click()
  }

  test('/turn → Heading 1 converts an existing block to <h1> and persists', async ({ page }) => {
    await turnInto(page, 'turn me into a heading', 'Heading 1')

    await saveBlock(page)
    await expect(firstStatic(page).locator('h1')).toBeVisible()
    await expect(firstStatic(page).locator('h1')).toContainText('turn me into a heading')

    await reopenPage(page, 'Getting Started')
    await expect(firstStatic(page).locator('h1')).toBeVisible()
    await expect(firstStatic(page).locator('h1')).toContainText('turn me into a heading')
  })

  test('/turn → Code block converts an existing block to <pre><code> and persists', async ({
    page,
  }) => {
    await turnInto(page, 'console.log(1)', 'Code block')

    // A code block captures Enter as a newline (it never commits the block), so
    // `saveBlock` (which presses Enter) can't leave it. Commit by clicking a
    // DIFFERENT block's static area — that blurs + flushes the code block, which
    // then renders as <pre><code> in the static view.
    await page.locator('[data-testid="block-static"]').nth(1).click()
    await expect(firstStatic(page).locator('pre code')).toBeVisible()

    await reopenPage(page, 'Getting Started')
    await expect(firstStatic(page).locator('pre code')).toBeVisible()
  })

  test('/turn → Quote converts an existing block to <blockquote> and persists', async ({
    page,
  }) => {
    await turnInto(page, 'turn me into a quote', 'Quote')

    await saveBlock(page)
    await expect(firstStatic(page).locator('blockquote')).toBeVisible()
    await expect(firstStatic(page).locator('blockquote')).toContainText('turn me into a quote')

    await reopenPage(page, 'Getting Started')
    await expect(firstStatic(page).locator('blockquote')).toBeVisible()
    await expect(firstStatic(page).locator('blockquote')).toContainText('turn me into a quote')
  })

  test('/turn → Text reverts a heading back to a plain paragraph and persists', async ({
    page,
  }) => {
    // First make the block a heading via the same slash family, then — WITHOUT
    // leaving the editor — turn it back to Text, asserting the <h*> is gone and
    // a paragraph remains. (Re-focusing between the two conversions would race
    // the still-open editor's blur path; we stay in the one editor session.)
    await turnInto(page, 'heading then text', 'Heading 1')
    await expect(firstBlock(page).locator('h1')).toBeVisible()

    // The block is still in edit mode (as an <h1>). Open `/turn` again on the
    // live editor and pick Text. `typeSlashCommand` appends ` /` at the line
    // end, so the heading content is preserved and only the block type flips.
    const list = await typeSlashCommand(page, 'turn')
    const textItem = list.locator('[data-testid="suggestion-item"]', { hasText: 'Text' }).first()
    await expect(textItem).toBeVisible()
    await textItem.click()

    await saveBlock(page)
    // A top-level paragraph renders its inline content directly in the static
    // view (no <p> wrapper — the RichContentRenderer emits a bare <span>), so
    // we assert the heading tags are gone AND no structural wrapper remains,
    // with the text preserved on the plain block.
    await expect(firstStatic(page).locator('h1')).toHaveCount(0)
    await expect(firstStatic(page).locator('blockquote, ol, pre')).toHaveCount(0)
    await expect(firstStatic(page)).toContainText('heading then text')

    await reopenPage(page, 'Getting Started')
    await expect(firstStatic(page).locator('h1')).toHaveCount(0)
    await expect(firstStatic(page).locator('blockquote, ol, pre')).toHaveCount(0)
    await expect(firstStatic(page)).toContainText('heading then text')
  })
})
