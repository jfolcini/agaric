/**
 * TipTap extension: [[ block-link picker (page autocomplete).
 *
 * Two ways to insert a block link:
 * 1. **Picker** — Type [[ to open the suggestion popup, select from list.
 * 2. **Input rule** — Type [[text]] (with closing brackets) to auto-resolve.
 *    If an exact-match page exists, links to it. Otherwise creates it.
 *
 * Both resolve to ULID, never writing [[title]] to storage.
 */

import { Extension, InputRule } from '@tiptap/core'
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

  addInputRules() {
    const extensionOptions = this.options
    const editor = this.editor
    return [
      // Match [[text]] — auto-resolve to a block link on typing the closing ]]
      new InputRule({
        find: /\[\[([^\]]+)\]\]$/,
        handler: ({ state, range, match }) => {
          const innerText = (match[1] ?? '').trim()
          if (!innerText) return

          // Delete the [[text]] range immediately so the raw text doesn't linger
          state.tr.delete(range.from, range.to)

          // Async resolve: look up page, then insert block_link node
          const resolveAndInsert = async () => {
            try {
              const items = await extensionOptions.items(innerText)
              // Look for an exact match (case-insensitive)
              const exactMatch = items.find(
                (item) => !item.isCreate && item.label.toLowerCase() === innerText.toLowerCase(),
              )
              if (exactMatch) {
                editor.commands.insertBlockLink(exactMatch.id)
              } else if (extensionOptions.onCreate) {
                const newId = await extensionOptions.onCreate(innerText)
                editor.commands.insertBlockLink(newId)
              } else {
                // No match and no onCreate — re-insert as plain text
                editor.commands.insertContent(innerText)
              }
            } catch {
              // On error, re-insert as plain text so the user doesn't lose content
              editor.commands.insertContent(innerText)
            }
          }
          void resolveAndInsert()
        },
      }),
    ]
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
