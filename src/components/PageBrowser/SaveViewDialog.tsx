/**
 * SaveViewDialog — name-entry modal for saving the Pages view's current
 * `{ sort, density, filters }` tuple as a named saved view (#2003 piece 1).
 *
 * Deliberately simpler than `RenameDialog`: desktop-only (no
 * `useDialogOrSheet` mobile Sheet variant — the Pages view saved-views
 * feature is a power-user desktop affordance, matching the rest of
 * `PageBrowserHeader`'s sort/density controls, which have no mobile Sheet
 * fallback either). Validates only non-empty + a length cap; uniqueness is
 * NOT enforced — saving two views with the same name is allowed (they get
 * distinct ids), same as most "save as" flows.
 */

import type React from 'react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export const MAX_SAVED_VIEW_NAME_LENGTH = 64

/** Lowest ASCII control-char code point (NUL). */
const ASCII_CONTROL_LOW_MAX = 31
/** DEL code point — the one control char above the printable ASCII range. */
const ASCII_DEL = 127

/**
 * Strip ASCII control characters (code points 0-31 and DEL/127) by
 * iterating code points rather than a regex character class — a literal
 * control-char escape sequence in a regex is fragile across this file's
 * write/read pipeline (control bytes can get transcoded), so this stays
 * byte-code-driven and easy to reason about instead.
 */
function stripControlChars(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= ASCII_CONTROL_LOW_MAX || code === ASCII_DEL) continue
    out += ch
  }
  return out
}

export function sanitizeSavedViewName(raw: string): string {
  return stripControlChars(raw).trim()
}

export type SaveViewNameError = 'empty' | 'tooLong' | null

export function validateSavedViewName(raw: string): SaveViewNameError {
  const cleaned = sanitizeSavedViewName(raw)
  if (cleaned.length === 0) return 'empty'
  if (cleaned.length > MAX_SAVED_VIEW_NAME_LENGTH) return 'tooLong'
  return null
}

export interface SaveViewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fires with the sanitized name once validated. Caller is responsible for closing (matches RenameDialog's contract). */
  onConfirm: (name: string) => void
}

export function SaveViewDialog({
  open,
  onOpenChange,
  onConfirm,
}: SaveViewDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const errorId = useId()
  const inputId = useId()

  // Reset on every open so a previous attempt's text doesn't linger.
  useEffect(() => {
    if (open) {
      setName('')
      setTouched(false)
    }
  }, [open])

  const validationError = validateSavedViewName(name)
  const showError = touched && validationError !== null
  const errorMessage =
    validationError === 'empty'
      ? t('pageBrowser.savedViews.nameEmpty')
      : validationError === 'tooLong'
        ? t('pageBrowser.savedViews.nameTooLong', { max: MAX_SAVED_VIEW_NAME_LENGTH })
        : null

  const handleSave = () => {
    if (validationError !== null) {
      setTouched(true)
      return
    }
    onConfirm(sanitizeSavedViewName(name))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="save-view-dialog">
        <DialogHeader>
          <DialogTitle>{t('pageBrowser.savedViews.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('pageBrowser.savedViews.dialogDescription')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              handleSave()
            }}
          >
            <Label htmlFor={inputId} className="sr-only">
              {t('pageBrowser.savedViews.nameLabel')}
            </Label>
            <Input
              id={inputId}
              value={name}
              onChange={(e) => {
                setName(stripControlChars(e.target.value))
                if (!touched) setTouched(true)
              }}
              onBlur={() => setTouched(true)}
              placeholder={t('pageBrowser.savedViews.namePlaceholder')}
              aria-invalid={showError ? true : undefined}
              aria-describedby={showError ? errorId : undefined}
              maxLength={MAX_SAVED_VIEW_NAME_LENGTH * 2}
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- dialog opens on demand; focus the name input immediately
              autoFocus
            />
            {showError && errorMessage ? (
              <p id={errorId} className="mt-1 text-xs text-destructive" role="alert">
                {errorMessage}
              </p>
            ) : null}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('pageBrowser.savedViews.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={validationError !== null}>
            {t('pageBrowser.savedViews.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
