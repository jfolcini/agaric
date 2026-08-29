# Session 1436 — advice that converged the collision

#4518. When two PRs claim the same session-log number, the collision guard tells you the next
free one. I followed that advice today and collided again, which is how this got filed.

## The bug is convergence, not visibility

My own account of it was wrong. I thought the problem was that the guard could not see a
sibling's unpushed claim — a visibility gap. It is sharper than that: the suggestion is a pure
function of (merge target, visible claims), so **every colliding PR computes the identical
answer**. Both claimants move to the same number and collide one higher. Following the advice
does not resolve the collision, it translates it.

That is exactly what happened: two PRs on 1423, both told the next free number, both landing on
1426.

The fix is to make the assignment a function of *who is asking*: rank the colliding claimants by
PR number — a stable ordering every run can compute — and hand each the free number at its own
rank, in its own per-branch window.

## The window generalisation is load-bearing, and was proved rather than assumed

Each claimant needs its *own* window, not a shared one, because `check-session-log-numbering.sh`
computes the window from the claimant's own branch maximum. Review proved this against the real
hook in a throwaway repo rather than by reading it: with a branch carrying 1423 and 1450, the
shared-window answer (1424) **fails** the numbering guard — "must be between 1451 and 1460" —
while the per-branch answer passes at both edges.

So a suggestion computed the obvious way would have been advice that fails the very next commit
hook.

## The fix's own claim was still too strong

The emitted line said every run computes the same assignment. It does not. Both the rank and the
free-number enumeration are read off that run's own view of the board, so:

    board {#A:1423, #B:1423}                    -> #A→1424, #B→1425
    same board plus a third PR holding 1424     -> #A→1425, #B→1426

If a claim appears or disappears between two claimants' runs, they read different tables and can
still collide. The behaviour is downgraded from *deterministic* to *a race* — a real improvement
over a guaranteed loop, and not the guarantee the sentence asserted.

The advice is now conditional on seeing the same board, names that residual, and gives the way
out that actually breaks it: if you collide again, do **not** re-take your row — move further up
your own window. Non-greedy, because two greedy claimants are what produced the incident.

## A gate half of which nothing pinned

Falsification found the hole. Reverting the ranked assignment reddened four assertions as
expected. But gating the *retained* branch off — the case where a pure stale claim should still
be told a number — left the **entire 121-check suite green**. Half the gate had no assertion at
all, so a later edit could have silently removed the only remedy a stale-claim author gets.

Pinned now in both directions. The general shape is one this codebase keeps meeting: a change
that adds a condition needs a test for *each* branch of it, and the branch that keeps existing
behaviour is the one nobody writes a test for.

## What the guard could not have told me anyway

Recorded as #4527, found while reviewing this: `check-session-log-numbering.sh` selects staged
files with `--diff-filter=A`. A renumber performed the way its own message instructs — `git mv` —
stages as a rename, so the guard matches nothing and **exits 0 having checked nothing**.

I ran it twice today after `git mv` renumbers and read the pass as confirmation. It never looked.
Worse, whether git records a rename or an add depends on content similarity, so the coverage
flickers nondeterministically, and a run that checked nothing is indistinguishable from a run
that checked and approved.

## Verification

Self-test at 123 checks green; numbering-guard self-test green; oxfmt, oxlint and typos clean.
Every falsification against a copied backup with a `cmp`-proven restore.

One process note worth keeping: the shared session scratchpad is shared across the parallel
agents, and one of them overwrote a probe file mid-review. Backups were verified at each restore
and nothing reached the worktree, but a private subdirectory is the safe default when several
agents run at once.

## Round 2 — the fix had the same shape as the bug it fixed

Review rejected the first round, and the rejection is the most useful thing in this log: the
ranked assignment **still converged**, deterministically, on a single board — the exact #4518
outcome the change set out to remove.

Rank was a *positional index inside each claimant's own window*, with no bookkeeping across
ranks. That is safe only while every claimant shares a window. With merge-target max 1404 and
two multi-entry PRs — #100 claiming `session-1423-a.md` and `session-1426-x.md`, #200 claiming
`session-1423-b.md` and `session-1424-y.md`, 1425 free — the windows differ, and the two ranks
land on the same number:

```
#100 (rank 1 of 2) -> session-1427
#200 (rank 2 of 2) -> session-1427
```

Both claimants compute the same table from the same board, so the "board-conditional" qualifier
round 1 had carefully added does not cover this at all. It describes a *race*; this is
convergence with no race in it. A qualifier that narrows a claim to the cases you thought of is
not the same as a claim that is true.

The fix is to allocate **sequentially**: `nthFreeInWindow(origin, k, claims)` becomes
`firstFreeInWindow(origin, claims, taken)`, with a `taken` set threaded across ranks. Distinctness
then holds by construction rather than by every window happening to coincide. `suggestNextFree` is
re-expressed in terms of the same helper so the two cannot drift apart later.

The same rank-indexing also **skipped free numbers** — Case 33 asserted #4515 → 1452 with 1451
free inside its own window. That expectation was encoded as correct, which is worth noting on its
own: a test can pin a defect as intended behaviour, and then the test is the thing defending it.
It moves to 1451, and a new case asserts positively that no free number in a claimant's own window
is ever skipped, over three boards.

### Two more branches nothing was watching

**A stacked child could be a self-claimant with a row nowhere and a number nowhere.**
`isSelfClaim` keys on `claim.prs` (every carrier), the assignment table on `claim.pr` (the folded
representative). A PR stacked on another open PR, carrying only the parent's colliding file, is
therefore refused *and* absent from the table — and because round 1 suppressed the
next-free sentence whenever any collision existed, it received no number at all. The emitted
"a PR reading this need only find its own #pr in the list" was false for precisely that reader.

It does not get a table row: the number would be for a file it merely inherited and will rename
again on rebase. It gets an explanation of why no row names it, and a free number for a log of its
own.

**A collision and a stale claim in the same run dropped the stale claim's number too**, because
the suppression was gated globally rather than per finding. Gated per finding now. The old test
covered only a *pure* stale claim — the one case where the global gate was already right.

Both remedies read a new `remedySuggestion`: next free, excluding every number this run's
collision tables already handed out. Without it the mixed run offered #101 the very number its own
collision row named — #4518's convergence, one layer down, in the code fixing #4518.

### Verification

Self-test 123 → **131** assertions, green; real tree clean; `prek run
session-log-pr-collision-selftest` passed.

Four falsifications, each against a copy with the restore proven byte-identical:

- restoring rank-indexing reddens **4** — the repro case reads `1427/1427`, and the no-waste case
  reports `{pr:200, free:1425, got:1427}` and `{pr:4515, free:1451, got:1452}`. Its third board,
  the shared-window one, correctly stays green, which is the point: that board could never have
  caught this;
- re-gating the stale sentence globally reddens **1**, the mixed run, whose output ends at "rebase
  onto origin/main and renumber" with no number — the pure-stale case stays green, showing why the
  old test could not catch it;
- deleting the carrier advice reddens the stacked-child case only;
- replacing `remedySuggestion` with the plain suggestion reddens **4**.

## Round 3 — the same defect, one level further out, for the third time

Review rejected round 2 as well, and the finding is the same shape as the one round 2 fixed:
round 2 replaced rank-indexing with a `taken` set, and allocated that set **per collision**.
Distinctness then holds within a table and not across tables.

One board, merge target max 1404, `{#100: 1423, #200: 1423, #300: 1424, #400: 1424}`:

```
#100 (rank 1 of 2) → session-1425, #200 (rank 2 of 2) → session-1426.
#300 (rank 1 of 2) → session-1425, #400 (rank 2 of 2) → session-1426.
```

#100 and #300 are handed the same number, deterministically, on a single board — and **silently**,
because `selfCollisions` shows each PR only its own collision, so neither author can see the other
was told the same thing. The same-PR variant is visible inside one report: with #100 claiming both
1423 and 1424, its own output renders two different files with one number.

Nothing pinned it because **every self-test board had exactly one collision** — cases 30-36, and
all three `noWasteBoards`. That is the shape this very log named two rounds ago, in the section
about a branch nobody writes a test for.

### The class, not the instance

Three rounds is enough evidence that "two things that must be distinct, allocated from independent
non-communicating scopes" is the defect, not any particular instance of it. So there is now exactly
**one** `taken` set in the file, owned by `createRunAllocator(claims)`, created once per `analyze`
and threaded through every site that hands anybody a number: the collision tables, the per-file
stale-claim remedies, and the row-less carrier's number.

The supporting changes are what make that structural rather than a convention:

- `firstFreeInWindow` is a pure lookup that makes no distinctness claim of its own;
- `suggestNextFree` no longer takes a `taken` set at all, and is documented as the non-allocating
  query used only on the CLEAN path;
- `rankedCollisionAssignment` takes the allocator as a **parameter** and can no longer create one;
- the run-wide `remedySuggestion` — one number reused by every remedy, which was round 2's own
  version of this bug — is **deleted**. Each finding carries the number it was allocated, and
  `result.allocated` exposes every number the run handed out, so the invariant is assertable
  directly instead of re-derived at each site.

Allocation is board-wide and ordered — all tables, then all stale remedies, then the carrier — and
computed before the self/other split, so two PRs reading the same board still compute the same
allocation.

### The channel that hid it

`reportFindings` did its own writing, so a rendering defect was only observable through spawned-step
fixtures. It is split into a pure exported `findingLines(result)` and a thin one-`writeSync`
emitter, which is what makes cases 37-43 possible in-process at all. The narrow channel is why "one
collision per board" survived two rounds: not because nobody thought of a second collision, but
because asserting on the rendered output was expensive.

Case 36 had to be rewired off the deleted `remedySuggestion` — reading it would have been
`undefined`, which `includes()` reports as "not assigned", so the case would have kept **passing
while measuring nothing**. That is the specific way a deleted field makes a green test lie.

### Notes, all of them the same root cause

Two stale claims in one report both printed `session-1320`; the carrier paragraph and its number
were emitted once per collision, so a child carrying two colliding parent files got both twice. Both
are the reuse-instead-of-allocate bug at a different site, and both fall out of the run allocator.
The emitted distinctness sentence is now scoped to what the code does — distinct from every row
here, from every row of any other collision, and from every number offered further down —
and `firstFreeInWindow`'s "holds by construction" header is retracted and re-attributed to the
allocator. `analyze` builds new objects instead of assigning `assignment` in place, so its "Pure"
docblock is true.

### Verification

Self-test **131 → 143**, green; real board CLEAN. Six falsifications, each against a copy with the
restore proven by `cmp`: putting the allocator back inside `rankedCollisionAssignment` reddens
**9**, including the verbatim `[[100,1425],[200,1426]]` / `[[300,1425],[400,1426]]` pair; sharing
one run-wide number across stale remedies reddens 3; moving the carrier advice back inside the loop
reddens 1; narrowing the distinctness sentence reddens 1; and hoisting the allocator to module scope
reddens **14**, which is the one that shows the per-run lifetime is load-bearing and not incidental.

## Round 4 — a false claim, a reuse-not-reissue bug, a wrong-cause message, and a hole that closes on its own

Four review notes on #4531. Three fixed here; the fourth recorded rather than fixed, because fixing
it well would have meant touching the same allocator-keying this round already changed twice.

### Note 1 — a parenthetical describing a state that has not merged

The "which guard owns which case" header said `check-session-log-numbering.sh` "examines the
staged additions and RENAMES of the commit in front of it (#4527 widened it from additions
alone)". That is #4527's own fix, and #4527 has not merged — it exists only on the sibling branch
`claude/session-log-numbering-renames`. Checked directly against `origin/main`:
`scripts/check-session-log-numbering.sh:119` still reads
`git diff --cached --name-only --diff-filter=A`, and the file has no rename handling anywhere. I
had pulled the parenthetical in from that sibling branch's own commit message while it was fresh
in mind, and it made the header describe a future state as the present one — the exact "read the
pass as confirmation" trap this log's own title is about, aimed at a reader of the header instead
of at me. Corrected to state plainly that a rename is invisible to check 1 today, with no forward
reference.

### Note 2 — one file, two numbers in one report

`rankedCollisionAssignment` and the stale-claim remedy loop both allocate independently, and case
13 (two open PRs both add an already-merged `session-1000`) is claimed by both findings at once —
the SAME `claims` entries, read twice. Reproduced verbatim: PR #101's `session-1000-mine.md` was
told `session-1405` by the collision table and `session-1407` by the stale-claim remedy two
paragraphs later, in one report, about the one file. Not a race between two runs — one run,
contradicting itself.

Fixed by having the stale-claim remedy loop check a `${number}:${pr}` lookup built from the
collision table's own assignment first, and reuse that number instead of calling `alloc.take()`
again; it only falls through to a fresh allocation when this number was not also a collision. This
also stops the second, wasted window slot the old code burned per file — `allocated` for case 13
shrank from 4 entries to 2.

Case 22 pins both halves: the collision row and the stale-claim remedy now agree on the number for
each of #101 and #102, and `allocated` has exactly 2 distinct entries. Falsifying by reverting the
lookup reproduces the original 1405-vs-1407 divergence exactly.

### Note 3 — `nextFreeSentence(null)` names the wrong cause when the run's own bookkeeping is what emptied the window

`nextFreeSentence` is called from three sites with two different meanings of "null": the CLEAN
path's `result.suggestion` (a pure, non-consuming query — `null` there really does mean every
number in the window is an open PR's actual claim) and the carrier/stale-claim remedies, whose
number comes from `alloc.take()` against the RUN-WIDE `taken` set. Past roughly ten allocations on
one board, the run-wide set alone can fill the 10-wide window with numbers no open PR has claimed
at all — they were only ever offered to OTHER findings' remedies on the same board — and the old
message ("every one is already claimed by an open PR") named the wrong cause for that case.

Reproduced with eleven open PRs all naming one already-merged number: it is simultaneously an
11-way collision (exhausting the window across ranks 1–10) and a stale claim, so the 11th
claimant's stale-claim remedy hits `nextFreeSentence(null)` while `session-6`..`session-15` were
never claimed by anyone — they were handed to the other ten claimants as remedies.

`nextFreeSentence` now takes an `exhaustedByRunAllocator` flag, set at the two `alloc.take()`-fed
call sites (the carrier's advice, the stale-claim remedy) and left unset at the CLEAN path's. The
`null` message forks accordingly: the allocator-fed one says plainly that the window was emptied by
this run's own reservations to other findings, not by real contention, and that moving further up
the window (rather than rebasing to escape other PRs) is what actually helps here.

Case 44 pins the wrong-cause line is gone and the right-cause line is present on the exhaustion
fixture above; falsifying by dropping the flag from either call site reproduces the old sentence
verbatim.

### Note 4 — recorded, not fixed: `reps` dedupe can hand two files one number, and #4527 is the interaction

`rankedCollisionAssignment` dedupes `collision.claims` by `pr`
(`const reps = [...new Set(collision.claims.map((c) => c.pr))]`) before assigning one number per
representative. If a single PR carries TWO DIFFERENT files at one colliding number, `reps` folds
them to one row and one number — reproduced verbatim: PR #100 with `session-1423-a1.md` and
`session-1423-a2.md`, colliding with PR #200's `session-1423-b.md`, renders

    #100 (rank 1 of 2) → session-1424, #200 (rank 2 of 2) → session-1425

for BOTH of #100's files. Acting on that advice literally — renumbering both to session-1424 —
would recreate an intra-branch duplicate, the very defect `check-session-log-numbering.sh` check 1
exists to catch.

**Why it is mostly unreachable today.** For a single PR/branch to carry two files at the identical
number, check 1 has to have missed one of the two additions. It checks every staged file against
`HEAD` (updated as it iterates, even within one commit), so two plain `git add`s of session-log
files at the same number are caught locally before either can reach `gh pr list`. The one way past
it, today, is a same-branch RENAME: `check-session-log-numbering.sh` (`origin/main`, confirmed
above) selects only `--diff-filter=A`, so `git mv some-file.md docs/session-log/session-1423-a2.md`
onto an already-taken number is invisible to check 1 — the PR ends up with two files at one number,
locally, with the guard reporting nothing wrong, purely because the second one arrived as a rename
rather than an add. That is exactly the interaction: **#4527 is the fix that closes this specific
hole.** Its `staged_targets` selector widens to `--diff-filter=ACR`, resolving a rename to its
destination path and running it through check 1 — so once #4527 merges, this same-branch rename
path is caught locally, before push, in every case where the destination number is already taken
in `HEAD`. #4527 is already implemented (branch `claude/session-log-numbering-renames`, commit
`1b04abc95`) but not yet merged into `origin/main` at the time of this note.

**Why I recorded this instead of fixing `reps`.** A correct fix has to key everything this round
already keyed on `${number}:${pr}` — `collisionNumberByPr` (Note 2's own fix, this round) and the
carrier-detection lookup — down to `${number}:${pr}:${file}` instead, AND extend `renumberAdvice`'s
rendering to disambiguate which of a PR's several files a given row's number belongs to (today's
"#100 (rank 1 of 2) → session-1424" names no file at all, and can't while `reps` is deduped by PR).
That is a second pass over the same allocator-keying machinery this round already touched twice
(Notes 2 and 3), on a path that requires bypassing a local guard to reach at all, and that same path
closes on its own once #4527 lands — after which a single PR arriving at `check-session-log-pr-
collision.mjs` with two files at one number would require a GitHub-web-UI edit or a disabled hook,
not an ordinary `git mv`. Given the imminent close and the shared blast radius with two fixes just
made this round, I judged it not cheap enough to do safely in the same pass, and left it as this
note instead of filing a tracked issue for a hole that is already scheduled to close.

### Verification

Self-test **143 → 145** (Note 2's case 22, Note 3's case 44), green; `check-session-log-numbering.sh
--self-test` unaffected and still green (no numbering-guard file was touched — Note 1's fix and Note
4's record are both descriptive, not code, and Notes 2/3 are scoped to
`check-session-log-pr-collision.mjs`). `oxfmt`/`oxlint` clean on the changed file. Real-tree run
(`node scripts/check-session-log-pr-collision.mjs`, no CI-supplied `--prs`) still refuses cleanly —
exit 2, `SESSION_LOG_PR_COLLISION_VERDICT=UNVERIFIED`, `--prs is required` — which is the correct
fail-closed shape for a local invocation with no board to check, not a finding either way.

Two falsifications this round, each against a copy with the restore proven by `cmp`: reverting the
`collisionNumberByPr` reuse in the stale-claim loop reproduces the exact 1405/1407 divergence from
Note 2 and reddens case 22; dropping `exhaustedByRunAllocator: true` from either `nextFreeSentence`
call site reproduces the exact wrong-cause sentence from Note 3 and reddens case 44.
