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
 * For backward compatibility with existing import sites (and tests) the
 * command arrays and search helpers are re-exported from this module.
 */

import type { MutableRefObject } from 'react'
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
  //   - datePickerCursorPos: a MutableRefObject, stable for the lifetime of the owner
  //   - pageStore: a Zustand StoreApi, stable for the lifetime of the owner
  //   - setDatePickerMode, setDatePickerOpen: setter props, treated as stable by callers
  //   - openTemplatePicker: accessed via ref so callers can change `t` without rebuilding
  // Only focusedBlockId is a real dependency — it gates the whole body via `if (!focusedBlockId) return`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally omitted — see above
  const handleSlashCommand = useCallback(
    async (item: PickerItem) => {
      const rootParentId = rootParentIdRef.current
      const rovingEditor = rovingEditorRef.current
      const t = tRef.current
      if (!focusedBlockId) return

      if (
        item.id === 'todo' ||
        item.id === 'doing' ||
        item.id === 'cancelled' ||
        item.id === 'done'
      ) {
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
        await openTemplatePickerRef.current()
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

  return {
    handleSlashCommand,
    handleTemplateSelect,
    handleCheckboxSyntax,
    templatePickerOpen,
    templatePages,
    setTemplatePickerOpen,
  }
}
