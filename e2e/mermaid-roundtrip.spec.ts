/**
 * E2E for #1438 — Mermaid diagram support.
 *
 * A code block with language `mermaid` (the editor representation of a
 * ```mermaid fence) must:
 *   1. render a diagram (SVG) in the editor's React node view (not raw text);
 *   2. expose a raw-source toggle that swaps between the rendered diagram and
 *      the editable Mermaid source;
 *   3. round-trip — after saving (blur) the at-rest static render shows the
 *      diagram too (the static path uses the same code-block representation
 *      that serializes to a ```mermaid fence).
 *
 * Node views need real-browser verification (mermaid renders SVG async via the
 * real mermaid.js), hence an e2e rather than only a unit test.
 *
 * The block's mermaid language is set through the toolbar's code-block language
 * picker ("Use «mermaid»" custom-language row) — the typed-fence input rule is
 * not how the roving editor authors code blocks.
 */
import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { focusBlock, openPage, waitForBoot } from './helpers'

/** The plain DOM node view — a bare `<pre><code>`, no React wrapper around it. */
function plainCodeView(page: Page) {
  return page.locator('[data-testid="block-editor"] pre > code')
}

/**
 * Any React node view mounted inside the live editor. `NodeViewWrapper` and the
 * `ReactNodeView`'s own content host both carry this attribute; the plain DOM
 * node view has no React renderer at all, so a count of 0 means "this block is
 * NOT rendering through React".
 */
function reactNodeView(page: Page) {
  return page.locator('[data-testid="block-editor"] [data-node-view-wrapper]')
}

/**
 * Re-pick the focused CODE BLOCK's language through Turn into → Code block.
 * The block must already BE a code block, so `TurnIntoMenu` opens with
 * `CodeLanguageSelector` already expanded (#3001) and this is one interaction.
 *
 * Every row this can hit runs `updateAttributes('codeBlock', …)`, which keeps the
 * SAME node type — the attribute-only transition the node views have to police
 * themselves. Pass `''` for the language-clearing "Plain text" row.
 */
async function pickCodeLanguage(page: Page, language: string): Promise<void> {
  const trigger = page
    .locator('[data-testid="block-editor"]')
    .getByRole('button', { name: 'Turn into', exact: true })
  const filter = page.getByRole('textbox', { name: 'Code block language' })

  // Wait for any PREVIOUS picker to actually unmount before opening one.
  //
  // Picking a language runs `applyLanguage`, which dispatches the ProseMirror
  // transaction *and then* calls `onClose()` — so the popover is still mounted
  // while React commits the close. Measured on a throttled desktop run, that
  // window is ~75-100ms, and it widens with machine load.
  //
  // Without this wait the visibility check below is satisfied by the DYING
  // picker: the helper skips the open-click, and the leftover input unmounts
  // mid-`fill()` ("element was detached from the DOM, retrying" — then the
  // locator never re-resolves, because nobody re-opened the picker, and the
  // fill burns its full timeout). When the fill *does* land first, `Enter`
  // applies nothing, `toHaveCount(0)` below passes trivially on the unmount
  // that was already coming, and the caller's next assertion sees no language
  // change at all. Both shapes were observed on CI (#4314's `playwright (2)`)
  // and reproduced locally under `Emulation.setCPUThrottlingRate`.
  //
  // Raising a timeout cannot fix either shape — the wait is for an element
  // that is never coming back. The real signal is "no picker on screen", so
  // wait for that, then open a fresh one.
  await expect(filter).toHaveCount(0)

  // Retry the OPEN, not the pick: the popover's own dismissable layer can eat a
  // pointerdown that lands while a previous pick is still closing it, leaving
  // the trigger toggled back shut. Re-tapping until the picker is actually up
  // keeps that Radix race out of the assertions below.
  await expect(async () => {
    if (!(await filter.isVisible())) await trigger.click()
    await expect(filter).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })

  if (language === '') {
    // "Plain text" clears the language attr; it is a row of its own rather than
    // a filter match, so it is picked directly (and the picker is freshly open
    // here, so the row is settled).
    await page.getByRole('button', { name: 'Plain text', exact: true }).click()
  } else {
    await filter.fill(language)
    // Enter applies the highlighted row — index 0, which is the built-in match
    // when there is one and the "Use «typed»" custom-language row otherwise.
    // Keyboard rather than a click: a REOPENED Radix popover is still settling
    // into position, and Playwright refuses to click a moving target.
    await filter.press('Enter')
  }

  await expect(filter).toHaveCount(0)
}

test.describe('Mermaid diagram round-trip (#1438)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('renders a diagram in the editor node view, toggles source, and round-trips', async ({
    page,
  }) => {
    const editor = await focusBlock(page)
    // Author the Mermaid source, then turn the block into a mermaid code block.
    // #3001 — Turn into → Code block is a single-step disclosure: opening it
    // expands the language picker in place, so the block is turned into a code
    // block AND given the `mermaid` language in one interaction (custom-language
    // path, since mermaid is not a built-in language).
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await editor.pressSequentially('graph TD; A-->B;')

    const blockEditor = page.locator('[data-testid="block-editor"]')
    await blockEditor.getByRole('button', { name: 'Turn into', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Code block', exact: true }).click()
    const langInput = page.getByRole('textbox', { name: 'Code block language' })
    await expect(langInput).toBeVisible()
    await langInput.fill('mermaid')
    await page.getByTestId('use-custom-language').click()
    // Same contract the helper below enforces: a pick is not done until the
    // picker has unmounted. Nothing in this test picks again, so it is a
    // consistency guard rather than a live fix — but a direct pick that does
    // not honour the rule is how the flake reached the other test.
    await expect(langInput).toHaveCount(0)

    // #2449 (audit finding 45): with the caret INSIDE the block, the node
    // view opens in SOURCE mode — keystrokes must land in visible text, never
    // in a display:none <pre> behind the rendered diagram. The old behavior
    // (diagram shown while editing) was exactly the invisible-typing hazard.
    const nodeView = page.locator('[data-testid="mermaid-node-view"]')
    await expect(nodeView).toBeVisible()
    const toggle = nodeView.getByTestId('mermaid-toggle-source')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(nodeView.getByTestId('mermaid-rendered')).toBeHidden()
    await expect(nodeView.locator('pre.mermaid-source')).toBeVisible()
    await expect(nodeView.locator('pre.mermaid-source')).toContainText('graph TD')

    // Manually toggling back shows the rendered diagram even while the caret
    // stays inside (the selection flip is transition-triggered, so the user's
    // explicit choice sticks until the selection re-enters the node).
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(nodeView.locator('[data-testid="mermaid-diagram"] svg')).toBeVisible({
      timeout: 10_000,
    })

    // And toggling to source again still carries the editable text.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(nodeView.locator('pre.mermaid-source')).toBeVisible()
    await expect(nodeView.locator('pre.mermaid-source')).toContainText('graph TD')
    // Leave the node view in diagram mode before the blur/round-trip leg.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

    // Commit by moving focus to another block (the natural blur+flush path —
    // Enter inside a code block inserts a newline rather than saving). The
    // mermaid block serializes to a ```mermaid fence and its at-rest static
    // render shows the diagram, proving the round-trip is lossless.
    await page.locator('[data-testid="block-static"]').nth(2).click()
    const staticDiagram = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="mermaid-diagram"] svg')
    await expect(staticDiagram).toBeVisible({ timeout: 10_000 })
  })

  /**
   * The mermaid boundary is a NODE VIEW SWAP, and both directions have to be
   * refused by the node view being left behind (#4312 review).
   *
   * Only `language === 'mermaid'` may render through a React node view; every
   * other language renders through `CodeBlockWithShortcut`'s plain DOM one,
   * because a React node view rewrites its contentDOM on re-render and
   * prosemirror-view's DOMObserver turns that into a flush loop that froze the
   * whole app on mobile (see `mobile-editor.spec.ts`). Switching the language is
   * an ATTRIBUTE-only edit — the node TYPE is identical on both sides — so
   * neither view's default `update()` refuses it: each must detect the mermaid
   * boundary itself and return `false` so ProseMirror rebuilds the other one.
   *
   * mermaid → non-mermaid is the dangerous direction: a surviving React node
   * view re-renders into `MermaidCodeBlockView`'s non-mermaid branch
   * (`NodeViewWrapper > pre > NodeViewContent`), which is precisely the
   * configuration the mobile freeze was made of.
   *
   * These run on the DESKTOP user agent (this file's default). The freeze itself
   * is UA-gated, but the node-view identity asserted here is not, so asserting
   * it once on desktop covers both. That the mermaid React node view SURVIVES
   * the mobile UA — it did not, until #4315 gave it an `ignoreMutation` — is a
   * separate assertion, made where the gate lives: `mobile-editor.spec.ts`.
   */
  test('switching a code block to mermaid and back swaps the node view each way', async ({
    page,
  }) => {
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')

    // Turn into → Code block → javascript: starts on the plain DOM node view.
    await page
      .locator('[data-testid="block-editor"]')
      .getByRole('button', { name: 'Turn into', exact: true })
      .click()
    await page.getByRole('menuitem', { name: 'Code block', exact: true }).click()
    const langInput = page.getByRole('textbox', { name: 'Code block language' })
    await expect(langInput).toBeVisible()
    await langInput.fill('javascript')
    await page.getByRole('button', { name: 'javascript', exact: true }).click()
    // This pick is made directly rather than through `pickCodeLanguage`, so it
    // has to honour the same contract the helper ends on: the picker is not
    // done until it has unmounted. Leaving it half-closed is what handed the
    // next `pickCodeLanguage` a dying input to type into.
    await expect(langInput).toHaveCount(0)

    await expect(page.locator('[data-testid="block-editor"] pre')).toBeVisible()
    await expect(plainCodeView(page)).toHaveClass('language-javascript')
    await expect(reactNodeView(page)).toHaveCount(0)
    await expect(page.getByTestId('mermaid-node-view')).toHaveCount(0)

    // javascript → mermaid: the plain view refuses the update and ProseMirror
    // rebuilds the block as the React one.
    await pickCodeLanguage(page, 'mermaid')
    await expect(page.getByTestId('mermaid-node-view')).toBeVisible()

    // …and the editor still takes input (a wedged main thread would not).
    await editor.pressSequentially('graph TD')
    await expect.poll(async () => (await editor.textContent()) ?? '').toContain('graph TD')

    // mermaid → javascript: the REACT view must refuse it symmetrically. Without
    // that guard the React node view survives the attribute-only change and
    // re-renders into the non-mermaid branch — a React node view wrapped around
    // a <pre><code>, i.e. the freeze configuration — so `reactNodeView` stays
    // mounted and this is the assertion that goes red.
    await pickCodeLanguage(page, 'javascript')
    await expect(page.getByTestId('mermaid-node-view')).toHaveCount(0)
    await expect(reactNodeView(page)).toHaveCount(0)
    await expect(page.locator('[data-testid="block-editor"] pre')).toBeVisible()
    await expect(plainCodeView(page)).toHaveClass('language-javascript')

    await editor.pressSequentially('; const ok = 1')
    await expect.poll(async () => (await editor.textContent()) ?? '').toContain('const ok = 1')
  })
})
