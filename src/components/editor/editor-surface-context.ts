/**
 * EditorSurfaceContext — the seam that keeps the ~600 kB TipTap editor chunk off
 * the cold-start path (#2939).
 *
 * `EditableBlock` renders a block's editing UI (the `EditorContent` portal +
 * the formatting/bubble toolbars) through the component published on this
 * context, rather than importing `@tiptap/react` directly. The heavy
 * `EditorSurface` implementation lives in the lazily-imported editor-runtime
 * chunk (see `RovingEditorHost` / `useLazyRovingEditor`); until that chunk
 * loads, the context value is `null` and `EditableBlock` keeps showing the
 * read-only `StaticBlock`, so pages render their content immediately without
 * parsing or constructing TipTap.
 *
 * This module is intentionally TipTap-free: importing it costs nothing at
 * startup. The `editor` prop is typed loosely (`unknown`) here; the concrete
 * `EditorSurface` re-narrows it to the live TipTap `Editor`.
 */

import { createContext } from 'react'

// #4006 — the type-only surface lives in `@/types/editor-surface` so that
// `hooks/`-tier consumers (useLazyRovingEditor) can depend on it without
// importing from `components/`, which would invert the lib-layering guard's
// tier direction. Re-exported here unchanged so every existing importer of
// this module keeps working.
export type { EditorSurfaceComponent, EditorSurfaceProps } from '@/types/editor-surface'
import type { EditorSurfaceComponent } from '@/types/editor-surface'

/**
 * Published by `BlockTree` once the lazy editor-runtime chunk has loaded.
 * `null` means "editor runtime not loaded yet" — consumers must fall back to a
 * read-only render.
 */
export const EditorSurfaceContext = createContext<EditorSurfaceComponent | null>(null)
