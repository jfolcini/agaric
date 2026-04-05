import type { MutableRefObject } from 'react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { StoreApi } from 'zustand'
import { guessMimeType } from '../components/BlockTree'
import { serialize } from '../editor/markdown-serializer'
import type { PickerItem } from '../editor/SuggestionList'
import type { DocNode } from '../editor/types'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { formatRepeatLabel } from '../lib/repeat-utils'
import {
  addAttachment,
  deleteProperty,
  editBlock,
  listPropertyKeys,
  setPriority as setPriorityCmd,
  setProperty,
  setTodoState as setTodoStateCmd,
} from '../lib/tauri'
import { insertTemplateBlocks, loadTemplatePagesWithPreview } from '../lib/template-utils'
import type { PageBlockState } from '../stores/page-blocks'
import { useResolveStore } from '../stores/resolve'
import { useUndoStore } from '../stores/undo'

type DatePickerMode = 'date' | 'due' | 'schedule' | 'repeat-until'

export const SLASH_COMMANDS: PickerItem[] = [
  { id: 'todo', label: 'TODO — Mark as to-do' },
  { id: 'doing', label: 'DOING — Mark as in progress' },
  { id: 'done', label: 'DONE — Mark as complete' },
  { id: 'date', label: 'DATE — Link to a date page' },
  { id: 'due', label: 'DUE — Set due date on block' },
  { id: 'schedule', label: 'SCHEDULED — Set scheduled date on block' },
  { id: 'link', label: 'LINK — Insert page link' },
  { id: 'tag', label: 'TAG — Insert tag reference' },
  { id: 'code', label: 'CODE — Insert code block' },
  { id: 'effort', label: 'EFFORT — Set effort estimate (15m/30m/1h/2h/4h/1d)' },
  { id: 'assignee', label: 'ASSIGNEE — Set assignee' },
  { id: 'location', label: 'LOCATION — Set location' },
  { id: 'repeat', label: 'REPEAT — Set recurrence (daily/weekly/monthly/+Nd)' },
  { id: 'template', label: 'TEMPLATE — Insert block template' },
  { id: 'quote', label: 'QUOTE — Insert blockquote' },
  { id: 'table', label: 'TABLE — Insert table (e.g. /table 4x6)' },
  { id: 'query', label: 'QUERY — Insert embedded query block' },
  { id: 'attach', label: 'ATTACH — Attach file to block' },
]

export const PRIORITY_COMMANDS: PickerItem[] = [
  { id: 'priority-high', label: 'PRIORITY 1 — Set high priority' },
  { id: 'priority-medium', label: 'PRIORITY 2 — Set medium priority' },
  { id: 'priority-low', label: 'PRIORITY 3 — Set low priority' },
]

export const HEADING_COMMANDS: PickerItem[] = [
  { id: 'h1', label: 'Heading 1 — Large heading' },
  { id: 'h2', label: 'Heading 2 — Medium heading' },
  { id: 'h3', label: 'Heading 3 — Small heading' },
  { id: 'h4', label: 'Heading 4' },
  { id: 'h5', label: 'Heading 5' },
  { id: 'h6', label: 'Heading 6' },
]

export const REPEAT_COMMANDS: PickerItem[] = [
  { id: 'repeat-daily', label: 'REPEAT DAILY — Every day' },
  { id: 'repeat-weekly', label: 'REPEAT WEEKLY — Every week' },
  { id: 'repeat-monthly', label: 'REPEAT MONTHLY — Every month' },
  { id: 'repeat-yearly', label: 'REPEAT YEARLY — Every year' },
  { id: 'repeat-.+daily', label: 'REPEAT DAILY (from completion) — Days from when done' },
  { id: 'repeat-.+weekly', label: 'REPEAT WEEKLY (from completion) — Weeks from when done' },
  { id: 'repeat-.+monthly', label: 'REPEAT MONTHLY (from completion) — Months from when done' },
  { id: 'repeat-++daily', label: 'REPEAT DAILY (catch-up) — Advance to next future date' },
  { id: 'repeat-++weekly', label: 'REPEAT WEEKLY (catch-up) — Advance to next future date' },
  { id: 'repeat-++monthly', label: 'REPEAT MONTHLY (catch-up) — Advance to next future date' },
  { id: 'repeat-remove', label: 'REPEAT REMOVE — Clear recurrence' },
]

export const EFFORT_COMMANDS: PickerItem[] = [
  { id: 'effort-15m', label: 'EFFORT 15m — 15 minutes' },
  { id: 'effort-30m', label: 'EFFORT 30m — 30 minutes' },
  { id: 'effort-1h', label: 'EFFORT 1h — 1 hour' },
  { id: 'effort-2h', label: 'EFFORT 2h — 2 hours' },
  { id: 'effort-4h', label: 'EFFORT 4h — 4 hours' },
  { id: 'effort-1d', label: 'EFFORT 1d — 1 day' },
]

export const ASSIGNEE_COMMANDS: PickerItem[] = [
  { id: 'assignee-me', label: 'ASSIGNEE Me — Assign to me' },
  { id: 'assignee-custom', label: 'ASSIGNEE Custom... — Enter custom assignee' },
]

export const LOCATION_COMMANDS: PickerItem[] = [
  { id: 'location-office', label: 'LOCATION Office — Office' },
  { id: 'location-home', label: 'LOCATION Home — Home' },
  { id: 'location-remote', label: 'LOCATION Remote — Remote' },
  { id: 'location-custom', label: 'LOCATION Custom... — Enter custom location' },
]

export const REPEAT_END_COMMANDS: PickerItem[] = [
  { id: 'repeat-until', label: 'REPEAT UNTIL — Stop repeating after a date' },
  { id: 'repeat-limit-5', label: 'REPEAT LIMIT 5 — Stop after 5 occurrences' },
  { id: 'repeat-limit-10', label: 'REPEAT LIMIT 10 — Stop after 10 occurrences' },
  { id: 'repeat-limit-20', label: 'REPEAT LIMIT 20 — Stop after 20 occurrences' },
  { id: 'repeat-limit-remove', label: 'REPEAT LIMIT REMOVE — Clear end condition' },
]

export function searchSlashCommands(query: string): PickerItem[] {
  const q = query.toLowerCase()
  const baseResults = SLASH_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
  if (!q) return baseResults
  const priorityResults = PRIORITY_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
  const headingResults = HEADING_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
  const repeatResults = REPEAT_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
  const repeatEndResults = REPEAT_END_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
  const effortResults = EFFORT_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
  const assigneeResults = ASSIGNEE_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
  const locationResults = LOCATION_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))

  const tableMatch = q.match(/^table\s+(\d+)\s*x\s*(\d+)$/i)
  let results = [
    ...baseResults,
    ...priorityResults,
    ...headingResults,
    ...repeatResults,
    ...repeatEndResults,
    ...effortResults,
    ...assigneeResults,
    ...locationResults,
  ]
  if (tableMatch) {
    const rows = Number.parseInt(tableMatch[1] as string, 10)
    const cols = Number.parseInt(tableMatch[2] as string, 10)
    results = results.filter((r) => r.id !== 'table')
    results.unshift({
      id: `table:${rows}:${cols}`,
      label: `TABLE ${rows}\u00d7${cols} — Insert ${rows}\u00d7${cols} table`,
    })
  }
  return results
}

export async function searchPropertyKeys(query: string): Promise<PickerItem[]> {
  try {
    const keys = await listPropertyKeys()
    const q = query.toLowerCase()
    const filtered = q ? keys.filter((k) => k.toLowerCase().includes(q)) : keys
    return filtered.map((k) => ({ id: k, label: k }))
  } catch {
    return []
  }
}

export interface UseBlockSlashCommandsParams {
  focusedBlockId: string | null
  rootParentId: string | null
  pageStore: StoreApi<PageBlockState>
  rovingEditor: Pick<RovingEditorHandle, 'editor' | 'mount'>
  datePickerCursorPos: MutableRefObject<number | undefined>
  setDatePickerMode: (mode: DatePickerMode) => void
  setDatePickerOpen: (open: boolean) => void
  blocks: Array<{ id: string; parent_id: string | null; content: string | null }>
  load: () => Promise<void>
  // biome-ignore lint/suspicious/noExplicitAny: TFunction overload set is too complex
  t: (...args: any[]) => any
}

export interface UseBlockSlashCommandsReturn {
  handleSlashCommand: (item: PickerItem) => Promise<void>
  handleTemplateSelect: (templatePageId: string) => Promise<void>
  handleCheckboxSyntax: (state: 'TODO' | 'DONE') => void
  templatePickerOpen: boolean
  templatePages: Array<{ id: string; content: string; preview: string | null }>
  setTemplatePickerOpen: (open: boolean) => void
}

export function useBlockSlashCommands({
  focusedBlockId,
  rootParentId,
  pageStore,
  rovingEditor,
  datePickerCursorPos,
  setDatePickerMode,
  setDatePickerOpen,
  blocks,
  load,
  t,
}: UseBlockSlashCommandsParams): UseBlockSlashCommandsReturn {
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [templatePages, setTemplatePages] = useState<
    Array<{ id: string; content: string; preview: string | null }>
  >([])

  // biome-ignore lint/correctness/useExhaustiveDependencies: cursor position read at call time
  const handleSlashCommand = useCallback(
    async (item: PickerItem) => {
      if (!focusedBlockId) return

      if (item.id === 'todo' || item.id === 'doing' || item.id === 'done') {
        const state = item.id.toUpperCase()
        try {
          await setTodoStateCmd(focusedBlockId, state)
          if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
          pageStore.setState((s) => ({
            blocks: s.blocks.map((b) =>
              b.id === focusedBlockId ? { ...b, todo_state: state } : b,
            ),
          }))
        } catch {
          toast.error(t('blockTree.setTaskStateFailed'))
        }
      }

      if (item.id === 'date') {
        datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos
        setDatePickerMode('date')
        setDatePickerOpen(true)
      }

      if (item.id === 'due') {
        datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos
        setDatePickerMode('due')
        setDatePickerOpen(true)
      }

      if (item.id === 'schedule') {
        datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos
        setDatePickerMode('schedule')
        setDatePickerOpen(true)
        return
      }

      if (item.id === 'link') {
        rovingEditor.editor?.chain().focus().insertContent('[[').run()
        return
      }

      if (item.id === 'tag') {
        rovingEditor.editor?.chain().focus().insertContent('@').run()
        return
      }

      if (item.id === 'code') {
        rovingEditor.editor?.chain().focus().toggleCodeBlock().run()
        return
      }

      if (item.id === 'quote') {
        rovingEditor.editor?.chain().focus().toggleBlockquote().run()
        return
      }

      if (item.id === 'table' || item.id.startsWith('table:')) {
        let rows = 3
        let cols = 3
        const dimMatch = item.id.match(/^table:(\d+):(\d+)$/)
        if (dimMatch) {
          rows = Number.parseInt(dimMatch[1] as string, 10)
          cols = Number.parseInt(dimMatch[2] as string, 10)
        }
        rovingEditor.editor?.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run()
        return
      }

      if (item.id === 'query') {
        rovingEditor.editor?.chain().focus().insertContent('{{query type:tag expr:}}').run()
        return
      }

      if (
        item.id === 'priority-high' ||
        item.id === 'priority-medium' ||
        item.id === 'priority-low'
      ) {
        const priority =
          item.id === 'priority-high' ? '1' : item.id === 'priority-medium' ? '2' : '3'
        try {
          await setPriorityCmd(focusedBlockId, priority)
          if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
          pageStore.setState((s) => ({
            blocks: s.blocks.map((b) => (b.id === focusedBlockId ? { ...b, priority } : b)),
          }))
        } catch {
          toast.error(t('blockTree.setPriorityFailed'))
        }
      }

      const headingMatch = item.id.match(/^h([1-6])$/)
      if (headingMatch) {
        const level = Number(headingMatch[1])
        let currentContent = ''
        if (rovingEditor.editor) {
          const json = rovingEditor.editor.getJSON() as DocNode
          currentContent = serialize(json)
        } else {
          const block = pageStore.getState().blocks.find((b) => b.id === focusedBlockId)
          currentContent = block?.content ?? ''
        }
        const headingRegex = /^#{1,6}\s/
        const stripped = currentContent.replace(headingRegex, '')
        const newContent = `${'#'.repeat(level)} ${stripped}`
        try {
          await editBlock(focusedBlockId, newContent)
          pageStore.setState((state) => ({
            blocks: state.blocks.map((b) =>
              b.id === focusedBlockId ? { ...b, content: newContent } : b,
            ),
          }))
          rovingEditor.mount(focusedBlockId, newContent)
        } catch {
          toast.error(t('blockTree.setHeadingFailed'))
        }
      }

      if (item.id === 'assignee' || item.id === 'location') {
        if (!focusedBlockId) return
        try {
          await setProperty({
            blockId: focusedBlockId,
            key: item.id,
            valueText: '',
          })
          if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
          toast.success(
            t('blockTree.addedPropertyMessage', {
              name: item.label.split(' — ')[0]?.toLowerCase(),
            }),
          )
        } catch {
          toast.error(t('blockTree.addPropertyFailed'))
        }
        return
      }

      if (item.id.startsWith('assignee-')) {
        if (!focusedBlockId) return
        const preset = item.id.replace('assignee-', '')
        if (preset === 'custom') {
          try {
            await setProperty({
              blockId: focusedBlockId,
              key: 'assignee',
              valueText: '',
            })
            if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
            toast.success(t('blockTree.addedAssigneeProperty'))
          } catch {
            toast.error(t('blockTree.addPropertyFailed'))
          }
        } else {
          const value = item.label.split(' — ')[0]?.replace('ASSIGNEE ', '')
          try {
            await setProperty({
              blockId: focusedBlockId,
              key: 'assignee',
              ...(value != null && { valueText: value }),
            })
            if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
            toast.success(t('blockTree.setAssigneeMessage', { value }))
          } catch {
            toast.error(t('blockTree.setAssigneeFailed'))
          }
        }
        return
      }

      if (item.id.startsWith('location-')) {
        if (!focusedBlockId) return
        const preset = item.id.replace('location-', '')
        if (preset === 'custom') {
          try {
            await setProperty({
              blockId: focusedBlockId,
              key: 'location',
              valueText: '',
            })
            if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
            toast.success(t('blockTree.addedLocationProperty'))
          } catch {
            toast.error(t('blockTree.addPropertyFailed'))
          }
        } else {
          const value = item.label.split(' — ')[0]?.replace('LOCATION ', '')
          try {
            await setProperty({
              blockId: focusedBlockId,
              key: 'location',
              valueText: value,
            })
            if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
            toast.success(t('blockTree.setLocationMessage', { value }))
          } catch {
            toast.error(t('blockTree.setLocationFailed'))
          }
        }
        return
      }

      if (item.id.startsWith('effort-')) {
        if (!focusedBlockId) return
        const value = item.id.replace('effort-', '')
        try {
          await setProperty({
            blockId: focusedBlockId,
            key: 'effort',
            valueText: value,
          })
          if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
          toast.success(t('slash.effortSet', { value }))
        } catch {
          toast.error(t('slash.effortFailed'))
        }
        return
      }

      if (item.id === 'repeat-until') {
        if (!focusedBlockId) return
        datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos
        setDatePickerMode('repeat-until')
        setDatePickerOpen(true)
        return
      }

      if (item.id.startsWith('repeat-limit-')) {
        if (!focusedBlockId) return
        const sub = item.id.replace('repeat-limit-', '')
        if (sub === 'remove') {
          try {
            await deleteProperty(focusedBlockId, 'repeat-count')
            await deleteProperty(focusedBlockId, 'repeat-until')
            toast.success(t('blockTree.repeatEndConditionRemoved'))
          } catch {
            toast.error(t('blockTree.removeEndConditionFailed'))
          }
          return
        }
        const count = Number.parseInt(sub, 10)
        if (!Number.isNaN(count)) {
          try {
            await setProperty({
              blockId: focusedBlockId,
              key: 'repeat-count',
              valueNum: count,
            })
            if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
            toast.success(t('blockTree.repeatLimitedMessage', { count }))
          } catch {
            toast.error(t('blockTree.setRepeatLimitFailed'))
          }
        }
        return
      }

      if (item.id.startsWith('repeat-')) {
        if (!focusedBlockId) return
        const value = item.id.replace('repeat-', '')
        if (value === 'remove') {
          try {
            await deleteProperty(focusedBlockId, 'repeat')
            toast.success(t('slash.repeatRemoved'))
          } catch {
            toast.error(t('slash.repeatRemoveFailed'))
          }
          return
        }
        try {
          await setProperty({
            blockId: focusedBlockId,
            key: 'repeat',
            valueText: value,
          })
          if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
          toast.success(t('slash.repeatSet', { value: formatRepeatLabel(value) }))
        } catch {
          toast.error(t('slash.repeatFailed'))
        }
        return
      }

      if (item.id === 'template') {
        try {
          const pages = await loadTemplatePagesWithPreview()
          if (pages.length === 0) {
            toast.error(t('slash.noTemplates'))
            return
          }
          setTemplatePages(pages)
          setTemplatePickerOpen(true)
        } catch {
          toast.error(t('slash.templateLoadFailed'))
        }
        return
      }

      if (item.id === 'attach') {
        const input = document.createElement('input')
        input.type = 'file'
        input.onchange = async () => {
          const file = input.files?.[0]
          if (!file) return
          const filename = file.name
          const sizeBytes = file.size
          const mimeType = file.type || guessMimeType(filename)
          const fsPath = (file as File & { path?: string }).path
          if (!fsPath) {
            toast.error(t('blockTree.filePathReadFailed'))
            return
          }
          try {
            await addAttachment({
              blockId: focusedBlockId,
              filename,
              mimeType,
              sizeBytes,
              fsPath,
            })
            toast.success(t('blockTree.attachedFileMessage', { filename }))
          } catch {
            toast.error(t('blockTree.attachFileFailed'))
          }
        }
        input.click()
        return
      }
    },
    [focusedBlockId],
  )

  const handleTemplateSelect = useCallback(
    async (templatePageId: string) => {
      setTemplatePickerOpen(false)
      if (!focusedBlockId) return
      const block = blocks.find((b) => b.id === focusedBlockId)
      if (!block) return
      try {
        const parentId = block.parent_id ?? rootParentId
        if (!parentId) return
        const pageTitle = useResolveStore.getState().cache.get(rootParentId ?? '')?.title ?? ''
        const ids = await insertTemplateBlocks(templatePageId, parentId, {
          pageTitle,
        })
        if (ids.length > 0) {
          await load()
          toast.success(t('slash.templateInserted'))
        }
      } catch {
        toast.error(t('slash.templateInsertFailed'))
      }
    },
    [focusedBlockId, blocks, rootParentId, load, t],
  )

  const handleCheckboxSyntax = useCallback(
    (state: 'TODO' | 'DONE') => {
      if (!focusedBlockId) return
      setTodoStateCmd(focusedBlockId, state)
        .then(() => {
          if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
        })
        .catch(() => toast.error(t('blockTree.setTaskStateFailed')))
      pageStore.setState((s) => ({
        blocks: s.blocks.map((b) => (b.id === focusedBlockId ? { ...b, todo_state: state } : b)),
      }))
    },
    [focusedBlockId, rootParentId, t, pageStore],
  )

  return {
    handleSlashCommand,
    handleTemplateSelect,
    handleCheckboxSyntax,
    templatePickerOpen,
    templatePages,
    setTemplatePickerOpen,
  }
}
