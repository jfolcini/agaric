/**
 * TipTap extension: live checkbox syntax detection.
 *
 * Detects a typed checkbox of the shared alphabet (`[ ]` TODO, `[/]` DOING,
 * `[x]` / `[X]` DONE, `[-]` CANCELLED — `TASK_MARKER_TO_STATE`) at the start
 * of a block and immediately strips the syntax, calling the onCheckbox
 * callback to set the block's state (#5160 D6, P9, X11). `- [ ] ` and a bare
 * `[ ] ` mean the same thing, as they do in the Edit as Markdown buffer.
 *
 * #1494 — when `BulletList` is also registered (since #1436), its `- ` input
 * rule fires on the space right after the dash and wraps the line in a
 * `bulletList` before `- [ ] ` can finish, so live-typed checkboxes were
 * shadowed. To recover the typed path the bare rule matches the bracket
 * syntax WITHOUT the leading `- ` (`[ ] `) and, when the cursor sits in the
 * single, freshly-created bullet item, replaces that one-item list with an
 * empty paragraph and fires onCheckbox. Inside a real multi-item list the
 * rule stays inert. The bulk-insert path (`- [ ] ` matched in one shot, e.g.
 * applyInputRules) still hits the direct rule.
 */

import { Extension, InputRule } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'

import type { TodoState } from '@/lib/task-states'
import { taskStateFromMarker } from '@/lib/task-states'

export interface CheckboxInputRuleOptions {
  onCheckbox: ((state: TodoState) => void) | null
}

/** A checkbox of the shared alphabet and its trailing space; group 1 is the marker. */
const CHECKBOX = String.raw`\[([ xX/-])\] $`

/** `- [ ] ` at the start of a textblock, typed or inserted in one go. */
const DIRECT_RE = new RegExp(`^- ${CHECKBOX}`)

/**
 * `[ ] ` at the start of a textblock: a bare checkbox at the block's start, or
 * the tail of a typed `- [ ] ` inside the bullet item BulletList's rule just
 * created (#1494).
 */
const BARE_RE = new RegExp(`^${CHECKBOX}`)

export const CheckboxInputRule = Extension.create<CheckboxInputRuleOptions>({
  name: 'checkboxInputRule',

  addOptions() {
    return { onCheckbox: null }
  },

  addInputRules() {
    const fire = (match: RegExpMatchArray): void => {
      const todoState = taskStateFromMarker(match[1] ?? '')
      if (todoState) this.options.onCheckbox?.(todoState)
    }

    // Direct path: `- [ ] ` matched at the start of a textblock that was
    // NOT wrapped into a bullet list (bulk insert, or contexts without
    // BulletList). Strip the trigger and fire.
    const directRule = new InputRule({
      find: DIRECT_RE,
      handler: ({ state, range, match }) => {
        state.tr.delete(range.from, range.to)
        fire(match)
      },
    })

    // Bare path: `[ ] ` at the start of the block's first textblock makes it
    // a task (X11), and typed inside the single bullet item BulletList just
    // created from `- ` (#1494) replaces that one-item list with an empty
    // paragraph carrying the cursor. Returns null — leaving the typed text
    // intact — inside a real list, and anywhere but the block's start (a
    // table cell, a quote, a later paragraph).
    const bareRule = new InputRule({
      find: BARE_RE,
      handler: ({ state, range, match }) => {
        const { $from } = state.selection
        const listItem = $from.node(-1)
        if (listItem?.type.name !== 'listItem') {
          if ($from.depth !== 1 || $from.index(0) !== 0) return null
          state.tr.delete(range.from, range.to)
          fire(match)
          return undefined
        }
        const list = $from.node(-2)
        if (list?.type.name !== 'bulletList' || list.childCount !== 1) return null

        const paragraphType = state.schema.nodes['paragraph']
        if (!paragraphType) return null

        const listDepth = $from.depth - 2
        const from = $from.before(listDepth)
        const to = $from.after(listDepth)
        state.tr.replaceRangeWith(from, to, paragraphType.create())
        state.tr.setSelection(TextSelection.create(state.tr.doc, from + 1))
        fire(match)
        return undefined
      },
    })

    return [directRule, bareRule]
  },
})
