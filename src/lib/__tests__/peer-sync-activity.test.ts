/**
 * Tests for `lastSyncActivityAt` (#4084).
 *
 * The fold is three lines, and every one of them encodes a case the old
 * `peer.synced_at` read got wrong for a responder-only device.
 */

import { describe, expect, it } from 'vitest'

import { lastSyncActivityAt } from '@/lib/peer-sync-activity'
import type { PeerRef } from '@/lib/tauri'

function makePeer(overrides: Partial<PeerRef> = {}): PeerRef {
  return {
    peer_id: 'peer-4084',
    last_hash: null,
    last_sent_hash: null,
    synced_at: null,
    streamed_at: null,
    reset_count: 0,
    last_reset_at: null,
    cert_hash: null,
    device_name: null,
    last_address: null,
    endpoint_id: null,
    unpaired_by_peer_at_ms: null,
    ...overrides,
  }
}

describe('lastSyncActivityAt', () => {
  it('returns null when the peer has never synced in either direction', () => {
    expect(lastSyncActivityAt(makePeer())).toBeNull()
  })

  it('returns synced_at when only we have pulled', () => {
    expect(lastSyncActivityAt(makePeer({ synced_at: 1000 }))).toBe(1000)
  })

  // The responder-only device: #610 forbids the streamer advancing
  // `synced_at`, so this row reads "never synced" under the old logic while
  // the peer is demonstrably syncing on every tick.
  it('returns streamed_at when only they have pulled from us', () => {
    expect(lastSyncActivityAt(makePeer({ streamed_at: 2000 }))).toBe(2000)
  })

  it('returns the later of the two when both directions have run', () => {
    expect(lastSyncActivityAt(makePeer({ synced_at: 1000, streamed_at: 2000 }))).toBe(2000)
    expect(lastSyncActivityAt(makePeer({ synced_at: 3000, streamed_at: 2000 }))).toBe(3000)
  })

  it('treats 0 as a real timestamp, not as absent', () => {
    // `0` is the UNIX epoch and passes the column's `>= 0` CHECK, so a
    // truthiness test here (`peer.streamed_at ? … : …`) would silently
    // report "never synced".
    expect(lastSyncActivityAt(makePeer({ streamed_at: 0 }))).toBe(0)
    expect(lastSyncActivityAt(makePeer({ synced_at: 0, streamed_at: null }))).toBe(0)
  })
})
