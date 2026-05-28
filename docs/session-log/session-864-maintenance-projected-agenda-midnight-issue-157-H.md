## Session 864 — maintenance daemon: projected_agenda_midnight (#157 sub-item H) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | orchestrator-only |
| **Items closed** | — (one more sub-item of #157 shipped; I remains) |
| **Items modified** | #157 (status comment) |
| **Tests added** | +3 backend (`maintenance::tests` — first-call-fires, same-day-skips, day-rollover-fires) |
| **Files touched** | 3 |

**Summary:** Ships #157 sub-item **H** — fire `RebuildProjectedAgendaCache` at most once per UTC calendar day. The daemon's outer ticker fires every 60 s; the job body keeps its own "last-fired UTC day-number" state in a shared `AtomicI32`, compares it to today's day-number on every tick, and enqueues the rebuild when (and only when) the value advances. Sentinel `i32::MIN` means "never fired" — used at construction so the first post-boot tick always fires (the projected agenda may be stale by up to one full day if the previous session ended before its own midnight tick).

The rebuild lands at most ~60 s after midnight under normal operation; ~60 s after process start if the app was offline during midnight. CAS-on-update so two ticks racing across midnight don't double-enqueue: only the first thread to observe the transition fires; the loser sees `previous != today` after the CAS resolution and skips.

**Conflict note:** Fourth concurrent PR extending the daemon's `jobs` vec (alongside #168 = C+G, #169 = F+J, #170 = E). Whichever lands first cleanly; the others need trivial rebases concatenating `MaintenanceJob` literals. No semantic interaction between H and the other in-flight jobs.

**Files touched (this session):**
- `src-tauri/src/maintenance.rs` (+99 — added `chrono::Datelike` import, `projected_agenda_midnight_tick()` body fn with the atomic CAS gating, 3 tests covering boot/same-day/rollover behaviour)
- `src-tauri/src/lib.rs` (+38 net — extended the `jobs` vec with the `projected_agenda_midnight` entry; allocated the shared `Arc<AtomicI32>` initialised to `i32::MIN`)
- `docs/session-log/session-864-…md` (new — this log)

**Verification:**
- `cd src-tauri && cargo check --tests` — clean compile.
- `cd src-tauri && cargo nextest run -p agaric maintenance::` — 7/7 pass.
- pre-commit + pre-push hooks will run on commit/push.

**Process notes:** The natural way to express "fire at midnight" on the existing interval-ticker daemon is to set the job's `interval` to the polling cadence (60 s) and put the rate-limiting into the body via a comparison against shared state. The alternative — adding a "fire at wall-clock event X" mechanism to the daemon's run-tick logic — would have rippled into the `MaintenanceJob` struct shape (new fields), the test fixtures, and the spawn site. The body-side-gating shape kept the daemon's interface unchanged and lets the next "fire on event X" job (whatever it is) follow the same pattern.

**Lessons learned (for future sessions):** When a job's natural cadence is "fire at a wall-clock event" rather than "fire every N units of time", a tighter polling interval + body-side state gating is the cheaper-to-evolve answer than extending the daemon's scheduling primitive. The interval-ticker is doing nothing more than asking "is something due?" — the "what" can stay private to each job's body.

**Commit plan:** single commit on branch `feat/maintenance-projected-agenda-midnight-157-H`; PR against `main`. Issue #157 stays open (sub-item I — `loro_snapshot_if_dirty` — remains; it needs a dirty-engines counter on top of the loro engine state, which is not yet exposed as a metric).
