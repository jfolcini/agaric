/**
 * Tag-query builder model + compile (#1426).
 *
 * The backend `eval_tag_query` engine can evaluate an arbitrary nested
 * `TagExpr` tree (`Tag` / `Prefix` leaves, `And` / `Or` / `Not` nodes — see
 * `src-tauri/src/tag_query/mod.rs`), but the only IPC the frontend can reach,
 * `query_by_tags`, takes a FLAT triple `(tagIds, prefixes, mode)`. The Rust
 * `TagExpr` enum derives neither `Deserialize` nor `specta::Type`, so it never
 * crosses the IPC boundary — there is no nested-expr command. `query_by_tags`
 * itself assembles only a SINGLE-LEVEL `And(..)` / `Or(..)` / `Not(Or(..))`
 * from its flat triple (see `query_by_tags_inner`).
 *
 * `TagFilterPanel` previously hardcoded `prefixes: []` and a single flat
 * `mode`, so prefix search was unreachable from the UI. This module closes that
 * gap WITHOUT touching the backend or its IPC, and — critically — only models
 * what the flat IPC can FAITHFULLY express:
 *
 *  - A single (non-nested) builder whose leaves are tag-ids and name-prefixes,
 *    combined with one combinator: `and` (every leaf), `or` (any leaf), or
 *    `not` (none of the leaves — i.e. `Not(Or(leaves))`).
 *
 * Deep nesting and per-leaf negation are deliberately NOT modelled: the flat
 * IPC cannot represent them, so a UI that let the user build them would
 * silently flatten/drop the structure and execute a DIFFERENT query than the
 * one on screen (misleading). If a nested-expr IPC ever lands, this can grow a
 * recursive node model again (mirroring the advanced-query builder, #1280).
 */

// ───────────────────────────── Wire shape ──────────────────────────────────

/** The flat parameters the `query_by_tags` IPC accepts. */
export interface TagQueryParams {
  tagIds: string[]
  prefixes: string[]
  /** `and` = every leaf, `or` = any leaf, `not` = none of the leaves. */
  mode: 'and' | 'or' | 'not'
}

// ──────────────────────────── Builder model ────────────────────────────────

/** A tag leaf — references a resolved tag by id (with a display name). */
export interface TagBuilderTagLeaf {
  kind: 'tag'
  /** Stable React-key-only id (from `nextTagBuilderId`). */
  id: number
  /** Resolved tag id this leaf compiles to (a `tagIds` entry). */
  tagId: string
  /** Display name for the chip (not sent to the engine). */
  name: string
}

/** A prefix leaf — a free-text tag-name prefix (a `prefixes` entry). */
export interface TagBuilderPrefixLeaf {
  kind: 'prefix'
  /** Stable React-key-only id. */
  id: number
  /** The prefix string this leaf compiles to. */
  prefix: string
}

export type TagBuilderLeaf = TagBuilderTagLeaf | TagBuilderPrefixLeaf

/**
 * The composer's single (non-nested) builder group: an ordered list of
 * tag/prefix leaves combined by one `mode`. This is the EXACT shape the flat
 * `query_by_tags` IPC can faithfully execute — no sub-groups, no per-leaf
 * negation.
 */
export interface TagBuilder {
  /** Combinator over the leaves. */
  mode: 'and' | 'or' | 'not'
  /** Ordered leaves (tags + prefixes). */
  leaves: TagBuilderLeaf[]
}

// ─────────────────────────── Stable-id source ──────────────────────────────

let nextId = 1
/** Monotonic id source for builder leaves (React keys only). */
export function nextTagBuilderId(): number {
  return nextId++
}

// ──────────────────────────── Constructors ─────────────────────────────────

export function makeTagLeaf(tagId: string, name: string): TagBuilderTagLeaf {
  return { kind: 'tag', id: nextTagBuilderId(), tagId, name }
}

export function makePrefixLeaf(prefix: string): TagBuilderPrefixLeaf {
  return { kind: 'prefix', id: nextTagBuilderId(), prefix }
}

/** A fresh empty builder (`and`, no leaves). */
export function emptyTagBuilder(): TagBuilder {
  return { mode: 'and', leaves: [] }
}

// ──────────────────────── Immutable updates ─────────────────────────────────

/** Append a leaf to the builder (immutably). */
export function addLeaf(builder: TagBuilder, leaf: TagBuilderLeaf): TagBuilder {
  return { ...builder, leaves: [...builder.leaves, leaf] }
}

/** Remove the leaf with `id` from the builder (immutably). */
export function removeLeaf(builder: TagBuilder, id: number): TagBuilder {
  return { ...builder, leaves: builder.leaves.filter((l) => l.id !== id) }
}

/** Set the builder's combinator (immutably). */
export function setMode(builder: TagBuilder, mode: TagBuilder['mode']): TagBuilder {
  return { ...builder, mode }
}

// ────────────────────────────── Compile ────────────────────────────────────

/** Does the builder carry any leaf (tag or prefix)? */
export function tagBuilderHasLeaves(builder: TagBuilder): boolean {
  return builder.leaves.length > 0
}

/**
 * Compile the builder to the flat `query_by_tags` IPC params. Lossless: the
 * builder is constrained to exactly what the IPC can execute, so what the user
 * sees on screen is what the engine runs.
 */
export function compileTagBuilder(builder: TagBuilder): TagQueryParams {
  const tagIds: string[] = []
  const prefixes: string[] = []
  for (const leaf of builder.leaves) {
    if (leaf.kind === 'tag') tagIds.push(leaf.tagId)
    else prefixes.push(leaf.prefix)
  }
  return { tagIds, prefixes, mode: builder.mode }
}
