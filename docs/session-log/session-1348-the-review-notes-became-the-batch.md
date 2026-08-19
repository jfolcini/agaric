# Session 1348 — the review notes became the batch

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-18 → 2026-08-19 |
| **Subagents** | 5 build (2 of them resumed after an interruption) |
| **Items closed** | `#4071`, `#4133`, `#4141`, `#4126`, `#4129`, `#3967`, `#4138`, `#4065` |
| **Items shipped, PR open** | PR #4155 (hardens the guard PR #4140 added), PR #4157 (this log), PR #4158 (`#4036`, `#3939`), PR #4160 (`#4072`), PR #4162 (`#4078`) |
| **PRs merged** | #4149, #4145, #4136, #4140, #4150, #4151, #4154 |
| **Items filed** | `#4152`, `#4153`, `#4156`, `#4159`, `#4161` |

**Summary:** Seven PRs merged and eight issues closed, but the more useful observation is
where the *next* batch came from. Three of the five builders launched in this session
are not working backlog issues at all — they are working the non-blocking notes the
review bot left on PRs that merged an hour earlier. The backlog sweep found candidates;
the review queue found better ones.

### The reviewer's non-blocking notes are a backlog

Every PR merged here was approved with a "non-blocking notes" section attached, and those
sections are not padding. #4140's approval — for a PR whose entire purpose was adding a
guard — listed four concrete ways to evade that guard, including one (`GH_TOKEN:
${{ secrets.SOME_PAT }}` on the read-scoped job) that reinstates the exact arrangement of
#3967 with zero reaction from the new check. #4150's approval found that the argument in
its own PR description was incomplete: it justified the change with "the exact-match check
returns early on an empty query", which covers `q === ''` but not a non-empty query that
*folds* to empty.

Both were shipped as approved, which was right — neither is a regression, and holding a
correct PR hostage to its own follow-ups just moves the work later with more merge risk.
But the notes were then read as a work queue rather than as commentary, and two of them
turned out to be the highest-value items available:

- The guard-evasion set (now PR #4155, which closed all four), because a guard that passes
  while the thing it protects is broken is worse than no guard. This is the fourth time
  this pattern has been caught in recent sessions (presence-vs-count baselines,
  short-circuit-on-trigger, `- uses:` same-line assumptions, and escaping self-tests that
  never reach the real call site). The recurrence
  suggests the repo convention should be "every guard ships with a self-test proven to fail
  on the pre-fix code," and that this be checked at review time, not hoped for. #4155 was
  built that way deliberately: each of its four fixes was reverted in isolation, the
  self-test re-run to record the exact failures, then restored — so the evidence that the
  new assertions bite is in the PR body rather than assumed.
- The fold-to-empty gap, because it was a live user-visible bug: a combining-mark-only
  query in the `[[` picker suppressed the "Create new page" option and left an empty
  picker, reachable only because #4150 had just changed the seed from `'Untitled'` to `''`.

### Reproduce before fixing, and verify before "simplifying"

PR #4154 is the follow-up to #4150's notes, and its method is worth recording because two
of the four items resolved differently than the note predicted.

The fold-to-empty bug was **reproduced first**. The failing assertion was
`expected undefined to deeply equal { id: '__create__', … }` — and, importantly, the
*other* assertions in that same failing run passed, showing the non-create items were `[]`.
That is the empty-picker symptom itself, not a test artefact. Without that check, a test
that fails for an unrelated reason reads as a successful reproduction.

The "make this consistent" item went the other way. The note asked for `?? 'Untitled'` →
`?? ''` on the FTS path for consistency with the seed site. Rather than apply it, the
builder traced every consumer of that value first — render label, sort key, match key,
resolve-cache write, create-option branch — and only then concluded it was genuinely
equivalent. The same check, run against the alias path, found the opposite: the alias query
selects `b.content AS "title?"` with **no `COALESCE`**, so its `?? 'Untitled'` is correct
for its own source shape and must not be "made consistent". A blind consistency edit would
have introduced a bug in the name of tidiness.

Two further notes were declined outright, with `git show` evidence that both predate the PR
being followed up, and filed as #4152 and #4153 instead. One of them — whether typing
`untitled` should still surface a NULL-content page — was deliberately labelled `idea`
rather than `bug`, on the reasoning that labelling a product decision as a bug invites
someone to "fix" it back.

### Losing a batch to a weekly limit

The session hit the account's weekly API limit mid-batch. Two builders died on their first
substantive turn, with last-known states of "All green. Now the exhaustive sweep after the
fix" and "Let's time `tsc -b` to get real cost numbers".

The recovery is the same shape as the process-exit recovery in session 1347, and worth
stating as a rule rather than rediscovering: **a killed builder's edits are intact on disk
in its worktree, so resume from the worktree, do not relaunch from the issue.** One of the
two had four modified files and a throwaway sweep harness on disk representing most of the
work; relaunching would have discarded it and re-derived it. The resumed brief has to
re-state the verification the agent still owed, because the files on disk record what it
*did* and not what it had not yet proved.

The dead builders also left `in-progress` labels on their issues. Session 1347 spent a
section on exactly this — seven stale claims blocking a backlog sweep — which is evidence
that "remember to clear the label" is not a working mitigation. The label needs to expire
on its own or be derived from branch/PR state.

### #4072 — two fixpoints, and the seed pin they were holding open

#4072 bundled two rare round-trip violations that the #4059 sweep had found and left
live. Fixing them turned out to be the precondition on a comment already in the tree:
`markdown-roundtrip.property.test.ts` carried a fast-check seed pin whose docstring said,
in as many words, "delete the pin when violations 2 and 3 are fixed, not before". So the
real deliverable is not two one-line matchers — it is that the file explores randomly
again.

**A callout-shaped link.** A link whose visible text begins with `!` serializes to
`[!a](https://example.com)` — character-for-character a `[!TYPE]` callout marker with a
destination glued on. Leading a blockquote it re-parsed as a callout named `a`, so the
label was upper-cased and re-emitted as `[!A] (…)`. The inserted space is what makes this
more than cosmetic drift: it breaks the link. The two productions differ at exactly one
character — a callout's `]` is followed by end of line, whitespace, or its title, never by
the `(` that opens a link destination — so `CALLOUT_RE` refuses that one follower and
nothing else about callout syntax narrows.

**A cell edge that two frames disagreed about.** A markdown table cell is single-line, so
a hardBreak inside one degrades to a space, and `parseTable` trims the cell on both edges.
Those two rules ran in the wrong order: the break became a space at the node level;
`serializeParagraph` then saw a paragraph beginning with a space and declined to escape the
block marker behind it; and only afterwards did the string `.trim()` pull that space off,
emitting a bare `>` at the cell edge. The reparse stores the marker as plain text, whose
own serialization *does* escape it — so pass one wrote `| > |` and pass two `| \> |`,
forever. The trim now happens at the node level, before any escaping decision.

**The third file nobody had cited.** `src/lib/block-type-convert.ts` keeps its own callout
matcher for the Turn-into menu. Fixing the parser without it would have *created* a
divergence: the editor renders a plain quote holding a link while the menu still highlights
"Callout" and `stripBlockMarker` eats the `[!a]` that *is* the link's text. Both patterns
now derive from one shared fragment, and the test that matters is the cross-check — same
string, same verdict on both sides — not a restatement of the regex.

**What the sweep measured.** Before and after over the same corpus — six alphabets, free
and prefix-anchored, plus a seeded random corpus, 1,607,480 inputs. 616 non-convergent
before, 21 after, and **zero inputs that converged before and stopped converging after**.
That last number is the one the fix had to earn; the other two only say how much ground it
covered. The 21 survivors are one unrelated family present identically on both sides — an
emphasis span wrapping only whitespace, where `* *` re-reads as a bullet list — filed as
#4156 rather than folded in, because a fix there is about the serializer refusing to emit a
mark whose content cannot survive re-reading.

**Retiring the pin.** The evidence bar was set by the sweep that justified adding it
(10 seeds × 20,000 runs) and cleared with room: 32 seeds × 20,000 runs green across all 42
tests — with the *same* sweep reddening at seeds 1, 6, 9, 10 and 12 on the parent commit,
which is what makes the green mean something rather than merely being green.

### #4078 — the merge-result check learns to compile

`pr-merge-result-check.sh` computed the real merge of a PR and `main`, then ran only the
six whole-tree ratchet guards against it. The same failure class in ordinary source — each
branch correct alone, the merge wrong, no textual conflict — walked straight through with a
green "merge result verified". It did, on 2026-08-18: #4074 consolidated the property seeds
in `markdown-roundtrip.property.test.ts` and deleted `hasKnownIssue4049Drift`; #4075 added
three properties to the *same file* still referencing it. Disjoint hunks, so git merged them
silently; both branches green because each was internally consistent; the merged tree did
not compile, and `main` sat un-compilable until a release build noticed (#4077).

Per-PR CI structurally cannot see this — it tests the branch, not the branch merged into
whatever `main` has become. `pr-merge-result-check.sh` *can*: it already builds the actual
merge in a disposable worktree. It simply declined to look at anything but ratchets.

The merged tree is now type-checked with `npm run typecheck` — the repo's single definition
of "does this tree compile", deliberately not a sixth spelling that can drift. The new exit
code is **4, not a reuse of 1**: exit 1 renders in `pr-overlap.yml` as "a ratchet guard
fails" and points the author at `prek --all-files`, which is the wrong instrument for a
TS2304 — and a guard-shaped message for a compiler error is how a real finding gets
dismissed as ratchet noise. Every "the stage could not run" case is exit 3, never a quiet
pass: no install to borrow, an empty one, no `package.json` / `typecheck` script /
`tsconfig.json`, or a lockfile the borrowed install does not match. Half a verdict is not a
pass.

`node_modules` is borrowed rather than installed — the job already runs `npm ci` in its own
checkout, and the entries are symlinked into a *real* directory rather than the whole tree
being symlinked, because the tsconfigs write `tsBuildInfoFile` under `node_modules/.tmp/`
and a whole-tree symlink would write the merged tree's incremental state into the caller's
install.

The falsification was demonstrated red in the shape the issue asked for, modelled on the
real incident: `main` deletes a symbol and re-points its own use at the top of the file, the
PR adds a use at the bottom, and eight filler lines keep the hunks past git's three lines of
context so it merges cleanly rather than conflicting. Against `origin/main`'s script: exit
0, empty stderr. Against the new one: exit 4, `TS2304: Cannot find name 'NESTING_SEED'`. The
self-test pins the red half as an assertion — no guard reports anything on that merged tree
— so "the guards-only script had nothing to say about it" is recorded as a fact rather than
a claim.

Cost was measured rather than estimated, on real runs of this repo: `npm ci` 16–21 s,
`npm run typecheck` 7–8 s cold, the job itself previously 23–25 s — so ~55–65 s inside an
unchanged 10-minute ceiling. This PR's own `merge-result` run then went green at 56 s,
inside the predicted band. Affordable at all because TypeScript 7.0.2 is the native
compiler: 1757 files and ~535k lines check in seconds.

### Three PRs claimed session 1348

This log, #4160 and #4162 each added a `docs/session-log/session-1348-*.md`, independently
and within the same hour.

It is worth being precise about why the guard did not catch it, because the obvious
explanation is wrong. `scripts/check-session-log-numbering.sh` does *not* only see its own
tree — it unions the numbers in `HEAD` with those in the merge target (`origin/main`) and
tests against that union, added for exactly this failure mode in #3690. The gap is
narrower: **a sibling branch that has not merged yet is invisible to any tree-based
check.** Each of the three branches held exactly one 1348 file and none of the others
existed on `origin/main`, so all three were legitimately green, and the collision would
have surfaced only on the second merge.

That distinction matters — reported as "the guard only sees its own tree", it invites
someone to re-fix something #3690 already fixed. This is #3933, observed rather than
theorised, on the first batch where three agents wrote logs concurrently. The parallelism
that made the batch fast is precisely what made the number contended, so the trigger is
not rare-and-getting-rarer; it scales with how many builders run at once.

The resolution was to keep one log — this one — and fold the other two in, which is also
the right answer on the merits: one session's work is one narrative. #4160's half is the
markdown-fixpoint section above; #4162's is the one below.

### Process notes

**Bounding the merge on approval recency.** Each of the seven merges checked that the
approval's `submittedAt` post-dated the head commit's `committedDate` before merging.
#4140 in particular had four reviews — `APPROVED`, `APPROVED`, `CHANGES_REQUESTED`,
`APPROVED` — where taking "has an approval" at face value would have merged over an
unaddressed change request.

**A red check that was not a red check.** #4151 showed `claude-review` failing. The failure
was the review job erroring, not the review finding anything — the `claude-review findings`
check was `skipping`, not failing. Re-running it produced a clean approval. The two states
are visually identical in `gh pr checks` output and only distinguishable by reading which
of the two related checks failed.
