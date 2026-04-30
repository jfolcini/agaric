/**
 * ConfirmDestructiveAction — async-aware destructive-action confirmation
 * built on top of Radix `AlertDialog`.
 *
 * Differs from {@link ConfirmDialog} in three ways:
 *  - Always destructive — no `actionVariant` knob.
 *  - i18n-key API — caller passes `titleKey` / `descriptionKey` /
 *    `confirmKey` (and optional `cancelKey` + `values` for
 *    interpolation) instead of pre-resolved strings, so every callsite
 *    is forced through `t()`.
 *  - Async-aware — `onConfirm` may return `Promise<void>`. The dialog
 *    closes (`onOpenChange(false)`) on success and stays open on
 *    rejection so the caller's toast/log path runs without the dialog
 *    flickering closed-then-open. The wrapper deliberately swallows
 *    the rejection here so it does not escape into React's unhandled-
 *    rejection logger; the caller's `onConfirm` is responsible for
 *    surfacing the error (toast.error / inline banner).
 *
 * UX-259: focus lands on Cancel by default (Radix `AlertDialogCancel`
 * does this naturally for destructive callers — we keep the default).
 * A reflex Enter on open dismisses the dialog instead of confirming.
 */

import type React from 'react'
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
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface ConfirmDestructiveActionProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** i18n key for the dialog title (e.g. 'pairing.confirmCloseTitle'). */
  titleKey: string
  /** i18n key for the dialog body / description. */
  descriptionKey: string
  /** i18n key for the destructive confirm button label. */
  confirmKey: string
  /** i18n key for the cancel button label. Defaults to `'dialog.cancel'`. */
  cancelKey?: string
  /**
   * Async confirm handler. The dialog closes via `onOpenChange(false)`
   * on success; on rejection the dialog stays open and the caller is
   * expected to surface the error (toast.error, inline banner, …).
   */
  onConfirm: () => Promise<void> | void
  /** Optional values for i18n interpolation (passed to `t()`). */
  values?: Record<string, string | number>
  /** Optional className forwarded to AlertDialogContent (test/styling hook). */
  className?: string | undefined
  /** Optional data-testid for the AlertDialogContent root. */
  contentTestId?: string | undefined
  /** Optional data-testid for the Cancel button. */
  cancelTestId?: string | undefined
  /** Optional data-testid for the Confirm (destructive) button. */
  confirmTestId?: string | undefined
}

export function ConfirmDestructiveAction({
  open,
  onOpenChange,
  titleKey,
  descriptionKey,
  confirmKey,
  cancelKey = 'dialog.cancel',
  onConfirm,
  values,
  className,
  contentTestId,
  cancelTestId,
  confirmTestId,
}: ConfirmDestructiveActionProps): React.ReactElement {
  const { t } = useTranslation()
  const [pending, setPending] = useState(false)

  const handleConfirmClick = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      // Radix `AlertDialogAction` auto-closes the dialog on click. We
      // need to keep it open while `onConfirm` is in flight so we can
      // honor the "stay open on rejection" contract — preventDefault on
      // the synthetic event is the documented Radix opt-out.
      event.preventDefault()
      if (pending) return
      setPending(true)
      try {
        await onConfirm()
        onOpenChange(false)
      } catch {
        // Caller's `onConfirm` is responsible for surfacing the error
        // (toast.error / inline banner). We swallow here to avoid an
        // unhandled-rejection log; staying open conveys failure to the
        // user without flickering the dialog closed-then-open.
      } finally {
        setPending(false)
      }
    },
    [onConfirm, onOpenChange, pending],
  )

  // exactOptionalPropertyTypes: i18next's t() overload set rejects an
  // explicit `undefined` for the second arg, so we only pass `values`
  // when the caller actually provided it. Otherwise call the single-arg
  // form (no interpolation needed for this title/description).
  const titleText = values ? t(titleKey, values) : t(titleKey)
  const descriptionText = values ? t(descriptionKey, values) : t(descriptionKey)

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={className} data-testid={contentTestId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{titleText}</AlertDialogTitle>
          <AlertDialogDescription>{descriptionText}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} data-testid={cancelTestId}>
            {t(cancelKey)}
          </AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: 'destructive' }))}
            onClick={handleConfirmClick}
            disabled={pending}
            data-testid={confirmTestId}
          >
            {t(confirmKey)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
