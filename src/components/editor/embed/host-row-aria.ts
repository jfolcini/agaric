/**
 * `HostRowAriaContext` — the host row's `aria-level`, published so an embed
 * rendered inside that row can compute its own rows' levels RELATIVE TO THE
 * HOST TREE (#4550).
 *
 * Why this exists at all: an embedded subtree re-bases its indentation to
 * depth 0 inside its container (otherwise a target at storage depth 19 inside
 * a host row at storage depth 19 renders 38 indent levels and overflows any
 * window). Depth is also exactly the input `aria-level` is derived from —
 * `SortableBlockWrapper` renders `aria-level={block.depth + 1}`. Inheriting
 * the SOURCE page's depths would make a screen reader announce "level 20" for
 * a row that is visually at level 1 of an embed sitting at level 2 of this
 * page.
 *
 * So the embed's rows are announced as `hostLevel + 1 + rebasedDepth`, and
 * `hostLevel` is the one piece of information the embed cannot derive for
 * itself: `StaticBlock` (and everything under it) receives content, not
 * depth. `SortableBlockWrapper` is the single component that knows a row's
 * level — it is where the `aria-level` attribute is written — so it is where
 * this is published.
 *
 * Deliberately NOT `role="treeitem"` anywhere. The host outline is not an
 * ARIA tree: `BlockListRenderer` renders a plain `<ul>` with only an
 * `aria-label`, and `SortableBlockWrapper` documents why an isolated
 * `treeitem` under a plain list is itself a violation. The embed matches the
 * host's pattern rather than shipping half of a different one.
 */

import { createContext, useContext } from 'react'

/**
 * The enclosing row's `aria-level` (1-based, matching the attribute).
 * `0` means "no host row" — a standalone render outside a `BlockTree`, where
 * an embed's own rows start at level 1.
 */
export const HostRowAriaContext = createContext<number>(0)

/** Read the enclosing host row's `aria-level`; `0` outside a host row. */
export function useHostRowAriaLevel(): number {
  return useContext(HostRowAriaContext)
}
