# PEND-09 Phase 2 — Cutover plan

Day-1 deliverable for the cutover phase, written **2026-05-09**, the
same day the Phase-1 final report
(`pending/PEND-09-PHASE-1-REPORT.md`, commit `c6666d9d`) closed with a
**GO-WITH-CAVEATS** recommendation.

This doc is the analog of `pending/PEND-09-crdt-migration.md` scoped
specifically to Phase 2 — the cutover from "diffy authoritative + Loro
shadow" to "Loro authoritative". Every implementation claim is cited
to file:line / commit / `pending/*.md`. Sections §7-§8 enumerate the
genuinely-open items that the user must decide before any cutover
commit lands.

## 1. Phase definition

### 1.1 What "cutover" means in agaric terms

Cutover is the moment **Loro becomes the authoritative state** and
the diffy-based merge layer
(`src-tauri/src/merge/{apply,detect,resolve}.rs`, ~4 163 LOC per
`pending/PEND-09-crdt-migration.md` line 5) becomes a deprecation
candidate.

Three things flip on the same `loro_authoritative=true` toggle:

1. **Writes go to Loro first.** Each `apply_op` site (today: the
   single-op arm at `src-tauri/src/materializer/handlers.rs:149-183`
   and the `BatchApplyOps` arm at ~33-115 — wired in Phase-1 day-3
   commit `16d369d2`) reorders so the in-process per-space
   `LoroEngine` (`src-tauri/src/loro/engine.rs`, 871 LOC) applies the
   op into the LoroDoc **before** the SQL projection runs.
2. **The materializer projects from Loro state into SQL.** The
   `blocks`, `block_properties`, and the four hot-path columns
   (`todo_state`, `priority`, `due_date`, `scheduled_date` per
   `pending/PEND-09-crdt-migration.md` lines 17-36 + Q10) become
   **derived** from the LoroDoc; SQL stays as the read cache
   (Phase-0 day-7 verdict, `pending/PEND-09-SPIKE-REPORT.md` §4.4) but its data flows
   **out** of Loro instead of being computed by diffy.
3. **The diffy code path is feature-gated for fallback only.** The
   `merge::apply::shadow_dispatch_for_record` call site
   (`merge/apply.rs:131`, invoked from `merge_block_text_only`) and
   the materializer hot-path dispatches in
   `materializer/handlers.rs` (single-op at line 172, batched at
   line 110) flip from "secondary shadow write" to "primary write";
   existing diffy paths (`merge_block_text_only` at
   `apply.rs:47-140`, `resolve_property_conflict` at
   `resolve.rs:224-…` (function start; body runs ~75 lines),
   move-LWW at `sync_protocol/operations.rs:699-822`,
   property-LWW at `sync_protocol/operations.rs:515-697`) compile
   but are reachable only when the kill switch (§5) flips Loro
   back off.

### 1.2 Scope boundary

Phase 2 ends when **all three** of the above are true on the
maintainer's primary workstation, the `loro_authoritative` flag has
been ON continuously for the full cutover-soak window (§3 day 11+),
and zero D-bucket rows have appeared in the `merge_parity_log`
(migration `0051`, classifier at `src-tauri/src/loro/classifier.rs`,
rules per Phase-1 day-6 commit `55b2d65b`) during that window.

### 1.3 What Phase 2 is NOT

- **Not the deletion of diffy code.** That is Phase 3 per
  `pending/PEND-09-crdt-migration.md` lines 67-68. Diffy stays
  compiled-in for **at least one full release after Phase 2 closes**
  per the Phase-0 risks table line 113.
- **Not the FE-side Loro integration.** The FE never reads Loro
  state in Phase 2; it reads the same `blocks.content` SQL row it
  reads today. `pending/PEND-09-fe-edit-coordinate-space.md` §
  "Loro-mode equivalence" is explicit. Phase 2.5+ is where FE-side
  `subscribe()` callbacks and USV ↔ UTF-16 cursor bridging would
  land — explicitly **future work**, not Phase 2 scope.
- **Not the deletion of the `is_conflict` column.** That is Phase 3
  migration `0043_drop_is_conflict.sql` per the original plan line
  68 + 145. Phase 2 stops *producing* new `is_conflict=1` rows but
  keeps the column readable.
- **Not the deletion of `merge_parity_log`.** That table is the
  load-bearing observability surface during cutover-soak. Phase 3
  reaps it (§6).

## 2. Pre-cutover gates

Eight readiness items, restated from the Phase-1 final report §4.
Each must close **before** the day-9 toggle commit (§3 below) lands.
Owners are "the maintainer" throughout (solo-maintainer codebase per
`pending/PEND-09-crdt-migration.md` line 159).

### Gate 1 — 7-day real-`notes.db` shadow-mode soak

- **Requirement.** `cargo build --features loro-shadow` running on
  the maintainer's primary workstation continuously for ≥7 calendar
  days. Zero `bucket = 'D'` rows in `merge_parity_log` at every
  daily sample. (A/B/C all acceptable; D is the kill criterion
  floor.)
- **Closing artifact.** A `SELECT bucket, COUNT(*), MAX(created_at)
  FROM merge_parity_log WHERE created_at > ? GROUP BY bucket`
  result pasted into the Phase-2 day-9 commit message; a table dump
  archived alongside.
- **Verification.** Query is executable today; the day-6 classifier
  is invoked from `src-tauri/src/loro/flush_task.rs:117`
  (`classify_unbucketed`) on each 30-second flush tick (cadence
  constant `FLUSH_INTERVAL_SECS = 30` at line 46).

### Gate 2 — Two-device concurrent-merge proptests

- **Requirement.** Fourth proptest in
  `src-tauri/src/loro/parity_proptest.rs` (existing 496 LOC per
  Phase-1 day-8 commit `89df17a2`):
  `two_peer_concurrent_edit_stream_never_hits_bucket_d`. Two
  `LoroEngine` handles diverge on per-block edits, exchange
  snapshots at random sync points, assert bucket A/B/C and never D.
- **Closing artifact.** Phase-2 day-2 commit (§3).
- **Verification.** `cargo nextest run -p agaric --features
  loro-shadow` reports the new test green. This gate covers the
  **C-bucket-rich** case the day-8 single-author proptest cannot
  exercise (single-author streams cannot produce concurrent-merge
  buckets by construction).

### Gate 3 — `loro_bytes: Vec<u8>` envelope schema

- **Requirement.** `LoroBatch` envelope at
  `src-tauri/src/loro/envelope.rs` (Phase-1 day-3, 263 LOC) gains a
  `loro_bytes: Vec<u8>` column carrying Loro-exported batch bytes.
  `loro_version: u8` bumps from 1 → 2. Old rows (no `loro_bytes`)
  remain decodable through the typed-payload path.
- **Closing artifact.** Phase-2 day-3 commit (§3).
- **Verification.** Schema migration test — encode an envelope at
  v1, decode at v2 reader, confirm typed-payload path works;
  encode at v2, decode at v2, confirm `loro_bytes` round-trips
  byte-identical.

### Gate 4 — Op-log volume sampling

- **Requirement.** A one-off `agaric debug op-log-histogram`
  command run against the maintainer's real `notes.db`. Confirms
  the spike's 30/50/10/5/5 op-mix proxy (`pending/PEND-09-SPIKE-REPORT.md` §3 row
  "Plan 9") is in the right ballpark, OR re-runs the day-4 replay
  bench with the real distribution.
- **Closing artifact.** Phase-2 day-4 commit. Histogram pasted
  into the commit message.
- **Verification.** Reading the histogram tells the maintainer
  which engine code path is most-exercised. The wide kill margin
  (358× wall-clock, 14× heap) means this gate is about *knowing*,
  not gating.

### Gate 5 — macOS / Windows RSS measurement

- **Requirement.** Day-4 replay bench's RSS reader gains
  `mach_task_basic_info` for macOS and `GetProcessMemoryInfo` for
  Windows. Kill-criterion check passes on at least Linux + macOS.
- **Closing artifact.** Phase-2 day-5 commit (§3).
- **Verification.** `cargo run --release -p loro-spike --bin
  replay_bench` (run before the day-8 archive — the spike crate is
  now archived; see git tag `pend-09/spike-archive`) reports a
  non-zero RSS reading and the same single-digit-MiB ballpark on
  each platform.
- **Note.** The wide kill-criterion margin (14×) means the verdict
  is robust to platform variance; this is sign-off completeness,
  not risk reduction.

### Gate 6 — `loro_doc_state` storage decision + migration

- **Requirement.** A new migration (number ≥0052; Phase 1 used
  0051) creating `loro_doc_state` STRICT table inside `notes.db`.
  Columns: `(space_id TEXT PRIMARY KEY, doc_bytes BLOB NOT NULL,
  snapshot_seq INTEGER NOT NULL, snapshot_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL)`. Snapshot cadence + retention decided
  (see §8 open question 1 — currently undecided).
- **Closing artifact.** Phase-2 day-6 commit.
- **Verification.** New migration runs cleanly on fresh boot;
  feature-on test count grows by 1-2.
- **Sizing.** Spike day-4 measured ~6.4 MiB at 25K alive blocks
  (`pending/PEND-09-SPIKE-REPORT.md` §3 row "Plan 3"); 100K alive blocks
  extrapolates to ≈26 MiB. SQLite-blob storage is unproblematic.

### Gate 7 — `agaric debug parity-report` diagnostic

- **Requirement.** A CLI / IPC command that runs `SELECT bucket,
  COUNT(*), MAX(created_at) FROM merge_parity_log WHERE created_at
  > ? GROUP BY bucket` and pretty-prints. Lets the maintainer
  observe shadow-mode state without manual SQL.
- **Closing artifact.** Phase-2 day-7 commit (§3).
- **Verification.** Maintainer runs the command between Gate-1
  daily samples; output replaces the manual SQL query.
- **Why a gate, not nice-to-have.** Without it, the day-9 toggle
  is harder to operate. The command also opens the door to a
  Phase-3 release-channel diagnostic (§7.6).

### Gate 8 — Spike-crate archive

- **Requirement.** `src-tauri/crates/loro-spike/` removed from the
  workspace. `SPIKE-NOTES.md` and `SPIKE-REPORT.md` preserved at
  `pending/PEND-09-SPIKE-NOTES.md` and
  `pending/PEND-09-SPIKE-REPORT.md` so citations remain resolvable.
- **Closing artifact.** Phase-2 day-8 commit.
- **Verification.** `cargo build` (default + `--features
  loro-shadow`) clean; `cargo nextest run -p agaric` 3768; `grep
  -rn loro-spike src-tauri/Cargo.toml` empty.
- **Why archive, not delete.** The spike's binaries
  (`replay_bench`, `tree_replay_bench`, `commit_cadence_bench`,
  `read_path_bench` per `pending/PEND-09-SPIKE-REPORT.md` §11) remain useful as
  reproduction harnesses. A git tag `pend-09/spike-archive` on
  commit `3e8a1267` is sufficient — no tarball needed. (The
  task-spec originally suggested `fcdae147` (last spike-touching
  commit at plan-write time); the tag landed on `3e8a1267` since
  Phase-2 days 5 and 7 added two more commits touching
  `crates/loro-spike/SPIKE-REPORT.md` between plan-write and
  archive.)

## 3. Cutover sequence

Day-by-day plan. Order matters: each step assumes the prior steps
have landed. Days 2-8 run concurrently with the Gate-1 7-day soak;
day 9 cannot land until Gate 1 closes.

### Day 1 (today, 2026-05-09) — Cutover plan written

This document. The Phase-2 day-1 commit message links to it.
Default-build behaviour byte-identical to commit `c6666d9d`.
`cargo nextest run -p agaric` reports 3734 (unchanged).

### Day 2 — Two-device concurrent-merge proptest

Closes Gate 2. Adds
`two_peer_concurrent_edit_stream_never_hits_bucket_d` to
`parity_proptest.rs`. Structurally similar to the spike's
`tests/concurrent_edit.rs` but driving the production `LoroEngine`
and asserting on `merge_parity_log.bucket`. Default 3734;
feature-on test count grows by ≥1.

### Day 3 — `loro_bytes` envelope field schema

Closes Gate 3. Edits `envelope.rs` to add `loro_bytes: Vec<u8>`,
bump `loro_version: u8` from 1 → 2, add a decode-old / encode-new
test. Docstring note: "during the transition window both `payload`
(typed JSON) and `loro_bytes` (Loro-exported batch bytes) coexist;
the day-9 toggle starts emitting `loro_bytes`-only envelopes on
new rows; legacy rows decode via the typed-payload path
indefinitely."

### Day 4 — Op-log volume sampling tool

Closes Gate 4. New binary
`src-tauri/src/bin/op-log-histogram.rs` (or extension to an
existing `agaric debug` command — TBD by maintainer preference).
Connects to `notes.db`, runs `SELECT op_type, COUNT(*),
AVG(LENGTH(payload)), MAX(LENGTH(payload)) FROM op_log GROUP BY
op_type ORDER BY COUNT(*) DESC`, pretty-prints. Maintainer pastes
result into the commit message.

### Day 5 — Cross-platform RSS measurement

Closes Gate 5. Edits the spike crate's RSS reader (the spike
still exists at this point — Gate 8 archives it on day 8) to add
macOS and Windows branches. Re-runs `replay_bench` on at least
Linux + macOS; pastes new RSS numbers into the commit message.

### Day 6 — `loro_doc_state` storage migration

Closes Gate 6. New migration `0052_pend_09_loro_doc_state.sql`.
New module `src-tauri/src/loro/snapshot.rs` (~150-300 LOC)
implementing the snapshot scheduler, wired into
`flush_task::run_periodic_flush` as a secondary cadence (snapshot
every N flush ticks; N TBD per §8.1). Default 3734; feature-on
test count grows by 3-5.

### Day 7 — `agaric debug parity-report` diagnostic

Closes Gate 7. New IPC command (or CLI subcommand) at
`src-tauri/src/commands/debug/parity_report.rs`. Returns the
bucket histogram + recent-D-bucket-rows tail. UI surface TBD — a
JSON return value is sufficient for cutover-soak; a
human-readable formatter is nice-to-have. Three new IPC tests.

### Day 8 — Spike-crate archive

Closes Gate 8. Removes `src-tauri/crates/loro-spike/` from
`src-tauri/Cargo.toml` workspace members. Moves `SPIKE-NOTES.md` +
`SPIKE-REPORT.md` to `pending/PEND-09-SPIKE-NOTES.md` +
`pending/PEND-09-SPIKE-REPORT.md`.
Updates cite-paths in this doc, in
`pending/PEND-09-PHASE-1-REPORT.md`, and in
`pending/PEND-09-crdt-migration.md`. Tags commit `3e8a1267` as
`pend-09/spike-archive` for historical reference (see Gate 8 in §2
for why the tag landed on `3e8a1267` rather than the originally
proposed `fcdae147`).

### Day 8.5 (likely needed) — Tag engine coverage

See §8.2. The Phase-1 `LoroEngine` covers `blocks` + `block_properties` only;
`AddTag` / `RemoveTag` / `RestoreBlock` / `PurgeBlock` /
`DeleteProperty` / `AddAttachment` / `DeleteAttachment` op types
exist in `op::OpType` (see `src-tauri/src/op.rs:38-50`) and are
written by the production materializer, but `merge::shadow_apply`
(`merge/mod.rs:184-191`) currently logs-and-skips them — the
spike's engine never grew past the five LWW-relevant ops. The
day-9 toggle cannot flip on until at minimum `AddTag` /
`RemoveTag` writes also flow through Loro, otherwise the
projection-from-Loro path produces stale `block_tags` rows.

`block_links` is **NOT** in this gap: it is a derived cache
(`src-tauri/src/cache/block_links.rs::reindex_block_links`) that
parses `[[ULID]]` / `((ULID))` tokens out of `blocks.content` —
no `AddLink` / `RemoveLink` op type exists, and the cutover's
content edits already flow through `apply_edit_via_diff_splice`,
so `block_links` re-derives correctly from the Loro-projected
`blocks.content` row.

`RestoreBlock` / `PurgeBlock` (trash flow), `DeleteProperty`,
`AddAttachment` / `DeleteAttachment` are the residual gap.
Maintainer decides whether to scope these into 8.5 or accept that
the toggle stays off for spaces with recent attachment / trash
activity until a follow-up day. Conservative scope: tags +
delete_property + restore_block + purge_block (≈300-500 LOC):
`apply_add_tag` / `apply_remove_tag` / `apply_delete_property` /
`apply_restore_block` / `apply_purge_block`;
`merge::shadow_apply` extension; proptest harness extension.
Attachments deferrable. Schedule may slip 1-2 days.

### Day 9 — The actual cutover toggle

**The load-bearing day.** Adds a `loro_authoritative` runtime
flag, defaulting **off**. Source: a new `app_settings` row (key
`pend09.loro_authoritative`, value `'0'` or `'1'`), backed by a
new migration `0054_pend_09_app_settings.sql` (table does not
exist today — see §5.1 for schema), readable from the
materializer hot path through a `OnceLock<AtomicBool>` cache so
the lookup is sub-100 µs (target: ≤1 µs cached). When ON:

1. `apply_op` and `apply_batch_ops` reorder so the `LoroEngine`
   apply runs **before** `apply_op_tx`.
2. `apply_op_tx` skips its own merge logic; instead reads
   resolved post-Loro state from the per-space `LoroEngine` and
   projects directly into `blocks` / `block_properties` /
   `block_tags` rows. `block_links` and `block_tag_inherited`
   re-derive from the projected `blocks.content` /
   parent-relationship via the existing
   `cache::reindex_block_links` /
   `cache::reindex_block_tag_refs` helpers; no separate Loro
   container required. (See §8.4 — the exact reorder shape,
   Option A vs B, decided at days 6-8.)
3. The diffy-side `merge_block_text_only`,
   `resolve_property_conflict`, move-LWW dispatcher, and
   conflict-copy creation become unreachable in the hot path.
   Not deleted; reachable only when the flag flips off.

**Code-complete on day 9; not yet enabled.** The flag's default
is `'0'`. Day 9's commit changes no observable behaviour;
shadow-mode parity logging continues. Gate 1's 7-day soak window
must close before day 9 lands.

### Day 10 — Partial index on `merge_parity_log.bucket IS NULL`

Closes the Phase-1 §7.5 deferred follow-up. New migration
`0053_pend_09_parity_log_pending_bucket.sql`: `CREATE INDEX
idx_merge_parity_log_pending_bucket ON merge_parity_log(bucket)
WHERE bucket IS NULL`. Makes the day-6 classifier's `WHERE bucket
IS NULL` query probe an index instead of full-scanning. Day 10,
not day 9, because the optimisation is cheap and the post-cutover
write rate is no different from today's. SQLite has supported
partial indexes since 3.8.0 (2013).

### Day 11+ — Cutover soak

Maintainer flips `pend09.loro_authoritative = '1'` on the primary
workstation. Runs for the cutover-soak window — minimum **1
calendar week**, recommended **2-3 weeks** (lets the day-2
proptest's expected-C-bucket cases actually fire on real
multi-device workloads).

**Telemetry.** The day-7 `parity-report` command runs on a
maintainer-chosen cadence. Hard floor: zero `bucket = 'D'` rows.
If a D-bucket row appears:

1. **Flip the flag off immediately.** `UPDATE app_settings SET
   value = '0' WHERE key = 'pend09.loro_authoritative'`. The
   sub-100 µs cache picks up the change on the next materializer
   apply; no restart needed (§5).
2. **File a bug.** `pending/PEND-09-cutover-bug-NNN.md` with the
   offending op_id, diffy_result + loro_result strings,
   reproduction.
3. **Return to Phase 1.** Cutover scope freezes until the
   divergence is root-caused. Mirror of the Phase-1 final report's
   NO-GO clause (§1 close).

### Day N (final) — Phase 2 final report

When the cutover-soak closes with zero D-bucket rows, write
`pending/PEND-09-PHASE-2-REPORT.md` — analog to the Phase 1
report. Sections: TL;DR + Phase-3 recommendation; day-by-day
deliverables table; risk register update; Phase-3 readiness
checklist; what we learned; numbers; open questions; sign-off +
Phase 3 release-version commitment.

## 4. Rollback plan

Phase 2 is **reversible up through day 11+**. Each step's rollback:

| Day | Step | Rollback | Recoverable | Lost |
| --- | ---- | -------- | ----------- | ---- |
| 1 | Cutover plan | `git revert` | Plan doc | None |
| 2 | Two-device proptest | `git revert` | Test code | None |
| 3 | `loro_bytes` envelope | `git revert` (additive change; old envelopes still decode) | Schema | None |
| 4 | Op-log histogram | `git revert` | CLI tool | None |
| 5 | Cross-platform RSS | `git revert` | Bench reader | None |
| 6 | `loro_doc_state` migration | `git revert` of code; **migration 0052 sticky** but harmless when unused | Code | None (Loro can rebuild from `op_log`, plan Q4 option (a)) |
| 7 | Parity-report | `git revert` | CLI command | None |
| 8 | Spike archive | `git revert` (re-add workspace member) | Spike crate | None |
| 8.5 | Tag/link coverage | `git revert` | Engine extensions | None |
| 9 | Cutover toggle | `git revert`; or simpler — flip the flag (§5). Migration `0054_pend_09_app_settings.sql` is **sticky** but harmless when unused (single empty table). | All | None (SQL state identical because materializer projects from Loro into the same rows; rebuild from `op_log` is invariant) |
| 10 | Partial index | `git revert` | Index | None |
| 11+ | D-bucket sighting | Flip the flag (§5); no code revert needed; file a bug | All | None (zero data lost — `op_log` is unchanged) |

**Net data risk: zero.** The fundamental safety property is that
the `op_log` is unchanged by the cutover. Both engines (diffy and
Loro) read from the same DAG; the cutover changes only **which
engine's output** the materializer projects. If we flip back to
diffy, the next materializer apply re-projects the SQL state from
the diffy view of the same `op_log` rows. The Loro doc becomes a
shadow again; on next sync, both engines re-read whatever new ops
arrived, and shadow-mode parity sampling resumes.

The one **non**-data rollback consideration: SQL rows the
materializer already projected from Loro state may carry slightly
different content than the diffy-resolved equivalent (the
C-bucket cases — LWW tiebreaker disagreement per
`pending/PEND-09-lww-resolution-rule.md` § "Edge cases" closing
paragraph). Flipping back to diffy will re-resolve those rows.
The user-visible effect — a small number of `set_property` values
"changing winner" across the rollback boundary — is the same
class of effect that already happens during routine cross-device
sync; not a regression in user trust.

## 5. The kill switch

A single runtime config that, when set, makes the materializer
treat diffy as authoritative again. The contract:

### 5.1 Storage

A row in a `app_settings` STRICT table — **does not exist
today**; verified by `grep -rn 'CREATE TABLE.*app_settings'
src-tauri/migrations/` returning empty (2026-05-09). The day-9
commit must therefore include a small migration creating the
table:

```sql
-- src-tauri/migrations/0054_pend_09_app_settings.sql (number
-- recomputed at day-9; placeholder uses next-after-day-10 since
-- day 6 takes 0052 and day 10 takes 0053).
CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;
INSERT OR IGNORE INTO app_settings (key, value, updated_at)
VALUES ('pend09.loro_authoritative', '0', datetime('now'));
```

Key `pend09.loro_authoritative`, value `'0'` (off) or `'1'`
(on). Default on first boot post-day-9: `'0'`. The seed INSERT
guarantees the cache (§5.2) reads a definite value on boot —
absent the seed, the `OnceLock<AtomicBool>` would have to encode
a "missing row" tri-state and the first-boot read would default
to whatever the cache initialiser picks, which would surprise on
re-cutover.

Alternative considered + rejected: an environment variable like
`AGARIC_LORO_AUTHORITATIVE=0`. Env-var changes need a process
restart, contradicting §5.3.

Alternative considered + rejected: extending an existing table.
There is no general-purpose `settings` / `config` table today;
`gcal_space_config` is gcal-scoped and per-space. Keeping the
new table generic (`(key, value)` shape) leaves room for future
PEND-XX flags without further migrations.

### 5.2 Read cost

Cached in a `static AtomicBool` (or `OnceLock<AtomicBool>` for
delayed init), refreshed by `flush_task::run_periodic_flush` on the
same 30-second cadence as parity-log flush. Read cost on the
materializer hot path: a single
`AtomicBool::load(Ordering::Relaxed)` — well under 100 ns, let
alone the ≤100 µs requirement. The existing `loro/shared.rs`
(Phase-1 day-2, 89 LOC) is the natural home.

The 30-second refresh cadence means flipping the flag takes
effect on the next `apply_op` after the next flush tick,
worst-case 30 seconds. Faster propagation (a `tokio::watch`
channel woken on `app_settings` write) is over-engineering — the
cutover-soak is days-to-weeks.

### 5.3 No-restart requirement

Flipping `pend09.loro_authoritative` from `'1'` to `'0'` must
take effect **without** a process restart, within ≤30 s.
Implementation:

1. The materializer apply path checks the cached `AtomicBool`
   on **every** fan-out (`apply_op` + `apply_batch_ops` —
   per-record).
2. The flush task refreshes the cache on each tick.
3. Maintainer flips via simple SQL UPDATE (or a future "Phase 2
   cutover off" debug command — out of scope for day 9).

Why this matters: if a D-bucket sighting requires a restart to
recover, the maintainer's data continues flowing through the buggy
Loro path during the restart window. With no-restart, worst-case
exposure is 30 seconds between the bad apply and the next cache
refresh.

### 5.4 Flag persistence after Phase 2 closes

The flag's existence persists at **least one full release** after
Phase 2 closes per
`pending/PEND-09-crdt-migration.md` line 113. The diffy code path
stays callable; the flag stays flippable; only Phase 3 deletes
both.

## 6. Phase 3 hand-off

Phase 3's scope is the **deletion** of everything Phase 2
deprecates. Specific deliverables:

### 6.1 Diffy code path deletion

After **one full release with no flag flips** (cutover-soak ran
the full release window with `loro_authoritative = '1'`
continuously, zero D sightings, zero rollbacks), the following
become deletable:

- `merge/apply.rs` (~600 LOC including `merge_block_text_only`)
- `merge/detect.rs` (~700 LOC)
- `merge/resolve.rs` (~400 LOC including
  `resolve_property_conflict`)
- The move-LWW dispatcher inline at
  `sync_protocol/operations.rs:699-822` (~120 LOC)
- The property-LWW dispatcher inline at
  `sync_protocol/operations.rs:515-697` (~180 LOC)
- ~4 163 LOC total per `pending/PEND-09-crdt-migration.md` line 5

The `pend09.loro_authoritative` flag itself is deleted along with
the diffy code path (the flag becomes unconditional).

### 6.2 `merge_parity_log` table drop

After the same one-full-release window, the parity log has
fulfilled its purpose. Migration
`0055_pend_09_drop_merge_parity_log.sql` drops the table + the
four indexes (per `0051` and `0053`). The
classifier (`classifier.rs`, ~554 LOC), parity sink
(`parity_sink.rs`, ~390 LOC), and proptest harness
(`parity_proptest.rs`, ~496 LOC) all become deletable.

### 6.3 `loro-shadow` cargo feature removal

After diffy deletion, the `loro-shadow` feature is misnamed — Loro
is no longer "shadow"; it IS the path. Phase 3 removes the
feature gate; `loro = "1.12"` becomes unconditional (still
`optional = true`? — see §8.5); `xxhash-rust = "0.8"` becomes
unconditional. All `#[cfg(feature = "loro-shadow")]` gates
disappear; the affected files compile their Loro paths into every
build.

### 6.4 `is_conflict` column drop

Per `pending/PEND-09-crdt-migration.md` lines 67-68 + 145, the
column drop is migration `0043_drop_is_conflict.sql` in the
original plan. Renumber to actual
(`0056_pend_09_drop_is_conflict.sql`) given Phase 1 + Phase 2 +
Phase 3.1 + Phase 3.2 used 0051, 0052 (Gate 6), 0053 (day 10),
0054 (day-9 `app_settings` per §5.1), 0055 (Phase 3.2 parity-log
drop). Reference counts (2026-05-09):

| Scope | Count | Command |
| ----- | ----- | ------- |
| `src-tauri/src/*.rs` (top level only) | 79 | `grep -rn is_conflict src-tauri/src/*.rs \| wc -l` |
| `src-tauri/src/` (recursive) | 682 | `grep -rn is_conflict src-tauri/src/ \| wc -l` |
| FE (`src/`, recursive) | 197 | `grep -rn is_conflict src/ \| wc -l` |
| Whole repo (`*.rs *.ts *.tsx *.svelte *.sql`) | 870 | `grep -rn is_conflict --include='*.rs' --include='*.ts' --include='*.tsx' --include='*.svelte' --include='*.sql' .` |

The original plan's "559-612 references across the whole
codebase" approximation is in the right ballpark for the recursive
counts; Phase 1's merge-orchestrator deduplication of
`shadow_dispatch_for_record` did not measurably move the
reference count (the dedup removed call sites, not column
references). All references are codemod-able once the column is
gone.

## 7. User-decision blocked-on items

Carried forward from Phase-1 final report §8, plus three new items
this plan introduces.

### 7.1 (carried) Conflict-copy conversion rule for existing `is_conflict=1` rows

`pending/PEND-09-crdt-migration.md` Q8. Spike's preferred default
is "concat-into-merge-result" (concatenate "ours" + "theirs" into
a single block, drop the `is_conflict` flag). Alternatives:
delete-the-conflict-copy (lose "theirs"), keep-as-legacy. UX
sign-off needed.

**Suggested resolution.** Concat on day 9. One-shot migration
runs as part of the day-9 commit:

```sql
-- pseudo-migration; final form decided at day-9
UPDATE blocks
SET content = COALESCE(content, '') || E'\n\n---\n\n' ||
              (SELECT content FROM blocks AS conflict
               WHERE conflict.original_block_id = blocks.id),
    is_conflict = 0
WHERE id IN (SELECT original_block_id FROM blocks
             WHERE is_conflict = 1);
DELETE FROM blocks WHERE is_conflict = 1;
```

Maintainer must confirm separator (`---`) and ordering
(ours-first vs theirs-first) before day 9.

### 7.2 (carried) Diffy fallback release window

`pending/PEND-09-crdt-migration.md` line 113 — "at least one full
release after Phase 2 cutover". Maintainer names the actual
release version that ships Phase 3.

**Suggested resolution.** Phase 2 ships in release N; Phase 3
ships no earlier than release N+1, with at least 2 weeks of
cutover-soak between.

### 7.3 (new) Cutover-soak duration

§3 day 11+ specifies **minimum** 1 calendar week, **recommended**
2-3 weeks. Maintainer names the actual.

**Suggested resolution.** 2 weeks. Shorter is acceptable if the
day-2 proptest plus daily `parity-report` histograms both stay
clean. Longer is overkill given the shadow-mode soak's evidence
floor was 7 days.

### 7.4 (new) Cutover release version

The release version that ships the day-9 toggle (with the flag
defaulting **off**). QA + release notes plan against this. Note
this is **not** the release that ships the cutover-on default —
that shifts when the cutover-soak closes. Maintainer can: (a)
ship the toggle and the flip in the same release after private
soak; or (b) ship the toggle dark in release N, flip on in N+1
after public soak.

**Suggested resolution.** (a). The maintainer is the only user; a
public-soak release window adds calendar time without adding
evidence.

### 7.5 (new) D-bucket sighting policy

Zero is the floor. How is a violation surfaced?

- **Telemetry.** Out of scope — agaric has none.
- **Crash log.** Wrong tool — D is divergence, not crash.
- **`tracing::error!`.** Already happens (parity sink writes the
  row; classifier marks D). Easy to miss.
- **User-visible warning in UI.** Maintainer is the only user;
  also runs cutover-soak. A toast or status-bar warning is
  appropriate.

**Suggested resolution.** Status-bar indicator that turns red on
any D-bucket row in the last 24 hours, with click-through to the
day-7 `parity-report` output. Implementation: a Tauri IPC command
returning `bucket_d_count_last_24h: i64` polled every 5 minutes.
Out of scope for day 9; nice-to-have for day 11+. If maintainer
defers to Phase 3 polish (or skips entirely in favour of manual
`parity-report` invocations), acceptable given solo-maintainer
scope.

### 7.6 (new) "Compare diffy and Loro" diagnostic in user-facing UI?

Phase-1 §7 open-question 2 suggested an `agaric debug
parity-report` (closed by Gate 7). A more ambitious version: a
debug panel in the UI showing the bucket histogram + recent
divergences. Useful during cutover-soak.

**Suggested resolution.** Defer to Phase 3 polish. The CLI / IPC
command from Gate 7 is sufficient for the maintainer-only soak.

## 8. Open questions

Genuinely-open items the plan-author could not resolve. Each is
small enough to be answered during day 2-8; none gates the
day-1-plan-doc deliverable.

### 8.1 `loro_doc_state` snapshot cadence + retention

Gate 6 mandates the table; the cadence + retention is undecided.

**Options.**

- **(a) Snapshot every N ops.** Predictable upper bound on rebuild
  cost and storage growth (≈26 MiB per 100K-block-equivalent
  snapshot per `pending/PEND-09-SPIKE-REPORT.md` §3 Q3). N = 1000 is plausible.
- **(b) Snapshot every M minutes.** Predictable wall-clock storage
  growth; less predictable rebuild cost. M = 60 minutes is
  plausible.
- **(c) Snapshot on shutdown only.** Simplest; rebuild cost is
  the whole `op_log` for that space on first boot
  post-snapshot-loss. At 100K-op replay = 1.677 s
  (`pending/PEND-09-SPIKE-REPORT.md` §2 row 3), acceptable for a solo workstation.

**Soft recommendation.** (c) for cutover-day-9 scope; revisit in
Phase 3 if the maintainer's `op_log` grows past ~50K rows per
space and boot replay starts feeling laggy.

### 8.2 Op-type engine coverage gap

The Phase-1 `LoroEngine` (`engine.rs`, 871 LOC) implements only
the five LWW-relevant apply methods the spike covered:
`apply_create_block` (line 178), `apply_edit_via_diff_splice`
(line 261) / `apply_edit_content` (line 316),
`apply_delete_block` (line 357), `apply_move_block` (line 374),
`apply_set_property` (line 404). `merge::shadow_apply`
(`merge/mod.rs:89`) dispatches exactly those five op-payload
variants and logs-plus-skips the rest at lines 184-191 per
Phase-1 day-2 commit `dcfc3637`.

The op types currently log-and-skipped:

- `AddTag` / `RemoveTag` — write `block_tags` rows directly via
  `commands/tags.rs:143,230`. **Real gap**: `block_tags` is
  not a derived cache, so the Loro doc must own these or the
  projection-from-Loro produces stale tag rows.
- `RestoreBlock` / `PurgeBlock` — trash-flow ops. Real gap if
  the cutover happens during a session with active trash
  activity.
- `DeleteProperty` — distinct from `SetProperty`; needs its
  own `apply_delete_property`.
- `AddAttachment` / `DeleteAttachment` — write `attachments`.
  Cutover scope decision (8.5 below).

`block_links` is **NOT** in the gap despite the plan's data-shape
sketch in `pending/PEND-09-crdt-migration.md:34`: production
populates `block_links` by parsing `[[ULID]]` / `((ULID))` tokens
out of `blocks.content` (`cache/block_links.rs:16`), and there
are no `AddLink` / `RemoveLink` op types in `op::OpType`. Once
content flows through `apply_edit_via_diff_splice`, the
materializer's existing `cache::reindex_block_links` re-derives
the link rows correctly from the Loro-projected `blocks.content`.
Same logic for `block_tag_inherited` (re-derived by
`cache::reindex_block_tag_refs` from
`block_tags` + parent-relationship).

**This is a real gap for day 9.** The cutover toggle cannot flip
on until at minimum tag, restore, purge, and delete-property
writes also flow through Loro.

**Suggested resolution.** Add Phase-2 sub-day 8.5 (between Gate 8
and the day-9 toggle) for the op-type gap: extend `LoroEngine`
with `apply_add_tag` / `apply_remove_tag` /
`apply_delete_property` / `apply_restore_block` /
`apply_purge_block`; extend `shadow_apply`; extend the proptest
harness. ~300-500 LOC. Attachment ops (`apply_add_attachment` /
`apply_delete_attachment`) deferrable to a follow-up sub-day if
they slip. Schedule may slip 1-2 days; preferable to surfacing
the gap on day 9.

This is the single biggest risk to the day-9 schedule the
plan-author found. Flagged for explicit maintainer review.

### 8.3 Migration ordering

Phase 2 + Phase 3 migration sequence (verified 2026-05-09 against
`ls src-tauri/migrations/ | tail` — head sits at
`0051_pend_09_merge_parity_log.sql`, so the next free number is
`0052`):

| Migration | Day | Purpose |
| --------- | --- | ------- |
| `0052_pend_09_loro_doc_state.sql` | day 6 (Gate 6) | snapshot table |
| `0053_pend_09_parity_log_pending_bucket.sql` | day 10 | partial index |
| `0054_pend_09_app_settings.sql` | day 9 (§5.1) | kill-switch table |
| `0055_pend_09_drop_merge_parity_log.sql` | Phase 3 | parity-log reap |
| `0056_pend_09_drop_is_conflict.sql` | Phase 3 | column drop |

Ordering assumes Phase 3 ships after Phase 2; if a future Phase
2.5 introduces an intervening migration (e.g. an unrelated PEND
ticket), renumber the Phase-3 entries downstream of the
intervening number.

The original plan's `0042_loro_doc_state.sql` and
`0043_drop_is_conflict.sql` are stale (migration numbers are
sequential and shared across all PEND tickets — the next 11
slots after the original plan was written were taken by
`0042_add_value_bool_column` through `0050_index_tags_cache_name_nocase`
and Phase-1's `0051`). The actual numbers above are placeholders:
each commit picks the actual next-available at the time it lands.

### 8.4 Where exactly does the cutover toggle's reorder happen?

Day 9 says "the materializer apply path reorders so the
LoroEngine apply runs before `apply_op_tx`". Two shapes:

- **Option A.** `apply_op` becomes `loro_apply` → `apply_op_tx`
  (now reads from Loro state).
- **Option B.** `apply_op` becomes `loro_apply` →
  `project_from_loro_to_sql` (a new function bypassing
  `apply_op_tx`).

Option B is cleaner architecturally but requires writing the
projection function from scratch (~200-400 LOC). Option A reuses
`apply_op_tx` but requires editing every code path inside it that
"knows" diffy is authoritative — a much larger churn surface.

**Suggested resolution.** Option B. The maintainer decides at
day 6-8.

### 8.5 Should `loro = "1.12"` remain optional after Phase 3?

Phase 3.3 (§6.3) removes the `loro-shadow` feature gate. Should
the dep itself remain `optional = true`?

- **Yes.** Keeps the door open for a future "no-CRDT build". CI
  configs need `--features default`.
- **No.** Simpler. Loro is a hard dep.

**Suggested resolution.** No (hard dep). The Phase-1 `optional =
true` was to keep the default build byte-identical during shadow
mode; that constraint is gone post-cutover.

### 8.6 Does the cutover commit's revert undo the `loro_doc_state` snapshots?

Day 6 lands the snapshot table + scheduler. Day 9 lands the
toggle. If the maintainer reverts day 9, the snapshot scheduler
keeps running. Are the rows invalid (stale) or useful (replay-
restorable)?

**Answer.** Useful. Loro is a CRDT — a snapshot at any wall-clock
moment is a valid representation of the doc's state at that
moment. A future re-cutover replays the `op_log` on top of the
latest snapshot; staleness only adds replay time, never produces
wrong state.

Structural advantage of the cutover plan: the snapshot
infrastructure has no "before cutover" / "after cutover" mode.
Always-on once day 6 lands.

### 8.7 What if Loro 2.0 ships during Phase 2?

Phase-0 kill criterion 4 (`pending/PEND-09-SPIKE-REPORT.md` §2 row 4) flagged
this as YELLOW — within-1.x format-stability is strong, but the
2.0 transition is "not under contract". Mitigation is the
`loro_version: u8` envelope field (bumping to v2 at Gate 3); a
2.0 release would need v3.

If Loro 2.0 ships during Phase 2 calendar time:

- **Don't bump.** Stay on `loro = "1.12"` caret-1 through Phase 2
  and the one-full-release fallback window of Phase 3. Bump after
  Phase 3 closes.
- The fallback diffy path is the safety net; if Loro 2.0 imports
  Loro 1.x state cleanly (their stated intent), the bump is a
  non-event. If not, the kill switch (§5) is the escape hatch.

The plan does not commit to a 2.0 timeline; this is purely "what
if". No action required unless upstream ships.

---

**Default-build behaviour byte-identical to commit `c6666d9d`.**
This plan is a docs-only deliverable.

— PEND-09 Phase 2 day-1, 2026-05-09.
