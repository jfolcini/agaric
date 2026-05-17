# Review Later

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

21 open items in the summary table; 21 detail entries (FE-* sub-tables don't appear in the summary).

| ID | Section | Title | Cost | Blocked on |
|----|---------|-------|------|-----------|
| FEAT-3p9 | FEAT | Spaces Phase 9: per-space external integrations — foundation (per-space `gcal_space_config` table + per-space keychain key + legacy single-space migration) in place; remaining work threads `space_id` through oauth/lease/connector/commands, branches the push loop by space, ships per-space Settings accordion, and (when FEAT-11 lands) prefixes OS notifications with the space name | M | — (M3 sub-task blocked on FEAT-11) |
| PEND-38 | FEAT | Import progress streaming over `Channel<T>` (PEND-06 Tier 3) — DEFERRED. Needs the import pipeline restructured before per-block progress channel has UX value (today `import_markdown` parses + applies the whole file in one tx, so the only progress signal is start / done). Pursue when imports become a UX paper-cut OR someone is already touching `import_markdown` for an unrelated reason. | L restructure + S emission | Import pipeline restructure |
| AGENDA-SQL | PERF | Agenda sort/group SQL pushdown — DEFERRED. Move `sortAgendaBlocks` + `groupBy*` from `src/lib/agenda-sort.ts` (sort sites at lines 30, 108, 175, 230, 242, 265, 325, 331, 339, 354) into a backend `ORDER BY (effective_date, state_rank, priority_rank)`. The current JS sort is sub-ms on the ≤200-item per-page set, so the SQL pushdown is a maintainability / consistency win, not a perf win. Cost driven by the compound-cursor reshape this requires (paginate-by-multi-column is non-trivial). Filed as a tombstone so a future contributor doesn't re-derive the blocker. Original sql-audit H4 item, separated from the audit doc when the audit was retired. | M | Decision to invest in compound-cursor reshape |
| SQL-M-8 | PERF | Snapshot restore streaming — DEFERRED until Android profiling justifies. `snapshot/restore.rs:76-88` materialises the full parsed `SnapshotData` in RAM. The docstring claims memory is bounded, but the *parsed struct* (not the compressed bytes nor decompressed CBOR stream) is fully in-memory. At 100K ops a SnapshotData can peak at 50-80 MB. On desktop, fine. On Android (24 MB heap), a real OOM risk. Fix: stream-decode CBOR per-table into batch INSERTs against the open tx. Last open task from `sql-review-2026-05-14.md` (all other Phases 1-5 items shipped in sessions 740-745). | L | Android profiling showing the OOM is real |
| FEAT-5g | FEAT | GCal: Android OAuth + background connector (DEFERRED — design sketch only) | L | Design review |
| FEAT-11 | FEAT | Adopt `tauri-plugin-notification` — OS notifications for due tasks / scheduled events (Org-mode parity, especially on mobile) | L | — |
| MAINT-111 | MAINT | Migrate MCP server JSON-RPC framing onto `rmcp` 1.6. **M1 LANDED** — `RmcpReadOnlyAdapter` advertises every RO tool, parity test pins byte-for-byte equivalence with the hand-rolled `handle_tools_list`. M2 (route `tools/call` through rmcp, ~6h) + M3 (drop hand-rolled framing, ~3h) remain, both behind the `mcp_rmcp_spike` feature flag. | M-L | — |
| MAINT-113 | MAINT | `ActiveBlockId` newtype to lift invariant #9 into the type system — 275 `is_conflict = 0` SQL occurrences across 52 files. **M1 + M1.5 + M2 LANDED (2026-05-02):** `ActiveBlockId` newtype + `verify_active` gate (M1). `ActiveBlockRow` + `ActiveProjectedAgendaEntry` parallel structs; `fts::search_fts`, `search_blocks_inner` + Tauri wrapper, `list_projected_agenda_inner` + on-the-fly + Tauri wrapper retyped (M1.5). `BacklinkQueryResponse.items` + `BacklinkGroup.blocks`, `eval_backlink_query` + `eval_backlink_query_grouped` + `eval_unlinked_references` (boundary-cast pattern), `eval_tag_query` (sqlx::FromRow over ActiveBlockRow), `pagination::list_backlinks` (sqlx column-cast `id as "id: ActiveBlockId"`), `get_backlinks_inner` + Tauri wrapper, `query_by_tags_inner` + Tauri wrapper retyped (M2). **DEFERRED to M3:** `list_children` retype + the rest of `list_blocks_inner`'s active fan-out — blocked by the polymorphic dispatcher in `commands::blocks::queries::list_blocks_inner` that routes `list_children` / `list_by_type` / `list_by_tag` / `list_agenda*` (active) AND `list_trash` (deleted blocks) into one return type. M3 must decide between (a) split `list_trash` into a dedicated Tauri command (clean, breaks IPC backward-compat slightly) or (b) narrow at the call site via `From<ActiveBlockRow>` downcasts (preserves IPC, defeats type safety at the dispatcher boundary). The `commands/properties.rs` `set_*_inner` helpers (9 functions taking `block_id: String` and returning `BlockRow`) are also M3 candidates — their inputs need `verify_active` at the IPC boundary, their outputs can become `ActiveBlockRow`. | L | M3 dispatcher refactor + decision (split-IPC vs. narrow-at-callsite) |
| MAINT-168 | MAINT | Sync trigger / scheduler dual-backoff unification — `useSyncTrigger.ts` (60s → 600s) and `sync_scheduler.rs` (1s → 60s) run independent exponential backoffs that never coordinate. Not a correctness bug; the backend is the authoritative scheduler and silently rejects redundant `startSync` calls. Filed as a documented design note after this session's bird's-eye review. | M | — |
| MAINT-194 | MAINT | `useBlockKeyboard` listener-attach perf — re-do MAINT-185 correctly (post-revert). Original ref-bag pattern broke listener stale-element invariant; need to memoize callbacks at call site OR add explicit `editor.view.dom.parentElement` watcher. | M | — |
| MAINT-193 | MAINT | zizmor baseline triage — 59 remaining GitHub Actions findings after closing `template-injection` × 6 (MAINT-114), `artipacked` × 6 (added `persist-credentials: false`), `excessive-permissions` × 1 (per-job perms in `release.yml`). Remaining: `unpinned-uses` × 35 (policy decision — SHA pinning via Renovate) + `cache-poisoning` × 24 (design call on tag-build caching). | M | — |
| MAINT-208 | MAINT | PEND-25 M1 deferred — three deferrable `block_on` calls in `src-tauri/src/lib.rs:637, 741, 1083` (link cleanup, space migration, gcal migration) at startup. Per the PEND-25 plan body, only act if Android boot profile shows >100 ms cumulative cost; on desktop the headroom is irrelevant. Profile `adb shell am start -W` with `tracing::info!` instrumentation before refactoring; if confirmed, defer to a post-window-show task. Conditional. | M (4-7h) | Android boot profile data |
| MAINT-209 | MAINT | PEND-25 L15 + L16 deferred — gcal connector channel + agenda fetch hygiene. (L15) `mpsc::UnboundedSender<DirtyEvent>` in `src-tauri/src/gcal_push/connector.rs:255` is unbounded; defensive bounded channel + `try_send` only matters if a fast producer overruns the consumer (no observed instance today). (L16) `connector.rs:486, 589-595` makes per-date agenda fetches in a loop instead of one `list_projected_agenda_inner(min_date, max_date)` call; only matters when the gcal push window grows beyond a handful of days. Both are speculative — only pursue if profiling shows a concrete need. | S-M (~3h together) | Profiling data showing gcal contention |
| PERF-19 | PERF | Backlink pagination cursor uses linear scan for non-Created sorts (2 sites) | S | — |
| PERF-20 | PERF | Backlink filter resolver has no concurrency cap on `try_join_all` | S | — |
| MAINT-227 | MAINT | gcal OAuth — migrate browser-open from `tauri-plugin-shell::open` (deprecated) to `tauri-plugin-opener`. Site: `src-tauri/src/commands/gcal.rs:550-557`, currently behind `#[allow(deprecated)]`. The new plugin lands when we next bump Tauri plugins; the surface is a 1-line callback swap. | S | `tauri-plugin-opener` dep added |
| MAINT-230 | MAINT | `bench_export_page_markdown` panics on `BlockId::from_string` because its fixture id `"SLOEXPORTPAGE000000000001"` (`src-tauri/benches/interactive_slo.rs:965`) is 25 chars but ULIDs are 26. Introduced in commit `a3f8c9e3` (the bench's first landing) and masked until 2026-05-17 by `batch_resolve_100k` panicking earlier in the same `cargo bench --bench interactive_slo` run. With PERF-21 resolved, this is now the new earliest panic in the bench suite. Fix: extend the literal to 26 chars (e.g. add one trailing `0` → `SLOEXPORTPAGE0000000000001`), re-verify the bench runs to completion, confirm the export-page-markdown number is within its 10 ms budget. | S | — |
| OSSF-1 | MAINT | OpenSSF Best Practices badge — register the project at <https://bestpractices.coreinfrastructure.org/> and earn at least the Passing tier. The Scorecard `CII-Best-Practices` check currently scores 0/10 (no badge detected); the form is a self-assessment, takes roughly an hour, and instantly lifts the overall score. Deferred from the 2026-05-16 Scorecard triage because the assessment expects pre-1.0 answers like "How will you handle bug reports?" to be already-final — easier to fill out once the project is stable and the surrounding docs (SECURITY.md, CONTRIBUTING.md) have settled. Revisit at 1.0 cut or when the Scorecard score becomes a release-gating concern. | S (~1h) | — (do at 1.0 or when score becomes load-bearing) |
| OSSF-2 | MAINT | Scorecard `Code-Review` score = 0 because changesets pushed directly to `main` by the solo maintainer count as "0/N approved" — the asymmetric maintainer-bypass ruleset (R12, see `docs/architecture/ci-and-tooling.md` §13) is by design. The score auto-improves the moment any external maintainer lands, because their PRs route through `validate-all` + at least one review. **Revisit trigger:** first external maintainer onboarded → flip the ruleset to symmetric (require review for everyone, drop the maintainer bypass), or accept a permanent 0 here and document the design choice in the public security posture. | S (decision) → M (ruleset flip + bypass test plan) | First external maintainer joining the repo |
| OSSF-3 | MAINT | Scorecard `Vulnerabilities` score = 0 because of 23 RUSTSEC advisories, the bulk of which are atk/gtk3 "no longer maintained" notices (`RUSTSEC-2024-04xx`) reaching us transitively via `wry → tauri`. All are documented in `src-tauri/deny.toml [advisories].ignore` with rationale and the upstream tracking issue. The score will recover automatically when `tauri`/`wry` finish migrating off gtk3 (already in progress upstream — wry's webkit2gtk backend is the only remaining gtk3 user, and the gtk4 work is on their roadmap). **Revisit trigger:** Tauri release notes announce gtk4 migration complete → drop the relevant `deny.toml` ignore entries + re-run Scorecard to confirm the score lifts. Tracking item: <https://github.com/tauri-apps/wry/issues/802>. | S (delete ignore entries + verify) | Upstream wry/tauri gtk4 migration |
| OSSF-4 | MAINT | Scorecard `Maintained` score = 0 because the repository was created within the last 90 days. Time-based check — it auto-recovers once the repo passes the threshold. **Revisit trigger:** if it has not recovered by 2026-08-14 (90 days from repo creation 2026-05-16), investigate whether commit cadence or branch-protection metadata is dragging the score. Until then no action. | trivial (verify only) | 90 days of repo age |

### Quick wins (S-cost, ready to grab)

These can be tackled in a single session with low risk — listed for prioritization convenience (canonical entries remain in the per-section detail blocks below):

- **MAINT-192** — 2 AGENTS.md additions (picker-debouncing convention; `INTERNAL_PROPERTY_KEYS` reference) — gated on user approval to edit AGENTS.md

> **`PERF-19` and `PERF-20` are NOT quick-grab items** despite their summary-table presence — read their detail entries: both end with `**Decision:** Defer — keep tracked in REVIEW-LATER as a deliberate non-fix`. They are listed only so the loops aren't reinvented as "fixes" later. Skip them in batch-picking.

> **Desktop code signing remains out of scope.** macOS + Windows bundles ship unsigned with Gatekeeper / SmartScreen first-launch warnings; the maintainer opted out of paid Apple Developer Program enrollment ($99/year) and Windows OV/EV certs ($200–400/year) for this OSS project. See `docs/BUILD.md` → "Desktop code signing in CI" for the user-facing install instructions.

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

**Status:** **M1 LANDED.** Reference adapter `RmcpReadOnlyAdapter` lives in `src-tauri/src/mcp/rmcp_spike.rs` (gated behind the off-by-default `mcp_rmcp_spike` Cargo feature) and now advertises every RO tool. The parity test `rmcp_spike_tools_list_matches_handle_tools_list_byte_for_byte` pins byte-for-byte equivalence with the hand-rolled `handle_tools_list`. Detailed assessment in `src-tauri/src/mcp/rmcp_spike.md`. The hand-rolled path is still the production code path; M3 flips that.

**Migration plan (2 milestones remaining):**

1. **Milestone 2 (M, ~6h):** route `tools/call` through `rmcp` — override `ServerHandler::call_tool` with the spike's pattern (`ACTOR.scope`, `LAST_APPEND.scope`, `emit_tool_completion` per call); add `AppError → ErrorData` translation. Remove the hand-rolled `dispatch` / `handle_tools_call` body once the new path passes every `mcp/server/tests.rs` / `tools_ro/tests.rs` / `tools_rw/tests.rs` byte-equivalent assertion. The current `call_tool` in the spike still early-returns `method_not_found` for any name other than `search`; M2 drops that guard.
2. **Milestone 3 (S, ~3h):** drop hand-rolled framing — delete `parse_request` / `make_success` / `make_error` / `handle_initialize` / `handle_notification` / `dispatch` / `truncate_params_preview` / JSON-RPC error code constants; replace the `handle_connection` body with `adapter.serve(stream)`. Delete the `mcp_rmcp_spike` Cargo feature once the migration is the default path.

**Functions that stay agaric-specific** (rmcp has nothing to say about them): `serve_unix` / `serve_pipe` / `serve` (Unix socket / Windows pipe + M-83 successor management + H-2 lifecycle gate), `run_connection` (L-113 grace period + RAII counter guard), `app_error_to_jsonrpc` (application-level error mapping).

**Risk-mitigation suggestion** (from the spike): a behind-flag shadow-mode (run both adapters in parallel, compare responses) during milestone 2 so any wire-format drift surfaces in CI before the hand-rolled path is removed.

**Cost:** M-L (~9h remaining across M2 + M3).
**Risk:** Medium — wire format is identical (rmcp targets the same MCP spec we hand-roll) but every existing `mcp/server/tests.rs` / `tools_ro/tests.rs` / `tools_rw/tests.rs` test must still pass byte-equivalent.
**Impact:** Medium — reduces framing boilerplate, tracks the MCP spec upstream rather than reimplementing it, and unlocks several spec features we currently stub (protocol-version negotiation, listChanged, cancel/progress, _meta, ping, structuredContent).

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

### MAINT-193 — `zizmor` baseline triage (59 remaining GitHub Actions findings)

- **Domain:** GitHub Actions security
- **Location:** `.github/zizmor.yml`, `.github/workflows/{ci,release,_validate}.yml`
- **What:** When the `zizmor` pre-commit hook was first wired into `prek.toml`, the audit reported 53 deduped findings across 5 rules. To avoid blocking every commit until they were all fixed, the findings were captured as a file:line baseline in `.github/zizmor.yml` so the hook only fires on **new** findings going forward. The baseline is a known-debt list, not a clean bill of health. Closed clusters:
  - **`template-injection` × 6** — defused by MAINT-114 (`release-tag.yml` fold routed `inputs.version` through `env: INPUT_VERSION:` + `"$INPUT_VERSION"`).
  - **`artipacked` × 6** — fixed by MAINT-193 (added `persist-credentials: false` to 6 non-pushing `actions/checkout` calls in `_validate.yml`, `ci.yml`, `release.yml`). The `bump-version` checkout in `release.yml` retains `persist-credentials: true` explicitly because it drives the tag push back to main — documented inline.
  - **`excessive-permissions` × 1** — fixed by MAINT-193 (workflow-level `contents: write` in `release.yml` tightened to `read`; per-job `contents: write` scoped to `bump-version`, `build-and-release`, `android-build-and-release`).
- **Remaining breakdown:**
  - **`unpinned-uses` × 35** (High) — every `actions/checkout@v5`, `dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2`, `actions/setup-node@v5`, etc. is pinned to a tag/branch instead of a SHA. This is a policy decision; many projects intentionally pin to tags. If we want SHA pinning, automate it via Renovate or Dependabot (it's mechanical).
  - **`cache-poisoning` × 24** (High, mostly tag-pushes building artifacts with `actions/cache` enabled). Either disable caching for tag builds or accept the risk and document. (Count refreshed 2026-05-15 — zizmor v1.25 reports more cache-poisoning sites than v1.x did at hook-introduction time; not new findings, just finer-grained accounting.)
- **Cost remaining:** S–M. `unpinned-uses` is a policy decision plus a Renovate config. `cache-poisoning` is one design call (cache on tag builds: yes/no) plus a file edit.
- **Risk:** Low — these are workflow-only changes; existing tests cover them via `_validate.yml`.
- **Impact:** Medium — closes real (if low-likelihood) supply-chain vectors, and shrinks the baseline file so the hook gives more genuine signal.
- **Status:** Open. Triage off the baseline as fixes land — when a finding is fixed, drop the matching `file:line` entry from `.github/zizmor.yml`.

### MAINT-194 — `useBlockKeyboard` listener-attach perf (re-do MAINT-185 correctly)

- **Domain:** Frontend / Editor
- **Location:** `src/editor/use-block-keyboard.ts:256-334`
- **What:** MAINT-185 attempted to reduce the `useCallback` deps for `handleKeyDown` from 16 (editor + 15 callbacks) to 1 (just `editor`) by stashing callbacks in a ref-bag (mirroring the `use-roving-editor.ts` pattern). The intent was to stop the keydown listener detaching/reattaching on every parent render. **The change broke 57 playwright e2e tests** because the listener attaches to `editor.view.dom.parentElement`, which can change identity between renders (e.g., when `EditorContent` unmounts / remounts on focus change). Under the old dep-heavy pattern, every callback identity change re-fired the `useEffect`, which re-grabbed a fresh `parentElement` and re-attached. Under MAINT-185's pattern, only an editor-instance change re-fires — so the listener stayed bound to a stale parent. Reverted in commit e8b0ac2 (session 651).
- **Why it matters:** The original perf concern is real (16-dep useCallback × every parent render → listener detach/re-attach). But the fix has to preserve the "follow the parent element" invariant.
- **Cost:** M — design + test the correct fix pattern.
- **Risk:** Medium — the e2e regression demonstrates how subtle the listener-stale-element bug is.
- **Impact:** Low — the perf problem is real but currently masked (re-attach overhead is O(microseconds) per render).
- **Recommendation:** Two paths:
  - (a) Keep the old useCallback-with-many-deps pattern but memoize the callbacks at the call site (in `BlockTree.tsx`) so each callback's identity is stable across renders — converts 16 deps to 16 stable references.
  - (b) Adopt the ref-bag pattern from MAINT-185 BUT add an explicit `useEffect` that watches `editor.view.dom.parentElement` (via a ref-callback re-attach trigger) and re-binds the listener when the parent element changes.
  - (c) Use a tree-level event listener on `document` and dispatch by `editor.isFocused` instead of binding to the editor's parent. (Cleanest, but requires careful focus-state tracking.)
- **Status:** Open. Filed by the e8b0ac2 revert.

### MAINT-208 — PEND-25 M1: defer 3 `block_on` startup calls (Android boot perf)

- **Domain:** Backend / startup performance (Android-conditional)
- **Locations:** `src-tauri/src/lib.rs:637, 741, 1083` — 3 deferrable `block_on` calls (link cleanup, space migration, gcal migration).
- **What:** Three startup tasks run synchronously via `block_on` inside the Tauri builder, blocking window-paint until they complete. Per the PEND-25 plan body, only 3 of 11 `block_on` calls are deferrable; the rest are correctness-critical (db pool init, materializer warm).
- **Why it matters:** On Android the cumulative cost may exceed 100 ms, delaying first-paint perceptibly. On desktop the headroom is irrelevant — startup is fast enough that the user doesn't see it.
- **Fix:** Defer the 3 deferrable calls to a post-window-show task (spawn after `app.handle().get_webview_window("main")` is up; signal via a `tokio::sync::Notify`). Materializer must remain initialized before any IPC handler can run.
- **Cost:** M (4-7h) — only worth doing if profiling confirms the >100 ms claim.
- **Risk:** Medium — startup ordering is fragile (gcal migration depends on space migration).
- **Impact:** Medium on Android, none on desktop. **Conditional on Android boot profile data.**
- **Status:** Open, conditional. Profile `adb shell am start -W` with `tracing::info!` instrumentation around each call before refactoring. If cumulative cost <100 ms, close as won't-fix.

### MAINT-209 — PEND-25 L15 + L16: gcal connector channel + agenda fetch hygiene (speculative)

- **Domain:** Backend / gcal push connector
- **Locations:** `src-tauri/src/gcal_push/connector.rs:255` (L15), `:486, :589-595` (L16).
- **What — L15:** `mpsc::UnboundedSender<DirtyEvent>` is unbounded today; defensive bounded channel + `try_send` would prevent a runaway producer from OOM'ing the consumer. No observed instance of producer overrun today; speculative-only.
- **What — L16:** `connector.rs:486, 589-595` makes per-date agenda fetches in a loop instead of a single `list_projected_agenda_inner(min_date, max_date)` call. Only matters when the gcal push window grows beyond a handful of days.
- **Why it matters:** Both are speculative perf wins. Worth doing if profiling shows real contention; not worth doing pre-emptively.
- **Fix:** L15 — switch to `mpsc::channel(N)` + `try_send` with overflow-warn-and-drop. L16 — batch the per-date calls into a single range query.
- **Cost:** S-M (~3h together if pursued; ~0 if not).
- **Risk:** Low (defensive changes).
- **Impact:** Low today; medium if gcal push usage grows.
- **Status:** Open, speculative. Surface concrete profiling data showing gcal contention before pursuing. Filed from PEND-25 (session 661).

## TEST — Backend test improvements

Items in this section are test-quality improvements identified during a thorough backend test review (10 parallel review subagents covering ~80K LOC of test code, 3 verification subagents to filter hallucinations). All items below are verified — known false positives are not listed.

> **Format:** test items use the compact L-style block. None of these are blocking; they are code-quality investments.

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
