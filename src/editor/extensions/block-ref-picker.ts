/**
 * TipTap extension: (( block-ref picker (block autocomplete).
 *
 * Intercepts the (( keystroke and opens a suggestion popup.
 * On selection, inserts a block_ref node with the chosen ULID.
 * Never writes ((content)) to storage — only ((ULID)).
 *
 * Picker resolves to ULID, not text.
 */

import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { Suggestion } from '@tiptap/suggestion'
import type { PickerItem } from '../SuggestionList'
import { createSuggestionRenderer } from '../suggestion-renderer'

const blockRefPickerPluginKey = new PluginKey('blockRefPicker')

export interface BlockRefPickerOptions {
  /** Return blocks matching the query. Called on every keystroke after ((. */
  items: (query: string) => PickerItem[] | Promise<PickerItem[]>
}

export const BlockRefPicker = Extension.create<BlockRefPickerOptions>({
  name: 'blockRefPicker',

  addOptions() {
    return {
      items: () => [],
    }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: blockRefPickerPluginKey,
        char: '((',
        allowedPrefixes: null,
        items: ({ query }) => this.options.items(query),
        command: ({ editor, range, props }) => {
          const item = props as PickerItem
          editor.chain().focus().deleteRange(range).insertBlockRef(item.id).run()
        },
        render: () => createSuggestionRenderer('Block references'),
      }),
    ]
  },
})
