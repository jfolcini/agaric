/**
 * UnpairConfirmDialog — shared confirmation dialog for unpairing a device (#301).
 *
 * Used by both PairingDialog and DeviceManagement to avoid duplication.
 */

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

interface UnpairConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  deviceName?: string | null
  className?: string
}

export function UnpairConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  deviceName,
  className,
}: UnpairConfirmDialogProps): React.ReactElement {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={className}>
        <AlertDialogHeader>
          <AlertDialogTitle>Unpair device?</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove {deviceName ? `"${deviceName}"` : 'the paired device'}. You will need
            to pair again to sync.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            Yes, unpair{deviceName ? ` ${deviceName}` : ''}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
