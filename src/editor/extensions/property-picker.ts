/**
 * TipTap extension: :: property picker (property name autocomplete).
 *
 * Intercepts the :: keystroke and opens a suggestion popup with
 * existing property names. On selection, inserts `key:: ` text
 * and calls the onSelect callback so the parent can create the
 * property (set_property op with empty value).
 *
 * Follows the same pattern as AtTagPicker, BlockLinkPicker, and SlashCommand.
 */

import type { Editor } from '@tiptap/core'
import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { Suggestion } from '@tiptap/suggestion'
import type { PickerItem } from '../SuggestionList'
import { createSuggestionRenderer } from '../suggestion-renderer'

const propertyPickerPluginKey = new PluginKey('propertyPicker')

export interface PropertyPickerOptions {
  /** Return property keys matching the query. Called on every keystroke after ::. */
  items: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Called when a property is selected from the picker. */
  onSelect?: (item: PickerItem, editor: Editor) => void
}

export const PropertyPicker = Extension.create<PropertyPickerOptions>({
  name: 'propertyPicker',

  addOptions() {
    return {
      items: () => [],
      onSelect: undefined,
    }
  },

  addProseMirrorPlugins() {
    const extensionOptions = this.options
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: propertyPickerPluginKey,
        char: '::',
        allowedPrefixes: null,
        items: ({ query }) => extensionOptions.items(query),
        command: ({ editor, range, props }) => {
          const item = props as PickerItem
          // Replace the :: trigger + query with `key:: `
          editor.chain().focus().deleteRange(range).insertContent(`${item.label}:: `).run()
          // Notify parent to create the property
          extensionOptions.onSelect?.(item, editor)
        },
        render: () => createSuggestionRenderer('Properties'),
      }),
    ]
  },
})
