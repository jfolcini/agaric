import {
  expect,
  focusBlock,
  openPage,
  reopenPage,
  saveBlock,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E for the selection BubbleMenu mark toggles that persist formatting
 * (#1170 acceptance criterion #5).
 *
 * `selection-bubble.spec.ts` proved the drag-select → click-Bold flow end to
 * end, but ONLY for Bold, and it verified the mark only in the immediate
 * static render (no reload / re-fetch). The remaining bubble mark toggles —
 * Italic, Inline code, Strikethrough, Highlight, Underline — had ZERO
 * bubble-click coverage: `toolbar-and-blocks.spec.ts` exercises Italic/Code
 * via the always-visible FormattingToolbar button (a different surface) and
 * Bold via the Ctrl+B shortcut, while Strikethrough and Underline had no e2e
 * path at all.
 *
 * Each test here, for one mark:
 *   1. focuses a block, clears it, and types fresh content,
 *   2. selects a word and clicks the mark's button INSIDE the bubble menu
 *      (`[data-testid="selection-bubble-menu"]`) — not a keyboard shortcut and
 *      not the standing toolbar,
 *   3. asserts the mark applied in the LIVE editor (rendered tag),
 *   4. saves the block (Enter) and asserts the tag in the immediate static
 *      render, then
 *   5. REOPENS the page (navigate to Status and back via `reopenPage`, which
 *      forces `BlockTree` to re-fetch the saved block from the Tauri mock
 *      backend) and asserts the tag survives — proving the mark persisted
 *      through save + reopen, not just a transient editor decoration.
 *
 * Assertions are on the RENDERED DOM (tag names), never on TipTap/@tiptap/pm
 * internals: `instanceof` across the bundle's multiple `@tiptap/pm` module
 * copies is a known footgun (#924), and the static render maps each mark to a
 * fixed tag (src/components/RichContentRenderer/marks/text.tsx):
 *   bold → <strong>, italic → <em>, code → <code>, strike → <s>,
 *   highlight → <mark>, underline → <u>.
 *
 * Underline + Strikethrough are the priority (acceptance #5); the other marks
 * round out full bubble-click → persists-through-reopen coverage.
 */

/** The first block's static render container, post-save. */
function firstStaticBlock(page: import('@playwright/test').Page) {
  return page
    .locator('[data-testid="sortable-block"]')
    .first()
    .locator('[data-testid="block-static"]')
}

interface MarkCase {
  /** Human label for the test title. */
  name: string
  /** Accessible name of the bubble button (t(toolbar.<key>) — see i18n/toolbar.ts). */
  button: string
  /** Whether getByRole needs exact matching (e.g. "Inline code" vs other "code"). */
  exact?: boolean
  /** Rendered tag the mark maps to in both the live editor and the static render. */
  tag: string
}

/**
 * One row per bubble mark toggle (the order createMarkToggles emits them in,
 * src/lib/toolbar-config.ts). Bold is included for parity with the reference
 * pattern even though selection-bubble.spec.ts already covers its click; the
 * value add here is the reopen step.
 */
const MARK_CASES: MarkCase[] = [
  { name: 'Bold', button: 'Bold', tag: 'strong' },
  { name: 'Italic', button: 'Italic', tag: 'em' },
  // "Inline code" must be exact — a non-exact "code" substring also matches
  // the "Code block language" button on the standing toolbar.
  { name: 'Inline code', button: 'Inline code', exact: true, tag: 'code' },
  { name: 'Strikethrough', button: 'Strikethrough', tag: 's' },
  { name: 'Highlight', button: 'Highlight', tag: 'mark' },
  { name: 'Underline', button: 'Underline', tag: 'u' },
]

test.describe('Selection bubble menu — mark toggles persist through reopen (#1170 #5)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  for (const mark of MARK_CASES) {
    test(`${mark.name}: bubble-click applies <${mark.tag}>, survives save + reopen`, async ({
      page,
    }) => {
      const editor = await focusBlock(page)

      // Clear and type fresh, deterministic content: "the <word> here". We mark
      // the MIDDLE word so the rendered tag wraps exactly that word. A leading
      // prefix ("the ") is load-bearing: it shifts the selection rect — and so
      // the floating bubble — rightward, away from the block's left edge. With
      // the marked word at offset 0 the bubble lands over the block's right-
      // side hover action column (`w-[68px] … justify-end`), which intercepts
      // the pointer and the click never reaches the toggle (mirrors the
      // reference spec's "hello world" → select "world", never char 0).
      const word = mark.name.toLowerCase().replace(/\s+/g, '')
      const prefix = 'the '
      await page.keyboard.press('Control+a')
      await page.keyboard.type(`${prefix}${word} here`)

      // Select the middle word (chars prefix.length .. prefix.length+word.length).
      await selectEditorRange(page, prefix.length, prefix.length + word.length)

      // The bubble menu shows over a non-empty TEXT selection.
      const bubble = page.locator('[data-testid="selection-bubble-menu"]')
      await expect(bubble).toBeVisible({ timeout: 5000 })

      // Click the mark toggle INSIDE the bubble — the load-bearing distinction
      // from the toolbar-and-blocks.spec.ts coverage, which clicks the
      // always-visible FormattingToolbar / uses keyboard shortcuts.
      await bubble.getByRole('button', { name: mark.button, exact: mark.exact }).click()

      // The selected word now carries the mark in the LIVE editor.
      const liveMark = editor.locator(mark.tag)
      await expect(liveMark).toBeVisible()
      await expect(liveMark).toHaveText(word)

      // Re-focus the editor before Enter: the bubble button click landed
      // outside the contenteditable, so the save keystroke must re-target the
      // editor (the reference Bold test does the same).
      await editor.click()
      await saveBlock(page)

      // The mark survives into the IMMEDIATE static render.
      await expect(firstStaticBlock(page).locator(mark.tag)).toHaveText(word)

      // …and survives a full reopen: `reopenPage` navigates to Status and back,
      // forcing BlockTree to re-fetch the saved block from the Tauri mock
      // backend — so this asserts true persistence, not a stale in-memory DOM.
      await reopenPage(page, 'Getting Started')
      await expect(firstStaticBlock(page).locator(mark.tag)).toHaveText(word)
    })
  }
})
