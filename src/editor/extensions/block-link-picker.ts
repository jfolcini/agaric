/**
 * TipTap extension: [[ block-link picker (page autocomplete).
 *
 * Intercepts the [[ keystroke and opens a suggestion popup.
 * On selection, inserts a block_link node with the chosen ULID.
 * Never writes [[title]] to storage — only [[ULID]].
 *
 * Picker resolves to ULID, not text.
 */

import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { Suggestion } from '@tiptap/suggestion'
import type { PickerItem } from '../SuggestionList'
import { createSuggestionRenderer } from '../suggestion-renderer'

const blockLinkPickerPluginKey = new PluginKey('blockLinkPicker')

export interface BlockLinkPickerOptions {
  /** Return pages/blocks matching the query. Called on every keystroke after [[. */
  items: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Create a new page with the given title. Returns the new block's ULID. */
  onCreate?: ((label: string) => Promise<string>) | undefined
}

export const BlockLinkPicker = Extension.create<BlockLinkPickerOptions>({
  name: 'blockLinkPicker',

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
        pluginKey: blockLinkPickerPluginKey,
        char: '[[',
        allowedPrefixes: null,
        items: ({ query }) => this.options.items(query),
        command: ({ editor, range, props }) => {
          const item = props as PickerItem
          if (item.isCreate && extensionOptions.onCreate) {
            extensionOptions
              .onCreate(item.label)
              .then((newId) => {
                editor.chain().focus().deleteRange(range).insertBlockLink(newId).run()
              })
              .catch((err) => {
                console.error('Failed to create page for block link:', err)
              })
          } else {
            editor.chain().focus().deleteRange(range).insertBlockLink(item.id).run()
          }
        },
        render: () => createSuggestionRenderer('Block links'),
      }),
    ]
  },
})
