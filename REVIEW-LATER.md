# Review Later

> **Last updated:** 2026-05-02 (Frontend test code review — TEST-FE-1 through TEST-FE-8)

Items flagged during development that need revisiting. Organized by section with cost estimates.

> **Do not add "Resolved" sections to this file.** When an item is resolved, remove it
> entirely (table row + detail section). Do NOT record the removal anywhere in this file.

> **No historical references.** This file tracks only open items. No session logs,
> no "resolved in session X" notes, no reclassification history, no audit narratives.
> When an item is resolved, delete it completely. When an item is reclassified, update
> it in place. The git history is the audit trail — this file is not a changelog.
> Session activity is tracked separately in `SESSION-LOG.md`.

**Cost key:** S = <2h, M = 2-8h, L = 8h+

---

## Summary

62 open items.

| ID | Section | Title | Cost | Blocked on |
|----|---------|-------|------|-----------|
| FEAT-3p9 | FEAT | Spaces Phase 9: per-space external integrations — foundation (per-space `gcal_space_config` table + per-space keychain key + legacy single-space migration) in place; remaining work threads `space_id` through oauth/lease/connector/commands, branches the push loop by space, ships per-space Settings accordion, and (when FEAT-11 lands) prefixes OS notifications with the space name | M | — (M3 sub-task blocked on FEAT-11) |
| FEAT-5g | FEAT | GCal: Android OAuth + background connector (DEFERRED — design sketch only) | L | Design review |
| FEAT-11 | FEAT | Adopt `tauri-plugin-notification` — OS notifications for due tasks / scheduled events (Org-mode parity, especially on mobile) | L | — |
| MAINT-111 | MAINT | Migrate MCP server JSON-RPC framing onto `rmcp` 1.6 (reference impl behind `mcp_rmcp_spike` feature flag; 3 milestones, 12-14h end-to-end) | L | — |
| MAINT-113 | MAINT | `ConflictFreeBlockId` newtype to lift invariant #9 (`is_conflict = 0` + `depth < 100` in every recursive CTE over `blocks`) into the type system — 275 `is_conflict = 0` SQL occurrences across 52 files (count refreshed 2026-05-02). **SCHEDULED** — owner-prioritized, planned across 3 milestones (M1 newtype + 5 high-traffic helpers; M2 backlink/tag-inheritance/property paths; M3 cascade/move/delete + materializer). Eliminates an entire class of "forgot to filter conflicts" bugs at compile time. | L | — |
| MAINT-114 | MAINT | Consolidation audit of `.github/workflows/` — fold `release-tag.yml` into `release.yml` as a `workflow_dispatch` job (4 → 3 files). Spike-then-commit; abandon if merged file isn't shorter than the sum. | S–M | — |
| MAINT-128 | MAINT | God-component decomposition: `PropertyRowEditor.tsx` (550L) — split each typed editor (text/number/date/ref/select) into its own component AND lift the shared state (`localValue`, date hook, select-options, ref-picker, 10+ callbacks) UP into a containing hook. **SCHEDULED** — owner-prioritized; refactor path locked in. Removes the only `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` in the codebase (at L85). | L | — |
| MAINT-168 | MAINT | Sync trigger / scheduler dual-backoff unification — `useSyncTrigger.ts` (60s → 600s) and `sync_scheduler.rs` (1s → 60s) run independent exponential backoffs that never coordinate. Not a correctness bug; the backend is the authoritative scheduler and silently rejects redundant `startSync` calls. Filed as a documented design note after this session's bird's-eye review. | M | — |
| MAINT-169 | MAINT | GCal connector: `DateFailure::Skipped` per-date errors are logged but never persisted to `gcal_space_config.last_error` — Settings UI shows no feedback for transient per-date failures until the next reconcile clears the dirty set | S | — |
| MAINT-170 | MAINT | Backlink: `eval_unlinked_references` collapses `total_count = filtered_count` (out of parity with `eval_backlink_query_grouped`); UI badge under-reports the unlinked-ref count when filters are active | S | — |
| MAINT-171 | MAINT | Recurrence: 8 duplicated `set_property_in_tx` call sites in `apply_recurrence_advance` — extract a small helper to reduce copy-paste surface | S | — |
| MAINT-172 | MAINT | Pagination/queries: space-filter SQL fragment inlined across 13+ files because `sqlx::query_as!` rejects `concat!()`; `space_filter_clause!` macro referenced in comments but unusable. Real maintenance hotspot, sqlx-constrained | M | sqlx upstream |
| PERF-19 | PERF | Backlink pagination cursor uses linear scan for non-Created sorts (2 sites) | S | — |
| PERF-20 | PERF | Backlink filter resolver has no concurrency cap on `try_join_all` | S | — |
| PERF-23 | PERF | `read_attachment_file` buffers whole file before chunked send | S | — |
| PERF-24 | PERF | `cache/block_tag_refs.rs::reindex_block_tag_refs` issues per-target DELETE/INSERT in a loop; sibling `block_links.rs` already batches via `json_each` | S | — |
| PERF-25 | PERF | `gcal_push/connector.rs::GcalSettingsSnapshot::read` issues 4 separate `SELECT`s every cycle; trivially batchable via `key IN (?, ?, ?, ?)` | S | — |
| PERF-26 | PERF | `link_metadata/mod.rs::fetch_metadata` rebuilds `reqwest::Client` per call; should reuse a `OnceLock` like `gcal_push/api.rs` does | S | — |
| PERF-27 | PERF | `backlink/filters.rs::PropertyText` filter fetches all rows for the property key then compares in Rust; push the operator into SQL `WHERE` | S | — |
| PUB-2 | PUB | Git author email across all history is corporate (`javier.folcini@avature.net`) | S | Identity decision |
| PUB-3 | PUB | Employer IP clearance before public release | S | Employer review |
| PUB-5 | PUB | Tauri updater — endpoint URL pinned to `jfolcini/agaric`; remaining work is user-only (generate Minisign keypair, paste pubkey into `tauri.conf.json`, add 2 GH Actions secrets, uncomment env vars in `release.yml`) | S | User-only |
| PUB-8 | PUB | Android release keystore + 4 GH Actions secrets (apksigner wiring already shipped in `release.yml`) | S | User-only |
| TEST-1 | TEST | `delete_block_inner` calls `now_rfc3339()` twice — production timestamp-mismatch bug surfaced by hardcoded-timestamp workaround in `revert_delete_block_restores_with_descendants` | S | — |
| TEST-2 | TEST | Inequality count assertions where exact count is known (3 sites: integration_tests `bg >= 1`, agenda projection `entries.len() >= 3`, recovery `draft_errors.len() >= 2`) | S | — |
| TEST-3 | TEST | Brittle `err.to_string().contains(...)` / event-message `.contains(...)` assertions instead of `matches!(AppError::Variant(_))` (11 in `block_cmd_tests.rs`, 9 in `sync_daemon/tests.rs`) | S | — |
| TEST-4 | TEST | Sync daemon tests use 18 fixed sleeps (50–800ms) as race-prone "barriers" because no `wait_for_*` helper exists on `SyncDaemon` / `SyncScheduler` | M | — |
| TEST-5 | TEST | `delete_block_cascades_to_children` doesn't verify op_log entries (only checks response struct) | S | — |
| TEST-6 | TEST | Sync merge tests assert on counter only, not materialized state (`merge_resolves_property_conflict_lww` doesn't query `block_properties`; `merge_block_conflict_creates_copy` doesn't query `blocks` for the conflict copy) | S | — |
| TEST-7 | TEST | Reverse tests don't verify batch ordering (newest-first by `created_at DESC, seq DESC`) or op-log append-only invariant (count increases by 1) | S | — |
| TEST-8 | TEST | TOFU test only covers acceptance, not rejection on cert-hash mismatch on reconnect (`inmem_handle_incoming_sync_tofu_stores_cert_hash`) | S | — |
| TEST-9 | TEST | `two_device_create_sync_both_see_block` only checks op_log via `get_op_by_seq`, never queries `blocks` to verify materialization | S | — |
| TEST-10 | TEST | Snapshot tests missing redactions of non-deterministic fields: `snapshot_history_entry_response` (cursor), `snapshot_list_blocks_response` (comment promises but no redaction call) | S | — |
| TEST-11 | TEST | Missing error-path test coverage: `export_page_markdown_inner` has 6 happy-path tests + 0 error tests; `set_property_inner` integration tests miss invalid-key / type-mismatch Validation cases | S | — |
| TEST-12 | TEST | `apply_remote_ops_detects_fork_with_same_seq_different_hash` queries hash but not full `OpRecord` (payload, op_type) — won't catch row mutation outside the hash field | S | — |
| TEST-13 | TEST | Draft tests use `record.payload.contains(BLOCK_A)` on raw JSON — a substring match that could pass with the ID in the wrong field | S | — |
| TEST-14 | TEST | Spaces tests don't verify isolation between Personal/Work spaces — no test creates pages in both and asserts queries return correct subset for each | S | — |
| TEST-15 | TEST | `propagate_multi_level` (tag inheritance) doesn't cover transitive case where intermediate node (CHILD) is deleted but tag still propagates from PAGE to GRANDCHILD | S | — |
| TEST-16 | TEST | Recurrence integration tests don't exercise year-boundary transitions (Dec 31 + 1 day → Jan 1 next year) — only unit tests cover DST/leap year | S | — |
| TEST-17 | TEST | `opbatch_streaming_sends_in_chunks` verifies chunk sizes (1000/1000/500) but not seq-ordering within each batch | S | — |
| TEST-18 | TEST | Backlink non-grouped tests use `setup_backlinks()` orphan sources (no parent_id), so they never exercise self-reference filtering; sort tests don't assert `total_count`/`filtered_count` | S | — |
| TEST-19 | TEST | MCP weak-shape assertions: `list_backlinks_happy_path` checks only `is_object()`; stress test bare `is_ok()` (line 1272); error-response tests check `result.is_none()` but not error code/message shape | S | — |
| TEST-20 | TEST | `protocol_initiator_requests_and_receives_files` asserts `files_sent/received` and `bytes_sent/received` but not `skipped_hash_mismatch` / `skipped_not_found` (== 0 in happy path) | S | — |
| TEST-21 | TEST | `protocol_hash_mismatch_no_ack_returns_err` only asserts `is_err()` — a connection-drop error would also pass; assert error message mentions hash mismatch | S | — |
| TEST-22 | TEST | `dispatch_op_unknown_op_type` asserts `is_ok()` but doesn't verify no DB side effects (row counts unchanged on `blocks` and `op_log`) | S | — |
| TEST-23 | TEST | 6 copy-pasted `*_paginates_with_cursor` tests in `pagination/tests.rs` (lines 720, 877, 1550, 1702, 1911, 2032) — identical 3-page-loop pattern | S | — |
| TEST-24 | TEST | 13 `tokio::time::sleep(Duration::from_millis(2))` for op-log timestamp separation in `undo_redo_tests.rs` — replace with deterministic `op_log::append_local_op_at` calls | S | — |
| TEST-25 | TEST | ~12 near-identical FEAT-3p4 space-scoping tests in `agenda_cmd_tests.rs` (lines 2268–2812) — extract `seed_two_spaces` helper | S | — |
| TEST-26 | TEST | `find_lca_after_compaction_returns_clear_error` hardcodes `'SNAP01'` / `'fakehash'` snapshot values inline — extract to module constants | S | — |
| TEST-27 | TEST | `count_set_property_ops_for_key` helper uses `LIKE '%"key":"X"%'` on JSON payloads — fragile to JSON whitespace changes | S | — |
| TEST-28 | TEST | `test_connection_pair()` bypasses real TLS (in-memory duplex with `peer_cert_hash_val: None`) — needs documenting so callers don't think they're testing mTLS | S | — |
| TEST-29 | TEST | `create_50_blocks_paginate_through_all_verify_count` creates 50 blocks sequentially in a loop — could parallelize with `futures::join_all` | S | — |
| TEST-30 | TEST | `now_rfc3339()` collision risk in `undo_redo_tests.rs` lines 1187, 1311, 1525 — siblings have sleep guards but these don't | S | — |
| TEST-31 | TEST | MCP pagination roundtrip test asserts `!ids1.contains(id)` for no overlap but never sums lengths across pages to verify nothing is lost | S | — |
| TEST-FE-1 | TEST | Bare `setTimeout` waits in tests (24 occurrences across 13 files; the dangerous subset is bare 50ms waits before `not.toHaveBeenCalledWith` negatives — `BlockTree.test.tsx`, `TagFilterPanel.test.tsx`, `useBlockTreeEventListeners.test.ts`, `GraphView.test.tsx`) — AGENTS.md explicitly forbids `await sleep(n)`; replace with `waitFor` or fake timers | M | — |
| TEST-FE-2 | TEST | Weak `toHaveBeenCalled()` assertions without arg matchers in hot files: `BlockContextMenu` (19), `FormattingToolbar` (16), `useBlockKeyboardHandlers` (10), `GraphView` (8), `BlockPropertyEditor` (7), `HeadingLevelSelector` (7), `useUndoShortcuts` (6), `UnlinkedReferences` (5) — wrong-block / wrong-arg regressions could pass silently | M | — |
| TEST-FE-3 | TEST | `makeHistoryEntry` helper duplicated across `HistoryPanel.test.tsx` and `HistoryView.test.tsx` — move to `src/__tests__/fixtures/index.ts` | S | — |
| TEST-FE-4 | TEST | `ViewDispatcher.test.tsx` Suspense-fallback test calls `vi.resetModules()` + `vi.doMock()` then unmocks at end of bare test body — assertion failure mid-test would leak module mocks to subsequent tests in the same worker | S | — |
| TEST-FE-5 | TEST | `useBatchCounts` test fixture sets `displayDate === dateStr`, so a regression that keys `agendaCounts` by `displayDate` instead of `dateStr` would silently pass | S | — |
| TEST-FE-6 | TEST | Local positional `makeBlock(id, content, ...)` helpers in `PageOutline`, `PageMetadataBar`, `PageEditor`, `TrashView` test files duplicate the shared `Partial<T>`-override factory — converge | S | — |
| TEST-FE-7 | TEST | `AgendaResults.test.tsx` hardcodes `'2020-01-01'` as overdue marker (lines 320, 332) when file already imports `subDays` and uses dynamic `new Date()` for "today" | S | — |
| TEST-FE-8 | TEST | `PairingDialog.test.tsx` uses `document.querySelector('.pairing-error')` for portal content (lines 314-318, 542-546, 850-854) — couples test to CSS class name; accessible queries preferred | S | — |

### Quick wins (S-cost, ready to grab)

These can be tackled in a single session with low risk — listed for prioritization convenience (canonical entries remain in the per-section detail blocks below):

- **MAINT-169** — gcal connector: persist `DateFailure::Skipped` reason to `gcal_space_config.last_error`
- **MAINT-170** — backlink `eval_unlinked_references`: capture `total_count` before user filters
- **MAINT-171** — extract `set_recurrence_property` helper to dedupe 8 call sites in `apply_recurrence_advance`
- **PERF-19** — backlink pagination keyset for non-Created sorts (2 sites)
- **PERF-20** — concurrency cap on `try_join_all` in backlink filter resolver
- **PERF-23** — stream-send for `read_attachment_file` (receive side already streams)
- **PERF-24** — batch `reindex_block_tag_refs` via `json_each` (mirror `block_links.rs`)
- **PERF-25** — `models::get_settings_batch` + single `SELECT … WHERE key IN (...)`
- **PERF-26** — `OnceLock<reqwest::Client>` in `link_metadata`
- **PERF-27** — push `PropertyText` operator into SQL `WHERE`
- **MAINT-114** — workflow consolidation audit (spike-then-commit)
- **PUB-5** — Tauri updater wiring (user-only: keypair + 2 secrets + uncomment)
- **PUB-8** — Android release keystore + 4 GH Actions secrets (CI wiring already shipped)

> **`PUB-*` statuses are heterogeneous now that the publish target is concrete (`github.com/jfolcini/agaric`).**
> PUB-5 / PUB-8 are ACTIONABLE; PUB-2 / PUB-3 remain DEFERRED on the identity / employer-IP decisions. macOS + Windows code signing are explicitly out of scope: the maintainer opted out of paid Apple Developer Program enrollment ($99/year) and Windows OV/EV certs ($200–400/year) for this OSS project. Bundles ship unsigned with Gatekeeper / SmartScreen first-launch warnings; see `BUILD.md` → "Desktop code signing in CI" for the user-facing install instructions.

---

## FEAT — Planned Feature Improvements

### FEAT-3p9 — Spaces Phase 9: per-space external integrations (GCal, OS notifications)

**Problem:** Two integration surfaces leak across spaces today:

1. **Google Calendar push** uses a single `calendar_id` in `GcalStatus` (`src-tauri/src/commands/gcal.rs:56-66`). The push pipeline (`gcal_push/connector.rs`) pulls agenda items via `list_projected_agenda_inner` (space-aware after FEAT-3p4, but the connector still passes `None` so every space's agenda lands in one calendar) and writes every item from every space into one calendar. A user with the integration on cannot keep their work calendar separate from their personal one.
2. **OS notifications** (FEAT-11, deferred): when adopted, due-task notifications will show task content with no space attribution. A Work task firing while the user is "in" Personal breaks context.

**Locked-in policy:**

- **GCal config is per-space.** A user can connect GCal independently for each space, with independent calendar IDs, OAuth tokens (via the existing keychain wrapper, key suffixed with the space ULID), window-days, privacy-mode, push-lease. A space with no GCal connection has no GCal sync — period. **No global fallback.**
- **Push pipeline branches by space.** Each space's push loop pulls agenda items scoped to that space (via FEAT-3p4's space-aware `list_projected_agenda`) and writes to that space's calendar. A failed push for one space does not block others.
- **OS notifications carry the space name.** Title format becomes `[<SpaceName>] <existing title text>` so the user always knows which context fired the notification, regardless of the active space at the moment.

**Backend scope (GCal) — foundation in place:**

- `gcal_space_config` table (`space_id PRIMARY KEY, account_email, calendar_id, window_days, privacy_mode, last_push_at, last_error, push_lease_device_id, push_lease_expires_at, created_at, updated_at`) — additive migration `0041_gcal_space_config.sql`.
- Per-space keychain account name `oauth_tokens_<SPACE_ULID>` via `keyring_account_for_space()` + `KeyringTokenStore::new_for_space()` (legacy `KEYRING_ACCOUNT = "oauth_tokens"` preserved alongside).
- Per-space CRUD helpers in `gcal_push::models`: `get_space_config / upsert_space_config / delete_space_config / list_space_configs / default_space_config`.
- One-shot legacy → Personal migration `gcal_push::migration::migrate_legacy_gcal_to_personal_space()` wired into `lib.rs` setup after the spaces bootstrap and before the connector spawn. Idempotent via the `gcal_per_space_migrated` flag in `gcal_settings`. Migrates both the DB row (legacy `gcal_settings` → `gcal_space_config[SPACE_PERSONAL_ULID]`) and the keychain entry (`oauth_tokens` → `oauth_tokens_<SPACE_PERSONAL_ULID>`). Keychain-unavailable is non-fatal — DB row migrated, flag NOT set, next boot retries.

**Backend scope (GCal) — remaining:**

- Thread `space_id` through `gcal_push::oauth` (notably `persist_oauth_account_email`), `gcal_push::lease` (`claim_lease / release_lease / read_current_lease`), `gcal_push::connector` (`GcalSettingsSnapshot::read`, `run_cycle`, `push_date`), and `gcal_push::dirty_producer` if needed. The push lease lives on `gcal_space_config` columns (no separate `gcal_space_lease` table — leases do not outlive config rows).
- Replace `GcalStatus` (single struct) with `Vec<GcalSpaceStatus>`: `(space_id, account_email, calendar_id, window_days, privacy_mode, push_lease, last_push_at, last_error, connected)`. Top-level `get_gcal_status` returns the vec keyed by space.
- `gcal_push::connector::push_loop` iterates configured spaces and runs an isolated push per space; a failure on one space does not block the others.
- Per-space versions of every existing command: `force_gcal_resync(space_id)`, `disconnect_gcal(space_id)`, `connect_gcal(space_id)`, `set_gcal_window_days(space_id, days)`, `set_gcal_privacy_mode(space_id, mode)`. The `gcal_settings` legacy KV table can be dropped once all callers move to `gcal_space_config` (separate housekeeping migration after the cutover).
- Settings tab UI gains a per-space accordion (`GoogleCalendarSettingsTab.tsx`).

**Backend scope (notifications, when FEAT-11 lands):**

- Notification builder reads the firing task's owning page's `space` property and prefixes the title with `[<SpaceName>] `. No new schema. Lookup is one `block_properties` read per notification, fine at notification frequency. Couples with FEAT-11 — this sub-task ships alongside or after FEAT-11.

**Migration (in place):**

- The legacy single-space GCal config migrates to the deterministic `SPACE_PERSONAL_ULID` row on first run after this phase ships, via `gcal_push::migration::migrate_legacy_gcal_to_personal_space()`. Idempotent and partial-failure-resumable behind the `gcal_per_space_migrated` flag in `gcal_settings`. Users can later move their GCal config to a different space when M2's per-space connect/disconnect commands ship.

**Testing:**

- Two configured spaces push to two different `calendar_id`s; per-space `last_push_at` advances independently.
- Disconnect on space A leaves space B's push working.
- Failed push on space A does not block the per-loop tick for space B.
- Notification title always carries the originating space, regardless of active space.

**Cost:** M — foundation (schema + models + keychain + legacy migration + boot wiring) is in place. Remaining work is the connector / commands / lease signature-thread + per-space iteration + Settings accordion UI; the notification-prefix sub-task is still blocked on FEAT-11 landing first.
**Status:** Foundation in place; remaining work as described under "Backend scope (GCal) — remaining" above. Independent of FEAT-3p4 (which already shipped). Notification-prefix sub-task remains blocked on FEAT-11.

### FEAT-5g — GCal: Android OAuth + background connector (DEFERRED — design sketch only)

Part of the FEAT-5 family. **Not scheduled.** Blocked on explicit design-review approval before any code lands.

**Why this is filed and not done:**

- `tauri-plugin-oauth` on Android needs investigation — its current implementation targets loopback HTTP listeners, which Android sandboxes.
- `keyring` has no Android support; token storage would need to switch to Android Keystore via a JNI bridge or a Tauri-side secure-storage plugin.
- The `gcal_push::connector` task lifecycle on Android needs to survive Doze / battery-saver — either WorkManager periodic task (≥15 min min interval, may miss pushes) or an Android foreground service with a persistent notification (always-on, user-visible).
- Rate limits + offline durability on mobile are different shapes than desktop — though the daily-digest model makes this easier (at most ~30 ops per full resync, well under quota).

**Design questions to resolve before scheduling:**

- Loopback OAuth vs. Custom Tabs + PKCE + App Link callback — which does `tauri-plugin-oauth` support on Android today?
- Keystore-backed token store — existing Tauri secure-storage plugin, or custom JNI?
- Connector scheduling — foreground service (user-visible, always-on) or WorkManager periodic (may skip pushes under Doze)? For the daily-digest model, WorkManager's ≥15 min cadence is actually acceptable and matches the desktop reconcile interval — event-driven updates are a bonus, not a requirement.
- Re-auth UX when the user clears app data — acceptable, or do we need to export-and-reimport tokens?

**Cost:** L — 2–3 sessions minimum after design approval.

**Status:** DEFERRED. Do NOT start without an explicit design-review session that resolves the four questions above.

### FEAT-11 — Adopt `tauri-plugin-notification` (OS notifications for due tasks / scheduled events)

**Problem:** The app has agenda + due dates + scheduled dates + repeat properties + projected agenda + the Google Calendar push connector (FEAT-5), but zero OS-level notification path. A user with "buy groceries — DUE 09:00" cannot be notified by the OS unless the GCal push has already fired and their calendar app shows it. Org-mode / Logseq users expect "10 minutes before scheduled" and "due now" to surface as native notifications.

**Fix:** Adopt `@tauri-apps/plugin-notification` + `tauri-plugin-notification`. New backend module `src-tauri/src/notifier/mod.rs` schedules notifications based on `due_date` + `scheduled_date` + property events from the materializer (analogous to `gcal_push::DirtyEvent`). Reuses the existing `agenda_view` queries to find blocks within the next-24h window on boot and on every materialize commit. Frontend: a Settings tab toggle + per-property filter. Mobile permissions: request `POST_NOTIFICATIONS` on Android 13+ via the plugin's permission API. Coupled stack — bump with the rest of the Tauri plugins.

**Cost:** L — design (which events fire? how to dedupe? snooze semantics?), backend scheduler (~6 files), one Settings sub-tab, mobile permission flow, ~25 tests.
**Risk:** M — wrong-time notifications and notification spam are both real failure modes; needs careful dedupe and "do not re-fire on materialize replay" guard.
**Impact:** L — closes a recognised feature gap with Org-mode / Logseq parity; especially valuable on mobile where the user is unlikely to have the app foregrounded when a task is due.

## MAINT — Maintenance / cleanup

### MAINT-111 — Migrate MCP server JSON-RPC framing onto `rmcp` (official Rust MCP SDK)

**Status:** verdict **GO (modest scope)**. Reference implementation lives in `src-tauri/src/mcp/rmcp_spike.rs` (gated behind the off-by-default `mcp_rmcp_spike` Cargo feature) with 3 passing tests proving the integration points survive. Detailed assessment in `src-tauri/src/mcp/rmcp_spike.md`. Spike numbers (`rmcp 1.6`, default vs `mcp_rmcp_spike` build): +6 transitive crates, +1s cold compile, +32 bytes on the `agaric-mcp` stripped binary, +0 default-build warnings. All four spike questions returned **Pass**: ~250 LOC of pure framing/dispatch in `server.rs` collapses; `ToolRegistry` trait stays; activity-feed + `ActorContext` + `LAST_APPEND` integration points preserved (verified with tests); `rmcp` gives us protocol-version negotiation + `tools/listChanged` + cancel/progress + `_meta` + `ping` + `structuredContent` "for free".

**Migration plan (3 milestones, 12-14h end-to-end):**

1. **Milestone 1 (S, ~4h):** route `tools/list` through `rmcp` — replace the spike's single-tool filter with a full `RmcpReadOnlyAdapter` mapping every `ToolDescription` → `Tool`. No behaviour change at the wire level.
2. **Milestone 2 (M, ~6h):** route `tools/call` through `rmcp` — override `ServerHandler::call_tool` with the spike's pattern (`ACTOR.scope`, `LAST_APPEND.scope`, `emit_tool_completion` per call); add `AppError → ErrorData` translation. Remove the hand-rolled `dispatch` / `handle_tools_call` body once the new path passes every `mcp/server/tests.rs` / `tools_ro/tests.rs` / `tools_rw/tests.rs` byte-equivalent assertion.
3. **Milestone 3 (S, ~3h):** drop hand-rolled framing — delete `parse_request` / `make_success` / `make_error` / `handle_initialize` / `handle_notification` / `dispatch` / `truncate_params_preview` / JSON-RPC error code constants; replace the `handle_connection` body with `adapter.serve(stream)`. Delete the `mcp_rmcp_spike` Cargo feature once the migration is the default path.

**Functions that stay agaric-specific** (rmcp has nothing to say about them): `serve_unix` / `serve_pipe` / `serve` (180 LOC — Unix socket / Windows pipe + M-83 successor management + H-2 lifecycle gate), `run_connection` (61 LOC — L-113 grace period + RAII counter guard), `app_error_to_jsonrpc` (8 LOC — application-level error mapping).

**Risk-mitigation suggestion** (from the spike): a behind-flag shadow-mode (run both adapters in parallel, compare responses) during milestone 2 so any wire-format drift surfaces in CI before the hand-rolled path is removed.

**Cost:** L (12-14h end-to-end across 3 milestones).
**Risk:** Medium — wire format is identical (rmcp targets the same MCP spec we hand-roll) but every existing `mcp/server/tests.rs` / `tools_ro/tests.rs` / `tools_rw/tests.rs` test must still pass byte-equivalent.
**Impact:** Medium — reduces framing boilerplate (~250 LOC), tracks the MCP spec upstream rather than reimplementing it, and unlocks several spec features we currently stub (protocol-version negotiation, listChanged, cancel/progress, _meta, ping, structuredContent).

### MAINT-113 — `ConflictFreeBlockId` newtype to lift invariant #9 into the type system

**What:** AGENTS.md "Key Architectural Invariants" #9 reads:

> Recursive CTEs over `blocks` must filter `is_conflict = 0` in the recursive member, and bound `depth < 100` to prevent runaway recursion on corrupted data. Conflict copies leak into results otherwise.

This invariant is currently enforced by code review + grep + one-line comments. It is baked into **275 `is_conflict = 0` SQL occurrences across 52 source files** (plus 3 more in `0021_block_tag_inherited.sql`) — count refreshed 2026-05-02 from the original 220/70. The file count *dropped* (consolidation is working) while the per-file occurrence rose (more queries touch `blocks` than before). Every new query touching `blocks` must remember to add it.

**Alternative design:** Split the `BlockId` primitive into two types:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct BlockId(String);        // raw — may refer to a conflict copy or deleted block

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ActiveBlockId(String);  // materialised AND is_conflict = 0 AND deleted_at IS NULL
```

Query helpers that return "active" blocks (`list_children`, `get_descendants`, `list_page_links`, every recursive CTE wrapped behind a Rust fn) return `Vec<ActiveBlockId>`. Query helpers that accept only active input take `&ActiveBlockId`. Conversion `BlockId → ActiveBlockId` goes through a single checked gate (`verify_active(&BlockId) -> Result<ActiveBlockId>`) that runs the `is_conflict = 0 AND deleted_at IS NULL` predicate exactly once. Recursive CTEs hidden behind these helpers keep their `AND is_conflict = 0` in SQL — the newtype just prevents callers from accidentally feeding a raw `BlockId` into a path that assumes active.

**Context (background — why this sat as a design note before now):**

- The invariant is already documented (AGENTS.md #9), already tested (the `block_tag_inherited` materialised cache has an oracle CTE that verifies the filter is honoured), and already flagged by review.
- No shipped HIGH/CRITICAL bug traces back to a missed filter in the last ~50 sessions. The tension is correctness-by-convention vs. correctness-by-types — the convention is working, but it does not scale to forever and the cognitive tax compounds with every new query.
- Scope is genuinely large — 275 SQL sites are the *floor* (each one lives in a function with a Rust signature); the real work is touching **every** producer/consumer of `BlockId` and deciding whether it returns raw or active. Honest estimate: 52 files, hundreds of function signature changes, a `specta`-bindings ripple to the frontend (extra TS type), and a round of test fixture updates.
- The serde wire format must stay `String` (both directions) so sync + IPC aren't affected — handled with `#[serde(transparent)]`.

**Cost:** L (8h+ at minimum; realistically 2–4 sessions split across the milestones below).
**Risk:** M — pervasive API change. Sync / MCP / specta bindings must round-trip identically. Mixing raw and active block IDs in a single data structure (e.g., `BlockTreeNode` with both active children and "recently-deleted" preview siblings) needs explicit policy (decided at the M2 boundary; see below).
**Impact:** M — eliminates an entire class of "forgot to filter conflicts" bugs at compile time. Invariant #9 in AGENTS.md can then reference the type instead of a prose rule, and code review stops spending cycles on this single class of finding.

**Milestone plan (3 milestones, ~10–12h end-to-end):**

1. **M1 (S–M, ~3–4h)** — Introduce `ActiveBlockId` newtype + `verify_active(&BlockId) -> Result<ActiveBlockId>` gate (single SQL predicate `is_conflict = 0 AND deleted_at IS NULL`). Convert ~5 high-traffic helpers — `list_children`, `get_descendants`, `list_page_links`, agenda projection, FTS resolve — plus their direct callers. Recursive CTEs hidden behind these helpers keep their `AND is_conflict = 0` in SQL; the newtype prevents callers from accidentally feeding raw IDs into a path that assumes active. No wire-format change (`#[serde(transparent)]`). Behaviour change: nil. Tests: existing suite must keep passing; add a small unit test that `verify_active` rejects a known conflict-copy ULID.
2. **M2 (M, ~4–6h)** — Convert backlink + tag-inheritance + property-resolution paths. This is the largest module-cluster by SQL site count. **Decide the `BlockTreeNode` mixing policy at the start of M2** before writing any code — pick one of: (a) split the struct into `ActiveBlockTreeNode` / `RawBlockTreeNode` (clean, more types); (b) keep mixed, type the children vector but leave the node's own `id` raw with a runtime gate at the few access points that care (less type churn, slightly less safety). Document the choice in the M2 commit message.
3. **M3 (S–M, ~3–4h)** — Convert cascade/move/delete paths + materializer handlers. Remove the last raw-`BlockId` SQL sites that should have been `ActiveBlockId`. Update AGENTS.md invariant #9 to reference the newtype instead of the prose rule. Remove this row from REVIEW-LATER.

**Per-milestone exit criteria:**

- All `cargo nextest run` + `npx vitest run` pass; existing E2E specs pass.
- No new `unsafe_code` or `biome-ignore`.
- `specta` bindings regenerated; `ts_bindings_up_to_date` test passes.
- Number of `is_conflict = 0` SQL sites strictly decreases at each milestone (sites that get hidden behind `ActiveBlockId`-returning helpers no longer count) — track in the commit message.

**Decision:** **Scheduled** — owner-prioritized, planned across the 3 milestones above. Each milestone is one focused session and one focused commit; revert granularity is per-milestone. Land M1 first as a thin slice to validate the newtype shape against `specta` + sync round-trip before committing to M2's scope.

### MAINT-114 — Consolidation audit of `.github/workflows/`

**What:** Four workflow files today:

| File | Trigger | Jobs |
|---|---|---|
| `.github/workflows/_validate.yml` (135 LOC) | `workflow_call` | prek-equivalent (lint + fmt + clippy + nextest + vitest + playwright + sqlx offline check + MCP smoke) |
| `.github/workflows/ci.yml` (288 LOC) | push (non-tag) + PR | calls `_validate.yml` → desktop build matrix (ubuntu / windows / macos) + android aarch64/x86_64 build |
| `.github/workflows/release.yml` (~450 LOC) | push `v*` tag | calls `_validate.yml` → verify-version → desktop build matrix + sign + android APK + draft GitHub Release |
| `.github/workflows/release-tag.yml` (78 LOC) | `workflow_dispatch` only (`-f version=…`) | runs `scripts/bump-version.sh --commit --tag --push`; the tag push then re-triggers `release.yml` |

The initial one-line recommendation was "4 → 2 (validate + release)". On inspection that is too aggressive. `ci.yml` and `release.yml` have genuinely different reasons to exist (per-push non-tag build vs. per-tag signed-release pipeline), and `release-tag.yml` is a thin entry-point wrapper around `bump-version.sh` that exists so the maintainer does not have to type the bump + tag + push dance manually.

**Realistic consolidation wins (ranked by ROI):**

1. **Fold `release-tag.yml` into `release.yml` as a `workflow_dispatch` job** — 4 → 3. The bump-version step would sit above the build matrix, gated by `if: github.event_name == 'workflow_dispatch'`; the build matrix remains tag-triggered. Saves one file, removes the "tag push re-triggers a different workflow" indirection. Mild downside: `release.yml` grows by 78 LOC, and a dispatched version bump run that fails before the tag push no longer leaves a small, focused log (failure appears inside the big Release file). Probably worth it, but not huge.
2. **Keep `_validate.yml` as reusable** — already optimal. Called by both ci.yml and release.yml, avoids duplicating 135 LOC of setup. Leave alone.
3. **Do NOT merge `ci.yml` into `release.yml`** — the build matrix would have to be double-gated (`if: github.event_name == 'push' && !startsWith(github.ref, 'refs/tags/')` etc.), artifact upload names would conflict between "per-push smoke bundle" and "signed release bundle", and the signed-release path needs secrets that per-push builds must not have access to. The current split is a principled least-privilege boundary; collapsing it would require narrower secret scoping per step, which is more complex than the current file split.

**Proposed outcome:** Attempt 4 → 3. Only commit if the merged `release.yml` is not longer than `ci.yml` + `release.yml` + `release-tag.yml` combined, AND the `workflow_dispatch` path is at least as discoverable in the GitHub Actions UI as the standalone "Release Tag" entry. Otherwise abandon — a tidy file split is worth more than a tidy file count.

**Cost:** S–M (spike ~2h; full migration including docs-drift checks ~4h).
**Risk:** Low-to-medium — release pipeline is load-bearing. Test the merged workflow by dispatching against a throwaway tag (`0.0.0-test-consolidation`) on a fork or a draft release.
**Impact:** S — one fewer file to navigate, slight simplification of the "how do I cut a release?" mental model. Not pressure relief.

### MAINT-128 — God-component decomposition: `PropertyRowEditor.tsx`

**What:** `PropertyRowEditor.tsx` is 550L and carries an explicit `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` at L85. The file dispatches on `def.value_type` (text/number/date/ref/select → 5 parallel JSX subtrees) but the 5 typed editors share `localValue`, date hook state, select-options state (3 fields), ref-picker state (4 fields), and 10+ callbacks — splitting naïvely re-creates the prop-chain problem that the `biome-ignore` acknowledges.

**Refactor path (locked in):** Split each typed editor into its own component AND lift the shared state UP into a containing hook. The hook owns local edit state, debounced save, and calls down into the per-type editor through a thin contract. The alternative — accepting the existing `biome-ignore` permanently with a rationale comment — was considered and rejected.

**Cost:** L.
**Risk:** Medium — has a test suite; run between each commit.
**Impact:** M — removes the only `biome-ignore` for cognitive complexity and clarifies the typed-editor surface.

**Decision:** **Scheduled** — owner-prioritized; refactor path locked in. Milestone breakdown to be drafted at the start of the implementation session; expected shape is ~3 milestones (M1 extract per-type editor components with the current shared-state shape preserved through props; M2 introduce the containing hook, lift state, switch to the thin contract; M3 remove the `biome-ignore` + test sweep).

### MAINT-168 — Sync trigger / scheduler dual-backoff unification

**What:** The repository has two independent exponential-backoff schedulers driving sync:

- **Frontend** — `src/hooks/useSyncTrigger.ts` (lines 21-23): `BASE_INTERVAL_MS = 60_000`, `MAX_INTERVAL_MS = 600_000`, doubles on failure. Fires `startSync()` for each peer on a 60s → 600s cadence.
- **Backend** — `src-tauri/src/sync_scheduler.rs`: per-peer `MIN_BACKOFF = 1s` → `MAX_BACKOFF = 60s`, doubles on failure, with per-peer mutex + jitter, silently rejects redundant invocations.

**Today's behaviour (intentional):** the backend is the authoritative scheduler. The frontend is a coarse "wake the scheduler" hint at a slower cadence. When the backend is mid-backoff, calling `startSync()` from the frontend is a no-op on the wire — it resolves quickly. The user briefly sees a "syncing" indicator that resolves without any wire activity. This is functionally correct and safe; it is a minor UX awkwardness and conceptual duplication, nothing more. Documented inline in `useSyncTrigger.ts` (the comment block above the constants references this item).

**Why this is filed and not done:**

- No shipped bug. No correctness issue. No user-facing report.
- Identified during the 2026-05-02 bird's-eye architectural review. Explicitly classed as "improvement, not bug."
- Two reasonable end-states:
  - **(a) Demote the frontend to a pure wake-hint** — drop the frontend backoff entirely; rely on a backend status event (`SyncStatusEvent::Backoff { peer_id, until }`) to mute the UI indicator while the backend is in backoff. Removes the duplicate scheduler.
  - **(b) Have the frontend query backend backoff state** before firing — adds a `get_sync_backoff_state(peer_id)` IPC and gates `startSync()` on it. Keeps two schedulers but coordinates them.
- (a) is cleaner; (b) is smaller. Either way, the design needs one round of thought before implementation.

**Cost:** M (4-6h once the design is picked).
**Risk:** Low (no correctness regressions possible; worst case the indicator behaves slightly differently).
**Impact:** Low (UX polish + reduced conceptual surface).

**Decision:** Defer — keep tracked as a documented design note. Revisit only if (i) the dual-scheduler behaviour ever surfaces as a user-facing bug, or (ii) the sync layer is being touched for another reason and unification becomes opportunistic.

### MAINT-169 — GCal connector: per-date `DateFailure::Skipped` errors are not persisted to `gcal_space_config.last_error`

**Problem:** `src-tauri/src/gcal_push/connector.rs:484-491` handles `DateFailure::Skipped(reason)` by emitting a `tracing::warn!` and `continue`-ing to the next date. Cycle-level failures (`CalendarGone`, `Unauthorized`, `Forbidden`) update state and emit events; transient per-date failures do not touch the database at all.

**Why it matters:** The Settings UI reads `gcal_space_config.last_error` to surface push status. A user whose push silently skips dates sees `last_error = NULL` even while the tracing log is full of warnings. Diagnostic feedback is the only signal that something is wrong before the daily reconcile clears the dirty set.

**Fix:** On `DateFailure::Skipped(reason)`, write the reason to `gcal_space_config.last_error` (via `models::upsert_space_config_last_error` or by extending the existing setter) before `continue`-ing. The reason string is already constructed.

**Cost:** S — one new helper or extend the existing one, plus one call site.
**Risk:** Low.
**Impact:** Medium — closes the diagnostic gap for transient failures.

### MAINT-170 — Backlink: `eval_unlinked_references` collapses `total_count = filtered_count`

**Problem:** `src-tauri/src/backlink/grouped.rs:525-526` sets both counts to the same post-filter value:
```rust
let filtered_count = page_groups.values().map(|(_, blocks)| blocks.len()).sum();
let total_count = filtered_count;
```
`eval_backlink_query_grouped` (line 128 in the same file) sets `total_count = base_ids.len()` *before* user filters. The two functions therefore report counts on different bases. The comment at L523-524 cites AGENTS.md "Backend Patterns #4" but that rule applies to fixed semantic filters (self-reference exclusion), not user-supplied filter expressions.

**Why it matters:** UI badge under-reports the unlinked-reference count when the user has any backlink filter active.

**Fix:** Capture `total_count` after self-reference exclusion (the grouping step) but *before* applying user `filters`. Mirror the structure of `eval_backlink_query_grouped`. Add a regression test that asserts `total_count >= filtered_count` and that both equal the unfiltered group sum when no filters are supplied.

**Cost:** S.
**Risk:** Low — pure read-side count semantics.
**Impact:** Low-medium — UX correctness for unlinked-references badge.

### MAINT-171 — Recurrence: 8 duplicated `set_property_in_tx` call sites in `apply_recurrence_advance`

**Problem:** `src-tauri/src/recurrence/compute.rs:239, 253, 282, 307, 324, 382, 396, 412` each call `set_property_in_tx(tx, device_id, block_id, key, value).await?` and then push the resulting `OpRecord` onto `ops`. The pattern is identical except for the key and value pair. Forgetting to push the op record (or capturing the wrong one) is a real copy-paste failure mode.

**Fix:** Extract `async fn set_recurrence_property(tx, device_id, block_id, key, value, ops: &mut Vec<OpRecord>) -> Result<()>` and reduce the 8 sites to 8 one-liners.

**Cost:** S — pure refactor; existing tests cover the behavior.
**Risk:** Low.
**Impact:** Low.

### MAINT-172 — Pagination/queries: space-filter SQL fragment inlined across 13+ files

**Problem:** The fragment
```sql
(?N IS NULL OR COALESCE(b.page_id, b.id) IN
    (SELECT bp.block_id FROM block_properties bp
     WHERE bp.key = 'space' AND bp.value_ref = ?N))
```
is duplicated across `pagination/{hierarchy,tags,links,undated,agenda,trash,properties}.rs`, `backlink/{query,grouped}.rs`, `fts/search.rs`, `tag_query/query.rs`, and `commands/{pages,agenda}.rs`. The `space_filter_clause!` macro is referenced in inline comments but unusable because `sqlx::query_as!` requires a string literal and rejects `concat!()`. Comments at the call sites instruct future maintainers to "mirror any change" — convention enforcement, not single-source-of-truth.

**Why it matters:** Real maintenance hotspot. Any change to the filter semantics requires N coordinated edits. A subtle bug (one site forgets the `COALESCE`) would only be caught by per-site tests.

**Fix (design space):**
1. **build.rs text substitution** — generate per-query SQL strings into `OUT_DIR` from a single canonical fragment, keep `query_as!` consuming the generated literal.
2. **prek hook** — fail commit if the canonical fragment text drifts across the 13 sites. Cheap; does not consolidate the source.
3. **Migrate the queries off `query_as!` to runtime sqlx** — loses compile-time validation; not preferred.

**Cost:** M — design + implementation + verifying the 13 sites still produce identical query plans.
**Risk:** Medium — touching every list query is high blast-radius; needs careful test coverage.
**Decision:** Defer until the cost of drift becomes visible (a real bug shipped because one site got out of sync). Until then, the comment-based "mirror any change" convention is acceptable.

## TEST — Backend test improvements

Items in this section are test-quality improvements identified during a thorough backend test review (10 parallel review subagents covering ~80K LOC of test code, 3 verification subagents to filter hallucinations). All items below are verified — known false positives are not listed.

> **Format:** test items use the compact L-style block. None of these are blocking; they are code-quality investments.

### TEST-1 — `delete_block_inner` calls `now_rfc3339()` twice (production timestamp-mismatch)
- **Domain:** Commands (Block lifecycle)
- **Location:** `src-tauri/src/commands/blocks/crud.rs` (`delete_block_inner`); workaround visible in `src-tauri/src/commands/tests/undo_redo_tests.rs:1843-1868`
- **What:** `delete_block_inner` calls `now_rfc3339()` separately for the `op_log` row and the `blocks.deleted_at` UPDATE. The two timestamps differ at sub-millisecond resolution but render as the same string most of the time, so the bug is silent. The `revert_delete_block_restores_with_descendants` test exposes it explicitly and works around it by manually constructing the op with a single hardcoded timestamp `"2025-06-15T12:00:00Z"`.
- **Why it matters:** Sub-ms timestamp drift between op_log and blocks rows can confuse history queries that reconstruct prior state by joining on `created_at`. Discovered during test code review; the fact that a test actively works around this is a strong signal.
- **Cost:** Trivial — compute `let now = now_rfc3339();` once at the top of `delete_block_inner` and reuse for both writes.
- **Risk:** Low.
- **Impact:** Low (silent in practice today, but a correctness latent).
- **Recommendation:** Fix `delete_block_inner` to compute `now` once; then simplify the test to call `delete_block_inner` directly instead of constructing the op manually.
- **Status:** Open.

### TEST-2 — Inequality count assertions where exact count is known (3 sites)
- **Domain:** Test infrastructure
- **Location:**
  - `src-tauri/src/integration_tests.rs:1177-1180` (`materializer_processes_background_tasks_after_page_create` — `assert!(bg >= 1, ...)`)
  - `src-tauri/src/commands/tests/agenda_cmd_tests.rs:865-869` (`entries.len() >= 3` for weekly projection across 28 days)
  - `src-tauri/src/recovery/tests.rs:687-695` (`report.draft_errors.len() >= 2`)
- **What:** Per AGENTS.md: "Prefer exact counts — use `assert_eq!(count, 5)` not `assert!(count >= 1)`. Inequality assertions hide subtle bugs."
- **Cost:** Trivial — compute exact expected value (the page-create test should expect exactly the dispatched task set; the agenda projection should compute `weeks_in_28_days(today)`; the recovery test knows the corrupted-fixture count).
- **Risk:** Low.
- **Impact:** Medium — closes silent-pass holes for materializer-task accounting and recovery-error counting.
- **Status:** Open.

### TEST-3 — Brittle `err.to_string().contains(...)` and `.contains(...)` on event messages
- **Domain:** Test infrastructure
- **Location:**
  - `src-tauri/src/commands/tests/block_cmd_tests.rs` lines 241-244, 336-338, 378-380, 405-407, 897-899, 1143-1145, 1209-1211, 1982-1984, 2006-2008, 2069-2071, 2198-2200 (11 sites)
  - `src-tauri/src/sync_daemon/tests.rs` lines 885, 979, 1063, 1231, 1563, 1622, 1691, 1820, 1902 (9 sites on `SyncEvent::Error.message`)
- **What:** Tests use `.contains("substring")` on error/event message strings instead of `matches!(AppError::Variant(_))` or pinned message equality. If the message text is refactored or i18n-localized, the test silently passes against a different error.
- **Cost:** S — mechanical replace per AGENTS.md convention.
- **Risk:** Low — if a substring check still adds value, keep it but combine with `matches!()` on the error variant (sync_daemon path requires keeping `.contains()` because the event carries an unstructured `message: String`; the block_cmd path can fully migrate to `matches!`).
- **Impact:** Medium — turns silent-pass regressions into hard failures.
- **Status:** Open.

### TEST-4 — Sync daemon tests use 18 fixed sleeps as race-prone "barriers"
- **Domain:** Sync / Test infrastructure
- **Location:** `src-tauri/src/sync_daemon/tests.rs` lines 2601, 2607, 2639, 2643, 2702, 2706, 2755, 2770, 2828, 2847, 2909, 3151, 3208, 3281, 3345, 3388, 3395, 3398
- **What:** Tests use `tokio::time::sleep(Duration::from_millis(50..800))` to wait for daemon state changes. Unlike the materializer (which exposes `flush_background()`, `wait_for_initial_block_count_cache()`, `wait_for_pending_block_count_refreshes()`), the sync daemon and `SyncScheduler` have no equivalent sync-barrier helper, so tests sleep and hope.
- **Why it matters:** Real flake risk on loaded CI. The 800ms sleeps in particular are pessimistic guesses that could still be too short under load.
- **Cost:** M — design + implement a `wait_for_state(scheduler, predicate)` polling helper or expose `Notify`-based barriers on `SyncDaemon`.
- **Risk:** Low — additive helper.
- **Impact:** Medium — eliminates a category of CI flakes.
- **Recommendation:** Pattern after the materializer's `flush_background()` API. A polling helper `async fn wait_for(predicate: impl Fn() -> bool, timeout: Duration)` would suffice for most sites.
- **Status:** Open.

### TEST-5 — `delete_block_cascades_to_children` doesn't verify op_log entries
- **Domain:** Test infrastructure (Commands tests)
- **Location:** `src-tauri/src/commands/tests/block_cmd_tests.rs:935-977`
- **What:** Test only checks the response struct (`descendants_affected`, `deleted_at`); never queries `op_log` to verify the `delete_block` op was appended with correct payload. Per AGENTS.md, every state-changing command should verify op-log entries.
- **Cost:** Trivial — add a `SELECT COUNT(*) … WHERE op_type = 'delete_block'` assertion mirroring the pattern in `create_block_writes_op_to_op_log` (line 193).
- **Risk:** Low.
- **Impact:** Low-medium — closes a silent gap on cascade-delete op accounting.
- **Status:** Open.

### TEST-6 — Sync merge tests assert on counter only, not materialized state
- **Domain:** Sync / Merge tests
- **Location:**
  - `src-tauri/src/sync_protocol/tests.rs:1115-1171` (`merge_resolves_property_conflict_lww`) — asserts `results.property_lww > 0` but never queries `block_properties` to confirm the LWW winning value is stored
  - `src-tauri/src/merge/tests.rs:1016-1113` (`merge_block_conflict_creates_copy`) — verifies `is_conflict=1` and `conflict_source` on the merge op but never queries `blocks` to confirm both rows (original + conflict copy) exist with correct content
- **What:** Tests verify the merge engine's counter outputs but stop short of confirming the database actually reflects the resolution. A regression that updates the counter but skips the DB write would pass.
- **Cost:** S — add `SELECT … FROM block_properties` / `SELECT … FROM blocks` assertions after each merge.
- **Risk:** Low.
- **Impact:** Medium — these tests are the only coverage for LWW + conflict-copy semantics.
- **Status:** Open.

### TEST-7 — Reverse tests don't verify batch ordering or op-log append-only invariant
- **Domain:** Reverse / Undo tests
- **Location:** `src-tauri/src/reverse/tests.rs` (entire 1541-line file)
- **What:** Per AGENTS.md "Undo/reverse testing": "Batch grouping: consecutive ops within 200ms by the same device are grouped — backend's `revert_ops` sorts newest-first (`created_at DESC, seq DESC`) before applying. Tests must verify this ordering." and "Reverse ops are appended to the op log (log remains append-only) — never assert that existing ops were mutated." Neither invariant is currently tested.
- **Cost:** S — add (a) a test that appends 3+ ops with identical timestamps and verifies they reverse newest-first; (b) a test that counts `op_log` rows before/after `compute_reverse` and asserts the original op is still present and the count increased by 1.
- **Risk:** Low.
- **Impact:** Medium — closes a gap on two AGENTS.md-mandated invariants.
- **Status:** Open.

### TEST-8 — TOFU test only covers acceptance, not rejection
- **Domain:** Sync (TLS / pairing)
- **Location:** `src-tauri/src/sync_daemon/tests.rs:1930-2049` (`inmem_handle_incoming_sync_tofu_stores_cert_hash`)
- **What:** Test verifies cert hash is stored on first connection, but never reconnects with a *different* cert hash to verify the mismatch is rejected. The negative path is the actual security-relevant behavior of TOFU.
- **Cost:** S — extend the test with a second connection attempt using a mismatched hash; assert connection is rejected.
- **Risk:** Low.
- **Impact:** Medium — TOFU behavior is asymmetric (acceptance is trivial; rejection is the property worth verifying).
- **Status:** Open.

### TEST-9 — `two_device_create_sync_both_see_block` doesn't verify materialization
- **Domain:** Sync integration tests
- **Location:** `src-tauri/src/sync_integration_tests.rs:145-202`
- **What:** Test verifies the synced op is readable in B via `get_op_by_seq()` but never queries the `blocks` table to verify materialization. If the materializer fails to apply the op on B, the test still passes.
- **Cost:** Trivial — `materializer.flush_background().await` then `SELECT FROM blocks WHERE id = ?` assertion.
- **Risk:** Low.
- **Impact:** Low-medium — closes a gap in the most fundamental sync test.
- **Status:** Open.

### TEST-10 — Snapshot tests missing redactions of non-deterministic fields
- **Domain:** Test infrastructure (insta snapshots)
- **Location:**
  - `src-tauri/src/pagination/tests.rs:3050-3075` (`snapshot_history_entry_response`) — `PageResponse` includes `next_cursor`; bare `insta::assert_yaml_snapshot!(resp)` will drift
  - `src-tauri/src/commands/tests/snapshot_tests.rs:55-81` (`snapshot_list_blocks_response`) — comment says "Redacts `id` fields" but the actual call has no redaction block
- **What:** Per AGENTS.md "Redaction patterns": cursors must be redacted with `[CURSOR]`, IDs with `[ULID]`, etc. Both sites violate this.
- **Cost:** Trivial — add the redaction block.
- **Risk:** Low.
- **Impact:** Low — prevents snapshot flakes (the second site is a latent flake).
- **Status:** Open.

### TEST-11 — Missing error-path test coverage (export_page_markdown + set_property_inner)
- **Domain:** Commands / integration tests
- **Location:**
  - `src-tauri/src/commands/tests/page_cmd_tests.rs:326-722` (6 happy-path tests for `export_page_markdown_inner`, 0 error tests)
  - `src-tauri/src/command_integration_tests/property_integration.rs` (covers nonexistent-block NotFound but not invalid-key / type-mismatch Validation)
- **What:** Per AGENTS.md, every command needs error coverage: nonexistent ID → NotFound, deleted block → NotFound, invalid input → Validation.
- **Cost:** S — add tests with nonexistent page IDs, deleted pages, and invalid property keys / type mismatches.
- **Risk:** Low.
- **Impact:** Medium — Validation paths are easy to break silently when refactoring.
- **Status:** Open.

### TEST-12 — Fork-detection test only checks hash, not full row
- **Domain:** Sync protocol tests
- **Location:** `src-tauri/src/sync_protocol/tests.rs:4109-4181` (`apply_remote_ops_detects_fork_with_same_seq_different_hash`)
- **What:** Test queries the local hash post-fork-detection but doesn't snapshot the full `OpRecord` (payload, op_type, parent_seqs, etc.) pre-detection and assert immutability. A regression that mutates fields outside the hashed bytes would not be caught.
- **Cost:** Trivial — capture the full pre-fork `OpRecord`, then `assert_eq!` after.
- **Risk:** Low.
- **Impact:** Low-medium — defends the append-only invariant on the most adversarial sync path.
- **Status:** Open.

### TEST-13 — Brittle `payload.contains()` in draft tests
- **Domain:** Draft tests
- **Location:** `src-tauri/src/draft/tests.rs:307-308, 330-331`
- **What:** Tests use `record.payload.contains(BLOCK_A)` and `record.payload.contains(DEVICE)` on the raw JSON-serialized payload string. The block_id or device string can appear anywhere in the JSON; the assertion doesn't prove it's in the correct field.
- **Cost:** Trivial — `serde_json::from_str::<EditBlockPayload>(&record.payload)` and assert `.block_id == BLOCK_A`.
- **Risk:** Low.
- **Impact:** Low — small but real precision improvement.
- **Status:** Open.

### TEST-14 — Spaces tests don't verify isolation between Personal/Work
- **Domain:** Spaces tests
- **Location:** `src-tauri/src/spaces/tests.rs:157-865` (entire test suite)
- **What:** Tests verify space creation, property assignment, and bootstrap behavior, but no test creates pages in BOTH Personal and Work spaces and asserts that scoped queries return the correct subset for each. Space isolation is a core feature; the absence of an end-to-end isolation test is a coverage gap.
- **Cost:** S — add a single test that creates pages in both spaces, runs `list_blocks(spaceId=Personal)` and `list_blocks(spaceId=Work)`, asserts each returns only its own pages.
- **Risk:** Low.
- **Impact:** Medium — locks down a core invariant.
- **Status:** Open.

### TEST-15 — Tag inheritance: missing transitive case (deletion of intermediate)
- **Domain:** Tag inheritance tests
- **Location:** `src-tauri/src/tag_inheritance/tests.rs:186-205` (`propagate_multi_level`)
- **What:** Test creates PAGE → CHILD → GRANDCHILD and verifies tag propagation. But does not cover the case where CHILD (intermediate) is deleted — should GRANDCHILD still inherit the tag from PAGE? Behavior is currently uncovered.
- **Cost:** Trivial — extend the test or add a sibling that soft-deletes CHILD and re-runs `recompute_subtree_inheritance`.
- **Risk:** Low.
- **Impact:** Low-medium — defines (and pins) behavior for an underspecified edge case.
- **Status:** Open.

### TEST-16 — Recurrence integration tests don't exercise year-boundary transitions
- **Domain:** Recurrence tests
- **Location:** `src-tauri/src/recurrence/tests.rs:521-1036` (integration tests section)
- **What:** Unit tests cover DST and leap-year edge cases, but no integration test exercises a daily/weekly recurrence that crosses Dec 31 → Jan 1 of the next year. A bug in year-component arithmetic would not be caught.
- **Cost:** Trivial — `set_due_date_inner(..., "2025-12-31"); set_repeat_property("daily"); mark DONE; assert next.due_date == "2026-01-01"`.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### TEST-17 — `opbatch_streaming_sends_in_chunks` doesn't verify within-batch seq ordering
- **Domain:** Sync protocol tests
- **Location:** `src-tauri/src/sync_protocol/tests.rs:2812-2876`
- **What:** Test verifies chunk sizes (1000, 1000, 500 ops) and `is_last` flags but doesn't assert that ops within each batch are in seq order. A reordering bug would be silent.
- **Cost:** Trivial — assert `ops[i].seq < ops[i+1].seq` per batch.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### TEST-18 — Backlink non-grouped tests don't exercise self-reference filtering or count fields
- **Domain:** Backlink tests
- **Location:** `src-tauri/src/backlink/tests.rs`
  - Self-reference filtering: `setup_backlinks()` (lines 109-117) creates orphan source blocks (no `parent_id`), so the non-grouped sort/pagination tests (lines 1130-1322) never exercise the self-reference-exclusion branch. Grouped tests cover this at line 3470+; non-grouped does not.
  - `total_count` / `filtered_count` not asserted in `sort_created_desc`, `sort_property_text`, `sort_property_num`, `sort_property_date` (lines 1158-1263).
- **What:** Per AGENTS.md pitfall #22, `total_count` must use post-filter count. The non-grouped sort tests only assert item ordering, leaving these fields unverified.
- **Cost:** S — add a non-grouped test that creates sources with `parent_id` on the target page; extend sort tests with `total_count` / `filtered_count` assertions.
- **Risk:** Low.
- **Impact:** Low-medium.
- **Status:** Open.

### TEST-19 — MCP weak-shape assertions
- **Domain:** MCP tests
- **Location:** `src-tauri/src/mcp/tools_ro/tests.rs:700` (`list_backlinks_happy_path` — only `result.is_object()`); `src-tauri/src/mcp/tools_ro/tests.rs:1272` (stress test bare `is_ok()`); `src-tauri/src/mcp/server/tests.rs:1098-1101, 1138-1141` (error-response tests check `result.is_none()` but not error code/message shape)
- **What:** Tests verify type/presence but not the response contract (`groups`, `next_cursor`, `has_more`, `total_count`; or for errors, `error.code`, `error.message`).
- **Cost:** S — add field-presence and type assertions per response contract.
- **Risk:** Low.
- **Impact:** Low-medium — tighter contract enforcement on the MCP boundary.
- **Status:** Open.

### TEST-20 — `protocol_initiator_requests_and_receives_files` missing skipped-counter assertions
- **Domain:** Sync files tests
- **Location:** `src-tauri/src/sync_files/tests.rs:495-570`
- **What:** Test asserts `files_sent/received` and `bytes_sent/received` but never asserts on `skipped_hash_mismatch` and `skipped_not_found`. Asserting `== 0` in the happy path catches future regressions in the skip accounting.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### TEST-21 — `protocol_hash_mismatch_no_ack_returns_err` only asserts `is_err()`
- **Domain:** Sync files tests
- **Location:** `src-tauri/src/sync_files/tests.rs:640-726`
- **What:** Test asserts the operation errored but doesn't verify the error message mentions hash mismatch. A connection-drop error would also pass — the test would not actually verify hash-mismatch detection.
- **Cost:** Trivial — `assert!(err.to_string().contains("hash"), …)`.
- **Risk:** Low.
- **Impact:** Low-medium.
- **Status:** Open.

### TEST-22 — `dispatch_op_unknown_op_type` doesn't verify no DB side effects
- **Domain:** Materializer tests
- **Location:** `src-tauri/src/materializer/tests.rs:841-850`
- **What:** Test asserts `dispatch_op` returns `Ok(())` for an unknown op type but doesn't verify that no DB rows were written (blocks unchanged, op_log unchanged, no cache rebuild dispatched). A silent no-op is indistinguishable from a corrupt write.
- **Cost:** Trivial — capture `SELECT COUNT(*)` before/after on `blocks` and `op_log` and assert equality.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### TEST-23 — 6 copy-pasted `*_paginates_with_cursor` tests
- **Domain:** Pagination tests
- **Location:** `src-tauri/src/pagination/tests.rs` lines 720, 877, 1550, 1702, 1911, 2032
- **What:** Six tests follow an identical 3-page-loop pattern (create N items → page through → assert ordering and `has_more`). Only the calling function and variable names differ. A bug fix in one currently requires touching all six.
- **Cost:** S — extract a generic helper `async fn assert_paginates_with_cursor<F, Fut>(list_fn: F, n: usize, page_size: usize)` or use a parameterized macro.
- **Risk:** Low — pure refactor.
- **Impact:** Low-medium — meaningful surface-area reduction.
- **Status:** Open.

### TEST-24 — 13 `tokio::time::sleep(Duration::from_millis(2))` for op-log timestamp separation
- **Domain:** Test infrastructure
- **Location:** `src-tauri/src/commands/tests/undo_redo_tests.rs` lines 599, 616, 704, 811, 940, 1066, 1073, 1224, 1245, 1348, 1371, 3846, 3933
- **What:** Tests sleep 2ms to ensure `now_rfc3339()` produces distinct timestamps on consecutive ops. The same file already uses `op_log::append_local_op_at(... explicit_timestamp ...)` in other tests — that deterministic pattern should replace these timing-dependent sleeps.
- **Cost:** S — mechanical replace.
- **Risk:** Low.
- **Impact:** Low — eliminates a category of CI flake risk.
- **Status:** Open.

### TEST-25 — ~12 near-identical FEAT-3p4 space-scoping tests in `agenda_cmd_tests.rs`
- **Domain:** Test infrastructure
- **Location:** `src-tauri/src/commands/tests/agenda_cmd_tests.rs:2268-2812`
- **What:** Multiple `*_feat3p4` tests follow the same fixture-and-assert pattern (seed two spaces, insert blocks, assign to spaces, call command, assert space filtering). The setup is copy-pasted across ~12 tests.
- **Cost:** S — extract `async fn seed_two_space_blocks(...)` helper.
- **Risk:** Low.
- **Impact:** Low — reduces a copy-paste surface that grows with each new space-aware list query.
- **Status:** Open.

### TEST-26 — `find_lca_after_compaction_returns_clear_error` hardcodes magic strings
- **Domain:** DAG tests
- **Location:** `src-tauri/src/dag/tests.rs:868-870`
- **What:** Test inserts a snapshot row with hardcoded `'SNAP01'` and `'fakehash'` directly in the SQL string. If the snapshot row schema or hash format ever changes, the test silently breaks.
- **Cost:** Trivial — extract to module constants.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### TEST-27 — `count_set_property_ops_for_key` uses LIKE on JSON
- **Domain:** Spaces tests
- **Location:** `src-tauri/src/spaces/tests.rs:931-942`
- **What:** Helper uses `format!("%\"key\":\"{}\"%", key)` LIKE pattern against JSON payloads. Fragile to whitespace or key-order changes in the JSON serializer (`"key" : "value"` vs `"key":"value"` would both currently match by accident, but a future formatter change could break the pattern).
- **Cost:** S — parse JSON in a SQL function or in Rust after `fetch_all` (or use SQLite's `json_extract`).
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### TEST-28 — `test_connection_pair()` bypasses real TLS — undocumented at the helper
- **Domain:** Sync tests / documentation
- **Location:** `src-tauri/src/sync_net/connection.rs:484` (`test_connection_pair` definition); used by `sync_daemon/tests.rs` lines 1527, 1589, 1658, 1718, 1775, 1854, 1972, 2089
- **What:** `test_connection_pair()` creates an in-memory `tokio::io::duplex` with WebSocket wrappers — no real TLS handshake. Tests using it cannot verify mTLS cert verification. The helper does not document this, so callers may believe their tests cover TLS.
- **Cost:** Trivial — add a doc-comment to `test_connection_pair` clarifying that callers needing mTLS verification must use `SyncServer::start()` + `connect_to_peer()` instead.
- **Risk:** Low.
- **Impact:** Low — documentation precision; prevents future false confidence.
- **Status:** Open.

### TEST-29 — `create_50_blocks_paginate_through_all_verify_count` creates blocks sequentially
- **Domain:** Test infrastructure
- **Location:** `src-tauri/src/command_integration_tests/lifecycle_integration.rs:160-172`
- **What:** Test creates 50 blocks in a sequential `for` loop; could parallelize with `futures::future::join_all` to reduce test runtime.
- **Cost:** Trivial.
- **Risk:** Low — parallel creates exercise the writer pool concurrency, which is also useful coverage; verify the test still asserts deterministic page ordering.
- **Impact:** Low — minor test-suite speedup.
- **Status:** Open.

### TEST-30 — `now_rfc3339()` collision risk in three undo_redo_tests sites
- **Domain:** Test infrastructure
- **Location:** `src-tauri/src/commands/tests/undo_redo_tests.rs` lines 1187, 1311, 1525
- **What:** Three sites call `now_rfc3339()` consecutively without the 2ms sleep guard that sibling tests use. Same flake risk as TEST-24 but smaller scale.
- **Cost:** Trivial — replace with explicit `append_local_op_at` (preferred) or add the same sleep guard.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### TEST-31 — MCP pagination roundtrip doesn't sum lengths across pages
- **Domain:** MCP tests
- **Location:** `src-tauri/src/mcp/tools_ro/tests.rs:1007-1012`
- **What:** Test asserts `!ids1.contains(id)` for no overlap between pages but doesn't sum `ids1.len() + ids2.len() + ids3.len()` and assert it equals the original total. A pagination bug that drops items would still pass.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

## TEST-FE — Frontend test improvements

Items in this section are test-quality improvements identified during a thorough frontend test review (8 parallel review subagents covering 366 test files under `src/**/__tests__/`, 3 verification subagents to filter hallucinations, plus direct grep + spot-reads on cross-cutting patterns). All items below are verified — known false positives (e.g., axe audits the reviewer thought were missing because they only read the first 471 lines of a longer file) are not listed.

> **Format:** test items use the compact L-style block. None of these are blocking; they are code-quality investments.

### TEST-FE-1 — Bare `setTimeout` waits in tests as the only "wait" before negative assertions
- **Domain:** Frontend test infrastructure
- **Location:**
  - `src/components/__tests__/BlockTree.test.tsx:1246, 3661, 3756, 3779, 3898, 4039, 4861` (7 bare 50ms waits before `not.toHaveBeenCalledWith` negatives)
  - `src/components/__tests__/TagFilterPanel.test.tsx:945` (350ms wall-clock for debounce, with explicit comment "without fake timers")
  - `src/hooks/__tests__/useBlockTreeEventListeners.test.ts:115` (50ms)
  - `src/components/__tests__/GraphView.test.tsx:960` (0ms tick, bare)
  - 9 additional sites where the same `await new Promise(r => setTimeout(r, N))` pattern appears (most legitimate, wrapped in `act(async)` per the React 19 timing convention)
- **What:** `src/__tests__/AGENTS.md` lines 187, 254, 261 explicitly forbid `await sleep(n)` patterns in tests ("the flake only looks fixed"). 24 occurrences across 13 files; the dangerous subset is bare 50ms waits used as the only "wait" before `expect(invoke).not.toHaveBeenCalledWith(...)` negatives — a 50ms wait passes trivially if the side effect ever takes longer than 50ms, so the test cannot tell broken from slow.
- **Why it matters:** Negative-assertion tests with bare timeouts give false confidence. Wall-clock waits for debounce (TagFilterPanel:945) waste 350ms per run and add cross-worker timing variance — pitfall #5 in AGENTS.md says exactly this.
- **Cost:** S–M — for negative assertions, await an observable signal first (`await waitFor(() => expect(invoke).toHaveBeenCalledWith('positive_signal', ...))`) then assert absence of the negative one; for debounce, `vi.useFakeTimers()` + `vi.advanceTimersByTime()`. ~13 files to touch.
- **Risk:** Low — converting wall-clock waits to deterministic `waitFor` strictly improves robustness.
- **Impact:** Medium — eliminates an entire class of silent-pass holes.
- **Status:** Open.

### TEST-FE-2 — Weak `toHaveBeenCalled()` assertions in hot files
- **Domain:** Frontend test infrastructure
- **Location:**
  - `src/components/__tests__/BlockContextMenu.test.tsx` (19 occurrences, e.g. lines 115–195: action handlers tested without verifying which block id they receive)
  - `src/components/__tests__/FormattingToolbar.test.tsx` (16)
  - `src/hooks/__tests__/useBlockKeyboardHandlers.test.ts` (10)
  - `src/components/__tests__/GraphView.test.tsx` (8)
  - `src/components/__tests__/BlockPropertyEditor.test.tsx` (7)
  - `src/components/__tests__/HeadingLevelSelector.test.tsx` (7)
  - `src/hooks/__tests__/useUndoShortcuts.test.ts` (6)
  - `src/components/__tests__/UnlinkedReferences.test.tsx` (5)
  - 175 total occurrences across 61 files (many legitimate "did fire at all"; high-frequency files most likely contain real cases)
- **What:** `src/__tests__/AGENTS.md` line 582: "Meaningful assertions — `toHaveBeenCalledWith` with exact args, not just `toHaveBeenCalled`." In `BlockContextMenu.test.tsx:115–195`, 9 parallel "it calls X" tests verify the action handler fired but not which block id it received — a wrong-block regression would silently pass.
- **Why it matters:** A documented quality standard. Concentration in hot files (action handlers, keyboard shortcuts) means real correctness regressions could slip through.
- **Cost:** M — audit the 8 listed files (~88 occurrences) and tighten high-value cases to `toHaveBeenCalledWith(expect.objectContaining({...}))`. The remaining ~50 files are a separate pass.
- **Risk:** Low — additive specificity in assertions.
- **Impact:** Medium-high in the action-handler / keyboard-shortcut files.
- **Status:** Open.

### TEST-FE-3 — `makeHistoryEntry` factory duplicated across two test files
- **Domain:** Frontend test fixtures
- **Location:**
  - `src/components/__tests__/HistoryPanel.test.tsx:38-51`
  - `src/components/__tests__/HistoryView.test.tsx:46-60`
  - Should live in `src/__tests__/fixtures/index.ts`
- **What:** Both files define a near-identical `makeHistoryEntry(seq, opType, payload, createdAt?, deviceId?)` constructing mock op-log history entries. The HistoryView variant adds an optional `deviceId` parameter; otherwise identical (same fields, same defaults, same JSON-stringified `payload`).
- **Why it matters:** `src/__tests__/AGENTS.md` line 225 explicitly says: "When the shared factory doesn't exist yet, add it to `fixtures/index.ts` rather than defining it locally — the next test file will need it too." Forthcoming undo / op-log inspector tests will likely use the same factory.
- **Cost:** Trivial — one factory + signature in fixtures, two deletions.
- **Risk:** Low — pure refactor.
- **Impact:** Low — small maintainability win.
- **Status:** Open.

### TEST-FE-4 — `vi.resetModules()` + `vi.doMock()` without try/finally guard in ViewDispatcher test
- **Domain:** Frontend test infrastructure
- **Location:** `src/components/__tests__/ViewDispatcher.test.tsx:167-213`
- **What:** The Suspense-fallback test calls `vi.resetModules()` (line 167) and `vi.doMock('../StatusPanel', …)` / `vi.doMock('../JournalPage', …)` (lines 174–180), then unmocks at lines 211–212 in the bare test body. If any assertion between 195 and 209 fails, the unmocks never run, the module registry stays poisoned, and subsequent tests in the same worker that import `StatusPanel` / `JournalPage` see the deferred-import mocks.
- **Why it matters:** Vitest's per-test isolation does not cover the dynamic module registry — it covers spies / mocked return values via `vi.clearAllMocks`, not `vi.doMock` calls. A flaky failure mid-test would corrupt the worker's module state and propagate failures.
- **Cost:** Trivial — wrap the body in `try { ... } finally { vi.doUnmock('../StatusPanel'); vi.doUnmock('../JournalPage') }`.
- **Risk:** Low.
- **Impact:** Low (rarely triggers, but eliminates a real flake source when it does).
- **Status:** Open.

### TEST-FE-5 — `useBatchCounts` agendaCounts assertion can't distinguish `dateStr` vs `displayDate` key contract
- **Domain:** Frontend test infrastructure
- **Location:** `src/hooks/__tests__/useBatchCounts.test.ts:32-52`
- **What:** The `makeDayEntry` fixture sets `displayDate === dateStr`. The hook contract is "`agendaCounts` is keyed by `dateStr`" (canonical date), but the test would also pass if a refactor accidentally changed it to use `displayDate` (timezone-formatted) — because they're the same value in the fixture. The two fields exist precisely to differ.
- **Why it matters:** A real contract regression (hook switching to display-date as the cache key) would silently pass — exactly the silent-pass class AGENTS.md flags.
- **Cost:** Trivial — make `displayDate` differ from `dateStr` in at least one fixture row, OR add `expect(Object.keys(result.current.agendaCounts)).toEqual(['2025-01-06', '2025-01-07'])`.
- **Risk:** Low.
- **Impact:** Low–medium — locks down the cache-key contract.
- **Status:** Open.

### TEST-FE-6 — Local positional `makeBlock` helpers duplicate the shared `Partial<T>`-override factory
- **Domain:** Frontend test fixtures
- **Location:**
  - `src/components/__tests__/PageOutline.test.tsx:34-51`
  - `src/components/__tests__/PageMetadataBar.test.tsx:21-35`
  - `src/components/__tests__/PageEditor.test.tsx:115-130`
  - `src/components/__tests__/TrashView.test.tsx:51-70`
- **What:** Four files define their own positional `makeBlock(id, content, ...)` helper that fully reconstructs a `FlatBlock`/`BlockRow` rather than spreading on top of the shared factory. They don't add component-specific fields — they're just positional-arg sugar over the shared `makeBlock`.
- **Why it matters:** AGENTS.md line 225 endorses the shared `Partial<T>`-override pattern. Picking one approach (positional-arg shared helper OR named-override shared helper) reduces drift in defaults — a future field added to `FlatBlock` must currently be added to four local copies, and divergence is invisible at the call site.
- **Cost:** Small — either inline `makeBlock({ id, content, parent_id: 'PAGE_1' })` at each call site, or add positional-arg variants to `fixtures/index.ts`.
- **Risk:** Low.
- **Impact:** Low — consistency and reduced drift surface.
- **Status:** Open.

### TEST-FE-7 — `AgendaResults.test.tsx` hardcoded `'2020-01-01'` overdue marker
- **Domain:** Frontend test infrastructure
- **Location:** `src/components/__tests__/AgendaResults.test.tsx:320, 332`
- **What:** Two test cases hardcode `'2020-01-01'` as an overdue date marker. The date will always be in the past, so the test isn't actually flaky — but the file already imports `subDays` from `date-fns` and uses dynamic `new Date()` for the "today" row. A relative date (`format(subDays(new Date(), 30), 'yyyy-MM-dd')`) would express intent more clearly and match the rest of the file's style.
- **Why it matters:** Mixing hardcoded-and-dynamic dates in the same test file is a small clarity tax. Consistency would make future date-relative refactors safer.
- **Cost:** Trivial — 2-line change.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### TEST-FE-8 — `PairingDialog.test.tsx` uses `document.querySelector('.pairing-error')` for portal content
- **Domain:** Frontend test infrastructure
- **Location:** `src/components/__tests__/PairingDialog.test.tsx:314-318, 542-546, 850-854`
- **What:** Three sites use `document.querySelector('.pairing-error')` to reach error content rendered inside a Radix Portal (outside the React tree). This works (the Portal escapes the React tree, `document.querySelector` reaches it) but couples the test to the CSS class name.
- **Why it matters:** Per AGENTS.md, accessible queries (`screen.findByText(...)` / `findByRole('alert')`) are preferred. They survive a class-name refactor and express intent better. Worth a quick check that each `.pairing-error` element exposes a stable accessible role/text first — if not, a one-line attribute add to the production component is the right precondition.
- **Cost:** Small — verify accessible-name surface, then swap selectors.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

## PERF — Performance items

### PERF-19 — Backlink pagination cursor uses linear scan for non-Created sorts (2 sites)

**Problem:** Two backlink pagination paths locate the cursor position with a linear scan when results are sorted by something other than block creation (e.g., due_date, priority, property value):
- `src-tauri/src/backlink/query.rs:112-128` — uses `.position(|s| s.as_str() == after_id)` on `sorted_ids`
- `src-tauri/src/backlink/grouped.rs:125-136` — uses `.skip_while(|(pid, _, _)| pid.as_str() != after_id)` on `group_list`

For `Created` sort, both already use binary search on lexicographic ULID order (correct, O(log n)). The linear-scan fallback is used because property sorts reorder by value, so binary search on ID is invalid — but the fallback is O(n) in the filtered result set.

**Why it matters:** N here is the already-filtered result set (per page), typically ≤50 items. At that size the linear scan is ~50 string comparisons — cheaper than building a HashMap would be. This is documented as a LOW-severity finding and would only matter if page size is ever raised well into the thousands. Listed here so it doesn't get reinvented as a "fix" later when someone sees the loop without context.

**Fix (if ever needed):** maintain a `HashMap<&str, usize>` during the sort step for O(1) cursor lookup. Only worth doing if page size grows past ~500.

**Decision:** Defer — keep tracked in REVIEW-LATER as a deliberate non-fix. Revisit only if page size grows past ~500 or saved-query features ship.

**Cost:** S

### PERF-20 — Backlink filter resolver has no concurrency cap on `try_join_all`

**Problem:** `src-tauri/src/backlink/query.rs:80-82` fires every top-level filter concurrently via `try_join_all(filter_list.iter().map(|f| resolve_filter(pool, f, 0)))`. The read pool has 4 connections; if a user ever ends up with a filter expression holding 20+ OR-ed top-level filters, they all enqueue at once.

**Why it's LOW:** sqlx's `SqlitePool` queues gracefully when all connections are busy — it doesn't fail, it just waits. Realistic filter counts from the UI (`BacklinkFilterBuilder`) are 2–4. No known path to generate 20+ concurrent filters from normal usage. Flagging here in case a future "saved query library" or automation feature ever produces pathological inputs.

**Fix (optional, if saved-query features ship):**
```rust
let semaphore = Arc::new(tokio::sync::Semaphore::new(4));
let futures = filter_list.iter().map(|f| {
    let sem = semaphore.clone();
    async move {
        let _permit = sem.acquire().await.ok()?;
        resolve_filter(pool, f, 0).await
    }
});
let results = try_join_all(futures).await?;
```

Or a simpler cap: reject filter lists longer than some reasonable limit (e.g., 16) at the command boundary.

**Decision:** Defer — keep tracked in REVIEW-LATER as a deliberate non-fix. Revisit only if saved-query / automation features ship that can produce pathological filter counts.

**Cost:** S

### PERF-23 — `read_attachment_file` buffers whole file before chunked send

**Problem:** `src-tauri/src/sync_files.rs:182` (`read_attachment_file`) loads the full attachment into a `Vec<u8>` with `std::fs::read(path)` and hashes the complete buffer, then the caller at `src-tauri/src/sync_files.rs:294-300` iterates through `FILE_CHUNK_SIZE` (5 MB, defined at `sync_files.rs:34`) slices of that in-memory buffer for transmission. Peak memory per attachment is the file size (not N-additive — the loop is sequential).

**Why it's LOW:** For a personal notes app with typical attachments under 10 MB this is fine. Listed so that if the product ever intentionally targets large media (e.g., video notes), the correct fix is obvious.

**Fix (only if large attachments become a supported use case):** stream-hash and stream-chunk. Open a `tokio::fs::File`, wrap it in a `BufReader`, and in one pass:
- `blake3::Hasher::new()` → `update()` per buffer
- Collect chunk-size slices directly into the send queue without retaining the full buffer

This changes the signature of `read_attachment_file` (no longer returns `Vec<u8>` + hash together) and requires threading the streaming semantics through the sender loop. The chunk transport on the wire is already chunked, so no sync-protocol change is needed.

**Decision:** Defer — keep tracked in REVIEW-LATER as a deliberate non-fix. Revisit only if large media (video notes, high-bit-depth images) becomes a supported use case.

**Cost:** S–M

### PERF-24 — `cache/block_tag_refs.rs::reindex_block_tag_refs` per-target DELETE/INSERT loop

**Problem:** `src-tauri/src/cache/block_tag_refs.rs:80-88` (DELETE loop) and `:90-108` (INSERT loop) issue one statement per target. The split-pool variant `reindex_block_tag_refs_split` has the same shape. Sibling `cache/block_links.rs:66-93` already uses `json_each(?)` to batch deletes and inserts in two round-trips total.

**Why it matters:** Realistic block-tag-ref counts are 1-10 per block, so the wall-clock impact is bounded. The value is consistency with `block_links` (same diff-and-apply semantics, two different implementations) and future-proofing if a block ever holds many tag refs (e.g. a block that aggregates tags from multiple sources).

**Fix:** Match the `block_links` pattern. Two statements total per re-index. The `INSERT OR IGNORE ... WHERE EXISTS (... block_type='tag')` form is expressible as a single statement using `json_each` joined against `blocks`. Keep the existence check in the JOIN.

**Cost:** S — straightforward port of the `block_links` pattern.
**Risk:** Low — covered by existing reindex tests; the oracle is `block_links`'s already-shipped batched implementation.
**Impact:** Low (bounded) but consistent with project performance conventions.

### PERF-25 — `gcal_push/connector.rs::GcalSettingsSnapshot::read` issues 4 separate SELECTs

**Problem:** `src-tauri/src/gcal_push/connector.rs:313-324` calls `models::get_setting` four times (CalendarId, PrivacyMode, WindowDays, AccountEmail). Each is a separate `SELECT … WHERE key = ?` round trip. Runs once per cycle (every 15-minute reconcile + every dirty-event burst).

**Fix:** Add `models::get_settings_batch(pool, &[Key1, Key2, Key3, Key4])` returning `HashMap<GcalSettingKey, String>`. Single `SELECT … WHERE key IN (?, ?, ?, ?)`. The pattern is already used in `lease.rs` for batched key reads.

**Cost:** S — one helper; one call-site change.
**Risk:** Low.
**Impact:** Low (4 round trips → 1, on a 15-minute timer; not a hot path).

### PERF-26 — `link_metadata/mod.rs::fetch_metadata` rebuilds `reqwest::Client` per call

**Problem:** `src-tauri/src/link_metadata/mod.rs:51-57` constructs `reqwest::Client::builder()…build()` on every invocation. Each call rebuilds TLS state and discards the connection pool after a single request. Called from a hot path (link preview on every external link paste/edit).

**Fix:** Move the client to a module-level `static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();` initialised lazily on first call. Pattern already used in `gcal_push/api.rs:49`.

**Cost:** S — 5-line change.
**Risk:** Low — `reqwest::Client` is `Clone + Send + Sync` and explicitly designed for this use.
**Impact:** Low-medium — eliminates per-call TLS handshake on the link-preview hot path. Particularly valuable when a user pastes a markdown block with many external links.

### PERF-27 — `backlink/filters.rs::PropertyText` filter materialises before comparing

**Problem:** `src-tauri/src/backlink/filters.rs:137-162` fetches all rows matching a property key (`SELECT … WHERE bp.key = ?1`), then applies the comparison operator (`=`, `LIKE`, `CONTAINS`, etc.) in Rust. For property keys with thousands of distinct values this materialises the full set into memory before filtering.

**Fix:** Build the comparison clause dynamically (the existing operator enum already enumerates the cases) and let SQLite do the filtering. Pattern already exists in `pagination/properties.rs:100-140`.

**Cost:** S — finite operator arms; query builder already in use elsewhere.
**Risk:** Low — covered by existing filter-resolver tests.
**Impact:** Low-medium — bounded by realistic property cardinality, but pushes work to the layer that should be doing it.

---

### PUB-2 — Git author email across all history is corporate (`javier.folcini@avature.net`)

**Problem:** `git log --format='%ae %an' | sort -u` across all 1,400+ commits returns a single corporate email address. If the project is published under a personal identity (or the user later wants to avoid tying the repo to a specific employer), the history will still expose the corporate address on every commit, including to anyone who clones.

**Options:**
1. **Rewrite history with `git filter-repo`** using a mailmap to replace `javier.folcini@avature.net` with a personal email across all commits. This changes every commit SHA — must be done before any public push or before any collaborator clones.
2. **Add a `.mailmap`** that re-maps the author in views (`git log`/`git shortlog`) without rewriting history. Cosmetic only; the underlying commit objects still carry the corporate email.
3. **Leave as-is.** Accept the provenance signal. Defensible if the project is legitimately personal and the corporate email was simply the active git config at the time.

**If option 1 is chosen:**
- Take a full backup of `.git` before running `git filter-repo`.
- Script: `git filter-repo --mailmap mailmap.txt` with an entry like
  `Your Name <personal@example.com> <javier.folcini@avature.net>`.
- Re-verify signatures if any commits are GPG-signed.
- Do this before the first public push. Rewriting published history is disruptive.

**Cost:** S
**Decision:** Defer the identity/history choice until the publish target (PUB-5) and publish timing are concrete. No `.mailmap` added and no history rewrite performed in this session.
**Status:** DEFERRED — revisit alongside PUB-5 when a publish target and identity are locked in.

### PUB-3 — Employer IP clearance before public release

**Problem:** Most employment agreements in AR/US/EU include IP-assignment clauses that cover work done on company devices, on company time, or in the employer's line of business. The committed corporate email in the git history (see PUB-2) makes provenance visible to anyone who clones. Even for a side project unrelated to the employer's business, publishing substantial software without checking the employment contract carries legal risk that a coding agent cannot assess.

**Options:**
1. **Review the employment contract** (and any IP-assignment addenda signed during onboarding) for clauses covering personal projects. Common concerns: "on company time", "using company equipment", "related to the employer's business", "during the term of employment".
2. **Request written clearance** from the employer (in writing, e.g., email to HR/legal) before publishing. Keep the response filed.
3. **Consult a lawyer** if any clause is ambiguous, especially the "related to employer's business" language. Note-taking / productivity / developer tooling can be a grey area for some employers.
4. **Defer publishing** until clearance is obtained.

**Not an agent task.** No file should be modified based on this item. Agents must never publish, push to remote, or change repo visibility without the user explicitly stating "PUB-3 is cleared".

**Cost:** S (user's time; not an implementation task)
**Decision:** Defer — user-only legal task. Agent does nothing and does not revisit this item during routine sweeps. Will be marked cleared (and the item removed) only when the user explicitly states "PUB-3 is cleared".
**Status:** DEFERRED — user task, not agent-actionable.

### PUB-5 — Tauri updater endpoint URL pinned; keypair + secrets remain user-only

**Status:** the endpoint URL in `src-tauri/tauri.conf.json` points at `https://github.com/jfolcini/agaric/releases/latest/download/latest.json`. The remaining work is purely user-side and cannot be agent-actioned:

1. **Generate the Minisign keypair** (`cargo tauri signer generate -w ~/.tauri/agaric.key`). Back up the private key offline — losing it means future updaters can't verify against the deployed pubkey, breaking the auto-update chain for installed users.
2. **Paste the public key** into `tauri.conf.json` `updater.pubkey`.
3. **Add two GH Actions secrets** at `Settings → Secrets and variables → Actions`:
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of the generated `.key` file
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the passphrase used at generation time
4. **Uncomment** the two `TAURI_SIGNING_PRIVATE_KEY*` env lines in `release.yml:93-95` (under the `# PUB-5: Uncomment …` comment). The agent intentionally left these commented because uncommenting before the secrets exist + pubkey is set causes tauri-action to attempt signing with empty inputs.
5. **Tag a release** to verify: tauri-action will produce `*.sig` files alongside each bundle (`.dmg.sig`, `.AppImage.sig`, `.msi.sig`, etc.), which the in-app updater fetches and verifies against the embedded pubkey.

**Alternative (skip the updater):** remove the `updater` block from `tauri.conf.json` and the `tauri-plugin-updater` dependency from `src-tauri/Cargo.toml`. Users would update by manually downloading new releases.

**Cost:** S (~30 min of user work once the keypair is generated).

### PUB-8 — Android release keystore + 4 GH Actions secrets

**Problem:** `release.yml`'s `android-build-and-release` job already contains the full apksigner pipeline (zipalign + apksigner sign + apksigner verify + `gh release upload`), gated on a `ANDROID_KEYSTORE_BASE64` secret. Without the keystore + secrets the job uploads `agaric-<tag>-android-aarch64-unsigned.apk` (works on personal devices, but Play Protect warns and the APK can never be updated by a release-keystore-signed APK without uninstalling and losing data). The local `agaric-release.apk` previously in repo root was debug-keystore-signed and has the same dead-end property.

**Concrete remaining work:**
1. **Generate a release keystore** (one-time, locally):
   ```bash
   keytool -genkeypair -v \
     -keystore ~/agaric-release.jks \
     -alias agaric \
     -keyalg RSA -keysize 4096 -validity 10000 \
     -storetype PKCS12
   ```
   Pick stable CN/OU/O/L/ST/C — these are visible in Android Settings → Apps → Agaric → Advanced → "App signed by".
2. **Back up `agaric-release.jks` offline** (not in the repo, not in the GH secret, not in any cloud-synced folder you might lose). Lose this key and you lose the ability to ship updates that overwrite installed apps — Android refuses signature changes on upgrade. The base64 in the GH secret is *not* a backup; secrets are write-only after creation.
3. **Add 4 GH Actions secrets** at `Settings → Secrets and variables → Actions`:
   - `ANDROID_KEYSTORE_BASE64` ← `base64 -w0 ~/agaric-release.jks`
   - `ANDROID_KEYSTORE_PASSWORD` ← the store password from step 1
   - `ANDROID_KEY_ALIAS` ← `agaric` (or whatever alias you chose)
   - `ANDROID_KEY_PASSWORD` ← the key password from step 1
4. **Tag a release.** Next `git push --tags` produces `agaric-<tag>-android-aarch64.apk` (no `-unsigned` suffix) on the GitHub Release.

Full setup recipe in `BUILD.md` → "Release signing in CI" (under "Android Builds"). If you ever want to ship via Play Store later, this same key becomes the **upload key** under Play App Signing — Google holds the actual app signing key in that flow.

**Cost:** S (~15 min once you've decided what to use as DN).
**Status:** ACTIONABLE — pure operations, no design decision pending.

### M-95 — `recover_calendar_gone` does not also clear `oauth_account_email`
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/connector.rs:727-741`
- **What:** When the calendar is gone, the connector wipes the event map and resets `calendar_id`, but `oauth_account_email` is left untouched. The Settings UI continues to show "connected as user@example.com" while the connector has just reset to "no calendar yet".
- **Why it matters:** Cosmetic UX consistency — does not affect correctness of the push pipeline. Listed Medium in the M- numbering for parity with M-89's transaction concern, but this is purely a Settings-tab display drift.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either leave as-is (the email is still the right one — only the calendar reset) or, if FEAT-5f explicitly differentiates "connected, no calendar yet" from "calendar recreated since last open", refresh `oauth_account_email` from the most recent token's id_token claim during the recreate path. Lean toward leaving as-is unless FEAT-5f spec calls for the distinction.
- **Pass-1 source:** 10/F23
- **Status:** Open

### M-96 — `materializer/coordinator.rs::status` swallows DB errors with `.ok()`
- **Domain:** Materializer / Observability
- **Location:** `src-tauri/src/materializer/coordinator.rs:751-761`
- **What:** `total_ops_in_log` and `retry_queue_pending` use `.ok()` on the COUNT query, returning `None` on any DB error with no logging. A persistent reader-pool issue or migration drift would surface as silent `None` values in the status output rather than a tracked operational signal.
- **Why it matters:** Operators lose visibility during exactly the conditions where they need it (DB pressure, pool exhaustion). Status itself never fails, which is correct behaviour for an observability path, but the silent error swallow loses signal.
- **Cost:** Trivial — `.inspect_err(|e| tracing::warn!(error = %e, "status query failed"))` chained before `.ok()`.
- **Risk:** Low.
- **Impact:** Low.
- **Recommendation:** Add the `inspect_err` log; keep `.ok()` so status semantics don't change.
- **Status:** Open

### M-97 — `commands/properties.rs` reserved-property validation queries `property_definitions` outside the transaction
- **Domain:** Commands (Properties)
- **Location:** `src-tauri/src/commands/properties.rs:204-207, 380-384`
- **What:** Both `set_priority_inner` and `set_todo_state_inner` issue a `fetch_optional` against `property_definitions` *before* opening the `CommandTx`. The single-user threat model means concurrent deletion of a property definition by another process is not a realistic race, and `set_property_in_tx` (called inside the transaction) repeats the validation. The pattern is suboptimal but not a correctness bug in the single-user context.
- **Why it matters:** Future-bug magnet. If the in-tx validation path is ever inlined or simplified, the out-of-tx fetch becomes the primary check and stops being safe. Folding it into `CommandTx::begin_immediate` is a 3-line move and removes the duplication.
- **Cost:** S — straightforward refactor.
- **Risk:** Low.
- **Impact:** Low.
- **Recommendation:** Move the `fetch_optional` to inside the existing transaction so the validation and the eventual write share atomicity. No behaviour change in single-user usage; cleaner contract for future readers.
- **Status:** Open

### L-17 — `dispatch_op` enqueues fg+bg out of order
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/dispatch.rs:98-102`
- **What:** `dispatch_op` calls `enqueue_foreground(ApplyOp(record))` then `enqueue_background_tasks(record, None)`. The two queues have independent consumers — the bg consumer can pull e.g. `RebuildTagsCache` and execute it before the fg consumer has applied the `CreateBlock(tag)` to `blocks`. The cache rebuild then reads pre-op state and `tags_cache` stays stale until the next op happens to re-enqueue the rebuild. Production paths use `dispatch_background_or_warn` *after* the command has committed the op, so this race is mostly limited to test code (and `sync_daemon/snapshot_transfer.rs:451`, which is itself a test helper); it is downgraded from Medium for that reason.
- **Why it matters:** For the test paths (and the snapshot-transfer test helper) it shrinks the window of correctness for the very-first op of its kind. If `dispatch_op` is ever adopted on a production code path it becomes a real correctness hazard ("created a tag, search doesn't find it" until I create another).
- **Cost:** M (2-8h)
- **Risk:** Medium
- **Impact:** Low
- **Recommendation:** Either (a) move the bg fan-out *into* the fg consumer so it runs only after `apply_op_tx` commits — making the consumer the single scheduler of per-op derived work; or (b) thread a `Notify` keyed on `(device_id, seq)` and have the bg side `notified().await` before running the rebuild it spawned. (a) is cleaner.
- **Pass-1 source:** 02/F10
- **Status:** Open

### L-53 — `cancel_pairing` clears pairing slot whether or not a session exists
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/sync_cmds.rs:152-158`
- **What:** `cancel_pairing_inner` sets the slot to `None` unconditionally and returns `Ok(())`; there is no error if no session was active. Combined with the lack of validation in `confirm_pairing_inner` (Pass-1 F16), the entire `pairing_state` slot is effectively write-only — only `start_pairing` writes it; `confirm_pairing` and `cancel_pairing` always overwrite with `None`.
- **Why it matters:** Symptom of broader pairing-state ownership confusion. Once the F16 fix lands (`confirm_pairing` actually validates against the slot), this becomes the natural "no-op if absent" path; until then, the slot has no observable effect.
- **Cost:** N/A (closes alongside the F16 fix tracked elsewhere as a High in REVIEW-LATER)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Bundle into the F16 / confirm_pairing fix; once `confirm_pairing` reads and validates the slot, `cancel_pairing` can keep its current "no-op if empty" semantics with a debug log.
- **Pass-1 source:** 05/F32
- **Status:** Open

### L-55 — `redact_log` newline split-and-rejoin is O(n²) in the worst case
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/bug_report.rs:229-242` (`redact_log`), `src-tauri/src/commands/bug_report.rs:202-226` (`redact_line`)
- **What:** `redact_log` iterates `split_inclusive('\n')`, calls `redact_line` (which does two `String::replace` calls — each a linear scan with allocation: home, then device_id), then pushes back into `out`. For a 2 MB file this is two full-buffer linear scans per line, multiplied by the line count. `MAX_LINE_BYTES` truncation happens *after* the replace, so the replace itself sees the original full-length line.
- **Why it matters:** A bug report on a workstation with thousands of large stack-trace lines could take seconds. Mitigated by the 2 MB file cap.
- **Cost:** M — switch to a single-pass replacer (e.g. `aho_corasick` or a hand-written matcher over the static needles).
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Acceptable as-is until profiling shows it is a bottleneck; lower priority than M-31 / L-41. If/when fixed, a single-pass `replace_n` over both needles avoids allocations.
- **Pass-1 source:** 05/F35
- **Status:** Open

### L-56 — `commands/attachments.rs::add_attachment_inner` uses `debug_assert_eq!` for file-size verification
- **Domain:** Commands (Attachments)
- **Location:** `src-tauri/src/commands/attachments.rs:122-130`
- **What:** Verifies `metadata.len() == size_bytes` only in debug builds; release builds skip the check entirely. If the frontend's `@tauri-apps/plugin-fs` write fails silently (truncation, disk full) the attachment record is created with the wrong `size_bytes`. The sync layer's hash check provides secondary defense, but the early guard is intentional.
- **Cost:** Trivial — convert to a runtime guard returning `AppError::Validation`.
- **Risk:** Low.
- **Impact:** Low — closes a release-build integrity gap.
- **Status:** Open

### L-57 — `commands/mod.rs::delete_property_core` panics on unknown reserved key via `unreachable!()`
- **Domain:** Commands
- **Location:** `src-tauri/src/commands/mod.rs:629-655`
- **What:** Match arms cover `"todo_state"`, `"priority"`, `"due_date"`, `"scheduled_date"`; the catch-all is `unreachable!(...)`. Currently safe because `is_reserved_property_key` (`src-tauri/src/op.rs:343-348`) returns `true` for exactly those four keys — but a future addition without updating this match crashes the command instead of returning a proper error.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low — defensive change; converts a panic path into an error path.
- **Recommendation:** Replace `unreachable!()` with `Err(AppError::InvalidOperation(format!("unknown reserved property: {key}")))`.
- **Status:** Open

### L-58 — `commands/sync_cmds.rs` repeats mutex-poison error mapping 4×
- **Domain:** Commands (Pairing/Sync)
- **Location:** `src-tauri/src/commands/sync_cmds.rs:152, 197, 230, 247`
- **What:** Four `map_err(|_| AppError::InvalidOperation("pairing state lock poisoned"))` sites in `start_pairing_inner`, `confirm_pairing_inner`, and `cancel_pairing_inner`. Future changes to the message or logging require N coordinated edits.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low — small DRY improvement.
- **Recommendation:** Extract a `lock_pairing_state(state) -> Result<MutexGuard<...>, AppError>` helper; collapse the 4 sites to 1.
- **Status:** Open

### L-59 — UTF-8-safe truncation duplicated between `commands/logging.rs` and `commands/bug_report.rs`
- **Domain:** Commands (Logging / Bug report)
- **Location:** `src-tauri/src/commands/logging.rs:26-40` and `src-tauri/src/commands/bug_report.rs:213-224`
- **What:** Both implement char-boundary-safe string truncation. Different signatures and message formats but identical core logic.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Recommendation:** Move to a small `crate::text_utils::truncate_at_char_boundary` helper; reuse from both call sites.
- **Status:** Open

### L-60 — `sync_files.rs::find_missing_attachments` collapses all `metadata` errors into "missing"
- **Domain:** Sync (Attachments)
- **Location:** `src-tauri/src/sync_files.rs:179-195`
- **What:** `Err(_) => missing.push(...)` treats EACCES, EPERM, EBUSY identically to ENOENT. The comment at L153-156 explicitly says "most defensive choice." A permission-denied attachment would be re-requested from the peer on every sync until fixed.
- **Why it matters:** Realistic impact is low (app's own data dir should be readable on Linux/Windows). Logging the error kind separately costs nothing and surfaces a real ops failure mode (antivirus quarantine, read-only remount, sandbox denial).
- **Cost:** Trivial — split the `Err` arm into `NotFound` vs other-with-warn.
- **Risk:** Low.
- **Impact:** Low — better diagnostics, no behaviour change.
- **Status:** Open

### L-61 — `op_log.rs::extract_block_id_from_payload` warns and returns `None` on JSON parse failure (DELIBERATE — no action)
- **Domain:** Op log
- **Location:** `src-tauri/src/op_log.rs:344-367`
- **What:** Function logs at `warn!` level and returns `None` if the payload JSON is malformed, leaving the indexed `op_log.block_id` column NULL for that row.
- **Why this is filed and not done:** The inline `L-1` comment documents the deliberate decision. The only path that produces a malformed payload here is one that has already passed hash-chain verification — essentially impossible for synced ops. Local ops go through the typed `OpPayload` path and would fail at serialize time, not at index extraction. The team has already considered and resolved this; recording it here so future code reviews don't re-flag the same pattern.
- **Cost:** N/A.
- **Risk:** N/A.
- **Impact:** N/A.
- **Decision:** No action. Filed for awareness only.
- **Status:** Documented as deliberate.

### FE-H-1 — Cursor pagination violated in `executeAgendaFilters` default branch
- **Domain:** Frontend / Agenda
- **Location:** `src/lib/agenda-filters.ts:287-290`
- **What:** Default branch (no filters) calls three queries with `limit: 500` and hardcoded `cursor: null`, and never paginates. Violates AGENTS invariant #3 ("Cursor-based pagination on ALL list queries").
- **Why it matters:** A user with more than 500 due/scheduled blocks silently loses items.
- **Cost:** S–M
- **Risk:** Low
- **Impact:** High — silent data loss in the default agenda view at scale.
- **Recommendation:** Thread cursor pagination through the default branch like the filtered branches do, or document the carve-out explicitly per AGENTS invariant #3 if 500 is genuinely a safe upper bound.
- **Source:** FE review 2026-05-02 / F014
- **Status:** Open

### FE-H-2 — `agenda-filters.ts`: hardcoded `limit: 500` repeated in 6 sites
- **Domain:** Frontend / Agenda
- **Location:** `src/lib/agenda-filters.ts:79, 99, 128, 156, 232, 290`
- **What:** A single magic number drives pagination in six call sites; missing one update silently truncates a query. Related to FE-H-1.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Medium.
- **Recommendation:** Extract `const AGENDA_QUERY_LIMIT = 500` and reference it everywhere.
- **Source:** FE review 2026-05-02 / F016
- **Status:** Open

### FE-H-3 — `useScrollRestore` schedules a `requestAnimationFrame` with no cleanup
- **Domain:** Frontend / Hooks
- **Location:** `src/hooks/useScrollRestore.ts:36-47`
- **What:** RAF callback captures `container`. If the component unmounts before the frame fires, the callback runs and writes `scrollTop` on a detached node.
- **Cost:** Trivial — capture the RAF id and `cancelAnimationFrame(id)` in the cleanup.
- **Risk:** Low.
- **Impact:** Low — defensive fix.
- **Source:** FE review 2026-05-02 / F043
- **Status:** Open

### FE-H-4 — `useBlockPropertyIpc` callbacks have no unmount guard
- **Domain:** Frontend / Hooks
- **Location:** `src/hooks/useBlockPropertyIpc.ts:57-65`
- **What:** Three `useCallback` wrappers around IPC functions have no `cancelled` flag. Promise resolution after unmount can fire setState on consumer components.
- **Cost:** S — adopt the `cancelled`-flag pattern that `useBacklinkResolution` already uses.
- **Risk:** Low.
- **Impact:** Medium — prevents React warnings and stale renders during property-drawer churn.
- **Source:** FE review 2026-05-02 / F028
- **Status:** Open

### FE-H-5 — `usePropertyDefForEdit` initiates nested IPC without checking stale flag first
- **Domain:** Frontend / Hooks
- **Location:** `src/hooks/usePropertyDefForEdit.ts:75-82`
- **What:** Outer `listPropertyDefs()` then-block kicks off `listBlocks()` without first checking `if (stale) return`. If unmount happens between outer-resolve and inner-call, the nested promise still runs and its own stale check fires too late.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low — race window is narrow.
- **Recommendation:** Gate the nested call with `if (stale) return` before initiating it.
- **Source:** FE review 2026-05-02 / F044
- **Status:** Open

### FE-H-6 — `useDuePanelData` projected-cache mutation not gated by stale flag
- **Domain:** Frontend / Due panel
- **Location:** `src/hooks/useDuePanelData.ts:393-467`
- **What:** Outer `if (!stale)` guards setState calls, but the `projectedCache.set(cacheKey, ...)` mutation itself is unguarded. Rapid date changes (which clear the cache via `invalidationKey`) can race with an in-flight resolve and silently repopulate the cache with stale data.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Medium — silent stale-data display in the projected agenda after fast date changes.
- **Recommendation:** Move the cache mutation inside the `if (!stale)` block, or add an explicit guard around it.
- **Source:** FE review 2026-05-02 / F036
- **Status:** Open

### FE-H-7 — `useCheckboxSyntax`: optimistic update has no rollback on IPC rejection
- **Domain:** Frontend / Editor
- **Location:** `src/hooks/useCheckboxSyntax.ts:38-60`
- **What:** Hook mutates `pageStore` optimistically (lines 58–60) before `setTodoStateCmd()` resolves. On rejection only a toast fires — the UI state stays out of sync with the backend.
- **Cost:** S — capture prior `todo_state` before the optimistic update; revert on rejection.
- **Risk:** Low.
- **Impact:** Medium — user sees the new checkbox state even though the backend never accepted it.
- **Source:** FE review 2026-05-02 / F037
- **Status:** Open

### FE-H-8 — `useCheckboxSyntax` silent catch: only `toast.error`, no `logger`
- **Domain:** Frontend / Editor
- **Location:** `src/hooks/useCheckboxSyntax.ts:55-60`
- **What:** `.catch(() => toast.error(...))` violates AGENTS' "no silent catch" rule — production debugging blind spot.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Recommendation:** Add `logger.error('useCheckboxSyntax', 'setTodoState failed', { focusedBlockId, state }, err)` before the toast. Combine with FE-H-7.
- **Source:** FE review 2026-05-02 / F034
- **Status:** Open

### FE-H-9 — `useHistoryDiffToggle` silent catch: only `toast.error`, no `logger`
- **Domain:** Frontend / History
- **Location:** `src/hooks/useHistoryDiffToggle.ts:33-38`
- **What:** Same pattern as FE-H-8 — bare `catch { toast.error(...) }` swallows the error.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Recommendation:** Add `logger.warn('useHistoryDiffToggle', 'computeEditDiff failed', undefined, err)`.
- **Source:** FE review 2026-05-02 / F035
- **Status:** Open

### FE-H-10 — `CompactionCard` silent catches in `fetchStatus` and `handleCompact`
- **Domain:** Frontend / Compaction
- **Location:** `src/components/CompactionCard.tsx:30-36, 50-55`
- **What:** Both catch handlers show toast but no `logger` call.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low — production debugging blind spot for compaction failures.
- **Recommendation:** Add `logger.warn('CompactionCard', 'getCompactionStatus failed', undefined, err)` and `logger.error('CompactionCard', 'compaction failed', undefined, err)`.
- **Source:** FE review 2026-05-02 / F069 + F070
- **Status:** Open

### FE-H-11 — `PdfViewerDialog` render-task cancel uses bare `catch { }`
- **Domain:** Frontend / PDF viewer
- **Location:** `src/components/PdfViewerDialog.tsx:58-62`
- **What:** Literal `catch {}` (no parameter, no log) violates AGENTS' "no silent catch" rule.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Recommendation:** `catch (err) { logger.warn('PdfViewerDialog', 'render task cancel threw', undefined, err) }`.
- **Source:** FE review 2026-05-02 / F075
- **Status:** Open

### FE-H-12 — `PairingDialog.doInit()` promise has no `.catch`
- **Domain:** Frontend / Pairing
- **Location:** `src/components/PairingDialog.tsx:153-160`
- **What:** `doInit().then(...)` has no `.catch`. Rejections become unhandled promise rejections.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Recommendation:** Chain `.catch((err) => logger.warn('PairingDialog', 'init failed', undefined, err))`.
- **Source:** FE review 2026-05-02 / F074
- **Status:** Open

### FE-H-13 — Tauri-mock dispatcher uses `console.warn`, bypassing the logger
- **Domain:** Frontend / Tauri mock
- **Location:** `src/lib/tauri-mock/handlers.ts:1635-1640`
- **What:** Bypasses the logger's rate-limiting, stack capture, and IPC bridge to the Rust side. Per AGENTS, `console.warn` is forbidden.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low — only affects dev/Storybook/E2E paths but undermines the "structured logging" guarantee.
- **Recommendation:** `logger.warn('TauriMock', 'unhandled command', { command: cmd })`.
- **Source:** FE review 2026-05-02 / F022
- **Status:** Open

### FE-H-14 — `className` is silently dropped from `Button`, `Spinner`, `Label` (CVA misuse)
- **Domain:** Frontend / UI primitives (cross-cutting)
- **Location:** `src/components/ui/button.tsx:59`, `src/components/ui/spinner.tsx:37`, `src/components/ui/label.tsx:38`
- **What:** All three pass `className` as a CVA variant key — `buttonVariants({ variant, size, className })` — but CVA does not consume `className`. The caller's `className` is silently dropped. Correct pattern is in `badge.tsx:42`: `cn(buttonVariants({ variant, size }), className)`.
- **Why it matters:** Button is at the top of the design system pyramid; every place that thought it was customizing a button has been silently overridden. Visible regressions cannot be tracked back without scanning every consumer.
- **Cost:** Trivial — 3 single-line edits.
- **Risk:** Low — fixes a silent regression; consumers that relied on the broken behavior would expose visual diffs that are themselves bugs.
- **Impact:** High — restores the entire design system's customization escape hatch.
- **Recommendation:** Replace each with `className={cn(buttonVariants({ variant, size }), className)}` etc. Consider adding a Biome rule or typed `cn-cva` helper to prevent regression.
- **Source:** FE review 2026-05-02 / F024
- **Status:** Open

### FE-H-15 — Sidebar rail drag handler leaks `pointermove`/`pointerup` listeners on unmount-during-drag
- **Domain:** Frontend / UI primitives
- **Location:** `src/components/ui/sidebar.tsx:488-548` (registration: 542-543)
- **What:** `onPointerDown` adds listeners to `document` and only removes them in the `pointerup` handler. If the sidebar component unmounts mid-drag (e.g., a route change), the listeners stay attached to `document` and reference stale state.
- **Cost:** S — track active drag in a ref, remove listeners in a cleanup effect.
- **Risk:** Low.
- **Impact:** Medium — small but real memory leak + stale-state callback risk.
- **Source:** FE review 2026-05-02 / F025
- **Status:** Open

### FE-H-16 — `SidebarProvider` `useMemo` deps array missing `setOpenMobile` / `setIsResizing`
- **Domain:** Frontend / UI primitives
- **Location:** `src/components/ui/sidebar.tsx:206-231`
- **What:** Memoized context value object includes `setOpenMobile` (line 213) and `setIsResizing` (line 218) but the dependency array (lines 220–230) omits both. If either setter ever changes identity, consumers receive a stale closure.
- **Cost:** Trivial — add both to the dependency array.
- **Risk:** Low.
- **Impact:** Low — current React guarantees that `useState` setters are stable, so the stale-closure risk is narrow today; included as a defensive correctness fix.
- **Source:** FE review 2026-05-02 / F026
- **Status:** Open

### FE-H-17 — `BlockPropertyDrawer` / `PagePropertyTable`: `Promise.all` partial-failure handling
- **Domain:** Frontend / Properties
- **Location:** `src/components/BlockPropertyDrawer.tsx:79-90`, `src/components/PagePropertyTable.tsx:48-60`
- **What:** Both use `Promise.all([getProperties(...), listPropertyDefs()])` then guard with `Array.isArray(props) ? props : []`. The defensive guard signals real uncertainty about response shape, and a single rejection rejects the whole load (catch logs but the user just sees an empty drawer with no specific feedback).
- **Cost:** S.
- **Risk:** Low.
- **Impact:** Medium.
- **Recommendation:** Use `Promise.allSettled` and report each failure individually via `reportIpcError`, or land the response-shape guarantee in the IPC layer so the defensive guards can come out.
- **Source:** FE review 2026-05-02 / F049
- **Status:** Open

### FE-H-18 — Slash-command auto-execute timer doesn't guard against destroyed editor view
- **Domain:** Frontend / Editor
- **Location:** `src/editor/extensions/slash-command.ts:93-101`
- **What:** A 200ms `setTimeout` calls `command(item)` later. If the editor view is destroyed between schedule and fire, the call runs on a destroyed view. AGENTS' Floating UI lifecycle logging rules require guarding callback invocations on stale state and logging the desync.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low — race window is narrow but visible in tests / fast keyboard navigation.
- **Recommendation:** `if (editor.view.isDestroyed) { logger.warn('slash-command', 'skipping auto-execute — editor view destroyed'); return }` plus a try/catch around `command(item)`.
- **Source:** FE review 2026-05-02 / F010
- **Status:** Open

### FE-H-19 — `DuePanel`: `flatItems` array recomputed every render, breaks `useListKeyboardNavigation` stability
- **Domain:** Frontend / Performance / Due panel
- **Location:** `src/components/DuePanel.tsx:149`
- **What:** `const flatItems = [...grouped.flatMap((g) => g.items), ...uniqueProjected.map((e) => e.block)]` runs every render. The reference is read in keyboard-nav and effect deps, which makes the effect re-run on every parent render even when membership hasn't changed.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Medium — re-renders + effect runs on a hot path (the agenda surface).
- **Recommendation:** `useMemo(() => [...], [grouped, uniqueProjected])`.
- **Source:** FE review 2026-05-02 / F059
- **Status:** Open

### FE-H-20 — `SearchPanel` and `TagFilterPanel`: parent-IDs array recomputed every render → redundant `batchResolve`
- **Domain:** Frontend / Performance / Search
- **Location:** `src/components/SearchPanel.tsx:136-154`, `src/components/TagFilterPanel.tsx:135-150`
- **What:** Both compute `const parentIds = results.map((b) => b.page_id).filter(...)` on every render and use it as an effect dep, firing `batchResolve` more often than needed.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Medium — extra IPC calls on every search keystroke / filter change.
- **Recommendation:** `useMemo(() => results.map(...).filter(...), [results])`.
- **Source:** FE review 2026-05-02 / F060 + F061
- **Status:** Open

### FE-H-21 — `Resolve` store `pendingVersionBump` debouncing relies on closure variable across `set()` calls
- **Domain:** Frontend / Resolve store
- **Location:** `src/stores/resolve.ts:118-130, 220-235`
- **What:** A module-level `let pendingVersionBump = false` is checked + flipped + scheduled-via-microtask. Multiple rapid `set()` calls (sync batch updates, undo bursts) can interleave: the microtask runs after only some of the pending mutations have been committed, leading to renders that observe a fresh `version` while the cache is mid-update.
- **Cost:** S.
- **Risk:** Medium — the debouncing is load-bearing for re-render economics; changing it incorrectly causes subscriber storms.
- **Impact:** Medium — subtle but real cache/version desync window.
- **Recommendation:** Bump `version` inside the same `set()` callback that mutates the cache, or move the flag into the Zustand state itself so it's serialized with the rest of the state.
- **Source:** FE review 2026-05-02 / F001
- **Status:** Open

### FE-H-22 — Resolve / page-blocks empty-string `spaceId` fallback is documented but ambiguous
- **Domain:** Frontend / Spaces
- **Location:** `src/stores/resolve.ts:140-150`, `src/stores/page-blocks.ts:170-180`
- **What:** `useSpaceStore.getState().currentSpaceId ?? ''` is passed to `listBlocks` to force a no-match SQL filter during pre-bootstrap. The pattern relies on the backend treating `''` as no-match — there is no programmatic guarantee. A backend change that interprets `''` as wildcard would silently leak data across the no-bootstrap window. **Especially worth tightening because FEAT-3p9 is in flight and the cross-space barrier is the most important invariant.**
- **Cost:** S — gate the call behind `if (!currentSpaceId) return` and skip the fetch, OR use a typed sentinel that the backend asserts on.
- **Risk:** Low.
- **Impact:** High — defensive correctness for the cross-space invariant.
- **Source:** FE review 2026-05-02 / F002
- **Status:** Open

### FE-M-1 — `useDuePanelData`: bare catch blocks in overdue/upcoming fetches drop logger
- **Domain:** Frontend / Due panel
- **Location:** `src/hooks/useDuePanelData.ts:200-302` (sites at lines 229, 293)
- **What:** Two of four catch blocks in this hook don't log; main + projected do. Inconsistent.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Recommendation:** Add `logger.warn` to both, matching the surrounding pattern.
- **Source:** FE review 2026-05-02 / F038
- **Status:** Open

### FE-M-2 — `useDuePanelData`: nested `resolveAndMergeTitles().catch` runs after unmount
- **Domain:** Frontend / Due panel
- **Location:** `src/hooks/useDuePanelData.ts:437-453`
- **What:** Inner `.catch` should `if (stale) return` before logging/toasting.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F039
- **Status:** Open

### FE-M-3 — `useBlockTreeEventListeners` deps include unstable `rovingEditor.editor`
- **Domain:** Frontend / Hooks
- **Location:** `src/hooks/useBlockTreeEventListeners.ts:131-137`
- **What:** Effect re-registers listeners every render. `rovingEditorRef` already exists (lines 62–63) and is used by other effects in the same hook (140–161); use it here too.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Medium — listener thrash on a hot path.
- **Source:** FE review 2026-05-02 / F040
- **Status:** Open

### FE-M-4 — `useHistoryDiffToggle`: `diffCache` in deps causes callback churn
- **Domain:** Frontend / History
- **Location:** `src/hooks/useHistoryDiffToggle.ts:49-52`
- **What:** `diffCache` is only read; including it in the callback's deps recreates the callback on every cache mutation.
- **Cost:** Trivial — drop `diffCache` from the deps array.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F041
- **Status:** Open

### FE-M-5 — `useListMultiSelect.toggleSelection`: `items` in deps causes hot churn
- **Domain:** Frontend / Hooks
- **Location:** `src/hooks/useListMultiSelect.ts:59-74`
- **What:** Memoized children that consume `toggleSelection` re-render whenever `items` changes (which can be every paginated load).
- **Cost:** Trivial — read `items` via a ref like the hook already does for `selected` (lines 51–52).
- **Risk:** Low.
- **Impact:** Medium.
- **Source:** FE review 2026-05-02 / F045
- **Status:** Open

### FE-M-6 — `useBlockSlashCommands` attach handler: incomplete error handling around `<input>.click()`
- **Domain:** Frontend / Editor
- **Location:** `src/hooks/useBlockSlashCommands.ts:368-396`
- **What:** Three small gaps: `input.click()` (line 395) not wrapped, the `onchange` callback's exit-without-file path is silent, and the `addAttachment` chain has no `void` marker.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Recommendation:** try/catch around `input.click()`; `void` the fire-and-forget `addAttachment(...)`.
- **Source:** FE review 2026-05-02 / F032
- **Status:** Open

### FE-M-7 — `useBlockDatePicker`: ref-capture pattern needs invariant doc
- **Domain:** Frontend / Hooks
- **Location:** `src/hooks/useBlockDatePicker.ts:189-200`
- **What:** `rovingEditor` and `t` are read via refs that aren't in the deps array, with a `biome-ignore`. Pattern works today but is easy to break — the existing comment explains the *intent* but not the *invariant* (rovingEditor stable across the lifetime of the BlockTree mount).
- **Cost:** Trivial — strengthen the comment to call out the invariant explicitly.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F029
- **Status:** Open

### FE-M-8 — Property pickers: IPC failures are log-only or use `String(error)`
- **Domain:** Frontend / Properties
- **Location:** `src/components/PropertyValuePicker.tsx:42-49`, `src/components/PropertyDefinitionsList.tsx:64-77`
- **What:** PropertyValuePicker silently empties the dropdown on backend error. PropertyDefinitionsList toasts `String(error)` which produces `[object Object]` for non-Error values.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Recommendation:** Replace inline error formatting with the existing `reportIpcError(...)` helper from `src/lib/report-ipc-error.ts`.
- **Source:** FE review 2026-05-02 / F054 + F058
- **Status:** Open

### FE-M-9 — `AgendaResults`: groups built from `sortedBlocks` only when `groupBy === 'page'`
- **Domain:** Frontend / Agenda
- **Location:** `src/components/AgendaResults.tsx:168-174`
- **What:** Other `groupBy` values use unsorted `blocks`. The internal `groupByDate`/`groupByPriority`/`groupByState` helpers re-sort, making the work duplicate.
- **Cost:** Trivial — sort once at the top, pass `sortedBlocks` to all branches.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F063
- **Status:** Open

### FE-M-10 — `keyboard-config/tiptap.ts`: split delimiter mismatch (`'+'` vs `' + '`)
- **Domain:** Frontend / Keyboard config
- **Location:** `src/lib/keyboard-config/tiptap.ts:10-15`
- **What:** `configKey.split('+')` while the canonical format produced by `match.ts` and stored in `catalog.ts` is `' + '` (with spaces). Works today because everything goes through `match.ts`; breaks the moment someone passes a string like `'Ctrl+E'`.
- **Cost:** Trivial — `configKey.split(' + ')`.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F023
- **Status:** Open

### FE-M-11 — `tree-utils.getProjection`: `splice(activeIndex, ...)` not bounds-checked
- **Domain:** Frontend / Tree utilities
- **Location:** `src/lib/tree-utils.ts:135-175`
- **What:** Early-return guard at line 140-142 protects the splice today, but the indirection between guard and use makes future edits risky. `findIndex` returning `-1` and reaching `splice(-1, 1)` would silently remove the last item.
- **Cost:** Trivial — add `if (activeIndex < 0 || overIndex < 0) return earlyResult` at function entry.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F017
- **Status:** Open

### FE-M-12 — `export-graph.ts`: per-page failure rejects the whole export
- **Domain:** Frontend / Export
- **Location:** `src/lib/export-graph.ts:18-31`
- **What:** Loop calls `exportPageMarkdown(page.id)` without try/catch. One failure rejects the whole export.
- **Cost:** Trivial — wrap in try/catch, log per-page failures, continue.
- **Risk:** Low.
- **Impact:** Medium — partial export is much more useful than no export.
- **Source:** FE review 2026-05-02 / F018
- **Status:** Open

### FE-M-13 — `editor/extensions/block-link.ts` & `block-ref.ts`: hardcoded English titles for broken links
- **Domain:** Frontend / Editor
- **Location:** `src/editor/extensions/block-link.ts:98-105`, `src/editor/extensions/block-ref.ts:98-105`
- **What:** `'Broken link — click to remove'` and `'Broken ref — target block deleted'` hardcoded; should use `t()` per AGENTS.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Recommendation:** `t('editor.brokenLink')` / `t('editor.brokenBlockRef')`.
- **Source:** FE review 2026-05-02 / F012
- **Status:** Open

### FE-M-14 — `priority-levels.ts`: listener notification non-transactional, partial failures swallowed
- **Domain:** Frontend / Priority levels
- **Location:** `src/lib/priority-levels.ts:63-81`
- **What:** Listener throw is logged but state has already mutated. Best-effort, but the comment doesn't say so.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Recommendation:** Document explicitly, or wrap in try/catch and roll back module state on the first throw.
- **Source:** FE review 2026-05-02 / F015
- **Status:** Open

### FE-M-15 — Picker extensions capture `insertPos` before async resolution
- **Domain:** Frontend / Editor
- **Location:** `src/editor/extensions/block-link-picker.ts:59-102`, `src/editor/extensions/block-ref-picker.ts:58-95`, `src/editor/extensions/at-tag-picker.ts:49-87`
- **What:** `insertPos` is captured pre-deletion; user can edit between then and async resolution; `insertContentAt(insertPos, ...)` then targets a stale offset.
- **Cost:** S.
- **Risk:** Low.
- **Impact:** Low — race window is narrow.
- **Recommendation:** Wrap `insertContentAt(insertPos, ...)` in try/catch with `logger.warn`. Better: validate the position against the current doc state before inserting.
- **Source:** FE review 2026-05-02 / F011
- **Status:** Open

### FE-L-1 — `Undo` store: `new Map(state.pages)` boilerplate repeated 9 times
- **Domain:** Frontend / Undo store
- **Location:** `src/stores/undo.ts:127, 145, 191, 216, 289, 332, 358, 366`
- **What:** Nine sites copy `new Map(state.pages)` then `.set()` then setState. Boilerplate is simple, not error-prone, but extracting a `setPageState(pageId, updates)` helper would cut ~40 lines.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F003
- **Status:** Open

### FE-L-2 — `Resolve` store cache eviction relies on Map insertion-order semantics with no comment
- **Domain:** Frontend / Resolve store
- **Location:** `src/stores/resolve.ts:204-211, 246-253`
- **What:** Map insertion order is spec-guaranteed; the lack of comment is the only real cost. Add one or extract a helper.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F004
- **Status:** Open

### FE-L-3 — `page-blocks` registry race comment could be defensive
- **Domain:** Frontend / Page blocks store
- **Location:** `src/stores/page-blocks.ts:535-541`
- **What:** Race is theoretical — React's commit ordering prevents it. Defensive guard `if (registry.get(pageId) === store) registry.delete(pageId)` is a 2-line cheap insurance.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F005
- **Status:** Open

### FE-L-4 — `Tabs` store `nextTabId` module-scoped counter
- **Domain:** Frontend / Tabs store
- **Location:** `src/stores/tabs.ts:40-50`
- **What:** Single-threaded browser is the documented architecture; no actual bug. Either move into Zustand state or add a one-line comment.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F006
- **Status:** Open

### FE-L-5 — `Undo` store batch-undo silent fallback (no UX surface)
- **Domain:** Frontend / Undo store
- **Location:** `src/stores/undo.ts:280-290`
- **What:** Graceful degradation, intentional. No UX surface when batch-history fetch fails.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Recommendation:** Optional: toast `'Batch undo unavailable; undid one op.'`.
- **Source:** FE review 2026-05-02 / F009
- **Status:** Open

### FE-L-6 — `Journal` store `parseISODate` accepts wrap-around invalid dates
- **Domain:** Frontend / Journal store
- **Location:** `src/stores/journal.ts:80-88`
- **What:** `new Date(year, month-1, day)` wraps `2026-13-45` to `2027-02-14`; `Number.isNaN(date.getTime())` doesn't catch this. The journal page is never the user's typed input today, so the wrap is harmless in practice.
- **Cost:** Trivial — validate components before constructing the Date.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F008
- **Status:** Open

### FE-L-7 — `markdown-parse.ts`: silent depth-limit truncation
- **Domain:** Frontend / Editor
- **Location:** `src/editor/markdown-parse.ts:465-480`
- **What:** Depth limit is intentional. One-line `logger.debug` would help diagnose pathological pastes.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F013
- **Status:** Open

### FE-L-8 — `useBatchAttachments` / `useBatchAttachmentCounts`: `stableKey` + `biome-ignore` is fragile but documented
- **Domain:** Frontend / Hooks
- **Location:** `src/hooks/useBatchAttachmentCounts.tsx:35-45`, `src/hooks/useBatchAttachments.tsx:55-65`
- **What:** Pattern is correct. Splitting `stableKey` into its own `useMemo([blockIds])` removes the need for the `biome-ignore`.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F031
- **Status:** Open

### FE-L-9 — `useBlockNavigateToLink` ref-indirection contract not documented at the consumer side
- **Domain:** Frontend / Hooks
- **Location:** `src/hooks/useBlockNavigateToLink.ts:55-122`
- **What:** Caller must always read `.current` at call time, never cache. Consider a stable wrapper that does the deref internally.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F033
- **Status:** Open

### FE-L-10 — `useScrollRestore`: redundant optional chaining
- **Domain:** Frontend / Hooks
- **Location:** `src/hooks/useScrollRestore.ts:24-30`
- **What:** `container?.scrollTop` after `if (!container) return` is dead defensiveness.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F048
- **Status:** Open

### FE-L-11 — `useWeekStart` synthetic StorageEvent missing fields
- **Domain:** Frontend / Hooks
- **Location:** `src/hooks/useWeekStart.ts:38-45`
- **What:** Current listener only checks `e.key`; missing `oldValue`/`newValue`/`url` are not consumed today, but a defensive fix is cheap.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F047
- **Status:** Open

### FE-L-12 — `agenda-filters.ts`: `spaceId ?? ''` applied inconsistently
- **Domain:** Frontend / Agenda
- **Location:** `src/lib/agenda-filters.ts:180-340`
- **What:** Some functions normalize at call site, some don't. Centralize at the `executeAgendaFilters` boundary.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F021
- **Status:** Open

### FE-L-13 — `UnlinkedReferences`: in-place push inside `setState` callback
- **Domain:** Frontend / References
- **Location:** `src/components/UnlinkedReferences.tsx:85-105`
- **What:** Works (React commits the new array reference) but stylistically off. Use spread.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F065
- **Status:** Open

### FE-L-14 — `FilterPillRow`: `key={index}` on filter list
- **Domain:** Frontend / Filters
- **Location:** `src/components/FilterPillRow.tsx:100-115`
- **What:** Documented why (`getFilterKey` collisions). Real fix is a stable per-filter UUID; tactical fix is the index workaround that's already there.
- **Cost:** S — depends on filter struct refactor.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F068
- **Status:** Open
