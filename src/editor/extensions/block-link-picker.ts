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
 *
 * Typed as `![[` (Obsidian's embed syntax) in an otherwise empty paragraph,
 * the same popup writes the pick as the embed `{{embed [[ULID]]}}` rather
 * than as a link, and so does a whole `![[text]]` typed there (#6033).
 *
 * An anchor kept when the page before its `#` is linked, typed whole or picked,
 * names a block of that page through `findAnchor`: `[[Page#Heading]]` and
 * `[[Page#^ULID]]` store the block ref `((ULID))`, or the embed
 * `{{embed ((ULID))}}`, and so does `[[#Heading]]` for the editor's own page.
 * An anchor that names no block links the page, and `[[#Heading]]` stays text
 * (#6033).
 */

import { type Content, type Editor, Extension, InputRule } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { type EditorState, PluginKey } from '@tiptap/pm/state'

import {
  createPickerPlugin,
  createPickerTokenFromCommand,
  resolveAndInsertPickerToken,
} from '@/editor/extensions/picker-plugin'
import { storableLinkLabel } from '@/editor/markdown-common'
import { PAGE_BLOCK } from '@/editor/page-mode/page-block-name'
import type { PickerItem } from '@/editor/SuggestionList'
import { EMBED_TOKEN_PREFIX } from '@/lib/embed-token'
import { t } from '@/lib/i18n'
import { type LinkReading, linkBodyReadings, normalizeTagName } from '@/lib/name-tokens'

export const blockLinkPickerPluginKey = new PluginKey('blockLinkPicker')

export interface BlockLinkPickerOptions {
  /** Return pages/blocks matching the query. Called on every keystroke after [[. */
  items: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Create a new page with the given title. Returns the new block's ULID. */
  onCreate?: ((label: string) => Promise<string>) | undefined
  /**
   * The block an `anchor` (a heading's text or `^ULID`) names on page
   * `pageId`, or on the editor's own page when `pageId` is undefined (#6033).
   * Without it an anchor is dropped and the page is linked.
   */
  findAnchor?:
    | ((pageId: string | undefined, anchor: string) => Promise<string | undefined>)
    | undefined
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
 * (#5160 N4): the exact full title, else the unique title that folds to `text`
 * (`normalizeTagName`: NFC, case-insensitive), else the unique alias whose
 * `aliasText` folds to it, else `undefined`, which creates the page. Two pages a
 * title matches alike, exactly or folded, are never guessed: `null` leaves the
 * text as typed. Titles are compared whole, namespace included (`item.title`),
 * so typing an existing namespaced title creates no twin; prefix-only alias hits
 * (`[[my]]` for alias `my-alias`) never resolve.
 */
export function matchBlockLinkItem(
  items: PickerItem[],
  text: string,
): PickerItem | undefined | null {
  const pages = items.filter((item) => !item.isCreate && !item.isAlias)
  const unique = (found: PickerItem[]) => (found.length > 1 ? null : found[0])
  const exact = unique(pages.filter((item) => (item.title ?? item.label) === text))
  if (exact !== undefined) return exact
  const key = normalizeTagName(text)
  const folded = unique(pages.filter((item) => normalizeTagName(item.title ?? item.label) === key))
  if (folded !== undefined) return folded
  return items.find(
    (item) =>
      !item.isCreate && item.aliasText !== undefined && normalizeTagName(item.aliasText) === key,
  )
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
 * The anchor an anchored link `name` keeps once {@link anchorBase} names its
 * page: the text after its first `#`; none when that is empty.
 */
function anchorOf(name: string): string | undefined {
  return name.slice(name.indexOf('#') + 1) || undefined
}

/** The anchor of an anchor-only `[[#anchor]]` body, which names no page (#6033). */
function ownPageAnchor(body: string): string | undefined {
  const pipe = body.indexOf('|')
  const name = (pipe < 0 ? body : body.slice(0, pipe)).trim()
  return name.startsWith('#') ? anchorOf(name) : undefined
}

/** Whether `name` names the picked `item` as {@link matchBlockLinkItem} compares. */
function namesItem(item: PickerItem, name: string): boolean {
  return name !== '' && matchBlockLinkItem([item], name) === item
}

/** The first of the typed `body`'s readings that names `item`, whole or before an anchor. */
function pickedReading(item: PickerItem, body: string): LinkReading | undefined {
  return linkBodyReadings(body).find(
    (reading) => namesItem(item, reading.name) || namesItem(item, anchorBase(reading.name)),
  )
}

/**
 * The label a picked `item` keeps from the typed `body` (#5160 D9, D10): the
 * text after the first of the body's readings that names the item as
 * {@link matchBlockLinkItem} compares, by its whole name or, as the input
 * rule reads it, the name before an anchor; none for the whole body, else the
 * text after the first `|`; never the item's own title.
 */
export function pickedLinkLabel(item: PickerItem, body: string): string | undefined {
  const label = (pickedReading(item, body) ?? linkBodyReadings(body).at(-1))?.label
  return label === (item.title ?? item.label) ? undefined : label
}

/**
 * The anchor a picked `item` keeps from the typed `body` (#6033): that of the
 * first reading naming the item by the name before its anchor, not whole.
 */
function pickedLinkAnchor(item: PickerItem, body: string): string | undefined {
  const reading = pickedReading(item, body)
  return reading === undefined || namesItem(item, reading.name) ? undefined : anchorOf(reading.name)
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

/** The ref of block `id`, `((id))`, or its embed `{{embed ((id))}}` (#6033). */
function blockRefContent(id: string, embed: boolean): Content {
  const ref = { type: 'block_ref', attrs: { id } }
  return embed
    ? [{ type: 'text', text: EMBED_TOKEN_PREFIX }, ref, { type: 'text', text: '}}' }]
    : ref
}

/** The embed of page `id`, `{{embed [[id]]}}`; the link stays a node so it serializes bare. */
function pageEmbedContent(id: string): Content {
  return [
    { type: 'text', text: EMBED_TOKEN_PREFIX },
    { type: 'block_link', attrs: { id } },
    { type: 'text', text: '}}' },
  ]
}

/**
 * Whether the `!` at `bang` before a `[[` link typed up to `to` makes it an
 * embed: only when the embed will be its block's whole content, the one place
 * an embed renders, which is the whole text of a plain paragraph alone in the
 * block (block mode's doc, a page block in page mode). Elsewhere (`Hello![[`,
 * `\![[`, a heading, quote, list item, task or second paragraph) the `!` stays
 * text before a link. An embed keeps no label, which `{{embed [[ULID]]}}` has
 * no room for.
 */
function embedsAt(doc: PMNode, bang: number, to: number): boolean {
  if (doc.textBetween(bang, bang + 1) !== '!') return false
  const $bang = doc.resolve(bang)
  const paragraph = $bang.parent
  const block = $bang.node($bang.depth - 1)
  return (
    paragraph.type.name === 'paragraph' &&
    paragraph.attrs['todoState'] == null &&
    (block.type.name === 'doc' || block.type.name === PAGE_BLOCK) &&
    block.childCount === 1 &&
    $bang.parentOffset === 0 &&
    to === $bang.end()
  )
}

/**
 * Take a typed `[[…]]` (`text`, over `range`) out of the document, so the raw
 * text does not linger while its link resolves: whether it embeds, where its
 * token goes, captured before the delete so the async insert lands there even
 * if the caret moves, and the text that goes back when no token lands. A `!`
 * that makes no embed stays text before the link.
 */
function takeTyped(
  state: EditorState,
  range: { from: number; to: number },
  text: string,
): { embed: boolean; insertPos: number; typed: string } {
  const bang = text.startsWith('!')
  const embed = bang && embedsAt(state.doc, range.from, range.to)
  const insertPos = bang && !embed ? range.from + 1 : range.from
  state.tr.delete(insertPos, range.to)
  return { embed, insertPos, typed: text.slice(insertPos - range.from) }
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
 * its first `#`, the page before the `#`, with that anchor, which is never
 * minted into a title (N6).
 */
async function findTypedName(
  options: BlockLinkPickerOptions,
  name: string,
): Promise<{ item: PickerItem | null | undefined; anchor?: string | undefined }> {
  const whole = matchBlockLinkItem(await options.items(name), name)
  const base = anchorBase(name)
  if (whole !== undefined || base === '') return { item: whole }
  return { item: matchBlockLinkItem(await options.items(base), base), anchor: anchorOf(name) }
}

export const BlockLinkPicker = Extension.create<BlockLinkPickerOptions>({
  name: 'blockLinkPicker',

  addOptions() {
    return {
      items: () => [],
      onCreate: undefined,
      findAnchor: undefined,
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
      // — unless a `#` makes it the tag `#[[text]]` (#5160 N7). A `!` before
      // it is matched too, to make the link an embed where `embedsAt` holds.
      new InputRule({
        find: /(?<!#)!?\[\[([^\]]+)\]\]$/,
        handler: ({ state, range, match }) => {
          const body = match[1] ?? ''
          const link = parseTypedLink(body)
          const { findAnchor } = extensionOptions

          if (!link) {
            // `[[#anchor]]` names a block of this editor's page, else stays text.
            const anchor = ownPageAnchor(body)
            if (anchor === undefined || !findAnchor) return
            const { embed, insertPos, typed } = takeTyped(state, range, match[0])
            let block: string | undefined
            void resolveAndInsertPickerToken({
              editor,
              text: anchor,
              typed,
              insertPos,
              items: async () => {
                block = await findAnchor(undefined, anchor)
                return []
              },
              matchItem: () => (block === undefined ? null : { id: block, label: anchor }),
              tokenFor: (id) => blockRefContent(id, embed),
              loggerComponent: 'BlockLinkPicker',
              errorMessage:
                'Failed to resolve an anchor via input rule, falling back to plain text',
            })
            return
          }

          const { embed, insertPos, typed } = takeTyped(state, range, match[0])

          // The first of the body's readings that names a page wins, with that
          // reading's label and the block its anchor names; a tie leaves the
          // text as typed; with none, the first-`|` split creates its base.
          let found: PickerItem | null | undefined
          let label: string | undefined
          let block: string | undefined
          void resolveAndInsertPickerToken({
            editor,
            text: link.base,
            typed,
            insertPos,
            items: async () => {
              for (const reading of linkBodyReadings(body)) {
                const named = await findTypedName(extensionOptions, reading.name)
                found = named.item
                label = reading.label
                if (found && named.anchor !== undefined) {
                  block = await findAnchor?.(found.id, named.anchor)
                }
                if (found !== undefined) break
              }
              return found ? [found] : []
            },
            matchItem: () => found,
            tokenFor: (id, item) => {
              if (block !== undefined) return blockRefContent(block, embed)
              return embed
                ? pageEmbedContent(id)
                : blockLinkNode(id, label, item ? (item.title ?? item.label) : link.base)
            },
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
        // `#[[` starts a tag, not a page link (#5160 N7).
        allow: ({ state, range }) => state.doc.textBetween(range.from - 1, range.from) !== '#',
        editor: this.editor,
        // The popup searches the base name: a `|label` or `#anchor` typed after
        // it is not part of any title (#5160 D9, N6).
        items: (query) => extensionOptions.items(parseTypedLink(query)?.base ?? query),
        command: ({ editor, range, props }) => {
          const item = props as PickerItem
          const body = typedBodyAt(editor, range)
          const typed = body === null ? null : parseTypedLink(body)
          // An embed takes the `!` with it.
          const embed = embedsAt(editor.state.doc, range.from - 1, range.to)
          const replaced = embed ? { from: range.from - 1, to: range.to } : range
          const anchor = body === null ? undefined : pickedLinkAnchor(item, body)
          const { findAnchor } = extensionOptions
          if (item.isCreate && extensionOptions.onCreate) {
            // Shared create path: deletes the trigger range synchronously
            // (closing the popup and the double-create window) and tracks
            // the insertion offset across the async create IPC.
            const label = typed?.base ?? item.label
            createPickerTokenFromCommand({
              editor,
              range: replaced,
              label,
              onCreate: extensionOptions.onCreate,
              tokenFor: (id) =>
                embed ? pageEmbedContent(id) : blockLinkNode(id, typed?.label, label),
              loggerComponent: 'BlockLinkPicker',
              errorMessage: 'Failed to create page for block link',
            })
          } else if (anchor !== undefined && findAnchor) {
            // The block the anchor names on the picked page, else the page.
            const typedText = editor.state.doc.textBetween(replaced.from, replaced.to)
            const label = pickedLinkLabel(item, body ?? '')
            editor.chain().focus().deleteRange(replaced).run()
            let block: string | undefined
            void resolveAndInsertPickerToken({
              editor,
              text: item.label,
              typed: typedText,
              insertPos: replaced.from,
              items: async () => {
                block = await findAnchor(item.id, anchor)
                return [item]
              },
              matchItem: () => item,
              tokenFor: (id) => {
                if (block !== undefined) return blockRefContent(block, embed)
                return embed
                  ? pageEmbedContent(id)
                  : blockLinkNode(id, label, item.title ?? item.label)
              },
              loggerComponent: 'BlockLinkPicker',
              errorMessage: 'Failed to resolve a picked anchor, falling back to plain text',
            })
          } else if (embed) {
            editor
              .chain()
              .focus()
              .deleteRange(replaced)
              .insertContent(pageEmbedContent(item.id))
              .run()
          } else {
            const label = body === null ? undefined : pickedLinkLabel(item, body)
            editor.chain().focus().deleteRange(range).insertBlockLink(item.id, label).run()
          }
        },
      }),
    ]
  },
})
