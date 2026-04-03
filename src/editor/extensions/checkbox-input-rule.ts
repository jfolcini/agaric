/**
 * TipTap extension: live checkbox syntax detection.
 *
 * Detects `- [ ] ` and `- [x] ` / `- [X] ` patterns as the user types
 * and immediately strips the syntax, calling the onCheckbox callback
 * to set the TODO/DONE state on the block.
 */

import { Extension, InputRule } from '@tiptap/core'

export interface CheckboxInputRuleOptions {
  onCheckbox: ((state: 'TODO' | 'DONE') => void) | null
}

export const CheckboxInputRule = Extension.create<CheckboxInputRuleOptions>({
  name: 'checkboxInputRule',

  addOptions() {
    return { onCheckbox: null }
  },

  addInputRules() {
    return [
      // - [ ] followed by space → TODO
      new InputRule({
        find: /^- \[ \] $/,
        handler: ({ state, range }) => {
          state.tr.delete(range.from, range.to)
          this.options.onCheckbox?.('TODO')
        },
      }),
      // - [x] or - [X] followed by space → DONE
      new InputRule({
        find: /^- \[[xX]\] $/,
        handler: ({ state, range }) => {
          state.tr.delete(range.from, range.to)
          this.options.onCheckbox?.('DONE')
        },
      }),
    ]
  },
})
