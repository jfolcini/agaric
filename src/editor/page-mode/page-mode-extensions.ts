/**
 * Page mode's extensions (#5691): block mode's own content, chips and pickers
 * (`contentExtensions`, the same list the roving editor builds from), under
 * page mode's document, ids and keys. Block mode's slash menu and `::` and
 * `{{` pickers come with `commands`, which runs a picked command on the
 * caret's block (#5743, `page-slash-commands.tsx`). A task marker,
 * typed or pasted, stays text until the caret leaves its block, which then
 * takes the task state (`page-tasks.ts`). The stock `- ` and `1. ` rules,
 * which make an in-block list, are off: page mode's own make the block a
 * bullet or numbered block, as block mode's list-style rule does
 * (`page-lists.ts`). In page mode the document owns text and structure.
 */

import type { Extensions } from '@tiptap/core'
import Placeholder from '@tiptap/extension-placeholder'

import { PropertyPicker } from '@/editor/extensions/property-picker'
import { QueryPicker } from '@/editor/extensions/query-picker'
import { SlashCommand } from '@/editor/extensions/slash-command'
import { PageBlockFocus } from '@/editor/page-mode/page-block-focus'
import { PageBlockIds } from '@/editor/page-mode/page-block-ids'
import { PageBlock, PageDocument } from '@/editor/page-mode/page-document'
import { PageKeys } from '@/editor/page-mode/page-keys'
import { type PageListSource, pageListKeys } from '@/editor/page-mode/page-lists'
import { PageRenderedKeys } from '@/editor/page-mode/page-rendered'
import { type PageTaskSource, pageTasks } from '@/editor/page-mode/page-tasks'
import type { PickerItem } from '@/editor/SuggestionList'
import {
  type ContentExtensionOptions,
  contentExtensions,
  embedTargets,
} from '@/editor/use-roving-editor'

/** Block mode's slash menu and `::` picker, and what runs a picked command. */
export interface PageCommandPickers {
  searchSlashCommands: (query: string) => PickerItem[]
  /** Run the `/` menu's pick, or the `{{` picker's query, as block mode's dispatch does. */
  onSlashCommand: (item: PickerItem) => void
  searchPropertyKeys: (query: string) => Promise<PickerItem[]>
}

export interface PageModeExtensionOptions extends Omit<ContentExtensionOptions, 'listInputRules'> {
  /** Shown in the empty block the cursor is in. */
  placeholder: string
  /** Mints a new block's id; a test passes a deterministic one. */
  mintId?: () => string
  /** The blocks' task states, drawn as block mode's checkbox; none, or no `lists`, draws none. */
  tasks?: PageTaskSource
  /** The blocks' list styles, drawn as block mode's marker, with its list keys; none draws none. */
  lists?: PageListSource
  /** The `/` menu and the `::` and `{{` pickers; none offers them. */
  commands?: PageCommandPickers
}

export function pageModeExtensions(options: PageModeExtensionOptions): Extensions {
  const content = contentExtensions({ ...options, listInputRules: false })
  return [
    PageDocument,
    ...(options.tasks === undefined || options.lists === undefined
      ? [PageBlock]
      : pageTasks(options.tasks, options.lists.lists)),
    ...content.text,
    ...content.lists,
    ...content.blocks,
    ...content.inline,
    ...content.chips,
    // Where block mode places them, behind the other pickers and ahead of
    // `PageRenderedKeys`, so an open menu keeps its arrows.
    ...(options.commands === undefined ? [] : commandPickers(options, options.commands)),
    PageBlockIds.configure(options.mintId === undefined ? {} : { mintId: options.mintId }),
    PageKeys,
    PageRenderedKeys,
    ...(options.lists === undefined ? [] : [pageListKeys(options.lists)]),
    PageBlockFocus,
    // Block mode's placeholder, on the empty paragraph the cursor is in.
    Placeholder.configure({
      placeholder: options.placeholder,
      includeChildren: true,
      emptyNodeClass: 'is-editor-empty',
    }),
  ]
}

function commandPickers(options: PageModeExtensionOptions, commands: PageCommandPickers) {
  return [
    SlashCommand.configure({
      items: commands.searchSlashCommands,
      onCommand: commands.onSlashCommand,
    }),
    // Its pick is the `key:: ` text, which becomes the property once the caret leaves the block.
    PropertyPicker.configure({ items: commands.searchPropertyKeys }),
    QueryPicker.configure({
      onCommand: commands.onSlashCommand,
      embedItems: (query: string) =>
        embedTargets(query, options.searchPages, options.searchBlockRefs),
    }),
  ]
}
