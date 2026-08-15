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

### The same defect, three times, each fix silent about the dimension it introduced

Review round three of this PR found the third iteration of one defect. Laid out in order:

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

Each fix was correct about the failure it was aimed at and silent about the dimension it had just
introduced. v1→v2 fixed *whether* the answer is kept and said nothing about *which lanes it covers*;
v2→v3 fixed *which lanes* and said nothing about *whose lanes*. The PR body's idempotency argument is
sound and answers none of this: idempotence is about churn, provenance is about whose truth is being
written. Both reviews landed on the same sentence — the justification for writing was still accurate,
and had stopped being sufficient.

The fix keeps the off-cycle answer authoritative only for the ref the cron itself uses
(`refs/heads/main`, on the full `GITHUB_REF` — `GITHUB_REF_NAME` is `main` for a *tag* named `main`
too, and a tag is a legal dispatch target), and dry-runs everywhere else.

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
