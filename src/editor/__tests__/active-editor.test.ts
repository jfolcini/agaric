/**
 * #1064 — active-editor registry liveness guard.
 *
 * The registry is deliberately not cleared on blur (BlockTree.tsx only clears
 * on guarded unmount), so a teardown that does not route through that path can
 * leave a destroyed `Editor` cached. `getActiveEditor()` is the chokepoint: it
 * must never hand out a dead handle. We use `Editor.isDestroyed` (NOT
 * `editor.view.isDestroyed`, a v3 Proxy-stub trap — #1017).
 */

import { Editor as CoreEditor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import History from '@tiptap/extension-history'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import type { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getActiveEditor,
  reloadBaseline,
  setActiveEditor,
  takeReloadedText,
} from '@/editor/active-editor'
import { serialize } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'

afterEach(() => {
  setActiveEditor(null)
})

describe('active-editor registry liveness (#1064)', () => {
  it('returns the live editor while it is not destroyed', () => {
    const live = { isDestroyed: false } as unknown as Editor
    setActiveEditor(live)
    expect(getActiveEditor()).toBe(live)
  })

  it('returns null when the registered editor is destroyed', () => {
    const dead = { isDestroyed: true } as unknown as Editor
    setActiveEditor(dead)
    expect(getActiveEditor()).toBeNull()
  })

  it('clears the stale ref so a subsequent get stays null', () => {
    // Mutate liveness after registration (a destroy that raced the publish):
    // the first get nulls the ref, and it stays null even though the local
    // object reference is unchanged.
    const editor = { isDestroyed: false } as unknown as Editor & { isDestroyed: boolean }
    setActiveEditor(editor)
    editor.isDestroyed = true
    expect(getActiveEditor()).toBeNull()
    expect(getActiveEditor()).toBeNull()
  })

  it('rejects a destroyed editor at set time', () => {
    setActiveEditor({ isDestroyed: true } as unknown as Editor)
    expect(getActiveEditor()).toBeNull()
  })
})

describe('takeReloadedText (#6533)', () => {
  /** A live editor on block `A`, mounted with `stored`, and the roving handle it belongs to. */
  function mountOnA(stored: string) {
    const editor = new CoreEditor({
      extensions: [Document, Paragraph, Text, History],
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: stored }] }],
      },
    })
    const roving = {
      activeBlockId: 'A' as string | null,
      storedMarkdown: stored,
      getMarkdown: () => serialize(editor.getJSON() as DocNode),
      markCommitted: vi.fn((markdown: string) => {
        roving.storedMarkdown = markdown
      }),
    }
    const onUpdate = vi.fn()
    editor.on('update', onUpdate)
    setActiveEditor(editor as unknown as Editor, roving)
    return { editor, roving, onUpdate }
  }

  it('a clean editor takes the text, keeps its caret, and makes it the commit baseline', () => {
    const { editor, roving, onUpdate } = mountOnA('hello world')
    editor.commands.setTextSelection(3)

    expect(takeReloadedText('A', 'hello brave world', 'hello world')).toBe(true)

    expect(roving.getMarkdown()).toBe('hello brave world')
    expect(editor.state.selection.from).toBe(3)
    expect(roving.storedMarkdown).toBe('hello brave world')
    // Not typing: nothing for the commit or draft debounce, nothing to undo.
    expect(onUpdate).not.toHaveBeenCalled()
    expect(editor.can().undo()).toBe(false)
    editor.destroy()
  })

  it('a dirty editor keeps what was typed', () => {
    const { editor, roving } = mountOnA('hello world')
    editor.commands.insertContentAt(12, '!')

    expect(takeReloadedText('A', 'hello brave world', 'hello world')).toBe(false)

    expect(roving.getMarkdown()).toBe('hello world!')
    expect(roving.markCommitted).not.toHaveBeenCalled()
    editor.destroy()
  })

  it('an editor that committed since the reload started is not overwritten by the older snapshot', () => {
    const { editor, roving } = mountOnA('hello')
    const baseline = reloadBaseline('A')
    expect(baseline).toBe('hello')
    // A commit lands while the reload's snapshot is in flight.
    editor.commands.insertContentAt(6, '!')
    roving.markCommitted('hello!')

    expect(takeReloadedText('A', 'hello', baseline)).toBe(false)
    expect(roving.getMarkdown()).toBe('hello!')
    editor.destroy()
  })

  it('a dirty editor, or one mid-composition, has no baseline', () => {
    const { editor, roving } = mountOnA('hello')
    expect(reloadBaseline('A')).toBe('hello')
    const composing = vi.spyOn(editor.view, 'composing', 'get').mockReturnValue(true)
    expect(reloadBaseline('A')).toBeNull()
    composing.mockRestore()
    editor.commands.insertContentAt(6, '!')
    expect(reloadBaseline('A')).toBeNull()
    expect(roving.getMarkdown()).toBe('hello!')
    editor.destroy()
  })

  it('undo after a take does not bring back the pre-reload text', () => {
    const { editor, roving } = mountOnA('hello')
    editor.commands.insertContentAt(6, '!')
    roving.markCommitted('hello!')

    expect(takeReloadedText('A', 'peer hello!', 'hello!')).toBe(true)
    editor.commands.undo()

    expect(roving.getMarkdown()).toBe('peer hello!')
    editor.destroy()
  })

  it('a selection past the new, shorter text is clamped', () => {
    const { editor, roving } = mountOnA('hello world')
    editor.commands.setTextSelection({ from: 5, to: 12 })

    expect(takeReloadedText('A', 'hi', 'hello world')).toBe(true)

    expect(roving.getMarkdown()).toBe('hi')
    expect(editor.state.selection.to).toBeLessThanOrEqual(3)
    editor.destroy()
  })

  it('leaves an editor on another block, or none, alone', () => {
    const { editor, roving } = mountOnA('hello world')
    roving.activeBlockId = 'B'
    expect(takeReloadedText('A', 'peer text', 'hello world')).toBe(false)
    expect(roving.getMarkdown()).toBe('hello world')

    setActiveEditor(editor as unknown as Editor)
    roving.activeBlockId = 'A'
    expect(takeReloadedText('A', 'peer text', 'hello world')).toBe(false)
    expect(roving.getMarkdown()).toBe('hello world')
    editor.destroy()
  })
})
