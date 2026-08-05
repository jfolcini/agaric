/**
 * PairingDialog -- modal dialog for device pairing (#219).
 *
 * #3463 — pairing only works when exactly one of the two devices shows a
 * code (the "host") and the other enters it (the "joiner"). The dialog's
 * first state is always a role choice (`PairingRole`); opening the dialog
 * fires ZERO backend calls, and the two roles' UI is mutually exclusive by
 * construction — `role` is a single tri-state value, not two booleans, so
 * "both at once" is not representable. Only the host path calls
 * `commands.startPairing()`; only the joiner path renders the entry
 * form/QR-scanner and calls `commands.confirmPairing()`.
 *
 * Sections (each extracted as a sub-component for testability):
 *  0. Role chooser (inline — two buttons, no backend call)
 *  1. QR code + passphrase display (PairingQrDisplay) — host only
 *  2. Passphrase entry (PairingEntryForm) — joiner only
 *  3. List of already-paired devices (PairingPeersList) — either role
 *
 * Props: open (boolean), onOpenChange (callback), triggerRef (optional).
 *
 * On phones < 768 px (`useIsMobile() === true`) the dialog renders as a
 * bottom Sheet via `useDialogOrSheet('dialog')` — pairing is a core
 * phone-first flow (#2665), so this matters more here than for most
 * dialogs. Both paths share the same controlled `open` / `onOpenChange`
 * API.
 */

import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { UnpairConfirmDialog } from '@/components/dialogs/UnpairConfirmDialog'
import { PairingEntryForm } from '@/components/peers/PairingEntryForm'
import { PairingPeersList } from '@/components/peers/PairingPeersList'
import { PairingQrDisplay } from '@/components/peers/PairingQrDisplay'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { DialogBody } from '@/components/ui/dialog'
import { SheetBody } from '@/components/ui/sheet'
import { useDialogOrSheet } from '@/hooks/useDialogOrSheet'
import { useIpcCommand } from '@/hooks/useIpcCommand'
import { mapPeerRefToInfo } from '@/hooks/useSyncTrigger'
import { announce } from '@/lib/announcer'
import { unwrap } from '@/lib/app-error'
import type { PairingInfo, PeerRef as PeerRefRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { formatErrorForDisplay } from '@/lib/error-display'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { useSyncStore } from '@/stores/sync'

interface PairingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  triggerRef?: React.RefObject<HTMLButtonElement | null>
}

const PAIRING_TIMEOUT_SECONDS = 300 // 5 minutes

// #3463 — the dialog's first state. A single tri-state value (rather than
// e.g. `isHost: boolean` + `isJoiner: boolean`) so "both roles selected at
// once" — the bug this fix addresses — is not representable in the type.
type PairingRole = 'chooser' | 'host' | 'joiner'

export function PairingDialog({
  open,
  onOpenChange,
  triggerRef,
}: PairingDialogProps): React.ReactElement | null {
  const [role, setRole] = useState<PairingRole>('chooser')
  const [pairingInfo, setPairingInfo] = useState<PairingInfo | null>(null)
  const [words, setWords] = useState<[string, string, string, string]>(['', '', '', ''])
  const [peers, setPeers] = useState<PeerRefRow[]>([])
  const [loading, setLoading] = useState(false)
  const [pairLoading, setPairLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unpairPeerId, setUnpairPeerId] = useState<string | null>(null)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [entryMode, setEntryMode] = useState<'manual' | 'scan'>('manual')
  // Guard against accidentally closing the dialog mid-handshake.
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false)
  // Pause the countdown while the user is mid-keystroke in the
  // passphrase inputs so an in-flight handshake doesn't fail to a tick
  // boundary. PairingEntryForm enforces a 5s idle debounce so an idle
  // user with focus can't keep this true forever. Only ever meaningful on
  // the host's own countdown, but the callback is shared with
  // PairingEntryForm (joiner) unconditionally — harmless there because no
  // countdown is ever rendered alongside the joiner's entry form.
  const [pausedByTyping, setPausedByTyping] = useState(false)

  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement>(null)
  const retryBtnRef = useRef<HTMLButtonElement>(null)
  // Tracks the paste-focus setTimeout so we can cancel it on unmount and
  // Avoid focusing a stale DOM node (#).
  const pendingFocusRef = useRef<number | null>(null)
  // True only once `startPairing` has actually succeeded (host path). Gates
  // every `cancelPairing` call (close/unmount cleanup, explicit Cancel, Back
  // to chooser) so we never cancel a session that was never started —
  // required because the joiner path never calls `startPairing` at all.
  const sessionStartedRef = useRef(false)

  // Clear any pending paste-focus timer on unmount so we never touch a
  // detached DOM node after the dialog closes.
  useEffect(
    () => () => {
      if (pendingFocusRef.current !== null) {
        window.clearTimeout(pendingFocusRef.current)
        pendingFocusRef.current = null
      }
    },
    [],
  )

  // Helper: query word inputs from the DOM (Input component doesn't forward refs)
  const getWordInputs = useCallback(
    () =>
      dialogRef.current
        ? Array.from(
            dialogRef.current.querySelectorAll<HTMLInputElement>('.pairing-word-inputs input'),
          )
        : [],
    [],
  )

  const syncSetState = useSyncStore((s) => s.setState)

  // Host-only: mint a passphrase + QR code via the shared useIpcCommand
  // hook. The error template literal mirrors the existing inline format so
  // the error banner copy stays byte-equivalent regardless of which of the
  // two calls in `initHost` below fails.
  const { execute: executeStartPairing } = useIpcCommand<void, PairingInfo>({
    call: () => commands.startPairing().then((r) => unwrap(r)),
    module: 'PairingDialog',
    errorLogMessage: 'Failed to start pairing',
    onSuccess: (info) => {
      sessionStartedRef.current = true
      setPairingInfo(info)
      setCountdown(PAIRING_TIMEOUT_SECONDS)
    },
    onError: (err) => {
      setError(
        t('pairing.startFailed', {
          message: String(err instanceof Error ? err.message : err),
        }),
      )
    },
  })

  // Shared by both roles: refresh the paired-devices list. Never calls
  // `startPairing` — read-only, so it's safe for the joiner path too.
  const { execute: executeLoadPeers } = useIpcCommand<void, PeerRefRow[]>({
    call: () => commands.listPeerRefs().then((r) => unwrap(r)),
    module: 'PairingDialog',
    errorLogMessage: 'Failed to load paired devices',
    onSuccess: (peerList) => {
      setPeers(peerList)
      // #1076: keep the shared sync store in step with the dialog's local
      // peer list so StatusPanel / sidebar dot stay correct.
      useSyncStore.getState().setPeers(peerList.map(mapPeerRefToInfo))
    },
    onError: (err) => {
      setError(
        t('pairing.startFailed', {
          message: String(err instanceof Error ? err.message : err),
        }),
      )
    },
  })

  // Host path: only entry point that calls `startPairing`.
  const initHost = useCallback(async () => {
    setRole('host')
    setLoading(true)
    setError(null)
    await Promise.all([executeStartPairing(), executeLoadPeers()])
    setLoading(false)
  }, [executeStartPairing, executeLoadPeers])

  // Joiner path: never calls `startPairing` — only refreshes the peers list
  // so the paired-devices section still has something to show.
  const initJoiner = useCallback(async () => {
    setRole('joiner')
    setLoading(true)
    setError(null)
    await executeLoadPeers()
    setLoading(false)
  }, [executeLoadPeers])

  // Retry button (#282) re-runs whichever role's init failed.
  const handleRetry = useCallback(() => {
    if (role === 'host') {
      void initHost()
    } else if (role === 'joiner') {
      void initJoiner()
    }
  }, [role, initHost, initJoiner])

  // Cleanup-side cancelPairing — fires when the dialog closes or unmounts,
  // but ONLY if a host session was actually started (`sessionStartedRef`).
  // Logger.warn + notify.error matches the original inline shape
  // (handleCancel uses a different logger.error-only flavor that stays
  // inline because it has no toast).
  const { execute: executeCancelPairingCleanup } = useIpcCommand<void, void>({
    call: () =>
      commands.cancelPairing().then((r) => {
        unwrap(r)
      }),
    module: 'PairingDialog',
    errorLogMessage: 'cancelPairing on close/unmount failed',
    logLevel: 'warn',
    onError: () => {
      notify.error(t('pairing.cancelFailed'))
    },
  })

  // #3463 — opening the dialog fires ZERO backend calls: reset to a fresh
  // role choice every time `open` flips true. The previous version
  // unconditionally called `startPairing` here, which is exactly the bug.
  useEffect(() => {
    if (!open) return
    setRole('chooser')
    setPairingInfo(null)
    setWords(['', '', '', ''])
    setPeers([])
    setError(null)
    setCountdown(null)
    setEntryMode('manual')
    sessionStartedRef.current = false
  }, [open])

  // Cancel the pairing session on the backend when the dialog closes or
  // unmounts — but only if a session was actually started (host path that
  // successfully called `startPairing`). The joiner path never starts a
  // session, so this is a correct no-op for it.
  useEffect(() => {
    if (!open) return
    return () => {
      if (sessionStartedRef.current) {
        sessionStartedRef.current = false
        void executeCancelPairingCleanup()
      }
    }
  }, [open, executeCancelPairingCleanup])

  // Countdown timer (#294) — only re-run effect when active/inactive changes.
  // Read the pause flag through a ref inside the interval so flipping
  // pausedByTyping does NOT tear down and recreate the interval (which would
  // also reset its 1s phase and skew the displayed countdown). The interval
  // simply skips the decrement while paused.
  //
  // The ref is written synchronously in handleTypingStateChange (below) — not
  // via a useEffect that mirrors the state — because under fake timers a
  // burst of timer callbacks (e.g. interval tick + debounce expiry) runs
  // back-to-back before React commits, so a deferred ref-sync would still
  // see the stale value at the next tick.
  const countdownActive = countdown !== null && countdown > 0
  const pausedByTypingRef = useRef(false)
  useEffect(() => {
    if (!countdownActive) return

    const interval = setInterval(() => {
      if (pausedByTypingRef.current) return
      setCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [countdownActive])

  // Single setter that updates both the ref (read by the interval)
  // and the state (drives the `t('pairing.countdownPaused')` indicator render).
  // Announces the pause / resume transition so screen-reader users — who
  // can't see the inline `t('pairing.countdownPaused')` indicator (it sits inside
  // an aria-hidden countdown <p>) — still hear the state change.
  const handleTypingStateChange = useCallback(
    (isTyping: boolean) => {
      const wasPaused = pausedByTypingRef.current
      pausedByTypingRef.current = isTyping
      setPausedByTyping(isTyping)
      if (isTyping && !wasPaused) {
        announce(t('announce.pairingCountdownPaused'))
      } else if (!isTyping && wasPaused) {
        announce(t('announce.pairingCountdownResumed'))
      }
    },
    [t],
  )

  // Announce countdown crossings at SR-relevant thresholds only.
  // We deliberately avoid announcing every tick — only the meaningful
  // boundaries (1 minute, 30 seconds, 10 seconds, expired) so screen-reader
  // users get warned without being spammed.
  useEffect(() => {
    if (countdown === null) return
    if (countdown === 60) {
      announce(t('announce.pairingCountdownMinute'))
    } else if (countdown === 30 || countdown === 10) {
      announce(t('announce.pairingCountdown', { seconds: countdown }))
    } else if (countdown === 0) {
      announce(t('announce.pairingExpired'))
    }
  }, [countdown, t])

  // Focus first word input once the joiner's entry form is rendered. Was
  // previously keyed off `pairingInfo` (a HOST-only value) as a proxy for
  // "the entry form is visible" — a symptom of the original bug, since both
  // widgets used to mount together. Now keyed directly on the joiner role.
  useEffect(() => {
    if (open && role === 'joiner' && !loading) {
      const inputs = getWordInputs()
      inputs[0]?.focus()
    }
  }, [open, role, loading, getWordInputs])

  // #279: Paste support — when pasting multi-word text, split and distribute across inputs
  const handleWordChange = useCallback(
    (index: number, value: string) => {
      const trimmed = value.trim().toLowerCase()
      const parts = trimmed.split(/\s+/)

      if (parts.length > 1) {
        // Paste detected: distribute words across inputs starting at index
        setWords((prev) => {
          const next = [...prev] as [string, string, string, string]
          for (let i = 0; i < parts.length && index + i < 4; i++) {
            next[index + i] = parts[i] ?? ''
          }
          return next
        })
        // Focus the next empty input after the distributed words
        const nextEmpty = Math.min(index + parts.length, 3)
        if (pendingFocusRef.current !== null) {
          window.clearTimeout(pendingFocusRef.current)
        }
        pendingFocusRef.current = window.setTimeout(() => {
          pendingFocusRef.current = null
          const inputs = getWordInputs()
          inputs[nextEmpty]?.focus()
        }, 0)
      } else {
        setWords((prev) => {
          const next = [...prev] as [string, string, string, string]
          next[index] = trimmed
          return next
        })
      }
    },
    [getWordInputs],
  )

  // Confirm pairing with the entered passphrase + refresh the
  // peer list. Failures in either of the two underlying calls produce
  // the same "Pairing failed:" banner — matches existing behavior where
  // a post-confirm `listPeerRefs()` rejection is reported under the same
  // label. `setWords` / success toast / dialog close run only on full
  // success via `onSuccess`. Joiner-only — the host never renders the form
  // that calls this.
  const { execute: executePair } = useIpcCommand<{ passphrase: string }, void>({
    call: async ({ passphrase }) => {
      // remoteDeviceId is derived from the passphrase in the pairing protocol
      unwrap(await commands.confirmPairing(passphrase, ''))
      syncSetState('idle')
      // Refresh peer list
      const peerList = unwrap(await commands.listPeerRefs())
      setPeers(peerList)
      // #1076: a freshly paired device must show up in the sidebar dot /
      // StatusPanel immediately, not only after the next sync cycle.
      useSyncStore.getState().setPeers(peerList.map(mapPeerRefToInfo))
    },
    module: 'PairingDialog',
    errorLogMessage: 'Pairing failed',
    onSuccess: () => {
      setWords(['', '', '', ''])
      notify.success(t('pairing.successMessage'))
      onOpenChange(false)
    },
    onError: (err) => {
      setError(t('pairing.pairFailed', { message: formatErrorForDisplay(err) }))
    },
  })

  const handlePair = useCallback(async () => {
    const passphrase = words.join(' ').trim()
    if (!passphrase || words.some((w) => w === '')) return

    setPairLoading(true)
    setError(null)
    await executePair({ passphrase })
    setPairLoading(false)
  }, [words, executePair])

  // #279: Space auto-advance and Enter-to-submit (uses DOM queries for focus)
  const handleWordKeyDown = useCallback(
    (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === ' ') {
        e.preventDefault()
        if (index < 3) {
          const inputs = getWordInputs()
          inputs[index + 1]?.focus()
        }
      } else if (e.key === 'Enter') {
        e.preventDefault()
        handlePair()
      }
    },
    [handlePair, getWordInputs],
  )

  // Handle QR scan result: parse passphrase and auto-fill word inputs
  const handleQrScan = useCallback(
    (data: string) => {
      // QR data may be JSON with a passphrase field or a plain passphrase string
      let passphrase = data
      try {
        const obj = JSON.parse(data)
        if (obj && typeof obj.passphrase === 'string') {
          passphrase = obj.passphrase
        }
      } catch {
        // Not JSON — use raw text as passphrase
      }

      const parts = passphrase.trim().toLowerCase().split(/\s+/)
      const newWords: [string, string, string, string] = [
        parts[0] ?? '',
        parts[1] ?? '',
        parts[2] ?? '',
        parts[3] ?? '',
      ]
      setWords(newWords)
      setEntryMode('manual') // Switch back so user can verify before confirming
      notify.success(t('pairing.qrScannedMessage'))
    },
    [t],
  )

  // Resets all role/session-scoped local state back to the pre-role-choice
  // shape. Shared by `handleCancel` (closes the dialog) and
  // `handleBackToChooser` (keeps it open, returns to the role choice).
  const resetRoleState = useCallback(() => {
    setRole('chooser')
    setPairingInfo(null)
    setWords(['', '', '', ''])
    setPeers([])
    setError(null)
    setCountdown(null)
    setEntryMode('manual')
    // Clear any stale paused state (ref + render state) so a
    // future re-open starts fresh.
    handleTypingStateChange(false)
  }, [handleTypingStateChange])

  const handleCancel = useCallback(() => {
    // Cancel any in-progress pairing session — only if one was actually
    // started (host path). The joiner path never calls `startPairing`, so
    // there is nothing on the backend to cancel for it.
    if (sessionStartedRef.current) {
      sessionStartedRef.current = false
      commands
        .cancelPairing()
        .then((r) => unwrap(r))
        .catch((err) => logger.error('PairingDialog', 'Failed to cancel pairing', undefined, err))
    }
    resetRoleState()
    onOpenChange(false)
    // #288: Return focus to trigger element
    triggerRef?.current?.focus()
  }, [onOpenChange, triggerRef, resetRoleState])

  // Back to the role choice (does NOT close the dialog). Cleans up any
  // started session exactly like `handleCancel`, satisfying "going back to
  // re-choose a role must clean up any started session."
  const handleBackToChooser = useCallback(async () => {
    if (sessionStartedRef.current) {
      sessionStartedRef.current = false
      await executeCancelPairingCleanup()
    }
    resetRoleState()
  }, [executeCancelPairingCleanup, resetRoleState])

  // Unpair a peer device. Same template-literal error format
  // as `handlePair` / `initHost` so the existing inline banner is preserved.
  const { execute: executeUnpair } = useIpcCommand<{ peerId: string }, void>({
    call: ({ peerId }) =>
      commands.deletePeerRef(peerId).then((r) => {
        unwrap(r)
      }),
    module: 'PairingDialog',
    errorLogMessage: 'Failed to unpair device',
    onSuccess: (_result, { peerId }) => {
      setPeers((prev) => {
        const next = prev.filter((p) => p.peer_id !== peerId)
        // #1076: mirror the removal into the shared store so the sidebar
        // dot flips back to "no peers" the moment the last device unpairs.
        useSyncStore.getState().setPeers(next.map(mapPeerRefToInfo))
        return next
      })
      setUnpairPeerId(null)
    },
    onError: (err) => {
      setError(
        t('pairing.unpairFailed', {
          message: String(err instanceof Error ? err.message : err),
        }),
      )
    },
  })

  const handleUnpair = useCallback(
    async (peerId: string) => {
      await executeUnpair({ peerId })
    },
    [executeUnpair],
  )

  // #294: Format countdown for display
  const isExpired = countdown !== null && countdown <= 0
  const countdownDisplay =
    countdown !== null && countdown > 0
      ? `${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, '0')}`
      : null

  // #430: Move focus to Retry button when error or expiry occurs
  useEffect(() => {
    if ((error || isExpired) && retryBtnRef.current) {
      retryBtnRef.current.focus()
    }
  }, [error, isExpired])

  // When the user attempts to close the dialog (Esc, X button, or
  // backdrop click) while a pairing handshake is mid-flight, show a
  // confirmation guard so they don't accidentally abort the in-progress
  // mTLS exchange. Direct prop changes from the parent still close the
  // dialog (intentional escape hatch).
  const handleAttemptClose = useCallback(() => {
    if (pairLoading) {
      setConfirmCloseOpen(true)
      return
    }
    handleCancel()
  }, [pairLoading, handleCancel])

  const parts = useDialogOrSheet('dialog')
  const { Root, Content, Header, Title } = parts
  // Sheet's Content takes a `side` prop; DialogContent does not.
  const contentSideProps = parts.isMobile ? ({ side: 'bottom' } as const) : {}
  // Mobile bottom-sheet path uses the Sheet body primitive so
  // padding/scroll behaviour comes from the Sheet scaffolding rather than
  // Dialog's — matches QuickCaptureDialog / BugReportDialog.
  const Body = parts.isMobile ? SheetBody : DialogBody

  if (!open) return null

  return (
    <>
      <Root
        open={open}
        onOpenChange={(o) => {
          if (!o) handleAttemptClose()
        }}
      >
        <Content
          className="pairing-dialog gap-0"
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            if (triggerRef?.current) {
              e.preventDefault()
              triggerRef.current.focus()
            }
          }}
          {...contentSideProps}
        >
          {/* Header */}
          <Header className="text-left mb-4">
            <Title>{t('pairing.dialogTitle')}</Title>
          </Header>

          <Body>
            <div ref={dialogRef}>
              {/* Role chooser (#3463) — the dialog's first state. No
                  backend call fires until one of these is clicked. */}
              {role === 'chooser' && (
                <div className="pairing-role-chooser flex flex-col gap-3 py-2">
                  <p className="text-sm text-muted-foreground">
                    {t('pairing.roleChooserInstruction')}
                  </p>
                  <Button
                    variant="outline"
                    className="pairing-role-host-btn h-auto justify-start py-3 text-left"
                    onClick={() => void initHost()}
                  >
                    <span className="flex flex-col items-start gap-0.5">
                      <span className="font-medium">{t('pairing.hostRoleButton')}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {t('pairing.hostRoleDescription')}
                      </span>
                    </span>
                  </Button>
                  <Button
                    variant="outline"
                    className="pairing-role-joiner-btn h-auto justify-start py-3 text-left"
                    onClick={() => void initJoiner()}
                  >
                    <span className="flex flex-col items-start gap-0.5">
                      <span className="font-medium">{t('pairing.joinerRoleButton')}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {t('pairing.joinerRoleDescription')}
                      </span>
                    </span>
                  </Button>
                </div>
              )}

              {role !== 'chooser' && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="pairing-back-btn -ml-2 mb-2 self-start"
                    onClick={() => void handleBackToChooser()}
                  >
                    {t('pairing.backButton')}
                  </Button>

                  {/* Error message with Retry button (#282) */}
                  {error && (
                    <div
                      className="pairing-error flex items-center gap-2 mb-4"
                      role="alert"
                      aria-live="polite"
                    >
                      <p className="text-sm text-destructive flex-1">{error}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        ref={retryBtnRef}
                        onClick={handleRetry}
                        className="pairing-retry-btn shrink-0"
                      >
                        {t('pairing.retryButton')}
                      </Button>
                    </div>
                  )}

                  {/* Loading state — QR-shaped square placeholder + entry-row
                      placeholders instead of a bare centered spinner, mirroring
                      the PairingQrDisplay + PairingEntryForm layout that
                      replaces it once the pairing session starts. */}
                  {loading && (
                    <div className="pairing-loading flex flex-col items-center gap-3 py-6">
                      <span className="text-sm text-muted-foreground">
                        {t('pairing.startingMessage')}
                      </span>
                      <LoadingSkeleton
                        count={1}
                        height="h-40"
                        className="w-40"
                        ariaLabel={t('pairing.startingMessage')}
                      />
                      <LoadingSkeleton count={2} height="h-10" loading={false} className="w-full" />
                    </div>
                  )}

                  {/* QR + Passphrase display — host only */}
                  {!loading && role === 'host' && pairingInfo && (
                    <PairingQrDisplay
                      qrSvg={pairingInfo.qr_svg}
                      passphrase={pairingInfo.passphrase}
                      countdownDisplay={countdownDisplay}
                      countdown={countdown}
                      isExpired={isExpired}
                      error={error}
                      onRetry={handleRetry}
                      retryBtnRef={retryBtnRef}
                      pausedByTyping={pausedByTyping}
                    />
                  )}

                  {/* Passphrase entry — joiner only */}
                  {!loading && role === 'joiner' && (
                    <PairingEntryForm
                      words={words}
                      entryMode={entryMode}
                      onEntryModeChange={setEntryMode}
                      onWordChange={handleWordChange}
                      onWordKeyDown={handleWordKeyDown}
                      onQrScan={handleQrScan}
                      onQrError={(err) => setError(t('pairing.cameraError', { error: err }))}
                      onCancel={handleCancel}
                      onPair={handlePair}
                      pairLoading={pairLoading}
                      isExpired={false}
                      onTypingStateChange={handleTypingStateChange}
                    />
                  )}

                  {/* Paired Devices */}
                  {!loading && (
                    <PairingPeersList
                      peers={peers}
                      onUnpair={(peerId) => setUnpairPeerId(peerId)}
                    />
                  )}

                  {/* Status message for screen readers */}
                  <div aria-live="polite" className="sr-only">
                    {loading && t('pairing.startingMessage')}
                    {pairLoading && t('pairing.inProgress')}
                    {error}
                  </div>
                </>
              )}
            </div>
          </Body>
        </Content>
      </Root>

      {/* #301: Use shared UnpairConfirmDialog */}
      <UnpairConfirmDialog
        open={!!unpairPeerId}
        onOpenChange={(o) => {
          if (!o) setUnpairPeerId(null)
        }}
        onConfirm={() => {
          if (unpairPeerId) handleUnpair(unpairPeerId)
        }}
        className="pairing-unpair-confirm"
      />

      {/* Mid-pair close guard. Cancelling a pairing in flight is
          destructive (the in-flight handshake is dropped). Migrated to
          the unified ConfirmDialog (UX-review-2026-05-09 item 11) — the
          wrapper auto-closes via onOpenChange(false) on confirm-handler
          success, so the inline `setConfirmCloseOpen(false)` call is no
          longer needed. */}
      <ConfirmDialog
        open={confirmCloseOpen}
        onOpenChange={setConfirmCloseOpen}
        titleKey="pairing.confirmCloseTitle"
        descriptionKey="pairing.confirmCloseDescription"
        cancelKey="pairing.confirmCloseKeep"
        confirmKey="pairing.confirmCloseAction"
        variant="destructive"
        onConfirm={handleCancel}
        className="pairing-close-confirm"
      />
    </>
  )
}
