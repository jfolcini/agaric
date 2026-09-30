/**
 * The typed and pasted markdown shortcuts of a mark extension (`*word*`,
 * `__word__`, `~~word~~`, `==word==`, …) held to the flanking rule the parser
 * reads those delimiters with (#5160 N9), so typing `5 * 3 = 15 and 2 *` stays
 * text, as it would read back once stored.
 */

import {
  type ExtendedRegExpMatchArray,
  InputRule,
  type Mark,
  PasteRule,
  type Range,
} from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'

import {
  codePointAt,
  codePointBefore,
  flankClass,
  runFlank,
  underscoreRunFlank,
} from '@/editor/markdown-common'

/**
 * The code point beside `pos` in its textblock, `''` past its edge or an
 * inline atom. Outside a run, `''` flanks as the parser's line edge and a ref
 * token's bracket both do.
 */
function charBeside(state: EditorState, pos: number, side: 'before' | 'after'): string {
  const $pos = state.doc.resolve(pos)
  const node = side === 'before' ? $pos.nodeBefore : $pos.nodeAfter
  const text = node?.isText ? (node.text ?? '') : ''
  return side === 'before' ? codePointBefore(text, text.length) : codePointAt(text, 0)
}

/**
 * Whether `run` can open and close between `before` and `after`, by the rule
 * the parser reads its char with.
 */
function flanks(before: string, run: string, after: string) {
  return run.startsWith('_')
    ? underscoreRunFlank(before + run + after, before.length)
    : runFlank(flankClass(before), flankClass(after))
}

/**
 * Whether a stock rule's match, `match[1]` the delimited span and `match[2]`
 * its text, opens and closes where it sits. `range` ends where the closer
 * does: at the caret for a typed one.
 */
function delimitersFlank(
  state: EditorState,
  range: Range,
  [full = '', span = '', text = '']: ExtendedRegExpMatchArray,
): boolean {
  const run = span.slice(0, (span.length - text.length) / 2)
  const before = charBeside(state, range.from + full.indexOf(span), 'before')
  const after = charBeside(state, range.to, 'after')
  return (
    flanks(before, run, codePointAt(text, 0)).canOpen &&
    flanks(codePointBefore(text, text.length), run, after).canClose
  )
}

export function withFlankingShortcuts<Options, Storage>(
  mark: Mark<Options, Storage>,
): Mark<Options, Storage> {
  return mark.extend({
    addInputRules() {
      return (this.parent?.() ?? []).map(
        (rule) =>
          new InputRule({
            find: rule.find,
            handler: (props) =>
              delimitersFlank(props.state, props.range, props.match) ? rule.handler(props) : null,
            undoable: rule.undoable,
          }),
      )
    },
    addPasteRules() {
      // A match that does not flank is left as text; null instead would drop
      // every match of the paste for this rule.
      return (this.parent?.() ?? []).map(
        (rule) =>
          new PasteRule({
            find: rule.find,
            handler: (props) =>
              delimitersFlank(props.state, props.range, props.match)
                ? rule.handler(props)
                : undefined,
          }),
      )
    },
  })
}
