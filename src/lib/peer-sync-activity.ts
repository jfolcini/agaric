import type { PeerRef } from '@/lib/bindings'

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
