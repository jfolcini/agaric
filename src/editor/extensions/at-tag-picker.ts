/**
 * TipTap extension: the `@` and `#` tag pickers and the typed tag (#5160 D8).
 *
 * - `@` opens the tag picker after a space or at the start of a block.
 * - `#` opens the same picker exactly where typing a space would make `#query`
 *   a tag: at the start of the text or after whitespace, never on `#42`, in
 *   code, or on a bare `#` run, so Space and Enter still make `# ` … `###### `
 *   headings.
 * - Typing `#name` and then a space or punctuation makes the tag without
 *   picking, and so does closing `#[[multi word]]` (N7): the existing tag of
 *   that name in any case, else a new one. The terminator stays after the tag;
 *   Enter is left to the picker or the block. {@link completedTag} reads the
 *   name with the rule import, paste and the buffer use (`scanNameTokens`), so
 *   `#42`, `a#b`, `(#tag`, `x.com/#frag`, `&#39;`, `\#tag` and a `#` in a URL,
 *   a link destination, inline code or a `[[link]]` stay text. A `#name` left
 *   as text when the block is saved becomes the tag then (`unmount-flush.ts`).
 * - TipTap runs input rules when an IME composition ends, so a composed
 *   `#name ` becomes a tag too.
 *
 * Either way the block holds a `tag_ref` node, stored as `#[ULID]`.
 */

import { type Editor, Extension, getTextContentFromNodes, InputRule } from '@tiptap/core'
import { type EditorState, PluginKey } from '@tiptap/pm/state'

import {
  createPickerPlugin,
  createPickerTokenFromCommand,
  type PickerPluginConfig,
  resolveAndInsertPickerToken,
} from '@/editor/extensions/picker-plugin'
import type { PickerItem } from '@/editor/SuggestionList'
import { t } from '@/lib/i18n'
import { scanNameTokens } from '@/lib/name-tokens'

export const atTagPickerPluginKey = new PluginKey('atTagPicker')
export const hashTagPickerPluginKey = new PluginKey('hashTagPicker')

export interface AtTagPickerOptions {
  /** Return tags matching the query. Called on every keystroke after @ or #. */
  items: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Create a new tag with the given name. Returns the new tag's ULID. */
  onCreate?: ((name: string) => Promise<string>) | undefined
}

/** A tag the last typed character completes. */
export interface CompletedTag {
  /** The trimmed name the tag resolves. */
  name: string
  /** The token as typed, `#name` or `#[[name]]`: what goes back when no tag lands. */
  typed: string
  /** The character that ended a bare `#name`, which stays after the tag; empty for `#[[name]]`. */
  terminator: string
}

/**
 * The tag `text` completes with its last character: a bare `#name` that
 * character ends, or a `#[[name]]` it closes. `text` is read as it will read
 * once an inline-code span, a `[[` link or a `](` destination still open in it
 * is closed, so a `#` inside one stays text. `null` for Enter, which is the
 * picker's or the block's.
 */
export function completedTag(text: string): CompletedTag | null {
  const terminator = /[^]$/u.exec(text)?.[0]
  if (terminator === undefined || terminator === '\n') return null
  const closers =
    ((text.match(/`/g)?.length ?? 0) % 2 === 1 ? '`' : '') +
    (/\[\[[^\]\n]*\]?$/.test(text) ? ']]' : '') +
    (/\]\([^)\n]*$/.test(text) ? ')' : '')
  for (const token of scanNameTokens(text + closers)) {
    if (token.kind !== 'tag') continue
    const typed = text.slice(token.start, token.end)
    const bracketed = typed.startsWith('#[[')
    if (token.end === (bracketed ? text.length : text.length - terminator.length)) {
      return { name: token.name, typed, terminator: bracketed ? '' : terminator }
    }
  }
  return null
}

/** Whether `pos` is in a code block or inline code, where TipTap runs no input rule either. */
function inCode(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos)
  if ($pos.parent.type.spec.code) return true
  return ($pos.nodeBefore ?? $pos.nodeAfter)?.marks.some((mark) => mark.type.spec.code) ?? false
}

/** The `@` or `#` picker: one search, create and insertion for both triggers. */
function tagPicker(
  extension: { editor: Editor; options: AtTagPickerOptions },
  trigger: Pick<
    PickerPluginConfig,
    'pluginKey' | 'char' | 'allowSpaces' | 'allowedPrefixes' | 'allow'
  >,
) {
  const { options } = extension
  return createPickerPlugin({
    loggerComponent: 'AtTagPicker',
    displayName: t('editor.suggestion.tags'),
    ...trigger,
    editor: extension.editor,
    items: (query) => options.items(query),
    command: ({ editor, range, props }) => {
      const item = props as PickerItem
      if (item.isCreate && options.onCreate) {
        // Shared create path: deletes the trigger range synchronously
        // (closing the popup and the double-create window) and tracks
        // the insertion offset across the async create IPC.
        createPickerTokenFromCommand({
          editor,
          range,
          label: item.label,
          onCreate: options.onCreate,
          tokenFor: (id) => ({ type: 'tag_ref', attrs: { id } }),
          loggerComponent: 'AtTagPicker',
          errorMessage: 'Failed to create tag',
        })
      } else {
        editor.chain().focus().deleteRange(range).insertTagRef(item.id).run()
      }
    },
  })
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
        find: (text) => {
          const tag = completedTag(text)
          if (!tag) return null
          const matched = tag.typed + tag.terminator
          return { index: text.length - matched.length, text: matched, data: tag }
        },
        handler: ({ state, range, match }) => {
          const tag = match.data as CompletedTag
          // The range is what the typed text replaces: the token, a selection
          // typed over, and the terminator once an IME composition has put it
          // in the document. The terminator alone takes its place.
          state.tr.insertText(tag.terminator, range.from, range.to)

          void resolveAndInsertPickerToken({
            editor,
            text: tag.name,
            typed: tag.typed,
            insertPos: range.from,
            items: extensionOptions.items,
            matchItem: (items, text) =>
              items.find(
                (item) => !item.isCreate && item.label.toLowerCase() === text.toLowerCase(),
              ),
            tokenFor: (id) => ({ type: 'tag_ref', attrs: { id } }),
            onCreate: extensionOptions.onCreate,
            loggerComponent: 'AtTagPicker',
            errorMessage: 'Failed to resolve tag via input rule, falling back to plain text',
          })
        },
      }),
    ]
  },

  addProseMirrorPlugins() {
    return [
      tagPicker(this, {
        pluginKey: atTagPickerPluginKey,
        char: '@',
        allowSpaces: true,
        // Only after a space or at the start of the block. Without this guard,
        // query expressions like `property:context=@office` would trip the
        // picker and intercept Enter (creating a "Create 'office}}'" tag instead
        // of saving the block). ProseMirror renders a trailing space as NBSP, so
        // `tagged: ` plus the toolbar's Insert-tag button reads
        // `tagged:\u00A0@`; `\n` covers a hard break.
        allowedPrefixes: [' ', '\u00A0', '\n'],
      }),
      tagPicker(this, {
        pluginKey: hashTagPickerPluginKey,
        char: '#',
        allowSpaces: false,
        // The tag rule below decides, whitespace of every kind included.
        allowedPrefixes: null,
        allow: ({ state, range }) =>
          !inCode(state, range.to) &&
          completedTag(`${getTextContentFromNodes(state.doc.resolve(range.to))} `)?.typed ===
            state.doc.textBetween(range.from, range.to),
      }),
    ]
  },
})
