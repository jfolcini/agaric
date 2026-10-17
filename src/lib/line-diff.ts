/**
 * A line diff of two texts, and the words that changed inside a changed line,
 * for *Edit as Markdown*'s Changes view. Lines split on `\n`, `\r\n` or `\r`,
 * so a text's last line break is a line of its own, as the buffer holds it.
 * A change is a hunk: a run of removed and added lines between unchanged ones.
 *
 * The Myers diff is jsdiff's, capped so a page rewritten end to end is one
 * hunk of every line rather than a long stall: past `MAX_LINE_EDITS` changed
 * lines, or `MAX_WORD_EDITS` changed words in a line, the whole run counts.
 */

import { diffArrays, diffWordsWithSpace } from 'diff'

const MAX_LINE_EDITS = 2000
const MAX_WORD_EDITS = 200

export interface Hunk {
  /** Where the hunk starts in each text's lines, counted from 0. */
  beforeStart: number
  afterStart: number
  removed: string[]
  added: string[]
}

export interface LineDiff {
  before: string[]
  after: string[]
  hunks: Hunk[]
}

export const splitLines = (text: string): string[] => text.split(/\r\n?|\n/)

/** The hunks that turn `before` into `after`. */
export function diffLines(before: string, after: string): LineDiff {
  const old = splitLines(before)
  const now = splitLines(after)
  const changes = diffArrays(old, now, { maxEditLength: MAX_LINE_EDITS }) ?? [
    { value: old, removed: true, added: false, count: old.length },
    { value: now, removed: false, added: true, count: now.length },
  ]
  const hunks: Hunk[] = []
  let beforeAt = 0
  let afterAt = 0
  let open: Hunk | null = null
  for (const change of changes) {
    if (!change.added && !change.removed) {
      open = null
      beforeAt += change.count
      afterAt += change.count
      continue
    }
    if (open === null) {
      open = { beforeStart: beforeAt, afterStart: afterAt, removed: [], added: [] }
      hunks.push(open)
    }
    if (change.removed) {
      open.removed.push(...change.value)
      beforeAt += change.count
    } else {
      open.added.push(...change.value)
      afterAt += change.count
    }
  }
  return { before: old, after: now, hunks }
}

export interface Segment {
  text: string
  changed: boolean
}

/** A removed line and the added line paired with it, each cut into the words they share and the words that changed. */
export function diffWords(removed: string, added: string): [Segment[], Segment[]] {
  const changes = diffWordsWithSpace(removed, added, { maxEditLength: MAX_WORD_EDITS })
  if (changes === undefined) {
    return [[{ text: removed, changed: true }], [{ text: added, changed: true }]]
  }
  const before: Segment[] = []
  const after: Segment[] = []
  for (const { value, added: isAdded, removed: isRemoved } of changes) {
    if (!isAdded) pushSegment(before, value, isRemoved)
    if (!isRemoved) pushSegment(after, value, isAdded)
  }
  return [before, after]
}

/** `text` onto `segments`; a change's leading and trailing blanks are not marked, only its words. */
function pushSegment(segments: Segment[], text: string, changed: boolean): void {
  const [, lead = '', words = '', trail = ''] = changed
    ? (/^(\s*)(.*?)(\s*)$/su.exec(text) ?? [])
    : []
  if (!changed || words === '') {
    segments.push({ text, changed: false })
    return
  }
  if (lead !== '') segments.push({ text: lead, changed: false })
  segments.push({ text: words, changed: true })
  if (trail !== '') segments.push({ text: trail, changed: false })
}
