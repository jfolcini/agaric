/**
 * Sync store -- manages peer-to-peer sync state.
 *
 * Tracks sync lifecycle (idle/syncing/error/offline), connected peers,
 * operation counters, and each peer's in-flight session progress.
 *
 * #1076: the `discovering` and `pairing` members were removed — they
 * were dead. The only writers of `state` are `mapBackendState`
 * (useSyncEvents.ts, returns idle/syncing/error) and the offline guard
 * in `useSyncTrigger`; nothing ever produced `discovering`/`pairing`, so
 * every UI branch keyed on them was unreachable. Do NOT re-add a member
 * here without a corresponding writer, or you reintroduce dead UI.
 */

import { create } from 'zustand'

import type { SyncProgressUpdate } from '@/lib/bindings'

export type SyncState = 'idle' | 'syncing' | 'error' | 'offline'

export interface PeerInfo {
  peerId: string
  lastSyncedAt: string | null
  resetCount: number
  /** What the user calls the device (`peerName`), or `null` when unnamed. */
  name: string | null
}

/**
 * What one peer's running session has reported so far, keyed by peer id in
 * `peerProgress`. Ops come first; the attachment exchange follows a completed
 * op sync, one `receiving` and one `sending` pass, each with its own totals.
 */
export type PeerSyncProgress =
  | { phase: 'ops'; opsSent: number; opsReceived: number }
  | {
      phase: 'sending' | 'receiving'
      filesDone: number
      filesTotal: number
      bytesDone: number
      bytesTotal: number
    }

/**
 * `null` ends the peer's progress: a terminal op state (`complete` or
 * `error`), or the file exchange's `complete` or `failed` tick.
 */
function toPeerProgress(update: SyncProgressUpdate): PeerSyncProgress | null {
  if (update.kind === 'sync') {
    if (update.state === 'complete' || update.state === 'error') return null
    return { phase: 'ops', opsSent: update.ops_sent, opsReceived: update.ops_received }
  }
  if (update.phase !== 'sending' && update.phase !== 'receiving') return null
  return {
    phase: update.phase,
    filesDone: update.files_done,
    filesTotal: update.files_total,
    bytesDone: update.bytes_done,
    bytesTotal: update.bytes_total,
  }
}

interface SyncStore {
  state: SyncState
  error: string | null
  peers: PeerInfo[]
  lastSyncedAt: string | null
  opsReceived: number
  opsSent: number
  peerProgress: Record<string, PeerSyncProgress>

  // Actions
  setState: (state: SyncState, error?: string | null) => void
  setPeers: (peers: PeerInfo[]) => void
  updateLastSynced: (timestamp: string) => void
  setOpsReceived: (count: number) => void
  setOpsSent: (count: number) => void
  recordPeerProgress: (peerId: string, update: SyncProgressUpdate) => void
  reset: () => void
}

const INITIAL_STATE = {
  state: 'idle' as SyncState,
  error: null as string | null,
  peers: [] as PeerInfo[],
  lastSyncedAt: null as string | null,
  opsReceived: 0,
  opsSent: 0,
  peerProgress: {} as Record<string, PeerSyncProgress>,
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

  setOpsReceived: (count: number) => {
    set({ opsReceived: count })
  },

  setOpsSent: (count: number) => {
    set({ opsSent: count })
  },

  recordPeerProgress: (peerId, update) => {
    set((s) => {
      const { [peerId]: _ended, ...others } = s.peerProgress
      const progress = toPeerProgress(update)
      return { peerProgress: progress == null ? others : { ...others, [peerId]: progress } }
    })
  },

  reset: () => {
    set({ ...INITIAL_STATE })
  },
}))
