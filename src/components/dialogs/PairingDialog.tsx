/**
 * PairingDialog -- modal dialog for device pairing (#219).
 *
 * #3463 — pairing only works when exactly one of the two devices shows a
 * code (the "host") and the other enters it (the "joiner"). The dialog
 * opens directly on the host path (this device's own code, no upfront
 * question) because that is the common case and a device is pairable the
 * moment the dialog is open. Choosing to enter a code instead — via the
 * "Have a code from the other device?" affordance on the host screen — is
 * what declares the joiner role; that switch cancels the host's own
 * session first (`cancelPairing`) so this device stops offering a code it
 * is no longer showing. The two roles' UI stays mutually exclusive by
 * construction — `role` is a single value, not two booleans, so "both at
 * once" (the #3463 shape) is not representable. Only the host path calls
 * `commands.startPairing()`; only the joiner path renders the entry
 * form/QR-scanner and calls `commands.confirmPairing()`.
 *
 * Sections (each extracted as a sub-component for testability):
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
import { PairingWaitingState } from '@/components/peers/PairingWaitingState'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { DialogBody } from '@/components/ui/dialog'
import { SheetBody } from '@/components/ui/sheet'
import { useDialogOrSheet } from '@/hooks/useDialogOrSheet'
import { useIpcCommand } from '@/hooks/useIpcCommand'
import { usePollingQuery } from '@/hooks/usePollingQuery'
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

// #3469 — how often the joiner polls `list_peer_refs` while waiting for the
// peer to appear (TOFU-pin on first authenticated connection). There is no
// push notification for "a peer just got pinned" distinct from the generic
// `blocks:changed`/sync events, so this is a plain interval poll, matching
// the existing `usePollingQuery` convention used elsewhere in the app.
const PAIRING_PEER_POLL_INTERVAL_MS = 2000

// #3463 — a single union value (rather than e.g. `isHost: boolean` +
// `isJoiner: boolean`) so "both roles at once" — the bug this fix
// addresses — is not representable in the type. Only the entry point
// changed (host by default, no chooser step); this exclusivity property
// is what actually prevents the bug and is preserved unchanged.
type PairingRole = 'host' | 'joiner'

// #3469 — the joiner's local phase within its own role. 'entry' is the
// passphrase-input form; 'waiting' is entered after `confirm_pairing`
// resolves and lasts until the peer is observed (success), a wire-level
// rejection is observed (failure), or the TTL elapses (timeout) — at which
// point it returns to 'entry' with an affordance to retype. Host-only state
// (`pairingInfo`/`countdown`) is untouched by this; a single union value for
// the same reason `PairingRole` is one — "waiting AND showing the form" must
// not be representable.
type JoinerPhase = 'entry' | 'waiting'

// #3469 (review) — a poll result carries the id of the wait it was fetched
// FOR, captured when the request starts. The dialog is mounted
// unconditionally by `DeviceManagement` and `usePollingQuery` never clears
// its `data` when `enabled` flips false, so the previous attempt's peer list
// is still sitting there the instant the next wait begins — before that
// wait's own first fetch has resolved. Judging a fresh (correctly empty)
// baseline against that leftover list reports the peer the user just
// unpaired as brand new, which is #3469 returning through unpair-then-repair.
//
// The token travels WITH the data rather than being counted separately on
// the side: "some fetch started after waiting began" would not establish
// that the value currently in `data` came from it — `usePollingQuery` leaves
// the old value in place until the new request resolves. Matching the id
// stamped on the value itself is the only form of the check with no window.
interface PolledPeerRefs {
  session: number
  peers: PeerRefRow[]
}

export function PairingDialog({
  open,
  onOpenChange,
  triggerRef,
}: PairingDialogProps): React.ReactElement | null {
  const [role, setRole] = useState<PairingRole>('host')
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
  // #3469 — joiner-only waiting state (see `JoinerPhase`) and its own TTL
  // countdown, bounded by the same pending-pairing TTL the host's QR session
  // uses (`PAIRING_TIMEOUT_SECONDS` — no distinct joiner-side binding is
  // exposed to the frontend; see the constant's comment).
  const [joinerPhase, setJoinerPhase] = useState<JoinerPhase>('entry')
  const [waitCountdown, setWaitCountdown] = useState<number | null>(null)

  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement>(null)
  const retryBtnRef = useRef<HTMLButtonElement>(null)
  // Tracks the paste-focus setTimeout so we can cancel it on unmount and
  // Avoid focusing a stale DOM node (#).
  const pendingFocusRef = useRef<number | null>(null)
  // True only once `startPairing` has actually succeeded (host path). Gates
  // every `cancelPairing` call (close/unmount cleanup, explicit Cancel,
  // switching to the joiner path) so we never cancel a session that was
  // never started — required because the joiner path never calls
  // `startPairing` at all.
  const sessionStartedRef = useRef(false)
  // #3469 — snapshot of known peer ids taken the instant waiting begins, so
  // the poll below can detect a genuinely NEW peer (the TOFU-pin signal)
  // rather than false-triggering on peers that were already paired before
  // this attempt. Likewise `waitErrorBaselineRef` snapshots the shared sync
  // store's error string at the same moment, so a STALE unrelated error
  // already sitting in the store can't be mistaken for this attempt's
  // rejection — only a change away from the baseline counts.
  //
  // `null` means the baseline is UNKNOWN — the authoritative read failed.
  // It must never be conflated with "no peers known": with an empty
  // baseline, every peer this device was ALREADY paired with looks brand
  // new to the first successful poll, and the dialog reports "Device
  // paired successfully" for a peer that has nothing to do with this
  // attempt — the exact false success #3469 exists to remove. The success
  // effect therefore fails CLOSED on `null` and adopts the first poll as
  // the baseline instead.
  const knownPeerIdsRef = useRef<Set<string> | null>(new Set())
  const waitErrorBaselineRef = useRef<string | null>(null)
  // #3469 (review) — monotonic id of the current wait, bumped the instant a
  // wait begins. Scopes poll results to the attempt they are judged against;
  // see `PolledPeerRefs` for why the baseline alone is not enough.
  const waitSessionRef = useRef(0)

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
  // #3469 — the responder rejects a bad pairing proof over the wire with
  // `"pairing passphrase proof required"` (sync_daemon/server.rs); today
  // that reaches this device only via the generic `sync:error` Tauri event
  // → `useSyncStore.setState('error', message)` (useSyncEvents.ts). Reading
  // the store's `error` field here — rather than adding a second listener —
  // reuses that exact, already-wired signal instead of duplicating it.
  const syncError = useSyncStore((s) => s.error)

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

  // #3463 — opening the dialog resets local state and starts a fresh host
  // session every time `open` flips true: this device shows its own code
  // immediately (no upfront role question). This DOES fire a backend call
  // on every open (`start_pairing`, which arms the 5-minute pending-pairing
  // marker and wakes the sync daemon) — a deliberate change from the
  // chooser design, and an accepted trade: the host must be pairable the
  // moment the dialog is open. Switching to the joiner path cancels this
  // session (see `handleSwitchToJoiner`) so it never runs uncancelled
  // alongside a joiner attempt.
  useEffect(() => {
    if (!open) return
    setPairingInfo(null)
    setWords(['', '', '', ''])
    setPeers([])
    setError(null)
    setCountdown(null)
    setEntryMode('manual')
    setJoinerPhase('entry')
    setWaitCountdown(null)
    sessionStartedRef.current = false
    void initHost()
  }, [open, initHost])

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

  // #3469 — while the joiner is 'waiting', poll `list_peer_refs` for the
  // TOFU-pin that is the ONLY observable evidence the passphrase matched.
  // `usePollingQuery` is the existing reusable polling hook (used elsewhere
  // for the same fixed-interval-while-mounted shape); it pauses while the
  // tab is hidden and refetches on visibility return, same as everywhere
  // else it's used.
  //
  // The wait id is read when the request STARTS, so a response that lands
  // after the wait it belongs to has ended is recognisable as stale.
  const pollPeerRefs = useCallback(async (): Promise<PolledPeerRefs> => {
    const session = waitSessionRef.current
    const rows = await commands.listPeerRefs().then((r) => unwrap(r))
    return { session, peers: rows }
  }, [])
  const { data: polled } = usePollingQuery<PolledPeerRefs>(pollPeerRefs, {
    intervalMs: PAIRING_PEER_POLL_INTERVAL_MS,
    enabled: joinerPhase === 'waiting',
  })

  // Success: a peer id appears that was not present in the snapshot taken
  // when waiting began. This is the ONLY path allowed to claim the pairing
  // succeeded — it is the first moment this device actually knows the
  // passphrase matched (the responder pins the peer only after its own
  // proof comparison passes).
  useEffect(() => {
    if (joinerPhase !== 'waiting' || !polled) return
    // Left over from a previous wait (or from before this one's first fetch
    // resolved) — carries no information about this attempt. Discarding it
    // also keeps it out of the baseline-adoption path below.
    if (polled.session !== waitSessionRef.current) return
    const polledPeers = polled.peers
    const known = knownPeerIdsRef.current
    if (known === null) {
      // Baseline unknown (the confirm-time read failed). Fail closed:
      // adopt this first successful poll as the baseline so only peers
      // that appear AFTER it can resolve the wait. The cost is that a pin
      // landing before this poll is missed and the wait falls through to
      // the TTL — strictly better than claiming success for a peer that
      // predates the attempt.
      knownPeerIdsRef.current = new Set(polledPeers.map((p) => p.peer_id))
      return
    }
    const newPeer = polledPeers.find((p) => !known.has(p.peer_id))
    if (!newPeer) return
    setPeers(polledPeers)
    useSyncStore.getState().setPeers(polledPeers.map(mapPeerRefToInfo))
    setJoinerPhase('entry')
    setWaitCountdown(null)
    setWords(['', '', '', ''])
    announce(t('announce.pairingSucceeded'))
    notify.success(t('pairing.pairSuccessMessage'))
    onOpenChange(false)
  }, [polled, joinerPhase, t, onOpenChange])

  // Failure: the responder's wire-level proof rejection reaches this device
  // as a generic `sync:error` → `useSyncStore` error string (see `syncError`
  // above). Only a value that (a) changed from the baseline snapshot taken
  // when waiting began and (b) carries the specific rejection tag counts —
  // an unrelated pre-existing/stale store error must not false-trigger this.
  useEffect(() => {
    if (joinerPhase !== 'waiting' || !syncError) return
    if (syncError === waitErrorBaselineRef.current) return
    if (!syncError.includes('pairing passphrase proof required')) return
    setJoinerPhase('entry')
    setWaitCountdown(null)
    setWords(['', '', '', ''])
    setError(t('pairing.proofRejectedError'))
    announce(t('announce.pairingProofRejected'))
  }, [syncError, joinerPhase, t])

  // Bound the wait by the same pending-pairing TTL the host countdown uses
  // (`PAIRING_TIMEOUT_SECONDS`) — 1s tick, mirroring the host countdown
  // effect below it in shape.
  const waitCountdownActive =
    joinerPhase === 'waiting' && waitCountdown !== null && waitCountdown > 0
  useEffect(() => {
    if (!waitCountdownActive) return
    const interval = setInterval(() => {
      setWaitCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval)
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [waitCountdownActive])

  // Timeout: the TTL elapsed with neither success nor a rejection observed.
  useEffect(() => {
    if (joinerPhase !== 'waiting' || waitCountdown !== 0) return
    setJoinerPhase('entry')
    setWords(['', '', '', ''])
    setError(t('pairing.waitTimedOut'))
    announce(t('announce.pairingWaitTimedOut'))
  }, [joinerPhase, waitCountdown, t])

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

  // Confirm pairing with the entered passphrase. #3469 — `confirm_pairing`
  // only arms this device's local pairing proof; it does NOT validate the
  // passphrase against the other device (that was the #3463 defect). A typo
  // (or a stale/expired code) reaches this same `onSuccess` just as cleanly
  // as a correct entry — the mismatch is only discoverable later, on the
  // wire, when the two devices' proofs are compared. So `onSuccess` here
  // must NOT claim the pairing succeeded and must NOT close the dialog: it
  // enters the WAITING phase (see the polling/failure/timeout effects
  // above), which resolves to success/failure/timeout once the actual
  // outcome is observable. Joiner-only — the host never renders the form
  // that calls this.
  const { execute: executePair } = useIpcCommand<{ passphrase: string }, void>({
    call: async ({ passphrase }) => {
      // remoteDeviceId is derived from the passphrase in the pairing protocol
      unwrap(await commands.confirmPairing(passphrase, ''))
      syncSetState('idle')
      // #3469 (review) — take the "peers we already had" baseline HERE,
      // from an authoritative read at the moment the proof is armed, not
      // from the `peers` React state. That state is filled by the peer
      // load that ran when the dialog opened / the joiner role was picked,
      // so by now it is at best seconds stale and is EMPTY whenever that
      // load failed — and an empty baseline turns this device's existing
      // peers into a false "paired successfully" on the first poll.
      //
      // A failure here must not fail the pairing: the local proof is
      // already armed and there is no way to un-arm it, so the wait
      // proceeds with an explicitly UNKNOWN baseline (see the ref's
      // comment) rather than a wrong one.
      try {
        const snapshot = unwrap(await commands.listPeerRefs())
        knownPeerIdsRef.current = new Set(snapshot.map((p) => p.peer_id))
      } catch {
        knownPeerIdsRef.current = null
      }
    },
    module: 'PairingDialog',
    errorLogMessage: 'Pairing failed',
    onSuccess: () => {
      // The peer baseline is snapshotted in `call` above (it needs an
      // authoritative read, which is async). This snapshots the other half:
      // the shared sync store's error string, so a STALE unrelated error
      // already sitting in the store can't be mistaken for this attempt's
      // rejection.
      waitErrorBaselineRef.current = useSyncStore.getState().error
      // #3469 (review) — open a new wait id. Every poll result stamped with
      // an older id (including the whole of the previous attempt's, which
      // `usePollingQuery` still holds in `data`) is now unusable as evidence
      // for this attempt. Bumped here rather than in `call` so the id
      // advances exactly once per wait that actually starts.
      waitSessionRef.current += 1
      setWaitCountdown(PAIRING_TIMEOUT_SECONDS)
      setJoinerPhase('waiting')
      announce(t('announce.pairingWaiting'))
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

  // Resets role/session-scoped local state back to a clean shape when the
  // dialog is closed via `handleCancel`. (The `open` effect performs the
  // equivalent reset — plus re-starting a fresh host session — the next
  // time the dialog opens, so this mostly matters for the brief window
  // before that effect re-runs.)
  const resetRoleState = useCallback(() => {
    setRole('host')
    setPairingInfo(null)
    setWords(['', '', '', ''])
    setPeers([])
    setError(null)
    setCountdown(null)
    setEntryMode('manual')
    setJoinerPhase('entry')
    setWaitCountdown(null)
  }, [])

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

  // #3463 — switching to the joiner path is what DECLARES the joiner role
  // (replacing the removed upfront chooser question). Crucially, this
  // cancels the host's own session first (`cancelPairing` clears the
  // backend's in-memory `pairing_state` slot — see sync_cmds.rs
  // `cancel_pairing_inner`) so this device stops offering a code it is no
  // longer showing. Without this, a device could simultaneously be
  // offering its own code (host) and entering another's (joiner) — the
  // #3463 shape wearing a different hat.
  const handleSwitchToJoiner = useCallback(async () => {
    if (sessionStartedRef.current) {
      sessionStartedRef.current = false
      await executeCancelPairingCleanup()
    }
    setPairingInfo(null)
    setCountdown(null)
    setWords(['', '', '', ''])
    setEntryMode('manual')
    setError(null)
    setJoinerPhase('entry')
    setWaitCountdown(null)
    await initJoiner()
  }, [executeCancelPairingCleanup, initJoiner])

  // Reversible: switching back to the host path re-initialises a fresh
  // host session (this device had none while it was a joiner).
  const handleSwitchToHost = useCallback(async () => {
    setWords(['', '', '', ''])
    setEntryMode('manual')
    setJoinerPhase('entry')
    setWaitCountdown(null)
    await initHost()
  }, [initHost])

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

  // #3469 — same `mm:ss` formatting for the joiner's post-confirm wait,
  // bounding it by the same `PAIRING_TIMEOUT_SECONDS` pending-marker TTL.
  const waitCountdownDisplay =
    waitCountdown !== null && waitCountdown > 0
      ? `${Math.floor(waitCountdown / 60)}:${String(waitCountdown % 60).padStart(2, '0')}`
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
    // #3469: the WAITING phase is a real in-flight handshake from the
    // backend's point of view (a pending pairing marker is armed) even
    // though `pairLoading` itself has already settled back to false — guard
    // it the same way so Esc/backdrop-click doesn't silently abandon it.
    if (pairLoading || joinerPhase === 'waiting') {
      setConfirmCloseOpen(true)
      return
    }
    handleCancel()
  }, [pairLoading, joinerPhase, handleCancel])

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

              {/* QR + Passphrase display — host only. Gated on `pairingInfo`
                  because it has nothing to render without a session. */}
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
                />
              )}

              {/* The affordance (#3463) that switches to the joiner path.
                  Choosing this is what DECLARES the joiner role — see
                  `handleSwitchToJoiner`. Deliberately NOT gated on
                  `pairingInfo`: it must stay reachable even when the host
                  session failed to start (error banner above) or resolved
                  with no data, so a user can always get to the joiner path
                  regardless of whether this device's own code loaded. */}
              {!loading && role === 'host' && (
                <Button
                  variant="link"
                  size="sm"
                  className="pairing-switch-to-joiner-btn self-start px-0 h-auto"
                  onClick={() => void handleSwitchToJoiner()}
                >
                  {t('pairing.switchToJoinerLink')}
                </Button>
              )}

              {/* Passphrase entry — joiner only, plus the affordance
                  (#3463) that switches back to the host path. Reversible by
                  design — see `handleSwitchToHost`. Hidden once the local
                  proof is armed and this device has moved into the #3469
                  WAITING phase below — there is nothing left to type and
                  switching roles mid-wait would abandon the pending marker
                  without going through the close guard. */}
              {!loading && role === 'joiner' && joinerPhase === 'entry' && (
                <>
                  <Button
                    variant="link"
                    size="sm"
                    className="pairing-switch-to-host-btn self-start px-0 h-auto mb-2"
                    onClick={() => void handleSwitchToHost()}
                  >
                    {t('pairing.switchToHostLink')}
                  </Button>
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
                  />
                </>
              )}

              {/* #3469 — honest waiting state after `confirm_pairing`. This
                  device has armed its local proof but cannot yet know
                  whether it matches the peer's; see the polling/failure/
                  timeout effects above for how this resolves. */}
              {!loading && role === 'joiner' && joinerPhase === 'waiting' && (
                <PairingWaitingState
                  waitCountdownDisplay={waitCountdownDisplay}
                  onCancel={handleCancel}
                />
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
