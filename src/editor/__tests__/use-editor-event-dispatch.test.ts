/**
 * #2244 — direct unit tests for `useEditorEventDispatch` (#1019), the
 * late-bound editor-event handler registry BlockTree wires its editor hooks
 * through. Previously this coordination hazard was only exercised transitively
 * via BlockTree; these tests pin its contract directly:
 *
 *  - a registered handler is routed when its stable thunk is invoked;
 *  - a de-registered handler falls back to the DEFAULT no-op (never an
 *    undefined-call crash);
 *  - the exposed thunks / flushRef keep stable identities across renders;
 *  - the per-render staging reset (`staged.current = {}`) is load-bearing: a
 *    handler registered in one render but NOT the next must NOT leak forward.
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { PickerItem } from '@/editor/SuggestionList'
import { useEditorEventDispatch } from '@/editor/use-editor-event-dispatch'

const ITEM: PickerItem = { id: 'ID_1', label: 'Item 1' }

describe('useEditorEventDispatch', () => {
  it('routes an event to the handler registered during render', () => {
    const slashCommand = vi.fn()
    const flush = vi.fn(() => 'flushed')
    // Registration happens DURING render (the renderHook callback is the render
    // body), mirroring how BlockTree calls `.on(...)` inline.
    const { result } = renderHook(() => {
      const dispatch = useEditorEventDispatch()
      dispatch.on('slashCommand', slashCommand)
      dispatch.on('flush', flush)
      return dispatch
    })

    // The post-commit layout effect has published the staged handlers.
    result.current.thunks.slashCommand(ITEM)
    expect(slashCommand).toHaveBeenCalledTimes(1)
    expect(slashCommand).toHaveBeenCalledWith(ITEM)

    expect(result.current.thunks.flush()).toBe('flushed')
    // flushRef mirrors the flush thunk (used by useBlockNavigateToLink).
    expect(result.current.flushRef.current()).toBe('flushed')
  })

  it('falls back to the DEFAULT no-op when a handler is not registered (no crash)', () => {
    // Never register any handler → every thunk resolves to its default.
    const { result } = renderHook(() => useEditorEventDispatch())

    // A no-op call must not throw on an undefined handler...
    expect(() => result.current.thunks.slashCommand(ITEM)).not.toThrow()
    expect(() => result.current.thunks.checkbox('DONE')).not.toThrow()
    expect(() => result.current.thunks.beforeCollapse('BLK_1')).not.toThrow()
    // ...and the default flush returns null (the documented "no content" value).
    expect(result.current.thunks.flush()).toBeNull()
  })

  it('keeps thunks / flushRef / dispatch identities stable across renders', () => {
    const { result, rerender } = renderHook(() => {
      const dispatch = useEditorEventDispatch()
      // Re-registering with a fresh identity each render is expected and cheap.
      dispatch.on('slashCommand', vi.fn())
      return dispatch
    })

    const firstDispatch = result.current
    const firstThunks = result.current.thunks
    const firstFlushRef = result.current.flushRef
    const firstOn = result.current.on

    rerender()

    expect(result.current).toBe(firstDispatch)
    expect(result.current.thunks).toBe(firstThunks)
    expect(result.current.flushRef).toBe(firstFlushRef)
    expect(result.current.on).toBe(firstOn)
  })

  it('does NOT leak a handler from a prior render (per-render staging reset)', () => {
    // Falsification target: this fails if `staged.current = {}` (the per-render
    // reset in useEditorEventDispatch) is dropped — a stale handler would then
    // remain published after a render that no longer registers it.
    const stale = vi.fn()
    const { result, rerender } = renderHook(
      ({ register }: { register: boolean }) => {
        const dispatch = useEditorEventDispatch()
        if (register) dispatch.on('slashCommand', stale)
        return dispatch
      },
      { initialProps: { register: true } },
    )

    // Sanity: while registered, the handler routes.
    result.current.thunks.slashCommand(ITEM)
    expect(stale).toHaveBeenCalledTimes(1)
    stale.mockClear()

    // Re-render WITHOUT re-registering slashCommand. The staging slot is reset
    // each render, so the layout effect republishes the DEFAULT no-op.
    rerender({ register: false })

    result.current.thunks.slashCommand(ITEM)
    // With the reset intact: no leak. Without it: `stale` would fire again.
    expect(stale).not.toHaveBeenCalled()
  })
})
