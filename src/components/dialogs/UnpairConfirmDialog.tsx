/**
 * UnpairConfirmDialog — shared confirmation dialog for unpairing a device (#301).
 *
 * Used by both PairingDialog and DeviceManagement to avoid duplication.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'

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
  const { t } = useTranslation()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      titleKey="device.unpairConfirmTitle"
      descriptionKey="device.unpairConfirmDescription"
      cancelKey="action.cancel"
      confirmKey="device.unpairConfirmAction"
      values={{ deviceName: deviceName ?? t('device.pairedDevice') }}
      variant="destructive"
      onConfirm={onConfirm}
      className={className}
    />
  )
}
