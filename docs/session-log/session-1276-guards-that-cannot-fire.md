# Session 1276 — four guards that could not fire, and two reviews that overturned their builders

**Date:** 2026-08-07
**PRs opened:** #3565, #3566, #3567, #3568 (all draft, CI pending at time of writing)
**Issues closed:** #3532, #3541, #3550, #3554 — pending the merges above
**Issues filed:** #3554, #3556, #3557, #3558, #3559, #3560, #3563, #3564

Continues session-1275, which drained the board to zero open PRs. This one picked four
scoped issues and found that three of them were the same bug wearing different clothes.

## The through-line: a check that is present, reads as protective, and cannot fire

Session 1275 catalogued four ways a *green check* answers a different question. This session
is the same failure one level down, in the checks themselves.

**#3550 — the probe that could never collide.** `start_sync_inner` probed the daemon's S-5
lock with a *device* id. #3511 had moved that lock to be keyed on `EndpointId`, so the probe
compared a device id against a table keyed by endpoint id. "Sync already in progress for
this peer" had been unreachable since that merge, and no test asserted the branch, so
nothing went red when it stopped working.

**#3554 — the cross-check that read itself.** `zizmor-hook.sh`'s self-test exists to catch
`setup-hooks.sh` and `zizmor-hook.sh` disagreeing about how to parse `zizmor --version`. It
extracted *both* sides from `$SELF`. Corrupting setup-hooks.sh's sed on `main` prints
`✓ … agrees` and `RC=0`. The comment above it claimed the opposite.

**#3563 — the negative control that cannot run.** `control_relay_disabled_preset_still_
queries_n0_dns` exists to prove `lan_only_endpoint_resolves_no_hostnames` *can* fail. In a
sandbox it fails, and its own message says what that means: "treat
`lan_only_endpoint_resolves_no_hostnames` as unable to fail." Guard 1 asserts
`queries.is_empty()`; in an environment where nothing resolves anything, that is satisfied
by the environment rather than by the code.

**#3557 — the deferral nothing pins.** Making production `scheduleIdle` run its callback
inline — destroying the deferral completely — leaves all 18 tests in `code.test.tsx`
passing, because the sibling test's "no highlight on first paint" assertion is satisfied by
the dynamic `import()` boundary alone.

Four instances, three of them found by *executing* the guard rather than reading it. That is
the only method that distinguishes the shape, and it is cheap: break the thing, run the
check, look at the colour.

## Two reviews overturned their builders, and both were right

The adversarial review pass is expensive and it earned its cost twice in one batch.

**#3541 — the diagnosis was wrong, not just the fix.** The builder attributed the flake to
the real `setTimeout(cb, 0)` in `scheduleIdle` and added an injectable scheduler seam to
production code. Direct A/B, cache cleared, alternating: seam **1966 ms** mean vs real timer
**1886 ms**. The seam was not faster than the code it replaced. Cost breakdown: dynamic
`import()` 98 ms, `lowlight.highlight()` 53 ms, and ~1.7 s building **5999 `<span>`s** into
happy-dom in one synchronous commit. The macrotask hop was sub-millisecond of a ~1900 ms
budget.

The reported failure signature had said so all along. A merely-delayed `setTimeout(0)` lets
`waitFor`'s own 8000 ms real timer fire roughly on schedule, giving a clean ~8 s failure.
Failures at **24-29 s** — past both the 8 s `asyncUtilTimeout` and the 20 s `testTimeout` —
are a blocking-CPU signature. The evidence to reject the hypothesis was in the issue text
before any code was written.

Final diff: production untouched, token count reduced, ~152 spans instead of ~6000, this
test 1877 ms → **34 ms**.

**#3554 — the fix re-committed the family bug.** Both new awk extractors were unbounded.
Adding a trailing comment to a `fi` — semantics unchanged, `bash -n` clean — made one
swallow 98 lines instead of 3 while still printing `all assertions passed`, and the runaway
text handed to `bash -c` **executed setup-hooks.sh's top-level provisioner**. It stopped
short of `cargo install` and `sudo apt-get` only because `have()` happens to be defined
above the extraction window. Safety by accident of layout.

Review also root-caused a phantom the builder had flagged and could not reproduce:
`printf | grep -q` under `set -o pipefail` returns **141**, not 0. grep matches, exits,
closes the pipe; `printf` takes SIGPIPE; the pipeline status is the signal. Measured
**300/300 spurious failures with `pipefail`, 0/300 without**.

The pattern worth keeping: in both cases the builder's *mechanism* was defensible and its
*justification* was false. Review that only checks whether the code does what the author
said would have passed both.

## A coverage gain that came from asking "on the boundary of what?"

The reworked #3541 test kept the body at the cap. Checking the arithmetic rather than the
prose: the original filler produced **29 998** characters, not 30 000. The guard is
`code.length > HIGHLIGHT_MAX_LENGTH`, so 30 000 is the largest still-highlighted input and
the *only* value that separates `>` from `>=`. At 29 998 that mutant stays green.

The test is now pinned to exactly 30 000 with `toBe`, not a band, and flipping `>` to `>=`
reddens it. A test named "right at the cap boundary" had never been at the boundary.

## Working alongside another session, and a claim that did not survive

Another Claude session was working the same backlog from a different container. It closed
**#3545** at 07:12 while a builder here was mid-flight on it — correctly, for that issue's
two original parts. Its closing rationale, however, asserted:

> There is also a guard … that feeds a synthetic trailing-token version line through both
> extractions and fails loudly if they disagree.

That is the guard described above, and it does not. The other session read the code and
believed it; this one executed it and watched it print `RC=0` under corruption. The
correction is on #3545 and the real work is tracked in #3554.

Two practices that mattered: check for claims *immediately before* pushing rather than only
at batch start — the window here was minutes — and treat a plausible closing rationale as a
claim to verify, not a fact to inherit. Repeating it would have laundered it.

## Provisioning: two paths for one pinned version

`zizmor@1.28.0` **cannot be compiled** under the repo-pinned rustc 1.95.0 — its dependency
`tree-sitter-iter@1.28.0` requires 1.97.0. CI never notices because
`taiki-e/install-action` downloads a prebuilt binary; local provisioning uses
`cargo install --locked` and hits the wall. The existing cross-checks verify that both
paths name the same *version*; nothing verifies that both can *obtain* it. Filed as #3564;
unblocked here by fetching the same prebuilt artifact CI uses, which let two of the four
branches pass the real Phase A gate rather than bypass it.

Related, from the #3550 builder: `setup.sh` only warns about missing GTK/WebKit dev libs, so
a fresh sandbox cannot compile the `agaric` crate at all — not merely cannot run the app
(#3556).

## Operational notes

**Disk, not CPU, was the binding constraint.** ~27 GB writable and no warm `target/`. A full
Rust debug build is most of that, so exactly one Rust build was possible at a time — the
batch was deliberately composed as one heavy Rust item plus three light-toolchain ones, all
pushes routed through a single shared `CARGO_TARGET_DIR`. It still reached 5.2 GB free;
dropping `target/debug/incremental` (9 GB) recovered the headroom.

**Bypass discipline.** #3565 is the only branch pushed with `SKIP_CI_VERIFY`, for #3563, and
the PR body says so. The other two blocked branches were unblocked by *installing the
missing tool* rather than skipping the hook that wanted it. A bypass normalised for
environmental reasons is how a real Phase A failure eventually gets waved through.

## What this session did not do

The four PRs are draft with CI pending; none is merged, so none of the four issues is
actually closed yet. #3563's real fix — making guard 1 report inconclusive when its control
cannot run — is filed, not done; it is a design call in that module and guessing at it from
an unrelated batch is how the vacuous version shipped in the first place. Same for #3560,
#3558 and #3564.
