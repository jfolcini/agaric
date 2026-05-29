/**
 * ConfirmDialog — unified confirmation dialog wrapper around AlertDialog primitives.
 *
 * Merged in PEND UX-review-2026-05-09 item 11: previously two
 * non-overlapping cousins (`ConfirmDialog` + `ConfirmDestructiveAction`)
 * lived side-by-side, and one screen (`GoogleCalendarSettingsTab`)
 * escaped both with raw `AlertDialog` primitives + a dual-`AlertDialogAction`
 * footer. This file is now the single API:
 *
 *  - i18n-first: pass `titleKey` / `descriptionKey` / `confirmKey` /
 *    optional `cancelKey` (and optional `values` for interpolation).
 *  - Legacy fallback: pre-resolved `title` / `description` / `actionLabel`
 *    / `cancelLabel` still work (explicit string overrides the key when
 *    both are set).
 *  - Async-aware: `onConfirm` may return
 *    `Promise<void>`. The dialog disables both buttons + shows a spinner
 *    on the confirm button while pending, closes via `onOpenChange(false)`
 *    on resolve, and stays open on rejection so the caller's toast / log
 *    path runs without a closed-then-reopen flicker. The wrapper swallows
 *    the rejection internally to avoid an unhandled-rejection log; the
 *    caller is responsible for surfacing the error (toast.error / inline
 *    banner).
 *  - Multi-action escape hatch: `secondaryAction` injects a third button
 *    between Cancel and Confirm — used by the Google Calendar disconnect
 *    flow (Delete-Calendar vs Keep-Calendar vs Cancel).
 *
 * UX-259: when `variant === 'destructive'`, initial focus lands on the
 * Cancel button (not the Action button) so that a reflex Enter keypress
 * dismisses the dialog instead of confirming the destructive action.
 * Non-destructive callers retain action-button focus.
 *
 * The 500 ms "arming" grace period that was originally proposed for
 * destructive dialogs was intentionally NOT implemented — the focus-flip
 * alone closes UX-259 (reflex Enter no longer fires destructive actions
 * because focus starts on Cancel), and the additional aria-disabled gate
 * created brittle interaction timing for every existing destructive-
 * dialog test in the suite.
 *
 * PEND-23 H3: on phones < 768 px (`useIsMobile() === true`) the dialog
 * renders as a bottom Sheet so action buttons sit within thumb reach.
 * Both paths share the same controlled `open` / `onOpenChange` API and
 * the same a11y semantics (Radix Dialog + AlertDialog both trap focus
 * and dismiss on Escape).
 */

import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AlertDialogAction, AlertDialogBody, AlertDialogCancel } from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useDialogOrSheet } from '@/hooks/useDialogOrSheet'
import { cn } from '@/lib/utils'

type ConfirmHandler = () => Promise<void> | void

/**
 * Stable no-op fallback for an absent `onConfirm`. Module-level so its
 * identity never changes — this keeps `effectiveOnConfirm` (and the
 * `handleConfirmClick` callback that depends on it) referentially stable
 * across renders when no handler is supplied, instead of allocating a fresh
 * `() => {}` every render.
 */
const NOOP_CONFIRM: ConfirmHandler = () => {}

export interface ConfirmDialogSecondaryAction {
  /** i18n key for the secondary button label (resolved via `t()`). */
  labelKey?: string
  /** Pre-resolved label — overrides `labelKey` when both are set. */
  label?: string
  /** Click handler (sync or async). Promise rejections keep the dialog open. */
  onConfirm: ConfirmHandler
  /** Button visual variant; defaults to `'default'` (neutral). */
  variant?: 'default' | 'destructive' | 'outline'
  /** Optional data-testid for the secondary button. */
  testId?: string | undefined
}

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void

  // ─── i18n-first API (preferred) ────────────────────────────────────────
  /** i18n key for the dialog title. */
  titleKey?: string
  /** i18n key for the dialog body / description. */
  descriptionKey?: string
  /** i18n key for the confirm button label. Defaults to `'dialog.confirm'`. */
  confirmKey?: string
  /** i18n key for the cancel button label. Defaults to `'dialog.cancel'`. */
  cancelKey?: string
  /** Values for i18n interpolation (passed to `t()`). */
  values?: Record<string, string | number>

  // ─── Pre-resolved strings (legacy fallback) ────────────────────────────
  /** Pre-resolved title — overrides `titleKey` when both are set. */
  title?: string
  /** Pre-resolved description — overrides `descriptionKey` when both are set. */
  description?: React.ReactNode
  /** Pre-resolved confirm label — overrides `confirmKey` when both are set. */
  actionLabel?: string
  /** Pre-resolved cancel label — overrides `cancelKey` when both are set. */
  cancelLabel?: string

  // ─── Visual + behavior ────────────────────────────────────────────────
  /** Styles the confirm button. `'destructive'` also flips initial focus to Cancel (UX-259). */
  variant?: 'default' | 'destructive'

  /**
   * Async-aware confirm handler. Promise rejections keep the dialog open;
   * resolves close it via `onOpenChange(false)`. Sync (void) handlers
   * close the dialog immediately after invocation.
   */
  onConfirm?: ConfirmHandler

  /** Optional explicit cancel hook fired before the dialog closes. */
  onCancel?: () => void

  /**
   * Externally controlled loading state. When `true`, both buttons are
   * disabled and the confirm button shows a spinner. Kept for callers
   * that drive the spinner from outside the dialog (e.g. parent state).
   * Internal pending state from an async `onConfirm` ORs with this flag.
   */
  loading?: boolean

  /** Optional third button rendered between Cancel and Confirm. */
  secondaryAction?: ConfirmDialogSecondaryAction

  children?: React.ReactNode
  className?: string | undefined
  /** Optional data-testid for the AlertDialogContent / SheetContent root. */
  contentTestId?: string | undefined
  /** Optional data-testid for the Cancel button. */
  cancelTestId?: string | undefined
  /** Optional data-testid for the Action (confirm) button. */
  actionTestId?: string | undefined
}

// oxlint-disable-next-line eslint/complexity -- complexity 27 vs max 25. The merge unifies two APIs (i18n keys + pre-resolved strings) + sync/async onConfirm + mobile Sheet + optional secondaryAction; splitting would scatter the dual-path logic.
export function ConfirmDialog({
  open,
  onOpenChange,
  titleKey,
  descriptionKey,
  confirmKey,
  cancelKey,
  values,
  title,
  description,
  actionLabel,
  cancelLabel,
  variant,
  onConfirm,
  onCancel,
  loading = false,
  secondaryAction,
  children,
  className,
  contentTestId,
  cancelTestId,
  actionTestId,
}: ConfirmDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const [pending, setPending] = useState(false)

  // exactOptionalPropertyTypes: i18next's t() overload set rejects an
  // explicit `undefined` for the second arg, so we only pass `values`
  // when the caller actually provided it.
  const tk = useCallback((key: string): string => (values ? t(key, values) : t(key)), [t, values])

  // ─── Resolve labels (explicit string > i18n key > default) ────────────
  const resolvedTitle = title ?? (titleKey ? tk(titleKey) : '')
  const resolvedDescription = description ?? (descriptionKey ? tk(descriptionKey) : '')
  const resolvedCancelLabel = cancelLabel ?? (cancelKey ? t(cancelKey) : t('dialog.cancel'))
  const resolvedActionLabel = actionLabel ?? (confirmKey ? t(confirmKey) : t('dialog.confirm'))

  // ─── Resolve variant + handler ────────────────────────────────────────
  const effectiveVariant = variant ?? 'default'
  const isDestructive = effectiveVariant === 'destructive'
  const effectiveOnConfirm: ConfirmHandler = onConfirm ?? NOOP_CONFIRM

  const isPending = pending || loading

  // Runs the confirm handler. If it returns a Promise we await it, show
  // the spinner, and only close on resolve (rejections keep the dialog
  // open so the caller's toast path runs). Sync handlers close
  // immediately to preserve the original ConfirmDialog behaviour.
  const runConfirm = useCallback(
    async (handler: ConfirmHandler) => {
      if (pending) return
      let result: Promise<void> | void
      try {
        result = handler()
      } catch {
        // Sync throw — treat like a rejected promise: stay open, swallow
        // the error (caller surfaces it via toast / inline banner).
        return
      }
      if (result instanceof Promise) {
        setPending(true)
        try {
          await result
          onOpenChange(false)
        } catch {
          // Stay open on rejection; caller surfaces the error.
        } finally {
          setPending(false)
        }
        return
      }
      // Sync handler — caller may have already toggled `open` via
      // onOpenChange (e.g. legacy ConfirmDialog callers always close
      // externally). Closing here too is idempotent.
      onOpenChange(false)
    },
    [onOpenChange, pending],
  )

  const handleCancel = useCallback(() => {
    if (isPending) return
    onCancel?.()
    onOpenChange(false)
  }, [isPending, onCancel, onOpenChange])

  const handleConfirmClick = useCallback(
    async (event?: React.MouseEvent<HTMLButtonElement>) => {
      // Radix `AlertDialogAction` auto-closes the dialog on click. We
      // need to keep it open while an async `onConfirm` is in flight so
      // we can honor the "stay open on rejection" contract — preventDefault
      // on the synthetic event is the documented Radix opt-out. We always
      // call it (sync or async) and let `runConfirm` close via
      // `onOpenChange(false)` so behavior is uniform.
      event?.preventDefault()
      await runConfirm(effectiveOnConfirm)
    },
    [effectiveOnConfirm, runConfirm],
  )

  const handleSecondaryClick = useCallback(
    async (event?: React.MouseEvent<HTMLButtonElement>) => {
      if (!secondaryAction) return
      event?.preventDefault()
      await runConfirm(secondaryAction.onConfirm)
    },
    [secondaryAction, runConfirm],
  )

  const parts = useDialogOrSheet()
  const { Root, Content, Header, Title, Footer } = parts

  // Sheet's Content takes a `side` prop; AlertDialogContent does not.
  const contentSideProps = parts.isMobile ? ({ side: 'bottom' } as const) : {}

  const secondaryLabel = secondaryAction
    ? (secondaryAction.label ?? (secondaryAction.labelKey ? t(secondaryAction.labelKey) : ''))
    : ''
  const secondaryVariant = secondaryAction?.variant ?? 'default'

  return (
    <Root open={open} onOpenChange={onOpenChange}>
      <Content className={className} data-testid={contentTestId} {...contentSideProps}>
        <Header>
          <Title>{resolvedTitle}</Title>
          {/* Description renders inline as a sibling so we keep markup parity
              between AlertDialogDescription (semantic alert text) and Sheet,
              where Radix Dialog's Description serves the same a11y role. */}
          <parts.Description>{resolvedDescription}</parts.Description>
        </Header>
        {/*
          PEND dialog-responsiveness-primitive-2026-05-13: when the caller
          supplies extra body content beyond the title+description, route it
          through AlertDialogBody on desktop so a tall body scrolls and the
          footer stays visible. The mobile Sheet path keeps its native flow
          since a sibling Sheet primitive (SheetBody) is being introduced
          separately. AlertDialogs with no children (the common confirm-
          dialog shape) remain unchanged.
        */}
        {children != null &&
          (parts.isMobile ? children : <AlertDialogBody>{children}</AlertDialogBody>)}
        <Footer>
          {parts.isMobile ? (
            <>
              <Button
                variant="outline"
                disabled={isPending}
                onClick={handleCancel}
                // UX-259: destructive dialogs auto-focus Cancel.
                autoFocus={isDestructive}
                data-testid={cancelTestId}
              >
                {resolvedCancelLabel}
              </Button>
              {secondaryAction && (
                <Button
                  variant={secondaryVariant}
                  disabled={isPending}
                  onClick={handleSecondaryClick}
                  data-testid={secondaryAction.testId}
                >
                  {secondaryLabel}
                </Button>
              )}
              <Button
                variant={isDestructive ? 'destructive' : 'default'}
                disabled={isPending}
                onClick={handleConfirmClick}
                // UX-259: only auto-focus Action for non-destructive variants.
                autoFocus={!isDestructive}
                data-testid={actionTestId}
              >
                {isPending && <Spinner />}
                {resolvedActionLabel}
              </Button>
            </>
          ) : (
            <>
              <AlertDialogCancel
                disabled={isPending}
                onClick={onCancel}
                // UX-259: destructive dialogs auto-focus Cancel so reflex Enter dismisses.
                autoFocus={isDestructive}
                data-testid={cancelTestId}
              >
                {resolvedCancelLabel}
              </AlertDialogCancel>
              {secondaryAction && (
                <AlertDialogAction
                  className={cn(buttonVariants({ variant: secondaryVariant }))}
                  onClick={handleSecondaryClick}
                  disabled={isPending}
                  data-testid={secondaryAction.testId}
                >
                  {secondaryLabel}
                </AlertDialogAction>
              )}
              <AlertDialogAction
                className={cn(isDestructive && buttonVariants({ variant: 'destructive' }))}
                onClick={handleConfirmClick}
                disabled={isPending}
                // UX-259: only auto-focus Action for non-destructive variants.
                autoFocus={!isDestructive}
                data-testid={actionTestId}
              >
                {isPending && <Spinner />}
                {resolvedActionLabel}
              </AlertDialogAction>
            </>
          )}
        </Footer>
      </Content>
    </Root>
  )
}
