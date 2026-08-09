/**
 * Zoom-scope brands (#3344) — the types that keep one render transform's
 * output out of a command path that never had that transform applied.
 *
 * T5: a render transform applied to the view but NOT to the command path. The
 * rendered projection and the un-zoomed page list are both `FlatBlock[]` /
 * `string[]`, so handing a command path the wrong one typechecks — which is
 * exactly how #3251 (arrow keys / Backspace-merge stepping onto unrendered
 * rows) and #3252 (Ctrl+A selecting the whole page while zoomed, then batch
 * deleting it) happened. The brands make that wiring unrepresentable.
 *
 * These live in `lib/` rather than beside `useBlockZoom` (#3642) so the
 * `stores/` layer can name them: the block store's selection primitives are
 * the widest injection point into the selection that batch actions consume,
 * and gating them only at `BlockTree`'s adapters left every other importer of
 * `useBlockStore` free to call `selectAll(someUngatedIds)`. `lib < stores <
 * hooks < components` (see `scripts/check-lib-layering.mjs`) forbids the
 * store importing a component-layer module, so the types moved down instead.
 *
 * `ZOOM_SCOPED` is `declare const` (ambient, erased at emit) so the brand has
 * no runtime cost and no runtime representation to forge.
 */

import type { FlatBlock } from '@/lib/tree-utils'

declare const ZOOM_SCOPED: unique symbol

/**
 * Which projection a branded list is. Three lists reach a command path and
 * none of them are interchangeable, so the brand carries which one it is
 * rather than a single "derived here" bit:
 *
 * - `'view'` — the zoom projection, in rendered document order, BEFORE the
 *   mount cap. Semantically the active pane; not necessarily all mounted.
 * - `'mounted'` — that same projection after `useBlockMountLimit` truncated it
 *   to the rows that actually mount as React components.
 * - `'select-all'` — Ctrl/Cmd+A's scope. At the page root this is the
 *   DOCUMENTED page-wide list, which includes collapse-hidden rows and rows
 *   past the mount cap, so it is deliberately *not* the rendered projection.
 *
 * Without the discriminant a one-bit brand would let `selectAllIds` — a
 * page-wide list containing rows the pane never rendered — pass as a rendered
 * list into Shift+Arrow extend / range-select, which is the very defect class
 * (#3251/#3252) this brand exists to close. The `'view'`/`'mounted'` split is
 * the same argument one transform further down (#3641): the uncapped list is
 * a legal *input* to the cap and an illegal argument to anything that steps
 * through mounted rows.
 */
type ScopeKind = 'view' | 'mounted' | 'select-all'

/**
 * Brand applied by `useBlockZoom`'s derivation, `useBlockMountLimit`'s
 * truncation, and nothing else. The arrays are `readonly` (#3643): `.sort()`
 * and `.reverse()` are typed as returning `this`, so on a mutable array a
 * caller could reorder a branded projection and hand it on with the brand
 * intact — while the brand's whole claim is *this is the list that was
 * rendered, in the order it was rendered*.
 */
type ZoomScoped<T, K extends ScopeKind> = T & { readonly [ZOOM_SCOPED]: K }

/**
 * The blocks of the ACTIVE view projection — the zoom-filtered, depth-rebased
 * slice while zoomed, the collapse-filtered page list at the root view. Only
 * `useBlockZoom` produces one.
 *
 * This is the SEMANTIC pane, uncapped. It is the input to the mount cap and
 * is NOT a legal argument for the command paths, which take
 * {@link MountedBlocks}.
 */
export type ZoomedBlocks = ZoomScoped<readonly FlatBlock[], 'view'>

/**
 * The rows of the active projection that actually mount — {@link ZoomedBlocks}
 * after `useBlockMountLimit`'s ceiling. Only that hook produces one.
 *
 * Command paths that step through document order — focus prev/next, the
 * Backspace merge target, the delete boundary guard, DnD's drop projection —
 * take this type, so neither the un-zoomed page list nor the uncapped zoom
 * projection is a legal argument. The uncapped one matters (#3641): with the
 * cap engaged, focus-next or Backspace-merge sourced from it can target a row
 * `BlockListRenderer` never mounted, which is #3251 again with virtualization
 * standing in for zoom.
 */
export type MountedBlocks = ZoomScoped<readonly FlatBlock[], 'mounted'>

/**
 * Ids of the mounted projection, derived from {@link MountedBlocks} via
 * {@link mountedScopedIds}. The command paths that step through *rendered*
 * rows — mouse Shift+Click range-select, Shift+Arrow extend — take this type,
 * so they cannot be handed the page-wide list.
 *
 * NOT the Ctrl/Cmd+A scope: see {@link SelectAllScopeIds}.
 */
export type MountedIds = ZoomScoped<readonly string[], 'mounted'>

/**
 * Ids Ctrl/Cmd+A selects. While zoomed this is the complete zoom projection;
 * at the page root it is the documented page-wide list, which contains
 * collapse-hidden rows and rows past the mount cap. That makes it a valid
 * argument for `selectAll` and for NOTHING else — a distinct brand kind from
 * {@link MountedIds} precisely so it cannot drift into a command path whose
 * contract is "the rows the pane rendered".
 */
export type SelectAllScopeIds = ZoomScoped<readonly string[], 'select-all'>

/**
 * Project a mounted block list to its ids, carrying the brand across the
 * `FlatBlock[]` → `string[]` change of shape.
 *
 * This is exported but is NOT an escape hatch: it demands a
 * {@link MountedBlocks} as input, so it can only re-express a list that was
 * already derived by the cap. It cannot brand an arbitrary array.
 */
export function mountedScopedIds(blocks: MountedBlocks): MountedIds {
  const ids: readonly string[] = blocks.map((b) => b.id)
  return ids as MountedIds
}
