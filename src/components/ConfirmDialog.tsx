/**
 * ConfirmDialog — shared confirmation dialog wrapper around AlertDialog primitives.
 *
 * Replaces the repeated AlertDialog > Content > Header > Title + Description > Footer > Cancel + Action
 * pattern used across 8+ components.
 */

import type React from 'react'
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
import { Spinner } from '@/components/ui/spinner'
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
  /** Optional data-testid for the AlertDialogContent root. */
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
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={className} data-testid={contentTestId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading} data-testid={cancelTestId}>
            {resolvedCancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            className={cn(
              actionVariant === 'destructive' && buttonVariants({ variant: 'destructive' }),
            )}
            onClick={onAction}
            disabled={loading}
            autoFocus
            data-testid={actionTestId}
          >
            {loading && <Spinner />}
            {resolvedActionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
