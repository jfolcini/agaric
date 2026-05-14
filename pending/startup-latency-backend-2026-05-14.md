# Startup-latency backend deferrals — boot critical-path trim

> **Scope:** Move three small backend boot items off the synchronous critical path so the BootGate handshake unblocks ~10-100 ms sooner, and let the journal shell render without waiting on backend-init slack. Frontend tiptap lazy-load is **out of scope** — that's Tier 1.3 in `pending/design-system-perf-review-2026-05-09.md` and stays there.
>
> **Trigger.** User report ("the app is a bit slow to start") plus a survey of `src-tauri/src/lib.rs:578-873`. The setup block runs ~7 `block_on(...)` calls **before the webview is shown**. Most are load-bearing (DB pool, Loro rehydrate, recovery, `bootstrap_spaces`), but four items are explicitly marked best-effort / non-fatal in their comments and can move to a background task spawned after `app.run()`.

---

## Background — what runs at boot today

`src-tauri/src/lib.rs` setup, in order:

1. `db::init_pools` (`:641`) — **load-bearing** (every subsequent call needs the pool).
2. `loro::shared::init` + `rehydrate_registry` (`:707-728`) — load-bearing; comment says "single-digit ms at typical scales", not worth touching.
3. `recovery::recover_at_boot` (`:732`) — **boot-fatal**; replays unmaterialized ops, required for correctness before any user action.
4. `link_metadata::cleanup_stale` (`:752`) — best-effort GC, warn-only on error.
5. FTS empty-check COUNT queries + conditional enqueue (`:766-790`) — read-only gating queries; the actual rebuild is already a background task.
6. `block_tag_refs` empty-check COUNT queries + conditional enqueue (`:798-826`) — same pattern.
7. `RebuildProjectedAgendaCache` enqueue (`:830`) — already background, but enqueued at boot.
8. `bootstrap_spaces` (`:839`) — **boot-fatal** per its own comment ("the app's 'every page belongs to a space' invariant cannot be honoured without this step completing"). First-run only; idempotent fast-path on subsequent boots. **Stays.**
9. `migrate_personal_pages_to_work` (`:856`) — explicitly non-fatal; threshold-gated no-op on fresh installs.
10. Frontend `BootGate` (`src/stores/boot.ts:32`) issues `invoke('list_blocks', { spaceId: '' })` as a "backend ready" handshake before transitioning to the `ready` state and rendering the journal.

---

## Phase 1 — defer four backend items to a post-`run()` task

Move the following out of `setup()` into a `tokio::spawn(async move { … })` that fires once the Tauri app handle is available:

- `link_metadata::cleanup_stale` (`:752`)
- The three `COUNT(*)` gating queries for FTS rebuild (`:766-790`) and `block_tag_refs` rebuild (`:798-826`). The rebuild tasks themselves are already background-enqueued; only the gating queries are synchronous.
- `migrate_personal_pages_to_work` (`:856`)
- `RebuildProjectedAgendaCache` enqueue (`:830`) — move trigger to "agenda panel first opened" so the materializer queue stays empty for the first user interaction.

`bootstrap_spaces` (`:839`) and everything above it stays on the critical path.

**Expected impact:** small in absolute terms (~10-100 ms on a typical boot, more on power users with many stale link-metadata rows). The relative win is releasing the materializer's foreground queue earlier so the first user action doesn't compete with cache-rebuild work.

---

## Phase 2 — drop the BootGate `invoke('list_blocks')` handshake

`src/stores/boot.ts:32` does a synchronous `invoke('list_blocks', { spaceId: '' })` whose only purpose is "wait until backend setup completes". The Tauri runtime already guarantees that — by the time any `invoke` can return, `setup()` has finished. The handshake's UX role is the `booting → recovering → ready` state machine that drives the boot screen; the journal page only mounts after `ready`.

**Fix.** Remove the artificial handshake. Render the journal shell (header, day tabs, empty content area) as soon as the React tree mounts; let the journal's own block-query be the first IPC. JournalPage already handles a "no data yet" state for date navigation, so the loading-state plumbing should already exist.

**Expected impact:** perceived ~50-150 ms earlier first paint of the journal shell. Wall-clock to "interactive" (blocks visible) unchanged.

---

## Phase 3 — verify, not before Phases 1+2 ship

Profile a cold boot with `tracing` spans + a frontend `performance.mark` at `BootGate` start / journal shell paint / first blocks visible. If the wall-clock cost of `recovery::recover_at_boot` dominates everything else by an order of magnitude on a real user's vault, that's the next investigation target — but it's load-bearing and the fix is "make recovery itself faster" rather than "move it off the critical path".

---

## Out of scope

- **Tiptap lazy-load** — tracked as Tier 1.3 in `pending/design-system-perf-review-2026-05-09.md`. That's the architectural fix (480 KB editor chunk + 148 KB highlight chunk off the parse-critical path), separate decision, separate cost/risk profile. Note that `EditableBlock.tsx:247-262` already renders unfocused blocks as `StaticBlock`, so the refactor is "make the editor mount path dynamic-import" rather than "introduce a static rendering path".
- **`recover_at_boot` optimisation** — out of scope here; would require materializer/op-log work.
- **`bootstrap_spaces` deferral** — rejected (`:843` says boot-fatal).
- **Loro rehydrate optimisation** — rejected (`:702-705` says "single-digit ms"; not worth touching).

---

## Cost / Impact / Risk

| Phase | Cost | Impact | Risk |
| --- | --- | --- | --- |
| 1 (background-defer 4 items) | ~2-3 h | ~10-100 ms off cold boot; materializer queue empty for first user interaction | **Low.** All four items have warn-only / non-fatal error paths in their existing comments. The COUNT-then-enqueue pattern is read-only and safe to move. `bootstrap_spaces` (the boot-fatal one) explicitly stays. |
| 2 (drop BootGate handshake) | ~1 h | Perceived ~50-150 ms earlier journal shell paint; wall-clock to first-block-visible unchanged | **Low.** The handshake is artificial — Tauri already guarantees backend readiness by the time an `invoke` resolves. Risk is that JournalPage's "no data yet" state for the boot case isn't as polished as for date navigation; verify in a `beforeEach` cold-boot test. |
| 3 (profile to decide next move) | ~1 h | Decision-making only; no code change | None. |

**Total bounded cost:** ~half a day for Phases 1 + 2. Phase 3 is the gate for any further investment.

---

## Acceptance

- Phase 1: cold boot `tracing` span shows the four deferred items running *after* the first `list_blocks` IPC resolves; no behavioural regression in existing recovery / first-run tests.
- Phase 2: `BootGate` no longer issues `list_blocks`; the journal shell appears before the first block query resolves; the `booting → recovering → ready` state machine either goes away or fires off the journal's own first query.
- Phase 3: a written one-paragraph profile note (committed alongside or pasted into `SESSION-LOG.md`) recording cold-boot timings before vs after Phases 1+2 on the maintainer's vault, and a go/no-go on Tier 1.3 (tiptap lazy-load) based on whether parse time is the residual bottleneck.
