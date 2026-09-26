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
 * `Page#Heading` (N6). A page titled with the text up to a later `|`, or with
 * all of it, wins over the first `|` (D10): `[[A | B]]` links `A | B`.
 */

import { type Editor, Extension, InputRule } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'

import {
  createPickerPlugin,
  createPickerTokenFromCommand,
  resolveAndInsertPickerToken,
} from '@/editor/extensions/picker-plugin'
import { storableLinkLabel } from '@/editor/markdown-common'
import type { PickerItem } from '@/editor/SuggestionList'
import { t } from '@/lib/i18n'
import { linkBodyReadings } from '@/lib/name-tokens'

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
 * creates the page. Two pages a title matches alike, exactly or by case, are
 * never guessed: `null` leaves the text as typed. Titles are compared whole,
 * namespace included (`item.title`), so typing an existing namespaced title
 * creates no twin; prefix-only alias hits (`[[my]]` for alias `my-alias`)
 * never resolve.
 */
export function matchBlockLinkItem(
  items: PickerItem[],
  text: string,
): PickerItem | undefined | null {
  const pages = items.filter((item) => !item.isCreate && !item.isAlias)
  const unique = (found: PickerItem[]) => (found.length > 1 ? null : found[0])
  const exact = unique(pages.filter((item) => (item.title ?? item.label) === text))
  if (exact !== undefined) return exact
  const lower = text.toLowerCase()
  const folded = unique(pages.filter((item) => (item.title ?? item.label).toLowerCase() === lower))
  if (folded !== undefined) return folded
  return items.find((item) => !item.isCreate && item.aliasText?.toLowerCase() === lower)
}

/** What a typed `[[…]]` body means (#5160 D9, D10). */
export interface TypedLink {
  /** The text before the first `|` and then before its first `#`, trimmed: the page it creates. */
  base: string
  /** The trimmed text after the first `|`, when there is one. */
  label: string | undefined
}

/**
 * Split a typed link body into its base and label; `null` for an anchor-only
 * `[[#heading]]`, which names no page.
 */
export function parseTypedLink(inner: string): TypedLink | null {
  const pipe = inner.indexOf('|')
  const name = (pipe < 0 ? inner : inner.slice(0, pipe)).trim()
  const label = pipe < 0 ? undefined : inner.slice(pipe + 1).trim() || undefined
  const hash = name.indexOf('#')
  const base = hash < 0 ? name : name.slice(0, hash).trim()
  if (base === '') return null
  return { base, label }
}

/**
 * The page an anchored link `name` falls back to (D10, N6): the text before
 * its first `#` when an anchor holding no `|` follows it, else `''`.
 */
function anchorBase(name: string): string {
  const hash = name.indexOf('#')
  return hash < 0 || name.slice(hash + 1).includes('|') ? '' : name.slice(0, hash).trim()
}

/**
 * The label a picked `item` keeps from the typed `body` (#5160 D9, D10): the
 * text after the first of the body's readings that names the item as
 * {@link matchBlockLinkItem} compares, by its whole name or, as the input
 * rule reads it, the name before an anchor; none for the whole body, else the
 * text after the first `|`; never the item's own title.
 */
export function pickedLinkLabel(item: PickerItem, body: string): string | undefined {
  const readings = linkBodyReadings(body)
  const names = (name: string) => name !== '' && matchBlockLinkItem([item], name) === item
  const named = readings.find((reading) => names(reading.name) || names(anchorBase(reading.name)))
  const label = (named ?? readings.at(-1))?.label
  return label === (item.title ?? item.label) ? undefined : label
}

/**
 * The `block_link` node for `id`, labelled unless the label is empty or the
 * target's `title`, which the chip shows anyway and follows through renames.
 */
export function blockLinkNode(
  id: string,
  label: string | undefined,
  title: string | undefined,
): Record<string, unknown> {
  const stored = storableLinkLabel(label)
  return stored && stored !== title
    ? { type: 'block_link', attrs: { id, label: stored } }
    : { type: 'block_link', attrs: { id } }
}

/** The link body typed after the popup's `[[` trigger over `range`, or `null` when unreadable. */
function typedBodyAt(editor: Editor, range: { from: number; to: number }): string | null {
  try {
    return editor.state.doc.textBetween(range.from, range.to).replace(/^\[\[/, '')
  } catch {
    // A range the document no longer holds.
    return null
  }
}

/**
 * The page a link name names among the `items` it is searched for (D10): the
 * page titled with the whole name, else, when an anchor holding no `|` follows
 * its first `#`, the page before the `#`, so the anchor is dropped rather than
 * minted into a title (N6).
 */
async function findTypedName(
  options: BlockLinkPickerOptions,
  name: string,
): Promise<PickerItem | null | undefined> {
  const whole = matchBlockLinkItem(await options.items(name), name)
  const base = anchorBase(name)
  if (whole !== undefined || base === '') return whole
  return matchBlockLinkItem(await options.items(base), base)
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

          // The selection is prose, not link syntax: its whole text names the
          // page, so no `#` or `|` in it is read as an anchor or a label.
          void resolveAndInsertPickerToken({
            editor,
            text: selectedText,
            insertPos,
            items: extensionOptions.items,
            matchItem: matchBlockLinkItem,
            tokenFor: (id) => blockLinkNode(id, undefined, undefined),
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
          const body = match[1] ?? ''
          const link = parseTypedLink(body)
          if (!link) return

          // Capture the insertion position *before* deletion so the async
          // callback inserts at the correct spot even if the cursor moves.
          const insertPos = range.from

          // Delete the [[text]] range immediately so the raw text doesn't linger
          state.tr.delete(range.from, range.to)

          // The first of the body's readings that names a page wins, with that
          // reading's label; a tie leaves the text as typed; with none, the
          // first-`|` split creates its base.
          let found: PickerItem | null | undefined
          let label: string | undefined
          void resolveAndInsertPickerToken({
            editor,
            text: link.base,
            typed: match[0],
            insertPos,
            items: async () => {
              for (const reading of linkBodyReadings(body)) {
                found = await findTypedName(extensionOptions, reading.name)
                label = reading.label
                if (found !== undefined) break
              }
              return found ? [found] : []
            },
            matchItem: () => found,
            tokenFor: (id, item) =>
              blockLinkNode(id, label, item ? (item.title ?? item.label) : link.base),
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
        // The popup searches the base name: a `|label` or `#anchor` typed after
        // it is not part of any title (#5160 D9, N6).
        items: (query) => extensionOptions.items(parseTypedLink(query)?.base ?? query),
        command: ({ editor, range, props }) => {
          const item = props as PickerItem
          const body = typedBodyAt(editor, range)
          const typed = body === null ? null : parseTypedLink(body)
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
              tokenFor: (id) => blockLinkNode(id, typed?.label, label),
              loggerComponent: 'BlockLinkPicker',
              errorMessage: 'Failed to create page for block link',
            })
          } else {
            const label = body === null ? undefined : pickedLinkLabel(item, body)
            editor.chain().focus().deleteRange(range).insertBlockLink(item.id, label).run()
          }
        },
      }),
    ]
  },
})
