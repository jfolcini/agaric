/**
 * The toast after a property definition write (#5841). Each write is an op,
 * so the toast offers Undo; a write that appended no op (a create the space
 * already declared) offers none.
 */

import { unwrap } from '@/lib/app-error'
import type { OpRef } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { notify } from '@/lib/notify'
import { reportIpcError, reportIpcErrorWithReason } from '@/lib/report-ipc-error'

/** Toast `message`, with an Undo that reverses `opRefs` and then calls `onUndone`. */
export function notifyDefinitionWrite(
  message: string,
  opRefs: OpRef[],
  onUndone?: () => void,
): void {
  if (opRefs.length === 0) {
    notify.success(message)
    return
  }
  notify.success(message, {
    action: { label: t('action.undo'), onClick: () => void undoDefinitionWrite(opRefs, onUndone) },
  })
}

async function undoDefinitionWrite(opRefs: OpRef[], onUndone?: () => void): Promise<void> {
  try {
    unwrap(await commands.undoOps(opRefs))
    onUndone?.()
  } catch (error) {
    reportIpcError('PropertyDefinitions', 'propertiesView.undoFailed', error, t, { opRefs })
  }
}

/**
 * Rename `from` to `to` in `spaceId`'s select `key`, with the toast and its
 * Undo; `changed` runs after the rename and after its undo. Resolves whether
 * the rename was written; a refusal is reported with its reason.
 */
export async function renameSelectOption(
  spaceId: string,
  key: string,
  from: string,
  to: string,
  changed: () => void,
): Promise<boolean> {
  try {
    const { op_refs } = unwrap(await commands.renamePropertyOption(spaceId, key, from, to))
    notifyDefinitionWrite(t('propertiesView.optionRenamed', { key, from, to }), op_refs, changed)
    changed()
    return true
  } catch (error) {
    reportIpcErrorWithReason('PropertyDefinitions', 'propertiesView.renameOptionFailed', error, t, {
      key,
      from,
      to,
    })
    return false
  }
}
