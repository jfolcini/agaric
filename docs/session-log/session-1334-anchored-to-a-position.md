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
