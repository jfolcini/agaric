/**
 * Block-subtree ⇄ indented-markdown serialization (#913).
 *
 * The system clipboard carries plain text, so a block "copy" that preserves
 * structure (the Logseq / Workflowy / Roam standard) encodes the selected
 * blocks + their subtrees as an INDENTED markdown outline: one block per line,
 * each child indented under its parent by {@link INDENT_UNIT} spaces per level.
 * Paste reverses the encoding into a flat list of block specs with relative
 * parent/index pointers, which the store materializes into real blocks.
 *
 * This is deliberately a SEPARATE indentation grammar from
 * `editor/markdown-serializer.ts` (which converts ONE block's content
 * ⇄ ProseMirror JSON). A block's own content is single-line markdown; the
 * outline indentation here expresses the block TREE, not inline marks. Each
 * line's text is the block's raw `content` verbatim — we do not re-serialize
 * it, so refs/marks/headings round-trip untouched.
 */

import type { FlatBlock } from './tree-utils'
import { computeSelectionRoots, getDragDescendants } from './tree-utils'

/** Spaces per indent level — the repo's outline convention (2-space indent). */
export const INDENT_UNIT = 2

// ── Human-readable reference rendering (export/clipboard only, #1440) ─────────

/**
 * Inline reference-token regexes. These mirror the canonical patterns the
 * markdown serializer EMITS (`src/editor/markdown-serialize.ts`) and the Rust
 * page-export resolver consumes (`src-tauri/src/cache/mod.rs`:
 * `TAG_REF_RE` / `PAGE_LINK_RE`, plus the `((ULID))` block-ref delimiter).
 * ULIDs are always 26 uppercase Crockford-base32 chars in canonical form, so
 * the character class is intentionally `[0-9A-Z]` (no lowercase).
 *
 * Kept verbatim-aligned with the Rust regexes so the clipboard/copy rendering
 * is byte-identical to what page-export produces for `#[ULID]` and `[[ULID]]`.
 */
const TAG_REF_RE = /#\[([0-9A-Z]{26})\]/g
const PAGE_LINK_RE = /\[\[([0-9A-Z]{26})\]\]/g
const BLOCK_REF_RE = /\(\(([0-9A-Z]{26})\)\)/g

/**
 * Resolve an internal-reference ULID to a human-readable name for export.
 *
 * Returns the display name (page title / tag name / block snippet) when the
 * ULID is known, or `undefined` when it is not — a `undefined` (dangling)
 * result tells {@link humanizeRefTokens} to fall back to the opaque ULID form,
 * so a broken/cross-space reference is never dropped or made to crash.
 */
export type RefResolver = (ulid: string) => string | undefined

/**
 * Rewrite the opaque-ULID reference tokens in a single block's content into
 * the human-readable forms used by page-export (#1440):
 *
 *   `#[ULID]`   → `#tag`          (tag reference)
 *   `[[ULID]]`  → `[[Page Name]]` (block/page link)
 *   `((ULID))`  → `((Name))`      (block reference)
 *
 * Resolution REUSES the same name source page-export uses (the title/tag
 * resolver) via the injected {@link RefResolver}; this function only renders.
 *
 * A ULID the resolver cannot resolve (a dangling ref, or a block-ref target
 * whose content isn't cached — page-export likewise leaves those verbatim)
 * falls back GRACEFULLY to the original ULID token, exactly like the Rust
 * `resolve_ulids_for_export` "keep original if not found" branch. Nothing is
 * dropped and no exception is thrown.
 *
 * This is a pure rendering pass over an EXPORT copy of the content; the stored
 * canonical block content (ULID-based) is never mutated.
 */
export function humanizeRefTokens(content: string, resolve: RefResolver): string {
  // Tag refs first, then page links, then block refs — the three token shapes
  // are disjoint, so ordering is immaterial for correctness; it just mirrors
  // the Rust resolver's tag→page sequence for readability.
  return content
    .replace(TAG_REF_RE, (match, ulid: string) => {
      const name = resolve(ulid)
      return name === undefined ? match : `#${name}`
    })
    .replace(PAGE_LINK_RE, (match, ulid: string) => {
      const name = resolve(ulid)
      return name === undefined ? match : `[[${name}]]`
    })
    .replace(BLOCK_REF_RE, (match, ulid: string) => {
      const name = resolve(ulid)
      return name === undefined ? match : `((${name}))`
    })
}

/**
 * A parsed clipboard block: its content and a pointer to its parent's index in
 * the SAME parsed list (`null` = top-level / paste root). Children always
 * appear AFTER their parent in document order, so a parent index is always
 * already resolved when a child references it.
 */
export interface ParsedBlock {
  content: string
  /** Index of the parent in the parsed array, or `null` for a top-level block. */
  parentIndex: number | null
}

// ── Serialize: block subtree → indented markdown ─────────────────────────────

/**
 * Serialize the selection ROOTS (+ their subtrees) to an indented-markdown
 * outline. `selectedIds` may contain blocks already nested inside other
 * selected blocks — {@link computeSelectionRoots} collapses those so each
 * subtree is emitted exactly once.
 *
 * Indentation is RELATIVE: the shallowest emitted block sits at indent 0 and
 * every other block is indented by `(depth - baseDepth)` levels, so copying a
 * deeply-nested selection pastes back at the top level with its internal
 * structure intact. Blocks are emitted in document order (their order in the
 * flat `items` list).
 *
 * Returns the empty string when nothing is selected / nothing matches.
 *
 * `humanize` (#1440) — optional reference renderer. When supplied, each block's
 * content has its opaque-ULID reference tokens rewritten to human-readable
 * names (`[[Page Name]]` / `#tag` / `((Name))`) via {@link humanizeRefTokens},
 * matching what page-export emits. This is for the SYSTEM-CLIPBOARD copy path
 * only; the internal copy→paste round-trips (duplicate, context-menu paste)
 * call WITHOUT it so block content stays ULID-canonical for re-import. Omitting
 * it preserves the original verbatim-content behaviour exactly.
 */
export function serializeBlockSubtree(
  items: FlatBlock[],
  selectedIds: Iterable<string>,
  humanize?: RefResolver,
): string {
  const roots = computeSelectionRoots(items, selectedIds)
  if (roots.length === 0) return ''

  // Collect each root + its descendants, preserving document order. A Set keeps
  // the emission idempotent if (defensively) a descendant is also a root.
  const emit = new Set<string>()
  for (const rootId of roots) {
    emit.add(rootId)
    for (const descId of getDragDescendants(items, rootId)) emit.add(descId)
  }

  const emitted = items.filter((b) => emit.has(b.id))
  if (emitted.length === 0) return ''

  // Baseline = shallowest emitted depth, so the outline always starts at 0.
  const baseDepth = emitted.reduce((min, b) => Math.min(min, b.depth), Number.POSITIVE_INFINITY)

  return emitted
    .map((b) => {
      const indent = ' '.repeat(INDENT_UNIT * (b.depth - baseDepth))
      const content = b.content ?? ''
      return indent + (humanize ? humanizeRefTokens(content, humanize) : content)
    })
    .join('\n')
}

// ── Parse: indented markdown → block specs ───────────────────────────────────

/**
 * Measure a line's leading-space indentation in INDENT units (floored), and
 * return the content with that indentation stripped. Tabs are each counted as
 * one indent unit (a pragmatic stance — pasted outlines from other tools mix
 * tabs and spaces); any remaining leading whitespace stays in the content.
 */
function measureIndent(line: string): { level: number; content: string } {
  let spaces = 0
  let i = 0
  for (; i < line.length; i++) {
    const ch = line[i]
    if (ch === ' ') spaces += 1
    else if (ch === '\t') spaces += INDENT_UNIT
    else break
  }
  return { level: Math.floor(spaces / INDENT_UNIT), content: line.slice(i) }
}

/**
 * Parse an indented-markdown outline into a flat list of {@link ParsedBlock}s
 * with relative parent pointers.
 *
 * The algorithm walks lines top-to-bottom keeping a stack of "open ancestor"
 * indices keyed by indent level. A line at level `L` becomes a child of the
 * most recent earlier line at level `< L` (clamped so a jump of >1 level does
 * not orphan it). Blank lines are skipped — they carry no block. Indentation
 * deeper than the current context is clamped to one level deeper than the
 * parent, so adversarial / hand-typed over-indentation can't create gaps in
 * the parent chain.
 *
 * Returns `[]` for empty / whitespace-only input — callers treat that as
 * "nothing recognizable" and fall back to a single-block paste.
 */
export function parseIndentedMarkdown(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  // `stack[level]` = index in `blocks` of the most recent block opened AT that
  // level. Truncated whenever we dedent so stale deeper entries can't be reused.
  const stack: number[] = []

  for (const rawLine of text.split('\n')) {
    if (rawLine.trim() === '') continue
    const { level: rawLevel, content } = measureIndent(rawLine)
    // Clamp the level so a block can be at most one level deeper than the
    // deepest currently-open ancestor (no orphaning jumps).
    const level = Math.min(rawLevel, stack.length)

    const parentIndex = level > 0 ? (stack[level - 1] ?? null) : null
    const myIndex = blocks.length
    blocks.push({ content, parentIndex })

    // This block is now the open ancestor at its level; everything deeper is
    // closed (a later sibling/child re-opens as needed).
    stack.length = level
    stack[level] = myIndex
  }

  return blocks
}
