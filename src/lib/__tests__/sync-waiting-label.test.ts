import { describe, expect, it } from 'vitest'

import { t } from '@/lib/i18n'
import { waitingForPeerLabel } from '@/lib/sync-waiting-label'

const NOW = Date.parse('2026-11-12T12:00:00Z')
const FIVE_MINUTES_AGO = new Date(NOW - 5 * 60_000).toISOString()

describe('waitingForPeerLabel (#6523)', () => {
  it('names the device and how long ago it last synced, aged by `now`', () => {
    const peers = [
      { peerId: 'OTHER', name: 'Laptop', lastSyncedAt: null },
      { peerId: 'PEER1', name: 'Pixel 8', lastSyncedAt: FIVE_MINUTES_AGO },
    ]

    expect(waitingForPeerLabel(peers, 'PEER1', t, NOW)).toBe(
      t('sync.waitingForPeer', { peer: 'Pixel 8', time: t('sidebar.minutesAgo', { count: 5 }) }),
    )
    expect(waitingForPeerLabel(peers, 'PEER1', t, NOW + 55 * 60_000)).toBe(
      t('sync.waitingForPeer', { peer: 'Pixel 8', time: t('sidebar.hoursAgo', { count: 1 }) }),
    )
  })

  it('falls back to the truncated id for a device with no name', () => {
    const peers = [
      { peerId: '0123456789ABCDEFGHJKMNPQRS', name: null, lastSyncedAt: FIVE_MINUTES_AGO },
    ]

    expect(waitingForPeerLabel(peers, '0123456789ABCDEFGHJKMNPQRS', t, NOW)).toBe(
      t('sync.waitingForPeer', {
        peer: '0123456789AB...',
        time: t('sidebar.minutesAgo', { count: 5 }),
      }),
    )
  })

  it('leaves out the last sync for a device that never synced, or one no longer listed', () => {
    const peers = [{ peerId: 'PEER1', name: 'Pixel 8', lastSyncedAt: null }]

    expect(waitingForPeerLabel(peers, 'PEER1', t, NOW)).toBe(
      t('sync.waitingForPeerNeverSynced', { peer: 'Pixel 8' }),
    )
    expect(waitingForPeerLabel([], 'GONE', t, NOW)).toBe(
      t('sync.waitingForPeerNeverSynced', { peer: 'GONE' }),
    )
  })
})
