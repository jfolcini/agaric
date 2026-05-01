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

14 open items.

| ID | Section | Title | Cost |
|----|---------|-------|------|
| FEAT-3p9 | FEAT | Spaces Phase 9: per-space external integrations — foundation (per-space `gcal_space_config` table + per-space keychain key + legacy single-space migration) in place; remaining work threads `space_id` through oauth/lease/connector/commands, branches the push loop by space, ships per-space Settings accordion, and (when FEAT-11 lands) prefixes OS notifications with the space name | M |
| FEAT-5g | FEAT | GCal: Android OAuth + background connector (DEFERRED — design sketch only) | L |
| FEAT-11 | FEAT | Adopt `tauri-plugin-notification` — OS notifications for due tasks / scheduled events (Org-mode parity, especially on mobile) | L |
| MAINT-111 | MAINT | Migrate MCP server JSON-RPC framing onto `rmcp` 1.6 (reference impl behind `mcp_rmcp_spike` feature flag; 3 milestones, 12-14h end-to-end) | L |
| MAINT-113 | MAINT | `ConflictFreeBlockId` newtype to lift invariant #9 (`is_conflict = 0` + `depth < 100` in every recursive CTE over `blocks`) into the type system — 220 `is_conflict = 0` SQL occurrences across 70 files. LOW-priority refactor for elegance, not correctness; the convention + review + documented invariant are already working. Do NOT do on a deadline. | L |
| MAINT-114 | MAINT | Consolidation audit of `.github/workflows/` — fold `release-tag.yml` into `release.yml` as a `workflow_dispatch` job (4 → 3 files). Spike-then-commit; abandon if merged file isn't shorter than the sum. | S–M |
| MAINT-128 | MAINT | God-component decomposition: `PropertyRowEditor.tsx` (539L) — design-heavy split (5 typed editors share `localValue`, date hook state, select-options state, ref-picker state, 10+ callbacks). Closing this row requires either accepting the existing `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` at L85 permanently, or splitting each typed editor into its own component AND lifting the shared state UP to a containing hook. | L |
| PERF-19 | PERF | Backlink pagination cursor uses linear scan for non-Created sorts (2 sites) | S |
| PERF-20 | PERF | Backlink filter resolver has no concurrency cap on `try_join_all` | S |
| PERF-23 | PERF | `read_attachment_file` buffers whole file before chunked send | S |
| PUB-2 | PUB | Git author email across all history is corporate (`javier.folcini@avature.net`) | S |
| PUB-3 | PUB | Employer IP clearance before public release | S |
| PUB-5 | PUB | Tauri updater — endpoint URL pinned to `jfolcini/agaric`; remaining work is user-only (generate Minisign keypair, paste pubkey into `tauri.conf.json`, add 2 GH Actions secrets, uncomment env vars in `release.yml`) | S |
| PUB-8 | PUB | Android release keystore + 4 GH Actions secrets (apksigner wiring already shipped in `release.yml`) | S |

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

This invariant is currently enforced by code review + grep + one-line comments. It is baked into **220 `is_conflict = 0` SQL occurrences across 70 source files** (plus 3 more in `migrations/`). Every new query touching `blocks` must remember to add it.

**Alternative design:** Split the `BlockId` primitive into two types:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct BlockId(String);        // raw — may refer to a conflict copy or deleted block

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ActiveBlockId(String);  // materialised AND is_conflict = 0 AND deleted_at IS NULL
```

Query helpers that return "active" blocks (`list_children`, `get_descendants`, `list_page_links`, every recursive CTE wrapped behind a Rust fn) return `Vec<ActiveBlockId>`. Query helpers that accept only active input take `&ActiveBlockId`. Conversion `BlockId → ActiveBlockId` goes through a single checked gate (`verify_active(&BlockId) -> Result<ActiveBlockId>`) that runs the `is_conflict = 0 AND deleted_at IS NULL` predicate exactly once. Recursive CTEs hidden behind these helpers keep their `AND is_conflict = 0` in SQL — the newtype just prevents callers from accidentally feeding a raw `BlockId` into a path that assumes active.

**Why this is a LOW-priority refactor:**

- The invariant is already documented (AGENTS.md #9), already tested (the `block_tag_inherited` materialised cache has an oracle CTE that verifies the filter is honoured), and already flagged by review (session logs show "missing `is_conflict = 0`" is caught before merge).
- No shipped HIGH/CRITICAL bug traces back to a missed filter in the last ~50 sessions. The tension is correctness-by-convention vs. correctness-by-types, not correctness vs. incorrectness.
- Scope is genuinely large — 220 SQL sites are the *floor* (each one lives in a function with a Rust signature); the real work is touching **every** producer/consumer of `BlockId` and deciding whether it returns raw or active. Honest estimate: 70 files, hundreds of function signature changes, a `specta`-bindings ripple to the frontend (extra TS type), and a round of test fixture updates.
- The serde wire format must stay `String` (both directions) so sync + IPC aren't affected — handled with `#[serde(transparent)]`.

**Do not take this on a deadline.** Land only as opportunistic cleanup — e.g., when a specific module is already being rewritten for another reason, convert its signatures over and leave the rest of the codebase on `BlockId` for another session. The existing `is_conflict = 0` + `depth < 100` convention is **not broken**; it is **not elegant**.

**Cost:** L (8h+ at minimum; realistically 2–4 sessions if done wholesale).
**Risk:** M — pervasive API change. Sync / MCP / specta bindings must round-trip identically. Mixing raw and active block IDs in a single data structure (e.g., `BlockTreeNode` with both active children and "recently-deleted" preview siblings) needs explicit policy.
**Impact:** M (if shipped) — eliminates an entire class of "forgot to filter conflicts" bugs at compile time. Invariant #9 in AGENTS.md could reference the type instead of a prose rule.

**Decision:** Defer indefinitely. Revisit only if a future `is_conflict = 0` miss ships a user-visible regression. Keep in REVIEW-LATER as a filed design note so it is not reinvented from scratch next time.

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

**What:** `PropertyRowEditor.tsx` is 539L and carries an explicit `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` at L85. The file dispatches on `def.value_type` (text/number/date/ref/select → 5 parallel JSX subtrees) but the 5 typed editors share `localValue`, date hook state, select-options state (3 fields), ref-picker state (4 fields), and 10+ callbacks — splitting naïvely re-creates the prop-chain problem that the `biome-ignore` acknowledges.

**Closing this row requires a design discussion:**

- **(a)** accept the existing `biome-ignore` permanently with a rationale comment, OR
- **(b)** split each typed editor into its own component AND lift the shared state UP to a containing hook (substantial refactor — the hook owns local edit state, debounced save, and calls down into the per-type editor with a thin contract).

**Cost:** L.
**Risk:** Medium — has a test suite; run between each commit.
**Impact:** M — removes the only `biome-ignore` for cognitive complexity and clarifies the typed-editor surface.

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
