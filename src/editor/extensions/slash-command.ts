/**
 * TipTap extension: / slash command picker.
 *
 * Intercepts the / keystroke and opens a suggestion popup
 * with available commands (TODO, DOING, DONE, Date).
 * On selection, delegates to the onCommand callback.
 *
 * Selection is always explicit: the command runs only on Enter or click
 * (handled by the Suggestion plugin / SuggestionList). There is no
 * silent auto-execute — matching Notion/Logseq behaviour.
 *
 * Follows the same pattern as AtTagPicker and BlockLinkPicker.
 */

import type { Editor } from '@tiptap/core'
import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'

import { createSuggestionRenderer } from '../suggestion-renderer'
import type { PickerItem } from '../SuggestionList'
import { createPickerPlugin } from './picker-plugin'

export const slashCommandPluginKey = new PluginKey('slashCommand')

export interface SlashCommandOptions {
  /** Return slash commands matching the query. Called on every keystroke after /. */
  items: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Execute the selected command. */
  onCommand: (item: PickerItem, editor: Editor) => void
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
        displayName: 'Slash commands',
        pluginKey: slashCommandPluginKey,
        char: '/',
        allowedPrefixes: null,
        editor,
        items: (query) => extensionOptions.items(query),
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).run()
          extensionOptions.onCommand(props as PickerItem, editor)
        },
        render: () => createSuggestionRenderer('Slash commands', slashCommandPluginKey, '/'),
      }),
    ]
  },
})
