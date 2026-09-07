/**
 * `EmbedRowEditorContext` — how an unlocked embed borrows the HOST tree's
 * one roving editor (#4550, phase 2).
 *
 * `AGENTS.md` invariant 4 is one roving TipTap instance per mounted
 * `BlockTree`, and edit-in-place inside an embed must not buy a second one.
 * So an unlocked embedded row does not mount an editor: it renders the host
 * tree's own editable row, which roves the single instance onto the embedded
 * block exactly as it does for a host row. The row lands INSIDE the source
 * page's `PageBlockStoreProvider`, so every write it makes — the debounced
 * content commit, the blur flush, the draft autosave — goes to the embedded
 * block's real page store, not the host's.
 *
 * The renderer arrives through context rather than a static import for the
 * same reason `EmbedRendererContext` exists: `EmbeddedBlockTree` →
 * `EditableBlock` → `StaticBlock` → `EmbedContainer` → `EmbeddedBlockTree` is
 * a four-module cycle, and `check-import-cycles` rejects it — rightly. The
 * props type lives here too, because a type-only import back across the
 * boundary would re-create the edge in any tool that does not special-case
 * `import type`.
 *
 * `null` — outside a `BlockTree` — is also the signal that there is nothing
 * to edit WITH, so the container hides its unlock control entirely rather
 * than offering a dead one.
 */

import { createContext, useContext, type ReactElement } from 'react'

/** The subset of the host editable row's props an embedded row supplies. */
export interface EmbedRowEditorProps {
  blockId: string
  content: string
  onNavigate?: ((id: string) => void) | undefined
  resolveBlockTitle?: ((id: string) => string) | undefined
  resolveTagName?: ((id: string) => string) | undefined
  resolveBlockStatus?: ((id: string) => 'active' | 'deleted') | undefined
  resolveTagStatus?: ((id: string) => 'active' | 'deleted') | undefined
}

/**
 * Renders one embedded row as the host tree's editable row.
 *
 * A render FUNCTION, not the component type — same reason as
 * `EmbedRenderer`: the element is constructed by the owning module against
 * its own module-level binding, so the child's type is a constant and
 * `react(static-components)` stays satisfied.
 */
export type EmbedRowEditor = (props: EmbedRowEditorProps) => ReactElement

export const EmbedRowEditorContext = createContext<EmbedRowEditor | null>(null)

/** The host tree's editable-row renderer, or `null` outside a `BlockTree`. */
export function useEmbedRowEditor(): EmbedRowEditor | null {
  return useContext(EmbedRowEditorContext)
}
