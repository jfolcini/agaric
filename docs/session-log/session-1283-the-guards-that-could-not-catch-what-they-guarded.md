# Session 1283 — the guards that could not catch what they guarded

**Date:** 2026-08-09
**Issues:** #3647, #3546, #3331, #3332, #3342, #3339, #3367, #3456, #3482, #3322,
#3318, #3561, #3519 (done); #3683, #3684, #3686, #3688, #3690, #3691, #3693, #3698,
#3700, #3702, #3703, #3706, #3707 (filed)
**PRs:** #3685, #3687, #3689, #3692, #3694, #3695, #3696, #3697, #3699, #3701, #3704,
#3705 (merged)

A wide batch session — up to six agents at once — against the tech-debt, testing and
sync backlog. The work itself is unremarkable in shape: verify a claim, fix what
survives, prove the fix red-on-revert. What made the day cohere was that the same
defect kept appearing in the *verification machinery* rather than in the code under
test.

Nine separate instances. In each, a signal that reads as reassurance answers a
narrower question than its reader assumes.

## The shape

A guard is written to enforce a property. It passes. The property does not hold.

- **The NOCASE hoist test** (#3456) killed its intended mutant only through an
  accident: the fast path orders by `name`, the fallback by `tag_id`, and the fixture
  happened to make them disagree. Undocumented, and load-bearing. The decisive check
  was run on `main` with **both** mutations applied at once — the test passed with the
  fast path entirely gone.
- **The metric-provability guard** (#3382) is supposed to reject a test that cannot
  prove its metric fires. Its `isFiringAssertion` credits any `>` comparison without
  consulting the metric's initial value, so `assert!(fts_last_optimize_ms > 0)` passes
  on a freshly built `Materializer` and keeps passing with the production `.store`
  deleted. Confirmed by calling the guard's own exported predicate, not by argument.
  Filed as #3707.
- **The observability leak guard** (#3317) forbids span keys containing `title`. It
  stayed green while `page_title` — usually a real vault path — was written verbatim
  to `traces/agaric-traces.log` and shipped over OTLP, because the guard only inspects
  a span the test itself constructs.
- **The diff-scoped mutation comment** (#3691) reported **All modules 100.0%, no
  surviving mutants** on a PR whose two mutated lines were a constant table addition,
  while ~46 lines of new logic sat in unenrolled modules. The selector's own header
  already states the right principle for its `--max` cap — "overflow is reported, not
  silently dropped" — and does not apply it to non-enrollment, which is the common
  case.
- **`claude-review`** (#3702) reported `SUCCESS` on #3694 with seven findings in a
  comment; two were real defects that shipped. The conclusion answers "did the review
  run", not "did it find anything". Then on #3701 the same reviewer stated it had
  "filed six non-blocking notes separately" — no issues were created, no inline
  comments exist, and only three were named in the prose, so **three are
  unrecoverable**. The survivors are #3703.
- **The session-log numbering guard** (#3690) enforces max+1 against the branch it
  runs on. Two branches forked from the same `main` both computed 1281 and both
  passed. The collision exists only in the merge result, which is the state nothing
  verifies — #3672 from another angle.
- **`cargo audit`** (#3688) collapses "you have a vulnerable dependency" and "the
  advisory database would not load" into one exit code, and its documented waiver
  (`deny.toml [advisories].ignore`) cannot apply to the second, because no advisory ID
  is ever reported.

The common thread is not carelessness. Every one of these guards is doing precisely
what it was written to do. The gap is between the question the mechanism answers and
the question the reader believes it answers, and that gap is invisible from the green
tick.

## Flake triage holds the deciding variable constant

`test_per_block_task_dropped_on_queue_full` (#3482) turned out to have two
deterministic mechanisms, neither probabilistic: the observation `SELECT` starved
behind ~1024 of the test's own pending writes on a 5-connection pool, and queued
copies of the task racing to `DELETE` the row the assertion reads.

The measurement is the point:

| concurrency | 1-min load | failures |
|---|---|--:|
| 8-way | quiet | 0 / 96 |
| 24-way | quiet | 0 / 192 |
| 48-way | 25–36 | 1 / 288 |
| 64-way | 55–79 | 6 / 640 |

Under the standard triage procedure — run it locally in a loop — this issue reads as
unreproducible with 288 consecutive passes. It is not evidence of anything. The
variable that decides the outcome is one the procedure neither controls nor records,
which makes both "cannot reproduce" and "0/500 after the fix" unsound. Filed as
#3698; `BlockTree.scale-envelope`, which two independent agents hit at 12.5 s and
12.8 s against a 10 s budget, is the same class (#3700).

## Issues that were wrong, and issues that were too kind

Verification changed the work more often than it confirmed it.

**Understated.** #3331 reported that `delete_block` reversal restores only the target
row. Deriving the semantics from the backend rather than patching the symptom showed
all *three* lifecycle reversals were single-row edits, and replacing the verb-prefix
heuristic with a signature check surfaced a second write-pool command classified
read-only. #3546 named one state-dependent `NonReversible` arm; there are two. #3367
was filed as an NFD edge case — but scripts with no precomposed forms have combining
marks in ordinary normalised text, so `#हिन्दी` minted a tag `ह` and committed the
remainder into the user's prose. Devanagari, Arabic, Hebrew and Tamil tags were all
mangled on paste, no decomposition step anywhere.

**Prescriptions that would have been regressions.** #3342 suggested interpolating a
page title into a glob as `` `${pageTitle}/*` ``. `prepare_globs` splits on top-level
commas, reads `[...]` as a character class and rejects unbalanced brackets, so
`Notes, drafts` would silently OR two unrelated globs and `Notes [2026]` would fail
the IPC and make a working panel vanish. #3519 proposed a global write mutex or a
transaction spanning check-and-unlink; both writers read `fs_path` straight from the
op payload rather than deriving it from anything the GC mutates, so a lock only
decides whether the writer commits just before or just after the gap — "just after"
leaves the identical row over deleted bytes. It would stall the single SQLite writer
across filesystem I/O and close nothing.

**Refuted outright.** #3322's advancedQuery extraction rested on three claims, all
false against current code: no `lib/` consumer exists, the helpers are already unit
tested, and `QueryBuilderModal` is statically imported so the bundle argument does not
apply. #3546's item 1 was labelled trivial and was not an equivalence — the exported
predicate also requires the `message` half of the envelope, and a message-less value
really can reach it.

## Two metrics deleted rather than tested

`fg_panics` and `bg_panics` are bumped only inside `if outcome.panicked`, reachable
only on an unwind, while `[profile.release]` sets `panic = "abort"`. No test can
clear them: one written to try would run under `cfg(test)`'s unwind and manufacture
exactly the false proof #3382 exists to prevent. Deleted across `QueueMetrics`,
`StatusInfo`, the regenerated bindings, `StatusPanel.tsx`, two i18n plurals, the
tauri-mock and the status snapshot. The panic-*isolation* machinery stays — it carries
the #665 cancellation contract independently.

## Tooling that cost more than the bugs

- **`push.sh`** (#3683) runs its full ~8-minute gate before discovering the branch has
  an unpushable refspec, then reports it as "the PUSH FAILED" — which reads as a
  network problem, the exact failure it exists to protect against. Whether the refspec
  is pushable is knowable in zero seconds. Paid twice on one branch.
- **`cargo-deny`'s advisory cache** refreshes with a hard reset, which never removes
  untracked paths. When upstream relocated `RUSTSEC-2026-0244`, the stale copy
  persisted locally and kept the hook red on an up-to-date machine against unmodified
  `main` — an outage no upstream fix can clear. Recorded on #3688.
- A worktree pruned while its agent was still running, twice, once mid-`push.sh`,
  producing a bogus Phase-C failure. Prune on agent liveness, not on PR state.

## What generalises

The session's own working rule — verify the claim before fixing it — turned out to
apply one level up. A guard is a claim about the code, and it deserves the same
treatment: not "does it pass" but "what does it do when the property is violated". The
cheapest version is the one used repeatedly today and it costs about two minutes:
break the thing the guard guards, and watch it go red. Where that was done, three
guards were found to be decorative. Where it was not, they had been decorative for
months.
