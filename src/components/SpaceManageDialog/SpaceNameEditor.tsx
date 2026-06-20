/**
 * SpaceNameEditor — inline rename for a single space row.
 *
 * Extracted from `SpaceRowEditor` (D-2). Owns its own draft
 * `name` state; commits via `editBlock` on blur or Enter. Escape
 * reverts the draft to the canonical `space.name` and blurs.
 *
 * Draft-resync policy (#1674): this editor re-syncs its draft from the
 * canonical `spaceName` prop when that prop changes (e.g. an external
 * rename, or `refreshAvailableSpaces` returning server truth) — UNLESS
 * the input is currently focused, i.e. the user has an in-flight edit.
 * Skipping the re-sync while focused prevents a mid-type parent refresh
 * from clobbering the unsaved draft. This is the guarded-re-sync arm of
 * the policy reconciliation: the sibling `SpaceJournalTemplateEditor`
 * reads its value once (read-once + remount-via-key); the name editor
 * keeps a re-sync because its row is keyed by `space.id`, which is
 * stable across a rename, so a plain read-once model would never pick
 * up an external rename without a dialog re-open.
 *
 * Behaviour preservation contract (callers must keep this in mind):
 *  - Blur OR Enter commits.
 *  - Escape cancels (revert + blur, no IPC).
 *  - Empty / unchanged trims are silently dropped (no IPC, no toast).
 *  - On IPC failure the draft reverts to the canonical name and a
 *    `space.renameFailed` toast surfaces.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
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
  // Tracks whether the input is focused (the user has an in-flight
  // edit). Held in a ref so toggling it never triggers a re-render and
  // so the resync effect reads the latest value without depending on it.
  const isFocusedRef = useRef(false)
  const renameInputId = useId()

  // Re-sync local state when the upstream `spaceName` changes — for
  // instance after the user renames it elsewhere or refreshAvailableSpaces
  // returns server truth that differs from optimistic state. Guarded
  // (#1674): skip while the input is focused so a parent refresh that
  // lands mid-type does not clobber the unsaved draft.
  useEffect(() => {
    if (isFocusedRef.current) return
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
        onFocus={() => {
          isFocusedRef.current = true
        }}
        onBlur={() => {
          isFocusedRef.current = false
          void handleCommit()
        }}
        onKeyDown={handleKeyDown}
        aria-label={t('space.renameLabel')}
        className="flex-1"
      />
    </>
  )
}
