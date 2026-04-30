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
import { Suggestion } from '@tiptap/suggestion'
import { logger } from '../../lib/logger'
import type { PickerItem } from '../SuggestionList'
import { createSuggestionRenderer } from '../suggestion-renderer'

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

          const resolveAndInsert = async () => {
            try {
              const items = await extensionOptions.items(selectedText)
              // No onCreate path for block refs — unlike block links (which
              // create pages), block refs reference arbitrary mid-content
              // blocks that have no sensible "create" target without a
              // parent context. Fall back to plain text on no match.
              const exactMatch = items.find(
                (item) => !item.isCreate && item.label.toLowerCase() === selectedText.toLowerCase(),
              )
              if (exactMatch) {
                editor
                  .chain()
                  .focus()
                  .insertContentAt(insertPos, {
                    type: 'block_ref',
                    attrs: { id: exactMatch.id },
                  })
                  .run()
              } else {
                // No exact match — re-insert as plain text
                editor.chain().focus().insertContentAt(insertPos, selectedText).run()
              }
            } catch (err) {
              logger.warn(
                'BlockRefPicker',
                'resolveBlockRefFromSelection failed, falling back to plain text',
                { text: selectedText },
                err,
              )
              editor.chain().focus().insertContentAt(insertPos, selectedText).run()
            }
          }
          void resolveAndInsert()
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

          // Async resolve: look up block, then insert block_ref node at the
          // captured position to avoid a race with subsequent user edits.
          const resolveAndInsert = async () => {
            try {
              const items = await extensionOptions.items(innerText)
              // No onCreate path for block refs — unlike block links (which
              // create pages), block refs reference arbitrary mid-content
              // blocks that have no sensible "create" target without a
              // parent context. Fall back to plain text on no match.
              const exactMatch = items.find(
                (item) => !item.isCreate && item.label.toLowerCase() === innerText.toLowerCase(),
              )
              if (exactMatch) {
                editor
                  .chain()
                  .focus()
                  .insertContentAt(insertPos, {
                    type: 'block_ref',
                    attrs: { id: exactMatch.id },
                  })
                  .run()
              } else {
                // No exact match — re-insert as plain text
                editor.chain().focus().insertContentAt(insertPos, innerText).run()
              }
            } catch (err) {
              logger.warn(
                'BlockRefPicker',
                'Failed to resolve block ref via input rule, falling back to plain text',
                { text: innerText },
                err,
              )
              // On error, re-insert as plain text so the user doesn't lose content
              editor.chain().focus().insertContentAt(insertPos, innerText).run()
            }
          }
          void resolveAndInsert()
        },
      }),
    ]
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: blockRefPickerPluginKey,
        char: '((',
        allowSpaces: true,
        allowedPrefixes: null,
        items: async ({ query }) => {
          try {
            return await this.options.items(query)
          } catch (err) {
            logger.warn('BlockRefPicker', 'items callback failed, returning empty', { query }, err)
            return []
          }
        },
        command: ({ editor, range, props }) => {
          const item = props as PickerItem
          editor.chain().focus().deleteRange(range).insertBlockRef(item.id).insertContent(' ').run()
        },
        render: () => createSuggestionRenderer('Block references', blockRefPickerPluginKey),
      }),
    ]
  },
})
