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
import type { PairingInfo, PeerRef } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { formatErrorForDisplay } from '@/lib/error-display'
import { notify } from '@/lib/notify'
// #3492/#3504 — the rejection strings the Rust responder puts on the wire, in
// the one module both this dialog and `useSyncEvents` read them from. Keep the
// matcher below referring to the BINDING: a re-inlined literal would satisfy
// the cross-language guard's value comparison while the matcher itself drifted,
// so the guard checks for the reference too.
import { PAIRING_PROOF_REQUIRED_MESSAGE } from '@/lib/pairing-rejections'
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
  peers: PeerRef[]
}

export function PairingDialog({
  open,
  onOpenChange,
  triggerRef,
}: PairingDialogProps): React.ReactElement | null {
  const [role, setRole] = useState<PairingRole>('host')
  const [pairingInfo, setPairingInfo] = useState<PairingInfo | null>(null)
  const [words, setWords] = useState<[string, string, string, string]>(['', '', '', ''])
  const [peers, setPeers] = useState<PeerRef[]>([])
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
  // True while this device holds BACKEND-side pairing state that a
  // `cancelPairing` would tear down. Gates every `cancelPairing` call
  // (close/unmount cleanup, explicit Cancel, switching to the joiner path)
  // so we never fire one when there is nothing armed.
  //
  // #3493 — this used to be `sessionStartedRef`, set only by a successful
  // host-side `startPairing`. That name described the QR session, but the
  // thing cancel actually has to tear down is the DB-side pending-pairing
  // marker, and BOTH roles arm one: the host in `start_pairing` and the
  // joiner in `confirm_pairing`. Gating on "did the host start a session"
  // therefore made the joiner's Cancel — the button on the waiting screen,
  // i.e. the exact "cancel a pairing wait" the issue is about — a pure UI
  // act that left the marker armed for the rest of its 5-minute TTL, still
  // able to admit an unpaired device. The ref now tracks "is anything armed
  // on the backend", which is the question the gate is really asking.
  const backendArmedRef = useRef(false)
  // #3620 — the clear the close/unmount cleanup left in flight, if any. A
  // reopen awaits it before arming a new window, so the DELETE can never
  // land after the next `start_pairing` upsert and silently delete the
  // window the user is being shown. Held as a ref (not state) because it is
  // read across a close/reopen cycle and must never trigger a render.
  const pendingClearRef = useRef<Promise<void | undefined> | null>(null)
  // #3469 — snapshot of known peer ids taken the instant waiting begins, so
  // the poll below can detect a genuinely NEW peer (the TOFU-pin signal)
  // rather than false-triggering on peers that were already paired before
  // this attempt.
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
  // #3469 — a device rejects a bad pairing proof with
  // `PAIRING_PROOF_REQUIRED_MESSAGE` (sync_daemon/server.rs); that reaches this
  // dialog via the generic `sync:error` Tauri event →
  // `useSyncStore.setState('error', message)` (useSyncEvents.ts). Reading the
  // store's `error` field here — rather than adding a second listener — reuses
  // that exact, already-wired signal instead of duplicating it.
  //
  // #3491: this now fires for BOTH roles. The proof gate runs on the responder,
  // so the rejection used to arrive only when this device was the one that
  // dialled; the responder now raises the same message on its own event sink
  // too. Which side dials first is daemon timing, not a user choice, so before
  // that fix the same mistyped passphrase produced a two-second error or a
  // five-minute timeout depending on the race. The two origins are
  // indistinguishable here by design — one matcher, one code path.
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
      backendArmedRef.current = true
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
  const { execute: executeLoadPeers } = useIpcCommand<void, PeerRef[]>({
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
    // #3615 (review) — drop the previous window's baseline BEFORE the arm.
    // `start_pairing` and the peer read race each other inside the
    // `Promise.all` below, so `pairingInfo` (and with it the poll's arming
    // condition) can land while the new baseline is still in flight. Leaving
    // the old attempt's snapshot in place across that window lets the first
    // poll judge a fresh window against a baseline that predates it and
    // report an ALREADY-paired peer as a fresh pair. `null` = UNKNOWN, so
    // any poll that slips through fails closed and adopts a baseline instead
    // (see the ref's comment). `loading` gates the poll for the same window
    // — this is the belt to that braces, for the case where two `initHost`
    // runs overlap and the first one's `setLoading(false)` reopens it.
    knownPeerIdsRef.current = null
    const [, peerList] = await Promise.all([executeStartPairing(), executeLoadPeers()])
    // #3615 — the host's baseline for its own success detection, taken from
    // the same authoritative read that fills the paired-devices list. Same
    // semantics as the joiner's confirm-time snapshot: `undefined` (the
    // read failed) becomes an explicitly UNKNOWN baseline rather than an
    // empty one, so the success effect fails closed instead of reporting
    // every already-paired device as a fresh pair.
    knownPeerIdsRef.current = peerList ? new Set(peerList.map((p) => p.peer_id)) : null
    // Open the wait id only once the baseline is in place — a poll that
    // started before this point is stamped with the previous id and is
    // discarded rather than judged against a baseline it predates.
    waitSessionRef.current += 1
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
  // but ONLY if something is actually armed on the backend
  // (`backendArmedRef`, either role — #3493).
  //
  // #3610 (review) — closing the host dialog now genuinely disarms the
  // pairing window: before #3493 the backend clear here was a no-op, so a
  // joiner mid-attempt could still complete pairing after the host closed
  // its dialog; it can no longer do so. Defensible (it follows directly
  // from the marker-clear becoming unconditional) but worth knowing if
  // you're relying on "host closed the dialog" as harmless to an
  // in-flight joiner.
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
    backendArmedRef.current = false
    // #3620 — a reopen must not race the clear the previous close left in
    // flight. `cancel_pairing`'s DELETE and `start_pairing`'s upsert touch
    // the same single pending-pairing row, so an un-awaited clear landing
    // after the new arm deletes the window the user is looking at: QR on
    // screen, countdown ticking, nothing armed on the backend. Ordering the
    // arm behind the clear is the whole fix — see `pendingClearRef`.
    let superseded = false
    void (async () => {
      const pendingClear = pendingClearRef.current
      if (pendingClear) await pendingClear
      if (superseded) return
      await initHost()
    })()
    return () => {
      superseded = true
    }
  }, [open, initHost])

  // Cancel the pairing session on the backend when the dialog closes or
  // unmounts — but only if a session was actually started (host path that
  // successfully called `startPairing`). The joiner path never starts a
  // session, so this is a correct no-op for it.
  useEffect(() => {
    if (!open) return
    return () => {
      if (backendArmedRef.current) {
        backendArmedRef.current = false
        // #3620 — a React cleanup function cannot be async, so this clear
        // is necessarily fire-and-forget. Publish it so a reopen can wait
        // for it instead of racing it (see the open effect above).
        const clear = executeCancelPairingCleanup()
        pendingClearRef.current = clear
        void clear.finally(() => {
          if (pendingClearRef.current === clear) pendingClearRef.current = null
        })
      }
    }
  }, [open, executeCancelPairingCleanup])

  // Countdown timer (#294) — only re-run effect when active/inactive changes.
  const countdownActive = countdown !== null && countdown > 0
  const isExpired = countdown !== null && countdown <= 0
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

  // #3615 — the two shapes of "this device is holding a pairing window open
  // and does not yet know whether it completed": the host's un-expired QR,
  // and the joiner's post-confirm wait. They are the same situation seen
  // from the two ends of one handshake, and completion is observable to
  // both in exactly one way — a new row in `list_peer_refs`, written when a
  // device TOFU-pins its counterpart. One flag drives both the poll and the
  // success effect below, so the two roles cannot drift apart again: the
  // host previously had no success detection at all, so a completed pair
  // left its marker armed and closing the dialog fired a `cancel_pairing`
  // that owned nothing.
  //
  // `!loading && Boolean(pairingInfo)` is the render gate on the QR block
  // below, verbatim — the host's window is live for exactly as long as its
  // code is on screen. `!loading` is load-bearing, not decorative: `initHost`
  // holds `loading` from before it calls `start_pairing` until after the
  // baseline snapshot and the wait-id bump are both in place, so without it
  // the poll arms the instant `start_pairing` resolves — while the baseline
  // is still the PREVIOUS attempt's (or the initial empty set) and the wait
  // id still matches it. The first poll then finds every already-paired peer
  // "new" and announces "Device paired successfully" for a pair that never
  // happened, disarming `backendArmedRef` and orphaning the real window.
  // That is #3469's false success reaching the host through #3615's poll.
  const hostWindowShowing = role === 'host' && !loading && Boolean(pairingInfo) && !isExpired
  const awaitingPairResult = open && (joinerPhase === 'waiting' || hostWindowShowing)

  // #3469 — while a pairing window is open, poll `list_peer_refs` for the
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
    // #3496 — `open` flipping to `false` does NOT unmount this component:
    // `if (!open) return null` (below) sits after every hook, so without
    // this the poll keeps firing `list_peer_refs` every 2s on a closed
    // dialog. `usePollingQuery` itself cleans up correctly on a genuine
    // unmount; the bug is that a parent-driven close isn't one.
    // (`awaitingPairResult` folds `open` in — see its comment.)
    enabled: awaitingPairResult,
  })

  // Success: a peer id appears that was not present in the snapshot taken
  // when the window was armed. This is the ONLY path allowed to claim the
  // pairing succeeded — it is the first moment this device actually knows
  // the passphrase matched (a device pins its counterpart only after its
  // own proof comparison passes).
  //
  // #3615 — runs for BOTH roles (see `awaitingPairResult`). The joiner
  // snapshots its baseline when `confirm_pairing` resolves; the host
  // snapshots it in `initHost`, the instant `start_pairing` arms its
  // window.
  useEffect(() => {
    if (!awaitingPairResult || !polled) return
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
    // #3493 — the pairing COMPLETED: the peer is pinned, so this device's
    // pending-pairing marker has done its job and is no longer ours to
    // tear down. Disarm the ref before `onOpenChange(false)` below, or the
    // close/unmount cleanup would fire a `cancel_pairing` on the way out of
    // a *successful* pair — a cancel that owns nothing, racing whatever
    // arms the marker next.
    backendArmedRef.current = false
    setPeers(polledPeers)
    useSyncStore.getState().setPeers(polledPeers.map(mapPeerRefToInfo))
    setJoinerPhase('entry')
    setWaitCountdown(null)
    setWords(['', '', '', ''])
    // #3615 — the host's QR and its countdown describe a window that has
    // now been consumed; clearing them is the host-side equivalent of the
    // joiner's wait teardown above, and it stops a spent code (and a
    // ticking timer) from being shown for the moment before the parent
    // honours `onOpenChange(false)`.
    setPairingInfo(null)
    setCountdown(null)
    announce(t('announce.pairingSucceeded'))
    notify.success(t('pairing.pairSuccessMessage'))
    onOpenChange(false)
  }, [polled, awaitingPairResult, t, onOpenChange])

  // Failure: the responder's wire-level proof rejection reaches this device
  // as a generic `sync:error` → `useSyncStore` error string (see `syncError`
  // above). #3495 — this used to also guard on a `waitErrorBaselineRef`
  // snapshot to keep a STALE pre-existing store error from being mistaken
  // for a fresh rejection, but that guard could never fire: `call` (below)
  // runs `syncSetState('idle')` synchronously right after `confirm_pairing`
  // resolves, which clears the store's `error` to `null` before waiting
  // even begins — so any stale error is already neutralised before this
  // effect can see it, and the ref was dead code. By the time `joinerPhase`
  // is 'waiting', a non-null `syncError` can only be a fresh rejection.
  //
  // #3504 asked for this to widen to "any terminal rejection", on the reasoning
  // that a joiner whose window outlives its host's gets `PEER_NOT_PAIRED_MESSAGE`
  // back and cannot resolve. It deliberately does NOT widen: during a pairing
  // window the daemon dials every discovered *unpaired* peer, so that message is
  // the ordinary reply from every third device on the LAN — and pairing a third
  // device into an existing pair would then report a failure while the real host
  // was still answering correctly. See `isPairingWindowRejection` for the full
  // asymmetry; the noise half of #3504 is handled there instead.
  useEffect(() => {
    if (joinerPhase !== 'waiting' || !syncError) return
    if (!syncError.includes(PAIRING_PROOF_REQUIRED_MESSAGE)) return
    setJoinerPhase('entry')
    setWaitCountdown(null)
    setWords(['', '', '', ''])
    setError(t('pairing.proofRejectedError'))
    announce(t('announce.pairingProofRejected'))
  }, [syncError, joinerPhase, t])

  // Bound the wait by the same pending-pairing TTL the host countdown uses
  // (`PAIRING_TIMEOUT_SECONDS`) — 1s tick, mirroring the host countdown
  // effect below it in shape.
  // `open &&` for the same reason the poll above carries it (#3496): this
  // component is mounted unconditionally, so a parent that sets
  // `open={false}` directly bypasses `handleCancel` and leaves `joinerPhase`
  // at `'waiting'`. Without the gate the tick keeps running on a closed
  // dialog and, up to `PAIRING_TIMEOUT_SECONDS` later, announces a timeout
  // to a screen reader for a dialog that is no longer on screen.
  const waitCountdownActive =
    open && joinerPhase === 'waiting' && waitCountdown !== null && waitCountdown > 0
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
      // #3493 — `confirm_pairing` has just armed this device's DB-side
      // pending-pairing marker, so from here on a Cancel has something real
      // to tear down. Set the moment the call resolves rather than in
      // `onSuccess`, so the baseline read below (which can reject) cannot
      // leave an armed marker recorded as unarmed. Without this the joiner's
      // Cancel button — the one on the waiting screen — never reached
      // `cancel_pairing` at all and the marker stayed live for its full TTL.
      backendArmedRef.current = true
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
      // already armed, and the only thing that un-arms it is an explicit
      // user Cancel (#3493) — not a failed bookkeeping read. So the wait
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
      // authoritative read, which is async). The equivalent stale-error
      // problem on the sync-store side is already handled by
      // `syncSetState('idle')` in `call`, above — see the failure effect's
      // comment (#3495).
      //
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

  // #3610 (review) — explicit-Cancel's own cancelPairing call. Mirrors
  // `executeCancelPairingCleanup`'s notify.error(t('pairing.cancelFailed'))
  // shape instead of swallowing a failure into a silent logger.error: a
  // failed cancel here is the same "marker stays armed for its full TTL
  // while the user believes it's cancelled" shape #3493 fixed on the
  // waiting-screen Cancel, just reached via a DB-write failure instead of
  // a stale gate.
  //
  // `backendArmedRef` is deliberately only cleared in `onSuccess` — the
  // ref means "something is armed on the backend", so if the DELETE never
  // landed it still is. Leaving it armed on failure hands the retry to the
  // close/unmount cleanup effect above: `handleCancel` still unconditionally
  // calls `onOpenChange(false)` below, which flips `open` to false and runs
  // that effect's cleanup — a no-op if this call succeeded (ref already
  // clear), one retry attempt if it didn't. `cancel_pairing_inner`'s clear
  // is a plain idempotent DELETE, so the two calls can never disagree.
  const { execute: executeCancelPairingExplicit } = useIpcCommand<void, void>({
    call: () =>
      commands.cancelPairing().then((r) => {
        unwrap(r)
      }),
    module: 'PairingDialog',
    errorLogMessage: 'Failed to cancel pairing',
    onSuccess: () => {
      backendArmedRef.current = false
    },
    onError: () => {
      notify.error(t('pairing.cancelFailed'))
    },
  })

  const handleCancel = useCallback(async () => {
    // Tear down whatever this device has armed on the backend — the host's
    // QR session, or (#3493) the joiner's pending-pairing marker armed by
    // `confirm_pairing`. Gated on `backendArmedRef` so a Cancel with
    // nothing armed (e.g. the joiner's entry form, before Pair) stays a
    // pure UI act and does not disarm a marker it never owned.
    //
    // Awaited so `backendArmedRef` only clears once the call has actually
    // succeeded — see `executeCancelPairingExplicit` above for why, and for
    // how a failure still gets one retry via the close/unmount cleanup.
    if (backendArmedRef.current) {
      await executeCancelPairingExplicit()
    }
    resetRoleState()
    onOpenChange(false)
    // #288: Return focus to trigger element
    triggerRef?.current?.focus()
  }, [onOpenChange, triggerRef, resetRoleState, executeCancelPairingExplicit])

  // #3463 — switching to the joiner path is what DECLARES the joiner role
  // (replacing the removed upfront chooser question). Crucially, this
  // cancels the host's own session first (`cancelPairing` clears both the
  // backend's in-memory `pairing_state` slot AND, since #3493, the DB-side
  // pending-pairing marker that slot was advertising — see sync_cmds.rs
  // `cancel_pairing_inner`) so this device stops offering a code it is no
  // longer showing, on the wire as well as on screen. Without this, a
  // device could simultaneously be offering its own code (host) and
  // entering another's (joiner) — the #3463 shape wearing a different hat.
  const handleSwitchToJoiner = useCallback(async () => {
    // #3620 — goes through the explicit executor, which clears
    // `backendArmedRef` in its `onSuccess` and nowhere else. Clearing it
    // here, before the await, recorded a teardown that had not happened
    // (and might still fail): the ref means "something is armed on the
    // backend", and if the DELETE never landed it still is. Leaving it
    // armed on failure hands the retry to the close/unmount cleanup, and
    // the clear is an idempotent DELETE so two attempts cannot disagree.
    if (backendArmedRef.current) {
      await executeCancelPairingExplicit()
    }
    setPairingInfo(null)
    setCountdown(null)
    setWords(['', '', '', ''])
    setEntryMode('manual')
    setError(null)
    setJoinerPhase('entry')
    setWaitCountdown(null)
    await initJoiner()
  }, [executeCancelPairingExplicit, initJoiner])

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

  // #294: Format countdown for display (`isExpired` is derived up with the
  // countdown timer above — the live-pairing-window flag needs it there).
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
    // #3620: the host's live QR is the same situation seen from the other
    // end — a pairing window armed on the backend that a joiner may be
    // mid-attempt against. Since #3610 closing it genuinely disarms that
    // window, and the joiner then fails the responder's proof check with
    // nothing on this device to say why. Guarded symmetrically with the
    // joiner's wait rather than warned about afterwards: the confirmation
    // is the non-destructive choice, and the whole point of this family of
    // fixes is that the two roles behave identically. An expired window has
    // nothing left to lose, so it closes without ceremony.
    const hostWindowLive = role === 'host' && backendArmedRef.current && !isExpired
    if (pairLoading || joinerPhase === 'waiting' || hostWindowLive) {
      setConfirmCloseOpen(true)
      return
    }
    handleCancel()
  }, [pairLoading, joinerPhase, role, isExpired, handleCancel])

  const parts = useDialogOrSheet('dialog')
  const { Root, Content, Header, Title } = parts
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
                  waitCountdown={waitCountdown}
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
