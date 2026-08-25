/**
 * E2E — mobile/touch editor coverage (#916).
 *
 * The UX review found that NONE of the e2e specs exercise the editor on a
 * mobile/touch viewport — the only mobile specs test Search. This spec proves
 * the core note-taking surface works on an iPhone 13 viewport with touch
 * enabled: tap-to-focus, typing commits, Enter creates a block, and arrow
 * navigation moves focus across blocks. It drives the default boot (Journal)
 * view, whose seeded day already has editable blocks.
 *
 * Scope note: precise caret control via key chords (Ctrl+A select-all, End)
 * does NOT behave identically under Playwright's touch/mobile emulation, so
 * these tests deliberately avoid asserting exact split text (that is covered on
 * desktop by block-keyboard-fundamentals.spec.ts) and instead assert the
 * mobile-reachable contract: typing lands, a block is created, focus moves.
 */

import { devices } from '@playwright/test'

import {
  clearInvokeCalls,
  expect,
  focusBlock,
  getInvokeCalls,
  installIpcRecorder,
  test,
  waitForBoot,
} from './helpers'

const iPhone13 = devices['iPhone 13']

type Page = import('@playwright/test').Page

async function liveEditorBlockId(page: Page): Promise<string | null> {
  return page.locator('[data-testid="block-editor"]').first().getAttribute('data-block-id')
}

/**
 * Empty the focused block WITHOUT a modifier chord.
 *
 * The scope note at the top of this file applies: `Control+A` / `End` do not
 * behave dependably under Playwright's touch/mobile emulation, so a test that
 * leaned on one to clear the block could fail for a reason that has nothing to
 * do with what it asserts — and the ` ```␣ ` input rule below only fires at the
 * start of an EMPTY textblock, so a silently no-op'd chord looks exactly like a
 * broken editor. `focusBlock` leaves the caret at the end of the block's text,
 * so plain Backspaces walk it back to empty. Self-verifying: it re-reads the
 * text every iteration and stops the moment the block is empty (never pressing
 * Backspace into an empty block, which is a block-level delete/outdent).
 */
async function clearFocusedBlock(page: Page): Promise<void> {
  const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
  for (let i = 0; i < 300; i++) {
    if (((await editor.textContent()) ?? '') === '') return
    await page.keyboard.press('Backspace')
  }
  throw new Error('focused block did not empty after 300 Backspaces')
}

/**
 * Turn the focused block into a code block with `language` via the typed fence
 * input rule (no toolbar, no popover — the shortest path, so a failure is
 * unambiguously the editor). Pass `''` for a language-less block.
 *
 * Types through `page.keyboard` rather than a locator so the caret the clear
 * above left behind is not disturbed by a re-focus.
 */
async function typeCodeFence(page: Page, language: string): Promise<void> {
  await clearFocusedBlock(page)
  await page.keyboard.type(`\`\`\`${language}`)
  await page.keyboard.press('Space')
}

/**
 * Re-pick the focused CODE BLOCK's language through the toolbar's "Turn into"
 * popover. The block must already be a code block: `TurnIntoMenu` then opens
 * with `CodeLanguageSelector` already expanded (#3001), so this is a single
 * interaction and never has to hit the "Code block" disclosure row.
 *
 * `updateAttributes('codeBlock', …)` — which is what every row below runs — keeps
 * the SAME node type, so this is the exact attribute-only transition that a
 * node view's `update()` has to refuse when it changes which node view the
 * block needs. Pass `''` for the language-clearing "Plain text" row.
 */
async function pickCodeLanguage(page: Page, language: string): Promise<void> {
  const toolbar = page.getByTestId('formatting-toolbar')
  await expect(toolbar).toBeVisible()
  const filter = page.getByRole('textbox', { name: 'Code block language' })

  // Retry the OPEN, not the pick: the popover's own dismissable layer can eat a
  // pointerdown that lands while a previous pick is still closing it, leaving
  // the trigger toggled back shut. "Turn into" is high-priority (94) so it
  // normally survives the narrow viewport's overflow collapse; fall back to the
  // "More" popover if a future layout change pushes it in there.
  // A pick is not finished until the picker has UNMOUNTED. `applyLanguage`
  // dispatches the transaction and only then calls `onClose()`, so the popover
  // outlives the pick by however long React takes to commit the close (~75-100ms
  // under load). Without this wait the `isVisible()` check below sees the dying
  // picker, skips the open-click, and drives the one that is going away — which
  // is the flake fixed in the mermaid spec. Latent here, since this helper's only
  // caller is preceded by a fence that opens no popover; it stops being latent
  // the moment a second pick is added.
  await expect(filter).toHaveCount(0)

  await expect(async () => {
    if (!(await filter.isVisible())) {
      const inlineTrigger = toolbar.getByRole('button', { name: 'Turn into', exact: true })
      if (await inlineTrigger.isVisible()) {
        await inlineTrigger.click()
      } else {
        await toolbar.getByRole('button', { name: 'More' }).click()
        await page
          .getByTestId('toolbar-overflow-menu')
          .getByRole('button', { name: 'Turn into', exact: true })
          .click()
      }
    }
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

/** The plain DOM node view — a bare `<pre><code>`, no React wrapper around it. */
function plainCodeView(page: Page) {
  return page.locator('[data-testid="block-editor"] pre > code')
}

/** The React node view's wrapper element (`NodeViewWrapper`). */
function reactNodeViewWrapper(page: Page) {
  return page.locator('[data-testid="block-editor"] [data-node-view-wrapper]')
}

test.describe('Mobile editor (iPhone 13 viewport)', () => {
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
    await expect(page.locator('[data-testid="block-static"]').first()).toBeVisible()
  })

  test('tapping a block focuses it and typing commits the text', async ({ page }) => {
    const editor = await focusBlock(page, 0)
    const before = (await editor.textContent()) ?? ''

    await editor.pressSequentially('ZZZ')

    // The typed text is now present in the contenteditable (ProseMirror committed it).
    await expect.poll(async () => (await editor.textContent()) ?? '').toContain('ZZZ')
    expect(before).not.toContain('ZZZ')
  })

  test('Enter creates a new block on a touch viewport', async ({ page }) => {
    const editor = await focusBlock(page, 0)
    await editor.pressSequentially('note')
    await clearInvokeCalls(page)
    await editor.press('Enter')

    // A new block is created (the create_block IPC fires) — the core
    // outline-building gesture works on mobile.
    await expect
      .poll(async () => (await getInvokeCalls(page, 'create_block')).length)
      .toBeGreaterThan(0)
  })

  test('ArrowDown at the end of a block moves focus to another block', async ({ page }) => {
    const editor = await focusBlock(page, 0)
    const startId = await liveEditorBlockId(page)
    await editor.press('ArrowDown')

    await expect.poll(async () => liveEditorBlockId(page)).not.toBe(startId)
  })

  /**
   * Regression: a code block used to freeze the editor PERMANENTLY on mobile.
   *
   * `CodeBlockWithShortcut` rendered every language through a React node view.
   * A React node view rewrites its own subtree on re-render; prosemirror-view
   * recorded those mutations and flushed, the flush re-rendered the node view,
   * and the cycle never terminated. The UA gate is @tiptap/core's default
   * `NodeView.ignoreMutation`: on iOS/Android with the editor focused it does
   * NOT ignore a childList mutation anywhere inside the node view's `dom` as
   * long as every changed node is contentEditable, so React's own writes are
   * read back as user edits. Desktop skips that branch and ignores everything
   * outside `contentDOM` — it created the same block in ~80 ms. (#4315 located
   * this; the earlier reading, which blamed `browser.android`/`browser.ios`
   * selection paths inside prosemirror-view, was wrong.)
   *
   * The block never appeared and the whole app stopped responding (still dead
   * after three minutes), so this asserts the `<pre>` actually materialises.
   * Runs on the mobile user-agent above, which is what gates the bug — a small
   * viewport or touch alone does NOT reproduce it.
   */
  test('a code block renders instead of freezing the editor', async ({ page }) => {
    const editor = await focusBlock(page, 0)

    // The ```␣ input rule is the shortest path to a code block and involves no
    // toolbar or popover, so a failure here is unambiguously the editor.
    await typeCodeFence(page, '')

    await expect(page.locator('[data-testid="block-editor"] pre')).toBeVisible()

    // The editor must still accept input — a frozen main thread swallows this.
    await editor.pressSequentially('ok')
    await expect.poll(async () => (await editor.textContent()) ?? '').toContain('ok')
  })

  /**
   * The other half of the seam the freeze above lives on (#4312 review).
   *
   * Changing a code block's language is an ATTRIBUTE-only edit
   * (`updateAttributes('codeBlock', …)` — see `CodeLanguageSelector`): the node
   * TYPE is identical on both sides, so neither node view's default `update()`
   * refuses it. The plain DOM view has to keep handling every non-mermaid
   * language itself and must NEVER let a React node view take the block over on
   * this user agent — a React node view rewriting its contentDOM is what feeds
   * prosemirror-view's DOMObserver into the flush loop that froze the app.
   *
   * Runs on the mobile user agent this describe block configures, which is what
   * gates the freeze; the same assertions on a desktop UA pass against the bug.
   * (The mermaid⇄non-mermaid halves of the same swap are covered on the desktop
   * UA by `mermaid-roundtrip.spec.ts`, where node-view identity is not UA-gated;
   * that mermaid's own React node view survives THIS UA is asserted below.)
   */
  test('changing a code block language keeps the plain node view and stays responsive', async ({
    page,
  }) => {
    const editor = await focusBlock(page, 0)
    await typeCodeFence(page, 'javascript')

    await expect(page.locator('[data-testid="block-editor"] pre')).toBeVisible()
    await expect(plainCodeView(page)).toHaveClass('language-javascript')
    await expect(reactNodeViewWrapper(page)).toHaveCount(0)

    // "Plain text" clears the language attribute. `renderHTML` emits NO class
    // attribute for a language-less block (it passes `class: null`), so the node
    // view must remove the attribute rather than blank it out — otherwise the
    // live DOM is `<code class="">` where a re-parse produces `<code>`.
    await pickCodeLanguage(page, '')
    await expect(plainCodeView(page)).not.toHaveAttribute('class')
    await expect(reactNodeViewWrapper(page)).toHaveCount(0)

    // The editor must still accept input — a frozen main thread swallows this.
    await editor.pressSequentially('const ok = 1')
    await expect.poll(async () => (await editor.textContent()) ?? '').toContain('const ok = 1')
  })

  /**
   * The half of the freeze seam #4312 did NOT change (#4315).
   *
   * `language === 'mermaid'` still mounts `MermaidCodeBlockView` through
   * `ReactNodeViewRenderer` — a React node view, on the exact user agent that
   * gates the freeze. That is the configuration the test above exists to keep
   * every other language out of, so "mermaid is fine" cannot be assumed: it has
   * to be measured on this UA, with the caret INSIDE the block and text landing
   * on every keystroke (which is what makes React re-render the node view while
   * prosemirror-view's DOMObserver is live).
   *
   * Typing into a mermaid block is the maximal version of that stress: each
   * keystroke changes `node.textContent`, which re-keys `<MermaidDiagram>` and
   * so rewrites a whole subtree of the node view, not just its attributes.
   */
  test('a mermaid code block renders and stays responsive on the mobile user agent', async ({
    page,
  }) => {
    const editor = await focusBlock(page, 0)

    // ```mermaid␣ — the same input rule as the plain-fence test above, so this
    // differs from it in exactly one thing: the language.
    await typeCodeFence(page, 'mermaid')

    // The React node view is the point: mermaid is the ONE language that still
    // gets one, so a count of 0 here would mean this test is not exercising the
    // configuration #4315 asks about.
    await expect(page.getByTestId('mermaid-node-view')).toBeVisible()
    await expect(reactNodeViewWrapper(page)).not.toHaveCount(0)

    // Selection is inside the node, so the view has flipped itself to source
    // mode (Finding 45) and the editable `NodeViewContent` is on screen.
    await expect(page.locator('[data-testid="block-editor"] pre.mermaid-source')).toBeVisible()

    // The editor must still accept input — a frozen main thread swallows this,
    // and every one of these keystrokes re-renders the React node view.
    await editor.pressSequentially('graph TD')
    await expect.poll(async () => (await editor.textContent()) ?? '').toContain('graph TD')

    // …and it must still be alive AFTER the diagram has had a chance to render
    // off the new source (the re-key remounts `MermaidDiagram` asynchronously,
    // so a loop it feeds would only bite on a later keystroke).
    await editor.pressSequentially(';A-->B')
    await expect.poll(async () => (await editor.textContent()) ?? '').toContain(';A-->B')
  })
})
