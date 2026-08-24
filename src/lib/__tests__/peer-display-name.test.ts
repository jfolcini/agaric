/**
 * Tests for the #4298 device-name display precedence.
 *
 * The precedence is three levels deep and every level is reachable in normal
 * use, which is exactly why it lives in one helper: a `??` chain repeated at
 * six call sites can disagree with itself in a way that is invisible, because
 * every wrong answer is still *a* string.
 */

import { describe, expect, it } from 'vitest'

import { peerDisplayName, peerDisplayNameOrId, peerName } from '@/lib/peer-display-name'
import type { PeerRef } from '@/lib/tauri'

function makePeer(overrides: Partial<PeerRef> = {}): PeerRef {
  return {
    peer_id: 'e3d48f0a-45ae-4782-baf4-6189413222d9',
    last_hash: null,
    last_sent_hash: null,
    synced_at: null,
    streamed_at: null,
    reset_count: 0,
    last_reset_at: null,
    cert_hash: null,
    device_name: null,
    remote_device_name: null,
    last_address: null,
    endpoint_id: null,
    unpaired_by_peer_at_ms: null,
    ...overrides,
  }
}

describe('peerName', () => {
  it('prefers the user override over the name the peer supplied', () => {
    // The whole reason there are two columns: a peer re-advertises its name on
    // every session, and if it could win, the next sync would silently undo a
    // rename the user performed.
    const peer = makePeer({ device_name: "Javier's Phone", remote_device_name: 'pixel-8' })
    expect(peerName(peer)).toBe("Javier's Phone")
  })

  it('falls back to the name the peer supplied when no override is set', () => {
    expect(peerName(makePeer({ remote_device_name: 'pixel-8' }))).toBe('pixel-8')
  })

  it('returns null when nobody has supplied a name', () => {
    expect(peerName(makePeer())).toBeNull()
  })

  it('treats empty and whitespace-only names as absent at every level', () => {
    expect(peerName(makePeer({ device_name: '' }))).toBeNull()
    expect(peerName(makePeer({ device_name: '   ' }))).toBeNull()
    expect(peerName(makePeer({ remote_device_name: '\t\n' }))).toBeNull()
    // A blank override must not shadow a real peer-supplied name — otherwise
    // clearing a rename would blank the row instead of revealing what is under
    // it, which is precisely what `update_peer_name` promises it does.
    expect(peerName(makePeer({ device_name: '  ', remote_device_name: 'pixel-8' }))).toBe('pixel-8')
  })

  it('trims a padded name rather than rendering the padding', () => {
    expect(peerName(makePeer({ device_name: '  Work Laptop  ' }))).toBe('Work Laptop')
  })
})

describe('peerDisplayName', () => {
  it('falls back to the truncated peer id — the bug this issue reported', () => {
    // The observed state on real hardware after a verified two-way pair: an
    // empty name on both devices, so both lists showed hex.
    expect(peerDisplayName(makePeer())).toBe('e3d48f0a-45a...')
  })

  it('reaches the fallback only when neither column carries a name', () => {
    expect(peerDisplayName(makePeer({ remote_device_name: 'pixel-8' }))).toBe('pixel-8')
    expect(peerDisplayName(makePeer({ device_name: 'Work Laptop' }))).toBe('Work Laptop')
  })
})

describe('peerDisplayNameOrId', () => {
  it('names a peer that is still in the list', () => {
    const peer = makePeer({ remote_device_name: 'pixel-8' })
    expect(peerDisplayNameOrId(peer, peer.peer_id)).toBe('pixel-8')
  })

  it('falls back to the id for a peer that has already left the list', () => {
    // The unpair confirmation renders while its peer is being removed, so the
    // lookup can miss — and a missing row still has an id to truncate.
    expect(peerDisplayNameOrId(undefined, 'e3d48f0a-45ae-4782-baf4-6189413222d9')).toBe(
      'e3d48f0a-45a...',
    )
  })
})
