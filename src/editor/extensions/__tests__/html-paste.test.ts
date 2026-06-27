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

// Lazy-loaded inside convertAndInsert; control their output per test.
const htmlBodyToOutline = vi.fn()
const outlineToIndentedMarkdown = vi.fn()

vi.mock('../../inline-turndown', () => ({
  createInlineTurndown: () => ({ inline: (el: Element) => el.textContent ?? '' }),
}))

vi.mock('../../html-to-blocks', () => ({
  htmlBodyToOutline: (...args: unknown[]) => htmlBodyToOutline(...args),
  outlineToIndentedMarkdown: (...args: unknown[]) => outlineToIndentedMarkdown(...args),
}))

afterEach(() => {
  vi.clearAllMocks()
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

async function loadModule() {
  return import('../html-paste')
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
