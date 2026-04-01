/**
 * Sync store -- manages peer-to-peer sync state.
 *
 * Tracks sync lifecycle (idle/discovering/pairing/syncing/error),
 * connected peers, and operation counters. The backend sync protocol
 * is not yet implemented; this store provides the frontend scaffolding.
 */

import { create } from 'zustand'

export type SyncState = 'idle' | 'discovering' | 'pairing' | 'syncing' | 'error'

export interface PeerInfo {
  peerId: string
  lastSyncedAt: string | null
  resetCount: number
}

interface SyncStore {
  state: SyncState
  error: string | null
  peers: PeerInfo[]
  lastSyncedAt: string | null
  opsReceived: number
  opsSent: number

  // Actions
  setState: (state: SyncState, error?: string | null) => void
  setPeers: (peers: PeerInfo[]) => void
  updateLastSynced: (timestamp: string) => void
  incrementOpsReceived: (count: number) => void
  incrementOpsSent: (count: number) => void
  setOpsReceived: (count: number) => void
  setOpsSent: (count: number) => void
  reset: () => void
}

const INITIAL_STATE = {
  state: 'idle' as SyncState,
  error: null as string | null,
  peers: [] as PeerInfo[],
  lastSyncedAt: null as string | null,
  opsReceived: 0,
  opsSent: 0,
}

export const useSyncStore = create<SyncStore>((set) => ({
  ...INITIAL_STATE,

  setState: (state: SyncState, error?: string | null) => {
    set({ state, error: error ?? null })
  },

  setPeers: (peers: PeerInfo[]) => {
    set({ peers })
  },

  updateLastSynced: (timestamp: string) => {
    set({ lastSyncedAt: timestamp })
  },

  incrementOpsReceived: (count: number) => {
    set((s) => ({ opsReceived: s.opsReceived + count }))
  },

  incrementOpsSent: (count: number) => {
    set((s) => ({ opsSent: s.opsSent + count }))
  },

  setOpsReceived: (count: number) => {
    set({ opsReceived: count })
  },

  setOpsSent: (count: number) => {
    set({ opsSent: count })
  },

  reset: () => {
    set({ ...INITIAL_STATE })
  },
}))
