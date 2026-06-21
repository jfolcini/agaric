/**
 * TipTap extension: `{{` embed-query picker.
 *
 * Typing `{{` opens a one-item suggestion popup ("Insert query…") that, on
 * selection, deletes the `{{` and opens the visual query builder for the
 * focused block (via the shared slash-command dispatch — the `query` command
 * id already maps to `openQueryBuilder`). This makes embedded `{{query …}}`
 * blocks discoverable the same way `[[`, `((` and `@` surface their pickers.
 *
 * Boundary with QueryHint (#907): the item is only offered while the query is
 * empty (immediately after `{{`). Once the user types anything, this picker
 * yields so manual `{{query …}}` syntax + the QueryHint ghost-text completion
 * take over. Selection is always explicit (Enter/click) — no auto-execute.
 *
 * Follows the same pattern as SlashCommand.
 */

import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'

import type { PickerItem } from '../SuggestionList'
import { createPickerPlugin } from './picker-plugin'

export const queryPickerPluginKey = new PluginKey('queryPicker')

/**
 * The single affordance item. Its `id` is `query` so the shared slash-command
 * dispatch routes it to `openQueryBuilder` (see useSlashCommandStructural).
 */
const QUERY_PICKER_ITEM: PickerItem = { id: 'query', label: 'Insert query…' }

export interface QueryPickerOptions {
  /**
   * Execute the embed-query affordance. Production wires this to the same
   * slash-command thunk used by `/query`, so it opens the visual builder for
   * the focused block. No `editor` param: handlers obtain it independently
   * (matching SlashCommand, #1668).
   */
  onCommand: (item: PickerItem) => void
}

export const QueryPicker = Extension.create<QueryPickerOptions>({
  name: 'queryPicker',

  addOptions() {
    return {
      onCommand: () => {},
    }
  },

  addProseMirrorPlugins() {
    const extensionOptions = this.options
    const editor = this.editor
    return [
      createPickerPlugin({
        loggerComponent: 'QueryPicker',
        displayName: 'Embed query',
        pluginKey: queryPickerPluginKey,
        char: '{{',
        // `{{` can open the affordance anywhere (queries usually sit on their
        // own block, but a mid-text `{{` is harmless). Spaces close it so the
        // empty-query gate below cleanly hands off to manual syntax.
        allowSpaces: false,
        allowedPrefixes: null,
        editor,
        // Only offer the affordance right after `{{`; once the user types,
        // defer to manual `{{query …}}` + QueryHint completion.
        items: (query) => (query === '' ? [QUERY_PICKER_ITEM] : []),
        command: ({ editor: cmdEditor, range }) => {
          cmdEditor.chain().focus().deleteRange(range).run()
          extensionOptions.onCommand(QUERY_PICKER_ITEM)
        },
      }),
    ]
  },
})
