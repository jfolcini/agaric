import { beforeEach, describe, expect, it } from 'vitest'

import { useSyncStore } from '@/stores/sync'

describe('useSyncStore', () => {
  beforeEach(() => {
    useSyncStore.getState().reset()
  })

  // ---------------------------------------------------------------------------
  // initial state
  // ---------------------------------------------------------------------------
  describe('initial state', () => {
    it('defaults to idle state with no peers', () => {
      const state = useSyncStore.getState()
      expect(state.state).toBe('idle')
      expect(state.error).toBeNull()
      expect(state.peers).toEqual([])
      expect(state.lastSyncedAt).toBeNull()
      expect(state.opsReceived).toBe(0)
      expect(state.opsSent).toBe(0)
      expect(state.peerProgress).toEqual({})
    })
  })

  // ---------------------------------------------------------------------------
  // setState
  // ---------------------------------------------------------------------------
  describe('setState', () => {
    it('updates sync state', () => {
      useSyncStore.getState().setState('syncing')
      expect(useSyncStore.getState().state).toBe('syncing')
      expect(useSyncStore.getState().error).toBeNull()
    })

    it('sets error when provided', () => {
      useSyncStore.getState().setState('error', 'Connection refused')
      expect(useSyncStore.getState().state).toBe('error')
      expect(useSyncStore.getState().error).toBe('Connection refused')
    })

    it('clears error when transitioning to non-error state', () => {
      useSyncStore.getState().setState('error', 'Some error')
      useSyncStore.getState().setState('idle')
      expect(useSyncStore.getState().state).toBe('idle')
      expect(useSyncStore.getState().error).toBeNull()
    })

    it('accepts all valid sync states', () => {
      // #1076: `discovering` / `pairing` removed — they had no writer.
      const states = ['idle', 'syncing', 'error', 'offline'] as const
      for (const s of states) {
        useSyncStore.getState().setState(s)
        expect(useSyncStore.getState().state).toBe(s)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // setPeers
  // ---------------------------------------------------------------------------
  describe('setPeers', () => {
    it('sets the peers array', () => {
      const peers = [
        { peerId: 'peer-1', lastSyncedAt: '2025-01-15T00:00:00Z', resetCount: 0, name: null },
        { peerId: 'peer-2', lastSyncedAt: null, resetCount: 1, name: null },
      ]
      useSyncStore.getState().setPeers(peers)
      expect(useSyncStore.getState().peers).toEqual(peers)
    })

    it('replaces existing peers', () => {
      useSyncStore
        .getState()
        .setPeers([{ peerId: 'peer-1', lastSyncedAt: null, resetCount: 0, name: null }])
      useSyncStore
        .getState()
        .setPeers([
          { peerId: 'peer-2', lastSyncedAt: '2025-01-15T00:00:00Z', resetCount: 2, name: null },
        ])
      const peers = useSyncStore.getState().peers
      expect(peers).toHaveLength(1)
      expect(peers[0]?.peerId).toBe('peer-2')
    })

    it('can set empty peers array', () => {
      useSyncStore
        .getState()
        .setPeers([{ peerId: 'peer-1', lastSyncedAt: null, resetCount: 0, name: null }])
      useSyncStore.getState().setPeers([])
      expect(useSyncStore.getState().peers).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // updateLastSynced
  // ---------------------------------------------------------------------------
  describe('updateLastSynced', () => {
    it('updates the last synced timestamp', () => {
      useSyncStore.getState().updateLastSynced('2025-01-15T12:00:00Z')
      expect(useSyncStore.getState().lastSyncedAt).toBe('2025-01-15T12:00:00Z')
    })

    it('overwrites previous timestamp', () => {
      useSyncStore.getState().updateLastSynced('2025-01-15T12:00:00Z')
      useSyncStore.getState().updateLastSynced('2025-01-16T08:00:00Z')
      expect(useSyncStore.getState().lastSyncedAt).toBe('2025-01-16T08:00:00Z')
    })
  })

  // ---------------------------------------------------------------------------
  // setOpsReceived
  // ---------------------------------------------------------------------------
  describe('setOpsReceived', () => {
    it('sets an absolute value for opsReceived', () => {
      useSyncStore.getState().setOpsReceived(42)
      expect(useSyncStore.getState().opsReceived).toBe(42)
    })

    it('overwrites previous value (not incremental)', () => {
      useSyncStore.getState().setOpsReceived(10)
      useSyncStore.getState().setOpsReceived(3)
      expect(useSyncStore.getState().opsReceived).toBe(3)
    })
  })

  // ---------------------------------------------------------------------------
  // setOpsSent
  // ---------------------------------------------------------------------------
  describe('setOpsSent', () => {
    it('sets an absolute value for opsSent', () => {
      useSyncStore.getState().setOpsSent(17)
      expect(useSyncStore.getState().opsSent).toBe(17)
    })

    it('overwrites previous value (not incremental)', () => {
      useSyncStore.getState().setOpsSent(10)
      useSyncStore.getState().setOpsSent(5)
      expect(useSyncStore.getState().opsSent).toBe(5)
    })
  })

  // ---------------------------------------------------------------------------
  // recordPeerProgress
  // ---------------------------------------------------------------------------
  describe('recordPeerProgress', () => {
    const ops = (state: string, sent: number, received: number) =>
      ({
        kind: 'sync',
        state,
        remote_device_id: 'R',
        ops_sent: sent,
        ops_received: received,
      }) as const
    const files = (phase: string, filesDone: number, bytesDone: number) =>
      ({
        kind: 'files',
        phase,
        remote_device_id: 'R',
        files_done: filesDone,
        files_total: 3,
        bytes_done: bytesDone,
        bytes_total: 9_000,
      }) as const

    it('keeps each peer apart', () => {
      useSyncStore.getState().recordPeerProgress('PEER_A', ops('streaming', 2, 1))
      useSyncStore.getState().recordPeerProgress('PEER_B', files('sending', 1, 3_000))

      expect(useSyncStore.getState().peerProgress).toEqual({
        PEER_A: { phase: 'ops', opsSent: 2, opsReceived: 1 },
        PEER_B: {
          phase: 'sending',
          filesDone: 1,
          filesTotal: 3,
          bytesDone: 3_000,
          bytesTotal: 9_000,
        },
      })
    })

    it('ends a peer on a terminal op state or the files complete tick, not the others', () => {
      const record = useSyncStore.getState().recordPeerProgress
      record('PEER_A', ops('streaming', 1, 1))
      record('PEER_B', ops('streaming', 1, 1))
      record('PEER_C', files('receiving', 0, 0))

      record('PEER_A', ops('complete', 2, 2))
      record('PEER_B', ops('error', 0, 0))
      expect(Object.keys(useSyncStore.getState().peerProgress)).toEqual(['PEER_C'])

      record('PEER_C', files('complete', 3, 9_000))
      expect(useSyncStore.getState().peerProgress).toEqual({})
    })

    it('ends a peer whose file exchange failed', () => {
      const record = useSyncStore.getState().recordPeerProgress
      record('PEER_B', files('receiving', 1, 3_000))

      record('PEER_B', files('failed', 0, 0))
      expect(useSyncStore.getState().peerProgress).toEqual({})
    })
  })

  // ---------------------------------------------------------------------------
  // reset
  // ---------------------------------------------------------------------------
  describe('reset', () => {
    it('resets all state to initial values', () => {
      // Set various state
      useSyncStore.getState().setState('error', 'Something broke')
      useSyncStore
        .getState()
        .setPeers([
          { peerId: 'peer-1', lastSyncedAt: '2025-01-15T00:00:00Z', resetCount: 0, name: null },
        ])
      useSyncStore.getState().updateLastSynced('2025-01-15T12:00:00Z')
      useSyncStore.getState().setOpsReceived(42)
      useSyncStore.getState().setOpsSent(17)
      useSyncStore.getState().recordPeerProgress('peer-1', {
        kind: 'sync',
        state: 'streaming',
        remote_device_id: 'peer-1',
        ops_sent: 1,
        ops_received: 0,
      })

      // Reset
      useSyncStore.getState().reset()

      // Verify all back to initial
      const state = useSyncStore.getState()
      expect(state.state).toBe('idle')
      expect(state.error).toBeNull()
      expect(state.peers).toEqual([])
      expect(state.lastSyncedAt).toBeNull()
      expect(state.opsReceived).toBe(0)
      expect(state.opsSent).toBe(0)
      expect(state.peerProgress).toEqual({})
    })
  })

  // ---------------------------------------------------------------------------
  // state independence
  // ---------------------------------------------------------------------------
  describe('state independence', () => {
    it('setState does not affect peers or counters', () => {
      useSyncStore
        .getState()
        .setPeers([{ peerId: 'peer-1', lastSyncedAt: null, resetCount: 0, name: null }])
      useSyncStore.getState().setOpsReceived(5)

      useSyncStore.getState().setState('syncing')

      expect(useSyncStore.getState().peers).toHaveLength(1)
      expect(useSyncStore.getState().opsReceived).toBe(5)
    })

    it('setPeers does not affect sync state or counters', () => {
      useSyncStore.getState().setState('syncing')
      useSyncStore.getState().setOpsSent(3)

      useSyncStore.getState().setPeers([])

      expect(useSyncStore.getState().state).toBe('syncing')
      expect(useSyncStore.getState().opsSent).toBe(3)
    })
  })
})
