/**
 * ConfirmDialog — shared confirmation dialog wrapper around AlertDialog primitives.
 *
 * Replaces the repeated AlertDialog > Content > Header > Title + Description > Footer > Cancel + Action
 * pattern used across 8+ components.
 *
 * UX-259: when actionVariant === 'destructive', initial focus lands on the Cancel
 * button (not the Action button) so that a reflex Enter keypress dismisses the
 * dialog instead of confirming the destructive action. Non-destructive callers
 * retain action-button focus (existing behavior).
 *
 * The 500 ms "arming" grace period that was originally proposed for destructive
 * dialogs was intentionally NOT implemented — the focus-flip alone closes
 * UX-259 (reflex Enter no longer fires destructive actions because focus starts
 * on Cancel), and the additional aria-disabled gate created brittle interaction
 * timing for every existing destructive-dialog test in the suite.
 *
 * PEND-23 H3: on phones < 768 px (`useIsMobile() === true`) the dialog renders
 * as a bottom Sheet so action buttons sit within thumb reach. Both paths share
 * the same controlled `open` / `onOpenChange` API and the same a11y semantics
 * (Radix Dialog + AlertDialog both trap focus and dismiss on Escape).
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertDialogAction, AlertDialogCancel } from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useDialogOrSheet } from '@/hooks/useDialogOrSheet'
import { cn } from '@/lib/utils'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: React.ReactNode
  cancelLabel?: string
  actionLabel?: string
  actionVariant?: 'default' | 'destructive'
  onAction: () => void
  loading?: boolean
  children?: React.ReactNode
  className?: string | undefined
  /** Optional data-testid for the AlertDialogContent / SheetContent root. */
  contentTestId?: string | undefined
  /** Optional data-testid for the Cancel button. */
  cancelTestId?: string | undefined
  /** Optional data-testid for the Action (confirm) button. */
  actionTestId?: string | undefined
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  cancelLabel,
  actionLabel,
  actionVariant = 'default',
  onAction,
  loading = false,
  children,
  className,
  contentTestId,
  cancelTestId,
  actionTestId,
}: ConfirmDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const resolvedCancelLabel = cancelLabel ?? t('dialog.cancel')
  const resolvedActionLabel = actionLabel ?? t('dialog.confirm')
  const isDestructive = actionVariant === 'destructive'

  const parts = useDialogOrSheet()
  const { Root, Content, Header, Title, Footer } = parts

  // Sheet has no AlertDialogAction/AlertDialogCancel equivalents that auto-close
  // the overlay on click — replicate that behaviour by closing via onOpenChange.
  const handleMobileAction = () => {
    onAction()
    onOpenChange(false)
  }
  const handleMobileCancel = () => {
    onOpenChange(false)
  }

  // Sheet's Content takes a `side` prop; AlertDialogContent does not.
  const contentSideProps = parts.isMobile ? ({ side: 'bottom' } as const) : {}

  return (
    <Root open={open} onOpenChange={onOpenChange}>
      <Content className={className} data-testid={contentTestId} {...contentSideProps}>
        <Header>
          <Title>{title}</Title>
          {/* Description renders inline as a sibling so we keep markup parity
              between AlertDialogDescription (semantic alert text) and Sheet,
              where Radix Dialog's Description serves the same a11y role. */}
          <parts.Description>{description}</parts.Description>
        </Header>
        {children}
        <Footer>
          {parts.isMobile ? (
            <>
              <Button
                variant="outline"
                disabled={loading}
                onClick={handleMobileCancel}
                // UX-259: destructive dialogs auto-focus Cancel.
                autoFocus={isDestructive}
                data-testid={cancelTestId}
              >
                {resolvedCancelLabel}
              </Button>
              <Button
                variant={isDestructive ? 'destructive' : 'default'}
                disabled={loading}
                onClick={handleMobileAction}
                // UX-259: only auto-focus Action for non-destructive variants.
                autoFocus={!isDestructive}
                data-testid={actionTestId}
              >
                {loading && <Spinner />}
                {resolvedActionLabel}
              </Button>
            </>
          ) : (
            <>
              <AlertDialogCancel
                disabled={loading}
                // UX-259: destructive dialogs auto-focus Cancel so reflex Enter dismisses.
                autoFocus={isDestructive}
                data-testid={cancelTestId}
              >
                {resolvedCancelLabel}
              </AlertDialogCancel>
              <AlertDialogAction
                className={cn(isDestructive && buttonVariants({ variant: 'destructive' }))}
                onClick={onAction}
                disabled={loading}
                // UX-259: only auto-focus Action for non-destructive variants.
                autoFocus={!isDestructive}
                data-testid={actionTestId}
              >
                {loading && <Spinner />}
                {resolvedActionLabel}
              </AlertDialogAction>
            </>
          )}
        </Footer>
      </Content>
    </Root>
  )
}
