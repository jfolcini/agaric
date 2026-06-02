/**
 * #286 — `insertEmojiIntoActiveEditor` unit tests.
 *
 * Mirrors the CommandPalette active-editor insertion test: register a fluent
 * `chain().focus().insertContent().run()` stub via the active-editor registry
 * and assert the emoji is routed through it (undo-history-joining path).
 */

import type { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setActiveEditor } from '../active-editor'
import { insertEmojiIntoActiveEditor } from '../insert-emoji'

afterEach(() => {
  setActiveEditor(null)
})

function makeChainSpy() {
  const calls = { focus: vi.fn(), insertContent: vi.fn(), run: vi.fn() }
  // oxlint-disable-next-line typescript/no-explicit-any -- minimal fluent chain stub.
  const chainObj: any = {
    focus: (...a: unknown[]) => {
      calls.focus(...a)
      return chainObj
    },
    insertContent: (...a: unknown[]) => {
      calls.insertContent(...a)
      return chainObj
    },
    run: (...a: unknown[]) => {
      calls.run(...a)
      return true
    },
  }
  return { calls, editor: { chain: () => chainObj } as unknown as Editor }
}

describe('insertEmojiIntoActiveEditor', () => {
  it('inserts the emoji through the active editor chain', () => {
    const { calls, editor } = makeChainSpy()
    setActiveEditor(editor)

    expect(insertEmojiIntoActiveEditor('\u{1F680}')).toBe(true)
    expect(calls.focus).toHaveBeenCalled()
    expect(calls.insertContent).toHaveBeenCalledWith('\u{1F680}')
    expect(calls.run).toHaveBeenCalled()
  })

  it('returns false (no-op) when there is no active editor', () => {
    setActiveEditor(null)
    expect(insertEmojiIntoActiveEditor('\u{1F600}')).toBe(false)
  })

  it('returns false for an empty char without touching the editor', () => {
    const { calls, editor } = makeChainSpy()
    setActiveEditor(editor)

    expect(insertEmojiIntoActiveEditor('')).toBe(false)
    expect(calls.insertContent).not.toHaveBeenCalled()
  })

  it('returns false when the chain throws (logged, not propagated)', () => {
    const editor = {
      chain: () => {
        throw new Error('editor destroyed')
      },
    } as unknown as Editor
    setActiveEditor(editor)

    expect(insertEmojiIntoActiveEditor('\u{1F525}')).toBe(false)
  })
})
