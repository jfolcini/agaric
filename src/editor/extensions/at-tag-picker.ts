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
  /** Create a new tag with the given name. Returns the new tag's ULID. */
  onCreate?: (name: string) => Promise<string>
}

export const AtTagPicker = Extension.create<AtTagPickerOptions>({
  name: 'atTagPicker',

  addOptions() {
    return {
      items: () => [],
      onCreate: undefined,
    }
  },

  addProseMirrorPlugins() {
    const extensionOptions = this.options
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: atTagPickerPluginKey,
        char: '@',
        allowedPrefixes: null,
        items: ({ query }) => this.options.items(query),
        command: ({ editor, range, props }) => {
          const item = props as PickerItem
          if (item.isCreate && extensionOptions.onCreate) {
            extensionOptions
              .onCreate(item.label)
              .then((newId) => {
                editor.chain().focus().deleteRange(range).insertTagRef(newId).run()
              })
              .catch((err) => {
                console.error('Failed to create tag:', err)
              })
          } else {
            editor.chain().focus().deleteRange(range).insertTagRef(item.id).run()
          }
        },
        render: () => createSuggestionRenderer('Tags'),
      }),
    ]
  },
})
