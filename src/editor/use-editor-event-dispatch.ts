/**
 * useEditorEventDispatch — owns the late-bound editor-event handler refs that
 * `BlockTree` previously declared, captured, and synced by hand in three
 * separate places (#1019).
 *
 * ## Why this exists
 *
 * Several of `BlockTree`'s editor-event handlers (`onSlashCommand`,
 * `onCheckbox`, `onPropertySelect`, `onBeforeCollapse`) and its editor-flush
 * callback (`flush`) are created *part-way through* the render, but the hooks
 * that consume them (`useRovingEditor`, `useBlockCollapse`,
 * `useBlockNavigateToLink`) run *earlier* in the same render and capture the
 * wiring up front. To break that forward reference the handlers were routed
 * through `useRef` indirections: hooks captured `(args) => ref.current(args)`
 * thunks before the matching handler existed, and the refs were populated
 * afterwards.
 *
 * Doing that previously required three synchronized edits per handler — a ref
 * declaration, a thunk passed to the consuming hook, and an assignment in a
 * single large `useLayoutEffect` — and every consumer had to `.current?.()`
 * null-check. This hook collapses that coordination hazard: it owns the ref
 * lifecycle, exposes stable thunks to wire into the consuming hooks, and
 * accepts the real handlers via `.on(eventName, handler)`. Adding a handler is
 * now one `.on(...)` call plus (if it's a new event) one entry in
 * `EditorEventHandlers`.
 *
 * ## Why `useLayoutEffect` is still required (and React Compiler can't remove it)
 *
 * The refs MUST be written *post-commit*, never during render. Under React's
 * concurrent rendering a render pass can be abandoned (StrictMode
 * double-render, a suspended/aborted concurrent pass); writing `ref.current`
 * during such a render would publish handlers from a render that never
 * committed, so a subsequent user event would invoke a stale/never-live
 * closure. React Compiler memoizes render work but does not change *when* a
 * ref may be written — refs are still an escape hatch that must be mutated in
 * an effect (after commit), not in render. The sync therefore stays in a
 * `useLayoutEffect`: it runs before the browser paints, hence before any user
 * event can read a ref, so the published handlers are always from a committed
 * render. The effect tracks every commit (no dependency array) because the
 * staged handlers are re-collected from scratch each render.
 */

import type { RefObject } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'

import type { PickerItem } from './SuggestionList'

/** Maps each editor event name to its handler signature. */
export interface EditorEventHandlers {
  /** Execute a selected slash command. */
  slashCommand: (item: PickerItem) => void
  /** Persist a checkbox-syntax (`- [ ]` / `- [x]`) toggle detected while typing. */
  checkbox: (state: 'TODO' | 'DONE') => void
  /** Write the property selected from the `::` picker. */
  propertySelect: (item: PickerItem) => void
  /** Rescue focus (flush + clear) before a subtree containing the focused block collapses. */
  beforeCollapse: (blockId: string) => void
  /** Flush the active editor (split + checkbox/todo persistence). Returns the new content, or null. */
  flush: () => string | null
}

type EditorEventName = keyof EditorEventHandlers

/** Default no-op handlers used until the real handler is registered via `.on()`. */
const DEFAULT_HANDLERS: EditorEventHandlers = {
  slashCommand: () => {},
  checkbox: () => {},
  propertySelect: () => {},
  beforeCollapse: () => {},
  flush: () => null,
}

export interface EditorEventDispatch {
  /**
   * Register the real handler for an editor event. Call this during render,
   * once the handler exists; the value is synced into the backing ref in a
   * post-commit `useLayoutEffect`.
   *
   * Re-registering with a new identity each render is expected and cheap — the
   * latest registered handler wins, and the layout-effect sync tracks it.
   */
  on<E extends EditorEventName>(event: E, handler: EditorEventHandlers[E]): void
  /**
   * Stable thunks to wire into the consuming hooks. Each thunk reads the
   * current registered handler at call time, so it can be captured before the
   * handler exists. Identities are stable for the lifetime of the component.
   */
  readonly thunks: Readonly<EditorEventHandlers>
  /**
   * The flush handler as a `RefObject`, for consumers that take a ref object
   * directly (e.g. `useBlockNavigateToLink`). Always read `.current` at call
   * time — never cache the dereferenced function.
   */
  readonly flushRef: RefObject<EditorEventHandlers['flush']>
}

/**
 * Owns the late-bound editor-event handler refs and their post-commit sync.
 * See the file-level doc comment for the concurrent-rendering rationale.
 */
export function useEditorEventDispatch(): EditorEventDispatch {
  // One ref per event, holding the latest committed handler. Read at event
  // time only — never during render.
  const refs = useRef<EditorEventHandlers>({ ...DEFAULT_HANDLERS })

  // Staging slot: handlers registered via `.on()` during the current render.
  // Reset each render so a handler that stops being registered falls back to
  // its default (matching the previous explicit-assignment behaviour).
  const staged = useRef<Partial<EditorEventHandlers>>({})
  staged.current = {}

  const on = useCallback(
    <E extends EditorEventName>(event: E, handler: EditorEventHandlers[E]): void => {
      staged.current[event] = handler
    },
    [],
  )

  // Stable thunks — captured by the consuming hooks before the real handlers
  // exist. Each reads `refs.current[event]` lazily at call time.
  const thunks = useMemo<EditorEventHandlers>(
    () => ({
      slashCommand: (item) => refs.current.slashCommand(item),
      checkbox: (state) => refs.current.checkbox(state),
      propertySelect: (item) => refs.current.propertySelect(item),
      beforeCollapse: (blockId) => refs.current.beforeCollapse(blockId),
      flush: () => refs.current.flush(),
    }),
    [],
  )

  // The flush handler exposed as a stable ref object for `useBlockNavigateToLink`.
  // It points at the stable `flush` thunk, so the ref identity AND its current
  // value are both stable across renders.
  const flushRef = useRef<EditorEventHandlers['flush']>(thunks.flush)
  flushRef.current = thunks.flush

  // Single post-commit sync. Reads the handlers staged this render and
  // publishes them (or their defaults) to the backing refs. No dependency
  // array on purpose — `.on()` writes into a fresh `staged.current` every
  // render, so the sync must track every commit. See the file doc comment for
  // why this must run post-commit (concurrent renders can be abandoned).
  useLayoutEffect(() => {
    const next = staged.current
    refs.current.slashCommand = next.slashCommand ?? DEFAULT_HANDLERS.slashCommand
    refs.current.checkbox = next.checkbox ?? DEFAULT_HANDLERS.checkbox
    refs.current.propertySelect = next.propertySelect ?? DEFAULT_HANDLERS.propertySelect
    refs.current.beforeCollapse = next.beforeCollapse ?? DEFAULT_HANDLERS.beforeCollapse
    refs.current.flush = next.flush ?? DEFAULT_HANDLERS.flush
  })

  return useMemo<EditorEventDispatch>(() => ({ on, thunks, flushRef }), [on, thunks])
}
