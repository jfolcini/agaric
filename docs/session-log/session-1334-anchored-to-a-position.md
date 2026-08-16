# Session 1334

## Anchored to a position

`.github/zizmor.yml` suppressed four `cache-poisoning` findings by **line number** — `ci.yml:318`,
`:341`, `:471`, `:503`. Any unrelated edit above them shifted the anchors and turned four suppressed
findings into four `high` failures. Per the file's own postmortem, that happened four times in one day.

The failure is the worst kind for a gate: a **passing** tree fails, for a reason unrelated to the
edit that triggered it. Do that often enough and the gate gets treated as noise.

zizmor 1.28.0 has a built-in inline suppression — `# zizmor: ignore[rule-id]` — that anchors to the
step's *content* rather than its position. All four moved onto the steps themselves and the
`rules:` block emptied.

Two things the review insisted on checking rather than assuming, both of which could have inverted
the fix:

- **Is the inline mechanism real for the pinned version?** An inline directive silently ignored by an
  older binary means four *unsuppressed* high findings — the opposite failure, arriving quietly.
  `zizmor --version` reports 1.28.0, matching every pin in the repo, and the post-fix run reports
  `4 ignored`.
- **Did each suppression land on the right step?** A suppression on the wrong step suppresses a real
  finding and leaves a fake one. Each old line number was resolved against `git show HEAD:` and matched
  to its new inline location: two `Swatinem/rust-cache`, two `actions/setup-node`, across the `build`
  and `android-build` jobs. Four exact matches.

### The fragility only reproduces at realistic size

Worth recording because it nearly produced a wrong conclusion. A **one-line** insertion above the
suppressed region did *not* redden the pre-fix shape — zizmor's config-level ignore has some positional
tolerance for tiny shifts. An 18-line insertion, matching the historical shift documented in the
postmortem, reddens it immediately: `4 high`, exit 14. The post-fix shape survives the identical
insertion at exit 0.

A falsification that fails to falsify is not evidence the bug is absent; it can just mean the probe
was too small. Sizing the probe to the real incident is what made it conclusive.

### Where the guard's strength actually lives

The new `check-cache-poisoning-suppressions.mjs` only checks for the *presence* of the directive
string and the *absence* of a reintroduced line-anchor list. It does not verify a directive resolves —
so on its own it would fail open against a typo'd rule id.

It does not stand on its own. The real `zizmor` prek hook runs on any workflow change, and a malformed
directive simply fails to suppress, so zizmor reports the finding as genuinely `high` — loud, locally
and in CI. The combined system fails loud; the JS guard's job is only to stop the line-anchored *shape*
returning. Stating which component carries which half is the part that keeps the next reader from
over-trusting either.

## A set that advertised its own inverse

`scheduled-deep-checks.yml` appended `--dry-run` whenever the trigger was not `schedule`. So a
`workflow_dispatch` run computed the correct failing-lane set — and threw it away. The tracking issue
kept advertising the previous week's set, possibly disjoint from the truth, for up to seven more days.

That is worse than reporting nothing. Nothing invites a check; a confident wrong set invites action.

The fix removes `--dry-run` from the dispatch branch and keeps `--skipped-ok`, and both halves needed
verifying rather than accepting:

- **Is `--skipped-ok` still needed?** Tracing the reporter's ten dependency lanes: only
  `file-fuzz-findings` is gated `github.event_name == 'schedule'` and legitimately reads `skipped`
  off-cron. `file-mutation-survivors` is `if: always()`, so it reports a real result. The other eight
  have no conditional gating at all and cannot legitimately skip — a real infrastructure problem there
  surfaces as `failure` or `cancelled`, neither of which the flag exempts. So it is correctly scoped by
  the workflow's actual structure.
- **Is writing on dispatch idempotent?** The claim was "the tracking issue is a set, not an append-log."
  Checked against the write path: `known` lanes are re-derived from the issue body every run, diffed
  against the fresh set, and any write rebuilds the whole body and pushes it with `--body-file` — a
  full replace. Comments fire only on notify/close transitions, and an unchanged set takes the `noop`
  branch with **zero** `gh` calls. So a dispatch cannot spam the issue.

Both are the kind of claim that sounds obviously fine and would have been embarrassing to be wrong
about — a reporter that appends rather than replaces would have turned this fix into an issue-spam
bug.

### And the fix contained the same defect, inverted

Review found the idempotency argument above was right about the lanes it considered and silent about
the one that mattered. Removing `--dry-run` from the dispatch branch left `--skipped-ok` in place —
and those two flags were only safe together *because the dispatch never wrote*. The script's own
self-test said so verbatim: `--skipped-ok exempts skipped (dispatch dry-run only)`.

With real writes enabled, a lane that merely **skipped** falls out of `current`, appears in
`resolvedOnes = known − current`, and `decideAction` returns `close`. So a dispatch reports a lane
recovered on the strength of it never having run, clears it from the tracked set, and the issue reads
green until the next Monday cron. With other lanes still red the same inputs yield `sync` instead —
which drops the lane with no comment at all. Quieter, same wrong state.

That is precisely the harm this PR set out to fix — a tracking issue advertising a set that is not
the truth — reintroduced by the fix, in the opposite direction. The first version threw away a
correct result; this version would have published an incorrect one.

The invariant that was missing has to be stated as a pair, and only the pair is right: a skipped lane
must not count as failing **and** must not count as recovered. It is carried over from `known`
instead. The `known.has(j)` guard matters as much as the carry-over itself — without it, a lane that
skipped would be *added* to the tracked set, which is the converse error. Both directions are pinned
by assertions that were shown to redden under the opposite mutation, plus a third pinning that a lane
which really ran and passed still closes the issue. Without that third one, carrying everything
forever would satisfy the first two.

### The stale justification was the mechanism, not a detail

Worth recording that the blocking bug's proximate cause was a comment nobody re-read. The flag was
correct under an assumption stated in prose, the assumption was deleted, and the prose stayed.

The same shape turned up twice more in the same review. The watchdog step was still gated to
`schedule` on the reasoning that "a dispatch is watched by the human who triggered it, and its
`--dry-run` failure must not file an issue" — a sentence whose premise had just been removed. And two
comments still described "the two schedule-only filers" when #3394 had un-gated one of them.

So the new watchdog condition is pinned by **code** rather than by a comment: a check reads the `if:`
verbatim, can see an event gate, and throws on a rename or a missing condition instead of passing
vacuously. A justification that can go stale silently is not a justification; it is a note.

### The guard passed everywhere except the place it runs

CI reddened on the one hook this PR adds, and only on CI. Locally, `prek run --all-files` was green
on the identical commit.

zizmor's `--color auto` resolves to **colour under `GITHUB_ACTIONS=true`**, TTY or not. The negative
control parses zizmor's human-readable output, and its rule-id header regex is anchored: `^\s*[a-z]+\[`
does not match `\x1b[1m\x1b[91merror[cache-poisoning]`. So every `-->` location below it belonged to no
rule, the harvest came back empty, and the control failed reporting that it *could not derive any line
numbers from a real zizmor run* — while printing, in its own failure message, the four findings zizmor
had just reported. The diagnostic and the evidence contradicted each other on the same line.

Reproduced by setting `GITHUB_ACTIONS=true` locally, which is the whole lesson: a self-test that shells
out to a tool inherits that tool's environment sensitivity, and "it passes locally" says nothing until
local resembles CI.

Fixed at both levels, and each half falsified separately. `runZizmor` passes `--color=never` — the root
cause, since the parse should not depend on an ambient variable at all. `findCachePoisoningFindingLines`
strips ANSI regardless, so the parser is correct for any caller that forgets. Removing the strip alone
fails the new colourised-fixture assertion; removing both reproduces CI's failure byte for byte.

Worth stating plainly, since this is the third time in this batch: the PR whose subject is *a suppression
must not depend on something incidental to its position* shipped a guard that depended on something
incidental to its environment.

### The same defect, four times, each fix silent about the dimension it introduced

Review rounds three and four of this PR each found the next iteration of one defect. In order:

- **v1** (before #3716) threw away a correct result: every off-schedule run passed `--dry-run`, so a
  `workflow_dispatch` computed the true failing set and discarded it, and the rolling issue kept
  advertising a stale — sometimes disjoint — set for up to a week.
- **v2** (#3716, this PR) published an incorrect one: with `--dry-run` gone and `--skipped-ok` left
  standing, a lane that merely `skipped` diffed as *recovered*, and a dispatch closed the tracking
  issue on the strength of a lane never having run.
- **v3** (the carry-over fix, also this PR) would have published a *branch's* result as the
  repository's: a dispatch runs on a user-selected ref, the tracking issue is repo-wide, and nothing
  compared the two. Dispatch on `fix/mutants`, find every lane green there, close an issue whose
  subject — `main` — is still red, for up to seven days.
- **v4** (the ref guard, also this PR) would have published a *shortened run's* result as the week's:
  ref equality was taken for cron-equivalence, but `workflow_dispatch` carries `fuzz_seconds`,
  `mutants_timeout` and `slo_include_problem`, and those change **what the lanes test**. A dispatch on
  `refs/heads/main` with `fuzz_seconds=10` passes the ref check and writes; a still-broken `fuzz` lane
  reports `success` at a budget it was never meant to pass at, diffs as *recovered*, and — if it was
  the last tracked lane — closes the issue with a "recovered" comment.

Each fix was correct about the failure it was aimed at and silent about the dimension it had just
introduced. v1→v2 fixed *whether* the answer is kept and said nothing about *which lanes it covers*;
v2→v3 fixed *which lanes* and said nothing about *whose lanes*; v3→v4 fixed *whose* and said nothing
about *under what conditions they ran*. We guarded the **event**, then the **ref**, and each time the
next-widest dimension was left open, because each fix was reasoned about from the bug it had just
seen rather than from the property being claimed. The property is one sentence — *this run reproduces
the cron* — and the event, the ref and the inputs are all just terms in it. The PR body's idempotency
argument is sound and answers none of this: idempotence is about churn, provenance is about whose
truth is being written, and the inputs are about whether the answer means what the issue says it
means. Every round landed on the same sentence: the justification for writing was still accurate, and
had stopped being sufficient.

So the workflow now writes only when the run reproduces the cron on every axis — the `schedule`
event, or a dispatch on `refs/heads/main` (the full `GITHUB_REF`, since `GITHUB_REF_NAME` is `main`
for a *tag* named `main` too, and a tag is a legal dispatch target) with every declared input at its
declared default. Everything else `--dry-run`s, which still performs every read and prints the whole
answer; it just does not get to speak for the repository. And the input list is not hardcoded:
`findDispatchInputDefaults` reads `on.workflow_dispatch.inputs` and `checkReporterAuthority` flips
each declared input in turn, so an input added later without a comparison in the step fails the guard
instead of quietly escaping it. That is the difference between fixing the fourth instance and
declining to ship a fifth.

### A guard that accepts both the fix and the bug pins nothing

The old regression guard searched the reporter job's text for the `--dry-run` token and failed if it
appeared on any non-comment line. That guard would have **rejected this fix**, because it cannot tell
a conditional `--dry-run` from an unconditional one — it was pinning "the token never appears" when
the invariant is "a dispatch on the default branch is not silently discarded". It also read prose: a
trailing comment merely *mentioning* the flag tripped it.

Replaced by a behavioural one. `resolveReporterInvocation` extracts the step's own `run:` block from
the workflow, executes it under `bash` with a stub `node` first on `$PATH`, and returns the argv the
runner would really produce for a given event and ref. `checkReporterAuthority` then asserts **both**
arms, plus the near-miss:

| event / ref | expected |
| --- | --- |
| `schedule` @ `refs/heads/main` | writes; no `--skipped-ok` (on the cron a skipped lane is a real failure) |
| `workflow_dispatch` @ `refs/heads/main` | writes, `--skipped-ok` — #3716 stays fixed |
| `workflow_dispatch` @ `refs/heads/fix/mutants` | `--dry-run` — #3960 |
| `workflow_dispatch` @ `refs/tags/main` | `--dry-run` — a tag is not the branch |

Every one falsified before being trusted: deleting the ref guard reddens the non-default arm and the
tag arm; restoring the unconditional `--dry-run` reddens the default-ref arm; a `GITHUB_REF_NAME`
comparison passes both branch arms and reddens the tag arm. Comments about `--dry-run` are inert now
by construction, because bash already knows what a `#` means.

### Three fail-open guards, one shape

The remaining findings were all the same shape as the bug the PR was fixing — an empty result meaning
"healthy":

- `findLineAnchoredCachePoisoningIgnores` stopped at the **first** `cache-poisoning:` key, so anchors
  under a second one were never scanned and `[]` came back. Identical to the four-space-indent
  fail-open fixed earlier in the same PR, one axis over.
- The issue body listed a carried-over lane under `### Currently-failing lanes` while the status table
  three lines below reported it `skipped` — the body contradicting itself on one screen, asserting a
  failure nobody observed. The carry-over behaviour was right; only the rendering was wrong.
- `.github/zizmor.yml` claimed the guard requires "every caching step to carry the inline comment".
  It does not: the `always_run` hook only notices **zero**, and the exactly-four assertion lives in a
  different hook. Given that this PR's own blocking bug was caused by a justification that had gone
  stale, an overclaiming comment about a guard is not a cosmetic issue.

And note 5's dependency is now asserted rather than noted: the `zizmor` prek hook cannot cover
`.github/zizmor.yml` (it forwards matched filenames to the binary as audit *targets*, so zizmor would
be asked to audit its own config), so the only thing re-running zizmor on a config edit is this
guard's self-test hook. The guard reads that hook's `files` pattern back out of `prek.toml` and fails
if it stops naming any path it depends on.

### Round four: two more premises that outlived their sentence

The input gate was the headline, but the same shape turned up twice more in the same diff.

**The last-resort notice.** Its comment read "#3716 removed that `--dry-run`, so a dispatch writes for
real" — a sentence that was true when written and false three commits later, because round three
restored `--dry-run` for every ref but the cron's. So a crash on a branch dispatch would have
reopened and commented on the repo-wide "the failure reporter is broken" issue for a run that could
not possibly have left the tracking issue half-written. Narrowed to `failure() && (github.event_name
== 'schedule' || github.ref == 'refs/heads/main')`.

It deliberately does *not* also track the inputs. A cron-ref dispatch with a shortened budget writes
nothing either, so the condition over-fires for it — in the **loud** direction, which is the only
direction a last-resort notice may err in. Over-firing costs one comment on an idempotent issue;
under-firing is the silence the job exists to end. `findLastResortNoticeCondition` pins the expression
verbatim and now also cross-checks that its ref is the same `CRON_REF` the authority gate compares
against, so the two cannot drift apart in the way the comment just did.

**`extra=()` on bash 3.2.** The behavioural guard executes the step's real bash, which is what made it
worth having — and it is also how a genuine portability bug in the *shipped workflow* surfaced. On
bash < 4.4, stock `/bin/bash` on macOS (a platform `scripts/setup-hooks.sh` keeps its own tables
compatible with, on purpose), expanding an empty array under `set -u` is an unbound-variable **error**,
not an empty expansion. On the `schedule` path `extra` was empty, so:

```
$ docker run --rm bash:3.2 …  bash step-before.sh
step-before.sh: line 39: extra[@]: unbound variable
exit=1
```

CI runs bash 5, so the workflow itself would never have shown this; the self-test executing the block
is what turned a latent workflow bug into a hard-failing pre-commit hook for macOS developers. Fixed
where the bug is — the array is seeded with the arguments that are always passed, so it is never empty
at the point of expansion — in the reporter *and* in `workflow-watchdog.yml`, which carried the
identical construct. `findUnportableEmptyArrayExpansions` pins both steps, and the whole matrix was
re-run under real bash 3.2 afterwards: every arm produces the same argv the JS guard asserts.

Also from this round: the `noop` run summary still printed `still failing: <carried lane>` — the same
"asserting a failure nobody observed" contradiction just fixed in the issue body, left standing one
output stream over. And a throw out of the workflow-executing helper escaped `runSelfTest` uncaught,
so the hook died with a raw stack trace and exit 1, which reads as *the tool is broken* rather than
*an assertion did not hold*; both self-tests now wrap their entry point the way `main()` is wrapped
and exit 2 with one legible `FAIL -` line.

### Round five: approved, and still carrying two stale justifications about itself

The fifth review approved the PR and left seven notes. Four were fixed here; three were filed as
issues rather than fixed, because the approval condition was "merge on green" and none of them is a
correctness risk in what ships.

**The two that matter most are prose.** `prek.toml`'s hook note still said the reporting job "must
never pass `--dry-run` to itself, on any event", and `scheduled-deep-checks.yml:1233` still said
"`report-scheduled-failures` no longer dry-runs on a dispatch itself", unqualified. Both were true
when written and false by the end of the same PR: passes three and four restored `--dry-run` for
every ref but the cron's and for every non-default input, and the token-search guard the first
sentence described had been deleted outright. A third copy of the same claim sat at `:1294` ("reads
only GitHub's own job-result data, safe to write anytime"), which the round-three review had already
quoted as drawing the wrong conclusion; it is corrected with the other two, since leaving it would
mean the file still says the false thing.

That is worth stating plainly, because it is the most on-the-nose evidence in the batch. This PR
**documents the stale-justification failure mode three separate times** — it is the diagnosis of its
own blocking bug, of the last-resort notice's `if:`, and of the `.github/zizmor.yml` overclaim. It
took four review rounds. And it still shipped two live sentences describing behaviour it had itself
changed, in the two files a maintainer reads first. A comment cannot be relied on to survive the
change it justifies; only something executable can. The guards added over these rounds now pin the
ref, the inputs, the notice's condition, the prek pattern and the array portability — every claim in
this PR that a future edit could falsify silently is now checked by something that runs. The prose
is the residue, and the residue is where all five rounds found the rot.

**Two more fail-opens, same family, now closed.** `findLineAnchoredCachePoisoningIgnores` treated any
non-blank line indented at or below the rule key as the end of the block, without exempting comments
— so a banner at column 0 inside a `cache-poisoning:` block truncated the scan to `[]`, and `[]` is
how that module spells *healthy*. Third instance in one function (four-space indent, second key, now
comments); blank lines had been exempt all along for exactly the same reason. `findDispatchInputDefaults`
had the same shape one file over, plus a subtler one: it threw only when it found *nothing*, so a
partial parse silently gated a write on half the input list. It now runs two scans that terminate on
different rules — the `on:` mapping's indent and the `inputs:` mapping's — and throws when they
disagree.

**And the generality claim from round four is now actually true.** It recorded only inputs that
declare a `default:`, so an input added without one (a `required: true` string, a `choice` leaning on
`options[0]`) was never env-mapped, never flipped, and changed what the lanes test while the run went
on writing authoritatively. Every declared input is now recorded, with `null` where there is no
default, and an input the guard *cannot* compare is reported as a problem rather than skipped —
because "I could not check this" and "this is fine" are the two things this whole batch is about not
confusing. Pinned with a fixture input that declares no default.

**Filed, not fixed** (three issues, so the record is complete):

- The `sync` log line and the `[dry-run]` summary still print `${all.length} still failing`, which
  counts carried-over lanes. Same contradiction just fixed in `buildIssueBody` and `buildNoopSummary`,
  left standing on two more output streams — a third and fourth place where one distinction has to be
  re-made by hand, which is the argument for making it once in the data instead.
- The exactly-four inline-suppression assertion lives only in `--self-test`, whose hook is keyed to
  four files, while the scan covers all of `.github/workflows/**`. A fifth suppression added to
  `release.yml` touches none of those four, so neither hook notices — the `always_run` one only
  checks for zero. The coverage and the trigger disagree about scope.
- `.github/zizmor.yml`'s `unpinned-uses` note is left indented under `rules: {}`, where it annotates
  nothing. Valid YAML, but it reads as a live nested entry.
