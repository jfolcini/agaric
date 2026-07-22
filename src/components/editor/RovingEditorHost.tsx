/**
 * RovingEditorHost — the lazily-loaded entry point of the editor-runtime chunk
 * (#2939).
 *
 * This headless component owns the single roving TipTap `Editor` for a
 * `BlockTree` (via `useRovingEditor`) and publishes both the editor handle and
 * the `EditorSurface` render component back up to `useLazyRovingEditor`. It is
 * reached ONLY through `React.lazy(() => import('./RovingEditorHost'))`, so its
 * static imports — the full ~50-extension TipTap graph (`use-roving-editor`) and
 * the `EditorSurface` (`@tiptap/react`) — land in a lazy chunk instead of on the
 * cold-start path.
 *
 * The module also registers the ProseMirror selection probe used by
 * `useBlockKeyboard` (which stays TipTap-free on the startup path). Registering
 * at module scope is correct: a real ProseMirror doc can only exist after this
 * chunk has loaded and constructed an editor, so the probe is always set before
 * any real keydown consults it.
 */

import type { Node as PMNode } from '@tiptap/pm/model'
import { Selection } from '@tiptap/pm/state'
import { useLayoutEffect } from 'react'

import type { EditorSurfaceComponent } from '@/components/editor/editor-surface-context'
import { EditorSurface } from '@/components/editor/EditorSurface'
import { setSelectionProbe } from '@/editor/pm-selection-probe'
import {
  type RovingEditorHandle,
  type RovingEditorOptions,
  useRovingEditor,
} from '@/editor/use-roving-editor'

// Register the real ProseMirror boundary probes now that prosemirror-state is
// loaded (see pm-selection-probe.ts / use-block-keyboard.ts, #2939).
setSelectionProbe({
  atStartFrom: (doc) => Selection.atStart(doc as PMNode).from,
  atEndTo: (doc) => Selection.atEnd(doc as PMNode).to,
})

export interface RovingEditorHostProps {
  options: RovingEditorOptions
  /**
   * Called after every render with the current editor handle and the surface
   * component. `useLazyRovingEditor` ignores calls until `handle.editor` is
   * non-null, then adopts the live editor. Passing the surface here (rather than
   * a separate effect) guarantees the consumer has both in the same commit.
   */
  onReady: (handle: RovingEditorHandle, surface: EditorSurfaceComponent) => void
}

export function RovingEditorHost({ options, onReady }: RovingEditorHostProps): null {
  const handle = useRovingEditor(options)
  // Layout effect so the adopt/replay-mount runs before paint — no flash of an
  // empty editor between "editor constructed" and "block content mounted".
  useLayoutEffect(() => {
    onReady(handle, EditorSurface)
  }, [handle, onReady])
  return null
}
