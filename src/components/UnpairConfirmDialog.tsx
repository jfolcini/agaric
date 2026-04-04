/**
 * UnpairConfirmDialog — shared confirmation dialog for unpairing a device (#301).
 *
 * Used by both PairingDialog and DeviceManagement to avoid duplication.
 */

import type React from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'

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
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Unpair device?"
      description={`This will remove ${deviceName ? `"${deviceName}"` : 'the paired device'}. You will need to pair again to sync.`}
      cancelLabel="Cancel"
      actionLabel={`Yes, unpair${deviceName ? ` ${deviceName}` : ''}`}
      onAction={onConfirm}
      className={className}
    />
  )
}
