/**
 * Property-related slash commands: TODO state, priority, assignee, location,
 * effort, repeat, repeat-limit, attach.
 *
 * All handlers mutate `block_properties` (or, for the four hot-path columns
 * `todo_state` / `priority`, the column directly via `setTodoStateCmd` /
 * `setPriorityCmd`) and notify the undo store. Pure ctx-driven — empty
 * `useMemo` dep array, no `oxlint-disable react-hooks/exhaustive-deps`.
 */

import { useMemo } from 'react'

import { notify } from '@/lib/notify'

import { guessMimeType, isAttachmentAllowed, readFileBytes } from '../../lib/file-utils'
import { logger } from '../../lib/logger'
import { formatRepeatLabel } from '../../lib/repeat-utils'
import {
  addAttachmentWithBytes,
  deleteProperty,
  setPriority as setPriorityCmd,
  setProperty,
  setTodoState as setTodoStateCmd,
} from '../../lib/tauri'
import { notifyUndo, warnIfBlocked } from './helpers'
import type { SlashCommandContext, SlashHandlerTables } from './types'

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
    notify.error(ctx.t('blockTree.setTaskStateFailed'))
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
    notify.error(ctx.t('blockTree.setPriorityFailed'))
  }
}

async function handleAssigneeOrLocation(
  ctx: SlashCommandContext,
  key: 'assignee' | 'location',
  label: string,
): Promise<void> {
  try {
    await setProperty({ blockId: ctx.blockId, key, valueText: '' })
    notifyUndo(ctx.rootParentId)
    notify.success(
      ctx.t('blockTree.addedPropertyMessage', {
        name: label.split(' — ')[0]?.toLowerCase(),
      }),
    )
  } catch {
    notify.error(ctx.t('blockTree.addPropertyFailed'))
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
      notify.success(ctx.t('blockTree.addedAssigneeProperty'))
    } catch {
      notify.error(ctx.t('blockTree.addPropertyFailed'))
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
    notify.success(ctx.t('blockTree.setAssigneeMessage', { value }))
  } catch {
    notify.error(ctx.t('blockTree.setAssigneeFailed'))
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
      notify.success(ctx.t('blockTree.addedLocationProperty'))
    } catch {
      notify.error(ctx.t('blockTree.addPropertyFailed'))
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
    notify.success(ctx.t('blockTree.setLocationMessage', { value }))
  } catch {
    notify.error(ctx.t('blockTree.setLocationFailed'))
  }
}

async function handleEffort(ctx: SlashCommandContext, value: string): Promise<void> {
  // 'Custom…' escape hatch: arbitrary effort values (e.g. `3d`, `45m`,
  // story-points) aren't covered by the fixed buckets, so route through the
  // same empty-value → property-editor path as assignee/location custom.
  if (value === 'custom') {
    try {
      await setProperty({ blockId: ctx.blockId, key: 'effort', valueText: '' })
      notifyUndo(ctx.rootParentId)
      notify.success(ctx.t('blockTree.addedEffortProperty'))
    } catch {
      notify.error(ctx.t('blockTree.addPropertyFailed'))
    }
    return
  }
  try {
    await setProperty({ blockId: ctx.blockId, key: 'effort', valueText: value })
    notifyUndo(ctx.rootParentId)
    notify.success(ctx.t('slash.effortSet', { value }))
  } catch {
    notify.error(ctx.t('slash.effortFailed'))
  }
}

async function handleRepeatLimit(ctx: SlashCommandContext, sub: string): Promise<void> {
  if (sub === 'remove') {
    try {
      await deleteProperty(ctx.blockId, 'repeat-count')
      await deleteProperty(ctx.blockId, 'repeat-until')
      notify.success(ctx.t('blockTree.repeatEndConditionRemoved'))
    } catch {
      notify.error(ctx.t('blockTree.removeEndConditionFailed'))
    }
    return
  }
  const count = Number.parseInt(sub, 10)
  if (Number.isNaN(count)) return
  try {
    await setProperty({ blockId: ctx.blockId, key: 'repeat-count', valueNum: count })
    notifyUndo(ctx.rootParentId)
    notify.success(ctx.t('blockTree.repeatLimitedMessage', { count }))
  } catch {
    notify.error(ctx.t('blockTree.setRepeatLimitFailed'))
  }
}

async function handleRepeat(ctx: SlashCommandContext, value: string): Promise<void> {
  if (value === 'remove') {
    try {
      await deleteProperty(ctx.blockId, 'repeat')
      notify.success(ctx.t('slash.repeatRemoved'))
    } catch {
      notify.error(ctx.t('slash.repeatRemoveFailed'))
    }
    return
  }
  try {
    await setProperty({ blockId: ctx.blockId, key: 'repeat', valueText: value })
    notifyUndo(ctx.rootParentId)
    // ctx.t is typed as the file-local loose `TFn` to keep the dispatcher
    // generic; formatRepeatLabel takes the strict i18next `TFunction`. The
    // cast is safe because ctx.t IS the i18next translator at runtime —
    // only the type alias is loose. See the `TFn` declaration in `types.ts`.
    notify.success(
      ctx.t('slash.repeatSet', {
        value: formatRepeatLabel(value, ctx.t as unknown as import('i18next').TFunction),
      }),
    )
  } catch {
    notify.error(ctx.t('slash.repeatFailed'))
  }
}

function handleAttach(ctx: SlashCommandContext): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    if (!file) return
    const filename = file.name
    const sizeBytes = file.size
    const mimeType = file.type || guessMimeType(filename)
    const allowed = isAttachmentAllowed(mimeType, sizeBytes)
    if (!allowed.ok) {
      notify.error(ctx.t(allowed.reason, allowed.i18nContext))
      return
    }
    const showProgress = sizeBytes >= 1_048_576
    const progressToastId = showProgress
      ? notify.loading(ctx.t('blockTree.attachingFileMessage', { filename }))
      : undefined
    try {
      const bytes = await readFileBytes(file)
      await addAttachmentWithBytes({
        blockId: ctx.blockId,
        filename,
        mimeType,
        bytes,
      })
      if (progressToastId !== undefined) notify.dismiss(progressToastId)
      notify.success(ctx.t('blockTree.attachedFileMessage', { filename }))
    } catch {
      if (progressToastId !== undefined) notify.dismiss(progressToastId)
      notify.error(ctx.t('blockTree.attachFileFailed'))
    }
  })
  // `input.click()` can throw on some platforms (e.g. when the user
  // gesture has been lost or the browser/webview blocks programmatic file
  // dialogs). Surface the failure instead of letting it bubble as an
  // unhandled rejection.
  try {
    input.click()
  } catch (err) {
    notify.error(ctx.t('attachments.openFileDialogFailed'))
    logger.warn('useBlockSlashCommands', 'input.click failed', undefined, err)
  }
}

export function useSlashCommandProperty(): SlashHandlerTables {
  return useMemo<SlashHandlerTables>(
    () => ({
      exact: {
        todo: (ctx) => handleTodoState(ctx, 'TODO'),
        doing: (ctx) => handleTodoState(ctx, 'DOING'),
        cancelled: (ctx) => handleTodoState(ctx, 'CANCELLED'),
        done: (ctx) => handleTodoState(ctx, 'DONE'),
        'priority-high': (ctx) => handlePriority(ctx, '1'),
        'priority-medium': (ctx) => handlePriority(ctx, '2'),
        'priority-low': (ctx) => handlePriority(ctx, '3'),
        assignee: (ctx, item) => handleAssigneeOrLocation(ctx, 'assignee', item.label),
        location: (ctx, item) => handleAssigneeOrLocation(ctx, 'location', item.label),
        attach: (ctx) => handleAttach(ctx),
      },
      prefix: [
        // Order matters: more specific prefixes (`repeat-limit-`) must be
        // checked before broader ones (`repeat-`).
        [
          'assignee-',
          (ctx, item) => handleAssigneePreset(ctx, item.id.replace('assignee-', ''), item.label),
        ],
        [
          'location-',
          (ctx, item) => handleLocationPreset(ctx, item.id.replace('location-', ''), item.label),
        ],
        ['effort-', (ctx, item) => handleEffort(ctx, item.id.replace('effort-', ''))],
        [
          'repeat-limit-',
          (ctx, item) => handleRepeatLimit(ctx, item.id.replace('repeat-limit-', '')),
        ],
        ['repeat-', (ctx, item) => handleRepeat(ctx, item.id.replace('repeat-', ''))],
      ],
    }),
    [],
  )
}
