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

22 open items in the summary table; 22 detail entries (FE-* sub-tables don't appear in the summary).

| ID | Section | Title | Cost | Blocked on |
|----|---------|-------|------|-----------|
| FEAT-3p9 | FEAT | Spaces Phase 9: per-space external integrations — foundation (per-space `gcal_space_config` table + per-space keychain key + legacy single-space migration) in place; remaining work threads `space_id` through oauth/lease/connector/commands, branches the push loop by space, ships per-space Settings accordion, and (when FEAT-11 lands) prefixes OS notifications with the space name | M | — (M3 sub-task blocked on FEAT-11) |
| PEND-38 | FEAT | Import progress streaming over `Channel<T>` (PEND-06 Tier 3) — DEFERRED. Needs the import pipeline restructured before per-block progress channel has UX value (today `import_markdown` parses + applies the whole file in one tx, so the only progress signal is start / done). Pursue when imports become a UX paper-cut OR someone is already touching `import_markdown` for an unrelated reason. | L restructure + S emission | Import pipeline restructure |
| AGENDA-SQL | PERF | Agenda sort/group SQL pushdown — DEFERRED. Move `sortAgendaBlocks` + `groupBy*` (10 `.sort()` sites + 4 `groupBy*` functions in `src/lib/agenda-sort.ts`) into a backend `ORDER BY (effective_date, state_rank, priority_rank)`. The current JS sort is sub-ms on the ≤200-item per-page set, so the SQL pushdown is a maintainability / consistency win, not a perf win. Cost driven by the compound-cursor reshape this requires (paginate-by-multi-column is non-trivial). Filed as a tombstone so a future contributor doesn't re-derive the blocker. Original sql-audit H4 item, separated from the audit doc when the audit was retired. | M | Decision to invest in compound-cursor reshape |
| SQL-M-8 | PERF | Snapshot restore streaming — DEFERRED until Android profiling justifies. `snapshot::restore::apply_snapshot` materialises the full parsed `SnapshotData` in RAM. The docstring claims memory is bounded, but the *parsed struct* (not the compressed bytes nor decompressed CBOR stream) is fully in-memory. On desktop, fine. On Android (24 MB heap), potentially OOM under large snapshots — let the future Android profile produce concrete numbers before sizing the fix. Fix: stream-decode CBOR per-table into batch INSERTs against the open tx. | L | Android profiling showing the OOM is real |
| FEAT-5g | FEAT | GCal: Android OAuth + background connector (DEFERRED — design sketch only) | L | Design review |
| FEAT-11 | FEAT | Adopt `tauri-plugin-notification` — OS notifications for due tasks / scheduled events (Org-mode parity, especially on mobile) | L | — |
| MAINT-168 | MAINT | Sync trigger / scheduler dual-backoff unification — `useSyncTrigger.ts` (60s → 600s) and `sync_scheduler.rs` (1s → 60s) run independent exponential backoffs that never coordinate. Not a correctness bug; the backend is the authoritative scheduler and silently rejects redundant `startSync` calls. Filed as a documented design note after this session's bird's-eye review. | M | — |
| MAINT-208 | MAINT | PEND-25 M1 deferred — deferrable `block_on` calls in `src-tauri/src/lib.rs` (in the `recover_at_boot`, `bootstrap_spaces`, and gcal-migration setup paths; the file currently has 6 `block_on` sites total, of which the PEND-25 plan classed 3 as deferrable). Per the PEND-25 plan body, only act if Android boot profile shows >100 ms cumulative cost; on desktop the headroom is irrelevant. Profile `adb shell am start -W` with `tracing::info!` instrumentation before refactoring; if confirmed, defer to a post-window-show task. Conditional. | M (4-7h) | Android boot profile data |
| MAINT-209 | MAINT | PEND-25 L15 + L16 deferred — gcal connector channel + agenda fetch hygiene. (L15) `mpsc::UnboundedSender<DirtyEvent>` in `src-tauri/src/gcal_push/connector.rs` (carried on the connector struct + spawn arg; the channel is constructed via `mpsc::unbounded_channel::<DirtyEvent>()` near the connector init) is unbounded; defensive bounded channel + `try_send` only matters if a fast producer overruns the consumer (no observed instance today). (L16) `connector.rs::push_date` is called per-date in a loop instead of one `list_projected_agenda_inner(min_date, max_date)` call; only matters when the gcal push window grows beyond a handful of days. Both are speculative — only pursue if profiling shows a concrete need. | S-M (~3h together) | Profiling data showing gcal contention |
| PERF-19 | PERF | Backlink pagination cursor uses linear scan for non-Created sorts (3 sites) | S | — |
| PERF-20 | PERF | Backlink filter resolver has no concurrency cap on `try_join_all` | S | — |
| MAINT-227 | MAINT | gcal OAuth — migrate browser-open from `tauri-plugin-shell::open` (deprecated) to `tauri-plugin-opener`. Site: `src-tauri/src/commands/gcal.rs:550-557`, currently behind `#[allow(deprecated)]`. The new plugin lands when we next bump Tauri plugins; the surface is a 1-line callback swap. | S | `tauri-plugin-opener` dep added |
| OSSF-1 | MAINT | OpenSSF Best Practices — **Passing tier achieved 2026-05-17** (project [#12870](https://www.bestpractices.dev/projects/12870)); badge wired in `README.md:10`. Silver-tier roadmap lives in `pending/PEND-49-ossf-silver-roadmap.md` — 14 unmet criteria catalogued by disposition (auto-meet on external contributor / deliberate non-policy / upstream-blocked / engineering work). Gold is not pursued while solo-maintained. Keep this row as the lookup pointer from the Scorecard `CII-Best-Practices` check to the live roadmap. | tracker | see PEND-49 |
| OSSF-2 | MAINT | Scorecard `Code-Review` score = 0 because changesets pushed directly to `main` by the solo maintainer count as "0/N approved" — the asymmetric maintainer-bypass ruleset (R12, see `docs/architecture/ci-and-tooling.md` §13) is by design. The score auto-improves the moment any external maintainer lands, because their PRs route through `validate-all` + at least one review. **Revisit trigger:** first external maintainer onboarded → flip the ruleset to symmetric (require review for everyone, drop the maintainer bypass), or accept a permanent 0 here and document the design choice in the public security posture. | S (decision) → M (ruleset flip + bypass test plan) | First external maintainer joining the repo |
| OSSF-3 | MAINT | Scorecard `Vulnerabilities` score = 0 because of ~22 RUSTSEC advisories (re-verify via `grep -c RUSTSEC src-tauri/deny.toml` before quoting a number — it drifts), the bulk of which are atk/gtk3 "no longer maintained" notices (`RUSTSEC-2024-04xx`) reaching us transitively via `wry → tauri`. All are documented in `src-tauri/deny.toml [advisories].ignore` with rationale and the upstream tracking issue. The score will recover automatically when `tauri`/`wry` finish migrating off gtk3 (already in progress upstream — wry's webkit2gtk backend is the only remaining gtk3 user, and the gtk4 work is on their roadmap). **Revisit trigger:** Tauri release notes announce gtk4 migration complete → drop the relevant `deny.toml` ignore entries + re-run Scorecard to confirm the score lifts. Tracking item: <https://github.com/tauri-apps/wry/issues/802>. | S (delete ignore entries + verify) | Upstream wry/tauri gtk4 migration |
| OSSF-4 | MAINT | Scorecard `Maintained` = 0: pure 90-day time-based check, auto-recovers. Revisit trigger: if not recovered by 2026-08-14, investigate commit cadence or branch-protection metadata. Until then no action. | trivial | 90 days of repo age |
| PEND-48 | MAINT | Verify reproducible builds end-to-end — build the release matrix twice from a clean state, diff hashes, identify and eliminate sources of non-determinism (timestamps, sort order, embedded build env). Flips `build_reproducible` to Met on bestpractices.dev Silver tier (load-bearing tentpole — see `PEND-49` §5d for scope decision: desktop-only vs. desktop+Android). Greenfield work: `release.yml` has zero `SOURCE_DATE_EPOCH` / reproducibility hooks today, so the cost is the multi-week investigation across desktop + Android build steps, not a quick verification pass. | L (multi-week) | — |
| CI-R3 | MAINT | Windows code signing via SignPath.io OSS — free for public OSS, integrates as one GHA step. Closes the "Windows bundle ships unsigned with SmartScreen warning" UX gap. SignPath OSS application queue runs ~2-3 weeks; once approved, wire the signing step into `release.yml` between the bundle build and the attest step. | S (apply) + S (wire step) | SignPath OSS application approval (maintainer action) |
| CI-R11 | MAINT | macOS notarisation — strict no-go for current cycle per maintainer decision. SLSA-provenance posture stays; `docs/BUILD.md` unquarantine instructions remain the user-facing UX for the Gatekeeper warning. Revisit trigger: a downstream that requires notarisation (managed corporate fleet, third-party Mac app catalogue). | M (Apple Dev Program $99/yr + notarytool wiring) | Maintainer decision to invest in Apple Developer Program |
| CI-R15 | PERF | Vitest pool A/B benchmark — `forks` (default) vs `threads`. Happy-dom suites *may* run faster on threads but threads can leak module state; the actual delta is unknown without measurement. ADOPT if measured speedup >30% on a CI experiment (run one branch each, compare wall times); document either way. | S (one CI run + decision) | Opt-in benchmark cycle |
| CI-R16 | MAINT | `SKIP_CI_VERIFY` reason-string / safe-glob guard. Habit-creep vs friction-cost is genuinely balanced for a solo workflow. Cheap version (reject `=1`, require non-empty reason string in env var) is ~10 lines bash; rigorous version (safe-glob allowlist) requires git-diff inspection in the pre-push script. | S (cheap) or M (rigorous) | Maintainer decision on cadence-vs-friction |

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

### MAINT-208 — PEND-25 M1: defer 3 `block_on` startup calls (Android boot perf)

- **Domain:** Backend / startup performance (Android-conditional)
- **Locations:** `src-tauri/src/lib.rs` — 3 deferrable `block_on` calls in the `recover_at_boot`, `bootstrap_spaces`, and gcal-migration setup paths. The file currently has 6 `block_on` sites in total; the PEND-25 plan classed only these 3 as deferrable (the rest — db pool init, materializer warm — are correctness-critical). Anchor by function name rather than line number; the file rebases.
- **What:** Three startup tasks run synchronously via `block_on` inside the Tauri builder, blocking window-paint until they complete.
- **Why it matters:** On Android the cumulative cost may exceed 100 ms, delaying first-paint perceptibly. On desktop the headroom is irrelevant — startup is fast enough that the user doesn't see it.
- **Fix:** Defer the 3 deferrable calls to a post-window-show task (spawn after `app.handle().get_webview_window("main")` is up; signal via a `tokio::sync::Notify`). Materializer must remain initialized before any IPC handler can run.
- **Cost:** M (4-7h) — only worth doing if profiling confirms the >100 ms claim.
- **Risk:** Medium — startup ordering is fragile (gcal migration depends on space migration).
- **Impact:** Medium on Android, none on desktop. **Conditional on Android boot profile data.**
- **Status:** Open, conditional. Profile `adb shell am start -W` with `tracing::info!` instrumentation around each call before refactoring. If cumulative cost <100 ms, close as won't-fix.

### MAINT-209 — PEND-25 L15 + L16: gcal connector channel + agenda fetch hygiene (speculative)

- **Domain:** Backend / gcal push connector
- **Locations (anchored by symbol — line numbers drift):** `src-tauri/src/gcal_push/connector.rs` — L15 covers the `UnboundedSender<DirtyEvent>` field carried on the connector struct + the matching `mpsc::unbounded_channel::<DirtyEvent>()` constructor. L16 covers `run_cycle` calling `push_date` once per date in a loop instead of a single ranged query.
- **What — L15:** `mpsc::UnboundedSender<DirtyEvent>` is unbounded today; defensive bounded channel + `try_send` would prevent a runaway producer from OOM'ing the consumer. No observed instance of producer overrun today; speculative-only.
- **What — L16:** per-date agenda fetches in a loop instead of a single `list_projected_agenda_inner(min_date, max_date)` call. Only matters when the gcal push window grows beyond a handful of days.
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
