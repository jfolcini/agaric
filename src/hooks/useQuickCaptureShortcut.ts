/**
 * useQuickCaptureShortcut — FEAT-12 OS-level quick-capture chord owner.
 *
 * Extracted from App.tsx (#754) so the register/unregister IPC calls can
 * be SEQUENCED. Registers the user-configured chord (default Ctrl+Alt+N
 * on Linux / Windows, Cmd+Option+N on macOS) via
 * `tauri-plugin-global-shortcut`. When the chord fires the handler:
 *   1. Brings the window forward (unminimize + show + setFocus) so the
 *      dialog is visible even if the app was hidden / minimized.
 *   2. Opens `QuickCaptureDialog` via `setQuickCaptureOpen(true)`.
 *
 * **Sequencing (#754).** `registerGlobalShortcut` / `unregisterGlobalShortcut`
 * are async IPC calls. The previous App.tsx effect fired them without
 * ordering, so a StrictMode / HMR mount-unmount-mount could interleave as
 * register₁ → unregister₁ → register₂ at the JS layer but resolve as
 * unregister₁ (no-op, nothing registered yet) → register₁ → register₂
 * ("already registered" failure) on the backend — leaving the chord dead
 * or double-bound. Every operation now chains onto a hook-lifetime promise
 * (`opChain`) so the OS sees them strictly in mount order. A failed op
 * logs and the chain continues (the `.catch` resolves the link).
 *
 * Desktop-only: `registerGlobalShortcut` itself short-circuits on mobile,
 * so there is no platform gate here.
 */

import { useEffect, useRef, useState } from 'react'

import { logger } from '@/lib/logger'
import {
  loadQuickCaptureShortcut,
  QUICK_CAPTURE_SHORTCUT_STORAGE_KEY,
} from '@/lib/quick-capture-shortcut'
import { registerGlobalShortcut, unregisterGlobalShortcut } from '@/lib/tauri'

export function useQuickCaptureShortcut(setQuickCaptureOpen: (open: boolean) => void): void {
  // FEAT-12: lift the chord into state so the registration effect
  // re-runs when SettingsView changes it. Lazy-init from localStorage
  // so we don't read on every render. The storage-event listener
  // below feeds new chords into this state.
  const [quickCaptureChord, setQuickCaptureChord] = useState<string>(loadQuickCaptureShortcut)

  // Hook-lifetime promise chain that serialises every register/unregister
  // IPC call (#754 — see module doc). Refs survive StrictMode's
  // mount-unmount-mount of the same fiber, so the chain spans the remount.
  const opChain = useRef<Promise<void>>(Promise.resolve())

  // Storage-event listener that updates the chord state, kept in its
  // own effect so it never tears down between chord-driven re-binds.
  // SettingsView writes the new chord to localStorage and dispatches
  // a synthetic storage event; we re-read and feed it into state.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== QUICK_CAPTURE_SHORTCUT_STORAGE_KEY) return
      const next = loadQuickCaptureShortcut()
      setQuickCaptureChord((prev) => (prev === next ? prev : next))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Register / re-register the global chord whenever it changes.
  // Cleanup unregisters the previous chord before the new one is
  // registered — both ride the sequenced chain, so the OS only ever
  // has one binding at a time.
  useEffect(() => {
    let active = true
    const accelerator = quickCaptureChord

    const handler = () => {
      // Best-effort window focus. The IPC failures here are non-fatal —
      // the dialog still opens; only the visibility / focus state may
      // be wrong if the user already closed the window manually.
      void (async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window')
          const w = getCurrentWindow()
          // Order matters: unminimize before show before setFocus.
          if (await w.isMinimized().catch(() => false)) {
            await w
              .unminimize()
              .catch((err) =>
                logger.warn('App', 'window operation failed', { op: 'unminimize' }, err),
              )
          }
          await w
            .show()
            .catch((err) => logger.warn('App', 'window operation failed', { op: 'show' }, err))
          await w
            .setFocus()
            .catch((err) => logger.warn('App', 'window operation failed', { op: 'setFocus' }, err))
        } catch (err) {
          logger.warn('App', 'quick-capture window focus failed', undefined, err)
        }
      })()
      if (active) setQuickCaptureOpen(true)
    }

    opChain.current = opChain.current
      .then(() => registerGlobalShortcut(accelerator, handler))
      .catch((err: unknown) => {
        logger.warn('App', 'failed to register quick-capture global shortcut', { accelerator }, err)
      })

    return () => {
      active = false
      opChain.current = opChain.current
        .then(() => unregisterGlobalShortcut(accelerator))
        .catch((err: unknown) => {
          logger.warn(
            'App',
            'failed to unregister quick-capture global shortcut',
            { accelerator },
            err,
          )
        })
    }
  }, [quickCaptureChord, setQuickCaptureOpen])
}
