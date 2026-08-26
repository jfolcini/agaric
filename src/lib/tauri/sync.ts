import { Channel } from '@tauri-apps/api/core'

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { PeerRef, SyncProgressUpdate } from '@/lib/bindings'

/** List all known peer references. */
export async function listPeerRefs(): Promise<PeerRef[]> {
  return unwrap(await commands.listPeerRefs())
}

// ---------------------------------------------------------------------------
// Sync protocol commands
// ---------------------------------------------------------------------------
//
// Note: Rust `sync_protocol::DeviceHead` (device_id/seq/hash) never crosses
// the Tauri IPC boundary — it's an internal wire type used between the sync
// daemons over their own TCP protocol (see `agaric-sync/src/sync_protocol`),
// not a `#[tauri::command]` parameter or return type, so it has no
// `bindings.ts` entry and no frontend consumer. #3209 removed the unused TS
// mirror that used to live here; re-add it only if a command starts
// returning device-head data to the frontend.

export interface SyncSessionInfo {
  state: string
  local_device_id: string
  remote_device_id: string
  ops_received: number
  ops_sent: number
}

/** Start a sync session with a known peer. */
export async function startSync(
  peerId: string,
  onProgress?: (update: SyncProgressUpdate) => void,
): Promise<SyncSessionInfo> {
  const channel = new Channel<SyncProgressUpdate>()
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Tauri `Channel` is an IPC primitive, not a DOM EventTarget; it only exposes an `onmessage` setter (no `addEventListener`)
  if (onProgress) channel.onmessage = onProgress
  return unwrap(await commands.startSync(peerId, channel))
}
