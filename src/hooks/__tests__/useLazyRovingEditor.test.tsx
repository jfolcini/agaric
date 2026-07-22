/**
 * #2939 — behavioural tests for the lazy roving-editor facade.
 *
 * Verifies the read-only → editable swap is seamless and loses no pipeline
 * state: the facade is a stub (editor null) until the runtime loads, `mount()`
 * buffers + triggers the load, and once the live editor arrives the hook adopts
 * it — replaying the buffered mount and transferring the buffered `onUpdate`
 * callback — so every RovingEditorHandle invariant is preserved across the swap.
 */

import { act, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EditorSurfaceProps } from '@/components/editor/editor-surface-context'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { useLazyRovingEditor } from '@/hooks/useLazyRovingEditor'

// The lazy editor-runtime chunk is mocked: its host captures the `onReady`
// callback so the test can hand over a "live" editor on demand, exactly as the
// real host does once useRovingEditor has constructed the Editor.
let capturedOnReady: ((h: RovingEditorHandle, s: (p: EditorSurfaceProps) => null) => void) | null =
  null
vi.mock('@/components/editor/RovingEditorHost', () => ({
  RovingEditorHost: ({
    onReady,
  }: {
    onReady: (h: RovingEditorHandle, s: (p: EditorSurfaceProps) => null) => void
  }) => {
    capturedOnReady = onReady
    return null
  },
}))

const MockSurface = (_props: EditorSurfaceProps): null => null

function makeLiveHandle(overrides: Partial<RovingEditorHandle> = {}): RovingEditorHandle {
  return {
    editor: {} as RovingEditorHandle['editor'], // non-null → "live"
    mount: vi.fn(),
    unmount: vi.fn(() => null),
    activeBlockId: null,
    getMarkdown: vi.fn(() => null),
    splitAtCaret: vi.fn(() => null),
    originalMarkdown: '',
    setOnUpdate: vi.fn(),
    markCommitted: vi.fn(),
    ...overrides,
  }
}

let latest: ReturnType<typeof useLazyRovingEditor> | null = null
function Harness(): ReactNode {
  const result = useLazyRovingEditor({} as never)
  latest = result
  return result.editorHost
}

beforeEach(() => {
  capturedOnReady = null
  latest = null
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useLazyRovingEditor (#2939)', () => {
  it('starts as a read-only stub: editor null, no surface published', () => {
    render(<Harness />)
    expect(latest?.rovingEditor.editor).toBeNull()
    expect(latest?.editorSurface).toBeNull()
  })

  it('mount() buffers the request, triggers the load, then adopts the live editor', async () => {
    render(<Harness />)

    // Focus a block before the runtime is ready → buffered on the stub.
    act(() => {
      latest?.rovingEditor.mount('BLK_1', 'hello world')
    })
    // Stub reflects the pending block so focus bookkeeping stays consistent.
    expect(latest?.rovingEditor.editor).toBeNull()
    expect(latest?.rovingEditor.activeBlockId).toBe('BLK_1')
    expect(latest?.rovingEditor.originalMarkdown).toBe('hello world')

    // The lazy host mounts and hands us its onReady.
    await waitFor(() => expect(capturedOnReady).not.toBeNull())

    const live = makeLiveHandle()
    act(() => {
      capturedOnReady?.(live, MockSurface)
    })

    // Adopted: facade is now the live handle, surface is published…
    expect(latest?.rovingEditor).toBe(live)
    expect(latest?.editorSurface).toBe(MockSurface)
    // …and the buffered mount was replayed onto the live editor (no lost focus).
    expect(live.mount).toHaveBeenCalledWith('BLK_1', 'hello world', undefined)
  })

  it('transfers a pre-load onUpdate callback to the live editor on adopt', async () => {
    render(<Harness />)
    const cb = vi.fn()
    act(() => {
      latest?.rovingEditor.mount('BLK_1', 'x')
      latest?.rovingEditor.setOnUpdate(cb) // registered against the stub
    })
    await waitFor(() => expect(capturedOnReady).not.toBeNull())

    const live = makeLiveHandle()
    act(() => {
      capturedOnReady?.(live, MockSurface)
    })
    // The buffered callback is handed to the real editor so autosave/commit
    // (#1015 / #2600) keep firing after the swap.
    expect(live.setOnUpdate).toHaveBeenCalledWith(cb)
  })

  it('ignores an onReady whose editor is not yet live (waits for a real editor)', async () => {
    render(<Harness />)
    act(() => {
      latest?.rovingEditor.mount('BLK_1', 'x')
    })
    await waitFor(() => expect(capturedOnReady).not.toBeNull())

    // Host publishes a handle whose editor is still null (first render).
    const notLive = makeLiveHandle({ editor: null })
    act(() => {
      capturedOnReady?.(notLive, MockSurface)
    })
    // Facade stays the stub; the buffered mount is NOT replayed onto a dead editor.
    expect(latest?.rovingEditor).not.toBe(notLive)
    expect(latest?.rovingEditor.editor).toBeNull()
    expect(notLive.mount).not.toHaveBeenCalled()
  })

  it('prefetches + constructs the editor on idle even without an interaction', async () => {
    vi.useFakeTimers()
    render(<Harness />)
    // scheduleIdle falls back to setTimeout(0) under jsdom.
    act(() => {
      vi.runOnlyPendingTimers()
    })
    // The lazy host is now in the tree; flush the dynamic import microtask.
    await vi.waitFor(() => expect(capturedOnReady).not.toBeNull())
  })
})
