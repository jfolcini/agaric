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

/** The rows of `folded` whose folds hold the row at `target`, however far up. */
export function foldsOver(outline: Outline, target: number, folded: Iterable<number>): number[] {
  const over: number[] = []
  for (const index of folded) {
    if (index < target && foldEnd(outline, index) > target) over.push(index)
  }
  return over
}

/** A flat tree's rows as an outline. */
export function outlineOf(
  rows: readonly { depth: number; content?: string | null | undefined }[],
): Outline {
  return {
    length: rows.length,
    depth: (index) => (rows[index] as { depth: number }).depth,
    level: (index) => headingLevel(rows[index]?.content),
  }
}
