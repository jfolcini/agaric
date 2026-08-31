/**
 * `EmbedRendererContext` — the injection point that keeps the embed
 * recursion out of the module graph (#4550).
 *
 * The recursion is real and intended: `EmbedContainer` renders
 * `EmbeddedBlockTree`, and a row inside that tree whose content is itself an
 * `{{embed …}}` token has to render another `EmbedContainer`. Expressed as
 * static imports that is a two-module cycle, which `check-import-cycles`
 * rejects — rightly: a cycle is a load-order hazard whether or not it happens
 * to work today, and merging the two files would only hide it (they have
 * genuinely different jobs — one owns the gate/resolve/chrome, the other owns
 * the row list).
 *
 * So the edge goes one way only: `EmbedContainer` → `EmbeddedBlockTree`.
 * `EmbedContainer` publishes ITSELF through the context below, and the tree
 * reads the renderer out of context instead of importing it. Both sides
 * depend on this module; neither depends on the other. The cycle is not
 * merely absent, it is unspellable.
 *
 * The props type lives here rather than in `EmbedContainer` for the same
 * reason: a type-only import back across the boundary would re-create the
 * edge in every tool that does not special-case `import type`.
 */

import { createContext, useContext, type ReactElement } from 'react'

export interface EmbedRenderProps {
  /** The block on the HOST page whose content holds the token. */
  hostBlockId: string
  /** The embed target's ULID. */
  targetId: string
  /**
   * `aria-level` of the host row. Embedded rows are announced at
   * `baseAriaLevel + 1 + rebasedDepth` — see `host-row-aria.ts`.
   */
  baseAriaLevel: number
  /** Navigate to a block/page id (the host tree's link-follow handler). */
  onNavigate?: ((id: string) => void) | undefined
}

/**
 * Renders a NESTED embed.
 *
 * A render FUNCTION returning an element, deliberately, rather than the
 * component type itself. The consumer would otherwise have to write
 * `<Renderer …/>` over a binding read from context, which is a component
 * whose identity the compiler cannot see is stable (React's own
 * `static-components` rule rejects it, and it is the shape that resets child
 * state whenever the identity does move). Here the element is constructed by
 * the OWNING module against its own module-level `EmbedContainer` binding, so
 * the child's type is a constant and its hooks run in its own fiber — the
 * consumer only forwards props.
 */
export type EmbedRenderer = (props: EmbedRenderProps) => ReactElement

/**
 * The nested-embed renderer, or `null` outside any embed (a standalone
 * `EmbeddedBlockTree` render), in which case a nested token degrades to the
 * text it is rather than throwing.
 */
export const EmbedRendererContext = createContext<EmbedRenderer | null>(null)

/** Read the nested-embed renderer; `null` when no `EmbedContainer` encloses. */
export function useEmbedRenderer(): EmbedRenderer | null {
  return useContext(EmbedRendererContext)
}
