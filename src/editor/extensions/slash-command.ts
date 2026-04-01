/**
 * TipTap extension: / slash command picker.
 *
 * Intercepts the / keystroke and opens a suggestion popup
 * with available commands (TODO, DOING, DONE, Date).
 * On selection, delegates to the onCommand callback.
 *
 * Follows the same pattern as AtTagPicker and BlockLinkPicker.
 */

import type { Editor } from '@tiptap/core'
import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { Suggestion } from '@tiptap/suggestion'
import type { PickerItem } from '../SuggestionList'
import { createSuggestionRenderer } from '../suggestion-renderer'

const slashCommandPluginKey = new PluginKey('slashCommand')

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
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: slashCommandPluginKey,
        char: '/',
        allowedPrefixes: null,
        items: ({ query }) => extensionOptions.items(query),
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).run()
          extensionOptions.onCommand(props as PickerItem, editor)
        },
        render: () => createSuggestionRenderer('Slash commands'),
      }),
    ]
  },
})
