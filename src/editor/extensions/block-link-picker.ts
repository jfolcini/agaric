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

import { logger } from '../../lib/logger'
import type { PickerItem } from '../SuggestionList'
import { createPickerPlugin, resolveAndInsertPickerToken } from './picker-plugin'

export const blockLinkPickerPluginKey = new PluginKey('blockLinkPicker')

export interface BlockLinkPickerOptions {
  /** Return pages/blocks matching the query. Called on every keystroke after [[. */
  items: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Create a new page with the given title. Returns the new block's ULID. */
  onCreate?: ((label: string) => Promise<string>) | undefined
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockLinkPicker: {
      resolveBlockLinkFromSelection: () => ReturnType
    }
  }
}

/**
 * Exact-match predicate for the BlockLink resolve paths.
 *
 * Look for an exact match: case-insensitive label OR exact alias text.
 * With prefix-alias matching now in `searchPages` (PEND-34), multiple items
 * can carry `isAlias: true` for prefixes that aren't `text` exactly — only
 * the alias whose `aliasText === text` should auto-resolve from the input
 * rule / selection-resolve path. Using `aliasText` instead of the dropped
 * `|| item.isAlias` short-circuit preserves the original "[[my-alias]]
 * resolves to its target page" intent without auto-resolving prefix-only
 * matches like "[[my]]".
 */
function matchBlockLinkItem(items: PickerItem[], text: string): PickerItem | undefined {
  const lower = text.toLowerCase()
  return items.find(
    (item) =>
      !item.isCreate &&
      (item.label.toLowerCase() === lower || item.aliasText?.toLowerCase() === lower),
  )
}

export const BlockLinkPicker = Extension.create<BlockLinkPickerOptions>({
  name: 'blockLinkPicker',

  addOptions() {
    return {
      items: () => [],
      onCreate: undefined,
    }
  },

  addCommands() {
    const extensionOptions = this.options
    return {
      resolveBlockLinkFromSelection:
        () =>
        ({ editor }) => {
          const { from, to } = editor.state.selection
          if (from === to) return false

          const selectedText = editor.state.doc.textBetween(from, to).trim()
          if (!selectedText) return false

          // Capture position before deletion (same race-condition fix as the input rule)
          const insertPos = from
          editor.chain().focus().deleteRange({ from, to }).run()

          // MAINT-203: shared FE-M-15 race-guard.
          void resolveAndInsertPickerToken({
            editor,
            text: selectedText,
            insertPos,
            items: extensionOptions.items,
            matchItem: matchBlockLinkItem,
            tokenFor: (id) => ({ type: 'block_link', attrs: { id } }),
            onCreate: extensionOptions.onCreate,
            loggerComponent: 'BlockLinkPicker',
            errorMessage: 'resolveBlockLinkFromSelection failed, falling back to plain text',
          })
          return true
        },
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

          // Capture the insertion position *before* deletion so the async
          // callback inserts at the correct spot even if the cursor moves.
          const insertPos = range.from

          // Delete the [[text]] range immediately so the raw text doesn't linger
          state.tr.delete(range.from, range.to)

          // MAINT-203: shared FE-M-15 race-guard. Token shape `block_link`;
          // exact-match recognises `aliasText === text` so `[[my-alias]]`
          // resolves to its target page (PEND-34).
          void resolveAndInsertPickerToken({
            editor,
            text: innerText,
            insertPos,
            items: extensionOptions.items,
            matchItem: matchBlockLinkItem,
            tokenFor: (id) => ({ type: 'block_link', attrs: { id } }),
            onCreate: extensionOptions.onCreate,
            loggerComponent: 'BlockLinkPicker',
            errorMessage: 'Failed to resolve block link via input rule, falling back to plain text',
          })
        },
      }),
    ]
  },

  addProseMirrorPlugins() {
    const extensionOptions = this.options
    return [
      createPickerPlugin({
        loggerComponent: 'BlockLinkPicker',
        displayName: 'Block links',
        pluginKey: blockLinkPickerPluginKey,
        char: '[[',
        allowedPrefixes: null,
        allowSpaces: true,
        editor: this.editor,
        items: (query) => extensionOptions.items(query),
        command: ({ editor, range, props }) => {
          const item = props as PickerItem
          if (item.isCreate && extensionOptions.onCreate) {
            extensionOptions
              .onCreate(item.label)
              .then((newId) => {
                if (editor.view?.isDestroyed) return
                editor
                  .chain()
                  .focus()
                  .deleteRange(range)
                  .insertBlockLink(newId)
                  .insertContent(' ')
                  .run()
              })
              .catch((err) => {
                logger.error(
                  'BlockLinkPicker',
                  'Failed to create page for block link',
                  undefined,
                  err,
                )
              })
          } else {
            editor
              .chain()
              .focus()
              .deleteRange(range)
              .insertBlockLink(item.id)
              .insertContent(' ')
              .run()
          }
        },
      }),
    ]
  },
})
