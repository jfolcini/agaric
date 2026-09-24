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
 * They also pin which plain-text pastes `handlePaste` routes to the block path
 * (#5140).
 */

import { Editor } from '@tiptap/core'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import Document from '@tiptap/extension-document'
import Text from '@tiptap/extension-text'
import type { EditorView } from '@tiptap/pm/view'
import { common, createLowlight } from 'lowlight'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TaskParagraph } from '@/editor/extensions/task-paragraph'

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

vi.mock('@/editor/inline-turndown', () => ({
  createInlineTurndown: () => ({ inline: (el: Element) => el.textContent ?? '' }),
}))

vi.mock('@/editor/html-to-blocks', () => ({
  htmlBodyToOutline: (...args: unknown[]) => htmlBodyToOutline(...args),
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
  it('sends the converted blocks, with the captured targetBlockId, as a PASTE_BLOCKS payload', async () => {
    const { convertAndInsert } = await loadModule()
    const view = makeView(false)

    // A multi-line block and a nested one → routes through the block-paste path.
    const blocks = [
      { content: '```js\nconst a = 1\n```', depth: 0 },
      { content: '- two', depth: 1 },
    ]
    htmlBodyToOutline.mockReturnValue(blocks)

    await convertAndInsert(
      view as unknown as EditorView,
      '<p>one</p><p>two</p>',
      'one\ntwo',
      'BLOCK_A',
    )

    expect(dispatchBlockEvent).toHaveBeenCalledWith('PASTE_BLOCKS', {
      input: { kind: 'blocks', blocks },
      targetBlockId: 'BLOCK_A',
    })
    // Block content must never be force-inserted into the editor view.
    expect(view.dispatch).not.toHaveBeenCalled()
  })

  it('forwards a null targetBlockId (no focused block) unchanged', async () => {
    const { convertAndInsert } = await loadModule()
    const view = makeView(false)

    const blocks = [
      { content: 'one', depth: 0 },
      { content: 'two', depth: 0 },
    ]
    htmlBodyToOutline.mockReturnValue(blocks)

    await convertAndInsert(view as unknown as EditorView, '<p>one</p><p>two</p>', 'one\ntwo', null)

    expect(dispatchBlockEvent).toHaveBeenCalledWith('PASTE_BLOCKS', {
      input: { kind: 'blocks', blocks },
      targetBlockId: null,
    })
  })
})

// #3277 finding 4 — `handlePaste` now parses the clipboard HTML once (via
// `parseUsableHtmlBody`) and threads the result into `convertAndInsert`
// instead of letting it re-parse the same string a second time.
describe('convertAndInsert — precomputed body plumbing (#3277)', () => {
  it('walks the SAME body object handlePaste already parsed, not a fresh re-parse', async () => {
    const { convertAndInsert } = await loadModule()
    const view = makeView(false)

    htmlBodyToOutline.mockReturnValue([{ content: 'hello', depth: 0 }])

    // A marker object standing in for the body `handlePaste` parsed — if the
    // conversion silently re-parsed `html` instead of using this, the object
    // identity check below would fail (a fresh `DOMParser` result is a
    // DIFFERENT object even for identical HTML).
    const precomputedBody = { marker: 'precomputed-body' } as unknown as ParentNode

    await convertAndInsert(
      view as unknown as EditorView,
      '<p>hello</p>',
      'hello',
      null,
      precomputedBody,
    )

    expect(htmlBodyToOutline).toHaveBeenCalledWith(precomputedBody, expect.any(Function))
  })

  it('falls back to parsing `html` itself when no precomputed body is given (existing callers unaffected)', async () => {
    const { convertAndInsert } = await loadModule()
    const view = makeView(false)

    htmlBodyToOutline.mockReturnValue([{ content: 'hello', depth: 0 }])

    await convertAndInsert(view as unknown as EditorView, '<p>hello</p>', 'hello', null)

    // Called with SOME body (a real parsed DOM node), not the precomputed
    // marker from the previous test — confirms the 5-arg call above is what
    // engages the shortcut, not a permanently-cached body.
    const [bodyArg] = htmlBodyToOutline.mock.calls[0] as [unknown, unknown]
    expect(bodyArg).not.toEqual({ marker: 'precomputed-body' })
    expect(bodyArg).toBeTruthy()
  })
})

// #5140 — with no usable HTML, plain text that opens with a list item is
// pasted as blocks (`paste_blocks` parses it), not into the editor, where
// ProseMirror would escape its markers into literal text. A lone task line is
// `TaskPaste`'s.
describe('handlePaste — a pasted outline goes to the block path (#5140)', () => {
  const lowlight = createLowlight(common)
  let editor: Editor | null = null

  afterEach(() => {
    editor?.destroy()
    editor = null
  })

  async function build(content: object): Promise<Editor> {
    const { HtmlPaste } = await loadModule()
    return new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        TaskParagraph,
        Text,
        CodeBlockLowlight.configure({ lowlight }),
        HtmlPaste,
      ],
      content,
    })
  }

  const EMPTY_PARAGRAPH = { type: 'doc', content: [{ type: 'paragraph' }] }

  /** Fire the handlePaste chain with a text/plain payload (and optional HTML). */
  function paste(ed: Editor, plain: string, html?: string): boolean {
    const data = new DataTransfer()
    data.setData('text/plain', plain)
    if (html !== undefined) data.setData('text/html', html)
    const event = new ClipboardEvent('paste', { clipboardData: data })
    return (
      ed.view.someProp('handlePaste', (fn) =>
        fn(ed.view, event, ed.view.state.selection.content()),
      ) ?? false
    )
  }

  it.each([
    ['our own copy of a parent and child', '- parent\n  - child\n'],
    ['our own copy of one block', '- only one\n'],
    ['a single bullet with trailing blank lines', '- only one\n\n  \n'],
    ['a task with a child', '- [ ] buy milk\n  - oat'],
    ['an indented first bullet', '  - a\n  - b'],
    ['a bullet list with a blank line between items', '- a\n\n- b'],
    ['an empty block with a child', '-\n  - child'],
  ])('routes %s as text', async (_name, text) => {
    mockFocusedBlockId = 'BLOCK_A'
    editor = await build(EMPTY_PARAGRAPH)

    expect(paste(editor, text)).toBe(true)

    expect(dispatchBlockEvent).toHaveBeenCalledTimes(1)
    expect(dispatchBlockEvent).toHaveBeenCalledWith('PASTE_BLOCKS', {
      input: { kind: 'text', text },
      targetBlockId: 'BLOCK_A',
    })
    // Nothing lands in the editor itself.
    expect(editor.state.doc.textContent).toBe('')
  })

  it('routes an outline when the HTML beside it is unusable (a bare wrapper)', async () => {
    editor = await build(EMPTY_PARAGRAPH)
    const html = '<html><body><!--StartFragment--><!--EndFragment--></body></html>'

    expect(paste(editor, '- a\n- b', html)).toBe(true)

    expect(dispatchBlockEvent).toHaveBeenCalledWith('PASTE_BLOCKS', {
      input: { kind: 'text', text: '- a\n- b' },
      targetBlockId: null,
    })
  })

  it.each([
    ['a single task line (TaskPaste owns it)', '- [ ] buy milk'],
    ['a single task line with trailing blank lines', '- [x] done\n\n'],
    ['plain lines', 'first line\nsecond line'],
    ['plain first line, then a bullet', 'intro\n- a\n- b'],
    ['a dash with no space', '-a\n-b'],
    ['a lone dash', '-'],
    // The backend reads only `- ` as a bullet, so these would land as
    // literal one-line blocks: they keep the default paste.
    ['a `*` list', '* a\n* b'],
    ['a `+` list', '+ a\n+ b'],
    ['a numbered list', '1. one\n2. two'],
  ])('leaves %s to the other paste handlers', async (_name, text) => {
    editor = await build(EMPTY_PARAGRAPH)

    expect(paste(editor, text)).toBe(false)

    expect(dispatchBlockEvent).not.toHaveBeenCalled()
  })

  it('leaves an outline pasted over a selection to the default paste, which replaces it', async () => {
    editor = await build({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'foo' }] }],
    })
    editor.commands.setTextSelection({ from: 1, to: 4 })

    expect(paste(editor, '- a\n- b')).toBe(false)

    expect(dispatchBlockEvent).not.toHaveBeenCalled()
  })

  it('keeps an outline pasted inside a code block literal', async () => {
    editor = await build({
      type: 'doc',
      content: [{ type: 'codeBlock', attrs: { language: 'js' } }],
    })

    expect(paste(editor, '- a\n- b')).toBe(false)

    expect(dispatchBlockEvent).not.toHaveBeenCalled()
  })
})
