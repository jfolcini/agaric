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
  blurEditors,
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

/**
 * Assert that BOTH conditions gating the freeze hold *right now* (#4353).
 *
 * A node view test that never actually met these would pass for the same reason
 * a node view that never mounted would: vacuously. tiptap's default
 * `NodeView.ignoreMutation` only reaches its dangerous branch when
 * `(isiOS() || isAndroid()) && this.editor.isFocused`, so a spec claiming "this
 * node view does not freeze on mobile" has to show both were true while the node
 * view was on screen.
 *
 * The two predicates are transcribed from `@tiptap/core`'s `isiOS.ts` /
 * `isAndroid.ts` (3.30.2) — they cannot be imported into `page.evaluate`. The
 * transcription is not the only evidence the gate is armed: the mermaid test at
 * the bottom of this file goes RED under this same `test.use()` block when its
 * `ignoreMutation` override is removed, which is a live demonstration that the
 * branch really does fire on this user agent.
 *
 * `editor.isFocused` is `view.hasFocus()`, i.e. the ProseMirror contenteditable
 * owns the document's active element — which is what is checked here.
 */
async function expectMobileFreezeConditions(page: Page): Promise<void> {
  const gate = await page.evaluate(() => {
    const isAndroid =
      ['Android'].includes(navigator.platform) || /android/i.test(navigator.userAgent)
    const isiOS =
      ['iPad Simulator', 'iPhone Simulator', 'iPod Simulator', 'iPad', 'iPhone', 'iPod'].includes(
        navigator.platform,
      ) ||
      (navigator.userAgent.includes('Mac') && 'ontouchend' in document)
    const active = document.activeElement
    const editorFocused =
      active instanceof HTMLElement &&
      active.isContentEditable &&
      active.closest('[data-testid="block-editor"]') !== null
    return { isAndroid, isiOS, editorFocused, userAgent: navigator.userAgent }
  })

  expect(gate.isiOS || gate.isAndroid, `UA did not read as mobile: ${gate.userAgent}`).toBe(true)
  expect(gate.editorFocused, 'the ProseMirror contenteditable did not hold focus').toBe(true)
}

/**
 * The React content host tiptap creates for a NON-leaf node view
 * (`ReactNodeView`'s `contentDOMElement`), scoped to `nodeView`.
 *
 * Its absence is the browser-observable form of the reason a leaf node view is
 * safe: `@tiptap/react` builds no `contentDOMElement` when `node.isLeaf`, its
 * `contentDOM` getter returns `null`, and tiptap's default `ignoreMutation`
 * answers "ignore" on its first line — above both the `options.ignoreMutation`
 * consultation and the mobile branch. Asserting count 0 here is what makes
 * "image/math did not freeze" a structural claim rather than a lucky run.
 */
function reactContentHost(nodeView: ReturnType<Page['locator']>) {
  return nodeView.locator('[data-node-view-content-react]')
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

    // #4353 — the discriminator, asserted positively here and negatively in the
    // image/math tests below: `codeBlock` is NOT a leaf, so tiptap DOES build a
    // React content host for it, its `contentDOM` is non-null, and its
    // `ignoreMutation` option is therefore consulted. This is the one node view
    // in the app that reaches the mobile branch — the reason it needs the
    // override, and the reason the leaf node views do not.
    await expect(reactContentHost(page.getByTestId('mermaid-node-view'))).not.toHaveCount(0)
    await expectMobileFreezeConditions(page)

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

  /**
   * #4353 — the other React node views, measured rather than assumed.
   *
   * #4353's premise is that the code block was simply the one that got reported
   * and that every React node view mounting on a mobile UA while the editor is
   * focused meets the same condition. Measured against `@tiptap/core@3.30.2`,
   * that premise is too broad: the snippet the issue quotes is `MarkView`'s copy
   * of `ignoreMutation`. `NodeView`'s — the one React node views actually run —
   * refuses the branch twice before reaching it, for a node view whose
   * `contentDOM` is null and again for a node that `isLeaf || isAtom`. `image`,
   * `math_inline` and `math_block` are leaf atoms, so both guards fire.
   *
   * These three tests are what turns that reading of a vendored file into
   * evidence. Each one mounts the node view on the mobile UA with the caret in
   * the editor, asserts BOTH gate conditions were actually in force at that
   * moment (`expectMobileFreezeConditions` — otherwise "it didn't freeze" is
   * indistinguishable from "it was never exercised"), asserts the node view
   * really painted (a React node view that never mounts also never freezes —
   * that is exactly how mermaid failed on mobile before #4315), asserts the
   * structural reason it is safe (no React content host ⇒ `contentDOM === null`),
   * and then proves the app is still alive.
   *
   * `node-view-mobile-freeze.test.ts` pins the same chain from the other side,
   * against the real `NodeView.prototype`, so a `@tiptap/core` bump that drops
   * either guard fails there rather than waiting for a mobile user to find it.
   */
  test('an image node view renders and stays responsive on the mobile user agent', async ({
    page,
  }) => {
    const editor = await focusBlock(page, 0)
    await clearFocusedBlock(page)

    // `![alt](url)` — the image input rule fires on the closing `)`.
    // `/favicon.svg` is same-origin so the <img> actually loads and the real
    // element stays mounted (see image-node.spec.ts for why not an external URL).
    await page.keyboard.type('pic ![a cat](/favicon.svg)')

    const nodeView = page.getByTestId('image-node-view')
    await expect(nodeView).toBeVisible()
    await expect(reactNodeViewWrapper(page)).not.toHaveCount(0)
    // The <img> is what `GatedImage` mounts once the src passes the policy —
    // i.e. the React subtree inside the node view really rendered, on this UA,
    // rather than the node view existing as an empty shell.
    await expect(nodeView.locator('img[alt="a cat"]')).toBeAttached()

    await expectMobileFreezeConditions(page)
    // Leaf ⇒ no content host ⇒ contentDOM is null ⇒ tiptap ignores every
    // mutation before the mobile branch. This is WHY it does not freeze.
    await expect(reactContentHost(nodeView)).toHaveCount(0)

    // The editor must still accept input — a frozen main thread swallows this.
    await page.keyboard.type(' done')
    await expect.poll(async () => (await editor.textContent()) ?? '').toContain('done')
    await expect(nodeView).toBeVisible()
  })

  test('an inline math node view renders and stays responsive on the mobile user agent', async ({
    page,
  }) => {
    const editor = await focusBlock(page, 0)
    await clearFocusedBlock(page)

    // `$…$` — the inline-math input rule fires on the closing `$`.
    await page.keyboard.type('e $x^2$')

    const nodeView = page.getByTestId('math-inline-node-view')
    await expect(nodeView).toBeVisible()
    await expect(reactNodeViewWrapper(page)).not.toHaveCount(0)
    // KaTeX is lazy (React.lazy + Suspense), so `.katex` appearing proves the
    // node view swapped its own subtree AFTER mount, while the editor was
    // focused on a mobile UA — the exact React write the mobile branch would
    // have read back as a user edit.
    await expect(nodeView.locator('.katex').first()).toBeVisible({ timeout: 10_000 })

    await expectMobileFreezeConditions(page)
    await expect(reactContentHost(nodeView)).toHaveCount(0)

    // The caret sits after the atom in the same paragraph, so the editor must
    // still take text.
    await page.keyboard.type(' ok')
    await expect.poll(async () => (await editor.textContent()) ?? '').toContain('ok')
    await expect(nodeView).toBeVisible()
  })

  test('a block math node view renders and stays responsive on the mobile user agent', async ({
    page,
  }) => {
    await focusBlock(page, 0)
    await clearFocusedBlock(page)

    // `$$ … $$` as the WHOLE textblock — the block-math rule is `^`-anchored.
    // The spaces matter: `$$E=mc^2$$` would trip the INLINE rule on the
    // second-to-last `$` (its group may not start with a space), producing a
    // math_inline atom instead.
    await page.keyboard.type('$$ E = mc^2 $$')

    const nodeView = page.getByTestId('math-block-node-view')
    await expect(nodeView).toBeVisible()
    await expect(reactNodeViewWrapper(page)).not.toHaveCount(0)
    await expect(nodeView.locator('.katex').first()).toBeVisible({ timeout: 10_000 })

    await expectMobileFreezeConditions(page)
    await expect(reactContentHost(nodeView)).toHaveCount(0)

    // The block-math rule replaces the whole paragraph with the atom, so there
    // is no text hole left to type into — the liveness probe moves to another
    // block instead. A frozen main thread fails at the very first step.
    await blurEditors(page)
    const other = await focusBlock(page, 1)
    await other.pressSequentially('alive')
    await expect.poll(async () => (await other.textContent()) ?? '').toContain('alive')
  })
})
