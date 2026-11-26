/**
 * What a fold hides (#7040 S5b). A page is a flat outline: each row has a
 * depth, and a heading row a level. A row's fold hides the rows under it; a
 * heading's goes on past them through the rows after it at its depth (its
 * section), up to the next heading of the same or a higher level, or the end
 * of its parent. Folds are block folds' own layout: a folded heading's section
 * keeps every fold inside it as it was.
 */

/** A page's rows, read by index: block mode's flat tree, page mode's document. */
export interface Outline {
  readonly length: number
  id: (index: number) => string
  depth: (index: number) => number
  /** A heading's level (1 to 6); null for any other row. */
  level: (index: number) => number | null
}

const HEADING_RE = /^(#{1,6})[ \t]/

/** The level of the heading a block's text opens with; null where it opens with none. */
export function headingLevel(content: string | null | undefined): number | null {
  const marks = content?.match(HEADING_RE)?.[1]
  return marks === undefined ? null : marks.length
}

/** Whether the row at `next` ends the fold of the row at `index`. */
function ends(outline: Outline, index: number, next: number): boolean {
  const depth = outline.depth(index)
  const nextDepth = outline.depth(next)
  if (nextDepth !== depth) return nextDepth < depth
  const level = outline.level(index)
  if (level === null) return true
  const nextLevel = outline.level(next)
  return nextLevel !== null && nextLevel <= level
}

/** The index just past what the row at `index` folds; `index + 1` when it folds nothing. */
export function foldEnd(outline: Outline, index: number): number {
  let end = index + 1
  while (end < outline.length && !ends(outline, index, end)) end += 1
  return end
}

/** Whether the row at `index` has something to fold. */
export function canFold(outline: Outline, index: number): boolean {
  return index + 1 < outline.length && !ends(outline, index, index + 1)
}

/** Each row's flag: whether a folded row above it hides it. */
export function hiddenRows(outline: Outline, folded: (index: number) => boolean): boolean[] {
  const hidden: boolean[] = []
  // The end of the outermost fold hiding rows now; nothing hides past it.
  let hideUntil = 0
  for (let index = 0; index < outline.length; index += 1) {
    hidden.push(index < hideUntil)
    if (index >= hideUntil && folded(index)) hideUntil = foldEnd(outline, index)
  }
  return hidden
}

/** The rows at its depth the fold of the row at `index` hides: the siblings its drag carries. */
export function foldedSiblingsAt(outline: Outline, index: number): string[] {
  const depth = outline.depth(index)
  const end = foldEnd(outline, index)
  const siblings: string[] = []
  for (let row = index + 1; row < end; row += 1) {
    if (outline.depth(row) === depth) siblings.push(outline.id(row))
  }
  return siblings
}

/**
 * `roots` in document order, each of `collapsed` followed by the siblings its
 * fold hides: a selection takes a folded heading's section with it, as its
 * drag does (#7040 decision 30).
 */
export function withFoldedSections(
  outline: Outline,
  roots: readonly string[],
  collapsed: ReadonlySet<string>,
): string[] {
  const picked = new Set(roots)
  const result = new Set<string>()
  for (let index = 0; index < outline.length; index += 1) {
    const id = outline.id(index)
    if (!picked.has(id) || result.has(id)) continue
    result.add(id)
    if (collapsed.has(id))
      for (const sibling of foldedSiblingsAt(outline, index)) result.add(sibling)
  }
  return [...result]
}

/**
 * The index just past what a move of the row at `index` takes: its fold if
 * `folded`, else the rows under it.
 */
export function carriedEnd(outline: Outline, index: number, folded: boolean): number {
  if (folded) return foldEnd(outline, index)
  const depth = outline.depth(index)
  let end = index + 1
  while (end < outline.length && outline.depth(end) > depth) end += 1
  return end
}

/**
 * A move of the row at `index` one shown row up (-1) or down (1), as a drop
 * there makes it: the rows from `index` to `end`, what it carries, go before the
 * row at `to`, past the sibling next to them and what that one carries (`carry`,
 * `carriedEnd` per row). `to` is null where no sibling is that way.
 */
export function stepOver(
  outline: Outline,
  carry: (index: number) => number,
  index: number,
  direction: -1 | 1,
): { end: number; to: number | null } {
  const depth = outline.depth(index)
  const end = carry(index)
  if (direction > 0) {
    const sibling = end < outline.length && outline.depth(end) === depth
    return { end, to: sibling ? carry(end) : null }
  }
  let unit = index
  while (unit > 0 && outline.depth(unit - 1) >= depth) unit -= 1
  if (unit === index) return { end, to: null }
  // Each sibling shown carries the ones it hides; the last before `index` is the neighbour.
  while (carry(unit) < index) unit = carry(unit)
  return { end, to: unit }
}

/**
 * The ids of `collapsed` whose folds hold the row `targetId`, however far up,
 * outermost first; none where no row is `targetId`.
 */
export function foldsOver(
  outline: Outline,
  targetId: string,
  collapsed: ReadonlySet<string>,
): string[] {
  if (collapsed.size === 0) return []
  // The folds open at the row read, innermost last: a fold ends no later than the one holding it.
  const open: number[] = []
  for (let index = 0; index < outline.length; index += 1) {
    while (open.length > 0 && ends(outline, open.at(-1) as number, index)) open.pop()
    const id = outline.id(index)
    if (id === targetId) return open.map((fold) => outline.id(fold))
    if (collapsed.has(id)) open.push(index)
  }
  return []
}

/**
 * The collapsed headings to unfold after a move from `before` to `after`: each
 * whose fold holds a row `before` showed (#7040 decision 30, a block moved or
 * dropped into a folded section unfolds it). A block fold does not unfold.
 */
export function unfoldedBy(
  before: Outline,
  after: Outline,
  collapsed: ReadonlySet<string>,
): string[] {
  if (collapsed.size === 0) return []
  const hidden = hiddenRows(before, (index) => collapsed.has(before.id(index)))
  const shown = new Set<string>()
  for (let index = 0; index < before.length; index += 1) {
    if (!hidden[index]) shown.add(before.id(index))
  }
  const unfold = new Set<string>()
  const open: number[] = []
  for (let index = 0; index < after.length; index += 1) {
    while (open.length > 0 && ends(after, open.at(-1) as number, index)) open.pop()
    const id = after.id(index)
    if (shown.has(id)) {
      for (const fold of open) if (after.level(fold) !== null) unfold.add(after.id(fold))
    }
    if (collapsed.has(id)) open.push(index)
  }
  return [...unfold]
}

/** A flat tree's rows as an outline. */
export function outlineOf(
  rows: readonly { id: string; depth: number; content?: string | null | undefined }[],
): Outline {
  return {
    length: rows.length,
    id: (index) => (rows[index] as { id: string }).id,
    depth: (index) => (rows[index] as { depth: number }).depth,
    level: (index) => headingLevel(rows[index]?.content),
  }
}
