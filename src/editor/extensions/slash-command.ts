/**
 * TipTap extension: / slash command picker.
 *
 * Intercepts the / keystroke at a block start or after whitespace and
 * opens a suggestion popup with available commands (TODO, DOING, DONE,
 * Date). A `/` mid-word (URLs, `6/15`, "and/or") does not trigger it
 * (#1344 — `allowedPrefixes`, matching AtTagPicker).
 * On selection, delegates to the onCommand callback.
 *
 * Selection is always explicit: the command runs only on Enter or click
 * (handled by the Suggestion plugin / SuggestionList). There is no
 * silent auto-execute — matching Notion/Logseq behaviour.
 *
 * Follows the same pattern as AtTagPicker and BlockLinkPicker.
 */

import { type Editor, Extension } from '@tiptap/core'
import { PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state'

import { createPickerPlugin } from '@/editor/extensions/picker-plugin'
import { createSuggestionRenderer } from '@/editor/suggestion-renderer'
import type { PickerItem } from '@/editor/SuggestionList'
import { t } from '@/lib/i18n'

export const slashCommandPluginKey = new PluginKey('slashCommand')

/**
 * Open the slash picker on `query` without the user typing it (the
 * `turnIntoBlock` chord, #5733). The picker opens only for a `/` at a
 * textblock start or after whitespace (see `allowedPrefixes`), so the trigger
 * goes at the start of the caret's textblock, not at the caret, followed by a
 * space: glued to the block's first word, a caret moved into that word would
 * stretch the picker's range over it. When the picker closes, whatever is left
 * of the inserted text is deleted (after a pick, only the space) and the caret
 * goes back, so the block text is left as it was.
 */
export function openSlashPicker(editor: Editor, query: string): void {
  const trigger = `/${query} `
  const { from: caretBefore, $from } = editor.state.selection
  let from = $from.start()
  let to = from + trigger.length
  let caret = caretBefore + trigger.length
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.insertText(trigger, from)
      tr.setSelection(TextSelection.create(tr.doc, to - 1))
      return true
    })
    .setMeta('addToHistory', false)
    .run()

  const onTransaction = ({ transaction }: { transaction: Transaction }) => {
    const { mapping } = transaction
    from = mapping.map(from)
    to = mapping.map(to)
    caret = mapping.map(caret)
    if (slashCommandPluginKey.getState(editor.state)?.active) return
    editor.off('transaction', onTransaction)
    const tr = editor.state.tr.delete(from, to)
    tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(caret)))
    editor.view.dispatch(tr.setMeta('addToHistory', false))
  }
  editor.on('transaction', onTransaction)
}

export interface SlashCommandOptions {
  /** Return slash commands matching the query. Called on every keystroke after /. */
  items: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /**
   * Execute the selected command. The active editor is NOT passed here:
   * production handlers obtain it independently (via `rovingEditor` in the
   * slash-command context), so an `editor` parameter would be dead (#1668).
   */
  onCommand: (item: PickerItem) => void
}

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  addOptions() {
    return {
      items: () => [],
      onCommand: () => {},
    }
  },

  addProseMirrorPlugins() {
    const extensionOptions = this.options
    const editor = this.editor
    return [
      createPickerPlugin({
        loggerComponent: 'SlashCommand',
        displayName: t('editor.suggestion.slashCommands'),
        pluginKey: slashCommandPluginKey,
        char: '/',
        // #1344 — only open the slash menu when `/` is at the start of the
        // block or preceded by whitespace, matching AtTagPicker. Without
        // this guard the picker fired mid-word on any `/` (URLs, `6/15`,
        // "and/or"). ProseMirror normalises a trailing space inside a
        // paragraph to NBSP (`\u00A0`), so we accept it alongside the
        // regular space; `\n` covers a preceding hard break.
        allowedPrefixes: [' ', '\u00A0', '\n'],
        editor,
        items: (query) => extensionOptions.items(query),
        command: ({ editor: cmdEditor, range, props }) => {
          cmdEditor.chain().focus().deleteRange(range).run()
          extensionOptions.onCommand(props as PickerItem)
        },
        render: () => createSuggestionRenderer('Slash commands', slashCommandPluginKey, '/'),
      }),
    ]
  },
})
