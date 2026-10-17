/**
 * #5686 — ULID tokens in the *Edit as Markdown* buffer: atomic under the arrow
 * keys, Backspace, Delete, typing, paste and IME composition, and decorated
 * with their target's title. A real TipTap editor with the buffer's
 * extensions; keys go through ProseMirror's `handleKeyDown` and typing through
 * `handleTextInput`, as the browser's would.
 */

import { invoke } from '@tauri-apps/api/core'
import { Editor } from '@tiptap/core'
import { redo, undo } from '@tiptap/pm/history'
import { TextSelection } from '@tiptap/pm/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { linesContent, readLines, sourceBufferExtensions } from '@/editor/source-buffer'
import { activeUlidToken } from '@/editor/source-buffer-ulids'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

const LINE = '01K00000000000000000000A01'
const REF = '01K0000000000000000000REF1'
const PAGE = '01K0000000000000000000PAGE'
const GONE = '01K000000000000000000000GN'

let editor: Editor | null = null

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
  useResolveStore.setState({ cache: new Map(), version: 0 })
  // Every buffer resolves its tokens' ids as it opens.
  mockedInvoke.mockImplementation(mockInvokeCommands({ batch_resolve: () => [] }))
})

afterEach(() => {
  editor?.destroy()
  editor = null
  vi.useRealTimers()
})

function build(text: string): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: sourceBufferExtensions([LINE]),
    content: linesContent({
      text,
      lineIds: text.split('\n').map((_, i) => (i === 0 ? LINE : null)),
    }),
  })
  return editor
}

const text = (ed: Editor): string => readLines(ed.state.doc).text

/** The position `offset` characters into the first line. */
const at = (offset: number): number => 1 + offset

function caret(ed: Editor, offset: number): void {
  ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, at(offset))))
}

function select(ed: Editor, from: number, to: number): void {
  ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, at(from), at(to))))
}

/** Press `key`; true when the buffer took it, so the browser does not act on it. */
function press(ed: Editor, key: string, init: KeyboardEventInit = {}): boolean {
  return (
    ed.view.someProp('handleKeyDown', (f) =>
      f(ed.view, new KeyboardEvent('keydown', { key, ...init })),
    ) ?? false
  )
}

/** Type `typed` over the selection as the browser's input does. */
function type(ed: Editor, typed: string): void {
  const { from, to } = ed.state.selection
  const deflt = () => ed.state.tr.insertText(typed, from, to)
  const handled = ed.view.someProp('handleTextInput', (f) => f(ed.view, from, to, typed, deflt))
  if (handled !== true) ed.view.dispatch(deflt())
}

function paste(ed: Editor, pasted: string): void {
  const data = new DataTransfer()
  data.setData('text/plain', pasted)
  ed.view.dom.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
  )
}

const head = (ed: Editor): number => ed.state.selection.head - 1

// `- see ((REF)) now`: the token is offsets 6 to 34.
const SEE = `- see ((${REF})) now`
const FROM = 6
const TO = FROM + REF.length + 4

describe('the arrow keys', () => {
  it('→ before a token steps over it whole, and ← after it steps back', () => {
    const ed = build(SEE)
    caret(ed, FROM)

    expect(press(ed, 'ArrowRight')).toBe(true)
    expect(head(ed)).toBe(TO)

    expect(press(ed, 'ArrowLeft')).toBe(true)
    expect(head(ed)).toBe(FROM)
  })

  it('leave a caret outside a token to the browser', () => {
    const ed = build(SEE)
    caret(ed, FROM - 1)
    expect(press(ed, 'ArrowRight')).toBe(false)
    caret(ed, TO + 1)
    expect(press(ed, 'ArrowLeft')).toBe(false)
  })

  it('from inside a token go to its edge', () => {
    const ed = build(SEE)
    caret(ed, FROM + 5)
    press(ed, 'ArrowRight')
    expect(head(ed)).toBe(TO)

    caret(ed, FROM + 5)
    press(ed, 'ArrowLeft')
    expect(head(ed)).toBe(FROM)
  })

  it('with Shift extend the selection over the whole token', () => {
    const ed = build(SEE)
    caret(ed, FROM)
    press(ed, 'ArrowRight', { shiftKey: true })
    expect(ed.state.selection.from).toBe(at(FROM))
    expect(ed.state.selection.to).toBe(at(TO))
  })

  it('with Ctrl leave the word move to the browser', () => {
    const ed = build(SEE)
    caret(ed, FROM)
    expect(press(ed, 'ArrowRight', { ctrlKey: true })).toBe(false)
  })
})

describe('Backspace and Delete', () => {
  it('Backspace after a token removes it whole, and one undo puts it back', () => {
    const ed = build(SEE)
    caret(ed, TO)

    expect(press(ed, 'Backspace')).toBe(true)
    expect(text(ed)).toBe('- see  now')
    expect(head(ed)).toBe(FROM)

    undo(ed.state, ed.view.dispatch)
    expect(text(ed)).toBe(SEE)
    redo(ed.state, ed.view.dispatch)
    expect(text(ed)).toBe('- see  now')
  })

  it('the undo of a removed token does not take the typing before it', () => {
    const ed = build(SEE)
    caret(ed, TO)
    type(ed, '!')
    caret(ed, TO)

    press(ed, 'Backspace')
    undo(ed.state, ed.view.dispatch)

    expect(text(ed)).toBe(`- see ((${REF}))! now`)
  })

  it('Delete before a token removes it whole', () => {
    const ed = build(SEE)
    caret(ed, FROM)

    expect(press(ed, 'Delete')).toBe(true)
    expect(text(ed)).toBe('- see  now')
  })

  it('Backspace inside a token removes it whole', () => {
    const ed = build(SEE)
    caret(ed, FROM + 3)

    press(ed, 'Backspace')
    expect(text(ed)).toBe('- see  now')
  })

  it('Backspace away from a token is the browser’s', () => {
    const ed = build(SEE)
    caret(ed, TO + 1)
    expect(press(ed, 'Backspace')).toBe(false)
    caret(ed, FROM)
    expect(press(ed, 'Backspace')).toBe(false)
  })

  it('over a selection that splits a token, deletes only what the selection holds whole', () => {
    const ed = build(SEE)
    select(ed, 2, FROM + 4)

    expect(press(ed, 'Backspace')).toBe(true)
    expect(text(ed)).toBe(`- ((${REF})) now`)
  })

  it('removes a property value whole', () => {
    const ed = build(`- a\n  owner:: ${PAGE}`)
    const end = ed.state.doc.content.size - 1
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, end)))

    press(ed, 'Backspace')
    expect(text(ed)).toBe('- a\n  owner:: ')
  })
})

describe('typing', () => {
  it('inside a token is refused', () => {
    const ed = build(SEE)
    caret(ed, FROM + 5)

    type(ed, 'x')
    expect(text(ed)).toBe(SEE)
  })

  it('beside a token is text as ever', () => {
    const ed = build(SEE)
    caret(ed, TO)
    type(ed, 'x')
    caret(ed, FROM)
    type(ed, 'y')
    expect(text(ed)).toBe(`- see y((${REF}))x now`)
  })

  it('over a whole token replaces it', () => {
    const ed = build(SEE)
    select(ed, FROM, TO)

    type(ed, 'x')
    expect(text(ed)).toBe('- see x now')
  })

  it('over a selection that splits a token replaces only what it holds whole', () => {
    const ed = build(SEE)
    select(ed, FROM + 4, TO + 2)

    type(ed, 'x')
    expect(text(ed)).toBe(`- see ((${REF}))xow`)
  })

  it('an IME composition inside a token is refused, and one beside it is not', () => {
    const ed = build(SEE)
    ed.view.dispatch(ed.state.tr.insertText('か', at(FROM + 5)).setMeta('composition', 1))
    expect(text(ed)).toBe(SEE)

    ed.view.dispatch(ed.state.tr.insertText('か', at(TO)).setMeta('composition', 1))
    expect(text(ed)).toBe(`- see ((${REF}))か now`)
  })

  it('a key held for an IME is the composition’s', () => {
    const ed = build(SEE)
    caret(ed, TO)
    expect(press(ed, 'Backspace', { isComposing: true })).toBe(false)
  })

  it('a token typed by hand is undone like any typing', () => {
    const ed = build(`- [[${PAGE}]`)
    const end = ed.state.doc.content.size - 1
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, end)))
    type(ed, ']')
    expect(text(ed)).toBe(`- [[${PAGE}]]`)

    undo(ed.state, ed.view.dispatch)
    expect(text(ed)).toBe(`- [[${PAGE}]`)
  })
})

describe('paste', () => {
  it('over a selection that splits a token lands beside it, the token whole', () => {
    const ed = build(SEE)
    select(ed, 2, FROM + 4)

    paste(ed, 'pasted ')
    expect(text(ed)).toBe(`- pasted ((${REF})) now`)
  })

  it('at a caret inside a token lands after it', () => {
    const ed = build(SEE)
    caret(ed, FROM + 4)

    paste(ed, '!')
    expect(text(ed)).toBe(`- see ((${REF}))! now`)
  })

  it('over a whole token replaces it', () => {
    const ed = build(SEE)
    select(ed, FROM, TO)

    paste(ed, '[[Plan]]')
    expect(text(ed)).toBe('- see [[Plan]] now')
  })
})

describe('the title hint', () => {
  const tokenSpan = (ed: Editor): HTMLElement | null =>
    ed.view.dom.querySelector<HTMLElement>('.source-ulid-token')

  function stubBatchResolve() {
    const batchResolve = vi.fn((args: unknown) => {
      const { ids } = args as { ids: string[] }
      return [
        { id: REF, title: 'Call the bank', block_type: 'content', deleted: false },
        { id: PAGE, title: 'Project Plan', block_type: 'page', deleted: false },
      ].filter((r) => ids.includes(r.id))
    })
    mockedInvoke.mockImplementation(mockInvokeCommands({ batch_resolve: batchResolve }))
    return batchResolve
  }

  it("decorates each token with its target's title, resolved in one batch", async () => {
    const batchResolve = stubBatchResolve()
    const ed = build(`${SEE}\n  owner:: ${PAGE}\n  ((${REF})) [[${GONE}]]`)

    await vi.waitFor(() => {
      expect(tokenSpan(ed)?.dataset['ulidHint']).toBe('Call the bank')
    })
    const spans = [...ed.view.dom.querySelectorAll<HTMLElement>('.source-ulid-token')]
    expect(
      spans.map((s) => [s.textContent, s.dataset['ulidHint'], 'ulidDeleted' in s.dataset]),
    ).toEqual([
      [`((${REF}))`, 'Call the bank', false],
      [PAGE, 'Project Plan', false],
      [`((${REF}))`, 'Call the bank', false],
      [`[[${GONE}]]`, '[[01K00000...]]', true],
    ])
    expect(batchResolve).toHaveBeenCalledTimes(1)
    expect(batchResolve.mock.calls[0]?.[0]).toMatchObject({ ids: [REF, PAGE, GONE] })
  })

  it('asks again only for the ids a change brings, once the typing stops', async () => {
    const batchResolve = stubBatchResolve()
    const ed = build(SEE)
    await vi.waitFor(() => expect(tokenSpan(ed)?.dataset['ulidHint']).toBe('Call the bank'))
    vi.useFakeTimers()

    ed.commands.insertContentAt(ed.state.doc.content.size - 1, ` [[${PAGE}]]`)
    ed.commands.insertContentAt(ed.state.doc.content.size - 1, ` [[${GONE}]]`)
    expect(batchResolve).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300)

    expect(batchResolve).toHaveBeenCalledTimes(2)
    expect(batchResolve.mock.calls[1]?.[0]).toMatchObject({ ids: [PAGE, GONE] })
  })

  it('marks the token the cursor touches as active, and none when it touches none', () => {
    useResolveStore.getState().set(REF, 'Call the bank', false)
    const ed = build(SEE)

    caret(ed, TO)
    expect(tokenSpan(ed)?.hasAttribute('data-ulid-active')).toBe(true)
    expect(activeUlidToken(ed.state)?.hint).toEqual({ label: 'Call the bank', deleted: false })

    caret(ed, TO + 1)
    expect(tokenSpan(ed)?.hasAttribute('data-ulid-active')).toBe(false)
    expect(activeUlidToken(ed.state)).toBeNull()
  })
})
