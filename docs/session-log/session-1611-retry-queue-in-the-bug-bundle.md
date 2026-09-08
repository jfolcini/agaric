# Session 1611 — the retry queue in the bug bundle (#4854)

#4854 asks whether a boot-time reconciliation audit should exist. The
maintainer's answer, recorded on the issue: **no audit in the release binary**,
harden the CI side instead, and add the one field signal that costs nearly
nothing — the materializer's own retry backlog, in the bug report.

## Why an audit was the wrong shape, and this is not one

The reconciliation oracle (`src/reconciliation_oracle.rs`, eleven artefacts) is
`#[cfg(test)]`, and #4854 reads as though nothing runs it outside a hand-written
fixture. That is not the case:
`materializer_app_tests::apply_reproject_proptest` already drives random,
structurally valid op chains through the **production** engine apply path — with
a per-case guard that `sql_only_fallback::count()` never advanced, so a case
cannot pass on the SQL-only fallback — settles the materializer, and calls
`reconciliation_failure()` after every op. It runs per-PR in
`validate / cargo-tests`.

So "run the audit in CI rather than on users' machines" is the status quo. The
gap #4854 names is the other half — a specific user's `notes.db`, reached by a
history CI's generator has no alphabet for: a crash between the primary write
and the materializer task, a task a saturated queue shed that outlived its retry
budget, a write failure at the OS level. #3081 is the worked example: a real
atomicity defect the entire e2e estate was green on, found because a user
reported it.

Nothing here audits or rebuilds anything. It reports the state of the backstop
the vault already maintains.

## What landed

`BugReport` gains `retry_queue: Option<RetryQueueSummary>` — depth, the oldest
row's age, the highest `attempts`, and the distinct `task_kind`s present. A deep
or old queue is a vault whose derived state is behind, which is what "my page
count is wrong" looks like from the inside; `task_kinds` is the difference
between "search is stale" and "the page tree is stale".

**`Option`, not a zero.** A failed read and an empty queue are different
answers, and a report that renders a failed read as `0` tells the maintainer the
vault is healthy on no evidence. The frontend renders them as `_(unavailable)_`
and `empty`.

**No `block_id`, no `last_error`.** The frontend embeds this metadata verbatim
into a prefilled PUBLIC GitHub issue body, where an id identifies the user's
content and an error string can quote it. `task_kind` values are the
materializer's own enum literals (migration 0044).

**Not a duplicate of `StatusInfo::retry_queue_pending`.** That exposes the depth
alone, through a command the bug report does not call and whose output the issue
body does not carry. Depth without the age does not say whether the queue is
draining; without `task_kinds` it does not say which artefact is stale. The OTel
pipeline carries more than either and defaults off, so it is absent from exactly
the reports that need it.

The Environment line is rendered even when the queue is empty, on purpose: an
absent line has to mean "reported by a build older than this", not "healthy", or
it proves nothing by its absence.

## Two untyped fixtures, caught by the field

`sampleMetadata` in `BugReportDialog.test.tsx` and `App.test.tsx` were object
literals with no type annotation, so `tsc` stayed green while they drifted from
the IPC contract — and the new field turned 34 tests red at RUNTIME instead.
Both are now `: BugReport`.

## Measured

B6's cost, for the weekly-cadence question #4854 also raises — three runs on
this machine, `cargo nextest run --workspace -E 'test(b6_derived_state_reconciles)'`:

| `PROPTEST_CASES` | elapsed |
|---:|---:|
| 16 (default) | 4.51 s |
| 64 | 15.64 s |
| 256 | 63.79 s |

Linear at ~0.25 s/case. Not acted on here: `PROPTEST_CASES` is proptest's own
env var and it overrides `ProptestConfig::cases` for EVERY proptest in the
workspace, so setting it on the weekly lane raises the whole estate, not B6.
Choosing that number needs a full-suite measurement, which this session did not
run. Recorded rather than guessed.

Also not done, and named on #4854: arms that drive the paths where drift is
actually born — a crash between the primary and derived write, a shed task past
its retry budget, the materializer killed mid-queue — then `assert_reconciled`.
That is where the CI half's remaining value is; the liveness half is already
covered by B6's existing non-vacuity assertions (`coverage.pages_cache_rows >= 4`,
`live_page_blocks >= 4`), so nothing was added there.

## Verified

- `cargo nextest run --workspace -E 'test(retry_queue_summary)'` — 4 passed,
  and falsified three ways against a copy: dropping the `.max(0)` clamp reddens
  the clamp test alone, `MIN` → `MAX` on `created_at` reddens the age test
  alone, and returning an empty summary instead of `None` on a read failure
  reddens the unavailable test alone.
- `npx vitest run` over the bug-report, dialog, App and tauri-mock suites —
  **45 files, 1018 tests**. `formatRetryQueue` falsified twice: rendering
  `null` as `empty` and ordering the age units finest-first each redden their
  own tests.
- `npm run typecheck` clean; `SQLX_OFFLINE=true cargo check --workspace
  --all-targets` clean; `.sqlx` caches and `src/lib/bindings.ts` regenerated.
