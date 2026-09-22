# Session 1796 — three CI lanes that reported the wrong thing

A sweep of the `ci`-labelled backlog. The common shape: each lane was doing
something defensible and reporting something false about it.

## The red that was already fixed

`#3388` and `#3394` are both open on `scheduled-deep-checks` → `full-suite` →
`full-suite-prek`, and neither describes anything broken now. The cause was the
`dtolnay/rust-toolchain` pin drift session-1793 records; #5116 moved the pin
about five hours after that run, and `prek run --all-files zizmor` passes on
`main` today. Both issues are rolling and self-closing, so Monday's scheduled
run clears them.

Worth recording only because the obvious reading of two open red tracking
issues is that something is broken now.

## A clean fuzz run that cleared nothing (#5112, PR #5132)

#5111 taught the fuzz filer to clear the tracked block on a clean run, but only
when *every* known finding was run-shape. The guard was right — libFuzzer writes
reproducers to `artifacts/`, not into the corpus, so a quiet run is no evidence
against a `[crash]` — and the consequence was not: in a mixed set nothing was
cleared at all.

A finding id is the dedup key. So a stale `[not-run] fts_strip: …` left in the
block swallowed the identical id from the next run that genuinely lost that
target. Not a stale line and a new line; no line, and no warning. The target's
coverage went missing and the tracking issue said nothing.

A clean run now drops the run-shape lines it disproved and keeps the rest,
leaving the issue open. That needed `parseKnownDetails`, which reads back what
`renderDetails` wrote, because the rewritten body carries ids from a previous
run while `byId` holds only this run's findings — a retained `[crash]` would
have kept its line and silently lost its reproduce command and log excerpt,
which is the one part of that issue a human reads.

`byId` is dropped from the close path rather than widened: with `all: []` there
is nothing for `renderDetails` to look up, and the new path carries its own map.
This run's `byId` is not merged over the parsed one either — `allTargetsClean`
requires `results.length > 0` and the `[lane]` fallback requires
`results.length === 0`, so it is provably empty there and the merge would be a
no-op needing a comment to say why.

Falsified six ways against a copy, including putting the bug back and replaying
the issue's own reproduction to watch the swallow happen.

## One ECONNRESET, every PR blocked (#5089, PR #5131)

`better-npm-audit audit` is one network round-trip to the registry advisory
endpoint. `prek.toml` already said, in writing, that this was too flaky for the
commit path. CI then ran the same hook as a blocking step inside
`validate / lint`, which feeds the required `validate-all` context — so the
dependency deemed too flaky to block a commit gated every merge instead. Run
35276134291 died after one second on `read ECONNRESET` and reddened `main`.

The wrapper retries three times with a 5s/15s backoff. Retrying on *any* failure
is what makes the change small, and it is safe for one reason worth stating
plainly: the loop exits early only on success, so exhausting the budget still
fails. A real advisory fails all three attempts and blocks exactly as before.
Classifying npm's error text would change how fast the same verdict is reached,
never which verdict it is.

The issue offered two larger options — move the check to a scheduled lane, or
pin an offline advisory set. Both trade advisory latency or new machinery for
stability. This one trades nothing, which is why it was the one taken.

## The lane with no second implementation, finally on the PR path (#4671 item 2, PR #5133)

`e2e-tauri` is the only place the real backend meets the real frontend. It ran
weekly and gated nothing, while 120 mock-backed Playwright specs gated every PR.

The issue sequenced the repair — widen, watch for flake, then promote — and set
an evidence gate of three consecutive green runs of the widened lane with at
least one scheduled. Measured: five consecutive greens since #4820 merged, two
of them scheduled, at 21.8 min and 17.5 min.

The gate is met, and this change still stops short of what it licenses. The lane
now runs per-PR and remains non-required, so real per-PR flake and queue cost are
observed on live traffic before any merge depends on them. What it buys today is
attribution: a real-backend regression is reported on the PR that introduced it
instead of by a Monday cron on a `main` that has absorbed a week of merges.

The `paths:` filter is the part that will matter later. A `paths`-skipped
workflow produces no check run at all — not neutral, not skipped, nothing — and
branch protection cannot tell an absent required context from a passing one, so
adding this lane's name to the ruleset while the filter stands would block every
docs PR forever. That is now written where the filter is. Promotion has to drop
the filter and skip inside the job, or route the lane through `detect-changes`
and the `validate-all` fail-closed aggregate, which exists for exactly this.

Item 3 went half stale the moment this landed. `AGENTS.md` rule 4 ended "Until
#4671 lands, that lane is `schedule` + `workflow_dispatch` only, so pair the
spec with one that runs per-PR". The trigger clause is now false; the
instruction it carries is not, because the lane still gates nothing and so
still cannot stop a reintroduction from merging. So it wanted rewording rather
than deleting, and it says that instead — with maintainer approval, asked for
because that file requires it. `e2e-tauri/AGENTS.md` had the same problem,
presenting `gh workflow run` as the only way to reach CI.

The caveat does not disappear until the lane is a required context, which is
the half of item 2 that remains.

## The sweep's own follow-up (PR #5136)

Seven non-blocking notes across the three PRs, batched into one PR rather than
seven pushes onto approved green branches. Four were the same note — the
reviewer flagged over-commenting on every PR of this sweep, which makes it one
finding about how these CI comments get written, not three slips. The audit
wrapper's header argued at length against the two options from #5089 that are
not in the tree, which is the clearest form of the mistake: a file explaining a
decision instead of itself.

One was not a comment. `diffFindings` wrote the marker block as this run's
findings alone, so the next run with any new finding dropped every tracked
`[crash]` — the same defect this session had just fixed on the clean-run path,
sitting in the other write path all along. Fixing it had a trap worth recording:
once `resolvedOnes` stops carrying the non-run-shape ids, the clean-run branch's
own derivation of its retained set yields empty, and that branch then CLOSES an
issue holding a live crash. Two guards, each correct alone, wrong together. The
test #5112 shipped catches it, which is the argument for having written it.

That fix stops short of one case, deliberately. A run that is neither clean nor
carrying a new finding writes nothing, so a settled `[not-run]` can persist
through it. Closing that means replacing the `allTargetsClean` gate — and that
gate is what stops a CANCELLED run from clearing a `[not-run]` line nothing
disproved, because #5110 has `buildFindings` suppress those exact findings on a
cancellation. The same cancelling-guards shape pointing the other way, so it was
left alone rather than opportunistically widened.

## What the three have in common

Each carried a comment that had become false about its own behaviour —
`prek.toml` explaining why the audit was off the commit path while CI made it a
merge gate; `closeResolvedIssue` saying it keeps "the whole set in the block";
`e2e-tauri-weekly.yml` opening with "intentionally NOT part of the PR gate" and
"Never run two of these at once". In each case the comment was accurate when
written. Fixing the behaviour without fixing the sentence would have left the
next reader with a worse map than before.
