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
import { logger } from '../../lib/logger'
import type { PickerItem } from '../SuggestionList'
import { createPickerPlugin } from './picker-plugin'

export const atTagPickerPluginKey = new PluginKey('atTagPicker')

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
            // FE-M-15: insertContentAt clamps silently when insertPos is past
            // the doc's end (e.g. user cleared/shrank the doc while the async
            // resolve was in flight), so the existing try/catch never fires
            // on that path. Validate before each insertContentAt(insertPos,
            // ...) call; on a stale offset, fall back to plain text at the
            // current cursor.
            const isStale = () => insertPos > editor.state.doc.content.size
            const insertPlainAtCursor = () => {
              editor.chain().focus().insertContent(innerText).run()
            }

            try {
              const items = await extensionOptions.items(innerText)
              const exactMatch = items.find(
                (item) => !item.isCreate && item.label.toLowerCase() === innerText.toLowerCase(),
              )
              if (exactMatch) {
                if (isStale()) {
                  logger.warn(
                    'AtTagPicker',
                    'insertPos stale after items resolved; falling back to plain text at cursor',
                    { text: innerText, insertPos, docSize: editor.state.doc.content.size },
                  )
                  insertPlainAtCursor()
                  return
                }
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
                if (isStale()) {
                  logger.warn(
                    'AtTagPicker',
                    'insertPos stale after onCreate resolved; falling back to plain text at cursor',
                    { text: innerText, insertPos, docSize: editor.state.doc.content.size },
                  )
                  insertPlainAtCursor()
                  return
                }
                editor
                  .chain()
                  .focus()
                  .insertContentAt(insertPos, {
                    type: 'tag_ref',
                    attrs: { id: newId },
                  })
                  .run()
              } else {
                if (isStale()) {
                  insertPlainAtCursor()
                  return
                }
                editor.chain().focus().insertContentAt(insertPos, innerText).run()
              }
            } catch (err) {
              logger.warn(
                'AtTagPicker',
                'Failed to resolve tag via input rule, falling back to plain text',
                { text: innerText },
                err,
              )
              if (isStale()) {
                insertPlainAtCursor()
                return
              }
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
      createPickerPlugin({
        loggerComponent: 'AtTagPicker',
        displayName: 'Tags',
        pluginKey: atTagPickerPluginKey,
        char: '@',
        // Only open the tag picker when `@` is preceded by whitespace or is
        // at the start of the block. Without this guard, query expressions
        // like `property:context=@office` or `value:@remote` would trip
        // the picker and intercept Enter (creating a "Create 'office}}'"
        // tag instead of saving the block).
        //
        // TipTap's default is `[' ']` (plain space only), but ProseMirror
        // normalises a trailing space inside a paragraph to NBSP (`\u00A0`)
        // — so the "type `tagged: ` then press the toolbar's Insert-tag
        // button" flow renders as `tagged:\u00A0@` and needs NBSP accepted
        // alongside the regular space. We include `\n` as well for the
        // (rare) case where a hard break precedes `@`.
        allowedPrefixes: [' ', '\u00A0', '\n'],
        allowSpaces: true,
        editor: this.editor,
        items: (query) => extensionOptions.items(query),
        command: ({ editor, range, props }) => {
          const item = props as PickerItem
          if (item.isCreate && extensionOptions.onCreate) {
            extensionOptions
              .onCreate(item.label)
              .then((newId) => {
                editor
                  .chain()
                  .focus()
                  .deleteRange(range)
                  .insertTagRef(newId)
                  .insertContent(' ')
                  .run()
              })
              .catch((err) => {
                logger.error('AtTagPicker', 'Failed to create tag', undefined, err)
              })
          } else {
            editor.chain().focus().deleteRange(range).insertTagRef(item.id).insertContent(' ').run()
          }
        },
      }),
    ]
  },
})
