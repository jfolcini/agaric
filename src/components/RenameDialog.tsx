/**
 * RenameDialog — modal for renaming a paired device (#422).
 *
 * Replaces the old window.prompt() flow with a proper AlertDialog.
 */

import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Input } from '@/components/ui/input'

interface RenameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (name: string) => void
  currentName: string
  className?: string
}

export function RenameDialog({
  open,
  onOpenChange,
  onConfirm,
  currentName,
  className,
}: RenameDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const [name, setName] = useState(currentName)

  // Reset when dialog opens with new name
  useEffect(() => {
    if (open) setName(currentName)
  }, [open, currentName])

  const handleSave = () => {
    onConfirm(name.trim())
    onOpenChange(false)
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Rename device"
      description="Enter a name for this device."
      cancelLabel="Cancel"
      actionLabel="Save"
      onAction={handleSave}
      className={className}
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSave()
        }}
        placeholder="Device name"
        aria-label={t('device.deviceNameLabel')}
        autoFocus
      />
    </ConfirmDialog>
  )
}
