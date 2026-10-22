/**
 * Page mode's slash menu (#5743): block mode's commands, run by block mode's
 * own handlers (`useSlashHandlers`, `runSlashCommand`) on the block the caret
 * is in. The `{{` picker's query item runs through here too, as in block mode.
 * Two things differ, because page mode's document is the whole page:
 *
 * - A command that rewrites the block's text (a heading, a callout, a
 *   divider, *Turn into*) rewrites it in the document (`blockText`), which
 *   saves it; block mode writes it with `edit_block`. A heading, code, a quote
 *   or a callout clears the block's list style as page mode's list keys do
 *   (`clearListStyle`): at once on screen, written once the block is saved.
 * - A command that writes to the block (its task state, priority, a property,
 *   a list style) or opens what writes to it (the date picker on a due, a
 *   scheduled or an until date, the property drawer, the query builder, the
 *   voice recorder) runs once a save has created the block, as the checkbox
 *   and the chips do; page mode then reads the page again, so the chips show
 *   what it wrote. A command runs as it is picked (`runsAtOnce`) when it
 *   changes nothing but the document (a mark toggled at the caret, which a
 *   save's change would clear, and what inserts at the caret), and `/attach`,
 *   whose file dialog WebKit opens only inside the key or click that picked
 *   it; the file chosen is attached once the block is saved, and, as block
 *   mode's `/attach`, an image is not put in the text.
 *
 * `/duplicate` and `/template` are not offered: they write blocks through the
 * block store, outside the document, which owns the page's structure here.
 */

import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'
import type { TFunction } from 'i18next'
import type React from 'react'
import { lazy, Suspense, useState } from 'react'
import type { StoreApi } from 'zustand'

import type { UseBlockDatePickerReturn } from '@/components/block-tree/use-block-date-picker'
import {
  runSlashCommand,
  searchSlashMenu,
  useSlashHandlers,
} from '@/components/block-tree/use-block-slash-commands'
import type {
  DatePickerMode,
  SlashCommandContext,
} from '@/components/block-tree/use-block-slash-commands/types'
import { BlockTreeDialogs } from '@/components/editor/BlockTreeDialogs'
import { insertEmojiIntoActiveEditor } from '@/editor/insert-emoji'
import { parse, serialize } from '@/editor/markdown-serializer'
import { blockDocJson } from '@/editor/page-mode/page-document'
import type { PickerItem } from '@/editor/SuggestionList'
import { blockIdOf } from '@/editor/token-ids'
import type { PageBlockState } from '@/stores/page-blocks'

const BlockTablePicker = lazy(() =>
  import('@/components/block-tree/BlockTablePicker').then((m) => ({
    default: m.BlockTablePicker,
  })),
)

const NOT_IN_PAGE_MODE = new Set(['duplicate', 'template'])

/** Block mode's menu for `query`, less what page mode does not offer. */
export function searchPageSlashCommands(query: string): PickerItem[] {
  return searchSlashMenu(query).filter((command) => !NOT_IN_PAGE_MODE.has(command.id))
}

const AT_ONCE = new Set([
  'attach',
  'bold',
  'italic',
  'code-mark',
  'strike',
  'highlight',
  'link',
  'block-ref',
  'tag',
  'embed',
  'emoji',
  'date',
  'code',
  'quote',
  'table',
  'divider',
  'turn',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
])

/** Whether command `id` runs as it is picked, not once a save has created its block. */
export function runsAtOnce(id: string): boolean {
  return AT_ONCE.has(id)
}

function blockAt(editor: Editor, id: string): { pos: number; node: PMNode } | null {
  const { doc } = editor.state
  for (let i = 0, pos = 0; i < doc.childCount; pos += doc.child(i).nodeSize, i += 1) {
    if (blockIdOf(doc.child(i)) === id) return { pos, node: doc.child(i) }
  }
  return null
}

/** Block `id`'s text in the document: read, and replaced with the caret at its end. */
export function blockText(
  editor: Editor,
  id: string,
): NonNullable<SlashCommandContext['blockText']> {
  return {
    read: () => {
      const at = blockAt(editor, id)
      return at === null ? '' : serialize(blockDocJson(at.node))
    },
    write: (markdown) => {
      const at = blockAt(editor, id)
      if (at === null) return
      const content = Fragment.fromJSON(editor.schema, parse(markdown).content)
      const tr = editor.state.tr.replaceWith(at.pos + 1, at.pos + at.node.nodeSize - 1, content)
      const end = at.pos + (tr.doc.nodeAt(at.pos)?.nodeSize ?? 2) - 1
      tr.setSelection(TextSelection.near(tr.doc.resolve(end), -1))
      editor.view.dispatch(tr.scrollIntoView())
    },
  }
}

export interface PageSlashCommandsOptions {
  pageId: string
  editor: Editor | null
  pageStore: StoreApi<PageBlockState>
  t: TFunction
  datePicker: Pick<
    UseBlockDatePickerReturn,
    'datePickerCursorPos' | 'openDatePickerFor' | 'setDatePickerOpen'
  >
  /** Open block mode's property drawer on a block. */
  openPropertyDrawer: (id: string) => void
  /** Write the query block mode's builder saved for a block; resolves whether it did. */
  saveQuery: (id: string, expression: string) => Promise<boolean>
  /** Attach files to a block once a save has created it, as block mode's `/attach` does. */
  attach: (id: string, files: File[]) => void
  /** Clear a block's list style: shown at once, written once a save has created it. */
  clearListStyle: (id: string) => void
}

export interface PageSlashCommands {
  /** Run command `item` on block `id`. */
  run: (id: string, item: PickerItem) => Promise<void>
  /** Block mode's dialogs, while a command has one open. */
  dialogs: React.ReactNode
}

const noBlock = (): void => {}

export function usePageSlashCommands({
  pageId,
  editor,
  pageStore,
  t,
  datePicker,
  openPropertyDrawer,
  saveQuery,
  attach,
  clearListStyle,
}: PageSlashCommandsOptions): PageSlashCommands {
  const handlers = useSlashHandlers()
  const [queryBlockId, setQueryBlockId] = useState<string | null>(null)
  const [voiceBlockId, setVoiceBlockId] = useState<string | null>(null)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [tableOpen, setTableOpen] = useState(false)

  const run = async (id: string, item: PickerItem): Promise<void> => {
    if (editor === null) return
    let mode: DatePickerMode = 'date'
    const ctx: SlashCommandContext = {
      blockId: id,
      rootParentId: pageId,
      // `mount` reloads block mode's editor after `edit_block`, which `blockText` replaces here.
      rovingEditor: { editor, mount: noBlock },
      pageStore,
      datePickerCursorPos: datePicker.datePickerCursorPos,
      // The picker opens on the command's block, as a chip opens it on the chip's.
      setDatePickerMode: (next) => {
        mode = next
      },
      setDatePickerOpen: (open) => {
        if (open) datePicker.openDatePickerFor(id, mode)
        else datePicker.setDatePickerOpen(false)
      },
      t,
      // Not offered in page mode (`NOT_IN_PAGE_MODE`).
      openTemplatePicker: () => Promise.resolve(),
      openQueryBuilder: () => setQueryBlockId(id),
      openEmojiPicker: () => setEmojiOpen(true),
      openTablePicker: () => setTableOpen(true),
      openPropertyDrawer,
      openVoiceNoteRecorder: setVoiceBlockId,
      blockText: blockText(editor, id),
      attachFiles: (files) => attach(id, files),
      clearListStyle: () => clearListStyle(id),
    }
    await runSlashCommand(handlers, ctx, item)
  }

  const dialogs = (
    <>
      {/* Page mode's property drawer is its own, and it has no history sheet. */}
      <BlockTreeDialogs
        queryBuilderOpen={queryBlockId !== null}
        setQueryBuilderOpen={(open) => {
          if (!open) setQueryBlockId(null)
        }}
        handleQuerySave={async (expression) => {
          if (queryBlockId !== null && (await saveQuery(queryBlockId, expression))) {
            setQueryBlockId(null)
          }
        }}
        emojiPickerOpen={emojiOpen}
        setEmojiPickerOpen={setEmojiOpen}
        handleEmojiSelect={insertEmojiIntoActiveEditor}
        voiceNoteBlockId={voiceBlockId}
        setVoiceNoteBlockId={setVoiceBlockId}
        historyBlockId={null}
        setHistoryBlockId={noBlock}
        propertyDrawerBlockId={null}
        setPropertyDrawerBlockId={noBlock}
      />
      {tableOpen && editor !== null && (
        <Suspense fallback={null}>
          <BlockTablePicker editor={editor} onClose={() => setTableOpen(false)} />
        </Suspense>
      )}
    </>
  )

  return { run, dialogs }
}
