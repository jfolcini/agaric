# Review Later

> **Last updated:** 2026-05-04 (Session 666 — closed PEND-23 H3 + M3 + M7 + M8 + M9 + L1 + L8 + L11 in one batch (8 sub-items: the last actionable HIGH plus 4 MEDIUM and 3 LOW): new `useDialogOrSheet()` hook + `ConfirmDialog` Sheet on mobile, `PopoverContent` aria-label across 5 popovers, `SectionTitle` semantic-color enum, `Input`/`Textarea` `[@media(pointer:coarse)]:text-base`, `GraphView` EmptyState on error, `EmptyState` `<section aria-label>` landmark, `Toaster` mobile-aware position, dark-mode `--task-done`/`--task-doing` distinguishability. +52 frontend tests. PEND-23 status: 0 HIGH + 2 MEDIUM (M6 focus-ring extraction, M10 keyboard-nav hook) + 14 LOW remaining. 9443/9443 vitest + 3510/3510 nextest + `prek run --all-files` clean.)

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

36 open items in the summary table; 35 detail entries (FE-* sub-tables don't appear in the summary).

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
| MAINT-194 | MAINT | `useBlockKeyboard` listener-attach perf — re-do MAINT-185 correctly (post-revert). Original ref-bag pattern broke listener stale-element invariant; need to memoize callbacks at call site OR add explicit `editor.view.dom.parentElement` watcher. | M | — |
| MAINT-193 | MAINT | zizmor baseline triage — 53 GitHub Actions findings suppressed by file:line in `.github/zizmor.yml` when the `zizmor` pre-commit hook was first wired in. Mix of policy-level (`unpinned-uses` × 35: tags vs SHAs) and real fixes (`template-injection` × 6 in `release-tag.yml` — pass `inputs.version` via `env:` instead of `${{ }}` interpolation; `excessive-permissions` × 1 in `release.yml`; `cache-poisoning` × 11; `artipacked` × 7). Triage off the baseline as fixes land. | M | — |
| MAINT-196 | MAINT | Projected-agenda projection path drift: `list_projected_agenda_inner` cached path emits 112 entries for a `.+1w` block over a 390-day window vs 110 from `list_projected_agenda_on_the_fly` — a real 2-entry divergence on the dot-plus completion-based mode. Surfaced by the PEND-05 parity test (now `#[ignore]`d in `agenda_cmd_tests::projected_agenda_cached_equals_on_the_fly`); A/B/C/E blocks are in parity. The deeper fix is to refactor the projection logic into a single function called by both paths, eliminating the drift surface entirely. Re-enable the parity test once the refactor lands. | M | — |
| MAINT-197 | MAINT | `Checkbox` UI primitive at `src/components/ui/checkbox.tsx:17,21` renders at 16/20 px — below the 44 px coarse-pointer floor mandated by AGENTS.md. PEND-14 added a local hitbox-wrapper in `PropertyRowEditor` as a stopgap; the systematic fix is to augment the primitive itself (mirroring how `Select` carries its own touch sizing). After landing, remove the local wrapper. | S | — |
| MAINT-198 | MAINT | `PropertyRowEditor` boolean cell renders unchecked for both `value_bool === null` ("no value") and `value_bool === 0` ("false"). PEND-14's plan endorsed this conflation, but Radix Checkbox supports `checked="indeterminate"` which would distinguish the two. Reverses the plan's open-question #1 decision; do not land without a fresh user signal. | S | User signal (reverses PEND-14 plan decision) |
| MAINT-199 | MAINT | `scripts/check-migrations-strict.mjs` mis-parses `;` inside SQL `--` comments as the statement terminator. Authors hitting this had to strip inline semicolons from migration comments. Fix: preprocess the input to strip `--` line comments + `/* */` block comments before scanning. Surfaced during PEND-03 (session 658). | S | — |
| MAINT-200 | MAINT | `useResolveStore.preload()` sets `_preloaded: true` in the catch branch (`src/stores/resolve.ts:208`), permanently disabling retry for the rest of the session. A single transient backend failure leaves tag chips and page-link breadcrumbs stuck on ULIDs / "Untitled" until the app is restarted. Fix: only flip `_preloaded` on success, or split into `'idle' \| 'ready' \| 'failed'`. | S | — |
| MAINT-201 | MAINT | `useDuePanelData` projected-agenda cache (`src/hooks/useDuePanelData.ts:45`, module-level `Map<string, ProjectedCacheEntry>`) checks TTL on read but never deletes stale entries. Every distinct `(spaceId, date)` key the user visits stays in the map until full reload. Fix: `delete()` on TTL expiry, or wrap in a small LRU with a hard cap (~100). | S | — |
| MAINT-202 | MAINT | `UnfinishedTasks.tsx` has three `catch {}` blocks that violate AGENTS.md "no silent catch": localStorage write failures (lines 113-117 and 144-148, comment "Silently ignore storage errors") and the main fetch (lines 232-236, "On error, show empty state") swallow without `logger.warn`. Read-side catches (lines 102-108, 132-141) return safe defaults and are fine. | S | — |
| MAINT-203 | MAINT | The FE-M-15 stale-`insertPos` race-condition guard is duplicated across 3 picker extensions: `at-tag-picker.ts:50-122` (still inlined), `block-link-picker.ts:51-122` (already extracted as `resolveAndInsertBlockLink`), `block-ref-picker.ts:54-122` (already extracted as `resolveAndInsertBlockRef`). Differs only in token shape (`#TAG` / `[[ULID]]` / `((ULID))`) and presence of `onCreate`. Extract a shared helper so the next race-fix lands in one place. | S-M | — |
| MAINT-204 | MAINT | `markdown-serialize.ts:47` stores the `onUnknownNode` callback in a module-scoped `let currentOnUnknownNode` set/cleared by `serialize()` via `try/finally`. Cleanup is robust today (sync, single-threaded), but the pattern is re-entrance-unsafe — any future async helper or recursive serialize call leaks state silently. Fix: thread the callback as a parameter, or scope it via a closure object built inside `serialize()`. | S | — |
| MAINT-205 | MAINT | `src/lib/i18n/index.ts:35-49` merges 14 namespace files via spread into one flat `translation: Record<string, string>`. A duplicate dotted key across two namespaces is silently overwritten (last-spread-wins). No current collisions, but no test guards it. Fix: tiny vitest asserting merged-key count equals the sum of namespace key counts (or pairwise `assertNoOverlap`). | S | — |
| MAINT-206 | MAINT | No automated parity check between `src/lib/tauri-mock/handlers.ts` `HANDLERS` map and the specta-generated commands in `src/lib/bindings.ts`. Adding a backend command without a matching handler silently returns `null` from the mock dispatcher, which masks real test failures. Mirrors PEND-08's `tauri.ts ↔ bindings.ts` parity hook for the test mock. | S | — |
| MAINT-207 | MAINT | Frontend hygiene bundle (5 low-impact items): (a) `Input` and `Textarea` duplicate identical focus-visible + aria-invalid class strings — extract a shared base. (b) `MonthlyView` accepts `onNavigateToPage` and `onAddBlock` only to ignore them via `_`-prefixed renames — drop both from the API + caller. (c) `limit: 50` literal repeated in 11+ production sites (SearchPanel, LinkedReferences, TrashView, DonePanel, ConflictList, HistoryPanel, TagFilterPanel, PageBrowser, HistoryView, useDuePanelData) — define `PAGINATION_LIMIT` in `src/lib/constants.ts`. (d) `SearchPanel.tsx:99-130` carries ~22 useState slices — collapse filter/popover state into a `useReducer` or two extracted hooks. (e) `SearchInput.tsx:69-72` synthesizes a partial `ChangeEvent` via `as unknown as` for the clear-button — expose an explicit `onClear` callback instead, or construct a fuller event. | S-M | — |
| MAINT-91 | MAINT | `oauth2` v5.0 still pins `reqwest ^0.12` while the repo pins `reqwest 0.13.2` (rustls everywhere). Drop the `reqwest` feature on the `oauth2` dependency and write a custom `AsyncHttpClient` adapter over reqwest 0.13. Adapter requires re-typing `OAuthClient::http_client` and `classify_refresh_error`'s generic error parameter. Revisit when `oauth2` tracks `reqwest 0.13`, or as a standalone refactor. Cited in `src-tauri/Cargo.toml:158-166` (oauth2 declaration) and `:137` (FEAT-5c / MAINT-91 reqwest pin block). Deferred from PEND-25 M2 (Rust perf review, session 661); the deeper duplicate-`reqwest 0.12` pull is the perf concern that justifies the refactor. | M | — |
| MAINT-208 | MAINT | PEND-25 M1 deferred — three deferrable `block_on` calls in `src-tauri/src/lib.rs:637, 741, 1083` (link cleanup, space migration, gcal migration) at startup. Per the PEND-25 plan body, only act if Android boot profile shows >100 ms cumulative cost; on desktop the headroom is irrelevant. Profile `adb shell am start -W` with `tracing::info!` instrumentation before refactoring; if confirmed, defer to a post-window-show task. Conditional. | M (4-7h) | Android boot profile data |
| MAINT-209 | MAINT | PEND-25 L15 + L16 deferred — gcal connector channel + agenda fetch hygiene. (L15) `mpsc::UnboundedSender<DirtyEvent>` in `src-tauri/src/gcal_push/connector.rs:255` is unbounded; defensive bounded channel + `try_send` only matters if a fast producer overruns the consumer (no observed instance today). (L16) `connector.rs:486, 589-595` makes per-date agenda fetches in a loop instead of one `list_projected_agenda_inner(min_date, max_date)` call; only matters when the gcal push window grows beyond a handful of days. Both are speculative — only pursue if profiling shows a concrete need. | S-M (~3h together) | Profiling data showing gcal contention |
| MAINT-210 | MAINT | `references.moreFilters` i18n key in `src/lib/i18n/references.ts:19` is now unused — PEND-31 removed the "Show / Hide filters" toggle that consumed it (along with `showFilters` / `hideFilters` / `filtersLabel`, which were deleted in the same change). Left in place in PEND-31 per AGENTS "Surgical Changes" rule (don't remove pre-existing dead code unless asked). Sweep on next i18n pass. | trivial | — |
| MAINT-211 | MAINT | `RecentPagesStrip` single-line scroll has no edge-fade affordance — off-screen chips are cued only by Radix's auto-hide horizontal scrollbar + a partially-cut last chip. Plan PEND-32 deferred a `mask-image` right-edge fade because it requires a `ResizeObserver` to toggle on/off based on overflow. Revisit only if real-world feedback says off-screen chips are hard to discover; see `src/components/RecentPagesStrip.tsx`. | S | Real-world discoverability feedback |
| MAINT-212 | MAINT | `MAX_RETAINED = 10` in `src/stores/recent-pages.ts` was sized for the pre-PEND-32 grid layout (which wrapped to 2 rows beyond ~7 chips). Now that the strip scrolls horizontally on a single fixed-height row, the cap could be raised (15-20) to retain longer history without hurting layout. Independent UX call; pursue when the user wants longer recents. | trivial | UX call on retention depth |
| MAINT-213 | MAINT | PEND-24 M4 follow-up — frontend distinct UX for 401/403 (sign-in card) vs 404/410 (gone) vs 5xx (transient/retry). Today the backend short-circuits on every non-2xx and returns minimal metadata; only `auth_required` is persisted. Adding a `not_found` boolean to `LinkMetadata` (+ migration + `link_metadata` table column + serde default-false on existing rows) would let the frontend distinguish "signed-out" from "page is gone" from "server flaked". File when the link card UI rework wants the distinction. | S-M (Rust column + frontend chrome) | Frontend rework that wants the distinction |
| MAINT-214 | MAINT | PEND-24 M6 sibling cases — two more paths still update `page_id` async-only (asymmetric vs `move_block_inner` and the now-fixed `restore_block_inner`): (a) `restore_all_deleted_inner` (`src-tauri/src/commands/blocks/crud.rs:1051`) — bulk restore covers every soft-deleted block in one `UPDATE`; `RebuildPageIds` is the only refresh path. (b) `apply_op_revert` for `OpPayload::RestoreBlock` and `OpPayload::MoveBlock` (`src-tauri/src/commands/history.rs:74` and `:105`) — undo/redo replay. Both should mirror M6 / `move_block_inner`'s recursive-CTE `UPDATE page_id`. Discovered during M6 implementation but explicitly out of scope per the plan's "this fix scoped to `restore_block_inner`" boundary. | S each | — |
| MAINT-215 | MAINT | PEND-23 H3 follow-up — propagate `useDialogOrSheet()` (new hook in `src/hooks/useDialogOrSheet.ts`, session 666) to the standalone Dialog consumers that PEND-23 H3 explicitly scoped out: `BugReportDialog`, `PdfViewerDialog`, `RenameDialog`, `WelcomeModal`, `QuickCaptureDialog`, `SpaceManageDialog`. Each is a separate Dialog primitive (not a wrapper around `ConfirmDialog`) so it doesn't inherit Sheet behaviour for free. Each migration is independent (cherry-pickable per dialog) and ~30–60 LOC + a mobile-path test. | S each | — |
| PERF-19 | PERF | Backlink pagination cursor uses linear scan for non-Created sorts (2 sites) | S | — |
| PERF-20 | PERF | Backlink filter resolver has no concurrency cap on `try_join_all` | S | — |
| PUB-3 | PUB | Employer IP clearance before public release | S | Employer review |
| PUB-5 | PUB | Tauri updater — endpoint URL pinned to `jfolcini/agaric`; remaining work is user-only (generate Minisign keypair, paste pubkey into `tauri.conf.json`, add 2 GH Actions secrets, uncomment env vars in `release.yml`) | S | User-only |
| PUB-8 | PUB | Android release keystore + 4 GH Actions secrets (apksigner wiring already shipped in `release.yml`) | S | User-only |
| TEST-4 | TEST | Sync daemon tests use 18 fixed sleeps (50–800ms) as race-prone "barriers" because no `wait_for_*` helper exists on `SyncDaemon` / `SyncScheduler` | M | — |
| TEST-FE-2 | TEST | Weak `toHaveBeenCalled()` assertions without arg matchers in hot files: `FormattingToolbar` (16), `GraphView` (8), `useUndoShortcuts` (6), `UnlinkedReferences` (5) — wrong-block / wrong-arg regressions could pass silently. `BlockContextMenu` (19, only 9 are bare on `props.onClose`, already complies), `useBlockKeyboardHandlers` (10), `HeadingLevelSelector` (7) audited & confirmed legitimate (all no-arg spies, comment-annotated). `BlockPropertyEditor` (7) audited & all 7 tightened to `toHaveBeenCalledWith(...)`. | M | — |

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

### MAINT-193 — `zizmor` baseline triage (47 remaining GitHub Actions findings suppressed at hook-introduction time)

- **Domain:** GitHub Actions security
- **Location:** `.github/zizmor.yml`, `.github/workflows/{ci,release,_validate}.yml`
- **What:** When the `zizmor` pre-commit hook was first wired into `prek.toml`, the audit reported 53 deduped findings across 5 rules. To avoid blocking every commit until they were all fixed, the findings were captured as a file:line baseline in `.github/zizmor.yml` so the hook only fires on **new** findings going forward. The baseline is a known-debt list, not a clean bill of health. The original `template-injection` × 6 cluster (all in the now-removed `release-tag.yml`) was defused by MAINT-114's fold of `release-tag.yml` into `release.yml`'s `bump-version` job, which routes `inputs.version` through `env: INPUT_VERSION:` + `"$INPUT_VERSION"` — those entries are gone from the baseline. Remaining breakdown:
  - **`unpinned-uses` × 35** (High) — every `actions/checkout@v5`, `dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2`, `actions/setup-node@v5`, etc. is pinned to a tag/branch instead of a SHA. This is a policy decision; many projects intentionally pin to tags. If we want SHA pinning, automate it via Renovate or Dependabot (it's mechanical).
  - **`cache-poisoning` × 11** (High, mostly tag-pushes building artifacts with `actions/cache` enabled). Either disable caching for tag builds or accept the risk and document.
  - **`artipacked` × 7** (Medium, Low confidence) — `actions/checkout` without `persist-credentials: false`. Auto-fixable via zizmor; one-liner per checkout.
  - **`excessive-permissions` × 1** (High, in `release.yml`) — workflow-level token grants more than the steps actually need. Audit and tighten.
- **Cost:** S–M. The `artipacked` cluster is mechanical (auto-fix). `unpinned-uses` is a policy decision plus a Renovate config. `excessive-permissions` is one workflow header to tighten.
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

### MAINT-196 — Projected-agenda projection-path drift between cached + on-the-fly

- **Domain:** Backend / Agenda
- **Location:** `src-tauri/src/cache/projected_agenda.rs:rebuild_projected_agenda_cache` vs `src-tauri/src/commands/agenda.rs:list_projected_agenda_on_the_fly`
- **What:** PEND-05's parity test (`agenda_cmd_tests::projected_agenda_cached_equals_on_the_fly`, currently `#[ignore]`d on this exact MAINT-196) caught a real divergence on the `.+1w` (completion-based weekly) repeat mode: the cached path emits 112 entries for a single `.+1w` block over a 390-day window, while the on-the-fly path emits 110 — a 2-entry drift. Blocks A (daily + count), B (weekly + until), C (+3d + count), and E (`++1w` skip-past-today) are all in parity; only the `.+` mode diverges.
- **Why it matters:** Users see different agendas depending on whether the cache is warm or cold for `.+`-recurring tasks. Invisible bug class — would hide for months otherwise.
- **Cost:** M — refactor the projection logic (`shift_date_once` + the per-mode windowing) into a single function called by both paths so the drift surface is eliminated. Once unified, re-enable the parity test by removing the `#[ignore]` attribute on `projected_agenda_cached_equals_on_the_fly`.
- **Risk:** Medium — projection logic is hot-path; refactor needs careful nextest coverage on every existing repeat-mode test.
- **Impact:** Medium — invisible-but-real correctness bug, plus enabling the safety-net test prevents future drift.
- **Status:** Open. Filed during PEND-05 close (session 654).

### MAINT-197 — `Checkbox` UI primitive lacks 44 px coarse-pointer hit-area

- **Domain:** Frontend / UI primitives
- **Location:** `src/components/ui/checkbox.tsx:17,21` (`size-4` / `size-5`)
- **What:** The `Checkbox` primitive renders at 16 px on default pointers and 20 px on coarse pointers — well below the 44 px floor mandated by AGENTS.md "Frontend Development Guidelines / Mandatory patterns / Touch targets". PEND-14 (boolean property type) tripped on this in `PropertyRowEditor`'s new boolean branch and applied a local hitbox-wrapper as a stopgap. Other primitives (Select trigger, FilterPill remove button, sidebar menu button) carry their own coarse-pointer sizing — Checkbox is the outlier. Existing call sites (`BugReportDialog.tsx:465`, `PropertyRowEditor.tsx:401-416` post-PEND-14) sit in larger touch-friendly contexts so the gap was invisible until now.
- **Why it matters:** Every NEW Checkbox call site has to either remember to add a wrapper (likely-forgotten work) or get its own AGENTS.md violation. The systematic fix scales.
- **Cost:** S — augment `src/components/ui/checkbox.tsx` itself: wrap the Radix indicator in a hitbox container with `[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11` (mirroring how `Select` carries its own touch sizing). After landing, remove the local wrapper from `PropertyRowEditor.tsx:402-416` (it becomes redundant).
- **Risk:** Low — visual change is touch-only (default-pointer rendering stays at 16 px). Existing call sites get a free upgrade.
- **Impact:** Medium — Android usability + AGENTS.md compliance + future-proofing.
- **Status:** Open. Filed during PEND-14 close (session 657).

### MAINT-198 — `PropertyRowEditor` boolean cell could use `indeterminate` for `value_bool === null`

- **Domain:** Frontend / Properties
- **Location:** `src/components/PropertyRowEditor.tsx:401-416` (`prop.value_bool === 1`)
- **What:** Today the boolean checkbox renders unchecked when `prop.value_bool` is `null` (no value set yet) AND when it is `0` (explicitly false). The PEND-14 plan's open-question #1 endorsed this conflation ("absence of the property row = absence of value, distinct from `false`"), but Radix Checkbox supports `checked="indeterminate"` which would visually distinguish "not yet set" from "set to false". The current behavior silently commits the row to `false` on first toggle.
- **Why it matters:** UX clarity for unset booleans. Low-impact for the current property surface (where boolean props are typically toggled deliberately), but matters more if the boolean type ever ships with import/migration paths that produce null values.
- **Cost:** S — change `checked={prop.value_bool === 1}` to `checked={prop.value_bool === null ? 'indeterminate' : prop.value_bool === 1}` and add a test for the indeterminate render. May also need a primitive update to ensure the indeterminate visual is well-defined.
- **Risk:** Low — purely additive UX clarity. Reverses the plan's open-question #1 decision; needs explicit user nod before landing.
- **Impact:** Low.
- **Status:** Open. Filed during PEND-14 close (session 657). Reverses the plan's deliberate decision; do not land without a fresh user signal.

### MAINT-199 — `check-migrations-strict.mjs` mis-parses `;` inside SQL `--` comments as the statement terminator

- **Domain:** Pre-commit tooling / migrations
- **Location:** `scripts/check-migrations-strict.mjs:48` (`src.indexOf(';', startIdx)`)
- **What:** The hook walks each `CREATE TABLE` by finding the next `;` after the `CREATE` keyword, then asserts `STRICT` appears in the tail after the last `)`. It does NOT strip SQL comments first, so a `--` line comment containing `;` (e.g. `-- example: id; this column holds the id`) is treated as the statement terminator. The `STRICT` keyword (which lives outside the truncated slice) is never seen, and the hook flags the table as missing STRICT — even when the actual migration is correct.
- **Repro:** `cat > /tmp/x.sql <<'EOF'`<br>`CREATE TABLE foo (`<br>`    id TEXT NOT NULL,  -- example: id; this column holds the id`<br>`    name TEXT NOT NULL,`<br>`    PRIMARY KEY (id)`<br>`) STRICT;`<br>`EOF`<br>`node scripts/check-migrations-strict.mjs /tmp/x.sql` → `ERROR: ... CREATE TABLE foo must use STRICT mode` (exit 1) — false positive.
- **Why it matters:** Surfaced during PEND-03 (session 658). Authors had to remove inline `;` from migration comments to silence the hook. Future migrations with descriptive comments will hit the same trap. The hook also miscounts `(` / `)` if a comment contains them, so the `lastIndexOf(')')` heuristic is similarly fragile.
- **Cost:** S — strip line comments (`-- ... <newline>`) and block comments (`/* ... */`) from `src` before applying the regex / boundary scan. Don't strip inside string literals (rare in DDL but possible in `DEFAULT 'literal'`).
- **Risk:** Low — preprocessor is a pure transformation; existing migrations are already STRICT-compliant so a less-aggressive parser will still pass them. Add a regression test based on the repro above.
- **Impact:** Medium — eliminates a class of false positives that force authors to write less-readable migration comments.
- **Status:** Open. Filed by PEND-03 review (session 658). The author worked around it by stripping inline semicolons from the 0044 migration comments; the hook itself was not modified.

### MAINT-200 — `useResolveStore.preload()` permanently disables retry on failure

- **Domain:** Frontend / Resolve store
- **Location:** `src/stores/resolve.ts:206-209`
- **What:** Both the success branch and the catch branch call `set({ _preloaded: true })`. Other call sites short-circuit when `_preloaded` is already true, so a single transient failure (slow backend at boot, broken pipe, …) leaves the cache empty and unrecoverable for the rest of the session — tag chips show ULIDs, page-link breadcrumbs show "Untitled" everywhere.
- **Why it matters:** A user-visible regression caused by a single transient error, with no recovery short of restarting the app.
- **Cost:** S — split the flag (e.g. `'idle' | 'ready' | 'failed'`) so a failure does not poison subsequent attempts; only mark `ready` on success. Add a regression test that simulates one failure followed by a successful retry.
- **Risk:** Low — only the catch branch changes; success path is unaffected.
- **Impact:** Medium — recovers a real failure mode that today requires an app restart.
- **Status:** Open. Filed during JS/TS code review (session 660).

### MAINT-201 — `useDuePanelData` projected-cache has no eviction (unbounded growth)

- **Domain:** Frontend / Hooks
- **Location:** `src/hooks/useDuePanelData.ts:45,406-437`
- **What:** A module-level `projectedCache: Map<string, ProjectedCacheEntry>` keyed by `${spaceId}|${date}` is read with a TTL check (`Date.now() - cached.timestamp < PROJECTED_CACHE_TTL_MS`), but stale entries are only ignored — never deleted. The only deletion path is `projectedCache.clear()` on `invalidationKey` bump. Every distinct date the user visits adds an entry that lives until full reload.
- **Why it matters:** Not catastrophic — entries are small — but the map is unbounded. A power-user navigating across many months over a long session sees uncapped growth.
- **Cost:** S — add `projectedCache.delete(k)` on TTL expiry, or wrap in a tiny LRU with cap ~100.
- **Risk:** Low — eviction is local to one hook.
- **Impact:** Low-medium — long-tail memory hygiene.
- **Status:** Open. Filed during JS/TS code review (session 660).

### MAINT-202 — `UnfinishedTasks` silent-catch blocks violate AGENTS.md

- **Domain:** Frontend / Journal
- **Location:** `src/components/journal/UnfinishedTasks.tsx:113-117,144-148,232-236`
- **What:** Three `catch {}` blocks swallow errors without logging. Two are localStorage write failures (`writeCollapsedState`, `writeGroupCollapsedState`) with the comment "Silently ignore storage errors"; the third is the main `fetchUnfinished` block (`catch { setBlocks([]) }` with comment "On error, show empty state"). AGENTS.md "Frontend Patterns Commonly Caught in Review" forbids silent `.catch(...) {}` blocks — `logger.warn` / `logger.error` is required. Read-side localStorage catches at lines 102-108 and 132-141 return safe defaults and don't apply.
- **Why it matters:** A failing fetch shows the user an empty Unfinished panel with no signal in the console / IPC log. localStorage quota-exceeded gets the same treatment. AGENTS.md compliance + observability.
- **Cost:** S — import `logger` from `src/lib/logger` and add three `logger.warn('UnfinishedTasks', ...)` calls.
- **Risk:** Low — additive logging.
- **Impact:** Medium — converts a mystery empty-state into a debuggable signal.
- **Status:** Open. Filed during JS/TS code review (session 660).

### MAINT-203 — Picker stale-`insertPos` race-guard duplicated across at-tag / block-link / block-ref

- **Domain:** Frontend / Editor extensions
- **Location:** `src/editor/extensions/at-tag-picker.ts:50-122`, `src/editor/extensions/block-link-picker.ts:51-122`, `src/editor/extensions/block-ref-picker.ts:54-122`
- **What:** All three picker extensions implement the same FE-M-15 race-condition guard (`isStale()` check + `insertPlainAtCursor` fallback when the user has typed past the original `range.from`). `block-link-picker` and `block-ref-picker` already factored their guard into per-extension helpers (`resolveAndInsertBlockLink`, `resolveAndInsertBlockRef`); `at-tag-picker` still has it inlined. The three helpers differ only in token shape (`#TAG`, `[[ULID]]`, `((ULID))`) and the presence/absence of an `onCreate` path.
- **Why it matters:** Any future fix or enhancement to the guard has to land in three (or more) places. The `at-tag-picker` inlining is the most likely to drift.
- **Cost:** S-M — extract a generic `resolveAndInsertPickerToken({ tokenFor, onCreate?, … })` in `picker-plugin.ts` (or a new `picker-helpers.ts`). Migrate the three call sites; preserve existing tests; add a unit test for the shared helper.
- **Risk:** Low-medium — well-tested area; refactor only.
- **Impact:** Medium — prevents the next race-fix from being pasted into 3 files.
- **Status:** Open. Filed during JS/TS code review (session 660).

### MAINT-204 — Markdown serializer uses module-scope mutable callback state

- **Domain:** Frontend / Editor / Markdown serializer
- **Location:** `src/editor/markdown-serialize.ts:47-50,407-425`
- **What:** A module-scoped `let currentOnUnknownNode: ((type: string) => void) | undefined` is set at the top of `serialize()` and reset in `finally`, then read by `notifyUnknownNodeType`. The header comment acknowledges the trade-off ("avoids threading the callback through every inline helper purely for one rare branch"). Cleanup is robust today, but the pattern is subtle and re-entrance-unsafe — a future helper that becomes async, or a `serialize` call inside a `serialize` call, leaks state.
- **Why it matters:** Defensive against silent bugs if the serializer ever grows async paths or recursive entry points.
- **Cost:** S — either thread the callback through the helpers as a parameter, or scope it via a closure object (e.g. `const ctx = { onUnknown }`) constructed inside `serialize()` and passed explicitly.
- **Risk:** Low — purely structural; existing tests cover behavior.
- **Impact:** Low — invariant insurance, not a current bug.
- **Status:** Open. Filed during JS/TS code review (session 660).

### MAINT-205 — i18n namespace flat-merge has no collision detection

- **Domain:** Frontend / i18n
- **Location:** `src/lib/i18n/index.ts:35-49`
- **What:** Fourteen namespace modules (`common`, `errors`, `toolbar`, `block`, `agenda`, `editor`, `pages`, `properties`, `references`, `conflicts`, `sync`, `shortcuts`, `settings`, …) are merged via object spread into one flat `Record<string, string>`. If two files define the same dotted key, the second silently wins. No collision check; no test guards it.
- **Why it matters:** Today the namespaces use distinct prefixes and there are no collisions, but a single careless `'block.title'` redeclaration could silently change UI strings. The cost of guarding is trivial.
- **Cost:** S — vitest like `expect(Object.keys(translation).length).toBe(common.length + errors.length + …)` or a per-pair `assertNoOverlap` helper that fails fast and lists the offending keys.
- **Risk:** Low.
- **Impact:** Low-medium — preserves a property the codebase already relies on.
- **Status:** Open. Filed during JS/TS code review (session 660).

### MAINT-206 — `tauri-mock` ↔ `bindings.ts` parity is unchecked (mirror PEND-08 for the test mock)

- **Domain:** Frontend / Test infrastructure
- **Location:** `src/lib/tauri-mock/handlers.ts` (`HANDLERS` map) vs `src/lib/bindings.ts` (specta-generated commands)
- **What:** PEND-08's parity hook checks that `src/lib/tauri.ts` wraps every command in `bindings.ts`. There is no equivalent check for the test mock. Adding a new backend command without a matching `HANDLERS[name]` entry silently returns `null` from the mock dispatcher, which masks real test failures or pollutes CI with "expected …, received null" failures distant from the cause.
- **Why it matters:** The mock is the test surface for IPC. Drift between bindings and mock is invisible until tests fail confusingly.
- **Cost:** S — write a vitest that imports both `HANDLERS` and the generated `commands` symbol from `bindings.ts`, then asserts the handler-keys set ⊇ the commands-keys set. Allowlist via constant for any deliberately-unimplemented commands.
- **Risk:** Low.
- **Impact:** Medium — catches drift on the next backend command add for ~30 min of test code.
- **Status:** Open. Filed during JS/TS code review (session 660).

### MAINT-207 — Frontend hygiene bundle (Input/Textarea dup, MonthlyView dead props, PAGINATION_LIMIT, SearchPanel state, SearchInput synthetic event)

- **Domain:** Frontend / UI primitives + components
- **Locations:**
  - **(a)** `src/components/ui/input.tsx:11-14` and `src/components/ui/textarea.tsx:11-14` (duplicate `focus-visible:*` + `aria-invalid:*` class strings).
  - **(b)** `src/components/journal/MonthlyView.tsx:29-39` (accepts `onNavigateToPage` + `onAddBlock`, both ignored via `_`-prefix renames).
  - **(c)** `limit: 50` literal repeated in 11+ production sites — `src/components/SearchPanel.tsx:151`, `LinkedReferences.tsx:89`, `TrashView.tsx:67`, `DonePanel.tsx:66,108`, `ConflictList.tsx:74`, `HistoryPanel.tsx:51`, `TagFilterPanel.tsx:113`, `PageBrowser.tsx:72`, `HistoryView.tsx:82`, `src/hooks/useDuePanelData.ts:204,255`.
  - **(d)** `src/components/SearchPanel.tsx:99-130` carries ~22 `useState` slices (query / debouncedQuery / typing / cleared / loadingResultId / pageTitles / recentPages / aliasMatch / aliasQuery / 4 filter slices / 4 page-popover slices / 4 tag-popover slices).
  - **(e)** `src/components/ui/search-input.tsx:64-72` synthesizes a partial `ChangeEvent` via `as unknown as React.ChangeEvent<HTMLInputElement>` to fire `onChange` from the clear button.
- **What:** Five low-impact maintainability items that surfaced together in the JS/TS code review. Each is small in isolation; bundled because they share the same "frontend hygiene" theme and would land naturally in one MR.
- **Why it matters:** None of these is a bug today. Each is a small drag on readability, an API debt from past refactors, or a future-bug-attractor.
- **Cost:** S-M — (a) ~5 LOC extract into a shared base; (b) drop two props from the type + caller; (c) define + import `PAGINATION_LIMIT` in 11 places; (d) `useReducer` or split into 2 hooks (largest item, ~M); (e) prefer adding an explicit `onClear` callback over the synthetic event — failing that, build a more complete event.
- **Risk:** Low — additive or refactor-only; covered by existing tests.
- **Impact:** Low-medium — readability + a guard against the synthetic-event NPE for any future consumer that reads `e.bubbles` / calls `e.preventDefault()`.
- **Status:** Open. Filed during JS/TS code review (session 660).

### MAINT-91 — `oauth2` v5 still pins `reqwest 0.12`; need adapter over reqwest 0.13

- **Domain:** Backend / dependency hygiene
- **Locations:** `src-tauri/Cargo.toml:158-166` (oauth2 declaration), `:137` (FEAT-5c / MAINT-91 reqwest pin block).
- **What:** `oauth2 v5.0` pins `reqwest ^0.12` via its built-in `reqwest` feature, while the rest of the repo pins `reqwest 0.13.2` (rustls everywhere). This drags a duplicate `reqwest 0.12` slice into the dep graph. The repo selects `rustls-tls` so both reqwest slices use the same TLS stack at link time, but the duplicate compile cost + binary size is real.
- **Why it matters:** Single-TLS-stack posture is preserved (good), but every `cargo build` recompiles two `reqwest` slices and the resulting binary carries both. Not a correctness issue.
- **Fix:** Drop the `reqwest` feature on the `oauth2` dep and write a custom `AsyncHttpClient` adapter over `reqwest 0.13`. Adapter requires re-typing `OAuthClient::http_client` and `classify_refresh_error`'s generic error parameter.
- **Cost:** M.
- **Risk:** Medium — touches `commands/oauth.rs` + `gcal_oauth/*` end-to-end; the type-parameter expansion ripples.
- **Impact:** Medium (perf — single reqwest slice instead of two; smaller binary).
- **Status:** Open. FEAT-5c declined to take it on (out of scope). Re-evaluate when `oauth2` tracks `reqwest 0.13`, or as a standalone refactor. Surfaced as PEND-25 M2 (session 661 confirmed it's still open as MAINT-91).

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

### MAINT-210 — `references.moreFilters` i18n key is dead (PEND-31 leftover)

- **Domain:** Frontend / i18n
- **Location:** `src/lib/i18n/references.ts:19`
- **What:** PEND-31 removed the "Show / Hide filters" toggle from `LinkedReferences` and `UnlinkedReferences` and deleted the three keys it consumed (`showFilters`, `hideFilters`, `filtersLabel`). `moreFilters` was already unused at PEND-31 time but was left in place per AGENTS "Surgical Changes" rule (don't remove pre-existing dead code unless asked).
- **Why it matters:** Dead i18n keys accumulate translator noise once locales are added. Cheap to sweep.
- **Fix:** Delete the key + grep-confirm no remaining references in `src/`.
- **Cost:** trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open. Filed from PEND-31 reviewer (this session).

### MAINT-211 — `RecentPagesStrip` edge-fade affordance for off-screen chips (deferred from PEND-32 v1)

- **Domain:** Frontend / UX
- **Location:** `src/components/RecentPagesStrip.tsx`
- **What:** PEND-32's single-line scroll layout cues off-screen chips only via Radix's auto-hide horizontal scrollbar + a partially-cut last chip. A right-edge `mask-image` fade was considered and deferred to v2 because the fade should be off when there's no overflow, which requires a `ResizeObserver` on the viewport.
- **Why it matters:** If real-world feedback shows users miss the off-screen chips, the fade is the standard reinforcement.
- **Fix:** Add a `ResizeObserver` + `useState` toggle that flips `mask-image: linear-gradient(to right, black 90%, transparent)` on the viewport when `scrollWidth > clientWidth`.
- **Cost:** S (~1-2 h including a regression test).
- **Risk:** Low.
- **Impact:** Low — secondary affordance.
- **Status:** Open, gated on real-world feedback. Filed from PEND-32 plan + UX reviewer (this session).

### MAINT-212 — `RecentPagesStrip` `MAX_RETAINED` cap can be raised post-PEND-32

- **Domain:** Frontend / UX
- **Location:** `src/stores/recent-pages.ts` (`MAX_RETAINED = 10`)
- **What:** The cap was sized for the pre-PEND-32 grid layout, where >7 chips wrapped to a second row. PEND-32 makes the strip a single fixed-height scrollable row, so longer history (15-20 entries) no longer hurts layout. The right number depends on user retention preference, not engineering constraints.
- **Why it matters:** Retains a longer "places I just was" trail without UI penalty.
- **Fix:** Bump the constant; one-line change. Verify `RecentPagesStrip` test still passes.
- **Cost:** trivial.
- **Risk:** Low.
- **Impact:** Medium (longer history) — depends on user signal.
- **Status:** Open, gated on UX call. Filed from PEND-32 plan + UX reviewer (this session).

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

### TEST-FE-2 — Weak `toHaveBeenCalled()` assertions in hot files
- **Domain:** Frontend test infrastructure
- **Location (un-audited):**
  - `src/components/__tests__/FormattingToolbar.test.tsx` (16)
  - `src/components/__tests__/GraphView.test.tsx` (8)
  - `src/hooks/__tests__/useUndoShortcuts.test.ts` (6)
  - `src/components/__tests__/UnlinkedReferences.test.tsx` (5)
  - 158 total occurrences across 59 files (many legitimate "did fire at all"; high-frequency files most likely contain real cases)
- **Audited & resolved:**
  - `src/components/__tests__/BlockContextMenu.test.tsx` (19) — action handlers already use `toHaveBeenCalledWith('BLOCK_01')`; the 9 bare calls are on `props.onClose` which legitimately takes no args. **Already complies.**
  - `src/hooks/__tests__/useBlockKeyboardHandlers.test.ts` (10) — all on `handleFlush` and `rovingEditor.unmount`, both no-arg by their TypeScript signature. Annotated with `// no-args by contract` (s649).
  - `src/components/__tests__/HeadingLevelSelector.test.tsx` (7) — all on `mockChain` / `mockFocus` / `mockRun` (TipTap chain API zero-arg) and `preventDefaultSpy`. Annotated with `// no-args by contract` (s650). Note: `mockToggleHeading({ level })` was already correctly tightened in the original test.
  - `src/components/__tests__/BlockPropertyEditor.test.tsx` (7) — all 7 were genuine violations and were tightened to `toHaveBeenCalledWith(...)` (s650): toast message ('Failed to save property'), `autoUpdate` 3-arg signature (anchor/popup/update), `computePosition` 3-arg with `expect.objectContaining({ placement: 'bottom-start' })`, `setRefSearch('a')`. Real catches.
- **What:** `src/__tests__/AGENTS.md` line 582: "Meaningful assertions — `toHaveBeenCalledWith` with exact args, not just `toHaveBeenCalled`." Audited files split ~50/50 between "all legitimate no-arg" and "all genuine violations" — there's no shortcut, each file needs to be cross-referenced against the production code's call signature.
- **Why it matters:** A documented quality standard. Concentration in hot files means real correctness regressions could slip through (the `BlockPropertyEditor` audit caught 7 real violations including assertions that didn't pin `placement: 'bottom-start'` on `computePosition`).
- **Cost:** M — audit the 4 remaining files (`FormattingToolbar`, `GraphView`, `useUndoShortcuts`, `UnlinkedReferences`) by cross-referencing each spy's signature against its production-code call site. The remaining ~50 files (~93 occurrences, mostly legitimate by the audit-so-far ratio) are a separate pass.
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
