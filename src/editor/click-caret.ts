/**
 * Where a click on a block's static render landed, as a point in the block's
 * text, and where that point is in the editor's document once the block is
 * mounted (#6562).
 *
 * The static render and the editor draw the same document differently (a
 * chip's label, the list marker, a highlighted code block's spans), so the
 * click is read from the static DOM before the mount and mapped after it, not
 * through `posAtCoords` on a render the click never saw. A DOM text node counts
 * when it continues the document's text runs (`parse(content)`); any other text
 * (a chip's label, the list marker, the space between paragraphs) counts
 * nothing. Chips and block boundaries take no characters, so `bias` says which
 * side of one the click was on: a click at the start of uncounted text (the
 * left edge of a chip) is before it, any other after it. A chip label that
 * begins the text run after it, or is a whole later run, is taken for that
 * run; a click on the text it skips then lands after it or at the end.
 */

import type { Node as PMNode } from '@tiptap/pm/model'

import { parse } from '@/editor/markdown-serializer'

export interface TextPoint {
  /** How many characters of the document's text runs come before the point. */
  textOffset: number
  /** `'after'` at a run's start, the point belongs to that run; `'before'`, to the run it ends. */
  bias: 'before' | 'after'
}

interface DocJson {
  type?: string
  text?: string
  content?: DocJson[]
}

function textRuns(node: DocJson, runs: string[] = []): string[] {
  if (node.type === 'text' && node.text) runs.push(node.text)
  for (const child of node.content ?? []) textRuns(child, runs)
  return runs
}

/** The DOM point under `x, y`: Chromium and Firefox name it a position, WebKit a range. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const position = document.caretPositionFromPoint?.(x, y)
  if (position) return { node: position.offsetNode, offset: position.offset }
  const range = document.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/**
 * The point in `content`'s text at DOM point `at` inside `root`, its static
 * render; `null` when no text of the render matches the document's.
 */
export function textPointAt(
  root: Node,
  content: string,
  at: { node: Node; offset: number },
): TextPoint | null {
  const runs = textRuns(parse(content) as DocJson)
  const runStart: number[] = []
  let total = 0
  for (const run of runs) {
    runStart.push(total)
    total += run.length
  }
  let run = 0
  let inRun = 0
  /**
   * Where `data` sits in the text runs: it continues the current run, which a
   * highlighted code block splits over nodes, or is a whole later one, when
   * the render leaves runs out (a diagram's source). Whitespace alone never
   * opens a run: it is the space between paragraphs or after a link, and
   * taking it for a run's leading space loses the rest of that run.
   */
  const match = (data: string): number | null => {
    if (data === '' || run >= runs.length || (inRun === 0 && data.trim() === '')) return null
    let found = -1
    if ((runs[run] as string).startsWith(data, inRun)) found = run
    else if (inRun === 0) found = runs.indexOf(data, run + 1)
    if (found < 0) return null
    run = found
    const start = (runStart[run] as number) + inRun
    inRun += data.length
    if (inRun === (runs[run] as string).length) {
      run++
      inRun = 0
    }
    return start
  }

  const point = document.createRange()
  point.setStart(at.node, at.offset)
  const towardNext = at.offset > 0
  let previousEnd: number | null = null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text
    const start = match(text.data)
    if (start === null) continue
    if (text === at.node) {
      return { textOffset: start + at.offset, bias: towardNext ? 'before' : 'after' }
    }
    if (point.comparePoint(text, 0) >= 0) {
      return towardNext || previousEnd === null
        ? { textOffset: start, bias: 'after' }
        : { textOffset: previousEnd, bias: 'before' }
    }
    previousEnd = start + text.length
  }
  if (previousEnd === null) return null
  return towardNext
    ? { textOffset: total, bias: 'after' }
    : { textOffset: previousEnd, bias: 'before' }
}

/** The point in `content`'s text under the click at `x, y` on `root`, its static render. */
export function textPointAtClick(
  root: Node,
  content: string,
  x: number,
  y: number,
): TextPoint | null {
  const at = caretAt(x, y)
  if (at === null || !root.contains(at.node)) return null
  return textPointAt(root, content, at)
}

/**
 * The position of `point` in `doc`; past the end of its text, the end of its
 * last textblock, after any chip there. `null` when `doc` has no textblock.
 */
export function posAtTextPoint(doc: PMNode, point: TextPoint): number | null {
  const { textOffset, bias } = point
  let start = 0
  let found: number | null = null
  let lastEnd: number | null = null
  doc.descendants((node, pos) => {
    if (found !== null) return false
    if (node.isTextblock) lastEnd = pos + node.nodeSize - 1
    if (!node.isText) return true
    const end = start + node.nodeSize
    const inside =
      bias === 'after'
        ? textOffset >= start && textOffset < end
        : textOffset > start && textOffset <= end
    if (inside) found = pos + textOffset - start
    start = end
    return false
  })
  return found ?? lastEnd
}
