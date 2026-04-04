/**
 * ConfirmDialog — shared confirmation dialog wrapper around AlertDialog primitives.
 *
 * Replaces the repeated AlertDialog > Content > Header > Title + Description > Footer > Cancel + Action
 * pattern used across 8+ components.
 */

import { Loader2 } from 'lucide-react'
import type React from 'react'
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

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  cancelLabel?: string
  actionLabel?: string
  actionVariant?: 'default' | 'destructive'
  onAction: () => void
  loading?: boolean
  children?: React.ReactNode
  className?: string | undefined
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  cancelLabel = 'Cancel',
  actionLabel = 'Confirm',
  actionVariant = 'default',
  onAction,
  loading = false,
  children,
  className,
}: ConfirmDialogProps): React.ReactElement {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={className}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(
              actionVariant === 'destructive' && buttonVariants({ variant: 'destructive' }),
            )}
            onClick={onAction}
            disabled={loading}
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
