/**
 * SpaceNameEditor — inline rename for a single space row.
 *
 * Extracted from `SpaceRowEditor` (PEND-30 D-2). Owns its own draft
 * `name` state; commits via `editBlock` on blur or Enter. Escape
 * reverts the draft to the canonical `space.name` and blurs.
 *
 * Behaviour preservation contract (callers must keep this in mind):
 *  - Blur OR Enter commits.
 *  - Escape cancels (revert + blur, no IPC).
 *  - Empty / unchanged trims are silently dropped (no IPC, no toast).
 *  - On IPC failure the draft reverts to the canonical name and a
 *    `space.renameFailed` toast surfaces.
 */

import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { editBlock } from '@/lib/tauri'

const LOG_MODULE = 'components/SpaceManageDialog/SpaceNameEditor'

interface SpaceNameEditorProps {
  spaceId: string
  /** Canonical name from the store. Re-syncs the draft on change. */
  spaceName: string
  /** Refresh callback after a successful rename. */
  onRefresh: () => Promise<void> | void
}

export function SpaceNameEditor({
  spaceId,
  spaceName,
  onRefresh,
}: SpaceNameEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState(spaceName)
  const renameInputId = useId()

  // Re-sync local state when the upstream `spaceName` changes — for
  // instance after the user renames it elsewhere or refreshAvailableSpaces
  // returns server truth that differs from optimistic state.
  useEffect(() => {
    setName(spaceName)
  }, [spaceName])

  const handleCommit = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === spaceName) {
      setName(spaceName)
      return
    }
    try {
      await editBlock(spaceId, trimmed)
      await onRefresh()
    } catch (err) {
      logger.error(LOG_MODULE, 'rename failed', { spaceId }, err)
      notify.error(t('space.renameFailed'))
      setName(spaceName)
    }
  }, [name, spaceName, spaceId, onRefresh, t])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        ;(e.target as HTMLInputElement).blur()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setName(spaceName)
        ;(e.target as HTMLInputElement).blur()
      }
    },
    [spaceName],
  )

  return (
    <>
      <Label htmlFor={renameInputId} className="sr-only">
        {t('space.renameLabel')}
      </Label>
      <Input
        id={renameInputId}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => void handleCommit()}
        onKeyDown={handleKeyDown}
        aria-label={t('space.renameLabel')}
        className="flex-1"
      />
    </>
  )
}
