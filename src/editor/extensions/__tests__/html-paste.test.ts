/**
 * Tests for the async HTML-paste insertion path (#2033).
 *
 * `convertAndInsert` runs AFTER the handler synchronously claims the paste, via
 * a dynamic `import()` + DOM walk. By the time it resolves the single-block
 * roving editor view may have been destroyed (blur / navigation / Android
 * suspend), and the focused block may have changed. These tests lock down two
 * guards:
 *   (a) a destroyed view is never dispatched against (no throw, no dispatch);
 *   (b) multi-block content threads the paste-time `targetBlockId` so the
 *       receiver can reject a paste whose focus has since moved.
 */

import type { EditorView } from '@tiptap/pm/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

const dispatchBlockEvent = vi.fn()

vi.mock('@/lib/block-events', () => ({
  dispatchBlockEvent: (...args: unknown[]) => dispatchBlockEvent(...args),
}))

// The currently-focused block id is read at runtime from the global block store
// (`useBlockStore.getState().focusedBlockId`) — the same source convertAndInsert
// samples SYNCHRONOUSLY at paste time. Drive it per test to model a roving-editor
// focus handoff DURING the async convert turn (#2454).
let mockFocusedBlockId: string | null = null

vi.mock('@/stores/blocks', () => ({
  useBlockStore: {
    getState: () => ({ focusedBlockId: mockFocusedBlockId }),
  },
}))

// Lazy-loaded inside convertAndInsert; control their output per test.
const htmlBodyToOutline = vi.fn()
const outlineToIndentedMarkdown = vi.fn()

vi.mock('@/editor/inline-turndown', () => ({
  createInlineTurndown: () => ({ inline: (el: Element) => el.textContent ?? '' }),
}))

vi.mock('@/editor/html-to-blocks', () => ({
  htmlBodyToOutline: (...args: unknown[]) => htmlBodyToOutline(...args),
  outlineToIndentedMarkdown: (...args: unknown[]) => outlineToIndentedMarkdown(...args),
}))

afterEach(() => {
  vi.clearAllMocks()
  mockFocusedBlockId = null
})

interface FakeView {
  isDestroyed: boolean
  dispatch: ReturnType<typeof vi.fn>
  state: { tr: { insertText: () => unknown }; schema: unknown; selection: unknown }
}

/** Minimal EditorView stand-in: only the members convertAndInsert touches. */
function makeView(isDestroyed: boolean): FakeView {
  const tr = { insertText: () => tr }
  return {
    isDestroyed,
    dispatch: vi.fn(),
    state: { tr, schema: {}, selection: {} },
  }
}

/**
 * A view that is LIVE at first inspection but becomes destroyed after the
 * `flipAfter`-th read of `isDestroyed`. Models the #2033 race: the view is
 * alive when `convertAndInsert` claims the paste (the synchronous guard at the
 * top passes), then the roving editor is torn down (blur / navigation / Android
 * suspend) WHILE the dynamic `import()` is in flight. The post-await re-check
 * (`if (view.isDestroyed) return`) and the per-insert guards must then catch it.
 */
function makeViewDestroyedAfter(flipAfter: number): FakeView {
  const tr = { insertText: () => tr }
  let reads = 0
  return {
    get isDestroyed() {
      reads += 1
      return reads > flipAfter
    },
    dispatch: vi.fn(),
    state: { tr, schema: {}, selection: {} },
  } as unknown as FakeView
}

async function loadModule() {
  return import('@/editor/extensions/html-paste')
}

describe('convertAndInsert — destroyed-view guard (#2033)', () => {
  it('no-ops without throwing when the view is already destroyed', async () => {
    const { convertAndInsert } = await loadModule()
    const view = makeView(true)

    await expect(
      convertAndInsert(view as unknown as EditorView, '<p>hi</p>', 'hi', 'BLOCK_A'),
    ).resolves.toBeUndefined()

    expect(view.dispatch).not.toHaveBeenCalled()
    expect(dispatchBlockEvent).not.toHaveBeenCalled()
    // Conversion is short-circuited before the dynamic import even resolves.
    expect(htmlBodyToOutline).not.toHaveBeenCalled()
  })

  it('does not dispatch the plain-text fallback against a destroyed view', async () => {
    const { convertAndInsert } = await loadModule()
    const view = makeView(true)

    // Even with content that would normally fall back to plain text, a destroyed
    // view must never be dispatched against.
    await expect(
      convertAndInsert(view as unknown as EditorView, '<p>hi</p>', 'plain', 'BLOCK_A'),
    ).resolves.toBeUndefined()

    expect(view.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch when the view is destroyed AFTER the conversion import resolves', async () => {
    const { convertAndInsert } = await loadModule()
    // Live at the synchronous top-of-function guard, destroyed by the time the
    // dynamic `import()` resolves (the post-await `if (view.isDestroyed) return`
    // at html-paste.ts ~line 127). flipAfter=1 → read #1 (top guard) sees a live
    // view and proceeds; read #2 (post-await) sees it destroyed and bails.
    const view = makeViewDestroyedAfter(1)

    // The conversion WOULD route a multi-block paste through the bus if it ran.
    htmlBodyToOutline.mockReturnValue([
      { content: 'one', depth: 0 },
      { content: 'two', depth: 0 },
    ])
    outlineToIndentedMarkdown.mockReturnValue('one\ntwo')

    await expect(
      convertAndInsert(
        view as unknown as EditorView,
        '<p>one</p><p>two</p>',
        'one\ntwo',
        'BLOCK_A',
      ),
    ).resolves.toBeUndefined()

    // Post-await guard fired: the body was never walked, no block event routed,
    // and nothing dispatched into the now-destroyed view. If that guard were
    // removed, htmlBodyToOutline would run and dispatchBlockEvent would fire.
    expect(htmlBodyToOutline).not.toHaveBeenCalled()
    expect(dispatchBlockEvent).not.toHaveBeenCalled()
    expect(view.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch the inline insert when the view is destroyed mid-conversion', async () => {
    const { convertAndInsert } = await loadModule()
    // Survive both the top guard (read #1) and the post-await guard (read #2),
    // then be destroyed by the time the single-inline-block insert runs
    // (`insertInlineMarkdown`'s `if (view.isDestroyed) return`, read #3).
    const view = makeViewDestroyedAfter(2)

    // Single top-level, non-structural block → inline-insert path.
    htmlBodyToOutline.mockReturnValue([{ content: 'hello', depth: 0 }])

    await expect(
      convertAndInsert(view as unknown as EditorView, '<p>hello</p>', 'hello', null),
    ).resolves.toBeUndefined()

    // The inline-insert guard caught the destroyed view: no dispatch, and the
    // block-paste bus was never used (this was the single-block inline path).
    expect(view.dispatch).not.toHaveBeenCalled()
    expect(dispatchBlockEvent).not.toHaveBeenCalled()
  })
})

describe('convertAndInsert — single-inline focus-handoff guard (#2454)', () => {
  it('does NOT inline-insert when focus moved to a different block during the async turn', async () => {
    const { convertAndInsert } = await loadModule()
    // Live view throughout: the roving view is handed to another block WITHOUT
    // being destroyed, so isDestroyed never catches this — only the focus check.
    const view = makeView(false)

    // Single top-level, non-structural block → the inline-insert path.
    htmlBodyToOutline.mockReturnValue([{ content: 'hello', depth: 0 }])

    // Focus has since moved from the paste-time target to a different block.
    mockFocusedBlockId = 'BLOCK_B'

    await expect(
      convertAndInsert(view as unknown as EditorView, '<p>hello</p>', 'hello', 'BLOCK_A'),
    ).resolves.toBeUndefined()

    // The inline insert was aborted: nothing dispatched into the (wrong) block,
    // and the block-paste bus was not used (this was the inline path).
    expect(view.dispatch).not.toHaveBeenCalled()
    expect(dispatchBlockEvent).not.toHaveBeenCalled()
  })

  it('inline-inserts when focus is unchanged (happy path)', async () => {
    const { convertAndInsert } = await loadModule()
    const view = makeView(false)

    htmlBodyToOutline.mockReturnValue([{ content: 'hello', depth: 0 }])

    // Focus is still on the paste-time target block.
    mockFocusedBlockId = 'BLOCK_A'

    await convertAndInsert(view as unknown as EditorView, '<p>hello</p>', 'hello', 'BLOCK_A')

    // The inline insert ran: exactly one dispatch into the view, no block event.
    expect(view.dispatch).toHaveBeenCalledTimes(1)
    expect(dispatchBlockEvent).not.toHaveBeenCalled()
  })

  it('inline-inserts when targetBlockId is null regardless of current focus', async () => {
    const { convertAndInsert } = await loadModule()
    const view = makeView(false)

    htmlBodyToOutline.mockReturnValue([{ content: 'hello', depth: 0 }])

    // A null capture keeps the prior behaviour (mirrors the multi-block guard):
    // even if some block is now focused, the null target does not abort.
    mockFocusedBlockId = 'BLOCK_B'

    await convertAndInsert(view as unknown as EditorView, '<p>hello</p>', 'hello', null)

    expect(view.dispatch).toHaveBeenCalledTimes(1)
    expect(dispatchBlockEvent).not.toHaveBeenCalled()
  })
})

describe('convertAndInsert — captured paste target (#2033)', () => {
  it('threads the captured targetBlockId in the PASTE_HTML_BLOCKS payload', async () => {
    const { convertAndInsert } = await loadModule()
    const view = makeView(false)

    // Two top-level blocks → routes through the block-paste path.
    htmlBodyToOutline.mockReturnValue([
      { content: 'one', depth: 0 },
      { content: 'two', depth: 0 },
    ])
    outlineToIndentedMarkdown.mockReturnValue('one\ntwo')

    await convertAndInsert(
      view as unknown as EditorView,
      '<p>one</p><p>two</p>',
      'one\ntwo',
      'BLOCK_A',
    )

    expect(dispatchBlockEvent).toHaveBeenCalledWith('PASTE_HTML_BLOCKS', {
      markdown: 'one\ntwo',
      targetBlockId: 'BLOCK_A',
    })
    // Block content must never be force-inserted into the editor view.
    expect(view.dispatch).not.toHaveBeenCalled()
  })

  it('forwards a null targetBlockId (no focused block) unchanged', async () => {
    const { convertAndInsert } = await loadModule()
    const view = makeView(false)

    htmlBodyToOutline.mockReturnValue([
      { content: 'one', depth: 0 },
      { content: 'two', depth: 0 },
    ])
    outlineToIndentedMarkdown.mockReturnValue('one\ntwo')

    await convertAndInsert(view as unknown as EditorView, '<p>one</p><p>two</p>', 'one\ntwo', null)

    expect(dispatchBlockEvent).toHaveBeenCalledWith('PASTE_HTML_BLOCKS', {
      markdown: 'one\ntwo',
      targetBlockId: null,
    })
  })
})
