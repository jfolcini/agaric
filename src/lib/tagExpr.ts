/**
 * Tag-query builder model + compile (#1426).
 *
 * The backend `eval_tag_query` engine evaluates an arbitrary nested `TagExpr`
 * tree (`Tag` / `Prefix` leaves, `And` / `Or` / `Not` nodes — see
 * `src-tauri/src/tag_query/mod.rs`). Since #1472 that tree crosses the IPC
 * boundary: the `query_by_tag_expr` command (wrapped as `queryByTagExpr` in
 * `@/lib/tauri`) accepts the adjacently-tagged wire shape
 * (`{ type: "Tag" | "Prefix" | "And" | "Or" | "Not"; value }`) and resolves it
 * with full nesting + per-node negation.
 *
 * `TagFilterPanel` exposes two query surfaces:
 *
 *  1. The FLAT default (`query_by_tags`): selected-tag chips + prefix pills
 *     under a single `and` / `or` / `not` mode. See {@link TagQueryParams} and
 *     {@link compileFlatParams}. Unchanged for users who never open the
 *     composer.
 *
 *  2. The nested COMPOSER (`query_by_tag_expr`, #1472): a recursive builder of
 *     groups (an `And` / `Or` combinator over children) and leaves (a resolved
 *     `Tag` or a name `Prefix`), where any node can carry a `NOT`. This module
 *     models that builder ({@link TagBuilderNode}) and compiles it LOSSLESSLY
 *     to a {@link TagExpr} tree the IPC runs — so `(A AND B) OR (NOT C)` on
 *     screen is exactly the tree the resolver evaluates.
 */

import type { TagExpr } from '@/lib/bindings'

// ───────────────────────────── Flat wire shape ─────────────────────────────

/** The flat parameters the `query_by_tags` IPC accepts (simple/flat mode). */
export interface TagQueryParams {
  tagIds: string[]
  prefixes: string[]
  /** `and` = every leaf, `or` = any leaf, `not` = none of the leaves. */
  mode: 'and' | 'or' | 'not'
}

/** The combinator a composer group applies over its children. */
export type TagBuilderOp = 'and' | 'or'

// ──────────────────────────── Builder model ────────────────────────────────

/** A leaf referencing a resolved tag by id (with a display name for the chip). */
export interface TagBuilderTagLeaf {
  kind: 'tag'
  /** Stable React-key-only id (from `nextTagBuilderId`). */
  id: number
  /** Negate this leaf (`Not(Tag(..))`). */
  negated: boolean
  /** Resolved tag id this leaf compiles to. */
  tagId: string
  /** Display name for the chip (not sent to the engine). */
  name: string
}

/** A leaf holding a free-text tag-name prefix (`Prefix(..)`). */
export interface TagBuilderPrefixLeaf {
  kind: 'prefix'
  /** Stable React-key-only id. */
  id: number
  /** Negate this leaf (`Not(Prefix(..))`). */
  negated: boolean
  /** The prefix string this leaf compiles to. */
  prefix: string
}

/**
 * A group node: an ordered list of children combined by one `op` (`and`/`or`),
 * optionally negated as a whole (`Not(And(..))`). Children may themselves be
 * groups, giving arbitrary nesting.
 */
export interface TagBuilderGroup {
  kind: 'group'
  /** Stable React-key-only id. */
  id: number
  /** Negate the whole group (`Not(And(..))` / `Not(Or(..))`). */
  negated: boolean
  /** Combinator over the children. */
  op: TagBuilderOp
  /** Ordered children (leaves and sub-groups). */
  children: TagBuilderNode[]
}

export type TagBuilderLeaf = TagBuilderTagLeaf | TagBuilderPrefixLeaf
export type TagBuilderNode = TagBuilderLeaf | TagBuilderGroup

// ─────────────────────────── Stable-id source ──────────────────────────────

let nextId = 1
/** Monotonic id source for builder nodes (React keys only). */
export function nextTagBuilderId(): number {
  return nextId++
}

// ──────────────────────────── Constructors ─────────────────────────────────

export function makeTagLeaf(tagId: string, name: string): TagBuilderTagLeaf {
  return { kind: 'tag', id: nextTagBuilderId(), negated: false, tagId, name }
}

export function makePrefixLeaf(prefix: string): TagBuilderPrefixLeaf {
  return { kind: 'prefix', id: nextTagBuilderId(), negated: false, prefix }
}

/** A fresh empty group (`and`, no children, not negated). */
export function makeGroup(op: TagBuilderOp = 'and'): TagBuilderGroup {
  return { kind: 'group', id: nextTagBuilderId(), negated: false, op, children: [] }
}

/** The composer's root group. */
export function emptyTagBuilder(): TagBuilderGroup {
  return makeGroup('and')
}

// ──────────────────────── Immutable tree updates ───────────────────────────

/** Append `child` to the group identified by `groupId` (immutably). */
export function addChild(
  root: TagBuilderGroup,
  groupId: number,
  child: TagBuilderNode,
): TagBuilderGroup {
  return mapGroup(root, groupId, (g) => ({ ...g, children: [...g.children, child] }))
}

/** Remove the node `nodeId` from anywhere in the tree (immutably). */
export function removeNode(root: TagBuilderGroup, nodeId: number): TagBuilderGroup {
  const prune = (group: TagBuilderGroup): TagBuilderGroup => ({
    ...group,
    children: group.children
      .filter((c) => c.id !== nodeId)
      .map((c) => (c.kind === 'group' ? prune(c) : c)),
  })
  return prune(root)
}

/** Set the combinator of the group `groupId` (immutably). */
export function setGroupOp(
  root: TagBuilderGroup,
  groupId: number,
  op: TagBuilderOp,
): TagBuilderGroup {
  return mapGroup(root, groupId, (g) => ({ ...g, op }))
}

/** Toggle the `negated` flag of any node `nodeId` (immutably). */
export function toggleNegated(root: TagBuilderGroup, nodeId: number): TagBuilderGroup {
  const walk = (node: TagBuilderNode): TagBuilderNode => {
    let next: TagBuilderNode = node
    if (node.id === nodeId) next = { ...node, negated: !node.negated }
    if (next.kind === 'group') {
      return { ...next, children: next.children.map(walk) }
    }
    return next
  }
  // Root is always a group; walk preserves that.
  return walk(root) as TagBuilderGroup
}

/** Apply `fn` to the group matching `groupId`, recursing into sub-groups. */
function mapGroup(
  group: TagBuilderGroup,
  groupId: number,
  fn: (g: TagBuilderGroup) => TagBuilderGroup,
): TagBuilderGroup {
  const recursed: TagBuilderGroup = {
    ...group,
    children: group.children.map((c) => (c.kind === 'group' ? mapGroup(c, groupId, fn) : c)),
  }
  return recursed.id === groupId ? fn(recursed) : recursed
}

// ────────────────────────────── Compile ────────────────────────────────────

/** Does the node carry at least one resolvable leaf (tag or prefix)? */
export function tagBuilderHasLeaves(node: TagBuilderNode): boolean {
  if (node.kind !== 'group') return true
  return node.children.some(tagBuilderHasLeaves)
}

/**
 * Wrap `expr` in `Not(..)` when `negated`. Centralises the per-node negation so
 * leaves and groups negate identically.
 */
function negate(expr: TagExpr, negated: boolean): TagExpr {
  return negated ? { type: 'Not', value: expr } : expr
}

/**
 * Compile a builder node to a {@link TagExpr}, or `null` when the node carries
 * no resolvable leaf (an empty group, or a group whose children are all empty).
 * Empty children are dropped so a half-built group never injects a vacuous
 * `And([])` / `Or([])` into the tree.
 */
export function compileNode(node: TagBuilderNode): TagExpr | null {
  if (node.kind === 'tag') {
    return negate({ type: 'Tag', value: node.tagId }, node.negated)
  }
  if (node.kind === 'prefix') {
    const trimmed = node.prefix.trim()
    if (!trimmed) return null
    return negate({ type: 'Prefix', value: trimmed }, node.negated)
  }
  // Group: compile non-empty children, then combine.
  const compiled = node.children.map(compileNode).filter((e): e is TagExpr => e !== null)
  if (compiled.length === 0) return null
  // A single child collapses to that child (no vacuous And([x])/Or([x]) wrapper),
  // keeping the tree minimal and the negation crisp.
  const combined: TagExpr =
    compiled.length === 1
      ? (compiled[0] as TagExpr)
      : { type: node.op === 'and' ? 'And' : 'Or', value: compiled }
  return negate(combined, node.negated)
}

/**
 * Compile the composer root to a {@link TagExpr}, or `null` when it carries no
 * leaf yet (so the panel can leave the query idle until the user adds one).
 */
export function compileTagExpr(root: TagBuilderGroup): TagExpr | null {
  return compileNode(root)
}

/**
 * Lower the flat (simple-mode) inputs onto the `query_by_tags` IPC params.
 * Unchanged simple-mode path: selected-tag ids + prefix pills under one mode.
 */
export function compileFlatParams(
  tagIds: string[],
  prefixes: string[],
  mode: TagQueryParams['mode'],
): TagQueryParams {
  return { tagIds, prefixes, mode }
}
