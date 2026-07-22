/**
 * useLazyRovingEditor — defers the ~600 kB TipTap editor chunk + the per-mount
 * `Editor` construction off the cold-start path (#2939).
 *
 * `BlockTree` previously called `useRovingEditor()` directly, which statically
 * pulls the whole TipTap extension graph (+ highlight.js) into the startup
 * bundle and constructs a full ~50-extension `Editor` per BlockTree mount (7 in
 * weekly view) before any block is focused. This hook replaces that call with a
 * drop-in `RovingEditorHandle` facade whose surface is IDENTICAL for every
 * downstream consumer, while:
 *
 *   1. The real editor module (`RovingEditorHost` → `use-roving-editor` +
 *      `EditorSurface`) is reached only through `React.lazy(() => import(...))`,
 *      so it is a lazy chunk, not a startup dependency.
 *   2. The `Editor` instance is constructed off the critical path — on an idle
 *      callback after first paint (prefetch), or immediately on the first edit
 *      interaction, whichever comes first.
 *
 * Until the runtime loads, the facade is a stub: `editor` is null (so
 * `EditableBlock` keeps rendering the read-only `StaticBlock`) and `mount()`
 * buffers the request and triggers the load. When the live editor arrives the
 * hook "adopts" it — transferring the buffered `onUpdate` callback and replaying
 * the buffered `mount()` in a layout effect (before paint) — so the read-only →
 * editable swap is seamless and no keystroke pipeline state is lost. Every
 * crash-safety flush and focus invariant is preserved because the same
 * `RovingEditorHandle` contract (mount/unmount/getMarkdown/setOnUpdate/
 * markCommitted/splitAtCaret/activeBlockId/originalMarkdown) is honoured
 * throughout — the stub simply queues, and the live handle replays.
 *
 * This module is deliberately TipTap-free: it touches the editor only through
 * the dynamically-imported `RovingEditorHost`.
 */

import {
  createElement,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useEffect } from 'react'

import type { EditorSurfaceComponent } from '@/components/editor/editor-surface-context'
import type {
  MountOptions,
  RovingEditorHandle,
  RovingEditorOptions,
} from '@/editor/use-roving-editor'

const LazyRovingEditorHost = lazy(() =>
  import('@/components/editor/RovingEditorHost').then((m) => ({ default: m.RovingEditorHost })),
)

interface PendingMount {
  blockId: string
  markdown: string
  opts: MountOptions | undefined
}

/**
 * Schedule `cb` off the critical path. Prefers `requestIdleCallback`; falls back
 * to `setTimeout` where unavailable (jsdom/older webviews). Returns a disposer.
 * (Mirrors the pattern in `RichContentRenderer/marks/code.tsx`.)
 */
function scheduleIdle(cb: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(cb)
    return () => {
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(id)
    }
  }
  const id = setTimeout(cb, 0)
  return () => clearTimeout(id)
}

export interface UseLazyRovingEditorResult {
  /** Drop-in replacement for `useRovingEditor(...)`'s return value. */
  rovingEditor: RovingEditorHandle
  /** Headless element that loads + hosts the real editor. Render it in the tree. */
  editorHost: ReactNode
  /** The lazily-loaded editor surface component, or null until the runtime loads. */
  editorSurface: EditorSurfaceComponent | null
}

export function useLazyRovingEditor(options: RovingEditorOptions): UseLazyRovingEditorResult {
  const [shouldLoad, setShouldLoad] = useState(false)
  const [liveHandle, setLiveHandle] = useState<RovingEditorHandle | null>(null)
  const [editorSurface, setEditorSurface] = useState<EditorSurfaceComponent | null>(null)

  // Buffers for interactions that happen before the live editor is ready.
  const pendingMountRef = useRef<PendingMount | null>(null)
  const pendingOnUpdateRef = useRef<(() => void) | null>(null)
  const liveHandleRef = useRef<RovingEditorHandle | null>(null)
  liveHandleRef.current = liveHandle

  const requestLoad = useCallback(() => setShouldLoad(true), [])

  // Prefetch + construct the editor off the critical path once the page has
  // painted, so the first interaction is seamless. `requestLoad` (below) also
  // flips this on an early edit that beats the idle callback.
  useEffect(() => {
    const cancel = scheduleIdle(() => setShouldLoad(true))
    return cancel
  }, [])

  // Stable stub facade used until the live editor is adopted. All methods are no
  // longer consulted once `liveHandle` replaces it (getters read the buffers).
  const stub = useMemo<RovingEditorHandle>(
    () => ({
      editor: null,
      mount(blockId: string, markdown: string, opts?: MountOptions) {
        pendingMountRef.current = { blockId, markdown, opts }
        requestLoad()
      },
      unmount() {
        // Nothing was ever live, so no content changed. Drop any buffered mount.
        pendingMountRef.current = null
        return null
      },
      get activeBlockId() {
        return pendingMountRef.current?.blockId ?? null
      },
      getMarkdown() {
        return null
      },
      splitAtCaret() {
        return null
      },
      get originalMarkdown() {
        return pendingMountRef.current?.markdown ?? ''
      },
      setOnUpdate(cb: (() => void) | null) {
        pendingOnUpdateRef.current = cb
      },
      markCommitted(markdown: string) {
        if (pendingMountRef.current) {
          pendingMountRef.current = { ...pendingMountRef.current, markdown }
        }
      },
    }),
    [requestLoad],
  )

  // Called by the host each render; we adopt only once the editor is live.
  const handleReady = useCallback(
    (handle: RovingEditorHandle, surface: EditorSurfaceComponent): void => {
      setEditorSurface((prev: EditorSurfaceComponent | null) => prev ?? surface)
      if (handle.editor == null) return // constructed but not yet live — wait
      if (liveHandleRef.current === handle) return // already adopted this instance
      // Adopt: transfer the buffered update callback, then replay the buffered
      // mount so the block content is in the live doc before paint.
      const pendingUpdate = pendingOnUpdateRef.current
      if (pendingUpdate) handle.setOnUpdate(pendingUpdate)
      pendingOnUpdateRef.current = null
      const pending = pendingMountRef.current
      if (pending) {
        handle.mount(pending.blockId, pending.markdown, pending.opts)
        pendingMountRef.current = null
      }
      setLiveHandle(handle)
    },
    [],
  )

  const editorHost: ReactNode = shouldLoad
    ? createElement(
        Suspense,
        { fallback: null },
        createElement(LazyRovingEditorHost, { options, onReady: handleReady }),
      )
    : null

  return {
    rovingEditor: liveHandle ?? stub,
    editorHost,
    editorSurface,
  }
}
