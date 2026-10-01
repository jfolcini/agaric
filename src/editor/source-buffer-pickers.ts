/**
 * The *Edit as Markdown* buffer's `[[`, `#` and `((` pickers (#5160 phase 5):
 * the block editor's pickers, opening where they open and searching as they
 * search, but a choice is written as the markdown that reads back as it,
 * `[[Title]]`, `#name` or `#[[name]]`, and `((ULID))`, so the save resolves it
 * as it resolves the same text typed. Create inserts the text as typed: the
 * save creates the page or tag, as for any name nothing matches.
 */

import { type Editor, Extension, getTextContentFromNodes } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { type EditorState, PluginKey } from '@tiptap/pm/state'

import { completedTag } from '@/editor/extensions/at-tag-picker'
import { parseTypedLink, pickedLinkLabel } from '@/editor/extensions/block-link-picker'
import { createPickerPlugin } from '@/editor/extensions/picker-plugin'
import { closesFence, FENCE_OPENER } from '@/editor/source-buffer-blocks'
import type { PickerItem } from '@/editor/SuggestionList'
import { t } from '@/lib/i18n'
import { scanNameTokens } from '@/lib/name-tokens'

type Search = (query: string) => PickerItem[] | Promise<PickerItem[]>

export interface SourceBufferPickersOptions {
  searchPages: Search
  searchTags: Search
  searchBlockRefs: Search
}

const pagePickerKey = new PluginKey('sourcePagePicker')
const tagPickerKey = new PluginKey('sourceTagPicker')
const blockRefPickerKey = new PluginKey('sourceBlockRefPicker')

/** Whether a picker is open in `state`: its Enter, Tab and Escape are its own. */
export function pickerOpen(state: EditorState): boolean {
  return [pagePickerKey, tagPickerKey, blockRefPickerKey].some(
    (key) => (key.getState(state) as { active?: boolean } | undefined)?.active === true,
  )
}

/**
 * `#name`, or `#[[name]]` when the bare form would not read back as that tag
 * between `before` and `after`: the export's rule (`tag_reads_back_bare`,
 * #5160 N8), so `#deep work`, `#C++` and `#works` are bracketed.
 */
export function tagText(name: string, before: string, after: string): string {
  // The characters either side, a whole code point each, as the Rust probe takes them.
  const left = /[^]$/u.exec(before)?.[0] ?? ''
  const probe = `${left}#${name}${/^[^]/u.exec(after)?.[0] ?? ''}`
  const bare = scanNameTokens(probe).some(
    (token) =>
      token.kind === 'tag' &&
      token.name === name &&
      token.start === left.length &&
      token.end === left.length + 1 + name.length,
  )
  return bare ? `#${name}` : `#[[${name}]]`
}

/**
 * The `[[…]]` a picked page is written as: its full title (an alias item's
 * alias, which the save reads back as its page), with the label typed after a
 * `|` (D9); a create item's typed text as it is.
 */
export function pageLinkText(item: PickerItem, typed: string): string {
  if (item.isCreate) return `[[${typed.trim()}]]`
  const name = item.isAlias ? (item.aliasText ?? item.label) : (item.title ?? item.label)
  const label = pickedLinkLabel(item, typed)
  return label === undefined ? `[[${name}]]` : `[[${name}|${label}]]`
}

/**
 * Whether line `index` of `doc` is in a fenced code block: one a line above
 * it opened and no line closed since. A fence left open ends before the next
 * line carrying an id, as the save reads it (D5).
 */
function inFencedCode(doc: PMNode, index: number): boolean {
  let fence: string | null = null
  for (let i = 0; i <= index; i += 1) {
    const line = doc.child(i)
    if (line.attrs['blockId'] != null) fence = null
    if (i === index) break
    const text = line.textContent
    if (fence === null) fence = FENCE_OPENER.exec(text)?.[1] ?? null
    else if (closesFence(text, fence)) fence = null
  }
  return fence !== null
}

/** Replace the picker's `range` with `text`, closing the picker in the same step: the text written would match it again. */
function insertText(
  editor: Editor,
  key: PluginKey,
  range: { from: number; to: number },
  text: string,
) {
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.insertText(text, range.from, range.to).setMeta(key, { exit: true })
      return true
    })
    .run()
}

/** Whether what the picker matched over `range` is still open: a link typed through its `closer` is done. */
function stillOpen(
  state: EditorState,
  range: { from: number; to: number },
  closer: string,
): boolean {
  return !state.doc.textBetween(range.from, range.to).includes(closer)
}

export const SourceBufferPickers = Extension.create<SourceBufferPickersOptions>({
  name: 'sourceBufferPickers',
  // Ahead of the buffer's own keys: an open picker takes Enter, Tab and Escape.
  priority: 1100,

  addOptions() {
    return { searchPages: () => [], searchTags: () => [], searchBlockRefs: () => [] }
  },

  addProseMirrorPlugins() {
    const { options, editor } = this
    return [
      createPickerPlugin({
        loggerComponent: 'SourceBufferPickers',
        displayName: t('editor.suggestion.blockLinks'),
        pluginKey: pagePickerKey,
        char: '[[',
        allowedPrefixes: null,
        allowSpaces: true,
        // `#[[` starts a tag, not a page link (#5160 N7).
        allow: ({ state, range }) =>
          state.doc.textBetween(range.from - 1, range.from) !== '#' &&
          stillOpen(state, range, ']]'),
        editor,
        items: (query) => options.searchPages(parseTypedLink(query)?.base ?? query),
        command: ({ editor: ed, range, props }) => {
          const typed = ed.state.doc.textBetween(range.from + 2, range.to)
          insertText(ed, pagePickerKey, range, pageLinkText(props as PickerItem, typed))
        },
      }),
      createPickerPlugin({
        loggerComponent: 'SourceBufferPickers',
        displayName: t('editor.suggestion.tags'),
        pluginKey: tagPickerKey,
        char: '#',
        allowSpaces: false,
        allowedPrefixes: null,
        // Where typing a space would make `#query` a tag (the block editor's
        // rule), and not in a fenced code block.
        allow: ({ state, range }) =>
          !inFencedCode(state.doc, state.doc.resolve(range.from).index(0)) &&
          completedTag(`${getTextContentFromNodes(state.doc.resolve(range.to))} `)?.typed ===
            state.doc.textBetween(range.from, range.to),
        editor,
        items: (query) => options.searchTags(query),
        command: ({ editor: ed, range, props }) => {
          const $from = ed.state.doc.resolve(range.from)
          const line = $from.parent.textContent
          const after = line.slice(ed.state.doc.resolve(range.to).parentOffset)
          const name = (props as PickerItem).label
          insertText(
            ed,
            tagPickerKey,
            range,
            tagText(name, line.slice(0, $from.parentOffset), after),
          )
        },
      }),
      createPickerPlugin({
        loggerComponent: 'SourceBufferPickers',
        displayName: t('editor.suggestion.blockReferences'),
        pluginKey: blockRefPickerKey,
        char: '((',
        allowSpaces: true,
        allowedPrefixes: null,
        allow: ({ state, range }) => stillOpen(state, range, '))'),
        editor,
        items: (query) => options.searchBlockRefs(query),
        command: ({ editor: ed, range, props }) => {
          insertText(ed, blockRefPickerKey, range, `((${(props as PickerItem).id}))`)
        },
      }),
    ]
  },
})
