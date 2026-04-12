/**
 * KeyboardSettingsTab — keyboard shortcut customization panel (UX-86).
 * Shows all shortcuts grouped by category with inline editing.
 */

import { Check, Pencil, X } from 'lucide-react'
import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
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
import { ConfirmDialog } from './ConfirmDialog'

/** Render a keys string as styled <kbd> elements. Handles `+` combos and `/` alternatives. */
function renderKeys(keys: string): React.ReactNode {
  const alternatives = keys.split(' / ')
  return alternatives.map((alt, i) => {
    const parts = alt.split(' + ')
    return (
      <React.Fragment key={alt}>
        {i > 0 && <span className="text-muted-foreground font-normal mx-1">/</span>}
        {parts.map((part, j) => (
          <React.Fragment key={part}>
            {j > 0 && <span className="text-muted-foreground font-normal mx-0.5">+</span>}
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold shadow-sm">
              {part}
            </kbd>
          </React.Fragment>
        ))}
      </React.Fragment>
    )
  })
}

export function KeyboardSettingsTab(): React.ReactElement {
  const { t } = useTranslation()
  const [version, setVersion] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmResetAll, setConfirmResetAll] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: version counter triggers re-read from localStorage
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: version counter triggers re-read from localStorage
  const conflicts = useMemo(() => findConflicts(), [version])

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
      <div>
        <h3 className="text-lg font-semibold">{t('keyboard.settings.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('keyboard.settings.description')}</p>
      </div>

      <ScrollArea className="max-h-[60vh]">
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
                    <div className="w-full sm:w-56 sm:shrink-0">
                      {isEditing ? (
                        <div className="flex items-center gap-1">
                          <Input
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            placeholder={t('keyboard.settings.typeNewBinding')}
                            className="text-xs"
                            autoFocus
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
                            disabled={!editValue.trim()}
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
                      ) : (
                        <span className="inline-flex flex-wrap items-center gap-1">
                          {renderKeys(shortcut.keys)}
                          {shortcut.isCustom && (
                            <span className="text-xs text-primary ml-1">
                              {t('keyboard.settings.customized')}
                            </span>
                          )}
                        </span>
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

                    {/* Conflict warning */}
                    {conflictNames && conflictNames.length > 0 && !isEditing && (
                      <div className="text-xs text-alert-warning-foreground">
                        {t('keyboard.settings.conflictWarning', {
                          shortcuts: conflictNames.join(', '),
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </ScrollArea>

      {/* Empty binding validation message */}
      {editingId && !editValue.trim() && (
        <p className="text-xs text-destructive">{t('keyboard.settings.emptyBinding')}</p>
      )}

      <div className="pt-2">
        <Button variant="outline" size="sm" onClick={() => setConfirmResetAll(true)}>
          {t('keyboard.settings.resetAllButton')}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmResetAll}
        onOpenChange={setConfirmResetAll}
        title={t('keyboard.settings.resetAllTitle')}
        description={t('keyboard.settings.resetAllConfirm')}
        actionLabel={t('keyboard.settings.resetAllButton')}
        actionVariant="destructive"
        onAction={handleResetAll}
      />
    </div>
  )
}
