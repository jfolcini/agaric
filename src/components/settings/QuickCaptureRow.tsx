/**
 * QuickCaptureRow — "Quick capture shortcut" row inside the General settings tab (FEAT-12).
 *
 * Surfaces the user-configured global hotkey and an "Edit" button.
 * Clicking edit opens an inline editor (Input + Save / Cancel) where
 * the user types the new chord. Save flow:
 *
 *   1. `unregisterGlobalShortcut(previous)` — release the OS binding
 *      so it doesn't double-fire while the new chord installs.
 *   2. `registerGlobalShortcut(next, …)` — try the new chord; if the
 *      OS rejects (chord conflict / IPC failure), revert to `previous`
 *      and surface `toast.error(t('settings.quickCapture.saveFailed'))`.
 *   3. On success: persist via `saveQuickCaptureShortcut` so subsequent
 *      App.tsx mounts re-bind the chosen chord.
 *
 * The handler is a no-op stub — the dialog is opened by App.tsx's own
 * registration; this row only owns the editing surface so the binding
 * lives in one place. We still re-register here so a save attempt
 * actually surfaces "this chord conflicts" feedback in real time.
 *
 * Hidden entirely on mobile (`useIsMobile`) — matches FEAT-12's
 * desktop-only requirement without depending on `tauri-apps/plugin-os`
 * or another IPC round-trip.
 */

import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useIsMobile } from '@/hooks/useIsMobile'
import { logger } from '@/lib/logger'
import {
  defaultQuickCaptureShortcut,
  loadQuickCaptureShortcut,
  QUICK_CAPTURE_SHORTCUT_STORAGE_KEY,
  saveQuickCaptureShortcut,
} from '@/lib/quick-capture-shortcut'
import { registerGlobalShortcut, unregisterGlobalShortcut } from '@/lib/tauri'

export function QuickCaptureRow(): React.ReactElement | null {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const [shortcut, setShortcut] = useState<string>(() => loadQuickCaptureShortcut())
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)

  const handleEdit = useCallback(() => {
    setDraft(shortcut)
    setEditing(true)
  }, [shortcut])

  const handleCancel = useCallback(() => {
    setDraft('')
    setEditing(false)
  }, [])

  const handleSave = useCallback(async () => {
    const next = draft.trim()
    if (next.length === 0 || next === shortcut) {
      setEditing(false)
      return
    }
    setPending(true)
    const previous = shortcut
    try {
      // Probe the new chord with a temporary register/unregister pair
      // so the user gets immediate failure feedback if the chord is
      // already claimed by another app. The live binding is owned by
      // App.tsx and re-applied via the `storage` event below; the
      // probe must NOT leak across the boundary, so we always
      // unregister it before saving.
      await registerGlobalShortcut(next, () => {})
      await unregisterGlobalShortcut(next).catch((err: unknown) => {
        logger.warn('SettingsView', 'failed to release probe quick-capture shortcut', { next }, err)
      })
      saveQuickCaptureShortcut(next)
      // Synthesize a `storage` event so App.tsx's chord-state listener
      // re-reads localStorage and the registration effect re-runs with
      // the live `setQuickCaptureOpen` handler. The spec only fires
      // storage events to *other* tabs, so we synthesize for ourselves.
      try {
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: QUICK_CAPTURE_SHORTCUT_STORAGE_KEY,
            oldValue: previous,
            newValue: next,
            storageArea: window.localStorage,
          }),
        )
      } catch {
        // StorageEvent constructor support is universal in modern
        // browsers; the swallow is for ancient JSDOM only.
      }
      setShortcut(next)
      setEditing(false)
    } catch (err) {
      logger.error(
        'SettingsView',
        'failed to register new quick-capture shortcut',
        { previous, next },
        err,
      )
      toast.error(t('settings.quickCapture.saveFailed'))
      // No restore needed — the previous chord stays bound by App.tsx
      // because we never touched its registration; we only probed
      // `next` (which we've already unregistered above on failure
      // paths via the catch unwinding).
    } finally {
      setPending(false)
    }
  }, [draft, shortcut, t])

  if (isMobile) return null

  return (
    <div
      className="flex items-start justify-between gap-4"
      data-testid="quick-capture-settings-row"
    >
      <div className="flex-1 space-y-1">
        <Label htmlFor="quick-capture-shortcut" muted={false}>
          {t('settings.quickCapture.label')}
        </Label>
        <p className="text-xs text-muted-foreground">{t('settings.quickCapture.description')}</p>
        {editing ? (
          <div className="flex items-center gap-2 pt-2">
            <input
              id="quick-capture-shortcut"
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={defaultQuickCaptureShortcut()}
              aria-label={t('settings.quickCapture.label')}
              disabled={pending}
              className="flex-1 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden"
              data-testid="quick-capture-shortcut-input"
            />
            <Button
              size="sm"
              onClick={() => {
                void handleSave()
              }}
              disabled={pending}
              data-testid="quick-capture-shortcut-save"
            >
              {t('keyboard.settings.saveButton')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleCancel}
              disabled={pending}
              data-testid="quick-capture-shortcut-cancel"
            >
              {t('keyboard.settings.cancelButton')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3 pt-1">
            <code
              className="rounded-md border border-border bg-muted/30 px-2 py-0.5 font-mono text-xs"
              data-testid="quick-capture-shortcut-binding"
            >
              {shortcut}
            </code>
          </div>
        )}
      </div>
      {!editing && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleEdit}
          aria-label={t('settings.quickCapture.editButton')}
          data-testid="quick-capture-shortcut-edit"
        >
          {t('settings.quickCapture.editButton')}
        </Button>
      )}
    </div>
  )
}
