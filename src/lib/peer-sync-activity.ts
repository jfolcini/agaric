import type { PeerRef } from '@/lib/bindings'
import { peerName } from '@/lib/peer-display-name'

/**
 * The last time anything synced between us and a peer, in backend epoch-ms,
 * or `null` when nothing ever has (#4084).
 *
 * # Why this is not just `peer.synced_at`
 *
 * A sync session is one-directional: the initiator pulls, the responder
 * streams. `synced_at` is deliberately the **puller's** clock — #610 keeps the
 * streamer from advancing it, because the scheduler measures staleness from it
 * and a responder refreshing it on every inbound session would make itself
 * permanently not-overdue and starve the reverse direction.
 *
 * The consequence used to reach the UI: a device that only ever succeeds as
 * responder wrote no progress at all, so the device list said "never synced"
 * about a peer it was demonstrably syncing with. `streamed_at` (migration
 * 0111) records the other direction, and the honest thing to show a user is
 * the later of the two — "when did anything last move between us", which is
 * the question "last synced" is actually asking on their behalf.
 *
 * The scheduler still reads `synced_at` alone; this is a display concern only.
 *
 * Both columns are nullable and independent, so the fold is null-safe on each
 * side rather than on the pair.
 */
export function lastSyncActivityAt(peer: PeerRef): number | null {
  const { synced_at: synced, streamed_at: streamed } = peer
  if (synced == null) return streamed
  if (streamed == null) return synced
  return Math.max(synced, streamed)
}

/**
 * #1673: Total-order comparator for a rendered peer list.
 *
 * Sort intent: named devices first (alphabetical by name), then unnamed
 * devices ordered by most-recently-synced first. Every branch returns a
 * consistent numeric -1/0/1 and the keys are layered so the relation is
 * total and transitive (no comparator returns 0 unless two rows are truly
 * indistinguishable on all keys), which keeps the sort well-defined and
 * stable across engines.
 *
 * Keys, in priority order:
 *  1. has-name  (named before unnamed) — #4298: `peerName`, so a peer-supplied
 *     name counts as named
 *  2. display name, localeCompare (named only — both unnamed skip this)
 *  3. last sync activity desc (never => -Infinity, sorts last)
 *  4. peer_id, localeCompare (stable, deterministic final tiebreak)
 *
 * #4084: key 3 is [`lastSyncActivityAt`] — `MAX(synced_at, streamed_at)` —
 * not `synced_at`. A device that only ever succeeds as RESPONDER never
 * advances `synced_at` (#610 forbids the streamer touching it), so sorting on
 * `synced_at` alone buried an actively-syncing peer at the bottom of the list
 * with the peers that genuinely never synced.
 *
 * # Why this lives here rather than at a call site
 *
 * `list_peer_refs` ends `ORDER BY synced_at DESC`, and SQLite sorts NULLs last
 * under DESC — so the backend order has exactly the defect above baked in, and
 * *every* surface that renders that list has to re-sort to undo it. The
 * comparator is therefore shared rather than owned by one component: the
 * device list (`DeviceManagement`) and the pairing dialog's list
 * (`PairingPeersList`) both apply it, so a responder-only peer cannot read
 * "Last: 5 minutes ago" on one surface while sorting to the bottom on the
 * other.
 *
 * The SQL was deliberately left alone. Its remaining consumers
 * (`should_start_active`, `peer_is_bound_to_another_key`,
 * `list_peer_refs_or_empty`) are all order-agnostic set/emptiness reads, the
 * display order they would need is not expressible as one `ORDER BY` anyway
 * (key 1 is the device *name*), and rewriting the query would touch the
 * offline `.sqlx` caches for no behavioural gain.
 */
export function comparePeers(a: PeerRef, b: PeerRef): number {
  // #4298: "has a name" is the DISPLAY precedence, not the `device_name`
  // column. A peer that told us its hostname is a named device — it renders as
  // "javier-thinkpad", not as hex — so sorting it with the anonymous rows would
  // put a legible name at the bottom of the list under the UUIDs. Sorting on
  // the same string the row renders is what keeps this key meaning what the
  // user sees.
  const aName = peerName(a)
  const bName = peerName(b)

  // 1. named devices before unnamed
  if ((aName != null) !== (bName != null)) return aName != null ? -1 : 1

  // 2. both named: alphabetical by name
  if (aName != null && bName != null) {
    const byName = aName.localeCompare(bName)
    if (byName !== 0) return byName
  }

  // 3. most-recent activity first (null => never synced => last)
  const aSynced = lastSyncActivityAt(a) ?? Number.NEGATIVE_INFINITY
  const bSynced = lastSyncActivityAt(b) ?? Number.NEGATIVE_INFINITY
  if (aSynced !== bSynced) return aSynced > bSynced ? -1 : 1

  // 4. deterministic final tiebreak so the order is total
  return a.peer_id.localeCompare(b.peer_id)
}
