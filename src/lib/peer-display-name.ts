import type { PeerRef } from '@/lib/bindings'
import { truncateId } from '@/lib/format'

/**
 * #4298: the one place that decides what a paired device is called.
 *
 * There are two name columns and a fallback, and they are strictly ordered:
 *
 *  1. `device_name` — the USER'S override, typed into the rename dialog on THIS
 *     device. Nothing on the wire may touch it.
 *  2. `remote_device_name` — what the peer told us it is called, over the wire
 *     (its OS hostname). An untrusted claim, already length-capped and
 *     normalised by the backend before it was stored.
 *  3. `truncateId(peer_id)` — a truncated UUID, which is what every row used to
 *     render as, because a device name was never exchanged at all.
 *
 * # Why one helper instead of a `??` chain at each call site
 *
 * The chain appeared at six read sites (the device list, its tooltips and
 * aria-labels, the sync-failure toast, the unpair confirmation, the sort
 * comparator). Repeating it means each site can independently get the
 * precedence, the empty-string handling, or the fallback wrong — and the
 * failure is invisible, because every wrong answer is still *a* string. The
 * user-visible symptom would be one surface calling a device "Pixel 8" while
 * another calls it `e3d48f0a-45a…` in the same view.
 */

/**
 * The name to display for a peer, or `null` when no one has supplied one.
 *
 * Separate from [`peerDisplayName`] because the sort comparator needs to
 * distinguish "named" from "unnamed" — a peer-supplied name counts as named, so
 * a device that told us its hostname sorts with the named devices rather than
 * with the anonymous ones.
 *
 * Empty and whitespace-only names are treated as absent at every level. The
 * backend already normalises the wire value, but `device_name` is written by a
 * local command and the mock's fixtures are hand-written, so the check is
 * repeated here rather than assumed of every producer.
 */
export function peerName(peer: Pick<PeerRef, 'device_name' | 'remote_device_name'>): string | null {
  const override = peer.device_name?.trim()
  if (override) return override
  const supplied = peer.remote_device_name?.trim()
  if (supplied) return supplied
  return null
}

/**
 * The name to display for a peer, falling back to its truncated id.
 *
 * The fallback is the last resort and always was — the fix is that it is now
 * reached far less often, because a paired device supplies its own name on
 * every session.
 */
export function peerDisplayName(peer: PeerRef): string {
  return peerName(peer) ?? truncateId(peer.peer_id)
}

/**
 * [`peerDisplayName`] for a peer that may not be in the list.
 *
 * The unpair confirmation renders while its peer is being removed, so the
 * lookup can miss; a missing row still has an id to truncate, which is the same
 * last resort every other call site lands on.
 */
export function peerDisplayNameOrId(peer: PeerRef | undefined, peerId: string): string {
  return (peer ? peerName(peer) : null) ?? truncateId(peerId)
}
