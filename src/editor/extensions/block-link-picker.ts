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

import { type Editor, Extension, InputRule } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { logger } from '../../lib/logger'
import type { PickerItem } from '../SuggestionList'
import { createPickerPlugin } from './picker-plugin'

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
 * Shared async resolve-and-insert path for the BlockLinkPicker entry points.
 *
 * Both the input rule (typing `[[text]]`) and the command
 * (`resolveBlockLinkFromSelection`) share the same resolution shape:
 *   1. async items lookup
 *   2. exact-match check (case-insensitive label OR alias match)
 *   3. on match → insert `block_link` node at `insertPos`
 *   4. on no match + `onCreate` → create new page, insert link
 *   5. on no match + no `onCreate` → re-insert plain `text`
 *   6. on error → log + re-insert plain `text`
 *
 * Branch coverage for this helper is provided by the existing input-rule and
 * command tests in `__tests__/block-link-picker.test.ts` — both paths exercise
 * every branch (exact match, onCreate, plain-text fallback, error fallback).
 */
async function resolveAndInsertBlockLink(
  editor: Editor,
  text: string,
  insertPos: number,
  options: BlockLinkPickerOptions,
  errorMessage: string,
): Promise<void> {
  // FE-M-15: insertContentAt clamps silently when insertPos is past the
  // doc's end (e.g. user cleared/shrank the doc while the async resolve
  // was in flight), so the existing try/catch never fires on that path.
  // Validate before each insertContentAt(insertPos, ...) call; on a stale
  // offset, fall back to plain text at the current cursor.
  const isStale = () => insertPos > editor.state.doc.content.size
  const insertPlainAtCursor = () => {
    editor.chain().focus().insertContent(text).run()
  }

  try {
    const items = await options.items(text)
    // Look for an exact match: case-insensitive label OR exact alias
    // text. With prefix-alias matching now in `searchPages` (PEND-34),
    // multiple items can carry `isAlias: true` for prefixes that aren't
    // `text` exactly — only the alias whose `aliasText === text` should
    // auto-resolve from the input rule / selection-resolve path. Using
    // `aliasText` instead of the dropped `|| item.isAlias` short-circuit
    // preserves the original "[[my-alias]] resolves to its target page"
    // intent without auto-resolving prefix-only matches like "[[my]]".
    const lower = text.toLowerCase()
    const exactMatch = items.find(
      (item) =>
        !item.isCreate &&
        (item.label.toLowerCase() === lower || item.aliasText?.toLowerCase() === lower),
    )
    if (exactMatch) {
      if (isStale()) {
        logger.warn(
          'BlockLinkPicker',
          'insertPos stale after items resolved; falling back to plain text at cursor',
          { text, insertPos, docSize: editor.state.doc.content.size },
        )
        insertPlainAtCursor()
        return
      }
      editor
        .chain()
        .focus()
        .insertContentAt(insertPos, { type: 'block_link', attrs: { id: exactMatch.id } })
        .run()
    } else if (options.onCreate) {
      const newId = await options.onCreate(text)
      if (isStale()) {
        logger.warn(
          'BlockLinkPicker',
          'insertPos stale after onCreate resolved; falling back to plain text at cursor',
          { text, insertPos, docSize: editor.state.doc.content.size },
        )
        insertPlainAtCursor()
        return
      }
      editor
        .chain()
        .focus()
        .insertContentAt(insertPos, { type: 'block_link', attrs: { id: newId } })
        .run()
    } else {
      // No match and no onCreate — re-insert as plain text
      if (isStale()) {
        insertPlainAtCursor()
        return
      }
      editor.chain().focus().insertContentAt(insertPos, text).run()
    }
  } catch (err) {
    logger.warn('BlockLinkPicker', errorMessage, { text }, err)
    // On error, re-insert as plain text so the user doesn't lose content
    if (isStale()) {
      insertPlainAtCursor()
      return
    }
    editor.chain().focus().insertContentAt(insertPos, text).run()
  }
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

          void resolveAndInsertBlockLink(
            editor,
            selectedText,
            insertPos,
            extensionOptions,
            'resolveBlockLinkFromSelection failed, falling back to plain text',
          )
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

          // Async resolve via the shared helper — inserts at the captured
          // position to avoid a race with subsequent user edits.
          void resolveAndInsertBlockLink(
            editor,
            innerText,
            insertPos,
            extensionOptions,
            'Failed to resolve block link via input rule, falling back to plain text',
          )
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
