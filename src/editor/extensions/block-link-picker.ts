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

import {
  createPickerPlugin,
  createPickerTokenFromCommand,
  resolveAndInsertPickerToken,
} from '@/editor/extensions/picker-plugin'
import type { PickerItem } from '@/editor/SuggestionList'
import { t } from '@/lib/i18n'

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
 * The page `[[text]]` names among `items`, by the one rule the backend applies
 * (#5160 N4): the exact full title, else the unique case-insensitive title,
 * else the unique alias whose `aliasText` is `text`, else `undefined`, which
 * creates the page. Two pages that differ only by case are never guessed:
 * `null` leaves the text as typed. Titles are compared whole, namespace
 * included (`item.title`), so typing an existing namespaced title creates no
 * twin; prefix-only alias hits (`[[my]]` for alias `my-alias`) never resolve.
 */
export function matchBlockLinkItem(
  items: PickerItem[],
  text: string,
): PickerItem | undefined | null {
  const pages = items.filter((item) => !item.isCreate && !item.isAlias)
  const exact = pages.find((item) => (item.title ?? item.label) === text)
  if (exact) return exact
  const lower = text.toLowerCase()
  const folded = pages.filter((item) => (item.title ?? item.label).toLowerCase() === lower)
  if (folded.length === 1) return folded[0]
  if (folded.length > 1) return null
  return items.find((item) => !item.isCreate && item.aliasText?.toLowerCase() === lower)
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

          // Shared race-guard.
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

          // Shared race-guard. Token shape `block_link`;
          // exact-match recognises `aliasText === text` so `[[my-alias]]`
          // Resolves to its target page.
          void resolveAndInsertPickerToken({
            editor,
            text: innerText,
            typed: match[0],
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
        displayName: t('editor.suggestion.blockLinks'),
        pluginKey: blockLinkPickerPluginKey,
        char: '[[',
        allowedPrefixes: null,
        allowSpaces: true,
        editor: this.editor,
        items: (query) => extensionOptions.items(query),
        command: ({ editor, range, props }) => {
          const item = props as PickerItem
          if (item.isCreate && extensionOptions.onCreate) {
            // Shared create path: deletes the trigger range synchronously
            // (closing the popup and the double-create window) and tracks
            // the insertion offset across the async create IPC.
            createPickerTokenFromCommand({
              editor,
              range,
              label: item.label,
              onCreate: extensionOptions.onCreate,
              tokenFor: (id) => ({ type: 'block_link', attrs: { id } }),
              loggerComponent: 'BlockLinkPicker',
              errorMessage: 'Failed to create page for block link',
            })
          } else {
            editor.chain().focus().deleteRange(range).insertBlockLink(item.id).run()
          }
        },
      }),
    ]
  },
})
