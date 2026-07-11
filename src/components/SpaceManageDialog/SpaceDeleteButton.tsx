/**
 * SpaceDeleteButton — delete-space affordance with emptiness gate +
 * confirmation AlertDialog.
 *
 * Extracted from `SpaceRowEditor` (D-2). Renders both the
 * Trash icon button (with disabled-state tooltip when the gate
 * Blocks) and the inline-blocked hint paragraph. The
 * Parent owns the emptiness probe and passes the
 * resolved tri-state result.
 *
 * Behaviour preservation contract:
 *  - `isLastSpace` always disables Delete (last-space guard wins).
 *  - `emptiness === false` (probe says non-empty) disables Delete and
 *    surfaces the inline-blocked hint paragraph.
 *  - `emptiness === null` (probe in flight or failed) keeps Delete
 *    disabled but does NOT show the inline hint.
 *  - `emptiness === true` (empty) enables Delete; clicking opens the
 *    confirmation dialog.
 *  - On `delete_block` IPC failure a `space.deleteFailed` toast fires
 *    and the dialog stays open (recoverable).
 */

import { Trash2 } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { deleteBlock } from '@/lib/tauri'

const LOG_MODULE = 'components/SpaceManageDialog/SpaceDeleteButton'

interface SpaceDeleteButtonProps {
  spaceId: string
  spaceName: string
  /** True when this is the only space — delete forbidden. */
  isLastSpace: boolean
  /**
   * Emptiness probe result lifted to the parent. `null` =
   * still loading or fetch failed → Delete stays disabled. `true` =
   * no pages, Delete enabled. `false` = ≥1 page, Delete disabled.
   */
  emptiness: boolean | null
  /** Refresh callback after a successful delete. */
  onRefresh: () => Promise<void> | void
}

export function SpaceDeleteButton({
  spaceId,
  spaceName,
  isLastSpace,
  emptiness,
  onRefresh,
}: SpaceDeleteButtonProps): React.JSX.Element {
  const { t } = useTranslation()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pending, setPending] = useState(false)

  const handleDeleteConfirm = useCallback(async () => {
    // Guard against a fast double-click dispatching `deleteBlock` twice while
    // the first IPC is still in flight (mirrors ConfirmDialog's isPending gate).
    if (pending) return
    setPending(true)
    try {
      await deleteBlock(spaceId)
      // Only close on success — on failure the dialog stays open (recoverable)
      // per the documented contract at the top of this file.
      setConfirmOpen(false)
      await onRefresh()
    } catch (err) {
      logger.error(LOG_MODULE, 'delete failed', { spaceId }, err)
      notify.error(t('space.deleteFailed'))
    } finally {
      setPending(false)
    }
  }, [pending, spaceId, onRefresh, t])

  const deleteDisabledReason: string | null = isLastSpace
    ? t('space.deleteLastTooltipDisabled')
    : emptiness === true
      ? null
      : t('space.deleteSpaceTooltipDisabled')

  const deleteEnabled = deleteDisabledReason === null

  return (
    <>
      {deleteEnabled ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('space.deleteSpaceLabel')}
          onClick={() => setConfirmOpen(true)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('space.deleteSpaceLabel')}
                disabled
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="left">{deleteDisabledReason}</TooltipContent>
        </Tooltip>
      )}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('space.deleteConfirmTitle', { name: spaceName })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('space.deleteConfirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional focus-on-open: destructive-delete confirmation focuses the safe Cancel button so an accidental Enter dismisses rather than deletes */}
            <AlertDialogCancel autoFocus disabled={pending}>
              {t('space.cancelLabel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              disabled={pending}
              // Radix `AlertDialogAction` auto-closes the dialog on click.
              // preventDefault keeps it open while the async delete is in flight
              // so the "stay open on rejection" contract holds — `handleDeleteConfirm`
              // closes via `setConfirmOpen(false)` only on success.
              onClick={(e) => {
                e.preventDefault()
                void handleDeleteConfirm()
              }}
            >
              {pending && <Spinner />}
              {t('action.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

interface SpaceDeleteBlockedHintProps {
  /**
   * `null` = probe in-flight, `true` = empty (delete enabled, no
   * hint), `false` = non-empty (show hint).
   */
  emptiness: boolean | null
  isLastSpace: boolean
}

/**
 * Inline help line under a row when Delete is disabled because the
 * Space contains pages. Sibling to the Trash button so the
 * row layout owns the placement; this keeps the
 * `SpaceDeleteButton` returning a fragment-shape that fits inline
 * in the row's flex header.
 */
export function SpaceDeleteBlockedHint({
  emptiness,
  isLastSpace,
}: SpaceDeleteBlockedHintProps): React.JSX.Element | null {
  const { t } = useTranslation()
  if (isLastSpace || emptiness !== false) return null
  return (
    <p className="text-xs text-muted-foreground" data-testid="space-delete-blocked-hint">
      {t('space.deleteSpaceInlineHint')}
    </p>
  )
}
