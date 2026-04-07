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

  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement>(null)
  const retryBtnRef = useRef<HTMLButtonElement>(null)

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

  // init function extracted so it can be called for retry (#282)
  const init = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [info, peerList] = await Promise.all([startPairing(), listPeerRefs()])
      setPairingInfo(info)
      setPeers(peerList)
      setCountdown(PAIRING_TIMEOUT_SECONDS)
    } catch (err) {
      logger.error('PairingDialog', 'Failed to initialize pairing', { error: String(err) })
      setError(`Failed to start pairing: ${String(err instanceof Error ? err.message : err)}`)
    }
    setLoading(false)
  }, [])

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
      cancelPairing().catch(() => toast.error(t('pairing.cancelFailed')))
    }
  }, [open, init, t])

  // Countdown timer (#294) — only re-run effect when active/inactive changes
  const countdownActive = countdown !== null && countdown > 0
  useEffect(() => {
    if (!countdownActive) return

    const interval = setInterval(() => {
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
        setTimeout(() => {
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

  const handlePair = useCallback(async () => {
    const passphrase = words.join(' ').trim()
    if (!passphrase || words.some((w) => w === '')) return

    setPairLoading(true)
    setError(null)
    try {
      // remoteDeviceId is derived from the passphrase in the pairing protocol
      await confirmPairing(passphrase, '')
      syncSetState('idle')
      // Refresh peer list
      const peerList = await listPeerRefs()
      setPeers(peerList)
      setWords(['', '', '', ''])
      toast.success(t('pairing.successMessage'))
      onOpenChange(false)
    } catch (err) {
      logger.error('PairingDialog', 'Pairing failed', { error: String(err) })
      setError(`Pairing failed: ${String(err instanceof Error ? err.message : err)}`)
    }
    setPairLoading(false)
  }, [words, syncSetState, onOpenChange, t])

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
      logger.error('PairingDialog', 'Failed to cancel pairing', { error: String(err) }),
    )
    setPairingInfo(null)
    setWords(['', '', '', ''])
    setError(null)
    setCountdown(null)
    setEntryMode('manual')
    onOpenChange(false)
    // #288: Return focus to trigger element
    triggerRef?.current?.focus()
  }, [onOpenChange, triggerRef])

  const handleUnpair = useCallback(async (peerId: string) => {
    try {
      await deletePeerRef(peerId)
      setPeers((prev) => prev.filter((p) => p.peer_id !== peerId))
      setUnpairPeerId(null)
    } catch (err) {
      logger.error('PairingDialog', 'Failed to unpair device', { error: String(err) })
      setError(`Failed to unpair device: ${String(err instanceof Error ? err.message : err)}`)
    }
  }, [])

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

  if (!open) return null

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) handleCancel()
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
                {pairLoading && 'Pairing in progress...'}
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
    </>
  )
}
