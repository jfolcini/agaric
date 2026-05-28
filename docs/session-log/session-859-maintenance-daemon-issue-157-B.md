## Session 859 — MaintenanceDaemon skeleton + wal_checkpoint_truncate (#157 sub-item B) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | orchestrator-only |
| **Items closed** | — (one sub-item of #157 shipped; B unblocks C/E/F/G/H/I/J) |
| **Items modified** | #157 (status comment) |
| **Tests added** | +4 backend (`maintenance::tests` — first-tick fires, predicate-false skips and preserves last_run, interval guard, wal_checkpoint_truncate smoke test against the real sqlx driver) |
| **Files touched** | 3 |

**Summary:** Closes sub-item **B** of issue #157 — introduces `src-tauri/src/maintenance.rs`, a general-purpose maintenance loop modelled on `draft::spawn_orphan_drafts_sweeper` (single `tokio::spawn` + `tokio::time::interval` ticker) but generalised over a vector of `MaintenanceJob` entries so subsequent sub-items (C / E / F / G / H / I / J) can land as additional jobs without re-wiring the daemon.

Daemon cadence: a fixed 60 s tick. On each tick the daemon walks the job vector; jobs whose individual `interval` has elapsed since their `last_run` AND whose `predicate` returns `true` are run sequentially in declared order. Errors log at warn (no propagation — the next tick retries). A skipped-predicate run does NOT bump `last_run`, so the job catches up as soon as the predicate returns true again. Shutdown via the same shared `AtomicBool` shape used by the orphan-drafts sweeper and the materializer retry-queue sweeper.

The first job is `wal_checkpoint_truncate` (1 h cadence, idle predicate). SQLite's `PRAGMA wal_autocheckpoint` (default 1000, our pool sets it to 5000) only fires PASSIVE checkpoints that copy pages back to the main DB without resizing the WAL. TRUNCATE actively shrinks the WAL when a clean snapshot exists — the 19.8 MB WAL footprint observed on the 3-month dev install (per #157's forensic table) is what this trims. The idle predicate gates on `lifecycle.is_foreground`: the TRUNCATE checkpoint can briefly block other writers, invisible when backgrounded but noticeable while the user is actively editing. The PRAGMA also returns `busy != 0` if a concurrent reader/writer holds the WAL, so the gating is double-belted.

**Files touched (this session):**
- `src-tauri/src/maintenance.rs` (new — ~280 LOC incl. detailed header comment, `MaintenanceJob` struct, `spawn_daemon`, `run_tick` factored out for testability, `wal_checkpoint_truncate` job body, 4 tests)
- `src-tauri/src/lib.rs` (+33 net — `pub mod maintenance;`, new `MaintenanceDaemonShutdown` managed-state struct, spawn site after the orphan-drafts sweeper that constructs the initial job vector + idle predicate)
- `docs/session-log/session-859-…md` (new — this log)

**Verification:**
- `cd src-tauri && cargo check --tests` — clean compile, no new warnings.
- `cd src-tauri && cargo nextest run` — 4024/4024 pass (one flaky retry — `sync_files::tests::run_file_transfer_initiator_breaks_on_cancel_m47` — is the pre-existing #162 flake, unrelated).
- 4 new tests pass on first try.
- pre-commit + pre-push hooks will run on commit / push.

**Process notes:** The `MaintenanceJob` struct holds owned closures (`Box<dyn Fn() -> bool + Send + Sync>` for the predicate and `Box<dyn Fn() -> Pin<Box<…Future…>> + Send + Sync>` for the body) rather than holding a polymorphic trait object across job kinds. The closure approach lets each job capture its own state (pool clones, lifecycle handles, materializer references) at construction time without the daemon needing to know about any concrete job's dependencies — adding a new job is one `MaintenanceJob { … }` literal in the job vector, no daemon edit. `run_tick` is factored out of `spawn_daemon` so tests can drive it directly on a `&mut Vec<MaintenanceJob>` without spinning the 60 s ticker; the production `spawn_daemon` wrapper is marked `#[cfg(not(tarpaulin_include))]` to match the existing sweepers.

**Lessons learned (for future sessions):** When adding a new long-lived task wired through `lib.rs::run`, the established pattern is: a `<Name>Shutdown(pub Arc<AtomicBool>)` managed-state struct, a `pub fn spawn_<name>(…, shutdown_flag)` constructor, and a setup-time call site adjacent to the other `spawn_*` calls. Following this pattern lets the next sub-items in #157 just append jobs to the `jobs` vector at the spawn site — no daemon-level edits required.

**Commit plan:** single commit on branch `feat/maintenance-daemon-issue-157-B`; PR against `main`. Issue #157 stays open (sub-items C, E, F, G, H, I, J remain).
