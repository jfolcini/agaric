/**
 * useAppDialogs — central state for the 4 shell-level dialogs.
 *
 * MAINT-124 step 3 — extracted from App.tsx as part of the 4-extraction
 * collapse plan (others: useAppKeyboardShortcuts ✅, AppSidebar ✅,
 * useAppDialogs THIS, ViewDispatcher next).
 *
 * Owns:
 * - `bugReportOpen` + `bugReportPrefill` (UX-279) — bug-report dialog with
 *   optional prefill payload from `FeatureErrorBoundary`.
 * - `quickCaptureOpen` (FEAT-12) — quick-capture dialog opened via the OS
 *   global hotkey registered in App.tsx.
 * - `showNoPeersDialog` (BUG-2) — sync-with-no-peers warning gate.
 * - `shortcutsOpen` (UX-228) — keyboard-shortcuts reference sheet.
 *
 * Also installs the two custom-event listeners that drive these dialogs:
 * - `BUG_REPORT_EVENT` (window) — opens the bug-report dialog with the
 *   captured error message + stack pre-filled. Dispatched from
 *   `FeatureErrorBoundary`'s "Report bug" button; the boundary lives
 *   inside the crashed subtree and can't open a dialog itself, so the
 *   App shell mounts the dialog and listens here.
 * - `CLOSE_ALL_OVERLAYS_EVENT` (window) — Esc-key bridge that closes the
 *   shortcuts sheet. The sheet is Radix-managed and already closes on
 *   Escape *inside* it; this listener is the secondary dismiss path for
 *   when focus has drifted elsewhere.
 *
 * The hook only owns the STATE. The dialog JSX (`BugReportDialog`,
 * `QuickCaptureDialog`, `NoPeersDialog`, `KeyboardShortcuts`) stays at
 * the App.tsx render boundary so each can wire its own
 * `onOpenChange` / `onOpenSettings` handler.
 */

import { useEffect, useState } from 'react'
import { BUG_REPORT_EVENT, type BugReportEventDetail } from '../lib/bug-report-events'
import { CLOSE_ALL_OVERLAYS_EVENT } from '../lib/overlay-events'

export interface UseAppDialogsReturn {
  // bug-report (UX-279)
  bugReportOpen: boolean
  setBugReportOpen: React.Dispatch<React.SetStateAction<boolean>>
  bugReportPrefill: BugReportEventDetail | null
  setBugReportPrefill: React.Dispatch<React.SetStateAction<BugReportEventDetail | null>>
  // quick-capture (FEAT-12)
  quickCaptureOpen: boolean
  setQuickCaptureOpen: React.Dispatch<React.SetStateAction<boolean>>
  // no-peers warning (BUG-2)
  showNoPeersDialog: boolean
  setShowNoPeersDialog: React.Dispatch<React.SetStateAction<boolean>>
  // shortcuts sheet (UX-228)
  shortcutsOpen: boolean
  setShortcutsOpen: React.Dispatch<React.SetStateAction<boolean>>
}

export function useAppDialogs(): UseAppDialogsReturn {
  const [bugReportOpen, setBugReportOpen] = useState<boolean>(false)
  const [bugReportPrefill, setBugReportPrefill] = useState<BugReportEventDetail | null>(null)
  const [quickCaptureOpen, setQuickCaptureOpen] = useState<boolean>(false)
  const [showNoPeersDialog, setShowNoPeersDialog] = useState<boolean>(false)
  const [shortcutsOpen, setShortcutsOpen] = useState<boolean>(false)

  // ── Bug-report event listener (UX-279) ────────────────────────────
  // FeatureErrorBoundary dispatches `BUG_REPORT_EVENT` from its "Report
  // bug" button. The boundary is inside the crashed subtree and can't
  // open a dialog itself, so the App shell mounts a top-level
  // BugReportDialog and opens it here with the event detail pre-filled.
  useEffect(() => {
    function handleReportBug(e: Event) {
      const detail = (e as CustomEvent<BugReportEventDetail>).detail
      if (detail == null) return
      setBugReportPrefill(detail)
      setBugReportOpen(true)
    }
    window.addEventListener(BUG_REPORT_EVENT, handleReportBug)
    return () => window.removeEventListener(BUG_REPORT_EVENT, handleReportBug)
  }, [])

  // ── Close the shortcuts sheet when "close all overlays" fires ───────
  // UX-228: the sheet is Radix-managed and already closes when Escape is
  // pressed *inside* it, but if focus has drifted elsewhere the global
  // handler is what dismisses it.
  useEffect(() => {
    function handleClose() {
      setShortcutsOpen(false)
    }
    window.addEventListener(CLOSE_ALL_OVERLAYS_EVENT, handleClose)
    return () => window.removeEventListener(CLOSE_ALL_OVERLAYS_EVENT, handleClose)
  }, [])

  return {
    bugReportOpen,
    setBugReportOpen,
    bugReportPrefill,
    setBugReportPrefill,
    quickCaptureOpen,
    setQuickCaptureOpen,
    showNoPeersDialog,
    setShowNoPeersDialog,
    shortcutsOpen,
    setShortcutsOpen,
  }
}
