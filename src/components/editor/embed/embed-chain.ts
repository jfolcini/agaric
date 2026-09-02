/**
 * `EmbedChainContext` — the cycle / depth guard for nested embeds (#4550).
 *
 * A embeds B embeds A **will** happen: it is one `/embed` away, and it can
 * also arrive from sync (two devices each add one leg). The renderer is
 * re-entrant by construction (`EmbeddedBlockTree` → embedded row →
 * `EmbedContainer` → `EmbeddedBlockTree`), so something has to stop the
 * recursion, and it has to stop it *visibly* — a blank, a toast or a thrown
 * boundary all hide where the loop closes, which is the only thing that lets
 * the user fix it.
 *
 * Belt AND braces, mirroring the posture the codebase already takes on tree
 * walks (`isInZoomPane` carries a `visited` set *and* the SQL CTEs carry
 * `depth < DESCENDANT_DEPTH_CAP`):
 *
 * - **`renderedIds`** — every block id already materialised by an enclosing
 *   embed on this render path. This is what catches TRUE cycles, including
 *   the indirect ones: embedding a block embeds its subtree, so embedding an
 *   *ancestor* of an already-rendered embed is a cycle too. The set is
 *   therefore seeded with each embed's target **and every id it rendered**,
 *   not just the target.
 * - **`depth`** — how many embed boundaries this render path has crossed,
 *   checked independently against `MAX_EMBED_DEPTH`. A → B → C → D with no
 *   repeated id is not a cycle and `renderedIds` will never stop it, but it
 *   is still unbounded render work.
 *
 * This is a plain React context, not a store: it is per-render-path state,
 * and two sibling embeds on the same page must not see each other's chain.
 */

import { createContext, useContext } from 'react'

/** Shared empty set so the default context value stays reference-stable. */
const NO_RENDERED_IDS: ReadonlySet<string> = new Set<string>()

export interface EmbedChain {
  /**
   * Block ids already materialised by an enclosing embed on this render
   * path (each enclosing embed's target plus every row it rendered).
   */
  renderedIds: ReadonlySet<string>
  /** Embed boundaries crossed so far. `0` on a host page. */
  depth: number
}

/** The host page's chain: nothing rendered by an embed, no boundary crossed. */
export const ROOT_EMBED_CHAIN: EmbedChain = { renderedIds: NO_RENDERED_IDS, depth: 0 }

export const EmbedChainContext = createContext<EmbedChain>(ROOT_EMBED_CHAIN)

/**
 * Read the enclosing embed chain. Outside any embed this returns
 * {@link ROOT_EMBED_CHAIN}, so a host-page `StaticBlock` needs no special
 * casing.
 */
export function useEmbedChain(): EmbedChain {
  return useContext(EmbedChainContext)
}

/**
 * Extend a chain across one embed boundary: the target and everything that
 * embed rendered join `renderedIds`, and the depth advances by one.
 */
export function extendEmbedChain(
  parent: EmbedChain,
  targetId: string,
  renderedRowIds: readonly string[],
): EmbedChain {
  const next = new Set(parent.renderedIds)
  next.add(targetId)
  for (const id of renderedRowIds) next.add(id)
  return { renderedIds: next, depth: parent.depth + 1 }
}
