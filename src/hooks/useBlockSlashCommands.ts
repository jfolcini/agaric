/**
 * Slash-command orchestrator.
 *
 * Owns the central `handleSlashCommand` state machine — dispatches each
 * picked slash item to the right Tauri command, editor mutation, or sub-hook
 * (template picker, date picker). State-heavy concerns have been split out:
 *   - command catalog + search helpers → `src/lib/slash-commands.ts`
 *   - template-picker state + insertion → `useTemplateSelection`
 *   - checkbox-syntax TODO/DONE handler → `useCheckboxSyntax`
 *
 * The individual command handlers live at module scope below as a dispatch
 * table keyed by either the exact picker id (e.g. `todo`, `date`) or a
 * structured prefix (`effort-`, `repeat-limit-`, `assignee-`, …). The hook
 * itself only assembles a `SlashCommandContext` from the latest refs and
 * delegates to `dispatchSlashCommand`, which keeps `handleSlashCommand`'s
 * cognitive complexity trivial and preserves the MAINT-10 identity-stability
 * contract (only `focusedBlockId` rebuilds the callback).
 *
 * For backward compatibility with existing import sites (and tests) the
 * command arrays and search helpers are re-exported from this module.
 */

import type { RefObject } from 'react'
import { useCallback, useRef } from 'react'
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
  setPriority as setPriorityCmd,
  setProperty,
  setTodoState as setTodoStateCmd,
} from '../lib/tauri'
import type { PageBlockState } from '../stores/page-blocks'
import { useUndoStore } from '../stores/undo'
import { useCheckboxSyntax } from './useCheckboxSyntax'
import { useTemplateSelection } from './useTemplateSelection'

// Re-export command catalog + search helpers from the new data module so
// existing consumers (BlockTree.tsx, the test suite) keep working.
export {
  ASSIGNEE_COMMANDS,
  CALLOUT_COMMANDS,
  EFFORT_COMMANDS,
  HEADING_COMMANDS,
  LOCATION_COMMANDS,
  PRIORITY_COMMANDS,
  REPEAT_COMMANDS,
  SLASH_COMMANDS,
  searchPropertyKeys,
  searchSlashCommands,
} from '../lib/slash-commands'

type DatePickerMode = 'date' | 'due' | 'schedule' | 'repeat-until'

// biome-ignore lint/suspicious/noExplicitAny: TFunction overload set is too complex
type TFn = (...args: any[]) => any

export interface UseBlockSlashCommandsParams {
  focusedBlockId: string | null
  rootParentId: string | null
  pageStore: StoreApi<PageBlockState>
  rovingEditor: Pick<RovingEditorHandle, 'editor' | 'mount'>
  datePickerCursorPos: RefObject<number | undefined>
  setDatePickerMode: (mode: DatePickerMode) => void
  setDatePickerOpen: (open: boolean) => void
  blocks: Array<{ id: string; parent_id: string | null; content: string | null }>
  load: () => Promise<void>
  t: TFn
}

export interface UseBlockSlashCommandsReturn {
  handleSlashCommand: (item: PickerItem) => Promise<void>
  handleTemplateSelect: (templatePageId: string) => Promise<void>
  handleCheckboxSyntax: (state: 'TODO' | 'DONE') => void
  templatePickerOpen: boolean
  templatePages: Array<{ id: string; content: string; preview: string | null }>
  setTemplatePickerOpen: (open: boolean) => void
}

// ---------------------------------------------------------------------------
// Dispatch infrastructure
// ---------------------------------------------------------------------------

/**
 * Immutable, dispatcher-only snapshot of the hook state used by a single
 * `handleSlashCommand` invocation. Built from the latest refs at call time so
 * downstream handlers always see the current `rootParentId`, `rovingEditor`,
 * `t`, etc. without rebuilding the memoised callback.
 */
interface SlashCommandContext {
  blockId: string
  rootParentId: string | null
  rovingEditor: Pick<RovingEditorHandle, 'editor' | 'mount'>
  pageStore: StoreApi<PageBlockState>
  datePickerCursorPos: RefObject<number | undefined>
  setDatePickerMode: (mode: DatePickerMode) => void
  setDatePickerOpen: (open: boolean) => void
  t: TFn
  openTemplatePicker: () => Promise<void>
}

type SlashHandler = (ctx: SlashCommandContext, item: PickerItem) => Promise<void> | void

// ---------------------------------------------------------------------------
// Small helpers shared by multiple handlers
// ---------------------------------------------------------------------------

function notifyUndo(rootParentId: string | null): void {
  if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
}

function readCurrentContent(ctx: SlashCommandContext): string {
  if (ctx.rovingEditor.editor) {
    const json = ctx.rovingEditor.editor.getJSON() as DocNode
    return serialize(json)
  }
  const block = ctx.pageStore.getState().blocks.find((b) => b.id === ctx.blockId)
  return block?.content ?? ''
}

async function applyContentEdit(
  ctx: SlashCommandContext,
  newContent: string,
  failKey: string,
): Promise<void> {
  try {
    await editBlock(ctx.blockId, newContent)
    // MAINT-116: heading/callout/numbered-list/divider slash commands
    // must clear the redo stack just like every other content-edit
    // mutation in `pageStore.edit()`. Pre-fix this was missing, so a
    // user could `Cmd+Z` past a slash command and `Cmd+Shift+Z` would
    // resurrect the wrong content. Mirror the `pageStore.edit()`
    // contract (`page-blocks.ts:392`) by calling `notifyUndo` here.
    notifyUndo(ctx.rootParentId)
    ctx.pageStore.setState((state) => ({
      blocks: state.blocks.map((b) => (b.id === ctx.blockId ? { ...b, content: newContent } : b)),
    }))
    ctx.rovingEditor.mount(ctx.blockId, newContent)
  } catch {
    toast.error(ctx.t(failKey))
  }
}

function openDatePicker(ctx: SlashCommandContext, mode: DatePickerMode): void {
  ctx.datePickerCursorPos.current = ctx.rovingEditor.editor?.state.selection.$anchor.pos
  ctx.setDatePickerMode(mode)
  ctx.setDatePickerOpen(true)
}

function warnIfBlocked(ctx: SlashCommandContext): void {
  getProperties(ctx.blockId)
    .then((props) => {
      const hasBlockedBy = props.some((p) => p.key === 'blocked_by' && p.value_ref != null)
      if (hasBlockedBy) toast.warning(ctx.t('dependency.dependencyWarning'))
    })
    .catch((err) => {
      logger.warn('useBlockSlashCommands', 'dependency check failed', undefined, err)
    })
}

// ---------------------------------------------------------------------------
// Individual command handlers
// ---------------------------------------------------------------------------

async function handleTodoState(ctx: SlashCommandContext, state: string): Promise<void> {
  try {
    await setTodoStateCmd(ctx.blockId, state)
    notifyUndo(ctx.rootParentId)
    ctx.pageStore.setState((s) => ({
      blocks: s.blocks.map((b) => (b.id === ctx.blockId ? { ...b, todo_state: state } : b)),
    }))
    // F-37: warn when completing a task that has unresolved dependencies
    if (state === 'DONE') warnIfBlocked(ctx)
  } catch {
    toast.error(ctx.t('blockTree.setTaskStateFailed'))
  }
}

async function handlePriority(ctx: SlashCommandContext, priority: string): Promise<void> {
  try {
    await setPriorityCmd(ctx.blockId, priority)
    notifyUndo(ctx.rootParentId)
    ctx.pageStore.setState((s) => ({
      blocks: s.blocks.map((b) => (b.id === ctx.blockId ? { ...b, priority } : b)),
    }))
  } catch {
    toast.error(ctx.t('blockTree.setPriorityFailed'))
  }
}

async function handleHeading(ctx: SlashCommandContext, level: number): Promise<void> {
  const stripped = readCurrentContent(ctx).replace(/^#{1,6}\s/, '')
  const newContent = `${'#'.repeat(level)} ${stripped}`
  await applyContentEdit(ctx, newContent, 'blockTree.setHeadingFailed')
}

async function handleCallout(ctx: SlashCommandContext, calloutType: string): Promise<void> {
  const newContent = `> [!${calloutType.toUpperCase()}] ${readCurrentContent(ctx)}`
  await applyContentEdit(ctx, newContent, 'slash.calloutFailed')
}

async function handleNumberedList(ctx: SlashCommandContext): Promise<void> {
  const newContent = `1. ${readCurrentContent(ctx)}`
  await applyContentEdit(ctx, newContent, 'slash.numberedListFailed')
}

async function handleDivider(ctx: SlashCommandContext): Promise<void> {
  await applyContentEdit(ctx, '---', 'slash.dividerFailed')
}

function handleTable(ctx: SlashCommandContext, id: string): void {
  let rows = 3
  let cols = 3
  const dimMatch = id.match(/^table:(\d+):(\d+)$/)
  if (dimMatch) {
    rows = Number.parseInt(dimMatch[1] as string, 10)
    cols = Number.parseInt(dimMatch[2] as string, 10)
  }
  ctx.rovingEditor.editor?.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run()
}

async function handleAssigneeOrLocation(
  ctx: SlashCommandContext,
  key: 'assignee' | 'location',
  label: string,
): Promise<void> {
  try {
    await setProperty({ blockId: ctx.blockId, key, valueText: '' })
    notifyUndo(ctx.rootParentId)
    toast.success(
      ctx.t('blockTree.addedPropertyMessage', {
        name: label.split(' — ')[0]?.toLowerCase(),
      }),
    )
  } catch {
    toast.error(ctx.t('blockTree.addPropertyFailed'))
  }
}

async function handleAssigneePreset(
  ctx: SlashCommandContext,
  preset: string,
  label: string,
): Promise<void> {
  if (preset === 'custom') {
    try {
      await setProperty({ blockId: ctx.blockId, key: 'assignee', valueText: '' })
      notifyUndo(ctx.rootParentId)
      toast.success(ctx.t('blockTree.addedAssigneeProperty'))
    } catch {
      toast.error(ctx.t('blockTree.addPropertyFailed'))
    }
    return
  }
  const value = label.split(' — ')[0]?.replace('ASSIGNEE ', '')
  try {
    await setProperty({
      blockId: ctx.blockId,
      key: 'assignee',
      ...(value != null && { valueText: value }),
    })
    notifyUndo(ctx.rootParentId)
    toast.success(ctx.t('blockTree.setAssigneeMessage', { value }))
  } catch {
    toast.error(ctx.t('blockTree.setAssigneeFailed'))
  }
}

async function handleLocationPreset(
  ctx: SlashCommandContext,
  preset: string,
  label: string,
): Promise<void> {
  if (preset === 'custom') {
    try {
      await setProperty({ blockId: ctx.blockId, key: 'location', valueText: '' })
      notifyUndo(ctx.rootParentId)
      toast.success(ctx.t('blockTree.addedLocationProperty'))
    } catch {
      toast.error(ctx.t('blockTree.addPropertyFailed'))
    }
    return
  }
  const value = label.split(' — ')[0]?.replace('LOCATION ', '')
  try {
    await setProperty({
      blockId: ctx.blockId,
      key: 'location',
      valueText: value,
    })
    notifyUndo(ctx.rootParentId)
    toast.success(ctx.t('blockTree.setLocationMessage', { value }))
  } catch {
    toast.error(ctx.t('blockTree.setLocationFailed'))
  }
}

async function handleEffort(ctx: SlashCommandContext, value: string): Promise<void> {
  try {
    await setProperty({ blockId: ctx.blockId, key: 'effort', valueText: value })
    notifyUndo(ctx.rootParentId)
    toast.success(ctx.t('slash.effortSet', { value }))
  } catch {
    toast.error(ctx.t('slash.effortFailed'))
  }
}

async function handleRepeatLimit(ctx: SlashCommandContext, sub: string): Promise<void> {
  if (sub === 'remove') {
    try {
      await deleteProperty(ctx.blockId, 'repeat-count')
      await deleteProperty(ctx.blockId, 'repeat-until')
      toast.success(ctx.t('blockTree.repeatEndConditionRemoved'))
    } catch {
      toast.error(ctx.t('blockTree.removeEndConditionFailed'))
    }
    return
  }
  const count = Number.parseInt(sub, 10)
  if (Number.isNaN(count)) return
  try {
    await setProperty({ blockId: ctx.blockId, key: 'repeat-count', valueNum: count })
    notifyUndo(ctx.rootParentId)
    toast.success(ctx.t('blockTree.repeatLimitedMessage', { count }))
  } catch {
    toast.error(ctx.t('blockTree.setRepeatLimitFailed'))
  }
}

async function handleRepeat(ctx: SlashCommandContext, value: string): Promise<void> {
  if (value === 'remove') {
    try {
      await deleteProperty(ctx.blockId, 'repeat')
      toast.success(ctx.t('slash.repeatRemoved'))
    } catch {
      toast.error(ctx.t('slash.repeatRemoveFailed'))
    }
    return
  }
  try {
    await setProperty({ blockId: ctx.blockId, key: 'repeat', valueText: value })
    notifyUndo(ctx.rootParentId)
    // ctx.t is typed as the file-local loose `TFn` to keep the dispatcher
    // generic; formatRepeatLabel takes the strict i18next `TFunction`. The
    // cast is safe because ctx.t IS the i18next translator at runtime —
    // only the type alias is loose. See the `TFn` declaration at the top
    // of this file.
    toast.success(
      ctx.t('slash.repeatSet', {
        value: formatRepeatLabel(value, ctx.t as unknown as import('i18next').TFunction),
      }),
    )
  } catch {
    toast.error(ctx.t('slash.repeatFailed'))
  }
}

function handleAttach(ctx: SlashCommandContext): void {
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
      toast.error(ctx.t('blockTree.filePathReadFailed'))
      return
    }
    try {
      await addAttachment({
        blockId: ctx.blockId,
        filename,
        mimeType,
        sizeBytes,
        fsPath,
      })
      toast.success(ctx.t('blockTree.attachedFileMessage', { filename }))
    } catch {
      toast.error(ctx.t('blockTree.attachFileFailed'))
    }
  }
  input.click()
}

// ---------------------------------------------------------------------------
// Dispatch tables
// ---------------------------------------------------------------------------

/**
 * Exact-id → handler. Lookup here is O(1) and, together with the ordered
 * prefix table below, replaces the long if/else cascade that previously lived
 * inside `handleSlashCommand` (cognitive complexity ≈ 157).
 */
const EXACT_HANDLERS: Record<string, SlashHandler> = {
  todo: (ctx) => handleTodoState(ctx, 'TODO'),
  doing: (ctx) => handleTodoState(ctx, 'DOING'),
  cancelled: (ctx) => handleTodoState(ctx, 'CANCELLED'),
  done: (ctx) => handleTodoState(ctx, 'DONE'),
  'priority-high': (ctx) => handlePriority(ctx, '1'),
  'priority-medium': (ctx) => handlePriority(ctx, '2'),
  'priority-low': (ctx) => handlePriority(ctx, '3'),
  date: (ctx) => openDatePicker(ctx, 'date'),
  due: (ctx) => openDatePicker(ctx, 'due'),
  schedule: (ctx) => openDatePicker(ctx, 'schedule'),
  'repeat-until': (ctx) => openDatePicker(ctx, 'repeat-until'),
  link: (ctx) => {
    ctx.rovingEditor.editor?.chain().focus().insertContent('[[').run()
  },
  tag: (ctx) => {
    ctx.rovingEditor.editor?.chain().focus().insertContent('@').run()
  },
  code: (ctx) => {
    ctx.rovingEditor.editor?.chain().focus().toggleCodeBlock().run()
  },
  quote: (ctx) => {
    ctx.rovingEditor.editor?.chain().focus().toggleBlockquote().run()
  },
  query: (ctx) => {
    ctx.rovingEditor.editor?.chain().focus().insertContent('{{query type:tag expr:}}').run()
  },
  callout: (ctx) => handleCallout(ctx, 'info'),
  'numbered-list': (ctx) => handleNumberedList(ctx),
  divider: (ctx) => handleDivider(ctx),
  table: (ctx) => handleTable(ctx, 'table'),
  assignee: (ctx, item) => handleAssigneeOrLocation(ctx, 'assignee', item.label),
  location: (ctx, item) => handleAssigneeOrLocation(ctx, 'location', item.label),
  template: (ctx) => ctx.openTemplatePicker(),
  attach: (ctx) => handleAttach(ctx),
}

/**
 * Prefix → handler, ordered by specificity. Earlier entries win — this is
 * how `repeat-limit-*` is matched before the broader `repeat-*`.
 */
const PREFIX_HANDLERS: ReadonlyArray<[string, SlashHandler]> = [
  ['table:', (ctx, item) => handleTable(ctx, item.id)],
  ['callout-', (ctx, item) => handleCallout(ctx, item.id.replace('callout-', ''))],
  [
    'assignee-',
    (ctx, item) => handleAssigneePreset(ctx, item.id.replace('assignee-', ''), item.label),
  ],
  [
    'location-',
    (ctx, item) => handleLocationPreset(ctx, item.id.replace('location-', ''), item.label),
  ],
  ['effort-', (ctx, item) => handleEffort(ctx, item.id.replace('effort-', ''))],
  ['repeat-limit-', (ctx, item) => handleRepeatLimit(ctx, item.id.replace('repeat-limit-', ''))],
  ['repeat-', (ctx, item) => handleRepeat(ctx, item.id.replace('repeat-', ''))],
]

async function dispatchSlashCommand(ctx: SlashCommandContext, item: PickerItem): Promise<void> {
  const exact = EXACT_HANDLERS[item.id]
  if (exact) {
    await exact(ctx, item)
    return
  }

  const headingMatch = item.id.match(/^h([1-6])$/)
  if (headingMatch) {
    await handleHeading(ctx, Number(headingMatch[1]))
    return
  }

  for (const [prefix, handler] of PREFIX_HANDLERS) {
    if (item.id.startsWith(prefix)) {
      await handler(ctx, item)
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

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
  const {
    templatePickerOpen,
    templatePages,
    setTemplatePickerOpen,
    openTemplatePicker,
    handleTemplateSelect,
  } = useTemplateSelection({ focusedBlockId, rootParentId, blocks, load, t })

  const handleCheckboxSyntax = useCheckboxSyntax({
    focusedBlockId,
    rootParentId,
    pageStore,
    t,
  })

  const rootParentIdRef = useRef(rootParentId)
  rootParentIdRef.current = rootParentId

  const rovingEditorRef = useRef(rovingEditor)
  rovingEditorRef.current = rovingEditor

  const tRef = useRef(t)
  tRef.current = t

  // `openTemplatePicker` rebuilds when `t` changes; route through a ref so
  // `handleSlashCommand` keeps a stable identity (see MAINT-10 test suite).
  const openTemplatePickerRef = useRef(openTemplatePicker)
  openTemplatePickerRef.current = openTemplatePicker

  // Omitted deps explanation:
  //   - rootParentId, rovingEditor, t: latest values read via *Ref.current (see refs above)
  //   - datePickerCursorPos: a RefObject, stable for the lifetime of the owner
  //   - pageStore: a Zustand StoreApi, stable for the lifetime of the owner
  //   - setDatePickerMode, setDatePickerOpen: setter props, treated as stable by callers
  //   - openTemplatePicker: accessed via ref so callers can change `t` without rebuilding
  // Only focusedBlockId is a real dependency — it gates the whole body via `if (!focusedBlockId) return`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally omitted — see above
  const handleSlashCommand = useCallback(
    async (item: PickerItem) => {
      if (!focusedBlockId) return
      const ctx: SlashCommandContext = {
        blockId: focusedBlockId,
        rootParentId: rootParentIdRef.current,
        rovingEditor: rovingEditorRef.current,
        pageStore,
        datePickerCursorPos,
        setDatePickerMode,
        setDatePickerOpen,
        t: tRef.current,
        openTemplatePicker: openTemplatePickerRef.current,
      }
      await dispatchSlashCommand(ctx, item)
    },
    [focusedBlockId],
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
