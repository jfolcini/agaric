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
 * Also installs the global `showShortcuts` keydown listener (default `?`)
 * that opens the shortcuts sheet — moved here from `KeyboardShortcuts`
 * because App.tsx gate-mounts that lazy component on `shortcutsOpen`
 * (#754), and an unmounted sheet can't open itself — plus the two
 * custom-event listeners that drive these dialogs:
 * - `BUG_REPORT_EVENT` (window) — opens the bug-report dialog with the
 *   captured error message + stack pre-filled. Dispatched from
 *   `FeatureErrorBoundary`'s `t('bugReport.reportCrashTitle')` button; the boundary lives
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
import { matchesShortcutBinding } from '../lib/keyboard-config'
import { CLOSE_ALL_OVERLAYS_EVENT, SHOW_SHORTCUTS_EVENT } from '../lib/overlay-events'

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

  // ── Global `showShortcuts` listener (default `?`) ───────────────────
  // #754 — App.tsx now gate-mounts the lazy `KeyboardShortcuts` sheet on
  // `shortcutsOpen` so its chunk stays off the boot path. The sheet used
  // to own this listener, but a gated component can't open itself — the
  // always-mounted dialog-state owner listens instead. Routed through
  // `matchesShortcutBinding` (#724) so a Settings rebind is honoured;
  // skipped while typing in an input / textarea / contenteditable, same
  // as the sheet's original listener.
  useEffect(() => {
    function handleShowShortcuts(e: KeyboardEvent) {
      if (!matchesShortcutBinding(e, 'showShortcuts')) return
      const target = e.target as HTMLElement | null
      if (!target) return
      const tagName = target.tagName?.toLowerCase()
      if (tagName === 'input' || tagName === 'textarea') return
      if (target.isContentEditable || target.getAttribute?.('contenteditable') === 'true') return
      e.preventDefault()
      setShortcutsOpen(true)
    }
    document.addEventListener('keydown', handleShowShortcuts)
    return () => document.removeEventListener('keydown', handleShowShortcuts)
  }, [])

  // ── Global `show-shortcuts` event listener (#922) ───────────────────
  // The `?` keydown handler above deliberately ignores `?` while an editor
  // is focused (so a literal `?` types during outlining), which left the
  // cheatsheet unreachable mid-outline. The command palette's "Keyboard
  // shortcuts" entry dispatches this editor-agnostic event so the sheet opens
  // regardless of focus — this hook is the always-mounted dialog-state owner.
  useEffect(() => {
    function handleShowShortcutsEvent() {
      setShortcutsOpen(true)
    }
    window.addEventListener(SHOW_SHORTCUTS_EVENT, handleShowShortcutsEvent)
    return () => window.removeEventListener(SHOW_SHORTCUTS_EVENT, handleShowShortcutsEvent)
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
