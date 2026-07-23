import { Channel } from '@tauri-apps/api/core'

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { SyncProgressUpdate } from '@/lib/bindings'

/** Peer reference row returned by `list_peer_refs` / `get_peer_ref`.
 *  Fields match the Rust `PeerRef` struct (see src-tauri/agaric-store/src/peer_refs.rs). */
export interface PeerRefRow {
  peer_id: string
  last_hash: string | null
  last_sent_hash: string | null
  /** Epoch milliseconds (UTC), or null if never synced. #109 Phase 2: was an ISO string. */
  synced_at: number | null
  reset_count: number
  /** Epoch milliseconds (UTC), or null if never reset. #109 Phase 2: was an ISO string. */
  last_reset_at: number | null
  cert_hash: string | null
  device_name: string | null
  last_address: string | null
}

/** List all known peer references. */
export async function listPeerRefs(): Promise<PeerRefRow[]> {
  return unwrap(await commands.listPeerRefs())
}

/** Fetch a single peer reference by ID, or null if not found. */
export async function getPeerRef(peerId: string): Promise<PeerRefRow | null> {
  return unwrap(await commands.getPeerRef(peerId))
}

/** Delete a peer reference by ID. */
export async function deletePeerRef(peerId: string): Promise<void> {
  unwrap(await commands.deletePeerRef(peerId))
}

/** Update the display name for a paired peer. Pass null to clear. */
export async function updatePeerName(peerId: string, deviceName: string | null): Promise<void> {
  unwrap(await commands.updatePeerName(peerId, deviceName))
}

/** Manually set a peer's network address (host:port) for direct connection. */
export async function setPeerAddress(peerId: string, address: string): Promise<void> {
  unwrap(await commands.setPeerAddress(peerId, address))
}

/** Get the local device ID. */
export async function getDeviceId(): Promise<string> {
  return unwrap(await commands.getDeviceId())
}

// ---------------------------------------------------------------------------
// Sync protocol commands
// ---------------------------------------------------------------------------

export interface DeviceHead {
  device_id: string
  seq: number
  hash: string
}

export interface SyncSessionInfo {
  state: string
  local_device_id: string
  remote_device_id: string
  ops_received: number
  ops_sent: number
}

/** Start the pairing flow — returns a passphrase and QR SVG.
 *
 * The QR carries only the passphrase. mDNS owns discovery and
 * address resolution end-to-end, so there is no `host`/`port` field on
 * the returned payload.
 */
export async function startPairing(): Promise<{
  passphrase: string
  qr_svg: string
}> {
  return unwrap(await commands.startPairing())
}

/** Confirm a pairing with the given passphrase and remote device ID. */
export async function confirmPairing(passphrase: string, remoteDeviceId: string): Promise<void> {
  unwrap(await commands.confirmPairing(passphrase, remoteDeviceId))
}

/** Cancel an in-progress pairing. */
export async function cancelPairing(): Promise<void> {
  unwrap(await commands.cancelPairing())
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

/** Cancel an in-progress sync session. */
export async function cancelSync(): Promise<void> {
  unwrap(await commands.cancelSync())
}

// ---------------------------------------------------------------------------
// Page alias commands (#598)
// ---------------------------------------------------------------------------
