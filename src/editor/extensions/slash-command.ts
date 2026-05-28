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

import { logger } from '../../lib/logger'
import { createSuggestionRenderer } from '../suggestion-renderer'
import type { PickerItem } from '../SuggestionList'
import { createPickerPlugin } from './picker-plugin'

export const slashCommandPluginKey = new PluginKey('slashCommand')

/** Auto-execute delay when exactly one suggestion matches a long-enough query. */
const AUTO_EXEC_DELAY_MS = 200

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
        render: () => {
          const base = createSuggestionRenderer('Slash commands', slashCommandPluginKey, '/')
          let autoExecTimer: ReturnType<typeof setTimeout> | null = null

          return {
            onStart(props: SuggestionProps<PickerItem>) {
              // Defensive: clear any lingering timer from a previous session
              // (e.g. onExit not invoked before a re-entry) to avoid firing a
              // command against a stale context.
              if (autoExecTimer) {
                logger.debug('slash-command', 'auto-execute timer cleared on onStart', {
                  reason: 'lingering-timer-from-previous-session',
                })
                clearTimeout(autoExecTimer)
                autoExecTimer = null
              }
              base.onStart(props)
            },
            onUpdate(props: SuggestionProps<PickerItem>) {
              base.onUpdate(props)
              if (autoExecTimer) {
                logger.debug('slash-command', 'auto-execute timer cleared on onUpdate', {
                  reason: 'rescheduling',
                  query: props.query,
                })
                clearTimeout(autoExecTimer)
                autoExecTimer = null
              }
              const { items, query, command } = props
              // Auto-execute when exactly 1 match and query is long enough.
              // Threshold bumped from 3 → 4 (UX-314): the 200ms auto-fire is
              // not visibly cued, so 3-char triggers surprised fast typists.
              // Trade-off: short slash commands (e.g. `/h1`) no longer
              // auto-fire; the user must press Enter to confirm.
              if (items.length === 1 && query.length >= 4) {
                logger.debug('slash-command', 'auto-execute timer scheduled', {
                  delayMs: AUTO_EXEC_DELAY_MS,
                  query,
                  itemId: items[0]?.id,
                })
                autoExecTimer = setTimeout(() => {
                  autoExecTimer = null
                  if (editor.view?.isDestroyed) {
                    logger.warn('slash-command', 'skipping auto-execute — editor view destroyed')
                    return
                  }
                  const item = items[0] as PickerItem
                  logger.debug('slash-command', 'auto-execute timer fired', {
                    query,
                    itemId: item.id,
                  })
                  try {
                    command(item)
                  } catch (err) {
                    logger.warn('slash-command', 'auto-execute threw', undefined, err)
                  }
                }, AUTO_EXEC_DELAY_MS)
              }
            },
            onKeyDown(props: SuggestionKeyDownProps) {
              // Cancel auto-execute on any keypress (user is still interacting)
              if (autoExecTimer) {
                logger.debug('slash-command', 'auto-execute timer cleared on onKeyDown', {
                  reason: 'user-keypress',
                  key: props.event.key,
                })
                clearTimeout(autoExecTimer)
                autoExecTimer = null
              }
              return base.onKeyDown(props)
            },
            onExit() {
              if (autoExecTimer) {
                logger.debug('slash-command', 'auto-execute timer cleared on onExit', {
                  reason: 'session-exit',
                })
                clearTimeout(autoExecTimer)
                autoExecTimer = null
              }
              base.onExit()
            },
          }
        },
      }),
    ]
  },
})
