/**
 * In-page replace in page mode (#6608). Page mode shows the page as one
 * ProseMirror document, which find walks as DOM text (`matcher.ts`), so a
 * replace edits that document in one transaction: page mode saves it as it
 * saves typing, and one undo in the editor takes it back.
 */

import type { Editor } from '@tiptap/core'

import type { FindMatch } from '@/lib/in-page-find/matcher'

/** The page-mode editor shown in `container`, or `null` when it shows none. */
export function pageModeEditorIn(container: Element): Editor | null {
  // TipTap hangs the editor on its root element.
  const root = container.querySelector<HTMLElement & { editor?: Editor }>('.page-mode-editor')
  const editor = root?.editor
  return editor !== undefined && !editor.isDestroyed ? editor : null
}

/**
 * The document range of a DOM match that is the document's own text; `null`
 * for one in a chip, a node view, or outside the editor (the page title).
 */
function documentRange(editor: Editor, match: FindMatch): { from: number; to: number } | null {
  const { view } = editor
  const from = view.posAtDOM(match.node, match.start)
  const to = view.posAtDOM(match.node, match.end)
  // Text in a chip or a widget has no positions of its own: both ends land on the node
  // (-1 for text outside the editor).
  return to - from === match.end - match.start ? { from, to } : null
}

/** How many of `matches` a replace leaves as they are. */
export function skippedInEditor(editor: Editor, matches: readonly FindMatch[]): number {
  return matches.filter((match) => documentRange(editor, match) === null).length
}

/** Replace each `match` with its `text` in one transaction; a match not the document's own text is skipped. */
export function replaceInEditor(
  editor: Editor,
  items: ReadonlyArray<{ match: FindMatch; text: string }>,
): { replaced: number; skipped: number } {
  const ranges: Array<{ from: number; to: number; text: string }> = []
  let skipped = 0
  let reached = 0
  const located = items.map((item) => ({
    range: documentRange(editor, item.match),
    text: item.text,
  }))
  for (const { range, text } of located.toSorted(
    (a, b) => (a.range?.from ?? 0) - (b.range?.from ?? 0),
  )) {
    if (range === null) {
      skipped += 1
      continue
    }
    // Overlapping matches keep the first.
    if (range.from < reached) continue
    ranges.push({ ...range, text })
    reached = range.to
  }
  if (ranges.length === 0) return { replaced: 0, skipped }
  const tr = editor.state.tr
  for (const { from, to, text } of ranges.toReversed()) tr.insertText(text, from, to)
  editor.view.dispatch(tr)
  return { replaced: ranges.length, skipped }
}
