/**
 * UnpairConfirmDialog — shared confirmation dialog for unpairing a device (#301).
 *
 * Used by both PairingDialog and DeviceManagement to avoid duplication.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('device.unpairConfirmTitle')}
      description={t('device.unpairConfirmDescription', {
        deviceName: deviceName ?? t('device.pairedDevice'),
      })}
      cancelLabel={t('action.cancel')}
      actionLabel={t('device.unpairConfirmAction')}
      actionVariant="destructive"
      onAction={onConfirm}
      className={className}
    />
  )
}
