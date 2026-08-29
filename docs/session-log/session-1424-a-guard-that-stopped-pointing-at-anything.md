# Session 1424 — the space-filter guard had stopped pointing at anything

**Issue:** #3255

The `check-space-filter-drift` guard has been green on every commit since the #2621
workspace split, and that green covered four files out of fifteen. The other eleven moved
into `agaric-store` and the guard never followed them: it matched what was left, found
nothing wrong, and exited 0. This re-scopes it, and adds the check that would have said so.

## Three blind spots, not one

The issue title reads as one fix — re-scope the hook. It is three, and each one alone is
sufficient to keep the guard useless.

**The hook was never selected.** `prek.toml`'s trigger was
`^src-tauri/src/.*\.rs$`, so a commit confined to `agaric-store/` did not run this hook at
all. Widening the guard's scan roots without widening this regex would have fixed nothing
for exactly the commits that matter.

**Eleven of fifteen baseline entries named files that no longer exist.**

```
src-tauri/src/backlink/{grouped,query}.rs
src-tauri/src/pagination/{agenda,hierarchy,links,properties,tags,tasks,trash,undated}.rs
src-tauri/src/tag_query/query.rs
```

**Twenty-one of the thirty-one canonical fragments were outside the walk**, which rooted at
`src-tauri/src/`.

`DENY_FILES` had the same rot in miniature: its single entry named
`space_filter_canonical.rs` relative to `src-tauri/src/`, a path dead since the file moved
to `agaric-store`.

## What was actually lost, and what was not

The sibling Rust parity test in `agaric-store/src/space_filter_canonical.rs` walks both
that crate's `src/` and the app crate's `../src`, and stayed green throughout. So the
*shape* invariant — a drifted bind index, `(?2 … ?3)` — was never unprotected.

What was lost is the half only the baseline can provide. A **removed** guard matches
nothing; there is no occurrence left for a regex to check the shape of. The per-file count
baseline is the only net for removal, and for degradation to a bare `b.space_id = ?N`
(legitimate at many single-space sites, which is why the count baseline exists rather than
a simple ban). That net covered four files.

The re-anchor shows the drift concretely rather than hypothetically:
`backlink/grouped.rs` goes **3 → 5**. Two canonical guards were added while the file was
unwatched. A later removal of either would have restored the stale baseline's 3 and passed.

## The check that closes the class

Widening the scope fixes today. It does not stop the next move from doing this again — and
the next move is already planned (#4499 sequences five more phases of exactly this kind of
relocation).

So the guard now asserts that every baseline and `DENY_FILES` entry names a file that
exists. This is the shape session 1299 identified after hitting four instances in one day
and could not act on generally:

> it walked discovered files and asked "is this one allowed?", never "does this entry still
> name a file?" — That is precisely how the first instance survived.

The check is deliberately unconditional: it runs on a targeted `prek` invocation too,
because the rot is a property of the baseline, not of the files in any one commit. A
version that only ran on a full-tree sweep would be invisible in the pre-commit path, which
is where the guard actually lives.

I first gated the `DENY_FILES` half on "the crate root this entry names is present in
this tree", because the CLI self-test's synthetic repo root has no `agaric-store/` and the
ungated check failed there. The review took that apart, and it is the most useful thing in
this session.

The gate made the check inapplicable to **exactly the mistakes most likely to be made** — a
misspelled crate segment, a crate renamed or retired wholesale. A deny entry naming a crate
root that does not exist read as "not applicable" rather than "dangling", so no run could
ever flag it. Demonstrated with three bogus entries (`agaric-storage/src/typo.rs`,
`agaric-observability/src/nope.rs`, `tests/nope.rs`): the guard exited 0 and said nothing.

The sandbox was what was wrong, not the check. `_build_cli_sandbox` now materialises every
`DENY_FILES` path, so it models a real checkout, and the check is unconditional.

Worse, the rationale I wrote for the gate was **factually false**. It claimed the sandbox
"has no `agaric-store/`" — but self-test directions 4 and 5 *create* it. From direction 4
onward every run emitted a dangling-deny finding, so the `code != 0` half of both cases was
satisfied by an unrelated error and only the substring assertions discriminated. I wrote a
confident mechanism into a comment and it was wrong; that is the failure this repo's own
"relayed claims are unverified until you verify them" rule exists for, committed by the
person writing the rule's subject.

## Falsification

Every new case was run against a deliberately broken guard, mutating a **copy** and proving
the restore with `cmp` each time.

| mutant | result |
|---|---|
| `CRATE_ROOTS` narrowed back to `src-tauri/src/` only | both widening cases fail |
| `_assert_paths_exist` baseline half neutered | dangling-baseline case fails |
| `_assert_paths_exist` DENY half deleted outright | dangling-deny case fails |
| `dangling` dropped from `main()`'s exit condition | dangling case fails |
| control (restored) | 24 cases pass |

The per-half rows are not padding. My original table had one row for "`_assert_paths_exist`
returns `[]`", which kills both halves at once — and that conflation is precisely why the
DENY half being **completely untested** went unnoticed: deleting it outright left the
self-test output byte-identical and still passing. A mutant that kills two things at once
cannot tell you that only one of them was covered.

The first mutant is the one worth recording. Under it, the whole-tree case still **exits
non-zero** — for an unrelated reason, a Rule-A drift in a different fixture file. A case
asserting only `code != 0` would have passed against a guard with the widening removed.
Asserting on the specific filename (`sub_drift.rs`) is what discriminates.

That is the "assertion that is true for two reasons" failure mode. I caught it in one place
and then committed it in another: the dangling-deny pollution described above is the same
bug, in the cases I had just written to defend against it. Review caught that one, not me.

And the whole fix, end to end, against the tree as it stood this morning:

```
$ git show HEAD:src-tauri/space-filter-baseline.txt > src-tauri/space-filter-baseline.txt
$ python3 scripts/check-space-filter-drift.py
  src-tauri/src/backlink/grouped.rs: baseline names a file that does not exist …
  … 11 entries …
$ echo $?
1
```

The `prek.toml` half separately: with the old regex, `prek run --files
src-tauri/agaric-store/src/backlink/query.rs check-space-filter-drift` reports **`(no files
to check) Skipped`**; with the new one, `Passed`.

## Verification

- `--self-test`: 24 cases pass (was 10).
- Whole-tree run on the fixed tree: exit 0.
- `prek run` hook selection confirmed on both a member-crate file and an app-crate file.
- `check-hook-deps.mjs`: 0 new gaps, 0 stale.
- `cargo nextest run --workspace -E 'test(space_filter)'`: 8 passed, including both
  `space_filter_canonical` parity tests.

Not run: the full workspace suite. This diff contains no Rust; the parity tests above are
the ones coupled to it.

## A correction to the issue thread

My own comment on #3255 said "26 matching sites in `agaric-store`", from a raw
`grep -c 'IS NULL OR b.space_id'`. The guard's canonical regex counts **21** there — the
grep also matched the canonical constant, prose comments, and structurally-different sites
the guard deliberately does not police. The claim was right in direction and wrong in its
denominator, which is the failure this repo's own rule about denominators names.

## Follow-on

The general form of this — nothing checks that guards still point at anything — is #4501,
filed with the six recorded instances. This session is its first live instance fixed, and
#4501 proposes falsifying the meta-guard against *this* issue's pre-fix state, which is now
recorded above in a reproducible form.

## Review round two

`agaric-reviewer` approved and then listed seven notes, which is the normal shape here — an
approval is not "nothing to address". Four were fixed in a follow-up commit:

- **The dangling hint prescribed a remedy that could not work for half of what it fires on.**
  It offered `--update-baseline`, which rebuilds the baseline and never touches `DENY_FILES`.
  An author hitting a dangling deny entry would run the prescribed command, see nothing
  change, and re-run into the identical message. The hint now names the actual fix.
- **The banner claimed a drift on a dangling-only run.** Nothing had drifted; the header said
  it had. Two headers now, and a self-test case pins it — falsified by reverting to the single
  unconditional banner.
- **Two comments this change made false**, which is the finding worth recording given what the
  section above says about confidently-wrong comments: `_build_cli_sandbox`'s docstring still
  claimed `main()` "only ever scans files under `<REPO_ROOT>/src-tauri/src`", and `main()`'s own
  inline comment still said "only police production .rs under `src-tauri/src/`". Both were
  precise statements of the behaviour this PR removes. I wrote a section about inheriting a
  confidently-wrong comment and left two behind in the same diff.
- **`all_source_files()`'s `seen` set was dead code** — no crate root is a prefix of another, so
  the dedup could never fire. Removed; the `sorted()` it sat next to is load-bearing and stays,
  now with a comment saying why.

Three were left, deliberately: an in-scope-ness check on baseline entries (an entry naming a
file that exists but sits outside `CRATE_ROOTS` is still never walked), a re-anchor that fails
when the total canonical count drops, and a mechanical coupling between `prek.toml`'s regex and
`CRATE_ROOTS`. All three are the same shape one level up — a guard whose scope and whose
subject can drift apart — and belong in #4501 rather than here, where they would be a fourth
hand-maintained pairing defended by prose.

## Review round three

A second approval, six more notes. Two were real and are fixed:

- **`crate_root_paths()` filtered `CRATE_ROOTS` through `is_dir()` and silently dropped what
  was missing.** Misspell or rename a crate segment and the walk narrows to nothing, with no
  signal — this PR's own failure mode, one level up, inside the guard written to end it. Four
  of the six roots carry no baseline entries, so a dangling-baseline finding could not have
  caught it for them indirectly either. `_assert_paths_exist` now flags a root that is not a
  directory, and `_build_cli_sandbox` materialises every root for the same reason it
  materialises `DENY_FILES`.
- **Self-test direction 6 removed a sandbox fixture and never put it back**, and it was the
  last case. Anything appended after it would have inherited a standing dangling-deny finding
  that satisfies the `code != 0` half unconditionally — exactly the pollution the sandbox
  materialisation was added to prevent, reintroduced by the case that tests it.

The second of those is worth being precise about: **it is not falsifiable today.** Because the
case is last, removing the restore changes no observable output, and the self-test passes
either way. It is preventive hygiene, not a demonstrated fix, and claiming a mutant killed it
would be the kind of unearned claim this log has already had to correct twice.

The new root case needed narrowing for the same reason. It first removed `agaric-store/src` —
which contains the only `DENY_FILES` stand-in, so the run went non-zero for *two* reasons and
only the substring assertion discriminated. It now removes `agaric-engine/src`, which holds no
deny entry, so exactly one thing can make that run fail. With the check removed, the case now
yields `(0, '')` rather than a non-zero exit for the wrong cause.

Four notes are left to #4501, where they belong: the `prek.toml` ↔ `CRATE_ROOTS` pairing, the
in-scope-ness of baseline entries, the silent-drop re-anchor, and the Rust parity test walking
two roots while the guard walks six.

## Review round four

A third approval, and one finding that mattered: **adding the baseline file to the hook's
`files:` regex did less than it looked like.**

The intent was that editing `space-filter-baseline.txt` re-runs the guard. It does select the
hook — but every non-`.rs` argument is dropped by the suffix filter, so the target set came out
empty and only the dangling check ran. A hand-edit *lowering* an existing file's count would
therefore pass: the entry still resolves, and no file is scanned to notice the count no longer
matches. That is precisely the edit adding the baseline to `files:` was meant to catch.

`main()` now falls back to the whole-tree walk when arguments were passed but none survived
filtering — which happens only for the baseline itself and the two guard scripts in the regex,
never on an ordinary `.rs` commit. The walk is 3.5s. Falsified: with the fallback removed the
new case yields `(0, '')`.

**And a confirmation the reviewer asked for rather than asserted.** They suspected a commit
that only *deletes* a baselined file would not select the hook, since prek does not pass
deleted paths. Checked directly:

```
$ prek run --files src-tauri/agaric-store/src/does_not_exist.rs check-space-filter-drift
space-filter drift guard (#139)..............................(no files to check)Skipped
```

Confirmed. The gap is real and deliberately not closed here: closing it means `always_run`,
which spends 3.5s on every commit in the repo to cover a case where CI's all-files sweep
already fires, and where deleting a module in practice also edits an in-scope `mod.rs`. Worth
recording as a known limit rather than paying that toll — and worth revisiting in #4501, where
the same question arises for every ratchet guard, not just this one.

The reviewer also caught the PR description still claiming "10 → 14 cases" against an actual
17 — in a change whose whole argument is about denominators being right. Corrected.

## Review round five

A fourth approval, three more fixes.

- **`sorted(DENY_FILES)[0]` would have crashed with an opaque `IndexError` if the set were
  ever emptied** — a legitimate config change, since its sole entry exists only because
  `space_filter_canonical.rs` holds the canonical const. It also exercised only the first
  entry, so a second would have shipped untested. Now iterates every entry and skips cleanly
  when the set is empty; verified by emptying it, where the suite passes instead of throwing.
- **`--update-baseline` never ran the existence checks.** With a misspelled root,
  `compute_baseline()` silently wrote a *narrowed* baseline — the damage happening at the
  exact moment the operator is looking somewhere else, with the report deferred to the next
  ordinary run. The checks now run first and warn. Falsified by misspelling `agaric-engine`:
  the warning fires and names the root before the rebuild.
- **The guard and its sibling Rust parity test had diverged in scope** — the guard now walks
  six roots, the test still walks two — and the test's own `DENY_FILES` comment claimed its
  paths were "relative to `src-tauri/src/`", which was already false for the one entry it
  holds. Both now carry a keep-in-step cross-reference naming the other. Nothing is unguarded
  today, since the other four crates hold no `b.space_id` read; the point is that the two
  lists could drift apart silently, which is this change's own subject one level over.

One note deliberately declined: a whole-`src-tauri` sweep asserting every `b.space_id`
occurrence falls under a listed root. It would close the inverse blind spot — a read landing
in an *unlisted* crate — and it is a good idea, but it is a new check rather than a repair of
this one, and widening the PR on my own is how a focused fix becomes an unreviewable one. It
is on #4501 with the rest.

## A pattern worth naming, about this session rather than the code

Four review rounds, and the reviewer found something real in every one — including two cases
where the bug I had just written was an instance of the class I was fixing: a self-test case
that leaked its fixture into the next case, and a case that passed for two reasons inside the
fix for a case that passed for two reasons. The guard is better for it, and the honest reading
is that the first version was not close to done when I thought it was.

Also worth recording: three `validate-all` failures on this branch were **self-inflicted** —
each was a run cancelled by the next push landing on top of it, and the gate correctly counts
cancelled as unacceptable. Pushing a fix the moment it is ready costs a CI cycle when reviews
are arriving faster than CI completes. Batching the round-four and round-five fixes into one
push would have been better.

## Review rounds six and seven

Two more approvals, converging on the same set. Four fixes, and the first is the one that
mattered.

**The new `CRATE_ROOTS` check had a footgun bolted to it.** `DANGLING_HINT` fires for every
dangling finding and prescribed `--update-baseline`. For a missing *root* that remedy is
actively destructive: `compute_baseline()` walks `crate_root_paths()`, which `is_dir()`-filters
the vanished root away, so re-anchoring deletes every baseline entry under it and reports
success — precisely the "re-anchoring past it is how the finding gets lost" failure the same
hint warns about two lines further down. I had added the warning-before-rebuild in the previous
round and thought that covered it; it did not, because a warning printed above a completed
rebuild is read after the damage is written.

The distinction the two halves need is not cosmetic:

- a dangling **baseline** entry is often *why* you are re-anchoring — the file really moved.
  Warn and proceed.
- a missing **root** is never that. The remedy is to fix the list, not the baseline. **Refuse.**

Demonstrated by misspelling `agaric-store` and running `--update-baseline`: it now exits 1
naming the root, and the baseline is byte-identical afterwards — all 21 store entries intact.
Under the warn-only version the same typo would have deleted them.

**The whole-tree fallback only fired when the target set came out empty**, so a commit editing
the baseline *alongside* a source file scanned only that source file, and a hand-lowered count
for some other file passed. That is the commoner shape and it was untested — direction 8 pinned
only the baseline-only argv. The baseline appearing in argv at all now forces the full walk,
pinned by direction 9 and falsified against the old condition.

**And a third confidently-wrong comment**, flagged independently by both reviews: the fallback
comment claimed it fires "never on an ordinary `.rs` commit". It also fires on a commit touching
only `space_filter_canonical.rs`, which is an ordinary `.rs` commit that the deny filter drops.
Harmless behaviourally, wrong as documentation, and the third instance of this exact fault in a
change whose log opens with a section about it.

The `_build_cli_sandbox` comment blocks were transposed relative to their loops, and the
`src-tauri/src` mkdir was redundant now that it is a `CRATE_ROOTS` entry. Both fixed.

Four notes stay deferred and are unchanged across three rounds now: the parity test's narrower
walk, in-scope-ness of baseline entries, unlisted crates carrying no enforcement, and the
`prek.toml` pairing. All four are #4501.

## Review round eight — and a convergence call I got wrong

I told the reviewer I would treat the review as converged unless a round surfaced a defect in
what was there rather than repeating the deferred set. The next round surfaced one, so the call
was wrong and this is the record of it.

**The removal net could itself be removed.** `base = baseline.get(rel, 0)` means an entry
deleted *outright* reads as 0, so `cnt < base` can never fire for it — and the dangling check
has nothing left to find, because there is no entry to dangle. Hand-editing a line out of the
baseline therefore retired the net for that file, silently. That is this guard's own subject
applied to the guard's own state file, and it survived seven rounds of review including mine.

A file carrying canonical fragments must now carry a baseline entry. A genuinely new file trips
it too, which is correct ratchet behaviour — re-anchor and the entry appears. Falsified: without
the check the case yields `(0, '')`.

**And the coupling I deferred three times is testable here after all.** The reviewer pointed out
that the self-test already spawns the real CLI, so it can parse the `files:` line out of
`prek.toml` and assert the regex accepts a probe path under every `CRATE_ROOTS` entry. That is
not the general meta-guard — it is this guard checking its own pairing — and it closes what two
separate rounds called the single most likely way this regresses. Falsified by narrowing the
regex back: the case names exactly the four roots that would go unguarded.

I deferred it three times on the grounds that it belonged to #4501. That was right about the
general form and wrong about this instance, and the difference is that a self-test addition is
not a new guard.

Also fixed: a fourth stale mechanism comment (the `CRATE_ROOTS` note claimed membership is
tested with `startswith`, which no longer exists), the `_assert_paths_exist` docstring omitting
the roots half and its refuse-not-warn asymmetry, sandbox restores moved into `try`/`finally`
so an exception in `_run_cli` cannot leak a fixture, and `check-space-filter-drift.py` added to
`pr-merge-result-check.sh`'s `examine_probe_guards` — that "a guard that examined zero files is
not a pass" protection gained a fourth subject the moment this guard grew a `CRATE_ROOTS` list,
and `derive_crate_roots` parses it without special-casing.

Four notes stay deferred, unchanged: the parity test's narrower walk, in-scope-ness of baseline
entries, unlisted crates carrying no enforcement, and the general form of the pairing check.

## Review round nine — a fix that did nothing, and a fix I had to take back out

The previous round's `examine_probe_guards` addition was **inert**, and the review caught it.
`targets` there is built from `check-raw-tx.py`'s `CRATE_ROOTS` and forced non-empty by an
earlier exit-3; this guard's roots are that same set plus `agaric-core/src`, so `count_examined`
can only ever return a positive number for it. The zero-examined arm is unreachable. I had
described the change in a commit message as giving that protection "a fourth subject", which was
simply wrong.

The review's suggested substantive fix was `RATCHET_GUARDS`, which actually *runs* the guard
against the merged tree — and that is the right idea, because this guard carries a per-file
count baseline and is therefore subject to the #3724 shape the overlap bot warned about on this
very PR.

**I tried it, and backed it out.** Three things surfaced, in order:

1. Adding it required `RATCHET_PREREQS` entries the review had not reached and my own change
   created: this guard `importlib`-loads `check-raw-tx.py`, whose top-level
   `exec_module(guard_file_source)` runs as a side effect, so a missing copy of either kills it
   at import — exit 1, read as "the guard FAILED on the merged tree", a content verdict from a
   guard that never ran.
2. `pr-merge-result-check.sh`'s own self-test then went red across seventeen assertions, all
   exit 3: its fixtures do not seed the new guard.
3. And seeding it is not the fix either. The fixtures are **synthetic repos** with crate roots
   like `src-tauri/source` and `src-tauri/extra/src`. This guard's new roots check is
   unconditional, so it would report every one of the six real roots missing and fail every
   fixture merge.

That third point is a genuine design question — how should a guard that asserts its own roots
exist behave inside a deliberately synthetic fixture repo? — and the answer is not obvious.
Weakening the roots check to accommodate fixtures would undo the round-four fix. So the whole
`pr-merge-result-check.sh` change is reverted to `origin/main`, the inert entry included, and
the work is recorded on #4501 as the follow-up it actually is.

The lesson is the one the batch rules already state and I ignored for a round: the reviewer's
suggestion was sound, and "the substantive change is one list entry" was still an estimate
rather than a measurement. Its own self-test is what said otherwise, which is the system working.

Kept from this round, in the guard itself:

- Self-test direction 11 read `prek.toml` unguarded, so a renamed or absent file would abort the
  entire suite with a traceback and discard the nineteen cases already recorded. The missing-file
  case now routes into the clean `could not parse` branch that already existed.

**A consistency challenge, answered with a measurement rather than an argument.** The review
noted that this PR declines `always_run` for the deleted-file gap on a ~3.5s-per-commit budget,
while the self-test hook *is* `always_run` on both pre-commit and pre-push and has grown from 3
to 13 spawned subprocesses. Fair — and the right way to settle it is to measure: the full
self-test runs in **0.57s**, six times cheaper than the walk it was compared against. The
asymmetry holds on the numbers.

## Review round ten — a false pass inside the false-pass check

Three fixes, and the first is the one that stings.

**Direction 11 could report coverage this guard does not have.** The `files:` parser scans
forward from the hook id for the first line starting with `files = ` and never stopped at the
next `[[repos.hooks]]`. If this hook ever loses its own `files` line, the first one found
belongs to a *later* hook, and the case validates that regex instead — a green result asserting
a coupling that no longer exists. A false pass, inside the check added one round earlier
specifically to prevent false passes. Bounded to the hook's own block; falsified by deleting the
`files` line, where the case now reports `could not parse` rather than passing.

**Control flow was keyed off diagnosis wording.** `--update-baseline` routes a ROOT finding into
its refusal branch and the other two into a warning, and it selected them by substring-matching
`"CRATE_ROOTS"` against the rendered message — so a baseline path containing that literal would
be misrouted into the refusal. `_assert_paths_exist` now returns `(kind, message)` pairs.
Falsified with a `CRATE_ROOTS_decoy.rs` baseline entry: it lands in the warning branch, where it
belongs.

**`--update-baseline` now prints its per-file deltas and marks reductions.** It regenerates the
whole file, so re-anchoring to absorb one intended change absorbs every other change in the same
pass — including a count reduction, which is the removal this guard exists to catch.
`DANGLING_HINT` told the operator to read `git diff`; nothing made them. Demonstrated by
removing a real guard from `pagination/links.rs`:

```
  src-tauri/agaric-store/src/pagination/links.rs: 1 -> 0  <-- REDUCTION

  A canonical space-filter guard was REMOVED from the file(s) marked above.
```

Three notes stay on #4501, and one of them is now the sharpest thing left: the Python guard walks
six roots and the Rust parity test walks two, bound only by the comments each gained in round
five. Direction 11 pins `prek.toml` ↔ `CRATE_ROOTS` mechanically; **nothing pins Rust ↔ Python**.
In a change whose entire subject is a comment-bound list rotting, that is the one pairing still
resting on a promise. It stays deferred because it is cross-language and genuinely belongs to the
general mechanism — but it is deferred with the observation recorded, not waved off.

## Review round eleven — and one note that was wrong

Four fixes, and the substantive one is a consistency argument I should have made myself.

**`--update-baseline` printed `<-- REDUCTION` and then exited 0.** The missing-root case already
*refuses*; a reduction was merely reported. That asymmetry has no principle behind it — I had
written on #4501 that "a ratchet that can be re-anchored downward without saying so is a ratchet
in name", and then shipped a re-anchor path whose strongest signal was advisory. It now refuses,
with `--allow-reductions` as the explicit opt-in for the legitimate case. The baseline is still
rewritten first, deliberately, so the operator can read the diff the message points at; the
non-zero exit is what stops the commit carrying it. Pinned in both directions and falsified.

Also: the return annotation still said `list[str]` after round ten changed it to tuples;
`BASELINE_PATH` was never `.resolve()`d while `baseline_touched` compares it against a resolved
argv path, which would have silently disabled the force-whole-tree-walk under any symlinked
component; and `CRATE_ROOTS` gained a line saying it is crate `src/` **deliberately**, since as
written it read as "everywhere a fragment could live" — the reading that lets the list rot.

**One note was wrong, and checking mattered.** The review said the hook-id split key
`id = "check-space-filter-drift"` is a prefix of `id = "check-space-filter-drift-selftest"` and
that the case only works because the drift hook is declared first. It is not: the key includes
the closing quote, so it cannot match the `-selftest` id, and the file has exactly one
occurrence. A round-ten review had verified this correctly. Two reviews disagreed and the tie
was broken by running it, which is the only way it should have been broken.

That is worth recording alongside the ten rounds of findings I accepted: the reviewer has been
right about something real every single round, and was still wrong here. "Relayed claims are
unverified until you verify them" cuts toward the reviewer as well as toward me.

## Review round twelve — the refusal was defeated by pressing up-arrow

The refusal added one round earlier wrote the baseline *before* refusing, so the operator could
read the diff. The review found what that costs: **a second identical run sees `before == after`,
finds no drop, and exits 0.** The reduction is absorbed without `--allow-reductions` ever being
typed — and re-running a failed command is the most natural response to it.

Reproduced before fixing:

```
run 1 exit: 1
run 2 exit: 0   <-- the refusal, skipped by repetition
```

Direction 12 structurally could not catch it: it restores the pre-state between its two runs.
Direction 13 does not, and reproduces `(1, 0)` against the old shape.

The fix decides **before** writing. Nothing is written on refusal, so it is idempotent, and the
printed per-file deltas give the operator what the diff would have.

**And the comparison moved from per-file to total**, which fixes a second problem the review
named in passing: a pure **move** shows a per-file loss at the old path and an equal gain at the
new one. Under per-file comparison it refused — and a move is the *headline* reason to re-anchor
at all; it is what #2621 did to eleven of these entries. The command `DANGLING_HINT` prescribes
was failing for its own primary case. A total that drops is a fragment that left the tree;
anything that nets to zero is a relocation. Verified both ways: a genuine removal refuses three
times running with the file untouched, a move re-anchors cleanly at exit 0.

The hints that prescribed the now-refusing command were corrected to match.

**One more falsification standard I had not applied to myself.** Directions 8 and 9 defend the
baseline-in-argv path, but nothing asserted the hook is *selected* when the baseline changes —
delete `^src-tauri/space-filter-baseline\.txt$` from `prek.toml` and the suite stayed
byte-identical and passing. That is precisely the standard this change applies everywhere else,
and direction 11 now covers it.

## Review round thirteen

**The total-only refusal had a hole the reviewer named and I had not stated.** Comparing whole-tree
totals lets a genuine in-place deletion in file A hide behind an unrelated addition in file B: the
sum is unchanged, so the re-anchor proceeds without `--allow-reductions`. The comment justified
totals correctly — a pure move must be allowed, and it is the primary re-anchor case — but never
said what that permits.

The discriminator is whether the losing file **still exists**. A relocation empties its old file;
an in-place deletion leaves the file present with a smaller count. Refusing on either signal
closes it without breaking moves. Direction 14 pins it, and against the total-only version the
case shows `keep.rs: 3 -> 2  <-- fewer` absorbed silently at exit 0.

**A claim in the PR body was stale, and checking it produced a better answer than fixing it.**
The body said direction 6's fixture restore "is not falsifiable — that case is last". It is now
case 6 of 13. So I neutered the restore and re-ran expecting failures.

There were none. The restore is still not falsifiable, but the reason is different and more
interesting: **every case after it asserts on a specific substring rather than a bare exit code**,
so a leaked dangling-deny finding adds noise without satisfying anything. The discipline this
change adopted in round one — assert on the finding, never on `code != 0` — is what makes the
suite immune to its own fixture leaks. The restore defends against a future case that forgets
that discipline, which is worth keeping and worth describing accurately.

Also fixed: `--allow-reductions` existed only in the refusal message, while the docstring and
hints still taught bare `--update-baseline`; `root / rel` over `DENY_FILES` would escape the
sandbox and `unlink` a real file if an entry were ever absolute (latent, but the operations are
destructive, so it is now an assert rather than a coincidence); and the hook-id split is anchored
to a line start so an earlier quoted occurrence cannot relocate the search.

Two notes stay open and are recorded rather than fixed: the Rust `DENY_FILES` entry would also
deny a same-named file under `src-tauri/src/` (latent, silent), and the Rust↔Python root pairing
remains hand-duplicated — the one coupling direction 11 mechanized on the `prek.toml` side and
left unmechanized here.

## Review round fourteen — the guard did not catch its own headline evidence

The most consequential finding of the fourteen, and it went unnoticed by me across all of them:
**a count that EXCEEDS its baseline was silent.**

This change leads with `backlink/grouped.rs` going 3 → 5 — two canonical guards added while the
file was unwatched, and the argument that a later removal would restore the stale 3 and pass. The
guard as written up to this round would not have caught that. The rot it was built to expose is a
class it still permitted, and re-anchoring is the only thing that would ever have surfaced it.

The same silence hides a hand-lowered baseline. Editing `5 foo.rs` down to `3` while `foo.rs`
still carries five passes everything: the entry resolves so `dangling` is silent, it is present
so `unbaselined` is silent, and `cnt < base` is false by construction. Reproduced before fixing —
exit 0.

One rule closes both, and it is the rule already applied to a brand-new file twenty lines above:
a file whose count exceeds its record needs re-anchoring. Verified against the actual historical
state — with `grouped.rs`'s baseline set back to 3, the guard now names it and exits 1.

**And a claim in the PR body was false.** It said forcing the whole-tree walk means "a hand-lowered
count cannot hide behind an unrelated `.rs` edit". It cannot hide behind an edit — it does not
need to, being undetectable outright. The review also noted direction 9 does not falsify that
claim: its fixture drops the source file to 0 as well, so `cnt < base` fires for an unrelated
reason. A case passing for the wrong reason, in the suite whose first lesson was to assert on the
finding rather than the exit code.

Also fixed: the `CRATE_ROOTS` sandbox loop lacked the absolute-path assert its `DENY_FILES`
sibling gained last round — same precondition, same `Path.__truediv__` reasoning, one of two
loops guarded; the docstring claimed "a pure move nets to zero and is allowed" while the code
refuses a *partial* move (indistinguishable from an in-place deletion by counts alone), and now
says so including that `--allow-reductions` is run-wide.

(This paragraph originally ended with "and the hook's `files:` regex now includes the guard
script itself". It did not. See round fifteen.)

**Committed but deliberately not pushed.** The standing rule adopted last round holds: twelve
heads produced zero completed `validate-all` runs because each push cancelled the previous one.
This round waits for `21deb76`'s run to reach a verdict.


## Round fifteen — the fix I said I had made

Two findings, and the second is the one worth keeping.

**The banner called a non-drift a drift.** I only found it because I ran the guard to check a
sentence I was about to put in the PR body, rather than reading the code to check it. Hand-lower
`grouped.rs` to 3, run, and the output opens "the inlined `(?N IS NULL OR b.space_id = ?N)`
fragment drifted", then prints `HINT`, which spends nine lines explaining mismatched bind indices.
Nothing drifted. The SQL is canonical. It is the baseline that does not cover it.

The galling part is that the dangling-only banner was split off two rounds earlier for exactly
this reason, with a comment saying so. Wiring the new `unbaselined` rule into the surviving drift
arm put the fault straight back on the new path. A guard against a class of error is not a guard
against committing it again somewhere else; the comment saying "two headers, because…" was true
when written and stopped being true one commit later, which is the same shape as a `CRATE_ROOTS`
list that stopped pointing at anything.

Three banners now, one per finding class, with the hints routed the same way, and the mechanism
comment says three. Pinned by a separate assertion on direction 15's existing run — mirroring how
direction 3 splits its banner from its exit code, because a regression can spoil either alone —
and falsified by folding the arm back together.

**And the fix I reported last round had not been made.** Round fourteen's review noted the guard
script was absent from its own hook's `files:` regex, so a commit editing only the guard never
ran it over the tree. I wrote that I had fixed it, in the commit message and in this log.
`a046c00` does not touch `prek.toml`. The regex was unchanged until this round.

That is the third time in this change that I have described something as recorded before
recording it. The pattern is specific: the claim is made in the same breath as the work, and the
work is the part that gets dropped. What distinguishes this instance is that the false claim
survived into two artefacts and would have shipped, because nothing checks a commit message
against its diff — the one place in this pipeline with no guard at all.

It is fixed now, and verified rather than asserted:

    before: prek run --files scripts/check-space-filter-drift.py
            -> space-filter drift guard (#139) ... (no files to check) Skipped
    after:  -> ... Passed

falsified by deleting the new alternative from line 2218 alone, which returns it to `Skipped`.
The three sibling guards share the identical `scripts/(...)` suffix, so a naive replace hits all
three; the edit is pinned to the line.

Twenty-five cases. Sixteen mutants.

**CI, finally.** `21deb76` is the first of thirteen heads to run `validate-all` to completion —
every job green, aggregator settling — because this is the first head not cancelled by the next
push. The rule cost two rounds of latency and bought the first real verdict this branch has had.

## Round sixteen — the same fault, one level of combination up

Three notes. Two taken, one rejected for the third time.

**The banner was still wrong, on the combination.** Round fifteen split it three ways so a
dangling or unanchored run would stop claiming a drift. It was a priority chain, so a run
carrying *both* a dangling entry and an unbaselined count announced only the second, over a
list containing "does not exist". Reachable on any commit that edits the baseline — which
forces the whole-tree walk — after one file was deleted and another gained a guard.

Nothing was lost; both hints still printed. But the headline described the finding set as
something it did not contain, which is precisely the fault the split was made to remove,
relocated from the arms onto their combination. Twice now I have fixed this by adding a case
to a chain, and twice the chain has been the thing that was wrong. It now composes one clause
per class that actually fired, so no combination can be described by a class it does not
contain. The single-class wording is byte-identical, which is why the existing cases did not
notice the defect and still pass unchanged.

**A refusal message asserted that the case being refused was allowed.** Two places — the
module docstring and the text printed at the moment of refusal — said a move with the old file
"gone OR EMPTIED" nets to zero and needs no flag. An emptied-but-present file is refused: the
count drops while `is_file()` stays true, so `in_place` fires. So the operator who empties a
file into a shim gets exit 1 and, immediately below it, a sentence telling them that is
allowed. Behaviour was right and is unchanged; only the two claims about it were false.

**Rejected, third time asked:** that direction 11's split key `id = "check-space-filter-drift"`
also matches `check-space-filter-drift-selftest` and works only by declaration order. It does
not — the key carries the closing quote. `prek.toml` holds exactly one occurrence and the split
lands on the block with the `files` line. Verified by running it, as in round ten. Three
reviews have now raised it and two runs have disproved it; recording it here so the next round
does not spend a fourth.

**DCO resolved.** The maintainer chose re-authoring over a Claude sign-off: all commits are now
authored `Javier Folcini <jfolcini86@gmail.com>`, matching the trailer thirteen of them already
carried. `filter-branch` rather than `rebase`, to preserve the one merge commit; the tree was
verified byte-identical to the pre-rewrite backup before the force-push. The local git identity
is now set to match, so the four-commit divergence that caused this cannot recur here.

Twenty-six cases. Seventeen mutants.
