## Session 833 — PEND-76 F3: decouple daemon activation from peer_refs (2026-05-24)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-24 |
| **Subagents** | orchestrator-direct |
| **Items closed** | PEND-76 F3 (pairing wrote a junk empty-string peer_refs row) |
| **Items modified** | PEND-76 (F3 → fixed; all 5 clusters now addressed) |
| **Tests added** | +0 (frontend) / +5 (backend) |
| **Files touched** | 5 (+ `.sqlx` cache) |

**Summary:** Fixed PEND-76 F3. `confirm_pairing` wrote a junk empty-string
`peer_refs` row (the FE has no remote device_id at confirm time), which showed as a
blank ghost peer — but that row was *load-bearing*: it was the only thing tripping
`should_start_active`, so the dormant daemon woke to accept the first post-pairing
connection. Decoupled activation from `peer_refs` via a persistent `app_settings`
marker `sync.pending_pairing`: `confirm_pairing` sets it (empty-id case) instead of
the junk row; `should_start_active` activates when real peers exist OR the marker is
set, and clears the marker once a real peer exists; `list_peer_refs` defensively
filters empty `peer_id`s. A non-empty device_id (if the FE ever supplies one) still
persists a real peer — so the existing pairing tests stay green.

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged (PEND-76 cluster; no REVIEW-LATER rows touched).
- **Previously resolved:** 1342+ (unchanged).

**Files touched (this session):**
- `src-tauri/src/peer_refs.rs` (pending-pairing helpers + empty-id filter + 2 tests)
- `src-tauri/src/sync_daemon/mod.rs` (`should_start_active` honors/clears the marker)
- `src-tauri/src/sync_daemon/tests.rs` (+2 tests)
- `src-tauri/src/commands/sync_cmds.rs` (`confirm_pairing_inner` sets marker for empty id)
- `src-tauri/src/commands/tests/sync_cmd_tests.rs` (+1 test)
- `src-tauri/.sqlx/` (regenerated for the new app_settings queries + filtered list_peer_refs)

**Verification:**
- `cargo nextest run -p agaric peer_refs:: sync_daemon::tests::should_start_active confirm_pairing pending_pairing` — 34 pass (5 new).
- `cargo sqlx prepare -- --tests` regenerated; `prek run --all-files` at commit.

**Lessons learned:** **Cannot verify end-to-end here** — the activation *decision* is
unit-tested, but the full pairing → daemon-accepts-connection → TOFU-writes-real-peer
→ first-sync handshake needs two real paired devices. Reused the existing (unused-in-
Rust) `app_settings` KV table for the marker, avoiding a new migration.

**Commit plan:** single commit; not pushed.
