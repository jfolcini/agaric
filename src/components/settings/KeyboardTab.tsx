/**
 * KeyboardTab — keyboard shortcut customization panel.
 * Shows all shortcuts grouped by category with inline editing.
 */

import { Check, Pencil, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { KbdChord } from '@/components/ui/kbd'
import {
  findConflicts,
  getCurrentShortcuts,
  resetAllShortcuts,
  resetShortcut,
  type ShortcutBinding,
  setCustomShortcut,
} from '@/lib/keyboard-config'
// #723 — imported from the submodule (not the barrel) so the validator is
// the SAME tokenizer the matcher parses with; the two previously drifted
// (validator accepted `Ctrl+E`/`Cmd + K` formats the matcher saved dead).
import { type BindingValidationError, validateBindingInput } from '@/lib/keyboard-config/parse'

export function KeyboardTab(): React.ReactElement {
  const { t } = useTranslation()
  // Value itself is never read — `setVersion` only forces a re-render
  // after a localStorage-backed mutation (see the `shortcuts`/`conflicts`
  // comment below).
  const [, setVersion] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmResetAll, setConfirmResetAll] = useState(false)

  // #2709 — `getCurrentShortcuts()` reads from `localStorage`, a mutable
  // source outside React's reactive graph; `version` exists purely to force
  // a re-render after a save/reset (which otherwise touches no React
  // state). It was previously threaded through as a `useMemo` dependency
  // the callback never actually reads — under this project's React
  // Compiler, a memo whose callback doesn't read its listed dependency is
  // treated as having no reactive inputs and never recomputes, so the tab's
  // own display (kbd chips, "Customized" badge, conflict warnings, Reset
  // button) silently went stale after every edit within the same mount —
  // functionally the shortcut WAS saved and live (`matchesShortcutBinding`
  // reads `localStorage` directly, unmemoized), but the Settings UI itself
  // never reflected it without navigating away and back. Computing plainly
  // on every render removes the mismatch; this list is ~30 catalog entries,
  // not a hot path.
  const shortcuts = getCurrentShortcuts()

  const grouped = useMemo(() => {
    const map = new Map<string, (ShortcutBinding & { isCustom: boolean })[]>()
    for (const s of shortcuts) {
      const existing = map.get(s.category) ?? []
      existing.push(s)
      map.set(s.category, existing)
    }
    return map
  }, [shortcuts])

  // Same rationale as `shortcuts` above — computed plainly, not memoized.
  const conflicts = findConflicts()

  // Validate the in-progress edit value (only meaningful while editing).
  const validationError = useMemo<BindingValidationError | null>(() => {
    if (!editingId) return null
    return validateBindingInput(editValue)
  }, [editingId, editValue])
  // #3308 — `'empty'` has its own message below the list; the other two are
  // blocking errors rendered inline next to the input.
  const inlineError = validationError === 'modifierOnly' || validationError === 'unknownKey'

  const startEdit = useCallback((id: string, currentKeys: string) => {
    setEditingId(id)
    setEditValue(currentKeys)
  }, [])

  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setEditValue('')
  }, [])

  const saveEdit = useCallback(() => {
    if (!editingId) return
    const trimmed = editValue.trim()
    if (validateBindingInput(trimmed)) return
    setCustomShortcut(editingId, trimmed)
    setEditingId(null)
    setEditValue('')
    setVersion((v) => v + 1)
  }, [editingId, editValue])

  const handleReset = useCallback((id: string) => {
    resetShortcut(id)
    setVersion((v) => v + 1)
  }, [])

  const handleResetAll = useCallback(() => {
    resetAllShortcuts()
    setConfirmResetAll(false)
    setEditingId(null)
    setEditValue('')
    setVersion((v) => v + 1)
  }, [])

  const getConflictsForId = useCallback(
    (id: string) => {
      const matching = conflicts.filter((c) => c.ids.includes(id))
      if (matching.length === 0) return null
      const otherIds = new Set<string>()
      for (const c of matching) {
        for (const cid of c.ids) {
          if (cid !== id) otherIds.add(cid)
        }
      }
      const otherNames = [...otherIds].map((oid) => {
        const s = shortcuts.find((sc) => sc.id === oid)
        return s ? t(s.description) : oid
      })
      return otherNames
    },
    [conflicts, shortcuts, t],
  )

  return (
    <div className="space-y-6" data-testid="keyboard-settings-tab">
      <Card>
        <CardHeader>
          <CardDescription>{t('keyboard.settings.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            {[...grouped.entries()].map(([category, items]) => (
              <div key={category} className="mb-6">
                <h4 className="text-xs font-medium text-muted-foreground mb-2">{t(category)}</h4>
                <div className="space-y-1">
                  {items.map((shortcut) => {
                    const isEditing = editingId === shortcut.id
                    const conflictNames = getConflictsForId(shortcut.id)

                    return (
                      // Phones: the name takes the first line, keys and actions share the second.
                      <div
                        key={shortcut.id}
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 sm:flex-nowrap"
                      >
                        <div className="w-full text-sm sm:w-auto sm:min-w-0 sm:flex-1">
                          {t(shortcut.description)}
                          {shortcut.condition && (
                            <small className="text-xs text-muted-foreground ml-1">
                              ({t(shortcut.condition)})
                            </small>
                          )}
                        </div>

                        <div
                          className="min-w-0 flex-1 sm:w-56 sm:flex-none"
                          data-testid="kbd-keys-column"
                        >
                          {isEditing ? (
                            <>
                              <div className="flex items-center gap-1">
                                <Input
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  placeholder={t('keyboard.settings.typeNewBinding')}
                                  className="text-xs"
                                  // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional focus-on-open: inline binding editor is shown only while editing this shortcut, so focus moves to the binding input the moment edit mode opens
                                  autoFocus
                                  aria-invalid={validationError ? true : undefined}
                                  aria-describedby={
                                    validationError === 'empty'
                                      ? 'kbd-empty-binding-error'
                                      : inlineError
                                        ? `kbd-validation-error-${shortcut.id}`
                                        : undefined
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault()
                                      saveEdit()
                                    } else if (e.key === 'Escape') {
                                      e.preventDefault()
                                      cancelEdit()
                                    }
                                  }}
                                />
                                <IconButton
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={saveEdit}
                                  disabled={!editValue.trim() || inlineError}
                                  tooltip={t('keyboard.settings.saveButton')}
                                  ariaLabel={t('keyboard.settings.saveButton')}
                                >
                                  <Check />
                                </IconButton>
                                <IconButton
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={cancelEdit}
                                  tooltip={t('keyboard.settings.cancelButton')}
                                  ariaLabel={t('keyboard.settings.cancelButton')}
                                >
                                  <X />
                                </IconButton>
                              </div>
                              {inlineError && (
                                <p
                                  className="text-xs text-destructive mt-1"
                                  role="alert"
                                  id={`kbd-validation-error-${shortcut.id}`}
                                >
                                  {validationError === 'unknownKey'
                                    ? t('keyboard.settings.validationUnknownKey')
                                    : t('keyboard.settings.validationModifierOnly')}
                                </p>
                              )}
                              <p className="text-xs text-muted-foreground mt-1">
                                {t('keyboard.settings.formatHint')}
                              </p>
                            </>
                          ) : (
                            <span className="inline-flex flex-wrap items-center gap-1">
                              <KbdChord keys={shortcut.keys} size="sm" />
                              {shortcut.isCustom && (
                                <Badge tone="secondary" className="ml-1">
                                  {t('keyboard.settings.customized')}
                                </Badge>
                              )}
                            </span>
                          )}

                          {conflictNames && conflictNames.length > 0 && !isEditing && (
                            <div className="text-xs text-alert-warning-foreground mt-1">
                              {t('keyboard.settings.conflictWarning', {
                                shortcuts: conflictNames.join(', '),
                              })}
                            </div>
                          )}
                        </div>

                        {/* #724: documentation-only entries (rebindable: false)
                            get NO edit affordance; their triggers are hardcoded
                            at the consumption site and a saved override would
                            never be honoured. */}
                        <div className="flex shrink-0 items-center justify-end gap-1 sm:w-36">
                          {shortcut.isCustom && !isEditing && (
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => handleReset(shortcut.id)}
                              aria-label={t('keyboard.settings.resetShortcutFor', {
                                action: t(shortcut.description),
                              })}
                            >
                              {t('keyboard.settings.resetButton')}
                            </Button>
                          )}
                          {!isEditing && shortcut.rebindable !== false && (
                            <IconButton
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => startEdit(shortcut.id, shortcut.keys)}
                              tooltip={t('keyboard.settings.editShortcutFor', {
                                action: t(shortcut.description),
                              })}
                              ariaLabel={t('keyboard.settings.editShortcutFor', {
                                action: t(shortcut.description),
                              })}
                            >
                              <Pencil />
                            </IconButton>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Empty binding validation message */}
          {editingId && !editValue.trim() && (
            <p id="kbd-empty-binding-error" className="text-xs text-destructive">
              {t('keyboard.settings.emptyBinding')}
            </p>
          )}

          <div className="pt-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmResetAll(true)}>
              {t('keyboard.settings.resetAllButton')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmResetAll}
        onOpenChange={setConfirmResetAll}
        titleKey="keyboard.settings.resetAllTitle"
        descriptionKey="keyboard.settings.resetAllConfirm"
        confirmKey="keyboard.settings.resetAllButton"
        variant="destructive"
        onConfirm={handleResetAll}
      />
    </div>
  )
}
