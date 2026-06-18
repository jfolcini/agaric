/**
 * TipTap extension: live checkbox syntax detection.
 *
 * Detects `- [ ] ` and `- [x] ` / `- [X] ` patterns as the user types
 * and immediately strips the syntax, calling the onCheckbox callback
 * to set the TODO/DONE state on the block.
 *
 * #1494 — when `BulletList` is also registered (since #1436), its `- `
 * input rule fires on the space right after the dash and wraps the line in
 * a `bulletList` before `- [ ] ` can finish, so live-typed checkboxes were
 * shadowed. To recover the typed path we add a second set of rules that
 * match the bracket syntax WITHOUT the leading `- ` (`[ ] ` / `[x] `),
 * firing only when the cursor sits in the single, freshly-created bullet
 * item: we replace that one-item list with an empty paragraph and fire
 * onCheckbox. The single-item guard keeps the rule inert inside real
 * multi-item lists and in plain paragraphs (where bare `[ ] ` stays
 * literal text). The bulk-insert path (`- [ ] ` matched in one shot, e.g.
 * applyInputRules) still hits the direct rules below.
 */

import { Extension, InputRule } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'

export interface CheckboxInputRuleOptions {
  onCheckbox: ((state: 'TODO' | 'DONE') => void) | null
}

export const CheckboxInputRule = Extension.create<CheckboxInputRuleOptions>({
  name: 'checkboxInputRule',

  addOptions() {
    return { onCheckbox: null }
  },

  addInputRules() {
    const fire = (todoState: 'TODO' | 'DONE'): void => {
      this.options.onCheckbox?.(todoState)
    }

    // Direct path: `- [ ] ` matched at the start of a textblock that was
    // NOT wrapped into a bullet list (bulk insert, or contexts without
    // BulletList). Strip the trigger and fire.
    const directRule = (find: RegExp, todoState: 'TODO' | 'DONE'): InputRule =>
      new InputRule({
        find,
        handler: ({ state, range }) => {
          state.tr.delete(range.from, range.to)
          fire(todoState)
        },
      })

    // Bullet-shadowed path (#1494): `[ ] ` typed inside the single bullet
    // item BulletList just created from the typed `- `. Replace that
    // one-item list with an empty paragraph (carrying the cursor), then
    // fire. Returns null — leaving the typed text intact — whenever the
    // surrounding structure isn't that freshly-created single bullet item.
    const unwrapRule = (find: RegExp, todoState: 'TODO' | 'DONE'): InputRule =>
      new InputRule({
        find,
        handler: ({ state }) => {
          const { $from } = state.selection
          const listItem = $from.node(-1)
          const list = $from.node(-2)
          if (listItem?.type.name !== 'listItem') return null
          if (list?.type.name !== 'bulletList' || list.childCount !== 1) return null

          const paragraphType = state.schema.nodes['paragraph']
          if (!paragraphType) return null

          const listDepth = $from.depth - 2
          const from = $from.before(listDepth)
          const to = $from.after(listDepth)
          state.tr.replaceRangeWith(from, to, paragraphType.create())
          state.tr.setSelection(TextSelection.create(state.tr.doc, from + 1))
          fire(todoState)
          return undefined
        },
      })

    return [
      directRule(/^- \[ \] $/, 'TODO'),
      directRule(/^- \[[xX]\] $/, 'DONE'),
      unwrapRule(/^\[ \] $/, 'TODO'),
      unwrapRule(/^\[[xX]\] $/, 'DONE'),
    ]
  },
})
