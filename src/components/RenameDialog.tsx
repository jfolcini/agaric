/**
 * RenameDialog — reusable modal for renaming an entity.
 *
 * Uses Dialog (not AlertDialog) because the modal contains a form input.
 * Originally built for device renaming (#422), now generic via optional
 * title / description / placeholder / ariaLabel props.
 */

import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface RenameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (name: string) => void
  currentName: string
  title?: string
  description?: string
  placeholder?: string
  ariaLabel?: string
  className?: string
}

export function RenameDialog({
  open,
  onOpenChange,
  onConfirm,
  currentName,
  title,
  description,
  placeholder,
  ariaLabel,
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={className}>
        <DialogHeader>
          <DialogTitle>{title ?? 'Rename device'}</DialogTitle>
          <DialogDescription>{description ?? 'Enter a name for this device.'}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSave()
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={placeholder ?? 'Device name'}
            aria-label={ariaLabel ?? t('device.deviceNameLabel')}
            autoFocus
          />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
