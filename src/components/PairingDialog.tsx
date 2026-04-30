/**
 * PairingDialog -- modal dialog for device pairing (#219).
 *
 * Three sections (each extracted as a sub-component for testability):
 *  1. QR code + passphrase display (PairingQrDisplay)
 *  2. Passphrase entry (PairingEntryForm)
 *  3. List of already-paired devices (PairingPeersList)
 *
 * Props: open (boolean), onOpenChange (callback), triggerRef (optional).
 */

import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { useIpcCommand } from '@/hooks/useIpcCommand'
import { announce } from '@/lib/announcer'
import { logger } from '@/lib/logger'
import type { PeerRefRow } from '../lib/tauri'
import {
  cancelPairing,
  confirmPairing,
  deletePeerRef,
  listPeerRefs,
  startPairing,
} from '../lib/tauri'
import { useSyncStore } from '../stores/sync'
import { ConfirmDestructiveAction } from './ConfirmDestructiveAction'
import { PairingEntryForm } from './PairingEntryForm'
import { PairingPeersList } from './PairingPeersList'
import { PairingQrDisplay } from './PairingQrDisplay'
import { UnpairConfirmDialog } from './UnpairConfirmDialog'

interface PairingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  triggerRef?: React.RefObject<HTMLButtonElement | null>
}

const PAIRING_TIMEOUT_SECONDS = 300 // 5 minutes

export function PairingDialog({
  open,
  onOpenChange,
  triggerRef,
}: PairingDialogProps): React.ReactElement | null {
  const [pairingInfo, setPairingInfo] = useState<{
    passphrase: string
    qr_svg: string
    port: number
  } | null>(null)
  const [words, setWords] = useState<[string, string, string, string]>(['', '', '', ''])
  const [peers, setPeers] = useState<PeerRefRow[]>([])
  const [loading, setLoading] = useState(false)
  const [pairLoading, setPairLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unpairPeerId, setUnpairPeerId] = useState<string | null>(null)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [entryMode, setEntryMode] = useState<'manual' | 'scan'>('manual')
  // UX-263: Guard against accidentally closing the dialog mid-handshake.
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false)
  // UX-263: Pause the countdown while the user is mid-keystroke in the
  // passphrase inputs so an in-flight handshake doesn't fail to a tick
  // boundary. PairingEntryForm enforces a 5s idle debounce so an idle
  // user with focus can't keep this true forever.
  const [pausedByTyping, setPausedByTyping] = useState(false)

  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement>(null)
  const retryBtnRef = useRef<HTMLButtonElement>(null)
  // Tracks the paste-focus setTimeout so we can cancel it on unmount and
  // avoid focusing a stale DOM node (#MAINT-12).
  const pendingFocusRef = useRef<number | null>(null)

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

  // MAINT-120: bootstrap the pairing session via the shared useIpcCommand
  // hook. The error template literal mirrors the existing inline format
  // so the error banner copy stays byte-equivalent.
  const { execute: executeInit } = useIpcCommand<
    void,
    [{ passphrase: string; qr_svg: string; port: number }, PeerRefRow[]]
  >({
    call: () => Promise.all([startPairing(), listPeerRefs()]),
    module: 'PairingDialog',
    errorLogMessage: 'Failed to initialize pairing',
    onSuccess: ([info, peerList]) => {
      setPairingInfo(info)
      setPeers(peerList)
      setCountdown(PAIRING_TIMEOUT_SECONDS)
    },
    onError: (err) => {
      setError(`Failed to start pairing: ${String(err instanceof Error ? err.message : err)}`)
    },
  })

  // init function extracted so it can be called for retry (#282)
  const init = useCallback(async () => {
    setLoading(true)
    setError(null)
    await executeInit()
    setLoading(false)
  }, [executeInit])

  // MAINT-120: cleanup-side cancelPairing — fires when the dialog closes
  // or unmounts. Logger.warn + toast.error matches the original inline
  // shape (handleCancel uses a different logger.error-only flavor that
  // stays inline because it has no toast).
  const { execute: executeCancelPairingCleanup } = useIpcCommand<void, void>({
    call: () => cancelPairing(),
    module: 'PairingDialog',
    errorLogMessage: 'cancelPairing on close/unmount failed',
    logLevel: 'warn',
    onError: () => {
      toast.error(t('pairing.cancelFailed'))
    },
  })

  // Load pairing info and peer list when dialog opens;
  // cancel the pairing session on close/unmount to avoid leaking the listener.
  useEffect(() => {
    if (!open) return

    let cancelled = false

    async function doInit() {
      await init()
    }

    doInit().then(() => {
      if (cancelled) {
        // Component closed before init finished — clean up
      }
    })

    return () => {
      cancelled = true
      // Cancel any in-progress pairing when the dialog closes or unmounts
      void executeCancelPairingCleanup()
    }
  }, [open, init, executeCancelPairingCleanup])

  // Countdown timer (#294) — only re-run effect when active/inactive changes.
  // UX-263: Read the pause flag through a ref inside the interval so flipping
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

  // UX-263: Single setter that updates both the ref (read by the interval)
  // and the state (drives the "Paused while typing…" indicator render).
  // Announces the pause / resume transition so screen-reader users — who
  // can't see the inline "Paused while typing…" indicator (it sits inside
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

  // UX-263: Announce countdown crossings at SR-relevant thresholds only.
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

  // Focus first word input when pairing info is loaded
  useEffect(() => {
    if (open && pairingInfo) {
      const inputs = getWordInputs()
      inputs[0]?.focus()
    }
  }, [open, pairingInfo, getWordInputs])

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

  // MAINT-120: confirm pairing with the entered passphrase + refresh the
  // peer list. Failures in either of the two underlying calls produce
  // the same "Pairing failed:" banner — matches existing behavior where
  // a post-confirm `listPeerRefs()` rejection is reported under the same
  // label. `setWords` / success toast / dialog close run only on full
  // success via `onSuccess`.
  const { execute: executePair } = useIpcCommand<{ passphrase: string }, void>({
    call: async ({ passphrase }) => {
      // remoteDeviceId is derived from the passphrase in the pairing protocol
      await confirmPairing(passphrase, '')
      syncSetState('idle')
      // Refresh peer list
      const peerList = await listPeerRefs()
      setPeers(peerList)
    },
    module: 'PairingDialog',
    errorLogMessage: 'Pairing failed',
    onSuccess: () => {
      setWords(['', '', '', ''])
      toast.success(t('pairing.successMessage'))
      onOpenChange(false)
    },
    onError: (err) => {
      setError(`Pairing failed: ${String(err instanceof Error ? err.message : err)}`)
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
      toast.success(t('pairing.qrScannedMessage'))
    },
    [t],
  )

  const handleCancel = useCallback(() => {
    // Cancel any in-progress pairing session
    cancelPairing().catch((err) =>
      logger.error('PairingDialog', 'Failed to cancel pairing', undefined, err),
    )
    setPairingInfo(null)
    setWords(['', '', '', ''])
    setError(null)
    setCountdown(null)
    setEntryMode('manual')
    // UX-263: Clear any stale paused state (ref + render state) so a
    // future re-open starts fresh.
    handleTypingStateChange(false)
    onOpenChange(false)
    // #288: Return focus to trigger element
    triggerRef?.current?.focus()
  }, [onOpenChange, triggerRef, handleTypingStateChange])

  // MAINT-120: unpair a peer device. Same template-literal error format
  // as `handlePair` / `init` so the existing inline banner is preserved.
  const { execute: executeUnpair } = useIpcCommand<{ peerId: string }, void>({
    call: ({ peerId }) => deletePeerRef(peerId),
    module: 'PairingDialog',
    errorLogMessage: 'Failed to unpair device',
    onSuccess: (_result, { peerId }) => {
      setPeers((prev) => prev.filter((p) => p.peer_id !== peerId))
      setUnpairPeerId(null)
    },
    onError: (err) => {
      setError(`Failed to unpair device: ${String(err instanceof Error ? err.message : err)}`)
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

  // UX-263: When the user attempts to close the dialog (Esc, X button, or
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

  if (!open) return null

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) handleAttemptClose()
        }}
      >
        <DialogContent
          className="pairing-dialog gap-0"
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            if (triggerRef?.current) {
              e.preventDefault()
              triggerRef.current.focus()
            }
          }}
        >
          <ScrollArea className="max-h-[calc(100dvh-4rem)]">
            <div ref={dialogRef}>
              {/* Header */}
              <DialogHeader className="text-left mb-4">
                <DialogTitle>{t('pairing.dialogTitle')}</DialogTitle>
              </DialogHeader>

              {/* Error message with Retry button (#282) */}
              {error && (
                <div className="pairing-error flex items-center gap-2 mb-4" aria-live="polite">
                  <p className="text-sm text-destructive flex-1">{error}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    ref={retryBtnRef}
                    onClick={() => init()}
                    className="pairing-retry-btn shrink-0"
                  >
                    Retry
                  </Button>
                </div>
              )}

              {/* Loading state */}
              {loading && (
                <div className="pairing-loading flex items-center justify-center py-8">
                  <Spinner className="text-muted-foreground" />
                  <span className="ml-2 text-sm text-muted-foreground">
                    {t('pairing.startingMessage')}
                  </span>
                </div>
              )}

              {/* QR + Passphrase display and Entry form */}
              {!loading && pairingInfo && (
                <>
                  <PairingQrDisplay
                    qrSvg={pairingInfo.qr_svg}
                    passphrase={pairingInfo.passphrase}
                    countdownDisplay={countdownDisplay}
                    countdown={countdown}
                    isExpired={isExpired}
                    error={error}
                    onRetry={() => init()}
                    retryBtnRef={retryBtnRef}
                    pausedByTyping={pausedByTyping}
                  />

                  <PairingEntryForm
                    words={words}
                    entryMode={entryMode}
                    onEntryModeChange={setEntryMode}
                    onWordChange={handleWordChange}
                    onWordKeyDown={handleWordKeyDown}
                    onQrScan={handleQrScan}
                    onQrError={(err) => setError(`Camera error: ${err}`)}
                    onCancel={handleCancel}
                    onPair={handlePair}
                    pairLoading={pairLoading}
                    isExpired={isExpired}
                    onTypingStateChange={handleTypingStateChange}
                  />
                </>
              )}

              {/* Paired Devices */}
              {!loading && (
                <PairingPeersList peers={peers} onUnpair={(peerId) => setUnpairPeerId(peerId)} />
              )}

              {/* Status message for screen readers */}
              <div aria-live="polite" className="sr-only">
                {loading && t('pairing.startingMessage')}
                {pairLoading && t('pairing.inProgress')}
                {error}
              </div>
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

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

      {/* UX-263: Mid-pair close guard. Cancelling a pairing in flight is
          destructive (the in-flight handshake is dropped). Migrated to
          ConfirmDestructiveAction (MAINT-130a) — the wrapper auto-closes
          via onOpenChange(false) on confirm-handler success, so the
          inline `setConfirmCloseOpen(false)` call is no longer needed. */}
      <ConfirmDestructiveAction
        open={confirmCloseOpen}
        onOpenChange={setConfirmCloseOpen}
        titleKey="pairing.confirmCloseTitle"
        descriptionKey="pairing.confirmCloseDescription"
        cancelKey="pairing.confirmCloseKeep"
        confirmKey="pairing.confirmCloseAction"
        onConfirm={handleCancel}
        className="pairing-close-confirm"
      />
    </>
  )
}
