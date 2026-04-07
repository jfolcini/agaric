/**
 * TipTap extension: @ tag picker (autocomplete).
 *
 * Intercepts the @ keystroke and opens a suggestion popup.
 * On selection, inserts a tag_ref node with the chosen ULID.
 * Never writes @tagname to storage — only #[ULID].
 *
 * Identical behavior to the # tag picker but triggered by @.
 */

import { Extension, InputRule } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { Suggestion } from '@tiptap/suggestion'
import { logger } from '../../lib/logger'
import type { PickerItem } from '../SuggestionList'
import { createSuggestionRenderer } from '../suggestion-renderer'

const atTagPickerPluginKey = new PluginKey('atTagPicker')

export interface AtTagPickerOptions {
  /** Return tags matching the query. Called on every keystroke after @. */
  items: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Create a new tag with the given name. Returns the new tag's ULID. */
  onCreate?: ((name: string) => Promise<string>) | undefined
}

export const AtTagPicker = Extension.create<AtTagPickerOptions>({
  name: 'atTagPicker',

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
      new InputRule({
        find: /#\[([^\]]+)\]$/,
        handler: ({ state, range, match }) => {
          const innerText = (match[1] ?? '').trim()
          if (!innerText) return

          const insertPos = range.from
          state.tr.delete(range.from, range.to)

          const resolveAndInsert = async () => {
            try {
              const items = await extensionOptions.items(innerText)
              const exactMatch = items.find(
                (item) => !item.isCreate && item.label.toLowerCase() === innerText.toLowerCase(),
              )
              if (exactMatch) {
                editor
                  .chain()
                  .focus()
                  .insertContentAt(insertPos, {
                    type: 'tag_ref',
                    attrs: { id: exactMatch.id },
                  })
                  .run()
              } else if (extensionOptions.onCreate) {
                const newId = await extensionOptions.onCreate(innerText)
                editor
                  .chain()
                  .focus()
                  .insertContentAt(insertPos, {
                    type: 'tag_ref',
                    attrs: { id: newId },
                  })
                  .run()
              } else {
                editor.chain().focus().insertContentAt(insertPos, innerText).run()
              }
            } catch {
              editor.chain().focus().insertContentAt(insertPos, innerText).run()
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
        pluginKey: atTagPickerPluginKey,
        char: '@',
        allowedPrefixes: null,
        allowSpaces: true,
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
                logger.error('AtTagPicker', 'Failed to create tag', { error: String(err) })
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
