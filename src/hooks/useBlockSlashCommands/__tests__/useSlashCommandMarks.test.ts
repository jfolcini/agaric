/**
 * Mark slash commands (#211 P0-5): `/bold` `/italic` `/code` `/strike`
 * `/highlight`. With a selection each toggles the mark (reusing the shared
 * `createMarkToggles` action); with no selection each inserts the Markdown
 * delimiter pair and parks the caret between the delimiters.
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useSlashCommandMarks } from '../useSlashCommandMarks'
import { makeSyntheticCtx } from './test-utils'

/**
 * Minimal chainable editor stub. `chain()` returns a proxy that records every
 * method name it sees and returns itself, so we can assert which TipTap toggle
 * a handler invoked (e.g. `toggleBold`) and what `insertContent` received.
 *
 * `insertContent` advances the live selection by the inserted length, exactly
 * as ProseMirror does — so a handler that parks the caret relative to the
 * *post-insert* `selection.from` (the production code) is distinguishable from
 * one that used a stale/absolute position.
 */
function makeMockEditor(selection: { from: number; to: number }) {
  const chainCalls: string[] = []
  const insertContentArgs: string[] = []
  const setTextSelectionArgs: number[] = []
  const state = { selection: { ...selection } }

  const chainProxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'run') return () => true
        return (...args: unknown[]) => {
          chainCalls.push(String(prop))
          if (prop === 'insertContent') {
            const content = args[0] as string
            insertContentArgs.push(content)
            // Mirror ProseMirror: the caret moves to *after* the inserted text.
            state.selection.from += content.length
            state.selection.to = state.selection.from
          }
          return chainProxy
        }
      },
    },
  )

  const editor = {
    state,
    chain: () => chainProxy,
    commands: {
      setTextSelection: (pos: number) => {
        setTextSelectionArgs.push(pos)
        return true
      },
    },
  }

  return { editor, chainCalls, insertContentArgs, setTextSelectionArgs }
}

function ctxWithEditor(selection: { from: number; to: number }) {
  const { ctx } = makeSyntheticCtx()
  const mock = makeMockEditor(selection)
  ctx.rovingEditor.editor = mock.editor as unknown as typeof ctx.rovingEditor.editor
  return { ctx, ...mock }
}

const MARK_IDS = ['bold', 'italic', 'code-mark', 'strike', 'highlight'] as const

// id → (TipTap toggle method, Markdown delimiter)
const EXPECTED: Record<(typeof MARK_IDS)[number], { toggle: string; delimiter: string }> = {
  bold: { toggle: 'toggleBold', delimiter: '**' },
  italic: { toggle: 'toggleItalic', delimiter: '*' },
  'code-mark': { toggle: 'toggleCode', delimiter: '`' },
  strike: { toggle: 'toggleStrike', delimiter: '~~' },
  highlight: { toggle: 'toggleHighlight', delimiter: '==' },
}

describe('useSlashCommandMarks — registration', () => {
  it('registers all five marks as exact handlers (no prefixes)', () => {
    const { result } = renderHook(() => useSlashCommandMarks())
    for (const id of MARK_IDS) expect(result.current.exact[id]).toBeDefined()
    expect(result.current.prefix).toHaveLength(0)
  })

  it('does NOT register the code-block `code` id (that lives in structural)', () => {
    const { result } = renderHook(() => useSlashCommandMarks())
    expect(result.current.exact['code']).toBeUndefined()
  })

  it('returns a stable identity across rerenders', () => {
    const { result, rerender } = renderHook(() => useSlashCommandMarks())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})

describe('useSlashCommandMarks — with a selection: toggle the mark', () => {
  it.each(MARK_IDS)('/%s toggles the mark when text is selected', (id) => {
    const { result } = renderHook(() => useSlashCommandMarks())
    const { ctx, chainCalls, insertContentArgs } = ctxWithEditor({ from: 3, to: 8 })

    result.current.exact[id]?.(ctx, { id, label: id })

    expect(chainCalls).toContain(EXPECTED[id].toggle)
    // No delimiter insertion on the selection path.
    expect(insertContentArgs).toHaveLength(0)
  })
})

describe('useSlashCommandMarks — no selection: insert delimiter pair, park caret', () => {
  it.each(MARK_IDS)('/%s inserts the doubled delimiter and centres the caret', (id) => {
    const { result } = renderHook(() => useSlashCommandMarks())
    // Empty selection at pos 5. After inserting the pair the caret sits after
    // both delimiters (5 + 2·len); the handler rewinds by one delimiter to land
    // *between* the pair → 5 + len.
    const { ctx, insertContentArgs, setTextSelectionArgs } = ctxWithEditor({ from: 5, to: 5 })

    result.current.exact[id]?.(ctx, { id, label: id })

    const { delimiter } = EXPECTED[id]
    expect(insertContentArgs).toEqual([delimiter + delimiter])
    expect(setTextSelectionArgs).toEqual([5 + delimiter.length])
  })

  it('does not toggle a mark when there is no selection', () => {
    const { result } = renderHook(() => useSlashCommandMarks())
    const { ctx, chainCalls } = ctxWithEditor({ from: 2, to: 2 })

    result.current.exact['bold']?.(ctx, { id: 'bold', label: 'bold' })

    expect(chainCalls).not.toContain('toggleBold')
    expect(chainCalls).toContain('insertContent')
  })
})

describe('useSlashCommandMarks — no editor', () => {
  it.each(MARK_IDS)('/%s no-ops gracefully when the editor is null', (id) => {
    const { result } = renderHook(() => useSlashCommandMarks())
    const { ctx } = makeSyntheticCtx() // editor stays null
    expect(() => result.current.exact[id]?.(ctx, { id, label: id })).not.toThrow()
  })
})
