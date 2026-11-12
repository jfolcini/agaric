/**
 * Advanced-query working set (#1280): the chips, the nested And/Or/Not builder
 * tree and the sort, group, aggregate and full-text controls of
 * `AdvancedQueryView`. Kept apart from the Pages chip store so the two
 * surfaces do not share a working set, partitioned by space because values
 * hold space-scoped ids, and not persisted: it clears on restart.
 */

import { create } from 'zustand'

import type { AggregateSpec, FilterExpr, FilterPrimitive, GroupSpec, SortKey } from '@/lib/bindings'
import type { PageFilterWithKey } from '@/lib/filters/page-filter-with-key'
import { isFilterExpr } from '@/lib/inline-query-spec'
import { LEGACY_SPACE_KEY } from '@/stores/space'

/*
 * The builder tree is decoupled from the wire `FilterExpr`: a group holds its
 * own `op` and an ordered child list the UI edits directly, and
 * `builderTreeToFilterExpr` compiles it. Node ids come from the store's
 * monotonic `nextAddId`, React keys only.
 */

/** A single filter-primitive leaf in the builder tree. */
export interface BuilderLeafNode {
  kind: 'leaf'
  /** React-key-only id (from `nextAddId`). */
  id: number
  /** The wire primitive this leaf compiles to (`{type:'Leaf', primitive}`). */
  primitive: FilterPrimitive
  /** When true, the compiled leaf is wrapped in `{type:'Not', child}`. */
  negated: boolean
}

/** A boolean group (And/Or over its children), optionally negated. */
export interface BuilderGroupNode {
  kind: 'group'
  /** React-key-only id (from `nextAddId`). */
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
 * Child indices from the root group: `[]` is the root, `[0, 2]` the third
 * child of its first child (which must be a group).
 */
export type BuilderPath = readonly number[]

/**
 * Compile one node: a leaf to `Leaf`, a group to `And`/`Or` over its compiled
 * children (an empty one is the engine's TRUE or FALSE), and `negated` wraps
 * the result in `Not`, outermost.
 */
function compileNode(node: BuilderNode): FilterExpr {
  const inner: FilterExpr =
    node.kind === 'leaf'
      ? { type: 'Leaf', primitive: node.primitive }
      : { type: node.op, children: node.children.map(compileNode) }
  return node.negated ? { type: 'Not', child: inner } : inner
}

/** Compile the builder tree; the default empty root `And` matches everything. */
export function builderTreeToFilterExpr(root: BuilderGroupNode): FilterExpr {
  return compileNode(root)
}

/**
 * Inverse of {@link compileNode} for saved views (#1460). A leading `Not` sets
 * `negated` on what it wraps; a doubled `Not` toggles back, keeping the
 * three-valued semantics. `allocId` mints the React-key ids, which compile drops.
 */
function filterExprToBuilderNode(expr: FilterExpr, allocId: () => number): BuilderNode {
  if (expr.type === 'Not') {
    const inner = filterExprToBuilderNode(expr.child, allocId)
    return { ...inner, negated: !inner.negated }
  }
  if (expr.type === 'Leaf') {
    return { kind: 'leaf', id: allocId(), primitive: expr.primitive, negated: false }
  }
  return {
    kind: 'group',
    id: allocId(),
    op: expr.type,
    negated: false,
    children: expr.children.map((child) => filterExprToBuilderNode(child, allocId)),
  }
}

/**
 * Rebuild a root group from a saved `FilterExpr` (#1460). The root must be a
 * group, so a hand-written spec with a leaf root is wrapped in an `And`.
 */
export function filterExprToBuilderTree(expr: FilterExpr, allocId: () => number): BuilderGroupNode {
  const node = filterExprToBuilderNode(expr, allocId)
  if (node.kind === 'group') return node
  return { kind: 'group', id: allocId(), op: 'And', negated: false, children: [node] }
}

/**
 * A saved view's JSON (`PREFERENCES.savedQueryViews`, #1460): the whole
 * working state except pagination.
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

/** The builder tree and controls as a {@link SavedQuerySpec}. */
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
 * Parse a saved view's spec JSON. Throws on malformed JSON or an invalid
 * `filter`, so the caller toasts rather than hydrate a half-built view.
 */
export function parseQuerySpec(raw: string): SavedQuerySpec {
  const parsed: unknown = JSON.parse(raw)
  const spec = (
    typeof parsed === 'object' && parsed !== null ? parsed : {}
  ) as Partial<SavedQuerySpec>
  const { filter } = spec
  if (!isFilterExpr(filter)) {
    throw new Error('saved view is missing a valid filter expression')
  }
  return {
    filter,
    sort: Array.isArray(spec.sort) ? spec.sort : [],
    fulltext: typeof spec.fulltext === 'string' ? spec.fulltext : '',
    group_by: spec.group_by ?? null,
    aggregates: Array.isArray(spec.aggregates) ? spec.aggregates : [],
  }
}

/** The non-chip controls, per space and not persisted, like the chips. */
export interface AdvancedQueryControls {
  /**
   * Full-text term; empty means none. When set, the engine intersects an FTS5
   * `MATCH` and `SortSource::Relevance` becomes valid.
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
  /** Per-space builder trees, keyed by space id. */
  buildersBySpace: Record<string, BuilderGroupNode>
  /** Per-space non-chip controls (fulltext/sort/groupBy/aggregates). */
  controlsBySpace: Record<string, AdvancedQueryControls>
  /** Monotonic source of chip `_addId`s and node ids, so React keys stay unique. */
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
   * Replace a space's builder tree and controls from a saved view (#1460),
   * minting fresh node ids so they never collide with existing keys.
   */
  loadView: (spaceKey: string, spec: SavedQuerySpec) => void
}

/** Stable empty fallback: a fresh `[]` per call would fail `Object.is` and re-render every consumer. */
const EMPTY_FILTERS: readonly PageFilterWithKey[] = Object.freeze([])

/** Stable default controls, frozen through, for the same reason. */
const EMPTY_SORT: readonly SortKey[] = Object.freeze([])
const EMPTY_AGGREGATES: readonly AggregateSpec[] = Object.freeze([])
const EMPTY_CONTROLS: Readonly<AdvancedQueryControls> = Object.freeze({
  fulltext: '',
  sort: EMPTY_SORT as SortKey[],
  groupBy: null,
  aggregates: EMPTY_AGGREGATES as AggregateSpec[],
})

/**
 * The default builder, one empty root `And` ("match everything"), frozen and
 * shared as the stable fallback. Its id `0` is one `nextAddId` never issues.
 */
const EMPTY_BUILDER: Readonly<BuilderGroupNode> = Object.freeze({
  kind: 'group',
  id: 0,
  op: 'And',
  negated: false,
  children: Object.freeze([]) as unknown as BuilderNode[],
})

/** Per-space chips; a null space maps to `__legacy__`. */
export function selectAdvancedQueryFiltersForSpace(
  state: AdvancedQueryState,
  spaceId: string | null,
): PageFilterWithKey[] {
  const key = spaceId ?? LEGACY_SPACE_KEY
  return state.filtersBySpace[key] ?? (EMPTY_FILTERS as PageFilterWithKey[])
}

/** Per-space controls, or the stable defaults. */
export function selectAdvancedQueryControlsForSpace(
  state: AdvancedQueryState,
  spaceId: string | null,
): AdvancedQueryControls {
  const key = spaceId ?? LEGACY_SPACE_KEY
  return state.controlsBySpace[key] ?? (EMPTY_CONTROLS as AdvancedQueryControls)
}

/** Per-space builder tree, or the stable default. */
export function selectAdvancedQueryBuilderForSpace(
  state: AdvancedQueryState,
  spaceId: string | null,
): BuilderGroupNode {
  const key = spaceId ?? LEGACY_SPACE_KEY
  return state.buildersBySpace[key] ?? (EMPTY_BUILDER as BuilderGroupNode)
}

/**
 * Copy the path from the root to the group at `path` and apply `mutate` to it;
 * untouched subtrees keep their identity. A path through a leaf or out of range
 * throws: paths come from the rendered tree, so that is a programmer error.
 */
function updateGroupAt(
  root: BuilderGroupNode,
  path: BuilderPath,
  mutate: (group: BuilderGroupNode) => BuilderGroupNode,
): BuilderGroupNode {
  if (path.length === 0) return mutate(root)
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

/** Apply `mutate` to the node, leaf or group, at `path`; throws as `updateGroupAt` does. */
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
 * Pure tree edits, shared by the store and the `has-parent-matching`
 * mini-builder, which keeps its own tree and id counter (#1478). The caller
 * passes the new node's id.
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

/** A fresh, unfrozen empty root `And` for the mini-builder's local state (#1478). */
export function makeEmptyRoot(id = 0): BuilderGroupNode {
  return { kind: 'group', id, op: 'And', negated: false, children: [] }
}

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
      // A structurally identical chip would AND a condition with itself.
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
      // Fresh ids, so the loaded tree's keys collide with no existing node.
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
