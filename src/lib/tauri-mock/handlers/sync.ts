/**
 * Tauri mock handlers -- Peer sync/pairing and MCP status/control.
 *
 * Split out of the former monolithic `handlers.ts` (#2931). Every handler
 * body below is UNCHANGED from the original -- only relocated. Shared
 * mutable mock state (`blocks`, `opLog`, `properties`, ...) and cross-domain
 * helpers come from `./shared` / `@/lib/tauri-mock/seed`, the single source
 * every domain module reads and writes -- there is no per-domain copy of any
 * store.
 */

import { type TypedHandlers, returnNull, returnUndefined } from '@/lib/tauri-mock/handlers/shared'

export const syncHandlers = {
  list_peer_refs: () => [],
  get_peer_ref: returnNull,
  delete_peer_ref: returnUndefined,
  get_device_id: () => 'mock-device-id-0000',

  start_pairing: () => ({
    passphrase: 'alpha bravo charlie delta',
    qr_svg: '<svg></svg>',
  }),
  confirm_pairing: returnUndefined,
  cancel_pairing: returnUndefined,

  start_sync: (args) => {
    const a = args as Record<string, unknown>
    return {
      state: 'syncing',
      local_device_id: 'mock-device-id-0000',
      remote_device_id: a['peerId'],
      ops_received: 0,
      ops_sent: 0,
    }
  },

  cancel_sync: returnUndefined,

  // #2506 — mDNS-status backfill. The mock environment has no real mDNS
  // service, but its peer discovery is simply out of scope (not disabled)
  // — so the mock reports the healthy default the same way a real device
  // with working mDNS would.
  get_mdns_status: () => ({ disabled: false, reason: null }),

  // ---------------------------------------------------------------------------
  // Task properties (todo/priority/due/scheduled)
  // ---------------------------------------------------------------------------

  update_peer_name: returnUndefined,

  // ---------------------------------------------------------------------------
  // Page alias commands
  // ---------------------------------------------------------------------------

  set_peer_address: returnNull,

  // ---------------------------------------------------------------------------
  // Page links for graph view (F-33)
  // ---------------------------------------------------------------------------

  get_mcp_status: () => ({
    enabled: false,
    socket_path: '/mock/agaric-mcp-ro.sock',
    active_connections: 0,
  }),

  get_mcp_socket_path: () => '/mock/agaric-mcp-ro.sock',

  mcp_set_enabled: (args) => {
    const a = args as Record<string, unknown>
    return (a['enabled'] as boolean) ?? false
  },

  mcp_disconnect_all: returnNull,

  // #695 — activity-ring read surface. The mock server has no agent
  // traffic, so the recent-activity feed is always empty.
  get_mcp_recent_activity: () => [],

  get_mcp_rw_status: () => ({
    enabled: false,
    socket_path: '/mock/agaric-mcp-rw.sock',
    active_connections: 0,
  }),

  get_mcp_rw_socket_path: () => '/mock/agaric-mcp-rw.sock',

  mcp_rw_set_enabled: (args) => {
    const a = args as Record<string, unknown>
    return (a['enabled'] as boolean) ?? false
  },

  mcp_rw_disconnect_all: returnNull,

  // ---------------------------------------------------------------------------
  // Trash descendant counts
  //
  // Returns a map of root_id → number of cascade-deleted descendants.
  //
  // ── Semantic divergence from the Rust backend ─────────────────────────
  // The Rust impl in `src-tauri/src/commands/blocks/queries.rs`
  // (`trash_descendant_counts_inner` → `pagination::trash_descendant_counts`)
  // uses a SQL JOIN on the root's `deleted_at` timestamp, so it counts
  // only blocks deleted in the *same cascade-batch* as the root.
  //
  // The mock here counts ALL soft-deleted descendants of the root via a
  // BFS over `parent_id`, regardless of *when* they were deleted.
  //
  // For the current Playwright e2e seed-data flows the two converge,
  // because the seed deletes whole subtrees in a single batch. Revisit
  // this if a Playwright spec ever creates mixed-batch trash state
  // (e.g. partial restore-then-redelete) — at that point the mock will
  // need to track and join on `deleted_at` like the Rust impl.
  // ---------------------------------------------------------------------------
} satisfies Pick<
  TypedHandlers,
  | 'list_peer_refs'
  | 'get_peer_ref'
  | 'delete_peer_ref'
  | 'get_device_id'
  | 'start_pairing'
  | 'confirm_pairing'
  | 'cancel_pairing'
  | 'start_sync'
  | 'cancel_sync'
  | 'get_mdns_status'
  | 'update_peer_name'
  | 'set_peer_address'
  | 'get_mcp_status'
  | 'get_mcp_socket_path'
  | 'mcp_set_enabled'
  | 'mcp_disconnect_all'
  | 'get_mcp_recent_activity'
  | 'get_mcp_rw_status'
  | 'get_mcp_rw_socket_path'
  | 'mcp_rw_set_enabled'
  | 'mcp_rw_disconnect_all'
>
