/**
 * The toast after a property definition write (#5841). Each write is a
 * `set_property_def` op, so the toast offers Undo; a write that appended no op
 * (a create the space already declared) offers none.
 */

import { unwrap } from '@/lib/app-error'
import type { OpRef } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { notify } from '@/lib/notify'
import { reportIpcError } from '@/lib/report-ipc-error'

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
