/**
 * Sync store: the sync lifecycle (idle, syncing, waiting, error, offline),
 * connected peers, op counters, and each peer's in-flight session progress.
 * Add a `state` member only together with something that writes it (#1076).
 */

import { create } from 'zustand'

import type { SyncProgressUpdate } from '@/lib/bindings'

/** `waiting`: a paired device is away, which is no failure (#6523). */
export type SyncState = 'idle' | 'syncing' | 'waiting' | 'error' | 'offline'

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
  /** The peer the `waiting` state waits for; `null` in every other state. */
  waitingFor: string | null
  peers: PeerInfo[]
  /** The latest sync known: this session's, or one a paired device's row stored. */
  lastSyncedAt: string | null
  opsReceived: number
  opsSent: number
  peerProgress: Record<string, PeerSyncProgress>
  /**
   * Spaces whose changes are not sent to other devices, as the backend's last
   * `sync:export_refused` report listed them (#6523). Not session state: a
   * state change leaves it.
   */
  exportRefusedSpaces: string[]

  setState: (state: SyncState, error?: string | null) => void
  setWaiting: (peerId: string) => void
  setExportRefusedSpaces: (spaceIds: string[]) => void
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
  waitingFor: null as string | null,
  peers: [] as PeerInfo[],
  lastSyncedAt: null as string | null,
  opsReceived: 0,
  opsSent: 0,
  peerProgress: {} as Record<string, PeerSyncProgress>,
  exportRefusedSpaces: [] as string[],
}

export const useSyncStore = create<SyncStore>((set) => ({
  ...INITIAL_STATE,

  setState: (state: SyncState, error?: string | null) => {
    set({ state, error: error ?? null, waitingFor: null })
  },

  setWaiting: (peerId: string) => {
    set({ state: 'waiting', error: null, waitingFor: peerId })
  },

  setExportRefusedSpaces: (spaceIds: string[]) => {
    set({ exportRefusedSpaces: spaceIds })
  },

  setPeers: (peers: PeerInfo[]) => {
    // #6523 — a peer's stored sync time outlives a restart; this session's
    // `lastSyncedAt` starts empty.
    set((s) => ({
      peers,
      lastSyncedAt: peers.reduce(
        (latest, { lastSyncedAt }) =>
          lastSyncedAt !== null &&
          (latest === null || Date.parse(lastSyncedAt) > Date.parse(latest))
            ? lastSyncedAt
            : latest,
        s.lastSyncedAt,
      ),
    }))
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
