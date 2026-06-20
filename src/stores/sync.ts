/**
 * Sync store -- manages peer-to-peer sync state.
 *
 * Tracks sync lifecycle (idle/syncing/error/offline), connected peers,
 * and operation counters.
 *
 * #1076: the `discovering` and `pairing` members were removed — they
 * were dead. The only writers of `state` are `mapBackendState`
 * (useSyncEvents.ts, returns idle/syncing/error) and the offline guard
 * in `useSyncTrigger`; nothing ever produced `discovering`/`pairing`, so
 * every UI branch keyed on them was unreachable. Do NOT re-add a member
 * here without a corresponding writer, or you reintroduce dead UI.
 */

import { create } from 'zustand'

export type SyncState = 'idle' | 'syncing' | 'error' | 'offline'

export interface PeerInfo {
  peerId: string
  lastSyncedAt: string | null
  resetCount: number
}

/**
 * File-transfer phase for the post-sync attachment exchange.
 *
 * `null` means no file-transfer phase is active (idle / pre-sync /
 * sync without attachments). The string values mirror the backend's
 * `SyncProgressUpdate::Files.phase`: `"sending"` (we're shipping
 * attachments to the peer), `"receiving"` (we're pulling), and
 * `"complete"` (terminal tick before reset).
 */
export type FilePhase = 'sending' | 'receiving' | 'complete' | null

interface SyncStore {
  state: SyncState
  error: string | null
  peers: PeerInfo[]
  lastSyncedAt: string | null
  opsReceived: number
  opsSent: number
  // Attachment-transfer progress (post-op-sync phase).
  // `filesTotal === 0` is the steady-state "nothing to transfer" case
  // and the UI should hide the file progress affordance.
  filePhase: FilePhase
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number

  // Actions
  setState: (state: SyncState, error?: string | null) => void
  setPeers: (peers: PeerInfo[]) => void
  updateLastSynced: (timestamp: string) => void
  setOpsReceived: (count: number) => void
  setOpsSent: (count: number) => void
  setFileProgress: (
    phase: Exclude<FilePhase, null>,
    filesDone: number,
    filesTotal: number,
    bytesDone: number,
    bytesTotal: number,
  ) => void
  resetFileProgress: () => void
  reset: () => void
}

const INITIAL_FILE_PROGRESS = {
  filePhase: null as FilePhase,
  filesDone: 0,
  filesTotal: 0,
  bytesDone: 0,
  bytesTotal: 0,
}

const INITIAL_STATE = {
  state: 'idle' as SyncState,
  error: null as string | null,
  peers: [] as PeerInfo[],
  lastSyncedAt: null as string | null,
  opsReceived: 0,
  opsSent: 0,
  ...INITIAL_FILE_PROGRESS,
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

  setFileProgress: (phase, filesDone, filesTotal, bytesDone, bytesTotal) => {
    set({
      filePhase: phase,
      filesDone,
      filesTotal,
      bytesDone,
      bytesTotal,
    })
  },

  resetFileProgress: () => {
    set({ ...INITIAL_FILE_PROGRESS })
  },

  reset: () => {
    set({ ...INITIAL_STATE })
  },
}))
