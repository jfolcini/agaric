import type { TFunction } from 'i18next'

import { truncateId } from '@/lib/format'
import { formatRelativeTime } from '@/lib/format-relative-time'

interface WaitedPeer {
  peerId: string
  name: string | null
  lastSyncedAt: string | null
}

/**
 * #6523 — the sync `waiting` state's line: "Waiting for <device>, last synced
 * <time>". Built at render time from the paired-device list, so the relative
 * time ages with `now`.
 */
export function waitingForPeerLabel(
  peers: readonly WaitedPeer[],
  peerId: string,
  t: TFunction,
  now: number,
): string {
  const peer = peers.find((p) => p.peerId === peerId)
  const name = peer?.name ?? truncateId(peerId)
  return peer?.lastSyncedAt
    ? t('sync.waitingForPeer', { peer: name, time: formatRelativeTime(peer.lastSyncedAt, t, now) })
    : t('sync.waitingForPeerNeverSynced', { peer: name })
}
