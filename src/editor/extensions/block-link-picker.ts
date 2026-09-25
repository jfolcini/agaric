/**
 * TipTap extension: [[ block-link picker (page autocomplete).
 *
 * Two ways to insert a block link:
 * 1. **Picker** — Type [[ to open the suggestion popup, select from list.
 * 2. **Input rule** — Type [[text]] (with closing brackets) to auto-resolve.
 *    If an exact-match page exists, links to it. Otherwise creates it.
 *
 * Both resolve to ULID, never writing [[title]] to storage. A `|label` after
 * the name is stored on the link (#5160 D9) unless it is the page's own title,
 * and a `#anchor` names the page titled with the whole text when one exists
 * (D10), else the page before the `#`: typing `[[Page#Heading]]` never creates
 * `Page#Heading` (N6).
 */

import { type Editor, Extension, InputRule } from '@tiptap/core'
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

/** What a typed `[[…]]` body means (#5160 D9, D10). */
export interface TypedLink {
  /** The text before the first `|`, trimmed: what a page must be titled to win whole. */
  name: string
  /** `name` before its first `#`, trimmed: the page an anchored name falls back to. */
  base: string
  /** The trimmed text after the first `|`, when there is one. */
  label: string | undefined
}

/**
 * Split a typed link body into its name, base and label; `null` for an
 * anchor-only `[[#heading]]`, which names no page.
 */
export function parseTypedLink(inner: string): TypedLink | null {
  const pipe = inner.indexOf('|')
  const name = (pipe < 0 ? inner : inner.slice(0, pipe)).trim()
  const label = pipe < 0 ? undefined : inner.slice(pipe + 1).trim() || undefined
  const hash = name.indexOf('#')
  const base = hash < 0 ? name : name.slice(0, hash).trim()
  if (base === '') return null
  return { name, base, label }
}

/**
 * The `block_link` node for `id`, labelled unless the label is empty or the
 * target's `title`, which the chip shows anyway and follows through renames.
 */
export function blockLinkToken(
  id: string,
  label: string | undefined,
  title: string | undefined,
): Record<string, unknown> {
  return label && label !== title
    ? { type: 'block_link', attrs: { id, label } }
    : { type: 'block_link', attrs: { id } }
}

/** The link typed after the popup's `[[` trigger over `range`, or `null` when unreadable. */
function typedLinkAt(editor: Editor, range: { from: number; to: number }): TypedLink | null {
  try {
    const typed = editor.state.doc.textBetween(range.from, range.to)
    return parseTypedLink(typed.replace(/^\[\[/, ''))
  } catch {
    // A range the document no longer holds.
    return null
  }
}

/**
 * Resolve a typed link and insert its chip at `insertPos`. `text` is the base
 * name; with an anchor, a page titled with the whole name is looked up first
 * (D10) and the base only when none is, so the anchor is dropped rather than
 * minted into a title (N6).
 */
function resolveTypedLink(
  editor: Editor,
  options: BlockLinkPickerOptions,
  link: TypedLink,
  typed: string,
  insertPos: number,
  errorMessage: string,
): void {
  const whole = link.name === link.base ? null : link.name
  void resolveAndInsertPickerToken({
    editor,
    text: link.base,
    typed,
    insertPos,
    items: async (query) => {
      if (whole === null) return options.items(query)
      const exact = await options.items(whole)
      return matchBlockLinkItem(exact, whole) ? exact : options.items(query)
    },
    matchItem: (items, query) => {
      const exact = whole === null ? undefined : matchBlockLinkItem(items, whole)
      return exact === undefined ? matchBlockLinkItem(items, query) : exact
    },
    tokenFor: (id, item) =>
      blockLinkToken(id, link.label, item ? (item.title ?? item.label) : link.base),
    onCreate: options.onCreate,
    loggerComponent: 'BlockLinkPicker',
    errorMessage,
  })
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

          const link = parseTypedLink(selectedText)
          if (!link) return false

          // Capture position before deletion (same race-condition fix as the input rule)
          const insertPos = from
          editor.chain().focus().deleteRange({ from, to }).run()

          // Shared race-guard.
          resolveTypedLink(
            editor,
            extensionOptions,
            link,
            selectedText,
            insertPos,
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
          const link = parseTypedLink(match[1] ?? '')
          if (!link) return

          // Capture the insertion position *before* deletion so the async
          // callback inserts at the correct spot even if the cursor moves.
          const insertPos = range.from

          // Delete the [[text]] range immediately so the raw text doesn't linger
          state.tr.delete(range.from, range.to)

          // Shared race-guard. Token shape `block_link`;
          // exact-match recognises `aliasText === text` so `[[my-alias]]`
          // Resolves to its target page.
          resolveTypedLink(
            editor,
            extensionOptions,
            link,
            match[0],
            insertPos,
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
        displayName: t('editor.suggestion.blockLinks'),
        pluginKey: blockLinkPickerPluginKey,
        char: '[[',
        allowedPrefixes: null,
        allowSpaces: true,
        editor: this.editor,
        // The popup searches the base name: a `|label` or `#anchor` typed after
        // it is not part of any title (#5160 D9, N6).
        items: (query) => extensionOptions.items(parseTypedLink(query)?.base ?? query),
        command: ({ editor, range, props }) => {
          const item = props as PickerItem
          const typed = typedLinkAt(editor, range)
          if (item.isCreate && extensionOptions.onCreate) {
            // Shared create path: deletes the trigger range synchronously
            // (closing the popup and the double-create window) and tracks
            // the insertion offset across the async create IPC.
            const label = typed?.base ?? item.label
            createPickerTokenFromCommand({
              editor,
              range,
              label,
              onCreate: extensionOptions.onCreate,
              tokenFor: (id) => blockLinkToken(id, typed?.label, label),
              loggerComponent: 'BlockLinkPicker',
              errorMessage: 'Failed to create page for block link',
            })
          } else {
            const title = item.title ?? item.label
            const label =
              typed?.label !== undefined && typed.label !== title ? typed.label : undefined
            editor.chain().focus().deleteRange(range).insertBlockLink(item.id, label).run()
          }
        },
      }),
    ]
  },
})
