import { beforeEach, describe, expect, it } from 'vitest'
import { useSyncStore } from '../sync'

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
      const states = ['idle', 'discovering', 'pairing', 'syncing', 'error'] as const
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
        { peerId: 'peer-1', lastSyncedAt: '2025-01-15T00:00:00Z', resetCount: 0 },
        { peerId: 'peer-2', lastSyncedAt: null, resetCount: 1 },
      ]
      useSyncStore.getState().setPeers(peers)
      expect(useSyncStore.getState().peers).toEqual(peers)
    })

    it('replaces existing peers', () => {
      useSyncStore.getState().setPeers([{ peerId: 'peer-1', lastSyncedAt: null, resetCount: 0 }])
      useSyncStore
        .getState()
        .setPeers([{ peerId: 'peer-2', lastSyncedAt: '2025-01-15T00:00:00Z', resetCount: 2 }])
      const peers = useSyncStore.getState().peers
      expect(peers).toHaveLength(1)
      expect(peers[0].peerId).toBe('peer-2')
    })

    it('can set empty peers array', () => {
      useSyncStore.getState().setPeers([{ peerId: 'peer-1', lastSyncedAt: null, resetCount: 0 }])
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
  // incrementOpsReceived
  // ---------------------------------------------------------------------------
  describe('incrementOpsReceived', () => {
    it('increments by the given count', () => {
      useSyncStore.getState().incrementOpsReceived(5)
      expect(useSyncStore.getState().opsReceived).toBe(5)
    })

    it('accumulates across multiple calls', () => {
      useSyncStore.getState().incrementOpsReceived(3)
      useSyncStore.getState().incrementOpsReceived(7)
      expect(useSyncStore.getState().opsReceived).toBe(10)
    })
  })

  // ---------------------------------------------------------------------------
  // incrementOpsSent
  // ---------------------------------------------------------------------------
  describe('incrementOpsSent', () => {
    it('increments by the given count', () => {
      useSyncStore.getState().incrementOpsSent(4)
      expect(useSyncStore.getState().opsSent).toBe(4)
    })

    it('accumulates across multiple calls', () => {
      useSyncStore.getState().incrementOpsSent(2)
      useSyncStore.getState().incrementOpsSent(8)
      expect(useSyncStore.getState().opsSent).toBe(10)
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
        .setPeers([{ peerId: 'peer-1', lastSyncedAt: '2025-01-15T00:00:00Z', resetCount: 0 }])
      useSyncStore.getState().updateLastSynced('2025-01-15T12:00:00Z')
      useSyncStore.getState().incrementOpsReceived(42)
      useSyncStore.getState().incrementOpsSent(17)

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
    })
  })

  // ---------------------------------------------------------------------------
  // state independence
  // ---------------------------------------------------------------------------
  describe('state independence', () => {
    it('setState does not affect peers or counters', () => {
      useSyncStore.getState().setPeers([{ peerId: 'peer-1', lastSyncedAt: null, resetCount: 0 }])
      useSyncStore.getState().incrementOpsReceived(5)

      useSyncStore.getState().setState('syncing')

      expect(useSyncStore.getState().peers).toHaveLength(1)
      expect(useSyncStore.getState().opsReceived).toBe(5)
    })

    it('setPeers does not affect sync state or counters', () => {
      useSyncStore.getState().setState('syncing')
      useSyncStore.getState().incrementOpsSent(3)

      useSyncStore.getState().setPeers([])

      expect(useSyncStore.getState().state).toBe('syncing')
      expect(useSyncStore.getState().opsSent).toBe(3)
    })
  })
})
