/**
 * #3469 (review) — the mock's pairing-outcome contract.
 *
 * `confirm_pairing` only arms this device's local proof. The FE's whole
 * point after #3469 is that it must NOT treat that as success; it waits for
 * a peer to appear in `list_peer_refs` that was absent from the baseline it
 * snapshotted the instant the proof was armed.
 *
 * That makes the mock's reveal TIMING load-bearing, not cosmetic, and wrong
 * in two opposite directions:
 *
 *  - reveal too EARLY (the original: a synchronous insert inside
 *    `confirm_pairing`) and the peer is already in the FE's baseline
 *    snapshot — which is read immediately after `confirm_pairing` resolves
 *    — so no later poll can ever see it as new and the wait DEADLOCKS for
 *    the full 5-minute TTL. Before the baseline read moved inside `call`,
 *    the same synchronous insert produced the opposite failure: the very
 *    first poll saw the peer and the dialog claimed "Device paired
 *    successfully" for any passphrase, one frame after opening — a mock
 *    that re-implemented the exact lie #3469 exists to delete.
 *
 *  - reveal too LATE and dev mode / E2E never resolve at all.
 *
 * These tests pin the contract the FE's flow actually needs:
 *  1. `confirm_pairing` adds no peer synchronously;
 *  2. the FE's baseline read (1st after confirm) is still peer-free;
 *  3. the poll's immediate enable-triggered fetch (2nd) is still peer-free,
 *     so the waiting state is genuinely observable;
 *  4. the first interval tick (3rd) reveals exactly one peer, and it stays;
 *  5. `seedBlocks()` resets both the store and any pending reveal.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { pairingPeerReveal, peerRefs, seedBlocks } from '@/lib/tauri-mock/seed'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

/** `list_peer_refs`, typed for the fields these tests care about. */
function listPeerRefs(): Record<string, unknown>[] {
  return dispatch('list_peer_refs', undefined) as Record<string, unknown>[]
}

function confirmPairing(passphrase: string): void {
  dispatch('confirm_pairing', { passphrase, remoteDeviceId: '' })
}

beforeEach(() => {
  seedBlocks()
})

describe('tauri-mock pairing peer reveal (#3469)', () => {
  it('confirm_pairing does not add a peer synchronously', () => {
    expect(listPeerRefs()).toHaveLength(0)

    confirmPairing('alpha bravo charlie delta')

    // Inspecting the store directly, not through `list_peer_refs` — a read
    // would itself advance the reveal countdown and mask a synchronous
    // insert behind an off-by-one.
    expect(peerRefs.size).toBe(0)
  })

  it('keeps the two reads the joiner makes before its first poll tick peer-free, then reveals on the third', () => {
    confirmPairing('alpha bravo charlie delta')

    // 1 — PairingDialog's authoritative baseline snapshot, taken inside
    // `executePair`'s `call` right after `confirm_pairing` resolves. A peer
    // here poisons the baseline and the wait can never resolve.
    expect(listPeerRefs()).toEqual([])
    // 2 — usePollingQuery's immediate fetch when `enabled` flips true
    // (usePollingQuery.ts:106). A peer here closes the dialog in the same
    // frame the waiting state opened.
    expect(listPeerRefs()).toEqual([])
    // 3 — the first 2s interval tick: the peer legitimately appears.
    const revealed = listPeerRefs()
    expect(revealed).toHaveLength(1)
    // #4298: the mock's revealed peer carries a PEER-SUPPLIED name and no local
    // override, which is the shape a real freshly-paired row has.
    expect(revealed[0]?.['device_name']).toBeNull()
    expect(revealed[0]?.['remote_device_name']).toBe('Paired Device')
    expect(revealed[0]?.['peer_id']).toEqual(expect.any(String))
  })

  it('keeps the revealed peer stable across later reads instead of adding one per poll', () => {
    confirmPairing('alpha bravo charlie delta')
    listPeerRefs()
    listPeerRefs()
    const first = listPeerRefs()
    expect(first).toHaveLength(1)

    // The poll keeps ticking after the dialog resolves; each further read
    // must return the SAME single peer, not mint another one.
    expect(listPeerRefs()).toHaveLength(1)
    expect(listPeerRefs()).toHaveLength(1)
    expect(listPeerRefs()[0]?.['peer_id']).toBe(first[0]?.['peer_id'])
  })

  it('exposes the revealed peer through get_peer_ref and lets delete_peer_ref remove it', () => {
    confirmPairing('alpha bravo charlie delta')
    listPeerRefs()
    listPeerRefs()
    const peerId = listPeerRefs()[0]?.['peer_id'] as string

    expect(dispatch('get_peer_ref', { peerId })).toMatchObject({ peer_id: peerId })
    dispatch('delete_peer_ref', { peerId })
    expect(listPeerRefs()).toEqual([])
  })

  it('seedBlocks() clears both the peer store and a pending reveal, so no peer leaks across seeds', () => {
    confirmPairing('alpha bravo charlie delta')
    listPeerRefs()
    listPeerRefs()
    expect(listPeerRefs()).toHaveLength(1)

    seedBlocks()

    expect(peerRefs.size).toBe(0)
    expect(pairingPeerReveal.readsRemaining).toBe(0)
    // A pending reveal armed before the reseed must not fire afterwards.
    expect(listPeerRefs()).toEqual([])
    expect(listPeerRefs()).toEqual([])
    expect(listPeerRefs()).toEqual([])
  })

  it('does not arm a reveal without a confirm_pairing, however many times the list is polled', () => {
    for (let i = 0; i < 10; i++) {
      expect(listPeerRefs()).toEqual([])
    }
  })
})
