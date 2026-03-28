/**
 * TipTap extension: # tag picker (autocomplete).
 *
 * Intercepts the # keystroke and opens a suggestion popup.
 * On selection, inserts a tag_ref node with the chosen ULID.
 * Never writes #tagname to storage — only #[ULID].
 *
 * ADR-01, ADR-20: picker resolves to ULID, not text.
 */

import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { Suggestion } from '@tiptap/suggestion'
import type { PickerItem } from '../SuggestionList'
import { createSuggestionRenderer } from '../suggestion-renderer'

const tagPickerPluginKey = new PluginKey('tagPicker')

export interface TagPickerOptions {
  /** Return tags matching the query. Called on every keystroke after #. */
  items: (query: string) => PickerItem[] | Promise<PickerItem[]>
}

export const TagPicker = Extension.create<TagPickerOptions>({
  name: 'tagPicker',

  addOptions() {
    return {
      items: () => [],
    }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: tagPickerPluginKey,
        char: '#',
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
