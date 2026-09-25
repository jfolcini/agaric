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
 * (#5140), spliced into the block at the selection (#5160 D4), and the
 * Ctrl/Cmd+Shift+V plain paste.
 */

import { Editor } from '@tiptap/core'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Heading from '@tiptap/extension-heading'
import { BulletList } from '@tiptap/extension-list'
import ListItem from '@tiptap/extension-list-item'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import Text from '@tiptap/extension-text'
import type { EditorView } from '@tiptap/pm/view'
import { common, createLowlight } from 'lowlight'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CalloutBlockquote } from '@/editor/extensions/callout-blockquote'
import { TaskParagraph } from '@/editor/extensions/task-paragraph'
import { parse } from '@/editor/markdown-serializer'

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

const lowlight = createLowlight(common)

/**
 * A real editor with the paste extension, hard breaks, headings, a code block,
 * tables and bullet lists.
 */
async function buildEditor(content: object): Promise<Editor> {
  const { HtmlPaste } = await loadModule()
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      TaskParagraph,
      Text,
      HardBreak,
      Heading,
      CalloutBlockquote,
      CodeBlockLowlight.configure({ lowlight }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      BulletList,
      ListItem,
      HtmlPaste,
    ],
    content,
  })
}

function paragraphDoc(text: string): object {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

const EMPTY_PARAGRAPH = { type: 'doc', content: [{ type: 'paragraph' }] }
const HELLO_WORLD = paragraphDoc('Hello world')
const HELLO_BIG_WORLD = paragraphDoc('Hello big world')

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
  let editor: Editor | null = null

  afterEach(() => {
    editor?.destroy()
    editor = null
  })

  it('sends the converted blocks, with the captured targetBlockId and the splice, as a PASTE_BLOCKS payload', async () => {
    const { convertAndInsert } = await loadModule()
    editor = await buildEditor(HELLO_WORLD)
    editor.commands.setTextSelection(7)

    // A multi-line block and a nested one → routes through the block-paste path.
    const blocks = [
      { content: '```js\nconst a = 1\n```', depth: 0 },
      { content: '- two', depth: 1 },
    ]
    htmlBodyToOutline.mockReturnValue(blocks)

    await convertAndInsert(editor.view, '<p>one</p><p>two</p>', 'one\ntwo', 'BLOCK_A')

    expect(dispatchBlockEvent).toHaveBeenCalledWith('PASTE_BLOCKS', {
      input: { kind: 'blocks', blocks },
      targetBlockId: 'BLOCK_A',
      splice: { before: 'Hello ', after: 'world' },
      asText: expect.any(String),
    })
    // Block content must never be force-inserted into the editor view.
    expect(editor.state.doc.textContent).toBe('Hello world')
  })

  it('forwards a null targetBlockId (no focused block) unchanged', async () => {
    const { convertAndInsert } = await loadModule()
    editor = await buildEditor(EMPTY_PARAGRAPH)

    const blocks = [
      { content: 'one', depth: 0 },
      { content: 'two', depth: 0 },
    ]
    htmlBodyToOutline.mockReturnValue(blocks)

    await convertAndInsert(editor.view, '<p>one</p><p>two</p>', 'one\ntwo', null)

    expect(dispatchBlockEvent).toHaveBeenCalledWith('PASTE_BLOCKS', {
      input: { kind: 'blocks', blocks },
      targetBlockId: null,
      splice: { before: '', after: '' },
      asText: expect.any(String),
    })
  })

  // followup-notes-2 item 1 — multi-block HTML over a selection replaced it
  // only on the plain-text branch; both branches splice now.
  it('replaces a selection: the selected text is in neither half of the splice', async () => {
    const { convertAndInsert } = await loadModule()
    editor = await buildEditor(HELLO_BIG_WORLD)
    editor.commands.setTextSelection({ from: 7, to: 11 })
    htmlBodyToOutline.mockReturnValue([
      { content: 'one', depth: 0 },
      { content: 'two', depth: 0 },
    ])

    await convertAndInsert(editor.view, '<p>one</p><p>two</p>', 'one\ntwo', 'BLOCK_A')

    expect(dispatchBlockEvent).toHaveBeenCalledWith(
      'PASTE_BLOCKS',
      expect.objectContaining({ splice: { before: 'Hello ', after: 'world' } }),
    )
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

// #5140 / #5160 D4 — with no usable HTML, text of more than one line (or one
// bullet line, our copy of a block) is pasted as blocks (`paste_blocks` reads
// it with the import grammar), not into the editor, where ProseMirror would
// escape its markers into literal paragraphs (`\## Plan`, `1\.`). The payload
// splices it into the block at the selection. A single line stays inline, a
// lone task line is `TaskPaste`'s.
describe('handlePaste — pasted text goes to the block path, spliced (#5160 D4)', () => {
  let editor: Editor | null = null

  afterEach(() => {
    editor?.destroy()
    editor = null
  })

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

  /** Fire the handleKeyDown chain, as the browser does before a paste. */
  function keyDown(ed: Editor, init: KeyboardEventInit): void {
    const event = new KeyboardEvent('keydown', init)
    ed.view.someProp('handleKeyDown', (fn) => fn(ed.view, event))
  }

  const README = '# Agaric\n\nA note app.\n\n## Install\n\n```sh\nnpm i\n```\n'
  const LLM_ANSWER =
    'Here is a plan:\n\n## Plan\n\n1. First step\n   - detail\n2. Second step\n\nGood luck!'

  it.each([
    ['multi-line prose', 'First line\nsecond line'],
    ['two paragraphs', 'One.\n\nTwo.'],
    ['a README', README],
    ['an LLM answer', LLM_ANSWER],
    ['a `*` list', '* a\n* b'],
    ['a numbered list', '1. one\n2. two'],
    ['our own copy of a parent and child', '- parent\n  - child\n'],
    ['our own copy of one block', '- only one\n'],
    ['a single bullet with trailing blank lines', '- only one\n\n  \n'],
    ['a task with a child', '- [ ] buy milk\n  - oat'],
    ['an empty block with a child', '-\n  - child'],
  ])('routes %s as text, spliced at the caret', async (_name, text) => {
    mockFocusedBlockId = 'BLOCK_A'
    editor = await buildEditor(HELLO_WORLD)
    editor.commands.setTextSelection(7)

    expect(paste(editor, text)).toBe(true)

    expect(dispatchBlockEvent).toHaveBeenCalledTimes(1)
    expect(dispatchBlockEvent).toHaveBeenCalledWith('PASTE_BLOCKS', {
      input: { kind: 'text', text },
      targetBlockId: 'BLOCK_A',
      splice: { before: 'Hello ', after: 'world' },
      asText: expect.any(String),
    })
    // Nothing lands in the editor itself.
    expect(editor.state.doc.textContent).toBe('Hello world')
  })

  it.each([
    ['at the start', 1, { before: '', after: 'Hello world' }],
    ['at the end', 12, { before: 'Hello world', after: '' }],
  ])('splices %s of the block', async (_name, caret, splice) => {
    editor = await buildEditor(HELLO_WORLD)
    editor.commands.setTextSelection(caret)

    expect(paste(editor, 'a\nb')).toBe(true)

    expect(dispatchBlockEvent).toHaveBeenCalledWith(
      'PASTE_BLOCKS',
      expect.objectContaining({ splice }),
    )
  })

  // `after` ends the LAST pasted block, so it must be the text alone: a
  // `doc.cut` from the caret keeps the heading node, whose serialization
  // repeats the `## ` marker mid-text.
  it('splices mid-heading: the anchor keeps its marker, the text after the caret carries none', async () => {
    editor = await buildEditor({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading here' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'next line' }] },
      ],
    })
    editor.commands.setTextSelection(9)

    expect(paste(editor, 'a\nb')).toBe(true)

    expect(dispatchBlockEvent).toHaveBeenCalledWith(
      'PASTE_BLOCKS',
      expect.objectContaining({ splice: { before: '## Heading ', after: 'here\nnext line' } }),
    )
  })

  it('splices mid-quote: the cut leaves no empty `> ` line in the text after the caret', async () => {
    editor = await buildEditor({
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted text' }] }],
        },
      ],
    })
    editor.commands.setTextSelection(8)

    expect(paste(editor, 'a\nb')).toBe(true)

    expect(dispatchBlockEvent).toHaveBeenCalledWith(
      'PASTE_BLOCKS',
      expect.objectContaining({ splice: { before: '> quoted', after: ' text' } }),
    )
  })

  it('replaces a selection: the selected text is in neither half of the splice', async () => {
    editor = await buildEditor(HELLO_BIG_WORLD)
    editor.commands.setTextSelection({ from: 7, to: 11 })

    expect(paste(editor, '- a\n- b')).toBe(true)

    expect(dispatchBlockEvent).toHaveBeenCalledWith(
      'PASTE_BLOCKS',
      expect.objectContaining({ splice: { before: 'Hello ', after: 'world' } }),
    )
  })

  it('carries the block as a plain paste leaves it: the lines literal, at the caret', async () => {
    editor = await buildEditor(HELLO_WORLD)
    editor.commands.setTextSelection(7)

    paste(editor, '## Plan\n1. step\n')

    const [, detail] = dispatchBlockEvent.mock.calls[0] as [string, { asText: string }]
    expect(parse(detail.asText).content).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hello ## Plan' },
          { type: 'hardBreak' },
          { type: 'text', text: '1. stepworld' },
        ],
      },
    ])
  })

  it('routes an outline when the HTML beside it is unusable (a bare wrapper)', async () => {
    editor = await buildEditor(EMPTY_PARAGRAPH)
    const html = '<html><body><!--StartFragment--><!--EndFragment--></body></html>'

    expect(paste(editor, '- a\n- b', html)).toBe(true)

    expect(dispatchBlockEvent).toHaveBeenCalledWith('PASTE_BLOCKS', {
      input: { kind: 'text', text: '- a\n- b' },
      targetBlockId: null,
      splice: { before: '', after: '' },
      asText: expect.any(String),
    })
  })

  it.each([
    ['a single line', 'just one line'],
    ['a single line with blank lines around it', '\n  one line\n\n'],
    ['a single `*` item', '* one'],
    ['a single numbered line', '1. Introduction'],
    ['a single task line (TaskPaste owns it)', '- [ ] buy milk'],
    ['a single task line with trailing blank lines', '- [x] done\n\n'],
    ['a lone dash', '-'],
  ])('leaves %s to the other paste handlers (inline)', async (_name, text) => {
    editor = await buildEditor(EMPTY_PARAGRAPH)

    expect(paste(editor, text)).toBe(false)

    expect(dispatchBlockEvent).not.toHaveBeenCalled()
  })

  it('keeps text pasted inside a code block literal', async () => {
    editor = await buildEditor({
      type: 'doc',
      content: [{ type: 'codeBlock', attrs: { language: 'js' } }],
    })

    expect(paste(editor, '- a\n- b')).toBe(false)

    expect(dispatchBlockEvent).not.toHaveBeenCalled()
  })

  // #5160 follow-up, item 13 — the splice cuts the block's doc at the cursor,
  // which would leave two tables with rows short of the header's cells, or two
  // lists. Inside one, a multi-line paste takes the literal path instead.
  const cell = (type: 'tableHeader' | 'tableCell', text: string) => ({
    type,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })
  const TABLE_DOC = {
    type: 'doc',
    content: [
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('tableHeader', 'A'), cell('tableHeader', 'B')] },
          { type: 'tableRow', content: [cell('tableCell', 'one'), cell('tableCell', 'two')] },
        ],
      },
    ],
  }
  const item = (text: string) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })
  const LIST_DOC = {
    type: 'doc',
    content: [{ type: 'bulletList', content: [item('one'), item('two')] }],
  }
  const PASTED_AFTER_ONE = [
    { type: 'text', text: 'onea' },
    { type: 'hardBreak' },
    { type: 'text', text: 'b' },
  ]

  /** The position right after the text node `text`. */
  function endOf(ed: Editor, text: string): number {
    let end = 0
    ed.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === text) end = pos + text.length
    })
    return end
  }

  it('pastes literal lines into a table cell: one table, every row the width of the header', async () => {
    editor = await buildEditor(TABLE_DOC)
    editor.commands.setTextSelection(endOf(editor, 'one'))

    expect(paste(editor, 'a\nb')).toBe(true)

    expect(dispatchBlockEvent).not.toHaveBeenCalled()
    const { doc } = editor.state
    expect(doc.childCount).toBe(1)
    const table = doc.child(0)
    expect(table.type.name).toBe('table')
    const widths = Array.from({ length: table.childCount }, (_, i) => table.child(i).childCount)
    expect(widths).toEqual([2, 2])
    expect(table.child(1).child(0).child(0).toJSON().content).toEqual(PASTED_AFTER_ONE)
  })

  it('pastes literal lines into a nested list item: one list, its items intact', async () => {
    editor = await buildEditor(LIST_DOC)
    editor.commands.setTextSelection(endOf(editor, 'one'))

    expect(paste(editor, '- a\n- b')).toBe(true)

    expect(dispatchBlockEvent).not.toHaveBeenCalled()
    const { doc } = editor.state
    expect(doc.childCount).toBe(1)
    const list = doc.child(0)
    expect(list.type.name).toBe('bulletList')
    const items = Array.from({ length: list.childCount }, (_, i) => list.child(i).type.name)
    expect(items).toEqual(['listItem', 'listItem'])
    expect(list.child(0).child(0).toJSON().content).toEqual([
      { type: 'text', text: 'one- a' },
      { type: 'hardBreak' },
      { type: 'text', text: '- b' },
    ])
  })

  it('pastes structural HTML into a table cell as literal text: no blocks, one table', async () => {
    const ed = await buildEditor(TABLE_DOC)
    editor = ed
    ed.commands.setTextSelection(endOf(ed, 'one'))
    htmlBodyToOutline.mockReturnValue([{ content: '# Title', depth: 0 }])

    expect(paste(ed, 'Title', '<h1>Title</h1>')).toBe(true)
    await vi.waitFor(() => expect(ed.state.doc.textContent).toContain('Title'))

    expect(dispatchBlockEvent).not.toHaveBeenCalled()
    const { doc } = ed.state
    expect(doc.childCount).toBe(1)
    const table = doc.child(0)
    expect(table.type.name).toBe('table')
    const widths = Array.from({ length: table.childCount }, (_, i) => table.child(i).childCount)
    expect(widths).toEqual([2, 2])
    expect(table.child(1).child(0).textContent).toBe('oneTitle')
  })

  it('pastes as literal lines after Ctrl+Shift+V: no blocks, no markdown read', async () => {
    editor = await buildEditor(HELLO_WORLD)
    editor.commands.setTextSelection(7)

    keyDown(editor, { key: 'V', ctrlKey: true, shiftKey: true })
    expect(paste(editor, '## Plan\n- step')).toBe(true)

    expect(dispatchBlockEvent).not.toHaveBeenCalled()
    expect(editor.getJSON().content?.map((node) => node.content)).toEqual([
      [
        { type: 'text', text: 'Hello ## Plan' },
        { type: 'hardBreak' },
        { type: 'text', text: '- stepworld' },
      ],
    ])
  })

  it('pastes as literal lines after Cmd+Shift+V, replacing a selection', async () => {
    editor = await buildEditor(HELLO_BIG_WORLD)
    editor.commands.setTextSelection({ from: 7, to: 11 })

    keyDown(editor, { key: 'v', metaKey: true, shiftKey: true })
    expect(paste(editor, 'a\nb')).toBe(true)

    expect(editor.getJSON().content?.map((node) => node.content)).toEqual([
      [{ type: 'text', text: 'Hello a' }, { type: 'hardBreak' }, { type: 'text', text: 'bworld' }],
    ])
  })

  it('reads the chord for one paste only: a later key clears it', async () => {
    editor = await buildEditor(EMPTY_PARAGRAPH)

    keyDown(editor, { key: 'V', ctrlKey: true, shiftKey: true })
    keyDown(editor, { key: 'a' })
    expect(paste(editor, 'a\nb')).toBe(true)

    expect(dispatchBlockEvent).toHaveBeenCalledTimes(1)
  })

  it('reads a plain Ctrl+V as a normal paste', async () => {
    editor = await buildEditor(EMPTY_PARAGRAPH)

    keyDown(editor, { key: 'v', ctrlKey: true })
    expect(paste(editor, 'a\nb')).toBe(true)

    expect(dispatchBlockEvent).toHaveBeenCalledTimes(1)
  })
})
