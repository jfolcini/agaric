/**
 * Page mode's extensions (#5691): block mode's own content, chips and pickers
 * (`contentExtensions`, the same list the roving editor builds from), under
 * page mode's document, ids and keys. Block mode's extensions that write
 * through its block store are not offered, so what triggers them is plain text
 * here: the slash menu, the `::` and `{{` pickers, the list-style input rule,
 * and the `- ` and `1. ` list input rules it builds on (#5743). A task marker,
 * typed or pasted, stays text until the caret leaves its block, which then
 * takes the task state (`page-tasks.ts`). In page mode the document owns text
 * and structure.
 */

import type { Extensions } from '@tiptap/core'
import Placeholder from '@tiptap/extension-placeholder'

import { PageBlockFocus } from '@/editor/page-mode/page-block-focus'
import { PageBlockIds } from '@/editor/page-mode/page-block-ids'
import { PageBlock, PageDocument } from '@/editor/page-mode/page-document'
import { PageKeys } from '@/editor/page-mode/page-keys'
import { type PageTaskSource, pageTasks } from '@/editor/page-mode/page-tasks'
import { type ContentExtensionOptions, contentExtensions } from '@/editor/use-roving-editor'

export interface PageModeExtensionOptions extends Omit<ContentExtensionOptions, 'listInputRules'> {
  /** Shown in the empty block the cursor is in. */
  placeholder: string
  /** Mints a new block's id; a test passes a deterministic one. */
  mintId?: () => string
  /** The blocks' task states, drawn as block mode's checkbox; none draws no checkbox. */
  tasks?: PageTaskSource
}

export function pageModeExtensions(options: PageModeExtensionOptions): Extensions {
  const content = contentExtensions({ ...options, listInputRules: false })
  return [
    PageDocument,
    ...(options.tasks === undefined ? [PageBlock] : pageTasks(options.tasks)),
    ...content.text,
    ...content.lists,
    ...content.blocks,
    ...content.inline,
    ...content.chips,
    PageBlockIds.configure(options.mintId === undefined ? {} : { mintId: options.mintId }),
    PageKeys,
    PageBlockFocus,
    // Block mode's placeholder, on the empty paragraph the cursor is in.
    Placeholder.configure({
      placeholder: options.placeholder,
      includeChildren: true,
      emptyNodeClass: 'is-editor-empty',
    }),
  ]
}
