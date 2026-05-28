/**
 * TipTap extension: (( block-ref picker (block autocomplete).
 *
 * Three ways to insert a block reference:
 * 1. **Picker** — Type (( to open the suggestion popup, select from list.
 * 2. **Input rule** — Type ((text)) (with closing parens) to auto-resolve
 *    when an exact-match block exists. Falls back to plain text on no match.
 * 3. **Command** — `resolveBlockRefFromSelection` resolves the current
 *    selection to a block_ref via the same exact-match rule.
 *
 * All paths resolve to ULID — never writes ((content)) to storage, only ((ULID)).
 */

import { Extension, InputRule } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'

import type { PickerItem } from '../SuggestionList'
import { createPickerPlugin, resolveAndInsertPickerToken } from './picker-plugin'

export const blockRefPickerPluginKey = new PluginKey('blockRefPicker')

export interface BlockRefPickerOptions {
  /** Return blocks matching the query. Called on every keystroke after ((. */
  items: (query: string) => PickerItem[] | Promise<PickerItem[]>
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockRefPicker: {
      resolveBlockRefFromSelection: () => ReturnType
    }
  }
}

/** Exact-match predicate for the BlockRef resolve paths (label only, no alias). */
function matchBlockRefItem(items: PickerItem[], text: string): PickerItem | undefined {
  const lower = text.toLowerCase()
  return items.find((item) => !item.isCreate && item.label.toLowerCase() === lower)
}

export const BlockRefPicker = Extension.create<BlockRefPickerOptions>({
  name: 'blockRefPicker',

  addOptions() {
    return {
      items: () => [],
    }
  },

  addCommands() {
    const extensionOptions = this.options
    return {
      resolveBlockRefFromSelection:
        () =>
        ({ editor }) => {
          const { from, to } = editor.state.selection
          if (from === to) return false

          const selectedText = editor.state.doc.textBetween(from, to).trim()
          if (!selectedText) return false

          // Capture position before deletion (same race-condition fix as the input rule)
          const insertPos = from
          editor.chain().focus().deleteRange({ from, to }).run()

          // MAINT-203: shared FE-M-15 race-guard. No `onCreate` — block refs
          // reference existing blocks only (unlike block links, which can
          // create pages).
          void resolveAndInsertPickerToken({
            editor,
            text: selectedText,
            insertPos,
            items: extensionOptions.items,
            matchItem: matchBlockRefItem,
            tokenFor: (id) => ({ type: 'block_ref', attrs: { id } }),
            loggerComponent: 'BlockRefPicker',
            errorMessage: 'resolveBlockRefFromSelection failed, falling back to plain text',
          })
          return true
        },
    }
  },

  addInputRules() {
    const extensionOptions = this.options
    const editor = this.editor
    return [
      // Match ((text)) — auto-resolve to a block ref on typing the closing ))
      new InputRule({
        find: /\(\(([^)]+)\)\)$/,
        handler: ({ state, range, match }) => {
          const innerText = (match[1] ?? '').trim()
          if (!innerText) return

          // Capture the insertion position *before* deletion so the async
          // callback inserts at the correct spot even if the cursor moves.
          const insertPos = range.from

          // Delete the ((text)) range immediately so the raw text doesn't linger
          state.tr.delete(range.from, range.to)

          // MAINT-203: shared FE-M-15 race-guard. Token shape `block_ref`;
          // no `onCreate` path.
          void resolveAndInsertPickerToken({
            editor,
            text: innerText,
            insertPos,
            items: extensionOptions.items,
            matchItem: matchBlockRefItem,
            tokenFor: (id) => ({ type: 'block_ref', attrs: { id } }),
            loggerComponent: 'BlockRefPicker',
            errorMessage: 'Failed to resolve block ref via input rule, falling back to plain text',
          })
        },
      }),
    ]
  },

  addProseMirrorPlugins() {
    const extensionOptions = this.options
    return [
      createPickerPlugin({
        loggerComponent: 'BlockRefPicker',
        displayName: 'Block references',
        pluginKey: blockRefPickerPluginKey,
        char: '((',
        allowSpaces: true,
        allowedPrefixes: null,
        editor: this.editor,
        items: (query) => extensionOptions.items(query),
        command: ({ editor, range, props }) => {
          const item = props as PickerItem
          editor.chain().focus().deleteRange(range).insertBlockRef(item.id).insertContent(' ').run()
        },
      }),
    ]
  },
})
