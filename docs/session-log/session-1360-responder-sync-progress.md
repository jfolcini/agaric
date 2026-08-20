# Session 1360 — the reporting half of #4084: a responder-only device stops re-toasting (2026-08-20)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-20 |
| **Subagents** | orchestrator-only (adversarial review of an uncommitted builder diff) |
| **Items closed** | `#4084`, `#4120` |
| **Items modified** | — |
| **Tests added** | +0 (frontend) / +12 (backend: 11 in `agaric-sync`, 1 in `agaric`) |
| **Files touched** | 4 |

**Summary:** Reviewed an uncommitted diff that suppresses the repeated red
`Sync failed:` toast a responder-only device raises on every resync cycle
(#4120 note 1, the impact #4084 actually reported). The review **upheld** the
builder's refusal to make the responder advance `synced_at` or to make
`streamed_at` a scheduling input — that refusal is #610's invariant and is what
#4120's own text calls "deliberate, and the obvious fix is wrong". Two real
defects were found and fixed: the suppression was keyed on the peer's *failure
streak* rather than on the *failure text*, so a failure whose cause changed
mid-streak (and the first pull failure after an unrelated identity refusal) went
unreported; and the "two resync intervals" freshness window was asserted rather
than derived. Every new test was falsified against the production change it
claims to guard.

**Files touched (this session):**
- `src-tauri/agaric-sync/src/sync_daemon/session_supervisor.rs` (+603/−22) — new
  `record_pull_failure` / `peer_pulled_from_us_recently` routing the four
  initiator failure sites in `try_sync_with_peer`; 9 tests
- `src-tauri/agaric-sync/src/sync_scheduler.rs` (+51) — `BackoffState` gains
  `last_reported_error` plus `last_reported_failure` /
  `set_last_reported_failure`. **`peers_due_for_resync` is untouched** — the
  whole point of the change
- `src-tauri/src/db/tests.rs` (+2/−2) — #4120 note 3: two seed INSERTs relied on
  SQLite's DQS misfeature (`"Javier's Phone"`); now `'Javier''s Phone'`
- `src-tauri/src/sync_daemon/tests.rs` (+150, review follow-up) — the wiring
  test that drives the suppression through `try_sync_with_peer`

## The adjudication: the builder's refusal was correct

The brief asked for the responder to record the same progress an initiator does,
and for the scheduler to stop considering such a peer due. Both are wrong, on
the evidence:

- **#610** (closed by PR #1227) established that `synced_at[peer]` means "the
  last time *we* pulled this peer into our store". A responder that advanced it
  would refresh the initiator's clock on every inbound session, so the responder
  would never find the peer overdue and the reverse direction would starve
  indefinitely under sustained activity. That is the bug #610 exists to have
  fixed; `issue610_only_the_puller_records_synced_at` pins it.
- **#4103** already shipped the correct recording half — a *separate*
  `streamed_at` column (migration `0111`), stamped by `record_stream_in_tx` in
  the `SyncComplete` arm's streamer branch, with the device list rendering
  null-safe `MAX(synced_at, streamed_at)`. So "the responder records nothing"
  is no longer true and was not this session's work to redo.
- **Making `streamed_at` a scheduling input** hands the peer a starvation lever:
  our `streamed_at` for a peer is refreshed by *that peer's* activity, and its
  own 60 s cadence lands inside every one of our 60 s windows. `peers_due_for_resync`
  would never fire. `peers_due_for_resync_ignores_streamed_at_4084` pins this on
  both the `None` and stale-`Some` arms.
- **#4120 note 1 says so itself**, in the issue body: *"This is deliberate, and
  the obvious fix is wrong… So this needs a design, not a patch."*

Confirmed by construction, not by reading: both plausible rewrites of the
due-check were applied and reverted — `synced_at.or(streamed_at)` (the `None`
arm) reddens `peers_due_for_resync_ignores_streamed_at_4084` **and** the new
`suppressing_the_repeat_report_does_not_make_the_peer_stop_being_due_4120`;
`synced_at.max(streamed_at)` (the stale-`Some` arm only) sails past the
supervisor test and is caught by the scheduler pin — which is exactly the
division of labour the new test's doc comment claims.

## What is actually suppressed, and for how long

The generic `Sync failed: …` / `Connection failed: …` event is withheld only
when **both** hold: the identical failure text has already been reported to the
user in this streak, **and** the peer's `streamed_at` is within two resync
intervals. Backoff, tracing and the pinned-identity refusal are unconditional.

- Freshness alone would silence a healthy→dark transition — pinned by
  `a_repeat_pull_failure_against_a_dark_peer_is_still_reported_4120` (both the
  never-streamed `None` and the went-dark stale-`Some` shapes).
- Repetition alone would hide a total outage behind one toast — pinned by the
  same test, and by the unknown-peer test.
- The suppression ends within ~2 minutes of the peer genuinely going quiet, and
  immediately on `record_success` or `clear_backoff` (#3547).

## Findings fixed

1. **The changing-cause hole (the real defect).** The streak was counted per
   *peer*: `failure_count(peer_id) > 0`. A peer that failed with
   `Connection failed: peer did not answer within 10s`, then started answering
   and died with `Sync failed: …`, had that second, different, differently-actionable
   fault swallowed for as long as it kept pulling from us. Now keyed on the
   reported text, stored in the scheduler's `BackoffState` — the one structure
   that already resets in exactly the two places "the user has been told this"
   stops being true. Pinned by `a_pull_failure_whose_cause_changes_mid_streak_is_reported_4120`.
2. **A second hole the same key opened.** The pinned-identity refusal books a
   failure and emits its own event *without* going through the helper. Keyed on
   the count, the first genuine pull failure after one of those was suppressed as
   a "repeat" of something unrelated — a report the user had never seen. Pinned by
   `a_pull_failure_after_an_unrelated_failure_booking_is_still_reported_4120`.
   The message key degrades safely in the other direction: a failure text that
   churns reports every cycle, i.e. back to pre-#4120 behaviour, never quieter.
3. **"Two intervals" was asserted, not derived.** Replaced with the arithmetic:
   a peer becomes due after `resync_interval` (60 s) and is noticed on the next
   periodic-resync tick (30 s, `session_supervisor.rs:424`), so a healthy peer
   stamps our `streamed_at` every `(60 s, 90 s]`. One interval is *provably*
   below that lower bound and would go false on a working pair; two clears the
   90 s worst case with half an interval of slack. The doc now states the
   invariant (`window > resync_interval + resync_tick`) rather than the literal
   `2`, and its previous claim of "a whole window to spare" — which was 30 s, not
   60 s — is corrected. Both edges pinned by
   `the_freshness_window_is_two_resync_intervals_4120`.
4. **Edges the diff did not cover**, now pinned: a `streamed_at` exactly at the
   two-interval boundary (inclusive), one second past it, and a `streamed_at` in
   the *future* (peer clock ahead of ours — counts as fresh, and the subtraction
   must not invert).

## Findings checked and left alone

- **All four initiator failure sites are routed.** The sync daemon has exactly
  five `record_failure` call sites: connect timeout, connect error, open-stream
  error and session error all go through `record_pull_failure`; the pinned-identity
  refusal deliberately does not (it is a different device answering to a paired
  peer's name, not a pull that failed). No site double-books backoff — the four
  call sites no longer call `record_failure` themselves.
- **`peer_pulled_from_us_recently` reads this peer's row** (falsified with
  `.find(|_p| true)`), an unknown peer is always reported, and a DB error fails
  *toward* reporting: `list_peer_refs_or_empty` returns `vec![]` on error, which
  yields no row, which yields the unsuppressed report.
- **`peer_refs` is re-listed on every round** (Branch A, B and C each call
  `list_peer_refs_or_empty`), so `streamed_at` is fresh to within one 30 s tick.
- **#4120 note 2** (the `PairingPeersList` re-sort deserving a changelog line)
  is not actionable: the repo has no `CHANGELOG.md` and no release-notes file —
  `scripts/release.sh` derives notes from git history. Recorded here instead.

**Verification:**
- `cd src-tauri && cargo nextest run --workspace` — 5930 tests run, 5930 passed,
  7 skipped, 0 failed. (Bare form without `--workspace` is package-scoped to
  `agaric` only and silently skips every `agaric-engine`/`agaric-store`/`agaric-sync`
  test — #3212.) All nine new `*_4120` tests confirmed present in the run output.
- `cargo fmt --check` — exit 0.
- `cargo check --all-targets` — exit 0, no warnings.
- `cargo clippy --workspace --all-targets` — exit 0, no warnings.
- **Falsification matrix, 12 production changes applied and reverted**, each
  reddening the test that claims to guard it: drop the freshness condition;
  drop the already-reported condition; revert to the per-peer streak key;
  window ×1; window ×3; treat a future `streamed_at` as stale; read the wrong
  peer's row; book the backoff only when reporting; never remember what was
  reported; `record_success` no longer forgets; and both `streamed_at`-aware
  rewrites of `peers_due_for_resync`. No new test is vacuous.

**Process notes:** `sync_scheduler.rs` was deliberately unchanged in the diff
under review, and this session did change it — but only by adding per-peer
state and two accessors. `peers_due_for_resync` is byte-identical, and that is
re-established by falsification rather than by inspection.

**Lessons learned (for future sessions):** when a fix suppresses a user-facing
report, the suppression key is the design. "Once per peer" and "once per cause"
read identically in a one-fault test and diverge exactly where it matters — a
fault that changes while the peer stays broken. Ask what the key *is*, not just
whether the first report survives.

## Review follow-up (PR #4197)

The PR was approved with eight non-blocking notes. Three were addressed in the
branch; three were filed as issues; two were bookkeeping.

**Note 6 — the wiring was untested (the important one).** All nine tests called
the private `record_pull_failure` directly, so a call site handing it the wrong
`peer_id` or a `peer_refs` slice without this peer would have passed every one
of them while re-raising the toast exactly as before. Now
`the_repeat_report_suppression_is_wired_into_try_sync_with_peer_4120`
(`src-tauri/src/sync_daemon/tests.rs`) drives the real initiator path against a
peer that never answers, using the existing `ServiceHarness` /
`unreachable_peer` fixtures.

Driving *two* real cycles is not possible in a unit test: the first failure arms
the backoff gate and each dial costs a full `CONNECT_TIMEOUT` (10 s). So the
second-cycle state is seeded (`record_failure` + `set_last_reported_failure`,
then the gate is waited out as the daemon waits it out) and the seeded text is
the text a *real* failure produced in the test's own first arm — nothing is
hardcoded. Two arms: a dark peer still reports (and supplies that text), and the
same failure against a peer whose `streamed_at` is fresh is silent while the
`connecting` progress event proves the run really dialled rather than returning
early. Falsified twice, against both mis-wirings the note names: passing `&[]`
for `peer_refs` and passing a different `peer_id` each redden it.

**Note 1 — the freshness-window invariant was advisory.** The 30 s tick was a
bare literal in `run_sync_daemon` while the window derived from
`resync_interval * 2`, so any `resync_interval <= 30 s` silently violated
`window > resync_interval + resync_tick` and the toast would return
intermittently on a healthy pair. There is now a shared `RESYNC_TICK` constant
used by the daemon's `tokio::time::interval` *and* by a `debug_assert!` in
`peer_pulled_from_us_recently`, plus two tests: one pinning that the shipped
defaults clear the invariant, one (`#[should_panic]`) pinning that the assert
itself exists.

**Note 5 — the unrelated SQL-literal change.** Checked empirically rather than
argued: with `"Javier's Phone"` restored, both
`peer_refs_0107_endpoint_id_add_preserves_existing_rows_3464` and
`peer_refs_0111_streamed_at_add_preserves_existing_rows_4084` still pass, so the
change was **opportunistic hygiene, not needed for the suite** — this build's
SQLite has the DQS fallback enabled. The literals stay (relying on the fallback
is wrong), and each site now carries a comment saying why, committed separately
from the fix.

**Notes 2, 3 and 4 — filed, not fixed here.** The single-slot
`last_reported_error` (an A/B/A/B fault alternation, or an error whose `Display`
carries a varying detail, never engages suppression), the three separate mutex
acquisitions in a helper that reads as one critical section, and the
pinned-identity refusal still emitting unconditionally every cycle. All three
are safe-direction and none blocks the fix; each is now an issue so the argument
can be revisited from something.

**Notes 7 and 8 — bookkeeping.** The PR body's claim that `sync_scheduler.rs`
"gains only a test" was wrong (it gains a `BackoffState` field and two public
methods; the test lives in `session_supervisor.rs`) and has been corrected. CI
was still pending at review time and must be green before merge.

**Commit plan:** not pushed — working tree left for the caller to commit with
`Closes #4084` and `Closes #4120`.
