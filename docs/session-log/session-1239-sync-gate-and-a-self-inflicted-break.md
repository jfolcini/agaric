# Session 1239 — replay-gate hardening, guard-range fix, and a self-inflicted break

`/loop /batch-issues` run, 2026-07-30. Third and final log for the day; 1237 covers through
migration phase 9, 1238 through phase 10.

## The break, first

A `--self-test` shipped in **#3210** built its fixture with `git init` in a temp dir. Run
from a git hook, `GIT_DIR`/`GIT_INDEX_FILE` point at the **real** repository, so that
`git init` was a *re-init of the caller's repo*. Two casualties before it was caught:

- The main checkout got `core.worktree=/tmp/tmp.XXXX` written into `.git/config`, pointing
  at a directory the fixture's own `EXIT` trap had already deleted. Every subsequent git
  command there failed with `fatal: this operation must be run in a work tree`.
- `wt-sync`'s **index** was clobbered — the fixture's `git add -A` ran against it, staging
  all ~4300 files as deletions. Working tree and commit were intact; `git reset --mixed`
  restored it.

Fixed in **#3214**: the fixture now unsets the inherited git environment, sets
`GIT_CEILING_DIRECTORIES`, disables hooks, and **asserts loudly** if the fixture repo ever
resolves outside its temp dir — so a future miss surfaces as an error rather than silent
corruption.

**Why #3210's own CI passed it:** the hook is wired at both `pre-commit` and `pre-push`, and
prek scrubs the git environment at pre-commit but *not* at pre-push. It passed at commit
time and failed at push time. The review had verified the isolation claim — against the
clean pre-commit run only.

**Not fully explained:** the re-init reproduces in a sandbox; the `core.worktree` write does
not. That mechanism is recorded as observed-in-production rather than demonstrable on
demand. The fix defends the whole class regardless.

Cost: one blocked PR, two wasted full-gate runs, and a period where the main checkout was
unusable.

## #3210 — the guard that taught people to bypass the verifier

`verify-ci-equivalent.sh` computed its push range as `origin/main..HEAD`. **Two dots
compares tips**, so any migration on main that the branch predated read as a *deletion*, and
`check-migrations-immutable.sh` rejects deletions. Every branch cut before a migration merged
failed its push for a file it never touched.

```
$ git diff origin/main..569be9554  --name-status -- 'src-tauri/migrations/*.sql'
D  0104_projected_agenda_cache_date_block_index.sql
D  0105_projected_agenda_horizon_rebuild_today.sql
$ git diff origin/main...569be9554 --name-status -- 'src-tauri/migrations/*.sql'
(empty)
```

The failure was indistinguishable from a real violation, and the error message's suggested
remedy is `SKIP_CI_VERIFY`. So the guard was actively teaching agents to bypass the whole
verifier — plausibly the cause of at least one of the two unexplained bypasses noted in
session 1236.

Fixed to three dots (merge-base) with a 9-fixture self-test. Case 5 is the load-bearing one:
a branch that is *both* behind main *and* edits a shipped migration must still fail, so this
cannot be read as a blanket amnesty.

## #3215 — replay-gate hardening (#3190, #3194)

**#3190.** The fork guard short-circuits at `local_counter == 0`, and the gate never mutates
the doc, so on an empty or freshly-reset doc every blob was fork-accepted. Now each blob's
own-peer range is compared against the ranges already accepted; overlap is a `Fork`, disjoint
is not, so legitimate continuations survive.

The first implementation put that check in the **first sweep**, and review showed that was
worse than the bug. With `A=[0,103)`, `B=[55,151)`, `C=[103,205)`: order `A,B,C` keeps two
slots, order `B,A,C` drops **all three** — `B` straddled its neighbours, forked them on both
sides, then was itself dropped as `Unreachable`. *A blob that is never imported had consumed
our `(peer, counter)` space.* Moving the check into the #3188 fixpoint's accept site gives a
canonical order; all six permutations now agree, pinned by a test.

Limitation kept rather than hidden: two slots echoing the **same** pre-reset history at
overlapping ranges are indistinguishable from a fork. `ImportBlobMetadata` has no content
digest and every candidate discriminator is unsound — `ContainerID`s derive from the creating
op's `(peer, counter)`, so divergent lineages collide.

**#3194.** The gate advanced its cumulative base by `partial_end_vv` without checking the
import reached it. The inbox slot is now deleted only once `oplog_vv` provably covers the
declared frontier, and `ImportStatus::pending` — previously discarded by `.map(|_status| ())`
— is surfaced. The residual gap on `apply_remote`/`replay_inbox_row` is filed as **#3213**
rather than papered over; the original in-code justification for it was backwards and was
rewritten.

The internally-gapped-blob fixture was dropped: loro's own encoder refuses to produce that
shape — `ExportMode::updates_in_range` over non-adjacent spans panics and **aborts the
process**.

## #3212 — the verification command under-tests

`cd src-tauri && cargo nextest run`, the form used throughout this workflow, is
**package-scoped**: 3358 tests, and **zero** `agaric-engine` unit tests. `--workspace` runs
5441. All four new engine tests for #3190/#3194 were invisible to the documented "full
suite" command. A false-green generator sitting in the verification path itself.

## Also shipped

- **#3208** (#3160) — the 100K agenda projection. Three defects, do-not-ship on first
  submission; the benchmark had been seeding every recurrence base *in the future*, so the
  100K case was timing an empty scan.
- **#3211** (#3202) — nine non-IPC plugin shims relocated to `src/lib/platform/`. Review
  caught two gates that would have failed (`knip`, oxfmt) plus two components silently
  dropping out of `check-ipc-error-path.mjs` when their imports moved.

## Issues filed

#3209 (14 wrappers with no production callers, unmasked by the `knip` fix), #3212, #3213.

**#3167** — re-measured and found still unmeasurable: zero `e2e-tauri-weekly` runs exist
since #3159 merged, so the cache question has no valid data until Monday 2026-08-03. The
sidecar half *was* settled: `externalBin` was removed from `tauri.conf.json` four months ago
in `34337f420`, nothing spawns `agaric-mcp`, and no spec references it — so skipping its
release build in that lane is safe. Held pending real numbers.

## Notes

- The three adversarial reviews this session each found something the builder missed, and in
  two cases the finding was that a *claim* was wrong rather than that code was broken —
  #3202's "63→56" (really 61→56), and #3190's order-freedom, refuted for the second time.
- `git ls-remote` exits 0 on no match. `ls-remote ... && echo "pushed"` reports success for a
  branch that was never pushed. Cost one wrong status claim mid-session.
