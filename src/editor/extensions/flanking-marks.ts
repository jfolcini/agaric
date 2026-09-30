/**
 * The typed and pasted markdown shortcuts of a mark extension (`*word*`,
 * `__word__`, `~~word~~`, `==word==`, …) held to the flanking rule the parser
 * reads those delimiters with (#5160 N9), so typing `5 * 3 = 15 and 2 *` stays
 * text and a typed `un*break*able` formats, as each would read back once
 * stored.
 */

import { InputRule, type Mark, markInputRule, markPasteRule, PasteRule } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'

import {
  codePointAt,
  codePointBefore,
  flankClass,
  runFlank,
  underscoreRunFlank,
} from '@/editor/markdown-common'

/**
 * `run`…`run` around text, matched wherever the parser could read it, not
 * only after whitespace as TipTap's stock rules ask, but as a whole run, so
 * the `*` rule does not fire inside a `**` being typed. Text with an edge
 * space never flanks, so it is not matched either, and a paste goes on to the
 * next span (`a == b and ==c==`). `match[1]` is the text.
 */
function spanPattern(run: string): string {
  const char = `[${run[0]}]`
  const text = `(?!\\s)[^${run[0]}]*[^${run[0]}\\s]`
  return `(?<!${char})${char}{${run.length}}(${text})${char}{${run.length}}`
}

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

/** Whether `run` around `text`, from `from` to `to` in `state`, opens and closes where it sits. */
function delimitersFlank(
  state: EditorState,
  { from, to }: { from: number; to: number },
  run: string,
  text: string,
): boolean {
  return (
    flanks(charBeside(state, from, 'before'), run, codePointAt(text, 0)).canOpen &&
    flanks(codePointBefore(text, text.length), run, charBeside(state, to, 'after')).canClose
  )
}

/** `mark` with a typed and a pasted shortcut for each of its delimiter `runs` (`['**', '__']`). */
export function withFlankingShortcuts<Options, Storage>(
  mark: Mark<Options, Storage>,
  runs: readonly string[],
): Mark<Options, Storage> {
  return mark.extend({
    addInputRules() {
      return runs.map((run) => {
        const rule = markInputRule({ find: new RegExp(`${spanPattern(run)}$`), type: this.type })
        return new InputRule({
          find: rule.find,
          handler: (props) =>
            delimitersFlank(props.state, props.range, run, props.match[1] ?? '')
              ? rule.handler(props)
              : null,
        })
      })
    },
    addPasteRules() {
      // A match that does not flank is left as text; null instead would drop
      // every match of the paste for this rule.
      return runs.map((run) => {
        const rule = markPasteRule({ find: new RegExp(spanPattern(run), 'g'), type: this.type })
        return new PasteRule({
          find: rule.find,
          handler: (props) =>
            delimitersFlank(props.state, props.range, run, props.match[1] ?? '')
              ? rule.handler(props)
              : undefined,
        })
      })
    },
  })
}
