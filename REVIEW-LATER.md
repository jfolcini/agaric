# Review Later

> **Last updated:** 2026-05-02 (Session 612 — Batch QUICK-WINS-4 closed: MAINT-169, MAINT-170, MAINT-173)

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

132 open items in the summary table; 164 detail entries (FE-* sub-tables don't appear in the summary).

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
| MAINT-172 | MAINT | Pagination/queries: space-filter SQL fragment inlined across 13+ files because `sqlx::query_as!` rejects `concat!()`; `space_filter_clause!` macro referenced in comments but unusable. Real maintenance hotspot, sqlx-constrained | M | sqlx upstream |
| MAINT-174 | MAINT | Frontend — `BlockContextMenu` hardening cluster: action errors silently close the menu, first-item focus has empty deps and doesn't refocus when items change, close-fallback selector matches any button in the block | S | — |
| MAINT-175 | MAINT | Frontend — `BlockPropertyEditor` leaves popup at last position on `computePosition` failure; `suggestion-renderer.ts` (off-screen fallback) is the better pattern. Extract a shared `applySafePosition` helper | S | — |
| MAINT-176 | MAINT | Frontend — `use-roving-editor.ts:391` dispatches the suggestion-exit transaction without try/catch; `replaceDocSilently()` then runs against a possibly-corrupt plugin state if dispatch throws | S | — |
| MAINT-177 | MAINT | Frontend — `BugReportDialog.handleSubmit` doesn't catch `openUrl()` failures; the dialog still closes with a success toast even when the GitHub issue page never opened. Add a copy-the-URL fallback on error | S | — |
| MAINT-178 | MAINT | Frontend — `BootGate` error screen has only Retry; for unrecoverable failures (corrupted DB, permission denied, missing migration) the user is stuck. Add a diagnostics escape hatch (show `error.cause` chain, copy logs, launch bug-report) | S | — |
| MAINT-180 | MAINT | Frontend — `SpaceManageDialog` — each `SpaceRowEditor` mount fires emptiness-probe + journal-template `listBlocks` IPCs with no dedup; reopening the dialog re-fetches the same data per row | S | — |
| MAINT-181 | MAINT | Frontend — `PropertyRowEditor.handleOpenRefPicker` opens the picker even when `listBlocks` rejects; user sees an empty picker with no failure indicator. Move `setRefPickerOpen(true)` into `.then()` | S | — |
| MAINT-183 | MAINT | Frontend — `markdown-serialize.ts` header claims "zero external dependencies" but file imports `sonner`, `logger`, `i18n`. Either rewrite the header or move the toast/i18n side effect to a wrapper at the call site | S | — |
| MAINT-184 | MAINT | Frontend — `block-link-picker.ts` and `block-ref-picker.ts` each duplicate ~70% of resolve-and-insert logic between their InputRule handler and their `resolve*FromSelection` command. Extract a shared helper | S | — |
| MAINT-185 | MAINT | Frontend — `use-block-keyboard.ts:275-335` `handleKeyDown` callback has 16 deps; depends on parent-callback memoization. Switch to the refs-bag pattern already used in `use-roving-editor.ts:258-289` for stable listener identity | S | — |
| MAINT-189 | MAINT | Frontend — `PropertyValuePicker.tsx:42-49` calls `listPropertyKeys()` once per component mount with no shared cache; multiple instances on the same view re-fetch. Add a `usePropertyKeysCache` hook | S | — |
| MAINT-190 | MAINT | Frontend — `FilterPillRow.tsx:104-105` uses `key={index}` with a `biome-ignore` because `getFilterKey()` can collide; make the key collision-free instead of relying on the workaround | S | — |
| MAINT-192 | MAINT | Documentation — UX.md / AGENTS.md additions to reduce false-positive churn on future reviews: (a) UX.md Common-Pitfall "`setState` after unmount in React 18+ is no longer a defect"; (b) UX.md Lesson-Learned "Reading store state inside callbacks via `useStore.getState()` is intentional"; (c) AGENTS.md mandatory-pattern: picker debouncing convention; (d) AGENTS.md reference `INTERNAL_PROPERTY_KEYS` (see MAINT-187) | S | — |
| MAINT-193 | MAINT | zizmor baseline triage — 53 GitHub Actions findings suppressed by file:line in `.github/zizmor.yml` when the `zizmor` pre-commit hook was first wired in. Mix of policy-level (`unpinned-uses` × 35: tags vs SHAs) and real fixes (`template-injection` × 6 in `release-tag.yml` — pass `inputs.version` via `env:` instead of `${{ }}` interpolation; `excessive-permissions` × 1 in `release.yml`; `cache-poisoning` × 11; `artipacked` × 7). Triage off the baseline as fixes land. | M | — |
| PERF-19 | PERF | Backlink pagination cursor uses linear scan for non-Created sorts (2 sites) | S | — |
| PERF-20 | PERF | Backlink filter resolver has no concurrency cap on `try_join_all` | S | — |
| PUB-3 | PUB | Employer IP clearance before public release | S | Employer review |
| PUB-5 | PUB | Tauri updater — endpoint URL pinned to `jfolcini/agaric`; remaining work is user-only (generate Minisign keypair, paste pubkey into `tauri.conf.json`, add 2 GH Actions secrets, uncomment env vars in `release.yml`) | S | User-only |
| PUB-8 | PUB | Android release keystore + 4 GH Actions secrets (apksigner wiring already shipped in `release.yml`) | S | User-only |
| TEST-3 | TEST | Brittle `err.to_string().contains(...)` / event-message `.contains(...)` assertions instead of `matches!(AppError::Variant(_))` (11 in `block_cmd_tests.rs`, 9 in `sync_daemon/tests.rs`) | S | — |
| TEST-4 | TEST | Sync daemon tests use 18 fixed sleeps (50–800ms) as race-prone "barriers" because no `wait_for_*` helper exists on `SyncDaemon` / `SyncScheduler` | M | — |
| TEST-6 | TEST | Sync merge tests assert on counter only, not materialized state (`merge_resolves_property_conflict_lww` doesn't query `block_properties`; `merge_block_conflict_creates_copy` doesn't query `blocks` for the conflict copy) | S | — |
| TEST-8 | TEST | TOFU test only covers acceptance, not rejection on cert-hash mismatch on reconnect (`inmem_handle_incoming_sync_tofu_stores_cert_hash`) | S | — |
| TEST-10 | TEST | Snapshot tests missing redactions of non-deterministic fields: `snapshot_history_entry_response` (cursor), `snapshot_list_blocks_response` (comment promises but no redaction call) | S | — |
| TEST-11 | TEST | Missing error-path test coverage: `export_page_markdown_inner` has 6 happy-path tests + 0 error tests; `set_property_inner` integration tests miss invalid-key / type-mismatch Validation cases | S | — |
| TEST-16 | TEST | Recurrence integration tests don't exercise year-boundary transitions (Dec 31 + 1 day → Jan 1 next year) — only unit tests cover DST/leap year | S | — |
| TEST-18 | TEST | Backlink non-grouped tests use `setup_backlinks()` orphan sources (no parent_id), so they never exercise self-reference filtering; sort tests don't assert `total_count`/`filtered_count` | S | — |
| TEST-23 | TEST | 6 copy-pasted `*_paginates_with_cursor` tests in `pagination/tests.rs` (lines 720, 877, 1550, 1702, 1911, 2032) — identical 3-page-loop pattern | S | — |
| TEST-24 | TEST | 13 `tokio::time::sleep(Duration::from_millis(2))` for op-log timestamp separation in `undo_redo_tests.rs` — replace with deterministic `op_log::append_local_op_at` calls | S | — |
| TEST-25 | TEST | ~12 near-identical FEAT-3p4 space-scoping tests in `agenda_cmd_tests.rs` (lines 2268–2812) — extract `seed_two_spaces` helper | S | — |
| TEST-27 | TEST | `count_set_property_ops_for_key` helper uses `LIKE '%"key":"X"%'` on JSON payloads — fragile to JSON whitespace changes | S | — |
| TEST-28 | TEST | `test_connection_pair()` bypasses real TLS (in-memory duplex with `peer_cert_hash_val: None`) — needs documenting so callers don't think they're testing mTLS | S | — |
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
| UX-300 | UX | Code-block language selector lacks search/filter | S | — |
| UX-302 | UX | Multi-selection has no visible feedback on selected blocks | S | — |
| UX-304 | UX | Swipe-to-delete (mobile) has no visual affordance or threshold cue | S | — |
| UX-305 | UX | Drag handle on touch has 250 ms long-press requirement, no hint | S | — |
| UX-306 | UX | Touch gutter "More actions" menu doesn't preview hidden actions | S | — |
| UX-307 | UX | `LinkEditPopover` doesn't auto-focus label field on Ctrl+K with selection | S | — |
| UX-308 | UX | New attachment count badge isn't animated on drop/paste | S | — |
| UX-309 | UX | Slash command palette is not discoverable to new users | S | — |
| UX-310 | UX | `@` / `[[` / `((` / `#[…]` triggers not surfaced anywhere visible | S | — |
| UX-311 | UX | Picker "Create new" item is faintly tinted, lost on long mobile lists | S | — |
| UX-312 | UX | Picker "No results" state has no next-step guidance | S | — |
| UX-313 | UX | Broken-link "click to remove" is hover-only (no touch affordance) | S | — |
| UX-314 | UX | Slash auto-execute (200 ms after 3 chars + unique match) can fire unintentionally | S | — |
| UX-315 | UX | Picker keyboard navigation not documented inline | S | — |
| UX-316 | UX | Inline `{{query …}}` expression syntax is cryptic to read | S | — |
| UX-317 | UX | Query operator symbols (≤, ≥, ≠) presented without text labels | S | — |
| UX-318 | UX | Query result table column auto-detection silently hides empty columns | S | — |
| UX-319 | UX | Task cycle is locked to TODO→DOING→DONE→CANCELLED→none with rationale not surfaced | S | — |
| UX-320 | UX | Repeating-task `++` / `.+` syntax is cryptic in the property drawer | S | — |
| UX-321 | UX | Property "+N" overflow chip looks like a badge, not a button | S | — |
| UX-322 | UX | `useDateInput.isParsing` is exposed but never rendered in property drawer | S | — |
| UX-323 | UX | Agenda filter popover dense (8 dimensions × nested presets) | S | — |
| UX-324 | UX | Due Panel filter pills (All / Due / Scheduled / Properties) are unlabelled | S | — |
| UX-325 | UX | `F-37` "DONE warning when block has `blocked_by`" is documented but not implemented | S | — |
| UX-327 | UX | Calendar dot fetch is silent (no skeleton / no busy state) | S | — |
| UX-330 | UX | Daily-view empty state doesn't mention `/` or templates | S | — |
| UX-332 | UX | PageBrowser sort preference persists silently — no UI cue | S | — |
| UX-333 | UX | "+" button on namespace folders hidden until hover on desktop | S | — |
| UX-334 | UX | TemplatesView "remove template" × hidden until hover (destructive) | S | — |
| UX-336 | UX | CJK search notice doesn't explain the 3-char workaround | S | — |
| UX-337 | UX | Disabled `SearchablePopover` trigger has no tooltip explaining why | S | — |
| UX-338 | UX | Search placeholder doesn't mention minimum character count | S | — |
| UX-339 | UX | Property definition options editor has no JSON validation feedback | S | — |
| UX-340 | UX | Tag filter loading state hidden when stale results present | S | — |
| UX-343 | UX | Trash batch-restore confirmation threshold (5) is undiscoverable | S | — |
| UX-344 | UX | Property definition delete button hidden until hover (desktop) | S | — |
| UX-345 | UX | History "Restore to here" vs "Revert selected" terminology overlaps | S | — |
| UX-346 | UX | Vim-style `j`/`k` nav has no touch alternative | S | — |
| UX-347 | UX | Conflict "Keep Incoming" / "Discard Incoming" is ambiguous | S | — |
| UX-349 | UX | Conflict type badges differ only by colour | S | — |
| UX-350 | UX | History op-type filter has no in-UI explanation | S | — |
| UX-351 | UX | Non-reversible history entries marked only by `opacity-50` + lock icon | S | — |
| UX-352 | UX | `CompactionCard` collapsed by default at top of HistoryView | S | — |
| UX-354 | UX | Graph filter bar has no on-touch affordance | S | — |
| UX-355 | UX | Graph node Enter/Space activation is undocumented | S | — |
| UX-357 | UX | Graph node labels truncated at 20 chars without `<title>` tooltip | S | — |
| UX-358 | UX | `PageHeaderMenu` mixes benign and destructive actions in one popover | S | — |
| UX-359 | UX | Page title in rich-display mode (with chips) lacks edit affordance | S | — |
| UX-362 | UX | Block zoom has no visible "Exit zoom" affordance (Escape only) | S | — |
| UX-363 | UX | `LinkedReferences` / `UnlinkedReferences` filter trigger has no visible label | S | — |
| UX-364 | UX | `SpaceSwitcher` trigger reads as a label, not a switcher | S | — |
| UX-365 | UX | Spaces onboarding banner only inside `SpaceManageDialog` | S | — |
| UX-366 | UX | Cross-space `[[link]]` chips render with literal "Broken link" tooltip | S | — |
| UX-368 | UX | Digit hotkeys (Ctrl+1..9) hint only inside dropdown rows | S | — |
| UX-369 | UX | History "All spaces" toggle resets every session | S | — |
| UX-370 | UX | Space delete-when-empty signalled only via tooltip | S | — |
| UX-371 | UX | Per-space journal template buried in Manage Spaces | S | — |
| UX-372 | UX | `SpaceAccentBadge` click cycles silently with no hover affordance | S | — |
| UX-373 | UX | Single-space state confusing | S | — |
| UX-374 | UX | Onboarding banner not re-showable after dismiss | S | — |
| UX-375 | UX | Per-space journal template variables undocumented in-app | S | — |
| UX-376 | UX | Pairing dialog defaults to manual passphrase, no QR recommendation | S | — |
| UX-378 | UX | Manual peer-address input has no real-time validation | S | — |
| UX-379 | UX | Sidebar "last synced" timestamp hidden when sidebar collapses | S | — |
| UX-380 | UX | Sync "no peers" gray indistinguishable from offline gray | S | — |
| UX-381 | UX | Settings has 9 tabs with no breadcrumb anywhere | S | — |
| UX-382 | UX | Welcome modal omits Sync / multi-device story | S | — |
| UX-383 | UX | Bug Report redact toggle nested under "Include logs" with `pl-6` | S | — |
| UX-384 | UX | Import progress shows file count, not bytes / blocks | S | — |
| UX-385 | UX | Export ZIP filename doesn't include space name | S | — |
| UX-386 | UX | Keyboard conflict warnings inline below row (mobile-unfriendly) | S | — |
| UX-387 | UX | Sidebar theme button cycles 7 themes silently | S | — |
| UX-388 | UX | Keyboard help panel has no search / filter for ~77 shortcuts | S | — |
| UX-389 | UX | Help-panel category headers don't stick on scroll | S | — |
| UX-390 | UX | Custom shortcut input has no documented format | S | — |
| UX-391 | UX | Custom shortcut input accepts any non-empty string with no validation | S | — |
| UX-392 | UX | Conflict warning rendered below row, not inline with keys | S | — |
| UX-393 | UX | "Customized" badge in keyboard settings is plain text-primary | S | — |
| UX-394 | UX | `findConflicts` ignores the `condition` field — false positives | S | — |
| UX-395 | UX | Help panel footer button "Customize shortcuts" doesn't indicate it leaves the panel | S | — |
| UX-397 | UX | Help panel doesn't badge customized shortcuts | S | — |

### Quick wins (S-cost, ready to grab)

These can be tackled in a single session with low risk — listed for prioritization convenience (canonical entries remain in the per-section detail blocks below):

- **PERF-19** — backlink pagination keyset for non-Created sorts (2 sites)
- **PERF-20** — concurrency cap on `try_join_all` in backlink filter resolver
- **MAINT-114** — workflow consolidation audit (spike-then-commit)
- **MAINT-192** — UX.md / AGENTS.md additions (4 small doc inserts to reduce review false-positive churn)
- **PUB-5** — Tauri updater wiring (user-only: keypair + 2 secrets + uncomment)
- **PUB-8** — Android release keystore + 4 GH Actions secrets (CI wiring already shipped)

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
| `.github/workflows/_validate.yml` (143 LOC) | `workflow_call` | prek-equivalent (lint + fmt + clippy + nextest + vitest + playwright + sqlx offline check + MCP smoke) |
| `.github/workflows/ci.yml` (288 LOC) | push (non-tag) + PR | calls `_validate.yml` → desktop build matrix (ubuntu / windows / macos) + android aarch64/x86_64 build |
| `.github/workflows/release.yml` (~464 LOC) | push `v*` tag | calls `_validate.yml` → verify-version → desktop build matrix + sign + android APK + draft GitHub Release |
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

### MAINT-174 — `BlockContextMenu` hardening cluster (3 small bugs in one file)
- **Domain:** Frontend (block context menu)
- **Location:** `src/components/BlockContextMenu.tsx`
- **What:** Three independent small bugs that share a single file and are best fixed in one session:
  - **Action errors silently close the menu** (lines 249-255): `handleAction` calls `action?.(blockId)` then unconditionally `onClose()`. Sync or async action rejections are swallowed; the menu disappears with no feedback. Wrap in try/catch with `toast.error` + `logger.error` before closing.
  - **First-item focus has empty deps** (lines 181-184): `useEffect(() => itemRefs.current[0]?.focus(), [])` runs once at mount. Items are conditional (zoom-in only when `hasChildren`, history only when `onShowHistory` is passed) — focus can land on an item that's no longer the first visible. Add `groups.length` (or a stable signature) to deps.
  - **Close-fallback selector is overly broad** (lines 135-145): `[data-block-id="${blockId}"] [role="button"]` matches any button in the block (gutter, inline date chip, property chip). After a delete-from-context-menu, focus is unpredictable. Use a stable marker (`data-context-trigger="true"` on the gutter overflow button) and select that.
- **Cost:** S — three small edits in one file.
- **Risk:** Low.
- **Impact:** Medium — improves keyboard UX and error feedback in a heavily-used menu.
- **Status:** Open.

### MAINT-175 — Floating UI position-failure recovery is inconsistent
- **Domain:** Frontend (popups / floating UI)
- **Location:** `src/components/BlockPropertyEditor.tsx:86-104`; reference impl in `src/editor/suggestion-renderer.ts:160-170`.
- **What:** `BlockPropertyEditor` catches `computePosition()` rejections and logs them, but does not reposition the popup, so it stays at whatever its last `style.left/top` was — if the anchor scrolled, the popup floats orphaned. `suggestion-renderer.ts` is the better pattern: keep the popup at `(-9999px, -9999px)` on failure (off-screen, not broken).
- **Cost:** S — extract a shared helper (e.g. `applySafePosition(popup, { x, y } | null)` in `src/lib/`) that applies coordinates if provided and applies the off-screen fallback otherwise. Use from both call sites.
- **Risk:** Low.
- **Impact:** Low–medium — eliminates a class of "popup stuck mid-page" visual bugs without changing happy-path behaviour.
- **Status:** Open.

### MAINT-176 — `use-roving-editor.ts` dispatches the suggestion-exit transaction without try/catch
- **Domain:** Frontend (editor)
- **Location:** `src/editor/use-roving-editor.ts:374-409` (dispatch at `:391`)
- **What:** The dispatch at L391 has no try/catch; if `editor.view.dispatch()` throws (e.g. view torn down between block-switch frames), the subsequent `replaceDocSilently()` runs on possibly-corrupt plugin state. The only guard prior to dispatch is `if (!editor) return` at L376 — there is no `editor.view.isDestroyed` check anywhere in the file.
- **Cost:** S — wrap the dispatch in try/catch with `logger.warn`; add an `editor.view.isDestroyed` check on the catch path (would need to be added, not re-added).
- **Risk:** Low.
- **Impact:** Low — the failure mode is rare in practice but its symptoms (stuck suggestion plugin, ghost popup) are hard to reproduce, so defensive logging is high-leverage.
- **Status:** Open.

### MAINT-177 — `BugReportDialog` swallows `openUrl` failure but reports success
- **Domain:** Frontend (bug report)
- **Location:** `src/components/BugReportDialog.tsx:239-253` ; `src/lib/open-url.ts` (14 lines total)
- **What:** `await openUrl(issueUrl)` is followed by `toast.success(...)` and `onOpenChange(false)`. `openUrl` itself never rejects — on Tauri-shell error it falls back to `window.open(url, '_blank', 'noopener,noreferrer')` silently, and `window.open` returns `null` (it doesn't throw) on popup-block. Result: user has a ZIP on disk, sees a success toast, and no GitHub tab opened.
- **Cost:** S — change `openUrl` to return `Promise<boolean>` reflecting whether the system browser actually opened (check the Tauri shell return + the `window.open(...)` return value); gate the success toast and `onOpenChange(false)` on the boolean. A localised try/catch in the dialog is *not* the fix — `openUrl` cannot reject, so try/catch can never fire.
- **Risk:** Low.
- **Impact:** Medium — the bug-report flow's whole point is for the user to land on the issue page; silently failing it defeats the feature.
- **Status:** Open.

### MAINT-178 — `BootGate` error screen has only a Retry button (no diagnostics escape hatch)
- **Domain:** Frontend (boot)
- **Location:** `src/components/BootGate.tsx:50-79`
- **What:** For unrecoverable failures (corrupted DB, permission-denied data dir, missing migration), Retry just keeps failing. The user has no way to (a) see the underlying error in detail (`error.cause` chain), (b) export logs, (c) launch the bug-report dialog, (d) copy the data-dir path.
- **Cost:** S — add a "Show details / Copy diagnostics" secondary action that opens a textarea with `error.cause` chain + platform info, plus a "Open bug report" link.
- **Risk:** Low.
- **Impact:** Medium — turns an unrecoverable error from "please reinstall" into "here is enough information to file a bug".
- **Status:** Open.

### MAINT-180 — `SpaceManageDialog` rows fire IPCs without dedup or cancellation
- **Domain:** Frontend (spaces management)
- **Location:** `src/components/SpaceManageDialog.tsx:178-200, 213-234`
- **What:** Each `SpaceRowEditor` mount fires an emptiness probe (`listBlocks { spaceId, limit: 1 }`) and a journal-template fetch. Re-opening the dialog re-fetches the same data; the IPCs have no shared cache. The `cancelled` flag prevents stale state writes but doesn't stop the IPCs from crossing the bridge.
- **Cost:** S — lift both probes to the parent dialog, fetch once per `space.id` set, pass results down as props. Optionally add a `useIpcCache` keyed on the IPC name + params.
- **Risk:** Low.
- **Impact:** Low–medium — no user-visible bug today, but the IPC volume scales O(N spaces × M opens).
- **Status:** Open.

### MAINT-181 — `PropertyRowEditor` opens ref picker even when `listBlocks` rejects
- **Domain:** Frontend (property editor)
- **Location:** `src/components/PropertyRowEditor.tsx:237-249`
- **What:** `setRefPickerOpen(true)` runs unconditionally; the IPC `.catch` only logs and toasts. User opens an empty picker labelled "Select page" with no indication anything went wrong.
- **Cost:** S — move `setRefPickerOpen(true)` into the `.then` after `setRefPages(res.items)`.
- **Risk:** Low.
- **Impact:** Low — minor UX cleanup.
- **Status:** Open.

### MAINT-183 — `markdown-serialize.ts` header claims zero-dep but file imports `sonner` / `logger` / `i18n`
- **Domain:** Frontend (editor / serializer)
- **Location:** `src/editor/markdown-serialize.ts:1-15`
- **What:** Header says "Zero external dependencies. O(n) in the document size." File imports `sonner` (line 13), `i18n` (line 14), `logger` (line 15) for the `notifyUnknownNodeType()` warning toast. Either the comment is outdated or the side effect should move out.
- **Cost:** S — preferred fix: convert `notifyUnknownNodeType()` into an `onUnknownNode?: (type: string) => void` callback; the call site in the editor wires the toast. Removes the imports, restores serializer purity for testing.
- **Risk:** Low.
- **Impact:** Low — maintainability + testability.
- **Status:** Open.

### MAINT-184 — Picker async-resolve duplication between InputRule and command paths
- **Domain:** Frontend (editor extensions)
- **Location:** `src/editor/extensions/block-link-picker.ts:48-104` (command) vs `:113-173` (input rule); same shape in `block-ref-picker.ts:44-97` (command) vs `:99-157` (input rule).
- **What:** Each picker has two entry points (input rule when typed, command when invoked from selection) that share ~70% of logic: async items lookup, exact-match check, `onCreate` fallback, plain-text fallback, error handling. Bug fixes need to land in two places per picker.
- **Cost:** S — extract `resolveAndInsertBlockLink(editor, opts, items, onCreate, insertPos)` (and twin for refs) into a small shared helper. Both entry points become 5-line wrappers.
- **Risk:** Low.
- **Impact:** Low–medium — duplication harms velocity and is a known foot-gun (one path was patched without the other in past sessions).
- **Status:** Open.

### MAINT-185 — `use-block-keyboard.ts` keydown callback has 16 deps (relies on parent memoization)
- **Domain:** Frontend (editor)
- **Location:** `src/editor/use-block-keyboard.ts:275-335`
- **What:** `useCallback(handleKeyDown, [16 callbacks])` — listener identity changes whenever any parent callback prop is recreated. Reference pattern (refs-bag) already exists in `use-roving-editor.ts:258-289` — store latest callbacks in a ref, keep the keydown handler stable.
- **Cost:** S — mirror the refs-bag pattern.
- **Risk:** Low.
- **Impact:** Low — most parents already memoize, so the bug rarely surfaces; this is mostly future-proofing.
- **Status:** Open.

### MAINT-189 — `listPropertyKeys()` fetched per-mount in 3 components with no shared cache
- **Domain:** Frontend (filter pickers + backlink panels)
- **Location:** `src/components/PropertyValuePicker.tsx:42-49` ; `src/components/UnlinkedReferences.tsx:147-148` ; `src/components/LinkedReferences.tsx:155-156`
- **What:** All three components call `listPropertyKeys()` from a `useEffect` with empty deps. Multiple instances on the same view (e.g. multiple filter rows + linked + unlinked panels open at once) each call the IPC. The data is small and rarely changes — perfect candidate for a shared cache.
- **Cost:** S — extract `usePropertyKeysCache` (Zustand or context) keyed on `currentSpaceId`; replace 3 per-mount `useEffect` fetches with a single shared cache; invalidate on relevant materializer events.
- **Risk:** Low.
- **Impact:** Low — minor IPC reduction; not user-visible.
- **Status:** Open.

### MAINT-190 — `FilterPillRow` `key={index}` is over-cautious (already prevented by add-time dedup)
- **Domain:** Frontend (filter UI)
- **Location:** `src/components/FilterPillRow.tsx:104-105` ; `src/components/BacklinkFilterBuilder.tsx:42-67` (`getFilterKey`), `:88-102` (`handleAddFilter`)
- **What:** Optional cleanup. The `biome-ignore` comment is defensive — `getFilterKey` already discriminates by all data fields (`PropertyText:${key}:${op}:${value}`, `HasTag:${tag_id}`, etc., with `JSON.stringify(filter)` fallback), and `handleAddFilter` rejects exact duplicates before they reach `FilterPillRow` (`filters.some((f) => getFilterKey(f) === key)`). A genuine collision would require two byte-identical filters past that guard — which the dedup blocks. Note: this overlaps with FE-L-14 in the FE review.
- **Cost:** S — could be removed by stamping a per-add monotonic `id` on each filter at add-time and using that as the React key, but the current biome-ignore is defensible. Low priority.
- **Risk:** Low.
- **Impact:** Low — pre-empts future bugs around filter reorder / animation only.
- **Status:** Open.

### MAINT-192 — UX.md / AGENTS.md additions to reduce false-positive churn on future frontend reviews
- **Domain:** Documentation
- **Location:** `UX.md`, `AGENTS.md`
- **What:** Frontend-wide UX review (the one that filed MAINT-173..MAINT-191 and PERF-28) had a 74% false-positive rate. The bulk of rejected findings pattern-matched against React-class anti-patterns that don't apply to this codebase. Four small doc additions would pre-empt most of that churn:
  - **(a) UX.md "Common Pitfalls"** — add an entry **"`setState` after unmount in React 18+ is no longer a defect"**: React 18 removed the warning and the call is silently dropped; only flag when the late update would leave incorrect *visible* state.
  - **(b) UX.md "Lessons Learned → Data & State"** — add **"Reading store state inside callbacks via `useStore.getState()` is intentional"**: it reads the latest state from the Zustand store, not from the closure, so it is *not* a stale-closure bug.
  - **(c) AGENTS.md "Frontend Development Guidelines → Mandatory patterns"** — add **"Picker debouncing"** entry referencing `useDebouncedCallback` + the 300 ms convention used by `TagFilterPanel`. PERF-28 traces directly to this gap.
  - **(d) AGENTS.md** — under "Properties system is the primary extension point", add a one-line reference to `INTERNAL_PROPERTY_KEYS` in `src/lib/block-utils.ts` (lands together with MAINT-187).
- **Cost:** Trivial — four small doc inserts.
- **Risk:** Low.
- **Impact:** Medium — every future frontend review (human or automated) avoids re-discovering the same false positives.
- **Status:** Open.

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

### TEST-3 — Brittle `err.to_string().contains(...)` and `.contains(...)` on event messages
- **Domain:** Test infrastructure
- **Location:**
  - `src-tauri/src/commands/tests/block_cmd_tests.rs` lines 241-244, 336-338, 378-380, 405-407, 897-899, 1143-1145, 1209-1211, 1982-1984, 2006-2008, 2069-2071, 2198-2200 (11 sites)
  - `src-tauri/src/sync_daemon/tests.rs` lines 885, 979, 1231, 1563, 1622, 1691, 1820, 1902 (8 sites on `SyncEvent::Error.message`) plus line 1063 (`err.to_string().contains("sync cancelled by user")` — error string, not event message)
- **What:** Tests use `.contains("substring")` on error/event message strings instead of `matches!(AppError::Variant(_))` or pinned message equality. If the message text is refactored or i18n-localized, the test silently passes against a different error.
- **Cost:** S — mechanical replace per AGENTS.md convention.
- **Risk:** Low — if a substring check still adds value, keep it but combine with `matches!()` on the error variant (sync_daemon path requires keeping `.contains()` because the event carries an unstructured `message: String`; the block_cmd path can fully migrate to `matches!`).
- **Impact:** Medium — turns silent-pass regressions into hard failures.
- **Status:** Open.

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

### TEST-6 — Sync merge tests assert on counter / conflict-copy block but not the original
- **Domain:** Sync / Merge tests
- **Location:**
  - `src-tauri/src/sync_protocol/tests.rs:1115-1171` (`merge_resolves_property_conflict_lww`) — asserts `results.property_lww > 0` but never queries `block_properties` to confirm the LWW winning value is stored
  - `src-tauri/src/merge/tests.rs:1016-1113` (`merge_block_conflict_creates_copy`) — queries the conflict-copy block via `blocks` (lines 1094-1109) and verifies the original block's text via `dag::text_at` (lines 1078-1090), but never asserts `SELECT content FROM blocks WHERE id = 'B1'` (the original) — so a bug that mutated the original block's row content (instead of leaving it intact) would slip through
- **What:** Tests verify the merge engine's counter outputs and the conflict-copy row, but stop short of confirming the *original* row is untouched and that LWW writes actually land in `block_properties`.
- **Cost:** S — add `SELECT … FROM block_properties WHERE block_id = ? AND key = ?` and `SELECT content FROM blocks WHERE id = 'B1'` assertions.
- **Risk:** Low.
- **Impact:** Medium — these tests are the only coverage for LWW + conflict-copy semantics.
- **Status:** Open.

### TEST-8 — TOFU rejection at the daemon entrypoint is uncovered (TLS-layer rejection IS covered)
- **Domain:** Sync (TLS / pairing)
- **Location:** `src-tauri/src/sync_daemon/tests.rs:1930-2049` (`inmem_handle_incoming_sync_tofu_stores_cert_hash`)
- **What:** The daemon-entrypoint TOFU test only stores the cert hash on first connection; it never reconnects with a *different* cert hash to verify rejection through `handle_incoming_sync`. TLS-layer rejection IS exercised in `src-tauri/src/sync_net/tests.rs:1250` (`mtls_reconnection_with_wrong_cert_hash_fails`) and `:1281` (`mtls_tofu_store_and_verify_round_trip` — `assert!(result.is_err())` at L1336-1338). The application-level rejection path through `handle_incoming_sync` is the actual gap.
- **Cost:** S — extend the test with a second connection attempt using a mismatched hash; assert connection is rejected.
- **Risk:** Low.
- **Impact:** Medium — TOFU behavior is asymmetric (acceptance is trivial; rejection is the property worth verifying).
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

### TEST-11 — Missing error-path coverage on `export_page_markdown_inner` + `set_property_inner`
- **Domain:** Commands / integration tests
- **Location:**
  - `src-tauri/src/commands/tests/page_cmd_tests.rs:326-722` (6 happy-path tests for `export_page_markdown_inner`, 0 error tests)
  - `src-tauri/src/command_integration_tests/property_integration.rs:9` (only the happy-path `set_property_writes_op_log_entry`; broader Validation coverage exists at `:273` `get_batch_properties_empty_ids_returns_validation_error`, `:343-475` date-validation tests on `list_blocks_inner`, `:760-867` `create_property_def_*_returns_validation` tests, and `:124, :172` `delete_property_on_*` NotFound coverage on `delete_property_inner` — but `set_property_inner` itself has no direct error tests)
- **What:** Per AGENTS.md, every command needs error coverage: nonexistent ID → NotFound, deleted block → NotFound, invalid input → Validation. The narrow gap is direct error tests on `set_property_inner` (invalid key / type mismatch / nonexistent block) plus all error coverage on `export_page_markdown_inner`.
- **Cost:** S — add tests with nonexistent page IDs, deleted pages, and invalid property keys / type mismatches.
- **Risk:** Low.
- **Impact:** Medium — Validation paths are easy to break silently when refactoring.
- **Status:** Open.

### TEST-16 — Recurrence integration tests don't exercise year-boundary transitions
- **Domain:** Recurrence tests
- **Location:** `src-tauri/src/recurrence/tests.rs:521-1036` (integration tests section)
- **What:** Unit tests cover DST and leap-year edge cases, but no integration test exercises a daily/weekly recurrence that crosses Dec 31 → Jan 1 of the next year. A bug in year-component arithmetic would not be caught.
- **Cost:** Trivial — `set_due_date_inner(..., "2025-12-31"); set_repeat_property("daily"); mark DONE; assert next.due_date == "2026-01-01"`.
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

### TEST-25 — 16 near-identical FEAT-3p4 space-scoping tests in `agenda_cmd_tests.rs`
- **Domain:** Test infrastructure
- **Location:** `src-tauri/src/commands/tests/agenda_cmd_tests.rs:2268-2812` — 4 `list_undated_tasks_*_feat3p4` (L2268, 2302, 2338, 2361) + 4 `list_projected_agenda_*_feat3p4` (L2439, 2473, 2501, 2526) + 4 `count_agenda_batch_*_feat3p4` (L2593, 2619, 2643, 2665) + 4 `count_agenda_batch_by_source_*_feat3p4` (L2716, 2743, 2764, 2783) = 16 tests total.
- **What:** Sixteen `*_feat3p4` tests follow the same fixture-and-assert pattern (seed two spaces, insert blocks, assign to spaces, call command, assert space filtering). The setup is copy-pasted across all 16 tests.
- **Cost:** S — extract `async fn seed_two_space_blocks(...)` helper.
- **Risk:** Low.
- **Impact:** Low — reduces a copy-paste surface that grows with each new space-aware list query.
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

### TEST-30 — One residual `now_rfc3339()` collision risk in `undo_redo_tests.rs:1525`
- **Domain:** Test infrastructure
- **Location:** `src-tauri/src/commands/tests/undo_redo_tests.rs:1525` (next call at L1558, no sleep between)
- **What:** Originally flagged 3 sites (1187, 1311, 1525); 2 of those already have 2ms sleep guards (line 1224 between L1187 and L1227; line 1348 between L1311 and L1352). Only line 1525 → 1558 has consecutive `now_rfc3339()` without a guard. Consider folding into TEST-24 as a 14th site rather than maintaining as standalone.
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
  - `src/components/__tests__/BlockTree.test.tsx:1246, 3661, 3756, 3779, 3898, 4039, 4861, 5732, 5780, 5798, 5834` (11 bare waits, several before `not.toHaveBeenCalledWith` negatives)
  - `src/components/__tests__/SpaceManageDialog.test.tsx:575, 590, 609, 639` (4)
  - `src/components/__tests__/JournalPage.test.tsx:2826, 2848, 2875` (3)
  - `src/hooks/__tests__/useGraphSimulation.test.ts:349, 368` (2)
  - `src/editor/extensions/__tests__/checkbox-input-rule.test.ts:192, 193` (2)
  - `src/components/__tests__/TagFilterPanel.test.tsx:945` (350ms wall-clock for debounce, with explicit comment "without fake timers")
  - `src/components/__tests__/GraphView.test.tsx:960` (0ms tick, bare)
  - `src/hooks/__tests__/useGraphWorkerSimulation.test.ts:174` (1)
  - `src/components/__tests__/ErrorBoundary.test.tsx:138` (1)
  - `src/components/__tests__/ViewHeader.test.tsx:143` (1)
  - `src/hooks/__tests__/useBlockTreeEventListeners.test.ts:115` (50ms)
- **What:** `src/__tests__/AGENTS.md` lines 187, 254, 261 explicitly forbid `await sleep(n)` patterns in tests ("the flake only looks fixed"). 28 occurrences across 11 files; the dangerous subset is bare 50ms waits used as the only "wait" before `expect(invoke).not.toHaveBeenCalledWith(...)` negatives — a 50ms wait passes trivially if the side effect ever takes longer than 50ms, so the test cannot tell broken from slow.
- **Why it matters:** Negative-assertion tests with bare timeouts give false confidence. Wall-clock waits for debounce (TagFilterPanel:945) waste 350ms per run and add cross-worker timing variance — pitfall #5 in AGENTS.md says exactly this.
- **Cost:** S–M — for negative assertions, await an observable signal first (`await waitFor(() => expect(invoke).toHaveBeenCalledWith('positive_signal', ...))`) then assert absence of the negative one; for debounce, `vi.useFakeTimers()` + `vi.advanceTimersByTime()`. ~13 files to touch.
- **Risk:** Low — converting wall-clock waits to deterministic `waitFor` strictly improves robustness.
- **Impact:** Medium — eliminates an entire class of silent-pass holes.
- **Status:** Open.

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

### TEST-FE-8 — `PairingDialog.test.tsx` uses `document.querySelector('.pairing-error')` for portal content
- **Domain:** Frontend test infrastructure
- **Location:** `src/components/__tests__/PairingDialog.test.tsx:314, 344, 543, 745, 775, 813, 851` (7 sites total — 5 `.pairing-error` at L314/344/745/775/813 and 2 `.pairing-error p` at L543/851)
- **What:** Seven sites across six tests use `document.querySelector('.pairing-error')` (or `.pairing-error p`) to reach error content rendered inside a Radix Portal (outside the React tree). This works (the Portal escapes the React tree, `document.querySelector` reaches it) but couples the tests to the CSS class name.
- **Why it matters:** Per AGENTS.md, accessible queries (`screen.findByText(...)` / `findByRole('alert')`) are preferred. They survive a class-name refactor and express intent better. Worth a quick check that each `.pairing-error` element exposes a stable accessible role/text first — if not, a one-line attribute add to the production component is the right precondition.
- **Cost:** Small — verify accessible-name surface, then swap selectors.
- **Risk:** Low.
- **Impact:** Low.
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


### FE-H-7 — `useCheckboxSyntax`: optimistic update has no rollback on IPC rejection
- **Domain:** Frontend / Editor
- **Location:** `src/hooks/useCheckboxSyntax.ts:38-60`
- **What:** Hook mutates `pageStore` optimistically (lines 58–60) before `setTodoStateCmd()` resolves. On rejection only a toast fires — the UI state stays out of sync with the backend.
- **Cost:** S — capture prior `todo_state` before the optimistic update; revert on rejection.
- **Risk:** Low.
- **Impact:** Medium — user sees the new checkbox state even though the backend never accepted it.
- **Source:** FE review 2026-05-02 / F037
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

### FE-H-21 — `Resolve` store: asymmetric version-bump policy between `set` and `batchSet`
- **Domain:** Frontend / Resolve store
- **Location:** `src/stores/resolve.ts:122` (closure flag declaration), `:226-232` (debounce in `set`), `:235-257` (`batchSet` bumps inline at L255)
- **What:** `set` debounces `version` bumps via a closure flag (`pendingVersionBump` declared at L122) plus a microtask. `batchSet` bumps `version` inline (L255) and never touches the flag. The cache mutations themselves are synchronous and fresh-Map per call, so renders cannot observe mid-update state in either path; the substantive issue is the asymmetric policy between the two writers, not a load-bearing race.
- **Cost:** S.
- **Risk:** Low.
- **Impact:** Low–medium — pick one policy. Demote severity from FE-H to FE-M (the speculative race the original framing described is not reproducible against the synchronous cache code).
- **Recommendation:** Choose one of (a) make `batchSet` use the same closure-flag debounce, or (b) drop the closure-flag debounce and have `set` bump inline like `batchSet`. (b) is simpler.
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

### FE-M-4 — `useHistoryDiffToggle`: `expandedKeys` and `diffCache` in deps cause callback churn
- **Domain:** Frontend / History
- **Location:** `src/hooks/useHistoryDiffToggle.ts:51` (deps: `[expandedKeys, diffCache, keyFn]`); reads at `:20` (`expandedKeys.has(key)`) and `:29` (`diffCache.has(key)`)
- **What:** Both `expandedKeys` and `diffCache` are read inside the callback. Naively dropping them from the deps array (the obvious-looking fix) creates a stale-closure bug — the `.has(...)` reads at L20, L29 would freeze on the values at the time the callback was last created, so the L29 short-circuit (`if (diffCache.has(key)) return`) would no longer prevent re-fetching. The functional-setState forms (`setExpandedKeys((prev) => ...)`) on L21, L28, L38 already avoid the *write-after-stale-read* hazard, but the *reads* still need fresh state.
- **Cost:** Trivial — mirror `expandedKeys` and `diffCache` into refs (`expandedKeysRef`, `diffCacheRef`), read `.has(...)` from `*Ref.current`, and drop both from the deps array. Pattern already used in `useListMultiSelect.ts:51-52`.
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

### FE-M-6 — `useBlockSlashCommands` attach handler: `input.click()` not wrapped in try/catch
- **Domain:** Frontend / Editor
- **Location:** `src/hooks/useBlockSlashCommands.ts:368-396`
- **What:** The single residual issue is `input.click()` at L395 not wrapped in try/catch. (The earlier framing mentioned two other concerns that don't hold: (b) the `if (!file) return` at L372-373 is the user dismissing the file-dialog — a deliberate cancel path, not an error path; (c) `await addAttachment(...)` at L383 is awaited inside the `async onchange` handler — there is nothing to `void`.)
- **Cost:** Trivial — try/catch around `input.click()`; on error, surface a toast and clean up the input element.
- **Risk:** Low.
- **Impact:** Low. Demote severity from FE-M to FE-L (single trivial concern).
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

### FE-M-8 — Property pickers: PropertyValuePicker has no user-facing toast; PropertyDefinitionsList uses `String(error)`
- **Domain:** Frontend / Properties
- **Location:** `src/components/PropertyValuePicker.tsx:42-49`, `src/components/PropertyDefinitionsList.tsx:73-74, 93-94, 106-108`
- **What:** PropertyValuePicker logs the failure via `logger.warn` at L46 (so it is *not* silent to the logger) but surfaces no user-facing toast — the dropdown silently empties from the user's perspective. PropertyDefinitionsList toasts `t('property.errorLoad', { error: String(error) })` etc. — `String({})` is `"[object Object]"` for plain objects (Tauri IPC rejections arrive as plain objects via `serializeError`), so the toast is unhelpful in practice.
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

### FE-M-15 — Picker extensions: validate `insertPos` against current doc before inserting
- **Domain:** Frontend / Editor
- **Location:** `src/editor/extensions/block-link-picker.ts:61-100` (already has try/catch + `logger.warn` fallback), `src/editor/extensions/block-ref-picker.ts:60-91` (same), `src/editor/extensions/at-tag-picker.ts:49-87` (verify before generalising)
- **What:** `insertPos` is captured pre-deletion; user can edit between then and async resolution; `insertContentAt(insertPos, ...)` then targets a stale offset. The basic try/catch + `logger.warn` recommendation is **already implemented** at all three picker sites — `block-link-picker.ts` and `block-ref-picker.ts` wrap `insertContentAt` and fall back to plain text on error. The remaining gap is that `insertContentAt` with a stale offset is more likely to silently *clamp* than to throw, so the existing try/catch may not actually fire.
- **Cost:** S.
- **Risk:** Low.
- **Impact:** Low — race window is narrow.
- **Recommendation:** Before calling `insertContentAt(insertPos, ...)`, validate `insertPos <= editor.state.doc.content.size` and skip the inline insert (fall back to plain text at the current cursor) if the doc has shrunk past it. Verify `at-tag-picker.ts:49-87` follows the same try/catch pattern as the other two before generalising the fix.
- **Source:** FE review 2026-05-02 / F011
- **Status:** Open

### FE-L-1 — `Undo` store: `new Map(state.pages)` boilerplate repeated 9 times
- **Domain:** Frontend / Undo store
- **Location:** `src/stores/undo.ts:127, 145, 163, 191, 216, 289, 332, 358, 366`
- **What:** Nine sites copy `new Map(state.pages)` then `.set()` then setState. Boilerplate is simple, not error-prone, but extracting a `setPageState(pageId, updates)` helper would cut ~40 lines.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F003
- **Status:** Open

### FE-L-2 — `Resolve` store: dedupe the two eviction loops into a helper
- **Domain:** Frontend / Resolve store
- **Location:** `src/stores/resolve.ts:204-211` (eviction in `set`), `:246-253` (eviction in `batchSet`)
- **What:** The "Delete oldest entries (first N entries in Map iteration order)" comment is **already present** at L205 and L247 — the original framing of "no comment" is stale. The remaining cleanup is the duplication of the 6-line eviction loop across `set` and `batchSet`.
- **Cost:** Trivial — extract `evictOldest(cache, MAX_CACHE_SIZE)` and call from both writers.
- **Risk:** Low.
- **Impact:** Low — pure refactor.
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


### FE-L-9 — `useBlockNavigateToLink` ref-indirection contract not documented at the consumer side
- **Domain:** Frontend / Hooks
- **Location:** `src/hooks/useBlockNavigateToLink.ts:55-122`
- **What:** Caller must always read `.current` at call time, never cache. Consider a stable wrapper that does the deref internally.
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low.
- **Source:** FE review 2026-05-02 / F033
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

### FE-L-13 — `UnlinkedReferences` mutates a shared `BacklinkGroup` object inside `setGroups` updater
- **Domain:** Frontend / References
- **Location:** `src/components/UnlinkedReferences.tsx:89-100` (inside `setGroups((prev) => { ... })`)
- **What:** Inside the `cursor`-append branch, `merged = [...prev]` (L90) is a shallow array copy — the `BacklinkGroup` objects inside `merged` are still shared with `prev`. `existing = merged.find((g) => g.page_id === newGroup.page_id)` (L92) gets a reference to a shared object, and `existing.blocks = [...existing.blocks, ...newGroup.blocks]` (L94) reassigns a property on that shared object — `prev`'s view of the same group now also has the new `blocks` array. (The previous "in-place push" framing of this item was incorrect — no `Array.prototype.push` is called on `existing.blocks`; L94 reassigns with a fresh array. The bug is property reassignment on a shared reference, not an in-place push.)
- **Cost:** Trivial.
- **Risk:** Low.
- **Impact:** Low — visible only if anything else still holds a reference to `prev`.
- **Recommendation:** Replace `existing.blocks = ...` with a copy: `const idx = merged.findIndex(g => g.page_id === newGroup.page_id); if (idx >= 0) merged[idx] = { ...merged[idx], blocks: [...merged[idx].blocks, ...newGroup.blocks] }; else merged.push(newGroup);`.
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

### FE-L-15 — `useDebouncedCallback` returns a new object every render
- **Domain:** Frontend / Hooks
- **Location:** `src/hooks/useDebouncedCallback.ts:52`
- **What:** `return { schedule, cancel }` creates a fresh object on every render of the owning component, even though the underlying functions close over stable refs (`timerRef`, `callbackRef`) and therefore have semantically stable behavior. Consumers that put the returned object in a `useCallback` / `useMemo` dependency array will see the dependency change every render and recreate the downstream callback unnecessarily. Flagged by the PERF-28 reviewer: `TagValuePicker.handleChange` (`[onChange, debounced]`) recreates every render; the debounce logic is still correct, just the `useCallback` wrapper ends up being a no-op. `TagFilterPanel` sidesteps the issue by not wrapping the handler in `useCallback` at all — inconsistent pattern between two consumers of the same hook.
- **Fix:** Wrap the return in `useMemo(() => ({ schedule, cancel }), [])`. Since both functions close over refs only (no closure captures of state or props), the empty dep array is safe. Alternatively, move the functions out of the hook body and have them receive `timerRef`/`callbackRef`/`delay` as args — but the `useMemo` version is less invasive.
- **Cost:** Trivial — one `useMemo` wrap + re-run the hook's existing test.
- **Risk:** Low — the returned identity was implicitly "per-render" before, but no known consumer relies on that behavior. A stable identity is the conventional React expectation.
- **Impact:** Low — eliminates the downstream `useCallback` churn in `TagValuePicker` (and any future consumer that does the same). No user-visible change.
- **Source:** PERF-28 reviewer flagged 2026-05-02 (session 609).
- **Status:** Open

## UX — User-experience / usability / discoverability

Items in this section come from a feature-map sweep (one analysis subagent per feature area, then 3 validation subagents that re-read each cited file:line and dropped exaggerations and stale claims). Format follows the compact TEST / FE-L convention. None of these are blocking; they are surface-level fixes (no schema, no op-types, no store changes) that improve discoverability, accessibility, or in-UI feedback.

### UX-300 — Code-block language selector lacks search/filter
- **Domain:** Frontend / Editor
- **Location:** `src/components/CodeLanguageSelector.tsx:21-69`
- **What:** Popover lists 17 languages as a static scrollable list with no filter input. Users have to eyeball-scan; painful on mobile.
- **Cost:** Trivial — add a filter input wired to `match-sorter` (mirrors the page/tag picker pattern).
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.


### UX-302 — Multi-selection styling exists for the static path but not the focused (mounted-editor) path
- **Domain:** Frontend / Editor
- **Location:** `src/components/StaticBlock.tsx:249` (selection styling: `isSelected && 'ring-2 ring-primary/50 bg-primary/5'`); `src/components/EditableBlock.tsx:257` (plumbs `isSelected` into `StaticBlock`); `src/components/EditableBlock.tsx:265-…` (focused / mounted-editor branch — no selection styling)
- **What:** Non-focused selected blocks get a 2-px primary ring + 5%-primary tint via `StaticBlock`. The mounted-editor branch (focused block) does not apply selection styling. In practice the focused block is rarely also "selected" (selection mostly applies to non-focused siblings) so this gap is small. Original framing — "isSelected does not drive any border/background change" — was wrong; only the focused-path is unstyled.
- **Cost:** Trivial — apply matching `ring`/`bg` classes to the focused branch in `EditableBlock`, or leave as-is and close the item if "focused-and-selected" is judged too rare.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-304 — Swipe-to-delete (mobile) has no visual affordance or threshold cue
- **Domain:** Frontend / Editor
- **Location:** `src/hooks/useBlockSwipeActions.ts:1-111` (thresholds at lines 4, 7) ; `src/components/SortableBlock.tsx:350-370`
- **What:** Reveals at 80 px and auto-deletes at 200 px with no visible hint. Users only discover the gesture by accident, and the auto-delete threshold has no progressive cue (color change / "Release to delete" label) before firing.
- **Cost:** S — add a swipe-hint indicator on coarse-pointer devices and a colour/label change at the 200 px threshold.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

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

### UX-307 — `LinkEditPopover` doesn't auto-focus label field on Ctrl+K with selection
- **Domain:** Frontend / Editor
- **Location:** `src/components/LinkEditPopover.tsx:172-181` (label input — no `autoFocus`) vs `:197` (URL input has `autoFocus`)
- **What:** When the user invokes Ctrl+K with a selection, the label is pre-filled but the URL input grabs focus, so Tab is required to edit the label first.
- **Cost:** Trivial — toggle `autoFocus` based on whether selection text was carried in.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-308 — New attachment count badge isn't animated on drop/paste
- **Domain:** Frontend / Editor
- **Location:** `src/components/BlockInlineControls.tsx:326-345` (the `attachment-badge` button)
- **What:** Toast confirms but the inline badge update at `BlockInlineControls.tsx:331` (`attachment-badge … bg-muted text-muted-foreground hover:bg-accent …`) has no animation tied to `attachmentCount` change — no flash/pulse to draw the eye to the just-attached file. (Original Locations cited `AttachmentList.tsx:107-109` (file-size span) and `EditableBlock.tsx:224-244` (drop/paste handlers) — neither contains the count badge; the actual badge lives in `BlockInlineControls`.)
- **Cost:** Trivial — brief CSS animation on count change.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-309 — Slash command palette is not discoverable to new users
- **Domain:** Frontend / Editor
- **Location:** `src/lib/slash-commands.ts` (64 commands across 8 categories: SLASH_COMMANDS body 22 + PRIORITY 3 + HEADING 6 + REPEAT 11 + EFFORT 6 + ASSIGNEE 2 + LOCATION 4 + REPEAT_END 5 + CALLOUT 5; plus dynamic `table:RxC` synthesised at L479) ; `src/editor/extensions/slash-command.ts:1-131`
- **What:** No in-editor hint that `/` opens a palette. New users find this only via `?` keyboard help or by accident.
- **Cost:** Trivial — empty-block placeholder "Type / for commands…"; add a 4th highlight in `WelcomeModal` for reference / slash syntax.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-310 — `@` / `[[` / `((` / `#[…]` triggers not surfaced anywhere visible
- **Domain:** Frontend / Editor
- **Location:** `src/editor/extensions/at-tag-picker.ts` ; `block-link-picker.ts` ; `block-ref-picker.ts` ; `tag-ref.ts`
- **What:** All four syntactic triggers are documented only in the `?` help panel. Without reading docs, the user has no way to discover them.
- **Cost:** S — add a "Reference syntax" highlight in `WelcomeModal` or a dismissible cheat-sheet pinned to first journal page.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-311 — Picker "Create new" item is faintly tinted, lost on long mobile lists
- **Domain:** Frontend / Editor
- **Location:** `src/editor/SuggestionList.tsx:115-122, 159` ; `src/editor/suggestion-renderer.ts:19-27, 64-87`
- **What:** Plus icon + `bg-accent/5` tint is subtle; on mobile with a tall list the create-new option blends in.
- **Cost:** Trivial — stronger background, a "NEW" badge, or always pin to top.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-312 — Picker "No results" state has no next-step guidance
- **Domain:** Frontend / Editor
- **Location:** `src/editor/SuggestionList.tsx:107-113`
- **What:** Renders a plain "No results" string. For `[[` / `@` the user can press Enter to create-new (not signposted); for `((` (block ref) there is no create-new option at all and the user is stuck.
- **Cost:** Trivial — context-aware empty state ("Press Enter to create" / "Block references can only point at existing blocks").
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

### UX-314 — Slash auto-execute (200 ms after 3 chars + unique match) can fire unintentionally
- **Domain:** Frontend / Editor
- **Location:** `src/editor/extensions/slash-command.ts:86-102`
- **What:** When exactly one match remains, the command fires automatically after 200 ms with no visible cue. Surprise factor on fast typists.
- **Cost:** S — visible "auto-runs in 0.2 s — Esc to cancel" indicator, or bump the threshold to 4+ chars.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-315 — Picker keyboard navigation not documented inline
- **Domain:** Frontend / Editor
- **Location:** `src/editor/SuggestionList.tsx:56-66` ; `src/editor/suggestion-renderer.ts:233-264`
- **What:** Pickers support full keyboard nav (Arrow / Home / End / PageUp / PageDown / Enter / Tab / Esc) but it's documented only in the `?` panel.
- **Cost:** Trivial — small "↑↓ navigate · Enter select · Esc close" footer hint, optionally first-use only.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-316 — Inline `{{query …}}` expression syntax is cryptic to read
- **Domain:** Frontend / Queries
- **Location:** `src/components/QueryBuilderModal.tsx:120-148` ; `src/lib/query-utils.ts:30-88`
- **What:** Generated expression is `type:tag expr:project` etc. The pencil-button visual builder hides this behind a modal, but the raw inline form has no plain-English layer.
- **Cost:** S — render a "this query reads as: …" preview in the modal; tooltip on the inline expression pills with human-readable phrasing.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-317 — Query operator symbols (≤, ≥, ≠) presented without text labels
- **Domain:** Frontend / Queries
- **Location:** `src/components/QueryBuilderModal.tsx:50-57` ; `src/lib/query-utils.ts:20-28`
- **What:** Select shows only the symbol; users unfamiliar with the glyphs misread or skip them.
- **Cost:** Trivial — render `"≤  less than or equal to"` etc. as the option text; symbol stays in the trigger.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-318 — Query result table column auto-detection silently hides empty columns
- **Domain:** Frontend / Queries
- **Location:** `src/components/QueryResult.tsx:36-44` ; `src/components/QueryResultTable.tsx:36-45`
- **What:** A column is rendered only if at least one row has the value. Sparse result sets hide columns the user might expect.
- **Cost:** S — show known columns with `—` placeholder for missing values; or add a "show empty columns" toggle.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-319 — Task cycle is locked to TODO→DOING→DONE→CANCELLED→none with rationale not surfaced
- **Domain:** Frontend / Tasks
- **Location:** `src/hooks/useBlockProperties.ts:24-32` (rationale in code comment)
- **What:** Users who don't want CANCELLED in their cycle have no way to opt out, and the locked-cycle decision (UX-201a) is invisible. A short note in Settings → Properties or Keyboard shortcuts panel would set expectations.
- **Cost:** Trivial — one-line tooltip / help text in Settings Properties tab next to the `todo_state` definition.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-320 — Repeating-task `++` / `.+` syntax is cryptic in the property drawer
- **Domain:** Frontend / Tasks
- **Location:** `src/lib/slash-commands.ts:259-280` (slash labels are descriptive); raw form on `repeat` property has no in-UI documentation
- **What:** Slash commands surface "REPEAT DAILY (catch-up)" / "(from completion)" but a user inspecting / editing the `repeat` property directly sees only the cryptic prefix.
- **Cost:** Trivial — `?` popover next to the `repeat` field in `BlockPropertyDrawer` explaining catch-up vs from-completion.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-321 — Property "+N" overflow chip: tooltip mentions count, not the keyboard shortcut; no chevron icon
- **Domain:** Frontend / Properties
- **Location:** `src/components/BlockInlineControls.tsx:305` (className includes `hover:bg-accent hover:text-foreground transition-colors` + `focus-visible:ring-[3px] focus-visible:ring-ring/50` + `active:scale-95`); `:307` (`aria-label={t('block.showAllProperties', { count })}`)
- **What:** The hover background, focus ring, and `active:scale-95` are already present (so the original "no hover background" framing was wrong). The remaining gaps: (a) the tooltip / aria-label mentions the count rather than a keyboard shortcut hint; (b) no ChevronRight / disclosure icon to signal click-through; (c) the visual still resembles a badge more than a button.
- **Cost:** Trivial — extend `aria-label` to include the keyboard shortcut, add a small ChevronRight icon next to the count.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-322 — `useDateInput.isParsing` is exposed but never rendered in property drawer
- **Domain:** Frontend / Properties
- **Location:** `src/hooks/useDateInput.ts:101` ; `src/components/BlockPropertyDrawer.tsx:357-399`
- **What:** Hook exposes a `isParsing` flag for a "parsing…" indicator; drawer never reads it. NL date typing feels silent on slow machines.
- **Cost:** Trivial — render a small spinner / "Parsing…" label in `PropertyRow` when `isParsing`.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-323 — Agenda filter popover dense (8 dimensions × nested presets)
- **Domain:** Frontend / Agenda
- **Location:** `src/components/AgendaFilterBuilder.tsx:155-191`
- **What:** Single popover lists all 8 dimensions; users must drill into each to see preset values. No grouped categories ("Dates" / "Task metadata" / "Organisation") and no quick-pick combos.
- **Cost:** S — group dimensions visually; optionally a small "Quick filters" cluster ("Overdue + TODO", "This week").
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-324 — Due Panel filter pills (All / Due / Scheduled / Properties) are unlabelled
- **Domain:** Frontend / Agenda
- **Location:** `src/components/DuePanelFilters.tsx:32-73`
- **What:** Bare buttons with `aria-pressed`. Users unfamiliar with Agaric's date model don't know the difference between "Due" and "Scheduled".
- **Cost:** Trivial — `Tooltip` per pill explaining each axis.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-325 — F-37 DONE-warning ships for `[x]` syntax + slash commands but not for the gutter-cycle path
- **Domain:** Frontend / Tasks
- **Location:** `src/hooks/useCheckboxSyntax.ts:41-55` (already fires `toast.warning(t('dependency.dependencyWarning'))` on `[x]` cycle to DONE); `src/hooks/useBlockSlashCommands.ts:160-169` (defines `warnIfBlocked`) and `:182-183` (invokes from `handleTodoState` when `state === 'DONE'`); `src/hooks/useBlockProperties.ts:60-92` (`handleToggleTodo` — gutter-cycle path) does **NOT** call `warnIfBlocked` ; `FEATURE-MAP.md:670` (the F-37 entry — accurate, F-37 ships)
- **What:** F-37 is implemented in two of three code paths. Only the gutter-button cycle path (`handleToggleTodo`) bypasses the warning. The original framing — "documented but not implemented" — was wrong; `FEATURE-MAP.md:670` is accurate. Git log: `afb28b7 feat: F-37 — task dependency indicator + DONE warning`.
- **Cost:** S — call `warnIfBlocked` from `useBlockProperties.handleToggleTodo` (mirror the slash-command path).
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.


### UX-327 — Calendar dot fetch is silent (no skeleton / no busy state)
- **Domain:** Frontend / Journal
- **Location:** `src/components/journal/JournalCalendarDropdown.tsx:127-145`
- **What:** `countAgendaBatchBySource` fires async on open and on month-nav with no `aria-busy` or skeleton; the calendar renders empty until dots arrive — looks like a glitch on cold disks.
- **Cost:** Trivial — `aria-busy="true"` on the grid + 4 placeholder dots while loading.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.


### UX-330 — Daily-view empty state doesn't mention `/` or templates
- **Domain:** Frontend / Journal
- **Location:** `src/components/journal/DaySection.tsx:208-223`
- **What:** Generic "Add first block" button. Users don't learn about slash commands or per-space journal templates from this surface.
- **Cost:** Trivial — secondary muted line "Type / for commands · journal templates configurable per space".
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.


### UX-332 — PageBrowser sort preference persists silently — no UI cue
- **Domain:** Frontend / Pages
- **Location:** `src/hooks/usePageBrowserSort.ts:18-19, 43-52`
- **What:** Saved to localStorage on change but nothing in the dropdown signals "this will persist next session".
- **Cost:** Trivial — small "saved" tick on the active option; or one-time toast on first change.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-333 — "+" button on namespace folders hidden until hover on desktop
- **Domain:** Frontend / Pages
- **Location:** `src/components/PageTreeItem.tsx:92-102, 142-152`
- **What:** Desktop: `opacity-0 group-hover:opacity-100`, icon `h-3 w-3`. Touch correctly forced visible. Desktop users can browse for ages without learning the "create sub-page" affordance exists.
- **Cost:** Trivial — show always (slightly larger icon) or add a tooltip on focus / first hover.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-334 — TemplatesView "remove template" × hidden until hover (destructive)
- **Domain:** Frontend / Pages / Templates
- **Location:** `src/components/TemplatesView.tsx:221-234`
- **What:** Same hover pattern; destructive action with very low desktop discoverability and a tiny `h-3.5 w-3.5` icon.
- **Cost:** Trivial — show on focus too; consider a per-row kebab menu for less-common actions.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.


### UX-336 — CJK search notice doesn't explain the 3-char workaround
- **Domain:** Frontend / Search
- **Location:** `src/components/SearchPanel.tsx:415-425`
- **What:** Banner says "CJK search is limited"; user can't tell what to do.
- **Cost:** Trivial — extend copy to mention 3+ character minimum.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-337 — Disabled `SearchablePopover` trigger has no tooltip explaining why
- **Domain:** Frontend / Search
- **Location:** `src/components/SearchablePopover.tsx:109`
- **What:** When disabled (e.g. another filter of the same kind already active), the button greys out silently.
- **Cost:** Trivial — wrap disabled state in a Tooltip with the reason ("Only one page filter at a time").
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-338 — Search placeholder doesn't mention minimum character count
- **Domain:** Frontend / Search
- **Location:** `src/components/SearchPanel.tsx:388-396`
- **What:** Placeholder is just "Search blocks…". The 3-char min is shown only as a separate notice (lines 509-511) once the user has already typed.
- **Cost:** Trivial — placeholder = "Search blocks (3+ chars)".
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-339 — Property definition options editor: single-line `<Input>` accepts JSON without inline validation
- **Domain:** Frontend / Properties view
- **Location:** `src/components/PropertyDefinitionsList.tsx:279-284` (single-line `<Input value={editOptionsValue} onChange={…} placeholder=… aria-label=…/>` — not a multi-line `<textarea>` or JSON editor)
- **What:** The field is a single-line `<Input>` accepting JSON. There is no inline parse / disabled-Save / inline error UI; validation surfaces only on `handleSaveOptions` as a generic toast. (Original framing called it "raw JSON input" which is loose — it's a single-line Input field, not a JSON-editor pane.)
- **Cost:** S — try/catch parse on every change; render a small red "Invalid JSON" line + disable Save until valid.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-340 — Tag filter loading state hidden when stale results present
- **Domain:** Frontend / Tags
- **Location:** `src/components/TagFilterPanel.tsx:427-429`
- **What:** `LoadingSkeleton` rendered only when `results.length === 0`. Switching mode (AND/OR/NOT) keeps stale results visible while the new query runs.
- **Cost:** Trivial — render skeleton (or dim list with spinner) whenever `loading`, not only when empty.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-343 — Trash batch-restore confirmation threshold (5) is undiscoverable
- **Domain:** Frontend / Trash
- **Location:** `src/components/TrashView.tsx:96-99, 191-197` (`BATCH_RESTORE_CONFIRM_THRESHOLD = 5`)
- **What:** Restoring 5 items is silent, restoring 6 prompts. Surprising boundary; not documented anywhere visible.
- **Cost:** Trivial — either confirm always (matches batch-purge), or surface the threshold in a tooltip ("Confirms above 5 items").
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-344 — Property definition delete button hidden until hover (desktop)
- **Domain:** Frontend / Properties view
- **Location:** `src/components/PropertyDefinitionsList.tsx:301-309`
- **What:** Same `opacity-0 group-hover` pattern as PageTreeItem / TemplatesView. Touch is fine; desktop is poor.
- **Cost:** Trivial — show on focus + always-visible-on-mobile is already done; just drop `opacity-0` from desktop class set, or show on `:focus-within` of the row.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-345 — History: displayed label is already "Restore to this point"; only the i18n key name + the per-entry-vs-point-in-time terminology gap remains
- **Domain:** Frontend / History
- **Location:** `src/components/HistoryListItem.tsx:293` ; `HistoryRestoreDialog.tsx:70` ; `HistoryRevertDialog.tsx:61` ; `src/lib/i18n/conflicts.ts:215-230` (key `history.restoreToHereLabel` resolves to displayed string `"Restore to this point"`; tooltip `"Revert all operations after this point"`)
- **What:** The displayed string is already "Restore to this point" — the original "Restore to here" framing was based on the i18n KEY name, which still says `restoreToHere`. The remaining concern is that "Restore to this point" and "Revert selected" still read as synonyms even though they do different things (point-in-time vs per-entry inverse ops).
- **Cost:** Trivial — rename to "Reset to this point" (one word change) and add a clarifying subtitle: "Undoes every operation after this point — use 'Revert selected' for individual entries." Optionally rename the i18n key from `restoreToHereLabel` to `resetToPointLabel` to reduce future confusion.
- **Risk:** Low.
- **Impact:** Low–medium.
- **Status:** Open.

### UX-346 — Vim-style `j`/`k` nav has no touch alternative
- **Domain:** Frontend / History
- **Location:** `src/hooks/useHistoryKeyboardNav.ts:57, 74` (vim mode)
- **What:** Navigation is keyboard-only on touch devices.
- **Cost:** S — render persistent ↑/↓ arrow buttons in the toolbar on coarse-pointer devices; or rely on existing list selection by tap.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-347 — Conflict "Keep Incoming" / "Discard Incoming" is ambiguous
- **Domain:** Frontend / Conflicts
- **Location:** `src/components/ConflictListItem.tsx:25-26, 99-100, 218-222` ; `src/lib/i18n/conflicts.ts:25-26, 48-51`
- **What:** "Incoming" doesn't make clear which version overwrites the other. Help text exists but only on hover.
- **Cost:** Trivial — relabel to "Use incoming" / "Reject incoming"; one-line subtitle under each button.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.


### UX-349 — Conflict type badges differ only by colour
- **Domain:** Frontend / Conflicts
- **Location:** `src/components/ConflictListItem.tsx:40-49, 145-152`
- **What:** Three colour-coded badges (text / property / move). Color-blind users distinguish by text label only; tooltip is hover-only.
- **Cost:** Trivial — add per-type icon (Pencil / Settings / ArrowRight).
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-350 — History op-type filter has no in-UI explanation
- **Domain:** Frontend / History
- **Location:** `src/components/HistoryFilterBar.tsx:77-100`
- **What:** 12 op types in a Select; new users have no idea what `restore_block` vs `delete_block` vs `purge_block` means.
- **Cost:** Trivial — `?` icon next to the Select with a popover legend.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-351 — Non-reversible history entries marked only by `opacity-50` + lock icon
- **Domain:** Frontend / History (a11y)
- **Location:** `src/components/HistoryListItem.tsx:230, 314-329`
- **What:** Single-cue (opacity) presentation risks WCAG contrast failure; the lock icon helps but is small.
- **Cost:** Trivial — secondary text label "Non-reversible" + retain icon; ensure body remains contrast-compliant.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-352 — `CompactionCard` collapsed by default at top of HistoryView
- **Domain:** Frontend / Compaction
- **Location:** `src/components/CompactionCard.tsx:23, 65-71` ; `HistoryView.tsx:166`
- **What:** Action surface is invisible on cold load; users may never see it. Once eligible-ops > 0, the user should be nudged.
- **Cost:** Trivial — auto-expand when `eligible > 0`, or render a small badge on the collapsed header.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.


### UX-354 — Graph filter bar has no leading "Filters" label / on-touch affordance
- **Domain:** Frontend / Graph
- **Location:** `src/components/GraphView.tsx:179-191` (wrapper className `'absolute top-2 left-2 right-2 z-10 max-w-[calc(100%-1rem)]'` — full-width, right-edge anchored, NOT just `top-2 left-2` as earlier framing said) ; `GraphFilterBar.tsx` (component body — too broad to cite the whole file)
- **What:** The bar spans the full width of the graph view but has no leading "Filters" label or first-touch hint. Earlier framing described position as "absolute top-2 left-2 (single-line, easy to miss)" — incomplete; the bar IS full-width.
- **Cost:** Trivial — small "Filters" label or info banner on first touch render.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-355 — Graph node Enter/Space activation is undocumented
- **Domain:** Frontend / Graph
- **Location:** `src/lib/graph-sim-helpers.ts:140-162` ; `src/components/GraphView.tsx:223-228`
- **What:** Nodes are activatable but the SVG carries only `aria-label="Graph"`. Keyboard users may not realise nodes are interactive.
- **Cost:** Trivial — `aria-describedby` on the SVG with a one-line keyboard hint.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.


### UX-357 — Graph node labels truncated at 20 chars without `<title>` tooltip
- **Domain:** Frontend / Graph
- **Location:** `src/lib/graph-sim-helpers.ts:120-140`
- **What:** Long page names render as `prefix…` with no native tooltip; nodes become unidentifiable.
- **Cost:** Trivial — `<title>{fullLabel}</title>` inside each node `<g>`.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-358 — `PageHeaderMenu` co-locates destructive Delete with benign actions in one popover
- **Domain:** Frontend / Page editor
- **Location:** `src/components/PageHeaderMenu.tsx:151-281` (popover entries top-to-bottom: Open in New Tab L162-174 → Add Alias → Add Tag → Add Property → `<hr>` → Toggle Template → Toggle Journal Template → `<hr>` → Export → `<hr>` (when `showMoveEntry`) → Move To submenu → `<hr>` L271 → Delete L272-279)
- **What:** The Delete button sits at the **end** of the popover, after the Move-To submenu and a separator at L271 — Open in New Tab is at the **top** at L164, with multiple entries and `<hr>` separators between them. (Earlier framing — "one `<hr>` away from Open in New Tab" — was geographically wrong; they bookend the menu.) The structural concern (destructive + benign in one popover, easy to misclick on mobile) is still real.
- **Cost:** S — visually separate the destructive Delete (background tint or separate sub-section); enforce a confirmation dialog with type-to-confirm for Delete.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-359 — Page title in rich-display mode (with chips) lacks edit affordance
- **Domain:** Frontend / Page editor
- **Location:** `src/components/PageTitleEditor.tsx:66-100`
- **What:** Read-only-looking chip rendering with no hover hint, no pencil icon, no `cursor-text`. Only signal is that clicking happens to switch modes.
- **Cost:** Trivial — `cursor-text` on hover + faint border / pencil icon on hover/focus.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-362 — Block zoom has no visible "Exit zoom" affordance (Escape only)
- **Domain:** Frontend / Page editor
- **Location:** `src/components/BlockZoomBar.tsx` ; `src/hooks/useBlockTreeKeyboardShortcuts.ts:127-151`
- **What:** Escape key exits zoom (good) but the breadcrumb has no "Exit zoom" button or label that signals how to leave on touch.
- **Cost:** Trivial — small "Exit zoom" button next to the home crumb on coarse pointer.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-363 — `LinkedReferences` / `UnlinkedReferences` filter trigger has no visible label
- **Domain:** Frontend / Page editor
- **Location:** `src/components/LinkedReferences.tsx:316-320, 329-335` ; `src/components/UnlinkedReferences.tsx:298-302`
- **What:** SlidersHorizontal icon button with `aria-label` and an active-count badge — but no text label. (Validator confirmed the count badge IS present; the only gap is a visible "Filters" label.)
- **Cost:** Trivial — short "Filters" text on desktop, icon-only on mobile.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-364 — `SpaceSwitcher` trigger reads as a label, not a switcher
- **Domain:** Frontend / Spaces
- **Location:** `src/components/SpaceSwitcher.tsx:105-126` (Radix `<SelectTrigger>` does render a chevron by default; the gap is the leading text)
- **What:** Replaces the static "Agaric" branding with the bare space name. No "Space:" prefix or accent micro-icon.
- **Cost:** Trivial — render a small `<SpaceAccentBadge>` + "Personal" pattern in the trigger; or prefix "Space:".
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-365 — Spaces onboarding banner only inside `SpaceManageDialog`
- **Domain:** Frontend / Spaces / Onboarding
- **Location:** `src/components/SpaceManageDialog.tsx:614-630, 645-648` ; `src/lib/i18n/common.ts:67-71`
- **What:** Visible only after the user opens Manage Spaces. New users may never reach it.
- **Cost:** S — surface the same banner in `WelcomeModal` (4th highlight) or as a one-time tooltip on the SpaceSwitcher trigger.
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


### UX-368 — Digit hotkeys (Ctrl+1..9) hint only inside dropdown rows
- **Domain:** Frontend / Spaces
- **Location:** `src/components/SpaceSwitcher.tsx:136-152` ; `src/hooks/useAppKeyboardShortcuts.ts:279-295`
- **What:** Trigger tooltip mentions "Ctrl+1..9" but doesn't list mappings. Once dropdown closes the user has to re-open to find a mapping.
- **Cost:** Trivial — extend the trigger tooltip to enumerate the first 5 mappings ("Ctrl+1 Personal · Ctrl+2 Work · …").
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-369 — History "All spaces" toggle resets every session
- **Domain:** Frontend / Spaces / History
- **Location:** `src/components/HistoryView.tsx:45-48` (deliberate per spec — non-persistent by design)
- **What:** Power users who routinely audit cross-space history must re-flip every visit. Either persist with a clear visual indicator, or accept the friction.
- **Cost:** Trivial — opt-in localStorage persistence guarded by an explicit settings toggle.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open. (Deliberate design — listed for visibility.)

### UX-370 — Space delete-when-empty signalled only via tooltip
- **Domain:** Frontend / Spaces
- **Location:** `src/components/SpaceManageDialog.tsx:176-204, 331-337`
- **What:** Disabled button reason is in a Tooltip only. No inline page-count or hint about what to do first.
- **Cost:** Trivial — small "(<N> pages)" badge next to disabled Delete; or inline help line under the row.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-371 — Per-space journal template buried in Manage Spaces
- **Domain:** Frontend / Spaces / Journal
- **Location:** `src/components/SpaceManageDialog.tsx:425-444`
- **What:** Powerful feature with no entry from the Journal view itself. Users probably never find it.
- **Cost:** S — small "Configure template" entry in `JournalPage` kebab menu that deep-links to `SpaceManageDialog` for the current space.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-372 — `SpaceAccentBadge` visible `title` attribute shows only space name (no click-to-cycle hint)
- **Domain:** Frontend / Spaces
- **Location:** `src/components/SpaceAccentBadge.tsx:101-128` (className includes `'transition-shadow duration-fast hover:ring-2 hover:ring-ring/30'` at L123 and `'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'` at L119; `aria-label={t('space.accentBadge', { name: space.name })}` at L105 → resolves via `common.ts:72` to `'{{name}} space — click to switch'`; visible `title={space.name}` at L106) ; `src/components/AppSidebar.tsx:138-142`
- **What:** Hover ring (`hover:ring-2 hover:ring-ring/30`) is **already present**. Aria-label already says "click to switch". Only the visible `title` attribute is silent on the action — sighted users without screen readers see only the bare space name. (Earlier framing — "no hover affordance" / "cycles silently" — was wrong.)
- **Cost:** Trivial — extend the visible `title` attribute to include "click to switch" or similar (e.g. `title={t('space.accentBadgeTitle', { name: space.name })}`).
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-373 — Single-space state confusing
- **Domain:** Frontend / Spaces
- **Location:** `src/components/SpaceSwitcher.tsx:62-173` ; `src/components/SpaceAccentBadge.tsx:66-78`
- **What:** With one space, the switcher dropdown is essentially a no-op and the cycle-badge does nothing on click. No nudge to create a second space.
- **Cost:** Trivial — render a "Create another space" inline hint when `availableSpaces.length === 1`.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-374 — Onboarding banner not re-showable after dismiss
- **Domain:** Frontend / Spaces / Onboarding
- **Location:** `src/components/SpaceManageDialog.tsx:113-127, 650-653` (`agaric:space-onboarding-seen-v1` localStorage flag)
- **What:** Once dismissed, no in-app way to re-show. Users who clicked through too fast lose the explanation forever.
- **Cost:** Trivial — "Reset onboarding" button somewhere in Settings → General.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-375 — Per-space journal template variables undocumented in-app
- **Domain:** Frontend / Spaces / Journal
- **Location:** `src/components/SpaceManageDialog.tsx:425-444`
- **What:** Placeholder mentions `<% today %>`, `<% time %>`, etc. but no examples or live preview.
- **Cost:** Trivial — collapsible "Examples" panel with 1–2 sample templates, optional "preview for today" rendered inline.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-376 — Pairing dialog defaults to manual passphrase, no QR recommendation
- **Domain:** Frontend / Sync
- **Location:** `src/components/PairingDialog.tsx:62` ; `src/components/PairingEntryForm.tsx:147-166`
- **What:** Two equally-prominent buttons; QR is faster but not signposted as recommended.
- **Cost:** Trivial — "Recommended" badge on QR button; reorder so QR is first.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.


### UX-378 — Manual peer-address input has no real-time validation
- **Domain:** Frontend / Sync
- **Location:** `src/components/PeerListItem.tsx:49-64, 122-159`
- **What:** Format hint is `text-xs` and easily missed; invalid `host:port` only surfaces on Save.
- **Cost:** Trivial — debounced validation with inline error text below the input.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-379 — Sidebar "last synced" timestamp hidden when sidebar collapses
- **Domain:** Frontend / Sync
- **Location:** `src/components/AppSidebar.tsx:233-240` (`group-data-[collapsible=icon]:hidden`)
- **What:** Dot stays visible but the timestamp disappears in icon mode — user can't tell "idle for 3 minutes" from "idle for 3 hours".
- **Cost:** Trivial — fold the timestamp into the sync button's `Tooltip` so it's accessible in both modes.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-380 — Sync "no peers" gray indistinguishable from offline gray
- **Domain:** Frontend / Sync
- **Location:** `src/components/AppSidebar.tsx:44-59`
- **What:** Both states return `bg-muted-foreground`. A pairing problem looks identical to a network problem.
- **Cost:** Trivial — distinct token (e.g. `bg-status-pending` for "no peers").
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-381 — Settings has 9 tabs with no breadcrumb anywhere
- **Domain:** Frontend / Settings
- **Location:** `src/components/SettingsView.tsx:140-163`
- **What:** Sidebar entry "Settings" doesn't show the active tab. After navigating away and back, users have to scan the tab strip to remember where they were (even though the tab IS restored from localStorage).
- **Cost:** Trivial — append the active tab name to the sidebar entry, or render a small breadcrumb in Settings header.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-382 — Welcome modal omits Sync / multi-device story
- **Domain:** Frontend / Onboarding
- **Location:** `src/components/WelcomeModal.tsx:39-55`
- **What:** Three highlights (Blocks, Shortcuts, Tags) skip what is arguably Agaric's biggest differentiator.
- **Cost:** Trivial — add a 4th "Sync across devices" highlight or replace one of the existing.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-383 — Bug Report redact toggle nested under "Include logs" with `pl-6`
- **Domain:** Frontend / Bug report
- **Location:** `src/components/BugReportDialog.tsx:356-371`
- **What:** Redaction option is hidden inside another toggle's expanded group; users may miss it before submitting.
- **Cost:** Trivial — small lock icon + "Redact" label or move to a sibling row that disables when "Include logs" is off.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-384 — Import progress shows file count, not bytes / blocks
- **Domain:** Frontend / Import-Export
- **Location:** `src/components/DataSettingsTab.tsx:136-159`
- **What:** "Importing file 2 of 5" is the only feedback; large markdown imports look stalled.
- **Cost:** S — secondary line "(N blocks created · M bytes)" updated as the import worker reports.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-385 — Export ZIP filename doesn't include space name
- **Domain:** Frontend / Import-Export
- **Location:** `src/components/DataSettingsTab.tsx:87-99`
- **What:** Generic `agaric-export-YYYY-MM-DD.zip`. With multiple spaces, users can't tell which one is in a ZIP they downloaded weeks ago.
- **Cost:** Trivial — include the active space name in the filename.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-386 — Keyboard conflict warnings inline below row (mobile-unfriendly)
- **Domain:** Frontend / Settings / Keyboard
- **Location:** `src/components/KeyboardSettingsTab.tsx:214-221`
- **What:** Warnings render as plain text on a separate line below each shortcut; they wrap ungracefully on narrow widths and are only shown after save.
- **Cost:** Trivial — add a warning icon + colour to the row's left margin; show conflict in real time as the user types in the input.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-387 — Sidebar theme button cycles 3 themes (auto/dark/light) silently — Settings exposes the full 7
- **Domain:** Frontend / Settings / Theme
- **Location:** `src/hooks/useTheme.ts:54-55` (`/** Theme cycle for the sidebar toggle button (classic light/dark/auto only). */ const CYCLE: ThemePreference[] = ['auto', 'dark', 'light']`) ; `src/components/AppSidebar.tsx:254-263` (sidebar button calls `onToggleTheme`, tooltip is the generic `t('sidebar.toggleTheme')`) ; `src/components/settings/AppearanceTab.tsx:114-135` (full 7-theme Select: light, dark, auto, solarized-light, solarized-dark, dracula, one-dark-pro)
- **What:** The sidebar cycles only 3 themes (auto/dark/light) — earlier framing claimed all 7. The full picker lives in Settings → Appearance. The remaining gap is that the sidebar tooltip says "Toggle theme" generically rather than announcing the current theme.
- **Cost:** Trivial — change the sidebar tooltip to show the current theme name + "click to cycle". Optionally, replace the cycle with "open Appearance settings" given the user-discoverable choice space is 7, not 3.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-388 — Keyboard help panel has no search / filter for ~77 shortcuts
- **Domain:** Frontend / Keyboard
- **Location:** `src/components/KeyboardShortcuts.tsx:143-187`
- **What:** Long flat scrollable table with 8 category headers; users have to eyeball-scan every time.
- **Cost:** S — filter input wired to description + key text; collapse to matching rows.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-389 — Help-panel category headers don't stick on scroll
- **Domain:** Frontend / Keyboard
- **Location:** `src/components/KeyboardShortcuts.tsx:156-165`
- **What:** Category context is lost when scrolling mid-list.
- **Cost:** Trivial — `position: sticky` on the header `<tr>` (or wrap each category in its own scroll-container).
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-390 — Custom shortcut input has no documented format
- **Domain:** Frontend / Keyboard
- **Location:** `src/components/KeyboardSettingsTab.tsx:126-129` ; `src/lib/i18n/shortcuts.ts:119`
- **What:** Placeholder is "Type new key binding…" with no example. Users don't know whether to write `Ctrl + Shift + E`, `Ctrl-Shift-E`, or what.
- **Cost:** Trivial — add a one-line "Format: `Ctrl + Shift + E`, alternatives with `/`" hint.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-391 — Custom shortcut input accepts any non-empty string with no validation
- **Domain:** Frontend / Keyboard
- **Location:** `src/components/KeyboardSettingsTab.tsx:57-65` ; `src/lib/keyboard-config/storage.ts:39-52`
- **What:** `saveEdit` writes whatever the user typed; malformed bindings silently never fire at runtime. Nothing rejects modifier-only / unparseable inputs.
- **Cost:** S — validation step before `setCustomShortcut`; render an inline error if invalid.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-392 — Conflict warning rendered below row, not inline with keys
- **Domain:** Frontend / Keyboard
- **Location:** `src/components/KeyboardSettingsTab.tsx:214-221`
- **What:** Warning is a separate `<div>` outside the row's flex layout. On narrow screens it wraps awkwardly. Also fires only after save, not while typing.
- **Cost:** Trivial — colocate next to the keys column; recompute on every keystroke during edit.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-393 — "Customized" badge in keyboard settings is plain text-primary
- **Domain:** Frontend / Keyboard
- **Location:** `src/components/KeyboardSettingsTab.tsx:167-171`
- **What:** Easy to miss; doesn't read as a status badge.
- **Cost:** Trivial — switch to the `Badge` primitive (`variant="secondary"`).
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.

### UX-394 — `findConflicts` ignores the `condition` field — false positives
- **Domain:** Frontend / Keyboard (correctness)
- **Location:** `src/lib/keyboard-config/storage.ts:72-91` (test at `src/lib/__tests__/keyboard-config.test.ts:229-238` documents the false-positive)
- **What:** Conflicts grouped by `(keys, category)` only; conditional shortcuts (e.g. Backspace on empty block vs. at start) get flagged as conflicting even though they never fire simultaneously. Users see a warning that's wrong.
- **Cost:** S — group by `(keys, category, condition)`; treat `condition === undefined` as wildcard.
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.

### UX-395 — Help panel footer button "Customize shortcuts" doesn't indicate it leaves the panel
- **Domain:** Frontend / Keyboard
- **Location:** `src/components/KeyboardShortcuts.tsx:216-232` ; `src/lib/i18n/shortcuts.ts:10`
- **What:** Generic label; users don't know it navigates to Settings.
- **Cost:** Trivial — relabel to "Customize in Settings" with a ChevronRight / external icon.
- **Risk:** Low.
- **Impact:** Low.
- **Status:** Open.


### UX-397 — Help panel doesn't badge customized shortcuts
- **Domain:** Frontend / Keyboard
- **Location:** `src/components/KeyboardShortcuts.tsx:32-45` ; `src/lib/keyboard-config/storage.ts:30-37`
- **What:** `getCurrentShortcuts()` already exposes `isCustom`; the panel shows current bindings but doesn't differentiate customized ones.
- **Cost:** Trivial — render the same "Customized" badge that the settings tab uses (after UX-393).
- **Risk:** Low.
- **Impact:** Medium.
- **Status:** Open.


---

## Ready-made batches (planning aid for next sessions)

Pre-grouped item clusters identified during the 2-pass audit. Each batch is sized for one PROMPT.md session — 5 trivial-cost items in non-overlapping files, splittable across 5 parallel subagents. **Remove the batch entry from this list when its items are resolved.**

_None currently pre-staged — all batches identified during the 2-pass audit have been consumed. Pick the next session's items ad-hoc from the summary table or re-audit if a fresh sweep is wanted._
