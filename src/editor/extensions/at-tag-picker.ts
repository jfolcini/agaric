/**
 * TipTap extension: @ tag picker (autocomplete).
 *
 * Intercepts the @ keystroke and opens a suggestion popup.
 * On selection, inserts a tag_ref node with the chosen ULID.
 * Never writes @tagname to storage — only #[ULID].
 *
 * Identical behavior to the # tag picker but triggered by @.
 */

import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { Suggestion } from '@tiptap/suggestion'
import type { PickerItem } from '../SuggestionList'
import { createSuggestionRenderer } from '../suggestion-renderer'

const atTagPickerPluginKey = new PluginKey('atTagPicker')

export interface AtTagPickerOptions {
  /** Return tags matching the query. Called on every keystroke after @. */
  items: (query: string) => PickerItem[] | Promise<PickerItem[]>
}

export const AtTagPicker = Extension.create<AtTagPickerOptions>({
  name: 'atTagPicker',

  addOptions() {
    return {
      items: () => [],
    }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: atTagPickerPluginKey,
        char: '@',
        allowedPrefixes: null,
        items: ({ query }) => this.options.items(query),
        command: ({ editor, range, props }) => {
          const item = props as PickerItem
          editor.chain().focus().deleteRange(range).insertTagRef(item.id).run()
        },
        render: createSuggestionRenderer,
      }),
    ]
  },
})
