/**
 * KeyboardSettingsTab — keyboard shortcut customization panel (UX-86).
 * Shows all shortcuts grouped by category with inline editing.
 */

import { Check, Pencil, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  findConflicts,
  getCurrentShortcuts,
  resetAllShortcuts,
  resetShortcut,
  type ShortcutBinding,
  setCustomShortcut,
} from '@/lib/keyboard-config'
import { renderKeys } from '@/lib/render-keyboard-shortcut'

import { ConfirmDialog } from './ConfirmDialog'

/**
 * UX-391 — Lightweight syntactic validation for custom shortcut bindings.
 * Rejects empty input and modifier-only patterns (e.g. `Ctrl + Shift`).
 * Accepted format: optional modifiers (Ctrl/Cmd/Meta/Alt/Option/Shift)
 * separated by `+` or `-` or whitespace, followed by at least one
 * non-modifier key token.
 */
const MODIFIER_TOKENS = new Set([
  'Ctrl',
  'Control',
  'Cmd',
  'Command',
  'Meta',
  'Alt',
  'Option',
  'Shift',
  'Mod',
])

function validateShortcutBinding(input: string): 'empty' | 'modifierOnly' | null {
  const trimmed = input.trim()
  if (!trimmed) return 'empty'
  // Tokenize on `+`, `-`, or runs of whitespace (handles "Ctrl+E", "Ctrl-E", "Ctrl + E", "Ctrl Shift E")
  const tokens = trimmed.split(/[+\-\s]+/).filter(Boolean)
  if (tokens.length === 0) return 'empty'
  const nonModifiers = tokens.filter((t) => !MODIFIER_TOKENS.has(t))
  if (nonModifiers.length === 0) return 'modifierOnly'
  return null
}

export function KeyboardSettingsTab(): React.ReactElement {
  const { t } = useTranslation()
  const [version, setVersion] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmResetAll, setConfirmResetAll] = useState(false)

  // oxlint-disable-next-line react-hooks/exhaustive-deps -- version counter triggers re-read from localStorage
  const shortcuts = useMemo(() => getCurrentShortcuts(), [version])

  const grouped = useMemo(() => {
    const map = new Map<string, (ShortcutBinding & { isCustom: boolean })[]>()
    for (const s of shortcuts) {
      const existing = map.get(s.category) ?? []
      existing.push(s)
      map.set(s.category, existing)
    }
    return map
  }, [shortcuts])

  // oxlint-disable-next-line react-hooks/exhaustive-deps -- version counter triggers re-read from localStorage
  const conflicts = useMemo(() => findConflicts(), [version])

  // UX-391 — validate the in-progress edit value (only meaningful while editing).
  const validationError = useMemo<'empty' | 'modifierOnly' | null>(() => {
    if (!editingId) return null
    return validateShortcutBinding(editValue)
  }, [editingId, editValue])

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
    if (!trimmed) return
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
    <div className="space-y-4" data-testid="keyboard-settings-tab">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('keyboard.settings.title')}</CardTitle>
          <CardDescription>{t('keyboard.settings.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ScrollArea className="max-h-[60dvh]">
            {[...grouped.entries()].map(([category, items]) => (
              <div key={category} className="mb-6">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  {t(category)}
                </h4>
                <div className="space-y-1">
                  {items.map((shortcut) => {
                    const isEditing = editingId === shortcut.id
                    const conflictNames = getConflictsForId(shortcut.id)

                    return (
                      <div
                        key={shortcut.id}
                        className="flex flex-col sm:flex-row sm:items-center gap-2 py-2 px-2 rounded hover:bg-accent/50"
                      >
                        {/* Keys column */}
                        <div className="w-full sm:w-56 sm:shrink-0" data-testid="kbd-keys-column">
                          {isEditing ? (
                            <>
                              <div className="flex items-center gap-1">
                                <Input
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  placeholder={t('keyboard.settings.typeNewBinding')}
                                  className="text-xs"
                                  autoFocus
                                  aria-invalid={validationError ? true : undefined}
                                  aria-describedby={
                                    validationError === 'empty'
                                      ? 'kbd-empty-binding-error'
                                      : validationError === 'modifierOnly'
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
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={saveEdit}
                                  disabled={!editValue.trim() || validationError === 'modifierOnly'}
                                  aria-label={t('keyboard.settings.saveButton')}
                                >
                                  <Check className="h-3 w-3" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={cancelEdit}
                                  aria-label={t('keyboard.settings.cancelButton')}
                                >
                                  <X className="h-3 w-3" />
                                </Button>
                              </div>
                              {validationError === 'modifierOnly' && (
                                <p
                                  className="text-xs text-destructive mt-1"
                                  role="alert"
                                  id={`kbd-validation-error-${shortcut.id}`}
                                >
                                  {t('keyboard.settings.validationModifierOnly')}
                                </p>
                              )}
                              <p className="text-xs text-muted-foreground mt-1">
                                {t('keyboard.settings.formatHint')}
                              </p>
                            </>
                          ) : (
                            <span className="inline-flex flex-wrap items-center gap-1">
                              {renderKeys(shortcut.keys)}
                              {shortcut.isCustom && (
                                <Badge tone="secondary" className="ml-1">
                                  {t('keyboard.settings.customized')}
                                </Badge>
                              )}
                            </span>
                          )}

                          {/* Conflict warning (UX-386/UX-392): inline inside the keys column */}
                          {conflictNames && conflictNames.length > 0 && !isEditing && (
                            <div className="text-xs text-alert-warning-foreground mt-1">
                              {t('keyboard.settings.conflictWarning', {
                                shortcuts: conflictNames.join(', '),
                              })}
                            </div>
                          )}
                        </div>

                        {/* Description column */}
                        <div className="w-full sm:flex-1 text-sm text-muted-foreground">
                          {t(shortcut.description)}
                          {shortcut.condition && (
                            <small className="text-xs text-muted-foreground ml-1">
                              ({t(shortcut.condition)})
                            </small>
                          )}
                        </div>

                        {/* Actions column */}
                        <div className="flex items-center gap-1 shrink-0">
                          {!isEditing && (
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => startEdit(shortcut.id, shortcut.keys)}
                              aria-label={t('keyboard.settings.editShortcutFor', {
                                action: t(shortcut.description),
                              })}
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                          )}
                          {shortcut.isCustom && !isEditing && (
                            <button
                              type="button"
                              className="text-xs text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:underline rounded-sm [@media(pointer:coarse)]:min-h-[44px]"
                              onClick={() => handleReset(shortcut.id)}
                              aria-label={t('keyboard.settings.resetShortcutFor', {
                                action: t(shortcut.description),
                              })}
                            >
                              {t('keyboard.settings.resetButton')}
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </ScrollArea>

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
        title={t('keyboard.settings.resetAllTitle')}
        description={t('keyboard.settings.resetAllConfirm')}
        actionLabel={t('keyboard.settings.resetAllButton')}
        variant="destructive"
        onConfirm={handleResetAll}
      />
    </div>
  )
}
