/**
 * useAppDialogs — central state for the shell-level dialogs.
 *
 * Extracted from App.tsx as part of the 4-extraction
 * collapse plan (others: useAppKeyboardShortcuts ✅, AppSidebar ✅,
 * useAppDialogs THIS, ViewDispatcher next).
 *
 * Owns:
 * `bugReportOpen` + `bugReportPrefill` — bug-report dialog with
 *   optional prefill payload from `FeatureErrorBoundary`.
 * `quickCaptureOpen` + `quickCapturePrefill` — quick-capture dialog opened via
 *   the OS global hotkey registered in App.tsx, or by an
 *   `agaric://capture?text=…` link holding its text (#6555).
 * `showNoPeersDialog` — sync-with-no-peers warning gate.
 * `shortcutsOpen` — keyboard-shortcuts reference sheet.
 * `newPageTitle` — the New page dialog's pre-filled title; `null` = closed.
 * `newMeetingOpen` — the New meeting dialog opened from the palette.
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
 * - `OPEN_NEW_PAGE_DIALOG_EVENT` (window) — opens the New page dialog,
 *   pre-filled with the event detail. Every new-page entry point sends it.
 * - `OPEN_NEW_MEETING_DIALOG_EVENT` (window) — opens the New meeting dialog.
 * - `OPEN_QUICK_CAPTURE_EVENT` (window) — opens Quick Capture holding the
 *   event's text; `handleCapturePayload` sends it for the Rust router's
 *   `deeplink:capture` event, listened for here because this hook owns the
 *   dialog, and `dispatchLaunchUrl` for a cold start's launch URL.
 * - `CLOSE_ALL_OVERLAYS_EVENT` (window) — Esc-key bridge that closes the
 *   shortcuts sheet. The sheet is Radix-managed and already closes on
 *   Escape *inside* it; this listener is the secondary dismiss path for
 *   when focus has drifted elsewhere.
 *
 * The hook only owns the STATE. The dialog JSX (`BugReportDialog`,
 * `QuickCaptureDialog`, `NoPeersPairing`, `KeyboardShortcuts`) stays at
 * the App.tsx render boundary so each can wire its own `onOpenChange`.
 */

import { useEffect, useState } from 'react'

import { DEEPLINK_EVENT_CAPTURE, handleCapturePayload } from '@/hooks/useDeepLinkRouter'
import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import { BUG_REPORT_EVENT, type BugReportEventDetail } from '@/lib/bug-report-events'
import { matchesShortcutBinding } from '@/lib/keyboard-config'
import { logger } from '@/lib/logger'
import {
  CLOSE_ALL_OVERLAYS_EVENT,
  OPEN_NEW_MEETING_DIALOG_EVENT,
  OPEN_NEW_PAGE_DIALOG_EVENT,
  OPEN_QUICK_CAPTURE_EVENT,
  SHOW_SHORTCUTS_EVENT,
} from '@/lib/overlay-events'

/** Text an `agaric://capture` link hands the dialog (#6555); a new object per link. */
export interface QuickCapturePrefill {
  text: string
}

export interface UseAppDialogsReturn {
  // Bug-report
  bugReportOpen: boolean
  setBugReportOpen: React.Dispatch<React.SetStateAction<boolean>>
  bugReportPrefill: BugReportEventDetail | null
  setBugReportPrefill: React.Dispatch<React.SetStateAction<BugReportEventDetail | null>>
  // Quick-capture
  quickCaptureOpen: boolean
  setQuickCaptureOpen: React.Dispatch<React.SetStateAction<boolean>>
  quickCapturePrefill: QuickCapturePrefill | null
  setQuickCapturePrefill: React.Dispatch<React.SetStateAction<QuickCapturePrefill | null>>
  // No-peers warning
  showNoPeersDialog: boolean
  setShowNoPeersDialog: React.Dispatch<React.SetStateAction<boolean>>
  // Shortcuts sheet
  shortcutsOpen: boolean
  setShortcutsOpen: React.Dispatch<React.SetStateAction<boolean>>
  // New page dialog: the title to pre-fill, `null` while closed
  newPageTitle: string | null
  setNewPageTitle: React.Dispatch<React.SetStateAction<string | null>>
  // New meeting dialog, linked from the day's journal
  newMeetingOpen: boolean
  setNewMeetingOpen: React.Dispatch<React.SetStateAction<boolean>>
}

export function useAppDialogs(): UseAppDialogsReturn {
  const [bugReportOpen, setBugReportOpen] = useState<boolean>(false)
  const [bugReportPrefill, setBugReportPrefill] = useState<BugReportEventDetail | null>(null)
  const [quickCaptureOpen, setQuickCaptureOpen] = useState<boolean>(false)
  const [quickCapturePrefill, setQuickCapturePrefill] = useState<QuickCapturePrefill | null>(null)
  const [showNoPeersDialog, setShowNoPeersDialog] = useState<boolean>(false)
  const [shortcutsOpen, setShortcutsOpen] = useState<boolean>(false)
  const [newPageTitle, setNewPageTitle] = useState<string | null>(null)
  const [newMeetingOpen, setNewMeetingOpen] = useState<boolean>(false)

  // ── Bug-report event listener ────────────────────────────
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

  useEffect(() => {
    function handleOpenNewPageDialog(e: Event) {
      setNewPageTitle((e as CustomEvent<string>).detail)
    }
    window.addEventListener(OPEN_NEW_PAGE_DIALOG_EVENT, handleOpenNewPageDialog)
    return () => window.removeEventListener(OPEN_NEW_PAGE_DIALOG_EVENT, handleOpenNewPageDialog)
  }, [])

  useEffect(() => {
    function handleOpenNewMeetingDialog() {
      setNewMeetingOpen(true)
    }
    window.addEventListener(OPEN_NEW_MEETING_DIALOG_EVENT, handleOpenNewMeetingDialog)
    return () =>
      window.removeEventListener(OPEN_NEW_MEETING_DIALOG_EVENT, handleOpenNewMeetingDialog)
  }, [])

  useTauriEventListener<unknown>(
    DEEPLINK_EVENT_CAPTURE,
    (event) => handleCapturePayload(event.payload),
    {
      enabled: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
      onError: (err) => {
        logger.warn('deeplink', `Failed to listen to ${DEEPLINK_EVENT_CAPTURE}`, undefined, err)
      },
    },
  )

  useEffect(() => {
    function handleOpenQuickCapture(e: Event) {
      // A new object per link, so a second link with the same text still reaches the open dialog.
      setQuickCapturePrefill({ text: (e as CustomEvent<string>).detail })
      setQuickCaptureOpen(true)
    }
    window.addEventListener(OPEN_QUICK_CAPTURE_EVENT, handleOpenQuickCapture)
    return () => window.removeEventListener(OPEN_QUICK_CAPTURE_EVENT, handleOpenQuickCapture)
  }, [])

  // ── Close the shortcuts sheet when "close all overlays" fires ───────
  // The sheet is Radix-managed and already closes when Escape is
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
    quickCapturePrefill,
    setQuickCapturePrefill,
    showNoPeersDialog,
    setShowNoPeersDialog,
    shortcutsOpen,
    setShortcutsOpen,
    newPageTitle,
    setNewPageTitle,
    newMeetingOpen,
    setNewMeetingOpen,
  }
}
