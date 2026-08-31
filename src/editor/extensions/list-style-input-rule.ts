/**
 * TipTap extension: live block-level list-marker syntax detection (#4552
 * slice 2).
 *
 * `BulletList` / `OrderedList` (`use-roving-editor.ts`) keep their stock
 * `- ` / `1. ` input rules ENABLED — deliberately. Disabling them would also
 * remove the transient single-item list that `CheckboxInputRule`'s unwrap
 * rules (#1494) rely on to recover a typed `- [ ] ` / `- [x] ` checkbox: that
 * rule fires on the space after `[ ] `/`[x] ` and detects "a single, empty
 * list item was just created", replacing it with an empty paragraph and
 * firing `onCheckbox`. Removing the stock rules would leave nothing for it to
 * detect, silently breaking checkbox creation via the typed `- [ ] ` path.
 *
 * This extension instead watches for the FIRST character typed into that
 * same freshly-created single, empty list item. Once a character other than
 * `[` appears, it is clear the user is not building a `- [ ] ` / `- [x] `
 * checkbox trigger, so this rule collapses the transient list into the new
 * `listStyle` block-property model: it replaces the whole (single-item)
 * list with a plain paragraph carrying the just-typed character, sets the
 * selection after it, and fires `onListStyle` so the caller persists the
 * block's `listStyle` property (`setListStyle`, `src/lib/list-style.ts`).
 * The list marker itself is drawn separately (`ListMarker.tsx` /
 * `list-marker-decoration.ts`) from that property, not from document
 * structure, so no marker text is left in `blocks.content`.
 *
 * `[` is excluded from the bullet rule so a checkbox trigger in progress is
 * left alone; `CheckboxInputRule` has no ordered-list counterpart (there is
 * no `1. [ ] ` checkbox syntax), so the ordered rule has no such exclusion.
 *
 * A block whose typed character is `[` but which never completes a checkbox
 * (e.g. the user types `- [hello` and stops) is left as a transient in-block
 * list rather than converted — a legacy shape slice 5's on-blur conversion
 * (`docs/architecture/list-ergonomics.md`, out of scope here) is meant to
 * reconcile. This is a narrow, documented gap, not a silent one.
 */

import { Extension, InputRule } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'

export type ListStyleInputValue = 'bullet' | 'ordered'

export interface ListStyleInputRuleOptions {
  onListStyle: ((style: ListStyleInputValue) => void) | null
}

export const ListStyleInputRule = Extension.create<ListStyleInputRuleOptions>({
  name: 'listStyleInputRule',

  addOptions() {
    return { onListStyle: null }
  },

  addInputRules() {
    const fire = (style: ListStyleInputValue): void => {
      this.options.onListStyle?.(style)
    }

    const unwrapRule = (
      find: RegExp,
      listTypeName: 'bulletList' | 'orderedList',
      style: ListStyleInputValue,
    ): InputRule =>
      new InputRule({
        find,
        handler: ({ state, match }) => {
          const { $from } = state.selection
          const listItem = $from.node(-1)
          const list = $from.node(-2)
          if (listItem?.type.name !== 'listItem') return null
          if (list?.type.name !== listTypeName || list.childCount !== 1) return null

          const paragraphType = state.schema.nodes['paragraph']
          if (!paragraphType) return null

          const typed = match[0] ?? ''
          const content = typed ? [state.schema.text(typed)] : []

          const listDepth = $from.depth - 2
          const from = $from.before(listDepth)
          const to = $from.after(listDepth)
          state.tr.replaceRangeWith(from, to, paragraphType.create(null, content))
          state.tr.setSelection(TextSelection.create(state.tr.doc, from + 1 + typed.length))
          fire(style)
          return undefined
        },
      })

    return [
      // Bullet: any single character EXCEPT `[` — see the file doc comment
      // for why `[` is left for CheckboxInputRule to claim.
      unwrapRule(/^[^[]$/, 'bulletList', 'bullet'),
      // Ordered lists have no checkbox-syntax counterpart, so any next
      // character finalizes the conversion.
      unwrapRule(/^.$/, 'orderedList', 'ordered'),
    ]
  },
})
