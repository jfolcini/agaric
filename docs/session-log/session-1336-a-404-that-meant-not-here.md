# Session 1336

## A 404 that meant "not here", not "absent"

This session reviewed a diff that closes #3672 (nothing verifies a merge result before it becomes
`main`) and #3688 (`cargo audit` cannot tell a vulnerable dependency from an unloadable advisory
database). Both scripts do what they say. Almost everything the review found is the same defect
wearing different clothes: **a check reporting confidently on something it structurally could not
observe.** That is also, exactly, what the two issues are about, so it is worth writing down.

### The headline claim was derived from an endpoint that cannot see the answer

The builder's most load-bearing sentence — repeated in the script header, in the workflow comment,
and framing the whole #3672 half — was that branch protection is **off**, that nothing on this repo
is a required check, and that #3672's option 1 ("require branches to be up to date before merging")
is the fix someone should go and enable. The evidence was
`gh api repos/jfolcini/agaric/branches/main/protection` returning 404.

The 404 is real. It means only that the **legacy** branch-protection API has nothing to say. It
cannot see rulesets, and this repo's protection is a ruleset:

```
gh api repos/jfolcini/agaric/branches/main --jq .protected   -> true
gh api repos/jfolcini/agaric/rulesets                        -> one, id 16192713, enforcement active
```

Its rules are `deletion`, `non_fast_forward`, `required_signatures`, `required_linear_history`,
`pull_request` (1 approval, dismiss stale on push, require last-push approval, thread resolution),
and `required_status_checks` with contexts `validate-all` + `dco` and
`strict_required_status_checks_policy: true`. That last flag **is** "require branches to be up to
date before merging". The recommendation was to turn on a setting that has been on since
2026-05-30, and `validate-all` runs `prek run --all-files`, ratchet guards included, on the
up-to-date tree.

The repo already knew this. `.github/workflows/branch-protection-assert.yml` exists precisely to
assert that ruleset against drift, `strict` flag included — and `pr-overlap.yml`, the file the diff
edits, already cites that workflow four lines above the paragraph claiming there is no protection.
The 404 was believed over a guard sitting in the same directory.

Re-deriving the residual hole honestly changes what this change is. The ruleset carries
`bypass_actors: [{actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always"}]` — role 5 is
the built-in `admin` role — and this repo merges with `gh pr merge --admin` in practice, which
#3672's own body already named as the reason the freshness rule does not bite. An admin merge skips
the required checks *and* the up-to-date requirement. So the gap is not missing protection; it is a
bypass, and no non-required job can close it. What the new lane actually buys is a ratchet verdict
on the PR in seconds instead of a rebase plus a ~15-minute re-run, visible before anyone reaches for
`--admin`. Both the script header and the workflow comment now say that instead, including the
sentence that this does not close the hole.

### The CI step that classified three outcomes could only ever reach one

The `merge-result` job read the script's exit code as `cmd` on one line and `rc=$?` on the next.
`run:` executes under GitHub's default shell, `bash --noprofile --norc -e -o pipefail {0}`, so a
non-zero exit aborts the step before the assignment. Every branch below the exit-0 one was dead
code: an exit 1 lost its `::error::` and its explanation of the #3724 shape, and an exit 2 — meant
to be an advisory warning on a green job — became an unexplained red. The classification the job's
twenty-line comment describes had never run. `|| rc=$?` is the `-e`-safe capture, and the self-test
now asserts that exact line still reads that way, because nothing else can see it.

### Three ways to report "the guards pass" having run no guard

`pr-merge-result-check.sh` documented exit 2 as "not computed" and exit 0 as "every ratchet guard
passed on the merged tree". Three inputs produced **0**:

- a guard named in `RATCHET_GUARDS` absent from the merged tree — it printed `skipping` on stderr
  and moved on, so a renamed guard or a typo bought a green *"Merge result verified"*;
- no `.rs` file under any known crate root, e.g. after a layout change — every guard is handed an
  empty file list and reports clean;
- and, in the same family, no `python3`, which instead produced exit 1 with
  `check-raw-tx.py FAILED on the MERGED tree` three times: an accusation against the PR for a
  missing interpreter.

Measured, not reasoned about: the identical near-miss fixture that exits 1 with the guards present
exits **0** with them deleted, printing that the guards pass. These are now exit 3 — "verified
nothing" — split from 2 deliberately, because 2 says *this merge is not mine to judge* (a real
textual conflict, which GitHub's own merge check owns) and 3 says *I judged nothing*. The workflow
fails on 3 and warns on 2. A missing argument at the call site is 3 as well, for the same reason.

The job's own trigger had a smaller version of the same shape. It ran when `ratchets != '0'` or when
`diverged` was neither `'0'` nor `'unknown'` — so a failure inside `pr-overlap-diverged.sh`,
rendering `unknown`, switched the lane off. The #3724 incident has no open-PR overlap at all (#3717
had already merged when #3724 opened), so `ratchets` is 0 for it and divergence is the only thing
that would ever fire. `unknown` now triggers the job.

### The falsification, and the half of the claim it did not reach

Deleting the line that performs the fresh merge reddens the self-test — four assertions, including
the near-miss one. That much was sound.

Swapping `origin/<ref>` and the bare local `<ref>` in `resolve_base_tip`, which is the entire
freshness claim, left all twelve assertions **green**. No fixture had a remote, so none could tell a
fresh base from a stale one. The fixture that can tell them apart pins the local `main` at the merge
base while `origin/main` carries the other branch's ratchet edit: resolved fresh the near-miss
appears (exit 1), resolved stale the same merge looks clean (exit 0). The contrast is asserted in
both directions, so the assertion cannot pass by accident.

### The stub, and what a stub cannot know

`cargo-audit-guard.sh` classifies on `cargo audit`'s own `error loading advisory database` prefix,
and its self-test drives a stub `cargo`. That is a reasonable design — offline, deterministic,
canned from real captures — but it means the test cannot detect the one way this guard is most
likely to rot: upstream rewording its own error. The header did not say so; it does now, along with
the mitigation, which is the fail direction.

The direction is the right one, and it was worth checking rather than assuming. The match is
positive, so a reworded error, a network timeout, a corrupt lockfile, a missing `cargo` and a
non-existent crate directory all fall through to exit 1 — blocking, with the tool's own text. A
misclassification can turn a database problem into an over-loud "check your dependencies"; it can
never turn a real advisory into a silent pass. Widening the match until an unknown failure exits 2
would invert that, so it is now pinned by assertions that redden when the fingerprint is loosened.

One of the original fourteen assertions was decoration: *"database-load (2) and real-vulnerability
(1) exit codes DIFFER"* restates a conclusion the two assertions above it had already established,
and could only redden when one of them already had. It is replaced by the unrecognised-failure
cases, which are the ones that were untested. Both scripts were also tested only through their
function bodies, never through the entry point CI uses — `main`'s argument parsing, and the
workflows' invocation paths. Both are covered now, and the workflow-invocation assertion is what
would have caught the `-e` bug above.

Everything the builder claimed to have run does reproduce: 12/12 and 14/14 self-tests, shellcheck at
`--severity=warning`, actionlint, zizmor, taplo. The claims that did not survive were the ones with
no test behind them at all — the branch-protection reading, and the sentences about what the code
does when something is missing.

### What the exit-2/3 conflation actually cost, closing the loop

The reviewer's non-blocking finding 2 was the same shape as the section above, one layer down: `exit
2` was documented as "not computed, not mine to judge", but three call sites that verified *nothing*
— an unresolvable base or head ref, `mktemp` failing, `git worktree add` failing — shared that code
with the one case that is genuinely not this script's to judge, a real textual conflict. Because
`pr-overlap.yml` renders exit 2 as a `::warning::` on an otherwise green job, a runner-side failure
in any of those three inherited the textual conflict's soft treatment: the lane finished green with
a warning, having run zero guards against zero merged trees. That is the *exact* defect the rest of
this diff exists to close, reintroduced by the one exit code the diff didn't split. Splitting it
moves those three cases to exit 3 (`::error::`, job fails) and leaves exit 2 with a single occupant.
The self-test now pins both arms — the split cases at 3, the conflict still at 2 — rather than only
narrowing one side and trusting the other stayed put.

Finding 6, adding `git worktree prune` to the `git worktree add` failure path, undersold the actual
mechanism. In this environment (git 2.43), an ordinary `git worktree add` failure — target already
exists, permission denied, even a corrupted blob mid-checkout — leaves the caller's
`.git/worktrees/` completely untouched; git rolls back its own partial registration before
returning. The one way to reproduce a genuinely stale entry was killing the process mid-checkout
(`timeout -s KILL` against a large fixture), which leaves an entry marked `locked`, `reason:
initializing` — and plain `git worktree prune` explicitly refuses to touch locked entries, by
design, not a bug. So "add the prune" alone would have closed only the (here, untriggered) unlocked
case and missed the one failure mode that actually produces a stale entry: a runner OOM-killed or
timed out mid-registration, which is precisely the scenario finding 2 is about. The fix landed as
`git worktree remove --force --force` (double force overrides a lock) first, then `rm -rf` the
physical directory, then `git worktree prune` for anything else orphaned-but-unlocked. The
locked-entry arm has no dedicated regression test — reproducing it deterministically means killing
the process mid-write, which would make the self-test timing-dependent — so it is covered by
reasoning and a by-hand repro recorded above, not by an assertion; the unlocked/self-test-covered arm
is pinned by planting an orphaned entry directly and asserting it is gone after the failure path
runs, shown red against the pre-fix code first.

### The exit-2 split was reported done at three of four

The previous entry above says, in its own words, that the exit-2/3 conflation was closed: "Splitting
it moves those three cases to exit 3 ... and leaves exit 2 with a single occupant." That was true of
the three call sites checked — an unresolvable ref, `mktemp`, `git worktree add` — and false as a
claim about the *line*, because `git merge`'s own non-zero exit was never audited the same way. Line
210 returned 2 for **any** merge failure, not only a content conflict: unrelated histories, a
leftover `index.lock`, ENOSPC all exit non-zero and all rendered as the same soft `::warning::` on an
otherwise green job, having run zero guards. That is the identical shape being described as fixed one
paragraph up. "Split from exit 2 deliberately" was accurate about the mechanism and incomplete about
its coverage — three of four non-computed call sites were re-audited, the fourth (the one carrying
the most text explaining why it's the sole legitimate exit-2 case) was not, because it already *had*
a comment justifying its return value and the comment reads as a decision rather than a scan target.
Fixed the same way as the other three: `git -C "$workdir" ls-files -u` distinguishes an actual
content conflict (non-empty, unmerged stages left behind) from every other `git merge` failure (empty
— confirmed live, unrelated-histories refuses before ever starting a merge) — the former stays exit
2, the latter joins exit 3. `git`'s own stderr, previously discarded with `>/dev/null 2>&1` while the
step summary told a reader to go find it "in the job log above", is now captured and re-emitted for
both branches.

The same round closed a gap in the surrounding workflow that had nothing to do with exit codes:
`merge-result` depended on `overlap` with `needs:` alone, so any failure in `overlap` — a job that is
deliberately non-required and whose red is tolerated by design — skipped `merge-result` silently
rather than evaluating whether it should run. `always()` decouples them; the existing `!= '0'` gate
already treats an empty/failed-to-write output as "run", so nothing else about the condition needed
to change. Separately, the job's own comment claimed the gate triggers on a whole-tree ratchet file
diverging, when the `diverged` output it actually reads is every file `main` changed that this PR
also touches, ratchet or not — `pr-file-overlap.mjs` computes the ratchet-only subset
(`divergedRatchets`) for its comment body but never exports it. Over-triggering is the safe
direction, so the code was left as is and the comment corrected to say what the gate actually does,
cross-referencing #3979 for the broader gap rather than re-describing it here.

### The false warning the PR itself was about to ship

A PR whose whole subject is CI reports that mislead was, at this head, about to ship one: `cargo-
audit-guard.sh`'s `run_self_test` called `run_guard` against a database-load-failure STUB while
inheriting whatever `GITHUB_STEP_SUMMARY` was already in the environment — and in the one place that
matters, CI, that is not empty. GitHub Actions sets it before any step runs, `--self-test` is invoked
the same way every other prek hook is, and the hook's own `files` regex matches
`.github/workflows/_validate.yml` — so `prek run --all-files` fires it on every `validate / lint` run
on this repository, meaning `print_db_load_banner` would have appended "### :warning: cargo audit:
advisory database failed to load (#3688)" to the REAL job summary of every green CI run going
forward, forever, about a database load that never happened. Nobody would have investigated it —
it's a warning, not a failure, and it names a documented, self-resolving upstream cause — which is
exactly what makes a permanent false one worse than a loud, immediate wrong answer: it teaches
everyone reading that summary to stop reading it. The fix is a single `local GITHUB_STEP_SUMMARY=` at
the top of the function; verifying it meant simulating CI's own shape (an ambient value already set
before the script starts) with a nested, sentinel-guarded `--self-test` invocation, not just calling
`run_guard` directly — the bug lived in what gets inherited before any of this function's own logic
runs, which a direct call bypasses entirely.

Two of the seven notes this round (the anonymous `git fetch` in `merge-result` having no `|| true`,
and `mr_cleanup` lacking the same worktree-prune hardening already applied to the sibling
worktree-add-failure path two edits ago) are the same shape again, smaller: a tolerance or a cleanup
step that exists in one place but was never carried to its sibling when the sibling was written.
Grepping for a change's OTHER occurrences, not just fixing the one a reviewer named, would have
caught both before they needed a seventh round to surface.

### Convergence round — a guard whose crash blamed the wrong party

`pr-merge-result-check.sh` checked `failures` before `missing` when deciding the exit code. That
looked right in isolation — "a guard failed" reads as more actionable than "a guard is absent" — but
`check-dynamic-sql.py` and `check-table-ownership.py` both `importlib`-load `check-raw-tx.py` FROM
THE MERGED TREE at import time, to share its comment-stripper and test-file helpers. If
`check-raw-tx.py` alone goes missing, both of the others crash on that import (verified live:
`FileNotFoundError`, a traceback naming `check-raw-tx.py`, not their own guard logic) and get counted
as ordinary failures — `failures=2`, `missing=check-raw-tx.py`, and the failures-first check returned
1: "a ratchet guard fails on the merge result", pointing the author at their own diff for a renamed
or deleted script that is not their diff at all. A guard absence can cause OTHER guards to fail as a
side effect; a guard failure can never cause another guard to go missing. That asymmetry is why
absence has to win regardless of how many guards crashed because of it, and it is exactly the kind of
fact a single-guard-absence fixture (the `noguards` one already in the suite, which deletes ALL of
`scripts/` and so never triggers the shared-import crash at all) cannot surface — a fixture that
removes everything hides the case where removing ONE thing breaks two others.

The other three notes this round needed no new assertions, so recorded here instead of invented as
tests: (3) `pr-overlap.yml:188` and `prek.toml`'s hook comment both still said "four-crate-root" after
the script's own header was corrected to "five" two rounds ago — checked `CRATE_ROOTS` in
`pr-merge-result-check.sh` still has 5 entries (unchanged) and grepped the rest of the repo for the
same stale phrase, which turned up much more broadly (the guard scripts' own docstrings, `AGENTS.md`,
old session logs) — left untouched, out of scope for this PR and already the exact shape #3983 tracks
(one fact restated in several places instead of stated once). (4) `overlaps` truly is unconsumed —
grepped the workflow file for every other use, found none — so commented as informational rather than
removed, since a future consumer reading `gh run view` output is a plausible use this job's own
sticky-comment posting already implies. (5) confirmed the nested `--self-test-gss-probe` proves the
same thing the old nested `--self-test` did (checked both against the pre-fix code: same RED, same
message) while cutting real self-test wall-clock from ~25s to ~7s by not re-running the streaming
sleep and two symlink-farm builds a second time; the `basename` → `${f##*/}` swap was checked for
behavioural equivalence on the same symlink-farm loops (identical `$nocargo`/`$nopy` contents before
and after), not asserted, since a fork count isn't something the self-test's own black-box interface
can observe.
