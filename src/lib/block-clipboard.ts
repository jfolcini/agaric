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
 */
export function serializeBlockSubtree(items: FlatBlock[], selectedIds: Iterable<string>): string {
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
      return indent + (b.content ?? '')
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
