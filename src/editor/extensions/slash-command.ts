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
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import { Suggestion } from '@tiptap/suggestion'
import { logger } from '../../lib/logger'
import type { PickerItem } from '../SuggestionList'
import { createSuggestionRenderer } from '../suggestion-renderer'

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
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: slashCommandPluginKey,
        char: '/',
        allowedPrefixes: null,
        items: async ({ query }) => {
          try {
            return await extensionOptions.items(query)
          } catch (err) {
            logger.warn('SlashCommand', 'items callback failed, returning empty', { query }, err)
            return []
          }
        },
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).run()
          extensionOptions.onCommand(props as PickerItem, editor)
        },
        render: () => {
          const base = createSuggestionRenderer('Slash commands', slashCommandPluginKey)
          let autoExecTimer: ReturnType<typeof setTimeout> | null = null

          return {
            onStart: base.onStart,
            onUpdate(props: SuggestionProps<PickerItem>) {
              base.onUpdate(props)
              if (autoExecTimer) clearTimeout(autoExecTimer)
              const { items, query, command } = props
              // Auto-execute when exactly 1 match and query is long enough
              if (items.length === 1 && query.length >= 3) {
                autoExecTimer = setTimeout(() => {
                  command(items[0] as PickerItem)
                }, 200)
              }
            },
            onKeyDown(props: SuggestionKeyDownProps) {
              // Cancel auto-execute on any keypress (user is still interacting)
              if (autoExecTimer) clearTimeout(autoExecTimer)
              return base.onKeyDown(props)
            },
            onExit() {
              if (autoExecTimer) clearTimeout(autoExecTimer)
              base.onExit()
            },
          }
        },
      }),
    ]
  },
})
