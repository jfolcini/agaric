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
import { fakeId, pairingPeerReveal, peerRefs } from '@/lib/tauri-mock/seed'

// #3469 (review) — how many `list_peer_refs` reads must elapse after a
// `confirm_pairing` before the mock materializes the pinned peer row.
//
// Three, because the joiner makes exactly two reads before its poll loop
// starts ticking and BOTH must still be peer-free:
//   1. the authoritative baseline snapshot `PairingDialog` takes inside
//      `executePair`'s `call`, immediately after `confirm_pairing`
//      resolves. A peer present here lands in the baseline set, so the
//      success effect can never see it as new and the wait DEADLOCKS
//      until the 5-minute TTL.
//   2. the immediate fetch `usePollingQuery` fires the instant `enabled`
//      flips true (usePollingQuery.ts:106 — the effect calls `load()`
//      before arming its interval). A peer present here resolves the wait
//      in the same frame it opened, which is the pre-#3469 "claim success
//      the moment `pair()` returned" lie wearing a poll's clothes.
// The third read is the first 2s interval tick, and that is where the
// peer legitimately appears — one full poll interval of honest waiting.
//
// ASSUMPTION this count depends on (#3499 review): the counter is mutated
// on READ, so `3` silently encodes "the pairing dialog is the only caller
// of `list_peer_refs` during the wait". True today — `DeviceManagement`'s
// load is mount/close-driven and `useSyncTrigger.ts:246` / `App.tsx:344`
// are event-driven — but any added interval refresh of the device list
// consumes a read, shifting the reveal one tick earlier and turning the
// E2E spec's "waiting state persists" assertion into an instant success.
// Add a reader, re-derive this number. Mock-only; no production risk.
const PAIRING_PEER_REVEAL_READS = 3

// #3463 — the mock used to accept ANY passphrase (`confirm_pairing:
// returnUndefined`), an unconditional no-op success that hid the real bug
// (the FE unconditionally started a competing pairing session on every
// device that opened the dialog, so real two-device pairing was structurally
// impossible) from dev mode and every frontend test for months.
//
// As landed on the backend (#3463), `confirm_pairing` does NOT compare the
// typed passphrase against anything held locally — the joiner arms a local
// "pending pairing" proof from whatever the user typed, and a WRONG
// passphrase is only discovered later, on the wire, when the two devices'
// proofs fail to match during the actual sync handshake. So a resolved
// promise from this handler does NOT mean the passphrase was correct — it
// means a confirm request was accepted for processing. There is no `pairing.
// passphrase.mismatch` tag any more; the backend never emits it.
//
// Modelling that wire-level proof mismatch faithfully is out of scope for
// this single-process browser mock — there is no peer transport for a wrong
// passphrase to fail against. If a sync/connect mock handler ever grows a
// notion of a remote peer, THAT is where a wrong-passphrase failure belongs,
// not here. (#3469: this remains true — `confirm_pairing` below still
// succeeds unconditionally for any input. What #3469 adds is that a peer
// row eventually appears in the `peerRefs` mock store, mimicking the real
// TOFU pin on first authenticated connection, so the FE's post-confirm
// `list_peer_refs` poll — the honest "did the peer actually appear" signal
// — has something to observe under dev mode / E2E instead of a static
// `[]`.
//
// What this mock therefore DOES represent: the SHAPE of a successful
// outcome — a peer that was absent when the proof was armed and present a
// couple of reads later, which is the only evidence the FE is allowed to
// treat as success. What it does NOT represent: any judgement about the
// passphrase. Every input, right or wrong, empty or garbage, reaches the
// same success path here, because the thing that would distinguish them —
// a peer comparing proofs over a transport — does not exist in a
// single-process browser mock. Dev mode and E2E consequently exercise the
// waiting state and its success resolution; they cannot exercise
// rejection. That path is covered at the unit layer
// (`PairingDialog.test.tsx`, via the `useSyncStore` error signal).
//
// The reveal is deliberately NOT synchronous inside `confirm_pairing`.
// See `PAIRING_PEER_REVEAL_READS` above for why both of the joiner's
// pre-tick reads must still be peer-free — a synchronous insert breaks
// the flow in BOTH directions (instant false success, or a permanently
// deadlocked wait, depending on which side of the baseline read it lands).
//
// `confirm_pairing` also does NOT require a prior `start_pairing` call on
// this device any more. It briefly did (`pairing.no_active_session`, a
// UI-state guard), but that guard was satisfiable only by a device that had
// itself called `start_pairing` — i.e. only by a host — so it made every
// pure joiner fail on every real attempt, which is exactly the role
// confusion #3463 exists to fix. It was removed from the backend, and
// `pairing.no_active_session` is not returned by `confirm_pairing` at all
// any more (the tag itself still exists and is used elsewhere). This mock
// therefore succeeds unconditionally for any input, including an empty
// passphrase — there is no backend-side check left to model here. (The FE's
// own "Pair disabled while any word is empty" is a pure client-side
// affordance and never reaches this handler.)
export const syncHandlers = {
  list_peer_refs: () => {
    // #3469 (review) — a `confirm_pairing` arms a pending reveal; the peer
    // materializes here, on a LATER read, never inside the confirm call.
    if (pairingPeerReveal.readsRemaining > 0) {
      pairingPeerReveal.readsRemaining -= 1
      if (pairingPeerReveal.readsRemaining === 0) {
        const peerId = fakeId()
        peerRefs.set(peerId, {
          peer_id: peerId,
          last_hash: null,
          last_sent_hash: null,
          synced_at: null,
          reset_count: 0,
          last_reset_at: null,
          cert_hash: 'mock-cert-hash',
          device_name: 'Paired Device',
          last_address: null,
        })
      }
    }
    return Array.from(peerRefs.values())
  },
  get_peer_ref: (args) => {
    const a = args as Record<string, unknown>
    return peerRefs.get(a['peerId'] as string) ?? null
  },
  delete_peer_ref: (args) => {
    const a = args as Record<string, unknown>
    peerRefs.delete(a['peerId'] as string)
  },
  get_device_id: () => 'mock-device-id-0000',

  start_pairing: () => ({
    passphrase: 'alpha bravo charlie delta',
    qr_svg: '<svg></svg>',
  }),
  confirm_pairing: () => {
    // #3469 — arms this device's local proof, exactly as the backend does,
    // and NOTHING else observable. In particular it does not pin a peer:
    // the real TOFU pin happens later, on the first authenticated
    // connection, and the joiner learns about it only by re-reading
    // `list_peer_refs`. Arming a pending reveal (rather than inserting the
    // row here) is what keeps the mock from re-asserting the very claim
    // #3469 deletes — see `PAIRING_PEER_REVEAL_READS`.
    pairingPeerReveal.readsRemaining = PAIRING_PEER_REVEAL_READS
  },
  cancel_pairing: () => {
    // #3493 — cancelling disarms this device's pending-pairing marker on
    // the real backend (`cancel_pairing_inner` deletes the row), so nothing
    // can pair against it afterwards. The mock's stand-in for that armed
    // marker is the pending peer reveal above, so cancel must clear it too.
    // Left as `returnUndefined`, the mock would keep counting down and pin
    // a peer several `list_peer_refs` reads AFTER the user cancelled —
    // dev mode and E2E would show a device pairing itself out of a
    // cancelled attempt, which is the exact behaviour #3493 removes.
    pairingPeerReveal.readsRemaining = 0
  },

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
