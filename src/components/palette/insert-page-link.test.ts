/**
 * #1064 — `insertPageLinkInto` liveness guard for the active-editor branch.
 *
 * Mirrors the CommandPalette active-editor insertion test: register a fluent
 * `chain().focus().insertContent().run()` stub and assert the link is routed
 * through it on a LIVE editor, but that a destroyed/absent editor degrades
 * cleanly (it must not throw into the swallowing catch, and must not drive the
 * dead chain). We use `Editor.isDestroyed`, not `editor.view.isDestroyed`
 * (#1017).
 */

import type { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setActiveEditor } from '@/editor/active-editor'

import { insertPageLinkInto } from './insert-page-link'

afterEach(() => {
  setActiveEditor(null)
  document.body.innerHTML = ''
})

function makeChainSpy(isDestroyed = false) {
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
  return { calls, editor: { isDestroyed, chain: () => chainObj } as unknown as Editor }
}

/** A `.ProseMirror` contenteditable host standing in for the focused block. */
function makeProseMirrorTarget(): HTMLElement {
  const pm = document.createElement('div')
  pm.className = 'ProseMirror'
  pm.contentEditable = 'true'
  document.body.appendChild(pm)
  return pm
}

describe('insertPageLinkInto active-editor branch (#1064)', () => {
  it('inserts through the live editor chain (undo-history path)', () => {
    const { calls, editor } = makeChainSpy()
    setActiveEditor(editor)
    const pm = makeProseMirrorTarget()

    expect(insertPageLinkInto(pm, 'Alpha', null)).toBe(true)
    expect(calls.focus).toHaveBeenCalled()
    expect(calls.insertContent).toHaveBeenCalledWith('[[Alpha]]')
    expect(calls.run).toHaveBeenCalled()
  })

  it('no-ops gracefully on a destroyed active editor — no throw, dead chain untouched', () => {
    // `getActiveEditor()` nulls the destroyed handle at the chokepoint, so the
    // ProseMirror branch is skipped and we fall through to the (caret-less)
    // Selection/Range fallback, which returns false here. Crucially the dead
    // editor's chain is never driven.
    const { calls } = makeChainSpy(true)
    const dead = {
      isDestroyed: true,
      chain: () => {
        throw new Error('editor destroyed')
      },
    } as unknown as Editor
    setActiveEditor(dead)
    const pm = makeProseMirrorTarget()

    expect(() => insertPageLinkInto(pm, 'Alpha', null)).not.toThrow()
    expect(insertPageLinkInto(pm, 'Alpha', null)).toBe(false)
    expect(calls.run).not.toHaveBeenCalled()
  })

  it('no-ops gracefully when there is no active editor at all', () => {
    setActiveEditor(null)
    const pm = makeProseMirrorTarget()
    // No selection planted → the Selection/Range fallback finds no range and
    // returns false, without throwing.
    expect(() => insertPageLinkInto(pm, 'Alpha', null)).not.toThrow()
    expect(insertPageLinkInto(pm, 'Alpha', null)).toBe(false)
  })
})
