# Review Later

> **Last updated:** 2026-05-03 (Session 647 — Batch MIX-4: closed TEST-FE-1 dangerous subset (bare 50ms waits before negative assertions in 4 hot frontend test files); 1 item via 1 subagent — L-17 dropped due to stalled subagent, deferred to future batch)

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

22 open items in the summary table; 26 detail entries (FE-* sub-tables don't appear in the summary).

| ID | Section | Title | Cost | Blocked on |
|----|---------|-------|------|-----------|
| FEAT-3p9 | FEAT | Spaces Phase 9: per-space external integrations — foundation (per-space `gcal_space_config` table + per-space keychain key + legacy single-space migration) in place; remaining work threads `space_id` through oauth/lease/connector/commands, branches the push loop by space, ships per-space Settings accordion, and (when FEAT-11 lands) prefixes OS notifications with the space name | M | — (M3 sub-task blocked on FEAT-11) |
| FEAT-5g | FEAT | GCal: Android OAuth + background connector (DEFERRED — design sketch only) | L | Design review |
| FEAT-11 | FEAT | Adopt `tauri-plugin-notification` — OS notifications for due tasks / scheduled events (Org-mode parity, especially on mobile) | L | — |
| MAINT-111 | MAINT | Migrate MCP server JSON-RPC framing onto `rmcp` 1.6 (reference impl behind `mcp_rmcp_spike` feature flag; 3 milestones, 12-14h end-to-end) | L | — |
| MAINT-113 | MAINT | `ActiveBlockId` newtype to lift invariant #9 into the type system — 275 `is_conflict = 0` SQL occurrences across 52 files. **M1 + M1.5 + M2 LANDED (2026-05-02):** `ActiveBlockId` newtype + `verify_active` gate (M1). `ActiveBlockRow` + `ActiveProjectedAgendaEntry` parallel structs; `fts::search_fts`, `search_blocks_inner` + Tauri wrapper, `list_projected_agenda_inner` + on-the-fly + Tauri wrapper retyped (M1.5). `BacklinkQueryResponse.items` + `BacklinkGroup.blocks`, `eval_backlink_query` + `eval_backlink_query_grouped` + `eval_unlinked_references` (boundary-cast pattern), `eval_tag_query` (sqlx::FromRow over ActiveBlockRow), `pagination::list_backlinks` (sqlx column-cast `id as "id: ActiveBlockId"`), `get_backlinks_inner` + Tauri wrapper, `query_by_tags_inner` + Tauri wrapper retyped (M2). **DEFERRED to M3:** `list_children` retype + the rest of `list_blocks_inner`'s active fan-out — blocked by the polymorphic dispatcher in `commands::blocks::queries::list_blocks_inner` that routes `list_children` / `list_by_type` / `list_by_tag` / `list_agenda*` (active) AND `list_trash` (deleted blocks) into one return type. M3 must decide between (a) split `list_trash` into a dedicated Tauri command (clean, breaks IPC backward-compat slightly) or (b) narrow at the call site via `From<ActiveBlockRow>` downcasts (preserves IPC, defeats type safety at the dispatcher boundary). The `commands/properties.rs` `set_*_inner` helpers (9 functions taking `block_id: String` and returning `BlockRow`) are also M3 candidates — their inputs need `verify_active` at the IPC boundary, their outputs can become `ActiveBlockRow`. | L | M3 dispatcher refactor + decision (split-IPC vs. narrow-at-callsite) |
| MAINT-128 | MAINT | God-component decomposition: `PropertyRowEditor.tsx` (550L) — split each typed editor (text/number/date/ref/select) into its own component AND lift the shared state (`localValue`, date hook, select-options, ref-picker, 10+ callbacks) UP into a containing hook. **SCHEDULED** — owner-prioritized; refactor path locked in. Removes the only `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` in the codebase (at L85). | L | — |
| MAINT-168 | MAINT | Sync trigger / scheduler dual-backoff unification — `useSyncTrigger.ts` (60s → 600s) and `sync_scheduler.rs` (1s → 60s) run independent exponential backoffs that never coordinate. Not a correctness bug; the backend is the authoritative scheduler and silently rejects redundant `startSync` calls. Filed as a documented design note after this session's bird's-eye review. | M | — |
| MAINT-172 | MAINT | Pagination/queries: space-filter SQL fragment inlined across 13+ files because `sqlx::query_as!` rejects `concat!()`; `space_filter_clause!` macro referenced in comments but unusable. Real maintenance hotspot, sqlx-constrained | M | sqlx upstream |
| MAINT-192 | MAINT | Documentation — AGENTS.md additions to reduce false-positive churn on future reviews: (a) "Frontend Development Guidelines → Mandatory patterns" picker debouncing convention referencing `useDebouncedCallback` + 300 ms (PERF-28 traces directly to this gap); (b) under "Properties system is the primary extension point", a one-line reference to `INTERNAL_PROPERTY_KEYS` in `src/lib/block-utils.ts` (lands together with MAINT-187). | S | User approval for AGENTS.md edits |
| MAINT-193 | MAINT | zizmor baseline triage — 53 GitHub Actions findings suppressed by file:line in `.github/zizmor.yml` when the `zizmor` pre-commit hook was first wired in. Mix of policy-level (`unpinned-uses` × 35: tags vs SHAs) and real fixes (`template-injection` × 6 in `release-tag.yml` — pass `inputs.version` via `env:` instead of `${{ }}` interpolation; `excessive-permissions` × 1 in `release.yml`; `cache-poisoning` × 11; `artipacked` × 7). Triage off the baseline as fixes land. | M | — |
| PERF-19 | PERF | Backlink pagination cursor uses linear scan for non-Created sorts (2 sites) | S | — |
| PERF-20 | PERF | Backlink filter resolver has no concurrency cap on `try_join_all` | S | — |
| PUB-3 | PUB | Employer IP clearance before public release | S | Employer review |
| PUB-5 | PUB | Tauri updater — endpoint URL pinned to `jfolcini/agaric`; remaining work is user-only (generate Minisign keypair, paste pubkey into `tauri.conf.json`, add 2 GH Actions secrets, uncomment env vars in `release.yml`) | S | User-only |
| PUB-8 | PUB | Android release keystore + 4 GH Actions secrets (apksigner wiring already shipped in `release.yml`) | S | User-only |
| TEST-4 | TEST | Sync daemon tests use 18 fixed sleeps (50–800ms) as race-prone "barriers" because no `wait_for_*` helper exists on `SyncDaemon` / `SyncScheduler` | M | — |
| TEST-FE-1 | TEST | Bare `setTimeout` waits in tests — dangerous subset (50ms before `not.toHaveBeenCalledWith` negatives) RESOLVED in session 647 across `BlockTree`, `TagFilterPanel`, `useBlockTreeEventListeners`, `GraphView`; 7 low-priority files remain (`SpaceManageDialog`, `JournalPage`, `useGraphSimulation`, `checkbox-input-rule`, `useGraphWorkerSimulation`, `ErrorBoundary`, `ViewHeader`) | S | — |
| TEST-FE-2 | TEST | Weak `toHaveBeenCalled()` assertions without arg matchers in hot files: `BlockContextMenu` (19), `FormattingToolbar` (16), `useBlockKeyboardHandlers` (10), `GraphView` (8), `BlockPropertyEditor` (7), `HeadingLevelSelector` (7), `useUndoShortcuts` (6), `UnlinkedReferences` (5) — wrong-block / wrong-arg regressions could pass silently | M | — |
| UX-305 | UX | Drag handle on touch has 250 ms long-press requirement, no hint | S | — |
| UX-306 | UX | Touch gutter "More actions" menu doesn't preview hidden actions | S | — |
| UX-313 | UX | Broken-link "click to remove" is hover-only (no touch affordance) | S | — |
| UX-366 | UX | Cross-space `[[link]]` chips render with literal "Broken link" tooltip | S | — |

### Quick wins (S-cost, ready to grab)

These can be tackled in a single session with low risk — listed for prioritization convenience (canonical entries remain in the per-section detail blocks below):

- **MAINT-192** — 2 AGENTS.md additions (picker-debouncing convention; `INTERNAL_PROPERTY_KEYS` reference) — gated on user approval to edit AGENTS.md
- **PUB-5** — Tauri updater wiring (user-only: keypair + 2 secrets + uncomment)
- **PUB-8** — Android release keystore + 4 GH Actions secrets (CI wiring already shipped)

> **`PERF-19` and `PERF-20` are NOT quick-grab items** despite their summary-table presence — read their detail entries: both end with `**Decision:** Defer — keep tracked in REVIEW-LATER as a deliberate non-fix`. They are listed only so the loops aren't reinvented as "fixes" later. Skip them in batch-picking.

> **`PUB-*` statuses are heterogeneous now that the publish target is concrete (`github.com/jfolcini/agaric`).**
> PUB-5 / PUB-8 are ACTIONABLE; PUB-2 / PUB-3 remain DEFERRED on the identity / employer-IP decisions. macOS + Windows code signing are explicitly out of scope: the maintainer opted out of paid Apple Developer Program enrollment ($99/year) and Windows OV/EV certs ($200–400/year) for this OSS project. Bundles ship unsigned with Gatekeeper / SmartScreen first-launch warnings; see `BUILD.md` → "Desktop code signing in CI" for the user-facing install instructions.

---

## FEAT — Planned Feature Improvements

### FEAT-3p9 — Spaces Phase 9: per-space external integrations (GCal, OS notifications)

**Problem:** Two integration surfaces leak across spaces today:

1. **Google Calendar push** uses a single `calendar_id` in `GcalStatus` (`src-tauri/src/commands/gcal.rs:58-68`). The push pipeline (`gcal_push/connector.rs`) pulls agenda items via `list_projected_agenda_inner` (space-aware after FEAT-3p4, but the connector still passes `None` so every space's agenda lands in one calendar) and writes every item from every space into one calendar. A user with the integration on cannot keep their work calendar separate from their personal one.
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

**Fix:** Adopt `@tauri-apps/plugin-notification` + `tauri-plugin-notification`. New backend module `src-tauri/src/notifier/mod.rs` schedules notifications based on `due_date` + `scheduled_date` + property events from the materializer (analogous to `gcal_push::DirtyEvent`). Reuses the existing agenda projection queries (`commands/agenda.rs::list_projected_agenda_inner`) to find blocks within the next-24h window on boot and on every materialize commit. Frontend: a Settings tab toggle + per-property filter. Mobile permissions: request `POST_NOTIFICATIONS` on Android 13+ via the plugin's permission API. Coupled stack — bump with the rest of the Tauri plugins.

**Cost:** L — design (which events fire? how to dedupe? snooze semantics?), backend scheduler (~6 files), one Settings sub-tab, mobile permission flow, ~25 tests.
**Risk:** M — wrong-time notifications and notification spam are both real failure modes; needs careful dedupe and "do not re-fire on materialize replay" guard.
**Impact:** L — closes a recognised feature gap with Org-mode / Logseq parity; especially valuable on mobile where the user is unlikely to have the app foregrounded when a task is due.
**Status:** Open.

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

### MAINT-113 — `ActiveBlockId` newtype to lift invariant #9 into the type system

**What:** AGENTS.md "Key Architectural Invariants" #9 reads:

> Recursive CTEs over `blocks` must filter `is_conflict = 0` in the recursive member, and bound `depth < 100` to prevent runaway recursion on corrupted data. Conflict copies leak into results otherwise.

This invariant is currently enforced by code review + grep + one-line comments. It is baked into **275 `is_conflict = 0` SQL occurrences across 52 source files** (plus 3 more in `0021_block_tag_inherited.sql`) — count refreshed 2026-05-02 from the original 220/70. Every new query touching `blocks` must remember to add it.

**Design:**

```rust
pub struct BlockId(String);        // raw — may refer to a conflict copy or deleted block
pub struct ActiveBlockId(String);  // materialised AND is_conflict = 0 AND deleted_at IS NULL
```

Conversion `BlockId → ActiveBlockId` goes through a single checked gate
(`verify_active(&BlockId) -> Result<ActiveBlockId>`) that runs the
`is_conflict = 0 AND deleted_at IS NULL` predicate exactly once. Recursive
CTEs hidden behind active-filtering helpers keep their `AND is_conflict = 0`
in SQL — the newtype just prevents callers from accidentally feeding a raw
`BlockId` into a path that assumes active.

**M1 + M1.5 + M2 progress (2026-05-02):**

LANDED in M1:
- `ActiveBlockId` newtype in `src-tauri/src/ulid.rs` with full impl set
  (`sqlx::Type` transparent, `serde(transparent)`, `specta::Type`,
  `PartialEq`/`PartialOrd`/`Hash`/`Display`/`AsRef`/`From` conversions).
- `verify_active(pool, &BlockId) -> Result<ActiveBlockId, AppError>`
  gate in the same file.
- 13 unit tests in `src-tauri/src/ulid/tests.rs` (7 type-level + 6
  DB-backed): rejects conflict copies, soft-deleted blocks, non-existent
  ids; conflict-check precedence over deletion-check; lowercase
  normalisation in lookup.
- `PageLink` retyped: `source_id: ActiveBlockId, target_id: ActiveBlockId`.
- `soft_delete::get_descendants` removed — dead code (zero production
  callers); doc reference in `block_descendants.rs` updated.

LANDED in M1.5:
- `ActiveBlockRow` parallel struct in `pagination/mod.rs` (mirror of
  `BlockRow` with `id: ActiveBlockId`) + `From<ActiveBlockRow> for BlockRow`
  + `ActiveBlockRow::from_block_row_unchecked`.
- `ActiveProjectedAgendaEntry` parallel struct (mirror of
  `ProjectedAgendaEntry` with `block: ActiveBlockRow`) + `From` downcast.
- `fts::search_fts` retyped to return `PageResponse<ActiveBlockRow>`.
- `commands::queries::search_blocks_inner` + the `search_blocks` Tauri
  command retyped to return `PageResponse<ActiveBlockRow>`.
- `commands::agenda::list_projected_agenda_inner` +
  `list_projected_agenda_on_the_fly` + the `list_projected_agenda` Tauri
  command retyped to return `PageResponse<ActiveProjectedAgendaEntry>`.
- `RepeatingBlockRow::to_active_block_row()` replaces `to_block_row()`.
- `gcal_push::connector` downcasts entries to `ProjectedAgendaEntry`
  at the boundary because the digest pipeline only consumes row content.
- 5 test sites updated with `.into()` widenings (HashSet/Vec collection
  targets in fts/tests, mcp/tools_ro/tests, cache/tests, agenda_cmd_tests).

LANDED in M2:
- `BacklinkQueryResponse.items` and `BacklinkGroup.blocks` retyped to
  `Vec<ActiveBlockRow>` in `src-tauri/src/backlink/types.rs`.
- `backlink::query::eval_backlink_query` retyped — uses
  `ActiveBlockRow::from_block_row_unchecked` boundary cast over the
  active-pre-filtered `actual_ids` set.
- `backlink::grouped::eval_backlink_query_grouped` and
  `eval_unlinked_references` retyped via the same boundary-cast pattern
  at the per-group block-row construction.
- `tag_query::query::eval_tag_query` retyped to
  `PageResponse<ActiveBlockRow>` — switched from
  `query_as::<_, BlockRow>` to `query_as::<_, ActiveBlockRow>` (sqlx's
  `FromRow` derive handles the typed-id slot via `sqlx::Type`
  transparent over `String`).
- `pagination::list_backlinks` retyped — added the sqlx column-cast
  hint `id as "id: crate::ulid::ActiveBlockId"` in the `query_as!`
  macro. New `.sqlx/` cache entry committed.
- `commands::queries::get_backlinks_inner` + the `get_backlinks` Tauri
  command propagate the typed return.
- `commands::tags::query_by_tags_inner` + the `query_by_tags` Tauri
  command propagate the typed return.
- 3 test sites updated with `.into()` widenings on `String` collection
  targets (`backlink/tests.rs`, `commands/tests/query_cmd_tests.rs`,
  `command_integration_tests/backlink_integration.rs`).
- specta-typescript regen confirms `ActiveBlockRow` is structurally
  compatible with `BlockRow` at the wire level (because
  `ActiveBlockId = string` alias) — frontend `BacklinkQueryResponse`,
  `BacklinkGroup`, and `getBacklinks` / `queryByTags` consumers
  continue to compile without changes.

DESIGN: parallel-types path chosen over `BlockRow<Id = String>` generic
because `specta-typescript` 0.0.11 (a) does not emit Rust generic
defaults (TS sees `BlockRow<Id>` requiring an explicit type arg, breaking
~69 frontend imports) and (b) the `specta::Type` derive macro drops
`Id: Clone` bounds through embedded generic structs (`PLACEHOLDER_Id`
codegen). The parallel struct duplicates 13 fields but is structurally
clean: `ActiveBlockRow` is a strict subset of `BlockRow` (always-safe
`From<ActiveBlockRow> for BlockRow`), and at the wire level both have
`id: string` (TS structural typing accepts each in place of the other).

**DEFERRED to M3:**

- **`list_children` retype + `list_blocks_inner` dispatcher** —
  `commands/blocks/queries.rs:111` fans into `list_children` /
  `list_by_type` / `list_by_tag` / `list_agenda*` (all active) **and**
  `list_trash` (deleted blocks) with a uniform
  `Result<PageResponse<BlockRow>, AppError>` return. Retyping any one
  branch forces the others to align. Two paths forward:
  - (a) `list_blocks_inner` upgrades to return `ActiveBlockRow`, the
    `show_deleted` branch is split off into a separate `list_trash`
    Tauri command (frontend already differentiates `TrashView` vs.
    other listings, so the IPC split is honest). Cost: medium —
    1 new IPC command + bindings + frontend `TrashView.tsx` +
    `ViewDispatcher` polling update + ~5 test sites.
  - (b) Each leaf helper returns its own row type; `list_blocks_inner`
    narrows at the call site via `From<ActiveBlockRow> for BlockRow`
    downcasts. Defeats the type-safety win at the dispatcher boundary
    but minimal churn elsewhere.
  Decision belongs in M3 before any code lands. Document the choice
  in the M3 commit message. AGENTS.md "Architectural Stability"
  applies — the IPC-split path is a non-trivial change.
- **`commands/properties.rs` `set_*_inner` family** — 9 functions take
  `block_id: String` and return `BlockRow`. M3 should add a
  `verify_active` gate at each Tauri command boundary so the inner
  helper takes `&ActiveBlockId` and returns `ActiveBlockRow`. Adds one
  DB roundtrip per call but tightens the type-safety win at the IPC
  boundary (every property write proves the target is active).
- **Cascade/move/delete paths + materializer handlers** — original M3
  scope. After the dispatcher decision lands, the last raw-`BlockId`
  SQL sites can be retyped.

**Cost remaining (M3):** M–L. M3 has the dispatcher architectural
decision plus the property-resolution + cascade/materializer cleanup.
Plausibly 1–2 sessions.

**Risk:** M for the dispatcher refactor (touches the central block IPC
surface). L for the property-resolution helpers (mechanical retype with
verify_active gates).

**Impact:** Six of the highest-traffic active-filtering helper chains
now carry typed IDs at the helper signature (search, agenda projection,
backlinks, grouped backlinks, unlinked references, tag query). The
`From` downcasts make the type system enforce the producer/consumer
asymmetry: any code that calls these and feeds the result back into a
raw `BlockRow` consumer must explicitly opt in via `.into()`, surfacing
the trust transition.

**Milestone plan:**

1. **M1 (DONE 2026-05-02)** — `ActiveBlockId` + `verify_active` + 13
   tests; `PageLink` retyped; `get_descendants` removed.
2. **M1.5 (DONE 2026-05-02)** — `ActiveBlockRow` +
   `ActiveProjectedAgendaEntry` parallel structs; `search_blocks_inner`
   + `list_projected_agenda_inner` + their command wrappers and `fts`
   delegate retyped.
3. **M2 (DONE 2026-05-02)** — `BacklinkQueryResponse` + `BacklinkGroup`
   retyped; `eval_backlink_query` + `eval_backlink_query_grouped` +
   `eval_unlinked_references` + `eval_tag_query` + `list_backlinks` +
   `get_backlinks_inner` + `query_by_tags_inner` retyped.
4. **M3 (M, ~4–8h, possibly 2 sessions)** — Decide
   `list_blocks_inner` dispatcher path (split-off-trash vs.
   narrow-at-callsite) before writing code; migrate `list_children` +
   the rest of `list_blocks_inner`'s active fan-out accordingly.
   Migrate `commands/properties.rs::set_*_inner` family with
   `verify_active` IPC gates. Convert cascade/move/delete paths +
   materializer handlers. Update AGENTS.md invariant #9 to reference
   the newtype instead of the prose rule. Remove this row from
   REVIEW-LATER.

**Per-milestone exit criteria:**

- All `cargo nextest run` + `npx vitest run` pass; existing E2E specs pass.
- No new `unsafe_code` or `biome-ignore`.
- `specta` bindings regenerated; `ts_bindings_up_to_date` test passes.
- Number of `is_conflict = 0` SQL sites strictly decreases at each
  milestone (sites that get hidden behind `ActiveBlockId`-returning
  helpers no longer count) — track in the commit message.

**Decision:** **Scheduled** — M1 + M1.5 + M2 closed 2026-05-02. M3 next, with the dispatcher architectural decision required up-front.

### MAINT-128 — God-component decomposition: `PropertyRowEditor.tsx`

**What:** `PropertyRowEditor.tsx` is 550L and carries an explicit `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` at L92. The file dispatches on `def.value_type` (text/number/date/ref/select → 5 parallel JSX subtrees) but the 5 typed editors share `localValue`, date hook state, select-options state (3 fields), ref-picker state (4 fields), and 10+ callbacks — splitting naïvely re-creates the prop-chain problem that the `biome-ignore` acknowledges.

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
**Impact:** Medium — eliminates a recurring drift hotspot; closes a long-tail correctness foot-gun.
**Decision:** Defer until the cost of drift becomes visible (a real bug shipped because one site got out of sync). Until then, the comment-based "mirror any change" convention is acceptable.
**Status:** Deferred.

> **MAINT-173 through MAINT-192 below were filed from a frontend-wide UX review.**
> Methodology: 7 parallel discovery subagents covering all 438 frontend source files,
> 3 parallel verification subagents reading the cited code to filter hallucinations.
> Items below are the verified survivors. Known false positives are not listed.

### MAINT-192 — AGENTS.md additions to reduce false-positive churn on future frontend reviews
- **Domain:** Documentation
- **Location:** `AGENTS.md`
- **What:** The frontend-wide UX review that filed MAINT-173..MAINT-191 + PERF-28 had a 74% false-positive rate. Two small AGENTS.md additions would pre-empt the recurring pattern-matches:
  - **(a) "Frontend Development Guidelines → Mandatory patterns"** — add **"Picker debouncing"** entry referencing `useDebouncedCallback` + the 300 ms convention used by `TagFilterPanel`. PERF-28 traces directly to this gap.
  - **(b)** Under "Properties system is the primary extension point", add a one-line reference to `INTERNAL_PROPERTY_KEYS` in `src/lib/block-utils.ts` (lands together with MAINT-187).
- **Cost:** Trivial — two doc inserts.
- **Risk:** Low.
- **Impact:** Medium — every future frontend review (human or automated) avoids re-discovering the same false positives.
- **Status:** Open. Gated on AGENTS.md self-rule "No changes to this file (AGENTS.md) without explicit user approval. Ever." Awaiting user approval.

### MAINT-193 — `zizmor` baseline triage (53 GitHub Actions findings suppressed at hook-introduction time)

- **Domain:** GitHub Actions security
- **Location:** `.github/zizmor.yml`, `.github/workflows/{ci,release,release-tag,_validate}.yml`
- **What:** When the `zizmor` pre-commit hook was first wired into `prek.toml`, the audit reported 53 deduped findings across 5 rules. To avoid blocking every commit until they were all fixed, the findings were captured as a file:line baseline in `.github/zizmor.yml` so the hook only fires on **new** findings going forward. The baseline is a known-debt list, not a clean bill of health. Breakdown:
  - **`unpinned-uses` × 35** (High) — every `actions/checkout@v5`, `dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2`, `actions/setup-node@v5`, etc. is pinned to a tag/branch instead of a SHA. This is a policy decision; many projects intentionally pin to tags. If we want SHA pinning, automate it via Renovate or Dependabot (it's mechanical).
  - **`template-injection` × 6** (High, all in `release-tag.yml`) — `scripts/bump-version.sh "${{ github.event.inputs.version }}"` and `echo "::notice title=Tagged ${{ github.event.inputs.version }}::..."` interpolate `inputs.version` directly into shell. Mitigation is small and idiomatic: `env: VERSION: ${{ inputs.version }}` then `"$VERSION"`. Threat-model context (per `AGENTS.md`): `workflow_dispatch` is collaborator-only, but the fix is cheap and worth doing.
  - **`cache-poisoning` × 11** (High, mostly tag-pushes building artifacts with `actions/cache` enabled). Either disable caching for tag builds or accept the risk and document.
  - **`artipacked` × 7** (Medium, Low confidence) — `actions/checkout` without `persist-credentials: false`. Auto-fixable via zizmor; one-liner per checkout.
  - **`excessive-permissions` × 1** (High, in `release.yml`) — workflow-level token grants more than the steps actually need. Audit and tighten.
- **Cost:** S–M. The `template-injection` cluster is ~6 lines of YAML across `release-tag.yml`. The `artipacked` cluster is mechanical (auto-fix). `unpinned-uses` is a policy decision plus a Renovate config. `excessive-permissions` is one workflow header to tighten.
- **Risk:** Low — these are workflow-only changes; existing tests cover them via `_validate.yml`.
- **Impact:** Medium — closes real (if low-likelihood) supply-chain / template-injection vectors, and shrinks the baseline file so the hook gives more genuine signal.
- **Status:** Open. Triage off the baseline as fixes land — when a finding is fixed, drop the matching `file:line` entry from `.github/zizmor.yml`.

## TEST — Backend test improvements

Items in this section are test-quality improvements identified during a thorough backend test review (10 parallel review subagents covering ~80K LOC of test code, 3 verification subagents to filter hallucinations). All items below are verified — known false positives are not listed.

> **Format:** test items use the compact L-style block. None of these are blocking; they are code-quality investments.

### TEST-4 — Sync daemon tests use 21 fixed sleeps as race-prone "barriers"
- **Domain:** Sync / Test infrastructure
- **Location:** `src-tauri/src/sync_daemon/tests.rs` lines 2601, 2607, 2639, 2643, 2702, 2706, 2755, 2770, 2781, 2828, 2847, 2862, 2909, 2919, 3151, 3208, 3281, 3345, 3388, 3395, 3398
- **What:** Tests use `tokio::time::sleep(Duration::from_millis(50..800))` to wait for daemon state changes. Unlike the materializer (which exposes `flush_background()`, `wait_for_initial_block_count_cache()`, `wait_for_pending_block_count_refreshes()`), the sync daemon and `SyncScheduler` have no equivalent sync-barrier helper, so tests sleep and hope.
- **Why it matters:** Real flake risk on loaded CI. The 800ms sleeps in particular are pessimistic guesses that could still be too short under load.
- **Cost:** M — design + implement a `wait_for_state(scheduler, predicate)` polling helper or expose `Notify`-based barriers on `SyncDaemon`.
- **Risk:** Low — additive helper.
- **Impact:** Medium — eliminates a category of CI flakes.
- **Recommendation:** Pattern after the materializer's `flush_background()` API. A polling helper `async fn wait_for(predicate: impl Fn() -> bool, timeout: Duration)` would suffice for most sites.
- **Status:** Open.

### TEST-FE-1 — Bare `setTimeout` waits in tests (low-priority remaining sweep)
- **Domain:** Frontend test infrastructure
- **Location (remaining low-priority files, the dangerous-subset is fixed):**
  - `src/components/__tests__/SpaceManageDialog.test.tsx:575, 590, 609, 639` (4)
  - `src/components/__tests__/JournalPage.test.tsx:2826, 2848, 2875` (3)
  - `src/hooks/__tests__/useGraphSimulation.test.ts:349, 368` (2)
  - `src/editor/extensions/__tests__/checkbox-input-rule.test.ts:192, 193` (2)
  - `src/hooks/__tests__/useGraphWorkerSimulation.test.ts:174` (1)
  - `src/components/__tests__/ErrorBoundary.test.tsx:138` (1)
  - `src/components/__tests__/ViewHeader.test.tsx:143` (1)
- **What:** `src/__tests__/AGENTS.md` lines 187, 254, 261 forbid `await sleep(n)` patterns in tests. The **dangerous subset** — bare 50ms waits as the only wait before `not.toHaveBeenCalledWith` negative assertions — was resolved in session 647 across the four hot files (`BlockTree.test.tsx`, `TagFilterPanel.test.tsx`, `useBlockTreeEventListeners.test.ts`, `GraphView.test.tsx`). What remains is the less-dangerous tail: bare timeouts in 7 files that are not before negative assertions and don't carry the same silent-pass risk. They're code-quality cleanup, not flake risk.
- **Cost:** S — pattern is the same as the dangerous-subset fix (use `waitFor` over an observable signal, or `vi.useFakeTimers()` for debounce). ~7 files left to sweep.
- **Risk:** Low.
- **Impact:** Low — the high-impact subset is already fixed; this is residual cleanup.
- **Status:** Open (downgraded from Medium to Low impact).

### TEST-FE-2 — Weak `toHaveBeenCalled()` assertions in hot files
- **Domain:** Frontend test infrastructure
- **Location:**
  - `src/components/__tests__/BlockContextMenu.test.tsx` (19 occurrences total — but this file is **NOT** the canonical violator: action handlers DO use `toHaveBeenCalledWith('BLOCK_01')` at lines 114, 124, 134, 144, 154, 164, 174, 184, 194; the 9 bare `toHaveBeenCalled()` calls are on `props.onClose`, which legitimately takes no arguments)
  - `src/components/__tests__/FormattingToolbar.test.tsx` (16)
  - `src/hooks/__tests__/useBlockKeyboardHandlers.test.ts` (10) — likely candidate for genuine violations
  - `src/components/__tests__/GraphView.test.tsx` (8)
  - `src/components/__tests__/BlockPropertyEditor.test.tsx` (7) — likely candidate for genuine violations
  - `src/components/__tests__/HeadingLevelSelector.test.tsx` (7)
  - `src/hooks/__tests__/useUndoShortcuts.test.ts` (6)
  - `src/components/__tests__/UnlinkedReferences.test.tsx` (5)
  - 175 total occurrences across 61 files (many legitimate "did fire at all"; high-frequency files most likely contain real cases)
- **What:** `src/__tests__/AGENTS.md` line 582: "Meaningful assertions — `toHaveBeenCalledWith` with exact args, not just `toHaveBeenCalled`." Find genuine violators in the higher-count files (`useBlockKeyboardHandlers`, `BlockPropertyEditor`) before tightening.
- **Why it matters:** A documented quality standard. Concentration in hot files (action handlers, keyboard shortcuts) means real correctness regressions could slip through.
- **Cost:** M — audit the listed files (excluding BlockContextMenu, which already complies) and tighten high-value cases to `toHaveBeenCalledWith(expect.objectContaining({...}))`. The remaining ~50 files are a separate pass.
- **Risk:** Low — additive specificity in assertions.
- **Impact:** Medium-high in the action-handler / keyboard-shortcut files.
- **Status:** Open.

## PERF — Performance items

### PERF-19 — Backlink pagination cursor uses linear scan for non-Created sorts (3 sites)

**Problem:** Three backlink pagination paths locate the cursor position with a linear scan when results are sorted by something other than block creation (e.g., due_date, priority, property value):
- `src-tauri/src/backlink/query.rs:178-185` — uses `.position(|s| s.as_str() == after_id)` on `sorted_ids`
- `src-tauri/src/backlink/grouped.rs:215-221` — uses `.skip_while(|(pid, _, _)| pid.as_str() != after_id)` on `group_list`
- `src-tauri/src/backlink/grouped.rs:547-553` — second `skip_while(...)` on the same shape

For `Created` sort, both already use binary search on lexicographic ULID order (correct, O(log n)). The linear-scan fallback is used because property sorts reorder by value, so binary search on ID is invalid — but the fallback is O(n) in the filtered result set.

**Why it matters:** N here is the already-filtered result set (per page), typically ≤50 items. At that size the linear scan is ~50 string comparisons — cheaper than building a HashMap would be. This is documented as a LOW-severity finding and would only matter if page size is ever raised well into the thousands. Listed here so it doesn't get reinvented as a "fix" later when someone sees the loop without context.

**Fix (if ever needed):** maintain a `HashMap<&str, usize>` during the sort step for O(1) cursor lookup. Only worth doing if page size grows past ~500.

**Decision:** Defer — keep tracked in REVIEW-LATER as a deliberate non-fix. Revisit only if page size grows past ~500 or saved-query features ship.

**Cost:** S
**Status:** Deferred.

### PERF-20 — Backlink filter resolver has no concurrency cap on `try_join_all` (3 sites)

**Problem:** Three production call sites fire every top-level filter concurrently via `try_join_all` over `resolve_filter_with_candidates` (the candidate-scoped variant of `resolve_filter`):
- `src-tauri/src/backlink/query.rs:122-123` — top-level
- `src-tauri/src/backlink/grouped.rs:152-153` — grouped variant
- `src-tauri/src/backlink/grouped.rs:480-481` — unlinked variant (uses `Some(&matching_ids)`)

The read pool has 4 connections; if a user ever ends up with a filter expression holding 20+ OR-ed top-level filters, they all enqueue at once.

**Why it's LOW:** sqlx's `SqlitePool` queues gracefully when all connections are busy — it doesn't fail, it just waits. Realistic filter counts from the UI (`BacklinkFilterBuilder`) are 2–4. No known path to generate 20+ concurrent filters from normal usage. Flagging here in case a future "saved query library" or automation feature ever produces pathological inputs.

**Fix (optional, if saved-query features ship):**
```rust
let semaphore = Arc::new(tokio::sync::Semaphore::new(4));
let futures = filter_list.iter().map(|f| {
    let sem = semaphore.clone();
    async move {
        let _permit = sem.acquire().await.ok()?;
        resolve_filter_with_candidates(pool, f, 0, Some(&base_ids)).await
    }
});
let results = try_join_all(futures).await?;
```

Or a simpler cap: reject filter lists longer than some reasonable limit (e.g., 16) at the command boundary.

**Decision:** Defer — keep tracked in REVIEW-LATER as a deliberate non-fix. Revisit only if saved-query / automation features ship that can produce pathological filter counts.

**Cost:** S
**Status:** Deferred.

---


### PUB-3 — Employer IP clearance before public release

**Problem:** Most employment agreements in AR/US/EU include IP-assignment clauses that cover work done on company devices, on company time, or in the employer's line of business. (Note: the corporate-email-in-history concern that PUB-2 originally tracked is no longer present — `git log --all --format='%ae' | sort -u` returns only the personal email — but the underlying IP-clearance question stands independently.) Even for a side project unrelated to the employer's business, publishing substantial software without checking the employment contract carries legal risk that a coding agent cannot assess.

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
4. **Uncomment** the two `TAURI_SIGNING_PRIVATE_KEY*` env lines in `release.yml:138-140` (under the `# PUB-5: Uncomment …` comment). The agent intentionally left these commented because uncommenting before the secrets exist + pubkey is set causes tauri-action to attempt signing with empty inputs.
5. **Tag a release** to verify: tauri-action will produce `*.sig` files alongside each bundle (`.dmg.sig`, `.AppImage.sig`, `.msi.sig`, etc.), which the in-app updater fetches and verifies against the embedded pubkey.

**Alternative (skip the updater):** remove the `updater` block from `tauri.conf.json` and the `tauri-plugin-updater` dependency from `src-tauri/Cargo.toml`. Users would update by manually downloading new releases.

**Cost:** S (~30 min of user work once the keypair is generated).
**Status:** DEFERRED — user-only. Agent action is none.

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

### L-17 — `dispatch_op` enqueues fg+bg out of order
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/dispatch.rs:128-132`
- **What:** `dispatch_op` calls `enqueue_foreground(ApplyOp(record))` then `enqueue_background_tasks(record, None)`. The two queues have independent consumers — the bg consumer can pull e.g. `RebuildTagsCache` and execute it before the fg consumer has applied the `CreateBlock(tag)` to `blocks`. The cache rebuild then reads pre-op state and `tags_cache` stays stale until the next op happens to re-enqueue the rebuild. Production paths use `dispatch_background_or_warn` *after* the command has committed the op, so this race is mostly limited to test code (and `sync_daemon/snapshot_transfer.rs:651`, the `seed_one_block` test helper); it is downgraded from Medium for that reason.
- **Why it matters:** For the test paths (and the snapshot-transfer test helper) it shrinks the window of correctness for the very-first op of its kind. If `dispatch_op` is ever adopted on a production code path it becomes a real correctness hazard ("created a tag, search doesn't find it" until I create another).
- **Cost:** M (2-8h)
- **Risk:** Medium
- **Impact:** Low
- **Recommendation:** Either (a) move the bg fan-out *into* the fg consumer so it runs only after `apply_op_tx` commits — making the consumer the single scheduler of per-op derived work; or (b) thread a `Notify` keyed on `(device_id, seq)` and have the bg side `notified().await` before running the rebuild it spawned. (a) is cleaner.
- **Pass-1 source:** 02/F10
- **Status:** Open


### L-55 — `redact_log` newline split-and-rejoin is O(n²) in the worst case
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/bug_report.rs:772-784` (`redact_log`), `src-tauri/src/commands/bug_report.rs:760-765` (`redact_line`), `src-tauri/src/commands/bug_report.rs:687-721` (`apply_allow_list`)
- **What:** `redact_log` iterates `split_inclusive('\n')`, calls `redact_line` (which first tries `redact_json_line` and falls back to `apply_allow_list`), then pushes back into `out`. `apply_allow_list` does ≥4 sequential `String::replace` calls (home, device_id, gcal_email, then a `for peer in ctx.peer_device_ids` loop) plus an `EMAIL_REGEX.replace_all` pass — each a linear scan with allocation. For a 2 MB file this is many full-buffer linear scans per line, multiplied by the line count. `MAX_LINE_BYTES` truncation via `cap_line_length` runs *after* the replace, so the replace itself sees the original full-length line.
- **Why it matters:** A bug report on a workstation with thousands of large stack-trace lines could take seconds. Mitigated by the 2 MB file cap.
- **Cost:** M — switch to a single-pass replacer (e.g. `aho_corasick` or a hand-written matcher over the static needles).
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Acceptable as-is until profiling shows it is a bottleneck; lower priority than M-31 / L-41. If/when fixed, a single-pass `replace_n` over both needles avoids allocations.
- **Pass-1 source:** 05/F35
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

## UX — User-experience / usability / discoverability

Items in this section come from a feature-map sweep (one analysis subagent per feature area, then 3 validation subagents that re-read each cited file:line and dropped exaggerations and stale claims). Format follows the compact TEST / FE-L convention. None of these are blocking; they are surface-level fixes (no schema, no op-types, no store changes) that improve discoverability, accessibility, or in-UI feedback.

### UX-305 — Drag handle on touch has 250 ms long-press requirement, no hint
- **Domain:** Frontend / Editor
- **Location:** `src/components/BlockGutterControls.tsx:111-121` ; `src/hooks/useBlockDnD.ts:106` (`PointerSensor delay: 250`)
- **What:** Touch drag requires long-press; the handle has `aria-label` but no on-touch tooltip / hint indicating the press-and-hold requirement.
- **Cost:** Trivial — add a one-time hint or a `:active`-pulsing animation on first touch interaction.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-306 — Touch gutter "More actions" menu doesn't preview hidden actions
- **Domain:** Frontend / Editor
- **Location:** `src/components/BlockGutterControls.tsx:124-182`
- **What:** On coarse pointer, history + delete collapse into a `MoreVertical` button with `aria-label` but no tooltip listing what's inside.
- **Cost:** Trivial — extend the button's `aria-label` to enumerate ("History, Delete") or add a touch-friendly `Popover` preview.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-313 — Broken-link "click to remove" is hover-only (no touch affordance)
- **Domain:** Frontend / Editor
- **Location:** `src/editor/extensions/block-link.ts:99-110`
- **What:** Tooltip "Broken link — click to remove" only appears on hover. Touch users see a non-functional-looking chip with no removal cue.
- **Cost:** S — touch overlay × button, or a confirm step on the click handler with explanatory toast.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-366 — Cross-space `[[link]]` chips render with literal "Broken link" tooltip
- **Domain:** Frontend / Spaces
- **Location:** `src/editor/extensions/block-link.ts:99-110` (deliberate per FEAT-3p7, but UX-confusing)
- **What:** A user who knows the page exists in another space sees their link presented as deleted. Same visual + wording as a true broken link.
- **Cost:** S — distinct visual (dashed border + lock icon) and tooltip "Link is in another space — click to remove".
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

---

## Ready-made batches (planning aid for next sessions)

Pre-grouped item clusters identified during the 2-pass audit. Each batch is sized for one PROMPT.md session — 5 trivial-cost items in non-overlapping files, splittable across 5 parallel subagents. **Remove the batch entry from this list when its items are resolved.**

_None currently pre-staged — all batches identified during the 2-pass audit have been consumed. Pick the next session's items ad-hoc from the summary table or re-audit if a fresh sweep is wanted._
