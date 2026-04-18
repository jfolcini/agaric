import {
  AlertTriangle,
  Calendar,
  CalendarClock,
  CalendarDays,
  CalendarX,
  CheckCheck,
  CheckCircle2,
  CircleDot,
  Code,
  Grid3x3,
  Hash,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Info,
  LayoutTemplate,
  Lightbulb,
  Link2,
  ListOrdered,
  MapPin,
  Minus,
  Paperclip,
  Quote,
  Repeat,
  Search,
  Signal,
  StickyNote,
  Tag,
  Timer,
  UserCircle,
  XCircle,
} from 'lucide-react'
import { matchSorter } from 'match-sorter'
import type { MutableRefObject } from 'react'
import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { StoreApi } from 'zustand'
import { serialize } from '../editor/markdown-serializer'
import type { PickerItem } from '../editor/SuggestionList'
import type { DocNode } from '../editor/types'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { guessMimeType } from '../lib/file-utils'
import { logger } from '../lib/logger'
import { formatRepeatLabel } from '../lib/repeat-utils'
import {
  addAttachment,
  deleteProperty,
  editBlock,
  getProperties,
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
  {
    id: 'todo',
    label: 'TODO — Mark as to-do',
    category: 'slashCommand.categories.tasks',
    icon: CheckCircle2,
  },
  {
    id: 'doing',
    label: 'DOING — Mark as in progress',
    category: 'slashCommand.categories.tasks',
    icon: CircleDot,
  },
  {
    id: 'done',
    label: 'DONE — Mark as complete',
    category: 'slashCommand.categories.tasks',
    icon: CheckCheck,
  },
  {
    id: 'date',
    label: 'DATE — Link to a date page',
    category: 'slashCommand.categories.dates',
    icon: Calendar,
  },
  {
    id: 'due',
    label: 'DUE — Set due date on block',
    category: 'slashCommand.categories.dates',
    icon: CalendarClock,
  },
  {
    id: 'schedule',
    label: 'SCHEDULED — Set scheduled date on block',
    category: 'slashCommand.categories.dates',
    icon: CalendarDays,
  },
  {
    id: 'link',
    label: 'LINK — Insert page link',
    category: 'slashCommand.categories.references',
    icon: Link2,
  },
  {
    id: 'tag',
    label: 'TAG — Insert tag reference',
    category: 'slashCommand.categories.references',
    icon: Tag,
  },
  {
    id: 'code',
    label: 'CODE — Insert code block',
    category: 'slashCommand.categories.structure',
    icon: Code,
  },
  {
    id: 'effort',
    label: 'EFFORT — Set effort estimate (15m/30m/1h/2h/4h/1d)',
    category: 'slashCommand.categories.properties',
    icon: Timer,
  },
  {
    id: 'assignee',
    label: 'ASSIGNEE — Set assignee',
    category: 'slashCommand.categories.properties',
    icon: UserCircle,
  },
  {
    id: 'location',
    label: 'LOCATION — Set location',
    category: 'slashCommand.categories.properties',
    icon: MapPin,
  },
  {
    id: 'repeat',
    label: 'REPEAT — Set recurrence (daily/weekly/monthly/+Nd)',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'template',
    label: 'TEMPLATE — Insert block template',
    category: 'slashCommand.categories.templates',
    icon: LayoutTemplate,
  },
  {
    id: 'quote',
    label: 'QUOTE — Insert blockquote',
    category: 'slashCommand.categories.structure',
    icon: Quote,
  },
  {
    id: 'callout',
    label: 'CALLOUT — Insert callout block',
    category: 'slashCommand.categories.structure',
    icon: Info,
  },
  {
    id: 'table',
    label: 'TABLE — Insert table (e.g. /table 4x6)',
    category: 'slashCommand.categories.structure',
    icon: Grid3x3,
  },
  {
    id: 'numbered-list',
    label: 'NUMBERED LIST — Insert ordered list',
    category: 'slashCommand.categories.structure',
    icon: ListOrdered,
  },
  {
    id: 'divider',
    label: 'DIVIDER — Insert horizontal rule',
    category: 'slashCommand.categories.structure',
    icon: Minus,
  },
  {
    id: 'query',
    label: 'QUERY — Insert embedded query block',
    category: 'slashCommand.categories.queries',
    icon: Search,
  },
  {
    id: 'attach',
    label: 'ATTACH — Attach file to block',
    category: 'slashCommand.categories.references',
    icon: Paperclip,
  },
]

export const PRIORITY_COMMANDS: PickerItem[] = [
  {
    id: 'priority-high',
    label: 'PRIORITY 1 — Set high priority',
    category: 'slashCommand.categories.tasks',
    icon: Signal,
  },
  {
    id: 'priority-medium',
    label: 'PRIORITY 2 — Set medium priority',
    category: 'slashCommand.categories.tasks',
    icon: Signal,
  },
  {
    id: 'priority-low',
    label: 'PRIORITY 3 — Set low priority',
    category: 'slashCommand.categories.tasks',
    icon: Signal,
  },
]

export const HEADING_COMMANDS: PickerItem[] = [
  {
    id: 'h1',
    label: 'Heading 1 — Large heading',
    category: 'slashCommand.categories.structure',
    icon: Heading1,
  },
  {
    id: 'h2',
    label: 'Heading 2 — Medium heading',
    category: 'slashCommand.categories.structure',
    icon: Heading2,
  },
  {
    id: 'h3',
    label: 'Heading 3 — Small heading',
    category: 'slashCommand.categories.structure',
    icon: Heading3,
  },
  { id: 'h4', label: 'Heading 4', category: 'slashCommand.categories.structure', icon: Heading4 },
  { id: 'h5', label: 'Heading 5', category: 'slashCommand.categories.structure', icon: Heading5 },
  { id: 'h6', label: 'Heading 6', category: 'slashCommand.categories.structure', icon: Heading6 },
]

export const REPEAT_COMMANDS: PickerItem[] = [
  {
    id: 'repeat-daily',
    label: 'REPEAT DAILY — Every day',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-weekly',
    label: 'REPEAT WEEKLY — Every week',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-monthly',
    label: 'REPEAT MONTHLY — Every month',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-yearly',
    label: 'REPEAT YEARLY — Every year',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-.+daily',
    label: 'REPEAT DAILY (from completion) — Days from when done',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-.+weekly',
    label: 'REPEAT WEEKLY (from completion) — Weeks from when done',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-.+monthly',
    label: 'REPEAT MONTHLY (from completion) — Months from when done',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-++daily',
    label: 'REPEAT DAILY (catch-up) — Advance to next future date',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-++weekly',
    label: 'REPEAT WEEKLY (catch-up) — Advance to next future date',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-++monthly',
    label: 'REPEAT MONTHLY (catch-up) — Advance to next future date',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-remove',
    label: 'REPEAT REMOVE — Clear recurrence',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
]

export const EFFORT_COMMANDS: PickerItem[] = [
  {
    id: 'effort-15m',
    label: 'EFFORT 15m — 15 minutes',
    category: 'slashCommand.categories.properties',
    icon: Timer,
  },
  {
    id: 'effort-30m',
    label: 'EFFORT 30m — 30 minutes',
    category: 'slashCommand.categories.properties',
    icon: Timer,
  },
  {
    id: 'effort-1h',
    label: 'EFFORT 1h — 1 hour',
    category: 'slashCommand.categories.properties',
    icon: Timer,
  },
  {
    id: 'effort-2h',
    label: 'EFFORT 2h — 2 hours',
    category: 'slashCommand.categories.properties',
    icon: Timer,
  },
  {
    id: 'effort-4h',
    label: 'EFFORT 4h — 4 hours',
    category: 'slashCommand.categories.properties',
    icon: Timer,
  },
  {
    id: 'effort-1d',
    label: 'EFFORT 1d — 1 day',
    category: 'slashCommand.categories.properties',
    icon: Timer,
  },
]

export const ASSIGNEE_COMMANDS: PickerItem[] = [
  {
    id: 'assignee-me',
    label: 'ASSIGNEE Me — Assign to me',
    category: 'slashCommand.categories.properties',
    icon: UserCircle,
  },
  {
    id: 'assignee-custom',
    label: 'ASSIGNEE Custom... — Enter custom assignee',
    category: 'slashCommand.categories.properties',
    icon: UserCircle,
  },
]

export const LOCATION_COMMANDS: PickerItem[] = [
  {
    id: 'location-office',
    label: 'LOCATION Office — Office',
    category: 'slashCommand.categories.properties',
    icon: MapPin,
  },
  {
    id: 'location-home',
    label: 'LOCATION Home — Home',
    category: 'slashCommand.categories.properties',
    icon: MapPin,
  },
  {
    id: 'location-remote',
    label: 'LOCATION Remote — Remote',
    category: 'slashCommand.categories.properties',
    icon: MapPin,
  },
  {
    id: 'location-custom',
    label: 'LOCATION Custom... — Enter custom location',
    category: 'slashCommand.categories.properties',
    icon: MapPin,
  },
]

const REPEAT_END_COMMANDS: PickerItem[] = [
  {
    id: 'repeat-until',
    label: 'REPEAT UNTIL — Stop repeating after a date',
    category: 'slashCommand.categories.repeat',
    icon: CalendarX,
  },
  {
    id: 'repeat-limit-5',
    label: 'REPEAT LIMIT 5 — Stop after 5 occurrences',
    category: 'slashCommand.categories.repeat',
    icon: Hash,
  },
  {
    id: 'repeat-limit-10',
    label: 'REPEAT LIMIT 10 — Stop after 10 occurrences',
    category: 'slashCommand.categories.repeat',
    icon: Hash,
  },
  {
    id: 'repeat-limit-20',
    label: 'REPEAT LIMIT 20 — Stop after 20 occurrences',
    category: 'slashCommand.categories.repeat',
    icon: Hash,
  },
  {
    id: 'repeat-limit-remove',
    label: 'REPEAT LIMIT REMOVE — Clear end condition',
    category: 'slashCommand.categories.repeat',
    icon: Hash,
  },
]

export const CALLOUT_COMMANDS: PickerItem[] = [
  {
    id: 'callout-info',
    label: 'CALLOUT INFO — Blue info callout',
    category: 'slashCommand.categories.structure',
    icon: Info,
  },
  {
    id: 'callout-warning',
    label: 'CALLOUT WARNING — Amber warning callout',
    category: 'slashCommand.categories.structure',
    icon: AlertTriangle,
  },
  {
    id: 'callout-tip',
    label: 'CALLOUT TIP — Green tip callout',
    category: 'slashCommand.categories.structure',
    icon: Lightbulb,
  },
  {
    id: 'callout-error',
    label: 'CALLOUT ERROR — Red error callout',
    category: 'slashCommand.categories.structure',
    icon: XCircle,
  },
  {
    id: 'callout-note',
    label: 'CALLOUT NOTE — Gray note callout',
    category: 'slashCommand.categories.structure',
    icon: StickyNote,
  },
]

export function searchSlashCommands(query: string): PickerItem[] {
  const q = query.toLowerCase()
  const baseResults = q ? matchSorter(SLASH_COMMANDS, q, { keys: ['label'] }) : SLASH_COMMANDS
  if (!q) return baseResults
  const priorityResults = matchSorter(PRIORITY_COMMANDS, q, { keys: ['label'] })
  const headingResults = matchSorter(HEADING_COMMANDS, q, { keys: ['label'] })
  const repeatResults = matchSorter(REPEAT_COMMANDS, q, { keys: ['label'] })
  const repeatEndResults = matchSorter(REPEAT_END_COMMANDS, q, { keys: ['label'] })
  const effortResults = matchSorter(EFFORT_COMMANDS, q, { keys: ['label'] })
  const assigneeResults = matchSorter(ASSIGNEE_COMMANDS, q, { keys: ['label'] })
  const locationResults = matchSorter(LOCATION_COMMANDS, q, { keys: ['label'] })
  const calloutResults = matchSorter(CALLOUT_COMMANDS, q, { keys: ['label'] })

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
    ...calloutResults,
  ]
  if (tableMatch) {
    const rows = Number.parseInt(tableMatch[1] as string, 10)
    const cols = Number.parseInt(tableMatch[2] as string, 10)
    results = results.filter((r) => r.id !== 'table')
    results.unshift({
      id: `table:${rows}:${cols}`,
      label: `TABLE ${rows}\u00d7${cols} — Insert ${rows}\u00d7${cols} table`,
      category: 'slashCommand.categories.structure',
      icon: Grid3x3,
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

  const rootParentIdRef = useRef(rootParentId)
  rootParentIdRef.current = rootParentId

  const rovingEditorRef = useRef(rovingEditor)
  rovingEditorRef.current = rovingEditor

  const tRef = useRef(t)
  tRef.current = t

  // Omitted deps explanation:
  //   - rootParentId, rovingEditor, t: latest values read via *Ref.current (see refs above)
  //   - datePickerCursorPos: a MutableRefObject, stable for the lifetime of the owner
  //   - pageStore: a Zustand StoreApi, stable for the lifetime of the owner
  //   - setDatePickerMode, setDatePickerOpen: setter props, treated as stable by callers
  //   - setTemplatePickerOpen, setTemplatePages: local useState setters, guaranteed stable by React
  // Only focusedBlockId is a real dependency — it gates the whole body via `if (!focusedBlockId) return`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally omitted — see above
  const handleSlashCommand = useCallback(
    async (item: PickerItem) => {
      const rootParentId = rootParentIdRef.current
      const rovingEditor = rovingEditorRef.current
      const t = tRef.current
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
          // F-37: warn when completing a task that has unresolved dependencies
          if (state === 'DONE') {
            getProperties(focusedBlockId)
              .then((props) => {
                const hasBlockedBy = props.some(
                  (p) => p.key === 'blocked_by' && p.value_ref != null,
                )
                if (hasBlockedBy) {
                  toast.warning(t('dependency.dependencyWarning'))
                }
              })
              .catch((err) => {
                logger.warn('useBlockSlashCommands', 'dependency check failed', undefined, err)
              })
          }
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

      if (item.id === 'callout' || item.id.startsWith('callout-')) {
        const calloutType = item.id === 'callout' ? 'info' : item.id.replace('callout-', '')
        let currentContent = ''
        if (rovingEditor.editor) {
          const json = rovingEditor.editor.getJSON() as DocNode
          currentContent = serialize(json)
        } else {
          const block = pageStore.getState().blocks.find((b) => b.id === focusedBlockId)
          currentContent = block?.content ?? ''
        }
        const newContent = `> [!${calloutType.toUpperCase()}] ${currentContent}`
        try {
          await editBlock(focusedBlockId, newContent)
          pageStore.setState((state) => ({
            blocks: state.blocks.map((b) =>
              b.id === focusedBlockId ? { ...b, content: newContent } : b,
            ),
          }))
          rovingEditor.mount(focusedBlockId, newContent)
        } catch {
          toast.error(t('slash.calloutFailed'))
        }
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

      if (item.id === 'numbered-list') {
        let currentContent = ''
        if (rovingEditor.editor) {
          const json = rovingEditor.editor.getJSON() as DocNode
          currentContent = serialize(json)
        } else {
          const block = pageStore.getState().blocks.find((b) => b.id === focusedBlockId)
          currentContent = block?.content ?? ''
        }
        const newContent = `1. ${currentContent}`
        try {
          await editBlock(focusedBlockId, newContent)
          pageStore.setState((state) => ({
            blocks: state.blocks.map((b) =>
              b.id === focusedBlockId ? { ...b, content: newContent } : b,
            ),
          }))
          rovingEditor.mount(focusedBlockId, newContent)
        } catch {
          toast.error(t('slash.numberedListFailed'))
        }
        return
      }

      if (item.id === 'divider') {
        const newContent = '---'
        try {
          await editBlock(focusedBlockId, newContent)
          pageStore.setState((state) => ({
            blocks: state.blocks.map((b) =>
              b.id === focusedBlockId ? { ...b, content: newContent } : b,
            ),
          }))
          rovingEditor.mount(focusedBlockId, newContent)
        } catch {
          toast.error(t('slash.dividerFailed'))
        }
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
          // F-37: warn when completing a task that has unresolved dependencies
          if (state === 'DONE') {
            getProperties(focusedBlockId)
              .then((props) => {
                const hasBlockedBy = props.some(
                  (p) => p.key === 'blocked_by' && p.value_ref != null,
                )
                if (hasBlockedBy) {
                  toast.warning(t('dependency.dependencyWarning'))
                }
              })
              .catch((err) => {
                logger.warn(
                  'useBlockSlashCommands',
                  'checkbox dependency check failed',
                  undefined,
                  err,
                )
              })
          }
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
