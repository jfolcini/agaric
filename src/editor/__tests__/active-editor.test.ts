/**
 * #1064 — active-editor registry liveness guard.
 *
 * The registry is deliberately not cleared on blur (BlockTree.tsx only clears
 * on guarded unmount), so a teardown that does not route through that path can
 * leave a destroyed `Editor` cached. `getActiveEditor()` is the chokepoint: it
 * must never hand out a dead handle. We use `Editor.isDestroyed` (NOT
 * `editor.view.isDestroyed`, a v3 Proxy-stub trap — #1017).
 */

import type { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it } from 'vitest'

import { getActiveEditor, setActiveEditor } from '../active-editor'

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
