/**
 * RenameDialog — reusable modal for renaming an entity.
 *
 * Uses Dialog (not AlertDialog) because the modal contains a form input.
 * Originally built for device renaming (#422), now generic via optional
 * title / description / placeholder / ariaLabel props.
 *
 * UX-263: Validates the entered name before invoking onConfirm.
 *  - Strips ASCII control characters (U+0000–U+001F, U+007F).
 *  - Trims leading/trailing whitespace.
 *  - Disallows empty names.
 *  - Caps length at MAX_RENAME_LENGTH (64) characters.
 * Errors are shown inline via aria-invalid + a text-destructive message.
 */

import type React from 'react'
import { useEffect, useId, useState } from 'react'
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

export const MAX_RENAME_LENGTH = 64

// Strip ASCII control chars (\u0000-\u001F, \u007F). Keeps printable text intact.
// biome-ignore lint/suspicious/noControlCharactersInRegex: validation strips control chars by design
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g

export function sanitizeRenameInput(raw: string): string {
  return raw.replace(CONTROL_CHARS, '').trim()
}

export type RenameValidationError = 'empty' | 'tooLong' | null

export function validateRenameInput(raw: string): RenameValidationError {
  const cleaned = sanitizeRenameInput(raw)
  if (cleaned.length === 0) return 'empty'
  if (cleaned.length > MAX_RENAME_LENGTH) return 'tooLong'
  return null
}

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
  const [touched, setTouched] = useState(false)
  const errorId = useId()

  // Reset when dialog opens with new name
  useEffect(() => {
    if (open) {
      setName(currentName)
      setTouched(false)
    }
  }, [open, currentName])

  const validationError = validateRenameInput(name)
  // Show inline error after the user has interacted with the input or
  // attempted to submit (avoids flagging the empty initial state).
  const showError = touched && validationError !== null
  const errorMessage =
    validationError === 'empty'
      ? t('rename.errorEmpty')
      : validationError === 'tooLong'
        ? t('rename.errorTooLong', { max: MAX_RENAME_LENGTH })
        : null

  const handleSave = () => {
    if (validationError !== null) {
      setTouched(true)
      return
    }
    // Sanitize once more on submit so trailing whitespace / control chars
    // never leak into the persisted name.
    onConfirm(sanitizeRenameInput(name))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={className}>
        <DialogHeader>
          <DialogTitle>{title ?? t('rename.title')}</DialogTitle>
          <DialogDescription>{description ?? t('rename.deviceName')}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSave()
          }}
        >
          <Input
            value={name}
            onChange={(e) => {
              // Strip control chars eagerly so paste of binary noise can't
              // even appear in the field. Trimming is deferred until submit
              // so users can still type spaces between words.
              setName(e.target.value.replace(CONTROL_CHARS, ''))
              if (!touched) setTouched(true)
            }}
            onBlur={() => setTouched(true)}
            placeholder={placeholder ?? t('rename.placeholder')}
            aria-label={ariaLabel ?? t('device.deviceNameLabel')}
            aria-invalid={showError ? true : undefined}
            aria-describedby={showError ? errorId : undefined}
            maxLength={MAX_RENAME_LENGTH * 2}
            autoFocus
          />
          {showError && errorMessage ? (
            <p id={errorId} className="rename-error mt-1 text-xs text-destructive" role="alert">
              {errorMessage}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('rename.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={validationError !== null}>
            {t('rename.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
