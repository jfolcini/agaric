/**
 * The rejection strings a device puts on the wire when it turns a sync
 * connection away, re-declared on this side of the process boundary (#3492,
 * #3504).
 *
 * The originals are `PAIRING_PROOF_REQUIRED_MESSAGE` and
 * `PEER_NOT_PAIRED_MESSAGE` in
 * `src-tauri/agaric-sync/src/sync_daemon/server.rs`. They reach the frontend as
 * free prose inside a generic `SyncEvent::Error { message }`, so nothing in
 * either language's type system notices when the two ends stop agreeing:
 * reword the Rust side and every test on both sides stays green while this
 * side silently stops recognising the message.
 * `scripts/check-pairing-rejection-contract.mjs` — wired into `prek.toml` so it
 * fires on a change to ANY of the three files — is what makes that reword red.
 *
 * # Why this module exists rather than a constant inside `PairingDialog`
 *
 * Two consumers now need these strings, and they need them for different
 * things:
 *
 *   * `PairingDialog` matches the *proof* message to turn a waiting joiner's
 *     dialog into an immediate "wrong code" instead of a five-minute timeout
 *     that then blames an expired one;
 *   * `useSyncEvents` uses [`isPairingWindowRejection`] to keep either message
 *     out of the red "Sync failed" toast (#3505).
 *
 * A hook reaching into a dialog component for a string would drag the dialog's
 * whole component tree into the hook's module graph, so the shared value lives
 * in `lib` and both import it.
 */

/**
 * The `#855` proof gate's refusal: a device offered a pairing proof that did
 * not match the one in this device's own marker.
 *
 * Since #3491 both devices raise it — the one that dialled receives it over the
 * wire, and the one that *detected* it raises the identical string on its own
 * event sink — so a single matcher handles both origins and the UI cannot tell
 * them apart. That is the point; see `Rejection::user_facing_message` in
 * `server.rs`.
 */
export const PAIRING_PROOF_REQUIRED_MESSAGE = 'pairing passphrase proof required'

/**
 * S-1's refusal: the key that dialled is bound to no peer and this device has
 * no pairing window open.
 *
 * The ordinary answer to every stranger's probe on a healthy LAN — and also
 * what a joiner gets back from a host whose own window has already lapsed
 * (#3504: the host arms at dialog-open and the joiner at confirm-time, so the
 * joiner's window outlives the host's by however long the user spent walking
 * over and typing).
 */
export const PEER_NOT_PAIRED_MESSAGE = 'peer not paired with this device'

/**
 * Is `message` a refusal that belongs to a pairing handshake rather than to a
 * failed sync?
 *
 * # What this is for, and what it is deliberately NOT for (#3504, #3505)
 *
 * It gates *noise suppression* only — see `useSyncEvents`. It must not be read
 * as "the pairing failed", and the asymmetry between the two constants above is
 * the reason:
 *
 *   * `PAIRING_PROOF_REQUIRED_MESSAGE` is safe to treat as a terminal pairing
 *     failure, and `PairingDialog` does. Producing it requires the peer to hold
 *     an open pairing window of its own, which is rare enough to be evidence.
 *   * `PEER_NOT_PAIRED_MESSAGE` is **not**, and #3504's suggestion that the
 *     joiner "treat any terminal rejection as terminal" would be a regression
 *     if taken literally. While a pairing window is open the daemon dials every
 *     discovered *unpaired* peer (it cannot know which one is the host — that
 *     is what the passphrase is for), so on any LAN with a third device this is
 *     the reply that device gives. Pairing a third device into an existing pair
 *     — the common case, not an edge case — would then report "the other device
 *     is no longer pairing" while the real host was still answering correctly.
 *
 * Suppressing the toast for both is safe in a way that acting on both is not: a
 * suppressed toast costs a notification the user could not have acted on, while
 * a wrong verdict ends a pairing that was working.
 */
export function isPairingWindowRejection(message: string): boolean {
  return (
    message.includes(PAIRING_PROOF_REQUIRED_MESSAGE) || message.includes(PEER_NOT_PAIRED_MESSAGE)
  )
}
