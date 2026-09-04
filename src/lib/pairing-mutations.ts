/**
 * The three backend commands that write this device's pending-pairing marker,
 * and the queue that orders them (#3628, #3715).
 *
 * `start_pairing` and `confirm_pairing` upsert the marker; `cancel_pairing`
 * deletes it. All three write the SAME single device-global row, and they are
 * dispatched from places that cannot see each other — an effect body, a React
 * cleanup function that may not be async, two click handlers — so without a
 * queue nothing but arrival order at the backend decides which one wins. The
 * two ways that goes wrong are both real bugs that were shipped:
 *
 *   * a reopen's arm overtaking the previous close's in-flight clear, so the
 *     clear deletes the window the user is looking at — passphrase on screen,
 *     countdown ticking, nothing armed on the backend (#3620);
 *   * a close's clear overtaking an arm still in flight, so the DELETE removes
 *     a row that does not exist yet and the late upsert stands — a live
 *     pairing window admitting unpaired peers with no dialog behind it
 *     (#3628).
 *
 * # Why this lives in a module rather than in `PairingDialog` (#3715)
 *
 * The queue was a `useRef` promise tail inside the dialog, which scoped it to
 * a component INSTANCE while the row it protects is device-global. Unmount the
 * dialog with a clear still in flight and the next instance starts with an
 * empty queue: its `start_pairing` can be dispatched — and can land — before
 * that clear, which is #3620 again, reached by remount rather than by reopen.
 * The queue must be scoped to the resource it serialises, and that resource is
 * the device. A module-level tail is exactly that scope: one per app process,
 * shared by every mount, for as long as the device is running.
 *
 * # Why every mutation is bounded (#3715)
 *
 * The tail used to be extended unconditionally, so an IPC that never settles —
 * daemon wedged, mDNS stack stuck — left every later mutation queued forever
 * behind it, including the clear that a close needs. The dialog closes, the
 * marker survives its full 5-minute TTL, and the device keeps admitting peers
 * with no UI behind it: the same user-visible failure #3628 fixed, reached by
 * a different route.
 *
 * So the tail is chained on the BOUNDED promise, not on the caller's `op`.
 * That one detail is the whole fix: when the bound expires, the tail settles,
 * and the next mutation runs. The wedged call is dropped from the queue rather
 * than holding it — it may still land later, but the marker it writes is one
 * the close's clear (now free to run) deletes afterwards, which is the safe
 * direction of that race.
 */

import { unwrap } from '@/lib/app-error'
import type { PairingInfo, ScannedPeerCandidate } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { i18n } from '@/lib/i18n'
import { runWithTimeout } from '@/lib/promise-timeout'

/**
 * How long a single pairing mutation may take before the queue gives up on it.
 *
 * Derived from the slowest a HEALTHY one can be, not guessed: these commands
 * are a single-row upsert/delete plus a scheduler wake, and the longest a
 * healthy write can legitimately block is the connection pool's `busy_timeout`
 * — 5 s (`src-tauri/agaric-store/src/db/mod.rs`). Three times that leaves room
 * for the IPC round-trip and a contended pool on top, while staying ~1/20th of
 * the 300 s marker TTL this exists to protect: expiring the bound must be far
 * cheaper than letting a wedged call sit on the queue for the whole life of the
 * window.
 */
export const PAIRING_MUTATION_TIMEOUT_MS = 15_000

/**
 * A queued pairing mutation that never answered.
 *
 * Carries translated copy because it is surfaced to the user through the
 * dialog's existing error banner (`pairing.startFailed` / `pairing.pairFailed`
 * interpolate `{{message}}`) and its `cancelFailed` toast — the same channels
 * a backend rejection uses, so a wedged daemon reads as a failure rather than
 * as a dialog that quietly does nothing.
 */
export class PairingMutationTimeoutError extends Error {
  constructor() {
    super(i18n.t('pairing.mutationTimedOut'))
    this.name = 'PairingMutationTimeoutError'
  }
}

/**
 * Device-scoped FIFO tail. Always settled or settling — never rejected: see
 * the `.then(op, op)` note below.
 */
let queueTail: Promise<unknown> = Promise.resolve()

function runPairingMutation<T>(op: () => Promise<T>): Promise<T> {
  // The bound starts when the mutation is DISPATCHED (here, inside the
  // continuation), not when it is enqueued. Timing from enqueue would expire a
  // mutation for its predecessor's slowness — and the mutation most likely to
  // be waiting is the close's clear, the one thing that must never be dropped.
  const dispatch = () =>
    runWithTimeout(op(), PAIRING_MUTATION_TIMEOUT_MS, new PairingMutationTimeoutError())
  // `.then(dispatch, dispatch)` rather than `.then(dispatch)`: a mutation that
  // rejects must not sink the queue behind it — a failed `cancel_pairing` still
  // has to let the next `start_pairing` through, or one DB error would wedge
  // pairing until the app restarts.
  const result = queueTail.then(dispatch, dispatch)
  // Chained on `result` (bounded) rather than on `op()` (unbounded): a call
  // that never answers releases the queue when its bound expires. See the
  // module comment.
  queueTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/**
 * The pairing-state mutations, each wrapped at its DEFINITION.
 *
 * "Is this queued?" is answerable by looking at this one object (#3715). It
 * used to be answerable only by reading every call site: `start_pairing` and
 * `cancel_pairing` were wrapped where their `useIpcCommand` was defined but
 * `confirm_pairing` was wrapped at its call site inside a larger `call` body,
 * and that asymmetry is the kind that decays — a second call site added later
 * gets no queueing and nobody notices, because the symptom is a rare ordering
 * race rather than a test failure.
 *
 * App code must call these rather than `commands.startPairing` /
 * `commands.confirmPairing` / `commands.cancelPairing` directly; an unqueued
 * call re-opens #3620/#3628 for every other caller, not just itself.
 */
export const pairingMutations = {
  /** Host: mint a passphrase and arm this device's marker. */
  start: (): Promise<PairingInfo> =>
    runPairingMutation(() => commands.startPairing().then((r) => unwrap(r))),
  /**
   * Joiner: arm this device's marker with the proof of the typed passphrase.
   *
   * `scannedPeer` is the host a v2 pairing QR named (#4037), or `null` when the
   * passphrase was typed. The backend races it against mDNS; it never replaces
   * it, so passing `null` is always correct behaviour, just slower on a LAN
   * where multicast does not work.
   */
  confirm: (
    passphrase: string,
    remoteDeviceId: string,
    scannedPeer: ScannedPeerCandidate | null,
  ): Promise<void> =>
    runPairingMutation(() =>
      commands.confirmPairing(passphrase, remoteDeviceId, scannedPeer).then((r) => {
        unwrap(r)
      }),
    ),
  /** Either role: delete the marker. Idempotent — a plain DELETE. */
  cancel: (): Promise<void> =>
    runPairingMutation(() =>
      commands.cancelPairing().then((r) => {
        unwrap(r)
      }),
    ),
}

/**
 * Drop the queue's tail. **Tests only.**
 *
 * The tail outliving a component is the point of this module, but it also
 * outlives a test: a spec that deliberately leaves a mutation unanswered (the
 * wedged-IPC cases) would otherwise hold the next spec's `start_pairing`
 * behind it until the bound expires. Production has no reason to call this —
 * every real path is ordered against whatever is already queued, which is the
 * invariant, not an inconvenience.
 */
export function resetPairingMutationQueue(): void {
  queueTail = Promise.resolve()
}
