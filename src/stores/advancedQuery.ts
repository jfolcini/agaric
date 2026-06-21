/**
 * Advanced-query working-set store (#1280 D1).
 *
 * The first dedicated advanced-query surface (`AdvancedQueryView`) lets the user
 * compose a flat conjunction of filter chips over the shared filter vocabulary
 * and run it against the live `run_advanced_query` engine. The chips are the
 * only working state in v1 (sort/group/aggregate controls, nested And/Or/Not and
 * saved views are D2/D3 follow-ups), so this store mirrors
 * `pageBrowserFilters.ts`: a per-space, in-memory chip list, deliberately kept
 * SEPARATE from the Pages chip store so the two surfaces don't share a working
 * set.
 *
 * Like the Pages store it is NOT persisted — the chips are a transient working
 * set, intentionally cleared on app restart — and it is partitioned by space id
 * (chip values reference space-scoped ids, so a space switch reads the new
 * space's slice and chips never cross spaces).
 */

import { create } from 'zustand'

import type { PageFilterWithKey } from '../components/PageBrowser/PageBrowserFilterRow'
import type { AggregateSpec, FilterExpr, FilterPrimitive, GroupSpec, SortKey } from '../lib/tauri'
import { LEGACY_SPACE_KEY } from './space'

/**
 * #1280 D3 — the nested boolean builder model.
 *
 * The flat chip conjunction is replaced (in the Advanced Query surface) by an
 * arbitrary And/Or/Not tree the user composes by hand. Both node kinds carry a
 * stable `id` (sourced from the same monotonic `nextAddId` counter the chips
 * use) so React keys stay distinct across re-mounts and reorders, and a
 * `negated` flag that wraps the node's compiled `FilterExpr` in `Not`.
 *
 * The model is deliberately decoupled from the wire `FilterExpr`: a group
 * holds an explicit ordered child list (leaves and sub-groups intermixed) plus
 * its own `op`, so the UI can render/edit it directly. `builderTreeToFilterExpr`
 * compiles it to the engine shape — see that function for the mapping rules.
 */

/** A single filter-primitive leaf in the builder tree. */
export interface BuilderLeafNode {
  kind: 'leaf'
  /** Stable React-key-only id (from `nextAddId`). */
  id: number
  /** The wire primitive this leaf compiles to (`{type:'Leaf', primitive}`). */
  primitive: FilterPrimitive
  /** When true, the compiled leaf is wrapped in `{type:'Not', child}`. */
  negated: boolean
}

/** A boolean group (And/Or over its children), optionally negated. */
export interface BuilderGroupNode {
  kind: 'group'
  /** Stable React-key-only id (from `nextAddId`). */
  id: number
  /** Combinator over `children` — `And` (every child) or `Or` (any child). */
  op: 'And' | 'Or'
  /** When true, the compiled group is wrapped in `{type:'Not', child}`. */
  negated: boolean
  /** Ordered child nodes (leaves and sub-groups intermixed). */
  children: BuilderNode[]
}

/** A node in the builder tree — either a leaf or a (possibly nested) group. */
export type BuilderNode = BuilderLeafNode | BuilderGroupNode

/**
 * A path into the builder tree as a list of child indices from the root group.
 * The empty path `[]` addresses the root group itself; `[0]` its first child,
 * `[0, 2]` the third child of that child (which must be a group), etc.
 */
export type BuilderPath = readonly number[]

/**
 * Compile a single builder node to a wire `FilterExpr`.
 *
 * Mapping rules:
 *   - leaf  → `{type:'Leaf', primitive}`
 *   - group → `{type:'And'|'Or', children: children.map(compile)}` (the op
 *     drives And vs Or); an empty group therefore compiles to `And{[]}` (TRUE)
 *     or `Or{[]}` (FALSE) per the engine's identity semantics.
 *   - `negated` on either kind wraps the compiled expr in `{type:'Not', child}`,
 *     applied AFTER the leaf/group is built (so a negated group negates the
 *     whole And/Or, and a negated leaf negates just that primitive).
 */
function compileNode(node: BuilderNode): FilterExpr {
  const inner: FilterExpr =
    node.kind === 'leaf'
      ? { type: 'Leaf', primitive: node.primitive }
      : { type: node.op, children: node.children.map(compileNode) }
  return node.negated ? { type: 'Not', child: inner } : inner
}

/**
 * Compile the builder tree (rooted at a group node) to a wire `FilterExpr`.
 *
 * A clean/default builder is a single root `And` group with no children, which
 * compiles to `And{ children: [] }` — the engine's TRUE expression ("match
 * everything"), identical to today's empty flat conjunction.
 */
export function builderTreeToFilterExpr(root: BuilderGroupNode): FilterExpr {
  return compileNode(root)
}

/**
 * #1460 saved-views — INVERSE of {@link compileNode}: rebuild a builder
 * {@link BuilderNode} from a wire `FilterExpr`.
 *
 * `compileNode` applies `Not` as the OUTERMOST wrapper (after the leaf/group
 * is built), so deserialization peels a leading `Not` and sets `negated=true`
 * on the node it wraps. A doubled `Not` (which our own compile never emits, but
 * a hand-written / future spec could) toggles back to `negated=false` so the
 * 3-valued semantics stay faithful. The remaining shapes map 1:1:
 *   - `Leaf{primitive}`        → leaf node
 *   - `And{children}` / `Or`   → group node carrying that op
 *
 * `allocId` mints a fresh, store-unique React-key id per node (the store passes
 * a closure over its monotonic `nextAddId`); ids are otherwise compile-invisible
 * (`compileNode` drops them), so any unique sequence round-trips identically.
 */
function filterExprToBuilderNode(expr: FilterExpr, allocId: () => number): BuilderNode {
  if (expr.type === 'Not') {
    const inner = filterExprToBuilderNode(expr.child, allocId)
    return { ...inner, negated: !inner.negated }
  }
  if (expr.type === 'Leaf') {
    return { kind: 'leaf', id: allocId(), primitive: expr.primitive, negated: false }
  }
  // And | Or — a group node.
  return {
    kind: 'group',
    id: allocId(),
    op: expr.type,
    negated: false,
    children: expr.children.map((child) => filterExprToBuilderNode(child, allocId)),
  }
}

/**
 * #1460 saved-views — rebuild a root builder {@link BuilderGroupNode} from a
 * persisted wire `FilterExpr` (the inverse of {@link builderTreeToFilterExpr}).
 *
 * The builder invariant is that the ROOT is always a group. Trees produced by
 * our own builder therefore always serialize to a group-shaped root
 * (`And`/`Or`, optionally wrapped in a single `Not`), which round-trips exactly.
 * A defensive fallback wraps any non-group root expr (a bare `Leaf`, or a `Not`
 * peeling down to a leaf) in a synthetic root `And` group so the invariant holds
 * for hand-authored / foreign specs without throwing.
 */
export function filterExprToBuilderTree(expr: FilterExpr, allocId: () => number): BuilderGroupNode {
  const node = filterExprToBuilderNode(expr, allocId)
  if (node.kind === 'group') return node
  // Non-group root (defensive): wrap the leaf in a fresh root `And` group.
  return { kind: 'group', id: allocId(), op: 'And', negated: false, children: [node] }
}

/**
 * #1460 saved-views — serialized shape stored in a saved view's `query_spec`
 * property (a JSON string). Captures everything the builder + D2 controls
 * produce EXCEPT pagination (cursor/limit), so a load fully reconstructs the
 * working state.
 */
export interface SavedQuerySpec {
  /** The compiled wire `FilterExpr` (from {@link builderTreeToFilterExpr}). */
  filter: FilterExpr
  /** Ordered sort keys (empty ⇒ engine default keyset). */
  sort: SortKey[]
  /** Full-text term (empty string ⇒ no FTS intersect). */
  fulltext: string
  /** Grouping directive, or `null` for the FLAT path. */
  group_by: GroupSpec | null
  /** Global / grouped aggregates. */
  aggregates: AggregateSpec[]
}

/**
 * Serialize the current builder tree + controls into a {@link SavedQuerySpec}
 * (ready to `JSON.stringify` into the `query_spec` property).
 */
export function serializeQuerySpec(
  builder: BuilderGroupNode,
  controls: AdvancedQueryControls,
): SavedQuerySpec {
  return {
    filter: builderTreeToFilterExpr(builder),
    sort: controls.sort,
    fulltext: controls.fulltext,
    group_by: controls.groupBy,
    aggregates: controls.aggregates,
  }
}

/**
 * Parse a persisted `query_spec` JSON string into a {@link SavedQuerySpec}.
 * Throws on malformed JSON or a missing/invalid `filter` field so callers can
 * surface a load error toast rather than hydrate a half-built view.
 */
export function parseQuerySpec(raw: string): SavedQuerySpec {
  const parsed = JSON.parse(raw) as Partial<SavedQuerySpec>
  if (parsed == null || typeof parsed !== 'object' || parsed.filter == null) {
    throw new Error('saved view query_spec is missing its filter expression')
  }
  return {
    filter: parsed.filter,
    sort: Array.isArray(parsed.sort) ? parsed.sort : [],
    fulltext: typeof parsed.fulltext === 'string' ? parsed.fulltext : '',
    group_by: parsed.group_by ?? null,
    aggregates: Array.isArray(parsed.aggregates) ? parsed.aggregates : [],
  }
}

/**
 * The non-chip working set of an advanced query: the controls D2 exposes on top
 * of the flat chip conjunction. Held per-space alongside `filtersBySpace` and,
 * like the chips, NOT persisted (a transient working set cleared on restart).
 */
export interface AdvancedQueryControls {
  /**
   * Optional full-text term. Empty string ⇒ no FTS intersect (purely
   * structural). When set, the engine intersects an FTS5 `MATCH` with the
   * structural filter and `SortSource::Relevance` becomes valid.
   */
  fulltext: string
  /** Ordered sort keys. Empty ⇒ the engine's default keyset. */
  sort: SortKey[]
  /** Optional grouping directive. `null` ⇒ the FLAT path (default). */
  groupBy: GroupSpec | null
  /** Optional global (and, when grouped, per-group) aggregates. */
  aggregates: AggregateSpec[]
}

interface AdvancedQueryState {
  /** Per-space active chip lists, keyed by space id (`__legacy__` for no-space). */
  filtersBySpace: Record<string, PageFilterWithKey[]>
  /** Per-space nested boolean builder trees (#1280 D3), keyed by space id. */
  buildersBySpace: Record<string, BuilderGroupNode>
  /** Per-space non-chip controls (fulltext/sort/groupBy/aggregates). */
  controlsBySpace: Record<string, AdvancedQueryControls>
  /** Monotonic counter for the React-key-only `_addId` / node `id` so keys stay unique across re-mounts. */
  nextAddId: number
  /** Append a chip to the space's list, de-duping structurally-identical chips. */
  addFilter: (spaceKey: string, filter: FilterPrimitive) => void
  /** Remove the chip at `index` from the space's list. */
  removeFilter: (spaceKey: string, index: number) => void
  /** Clear every chip for the space (no-op when already empty). */
  clearFilters: (spaceKey: string) => void
  /** Append a leaf primitive as a child of the group at `path`. */
  addLeaf: (spaceKey: string, path: BuilderPath, primitive: FilterPrimitive) => void
  /** Append a fresh empty `And` sub-group as a child of the group at `path`. */
  addGroup: (spaceKey: string, path: BuilderPath) => void
  /** Remove the node at `path`. No-op for the root (`[]`) — use `clearBuilder`. */
  removeNode: (spaceKey: string, path: BuilderPath) => void
  /** Set the And/Or combinator of the group at `path` (no-op for a leaf). */
  setGroupOp: (spaceKey: string, path: BuilderPath, op: 'And' | 'Or') => void
  /** Flip the `negated` flag of the node at `path`. */
  toggleNegate: (spaceKey: string, path: BuilderPath) => void
  /** Reset the builder to a single empty root `And` group ("match everything"). */
  clearBuilder: (spaceKey: string) => void
  /** Set the full-text term for the space (empty string clears it). */
  setFulltext: (spaceKey: string, fulltext: string) => void
  /** Replace the ordered sort keys for the space. */
  setSort: (spaceKey: string, sort: SortKey[]) => void
  /** Set (or clear with `null`) the grouping directive for the space. */
  setGroupBy: (spaceKey: string, groupBy: GroupSpec | null) => void
  /** Replace the aggregate specs for the space. */
  setAggregates: (spaceKey: string, aggregates: AggregateSpec[]) => void
  /**
   * #1460 saved-views — atomically replace a space's builder tree AND controls
   * from a deserialized {@link SavedQuerySpec}. Fresh React-key ids are minted
   * from `nextAddId` so the loaded tree never collides with existing node keys.
   */
  loadView: (spaceKey: string, spec: SavedQuerySpec) => void
}

/**
 * Stable frozen empty fallback for an absent slice. Returning a fresh `[]` each
 * call would retrigger every consumer via `Object.is`, so the reference must
 * stay stable (mirrors `pageBrowserFilters`' `EMPTY_FILTERS`).
 */
const EMPTY_FILTERS: readonly PageFilterWithKey[] = Object.freeze([])

/**
 * Stable frozen default controls for an absent slice (same referential-stability
 * rationale as `EMPTY_FILTERS`). Nested arrays are frozen too so the selector is
 * a pure read.
 */
const EMPTY_SORT: readonly SortKey[] = Object.freeze([])
const EMPTY_AGGREGATES: readonly AggregateSpec[] = Object.freeze([])
const EMPTY_CONTROLS: Readonly<AdvancedQueryControls> = Object.freeze({
  fulltext: '',
  sort: EMPTY_SORT as SortKey[],
  groupBy: null,
  aggregates: EMPTY_AGGREGATES as AggregateSpec[],
})

/**
 * The clean/default builder: a single root `And` group with no children. Compiles
 * to `And{[]}` (TRUE), so an untouched builder "matches everything" exactly like
 * the empty flat conjunction it replaces. Frozen and shared as the stable
 * fallback for an absent slice (referential idempotency, like `EMPTY_CONTROLS`);
 * the root id is `0`, which the `nextAddId` counter (starting at `1`) never
 * re-issues, so it never collides with a user-added node's key.
 */
const EMPTY_BUILDER: Readonly<BuilderGroupNode> = Object.freeze({
  kind: 'group',
  id: 0,
  op: 'And',
  negated: false,
  children: Object.freeze([]) as unknown as BuilderNode[],
})

/**
 * Per-space chip selector. Pass `currentSpaceId` from `useSpaceStore`; `null`
 * (pre-bootstrap) maps to the `__legacy__` slot. Returns the stable frozen empty
 * array for an absent slice so the selector is referentially idempotent.
 */
export function selectAdvancedQueryFiltersForSpace(
  state: AdvancedQueryState,
  spaceId: string | null,
): PageFilterWithKey[] {
  const key = spaceId ?? LEGACY_SPACE_KEY
  return state.filtersBySpace[key] ?? (EMPTY_FILTERS as PageFilterWithKey[])
}

/**
 * Per-space controls selector. Returns the stable frozen default controls for an
 * absent slice so the selector is referentially idempotent (mirrors the chip
 * selector above).
 */
export function selectAdvancedQueryControlsForSpace(
  state: AdvancedQueryState,
  spaceId: string | null,
): AdvancedQueryControls {
  const key = spaceId ?? LEGACY_SPACE_KEY
  return state.controlsBySpace[key] ?? (EMPTY_CONTROLS as AdvancedQueryControls)
}

/**
 * Per-space builder-tree selector. Returns the stable frozen default builder
 * (a single empty root `And` group) for an absent slice so the selector is
 * referentially idempotent (mirrors the chip/controls selectors above).
 */
export function selectAdvancedQueryBuilderForSpace(
  state: AdvancedQueryState,
  spaceId: string | null,
): BuilderGroupNode {
  const key = spaceId ?? LEGACY_SPACE_KEY
  return state.buildersBySpace[key] ?? (EMPTY_BUILDER as BuilderGroupNode)
}

/**
 * Structurally clone the root group and apply `mutate` to the group node
 * addressed by `path`, walking child indices from the root. Returns the new
 * root. Every node on the path is shallow-copied (immutable update for React);
 * untouched subtrees keep their identity. Throws if the path traverses a leaf or
 * an out-of-range index — callers pass paths sourced from the rendered tree, so
 * an invalid path is a programmer error, not user input.
 */
function updateGroupAt(
  root: BuilderGroupNode,
  path: BuilderPath,
  mutate: (group: BuilderGroupNode) => BuilderGroupNode,
): BuilderGroupNode {
  if (path.length === 0) return mutate(root)
  // `path.length > 0`, so index 0 exists; `?? 0` only satisfies the
  // `noUncheckedIndexedAccess` narrowing.
  const index = path[0] ?? 0
  const rest = path.slice(1)
  const child = root.children[index]
  if (child == null || child.kind !== 'group') {
    throw new Error(`updateGroupAt: path ${JSON.stringify(path)} does not address a group`)
  }
  const nextChild = updateGroupAt(child, rest, mutate)
  const children = root.children.slice()
  children[index] = nextChild
  return { ...root, children }
}

/**
 * Apply `mutate` to the node (leaf OR group) addressed by `path`, returning the
 * new root. The empty path addresses the root group itself. Throws on an
 * out-of-range or leaf-traversing path (programmer error — see `updateGroupAt`).
 */
function updateNodeAt(
  root: BuilderGroupNode,
  path: BuilderPath,
  mutate: (node: BuilderNode) => BuilderNode,
): BuilderGroupNode {
  if (path.length === 0) {
    const next = mutate(root)
    if (next.kind !== 'group') {
      throw new Error('updateNodeAt: the root must remain a group')
    }
    return next
  }
  const parentPath = path.slice(0, -1)
  const index = path.at(-1) as number
  return updateGroupAt(root, parentPath, (parent) => {
    const target = parent.children[index]
    if (target == null) {
      throw new Error(`updateNodeAt: path ${JSON.stringify(path)} out of range`)
    }
    const children = parent.children.slice()
    children[index] = mutate(target)
    return { ...parent, children }
  })
}

/**
 * #1478 — pure tree-edit operations, shared between the store actions (which
 * apply them to a per-space slice + the global `nextAddId` counter) and the
 * self-contained `has-parent-matching` mini-builder (which holds a local
 * `BuilderGroupNode` in React state with its OWN id counter, so its node ids
 * never need to coordinate with the global one — they compile away anyway, since
 * `compileNode` drops the `id`).
 *
 * Each takes the explicit `id` to stamp on the new node so the caller owns id
 * allocation (the store passes `nextAddId + 1`; the mini-builder passes a local
 * monotonic counter).
 */
export function addLeafToTree(
  root: BuilderGroupNode,
  path: BuilderPath,
  primitive: FilterPrimitive,
  id: number,
): BuilderGroupNode {
  const leaf: BuilderLeafNode = { kind: 'leaf', id, primitive, negated: false }
  return updateGroupAt(root, path, (group) => ({
    ...group,
    children: [...group.children, leaf],
  }))
}

export function addGroupToTree(
  root: BuilderGroupNode,
  path: BuilderPath,
  id: number,
): BuilderGroupNode {
  const group: BuilderGroupNode = { kind: 'group', id, op: 'And', negated: false, children: [] }
  return updateGroupAt(root, path, (parent) => ({
    ...parent,
    children: [...parent.children, group],
  }))
}

export function removeNodeFromTree(root: BuilderGroupNode, path: BuilderPath): BuilderGroupNode {
  if (path.length === 0) return root
  const parentPath = path.slice(0, -1)
  const index = path.at(-1) as number
  return updateGroupAt(root, parentPath, (parent) => ({
    ...parent,
    children: parent.children.filter((_, i) => i !== index),
  }))
}

export function setGroupOpInTree(
  root: BuilderGroupNode,
  path: BuilderPath,
  op: 'And' | 'Or',
): BuilderGroupNode {
  return updateGroupAt(root, path, (group) => (group.op === op ? group : { ...group, op }))
}

export function toggleNegateInTree(root: BuilderGroupNode, path: BuilderPath): BuilderGroupNode {
  return updateNodeAt(root, path, (node) => ({ ...node, negated: !node.negated }))
}

/**
 * #1478 — a fresh empty root `And` group with the given id, for the mini-builder's
 * initial local state (a NON-frozen copy of `EMPTY_BUILDER`, so the local id
 * counter can seed a distinct root id and the tree is freely re-`set`).
 */
export function makeEmptyRoot(id = 0): BuilderGroupNode {
  return { kind: 'group', id, op: 'And', negated: false, children: [] }
}

/** Merge a partial controls patch into a space's slice (defaulting from EMPTY). */
function patchControls(
  state: AdvancedQueryState,
  spaceKey: string,
  patch: Partial<AdvancedQueryControls>,
): Record<string, AdvancedQueryControls> {
  const current = state.controlsBySpace[spaceKey] ?? EMPTY_CONTROLS
  return {
    ...state.controlsBySpace,
    [spaceKey]: { ...current, ...patch },
  }
}

export const useAdvancedQueryStore = create<AdvancedQueryState>()((set) => ({
  filtersBySpace: {},
  buildersBySpace: {},
  controlsBySpace: {},
  nextAddId: 0,
  addFilter: (spaceKey, filter) =>
    set((state) => {
      const current = state.filtersBySpace[spaceKey] ?? []
      // Dedupe: strip the React-key-only `_addId` and compare a stable JSON
      // serialisation. Re-applying a structurally-identical chip is a no-op —
      // it would ship a duplicate Leaf to the IPC (an AND of a condition with
      // itself) and add a redundant pill.
      const incoming = JSON.stringify(filter)
      if (current.some(({ _addId, ...rest }) => JSON.stringify(rest) === incoming)) {
        return state
      }
      const nextAddId = state.nextAddId + 1
      return {
        nextAddId,
        filtersBySpace: {
          ...state.filtersBySpace,
          [spaceKey]: [...current, { ...filter, _addId: nextAddId }],
        },
      }
    }),
  removeFilter: (spaceKey, index) =>
    set((state) => {
      const current = state.filtersBySpace[spaceKey] ?? []
      return {
        filtersBySpace: {
          ...state.filtersBySpace,
          [spaceKey]: current.filter((_, i) => i !== index),
        },
      }
    }),
  clearFilters: (spaceKey) =>
    set((state) => {
      const current = state.filtersBySpace[spaceKey] ?? []
      if (current.length === 0) return state
      return {
        filtersBySpace: { ...state.filtersBySpace, [spaceKey]: [] },
      }
    }),
  addLeaf: (spaceKey, path, primitive) =>
    set((state) => {
      const root = state.buildersBySpace[spaceKey] ?? EMPTY_BUILDER
      const id = state.nextAddId + 1
      const next = addLeafToTree(root, path, primitive, id)
      return {
        nextAddId: id,
        buildersBySpace: { ...state.buildersBySpace, [spaceKey]: next },
      }
    }),
  addGroup: (spaceKey, path) =>
    set((state) => {
      const root = state.buildersBySpace[spaceKey] ?? EMPTY_BUILDER
      const id = state.nextAddId + 1
      const next = addGroupToTree(root, path, id)
      return {
        nextAddId: id,
        buildersBySpace: { ...state.buildersBySpace, [spaceKey]: next },
      }
    }),
  removeNode: (spaceKey, path) =>
    set((state) => {
      // The root is never removed (it's the container); use `clearBuilder`.
      if (path.length === 0) return state
      const root = state.buildersBySpace[spaceKey] ?? EMPTY_BUILDER
      const next = removeNodeFromTree(root, path)
      return { buildersBySpace: { ...state.buildersBySpace, [spaceKey]: next } }
    }),
  setGroupOp: (spaceKey, path, op) =>
    set((state) => {
      const root = state.buildersBySpace[spaceKey] ?? EMPTY_BUILDER
      const next = setGroupOpInTree(root, path, op)
      if (next === root) return state
      return { buildersBySpace: { ...state.buildersBySpace, [spaceKey]: next } }
    }),
  toggleNegate: (spaceKey, path) =>
    set((state) => {
      const root = state.buildersBySpace[spaceKey] ?? EMPTY_BUILDER
      const next = toggleNegateInTree(root, path)
      return { buildersBySpace: { ...state.buildersBySpace, [spaceKey]: next } }
    }),
  clearBuilder: (spaceKey) =>
    set((state) => {
      const current = state.buildersBySpace[spaceKey]
      // Already pristine (no slice, or an empty default-shaped root) ⇒ no churn.
      if (
        current == null ||
        (current.children.length === 0 && current.op === 'And' && !current.negated)
      ) {
        return state
      }
      return {
        buildersBySpace: {
          ...state.buildersBySpace,
          [spaceKey]: EMPTY_BUILDER as BuilderGroupNode,
        },
      }
    }),
  setFulltext: (spaceKey, fulltext) =>
    set((state) => {
      const current = state.controlsBySpace[spaceKey] ?? EMPTY_CONTROLS
      if (current.fulltext === fulltext) return state
      return { controlsBySpace: patchControls(state, spaceKey, { fulltext }) }
    }),
  setSort: (spaceKey, sort) =>
    set((state) => ({ controlsBySpace: patchControls(state, spaceKey, { sort }) })),
  setGroupBy: (spaceKey, groupBy) =>
    set((state) => ({ controlsBySpace: patchControls(state, spaceKey, { groupBy }) })),
  setAggregates: (spaceKey, aggregates) =>
    set((state) => ({ controlsBySpace: patchControls(state, spaceKey, { aggregates }) })),
  loadView: (spaceKey, spec) =>
    set((state) => {
      // Mint fresh React-key ids from the shared monotonic counter so the
      // hydrated tree's node keys never collide with existing/other-space nodes.
      let id = state.nextAddId
      const allocId = (): number => {
        id += 1
        return id
      }
      const builder = filterExprToBuilderTree(spec.filter, allocId)
      const controls: AdvancedQueryControls = {
        fulltext: spec.fulltext,
        sort: spec.sort,
        groupBy: spec.group_by,
        aggregates: spec.aggregates,
      }
      return {
        nextAddId: id,
        buildersBySpace: { ...state.buildersBySpace, [spaceKey]: builder },
        controlsBySpace: { ...state.controlsBySpace, [spaceKey]: controls },
      }
    }),
}))
