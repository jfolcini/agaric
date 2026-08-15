# Session 1319

## Density was never the invariant

The session-log numbering guard demanded that a new log number be **exactly** the maximum on
`origin/main` plus one. That is two requirements wearing one coat: numbers must not collide,
and numbers must not have gaps. Only the first one was ever load-bearing.

The second one is what made parallel PRs serial. Every branch forked from the same base
computes the same `expected`, so five open PRs all pick the same number, and each merge
invalidates the four that remain — a renumber, a fresh ~4-minute local gate, and a full CI
re-run each. Four such cycles were paid in a single five-PR batch.

### What the guard actually protects, stated precisely

Check 1 — uniqueness against `HEAD ∪ origin/main ∪ same-commit siblings` — is what makes a
duplicate unrepresentable in a merge result. It never depended on density. It is untouched
here, and reverting only check 2 leaves its cases green, which is the evidence rather than
the claim.

Check 2 becomes a bounded window: `(max, max + GAP_BOUND]`, `GAP_BOUND = 10`, twice the
documented five-PR pipeline cap. An off-by-a-lot number — a stale view of the max, a typo —
still fails hard. What is given up is contiguity, which the guard's own header shows had
ridden along with an unrelated numeric-max fix rather than being chosen.

### The race the review would not let us claim we had fixed

Worth recording plainly, because it is the kind of thing a green guard invites you to stop
thinking about: check 1 can only see numbers on the checking branch or in its local view of
`origin/main`. It cannot see a sibling's open, unmerged PR. Two PRs that independently pick
the same number both pass, right up until one lands.

That race is **pre-existing and unchanged by this work** — it is the mechanism behind the two
real duplicate `session-1281` files the script's header describes. The review went further
and checked whether GitHub was closing it from the other side: `branches/main/protection`
returns 404, so nothing requires a branch to be up to date before merge. So the residual gap
is real and structurally unmitigated, and closing it needs branch protection or a merge-time
allocator, not a wider or narrower local window.

The honest summary is: uniqueness in the merge result is exactly as safe as before — no
better, no worse — and the common case got much cheaper. Not: the collision problem is
solved.

### Four hardening gaps in push.sh, and one that could not be reddened honestly

The rejection classifier decides whether a failed push was refused locally or by the remote.
Its `[remote rejected]` marker was anchored to git's human-readable line, so the `--porcelain`
shape and the sibling `[remote failure]` marker both fell through to the local-rejection
heuristic — the same misattribution class as #3883. Now unanchored over both markers. The
false-positive direction was checked too, not just the one being fixed: a local hook would
have to print git's exact two-word bracketed vocabulary to be caught.

`--self-test` failure exited 2, the same code as a preflight refusal, so a real invocation and
a test-mode failure were indistinguishable to a caller. Self-test failure is now 3, and the
header says the test mode has its own contract rather than sharing the 0/1/2 one.

The interesting one is the third. The issue described a `VAR=x func_call` prefix assignment
leaking into a later spawn. It does not leak — verified empirically in this bash, in both
normal and POSIX mode — so a revert-test on the literal fix passes either way and proves
nothing. Rather than shipping that vacuous pair, the test forces the hazardous *condition*
directly (export the variable, then assert the explicit reset still wins), which is a real
test of the invariant the fix protects even though the specific path that was supposed to
create the condition is not reachable today.

That distinction is the reusable part: when you cannot redden the fix, ask whether you can
redden the *invariant*. If neither, the fix is decoration.

### The fourth was a name

`PUSH_NO_REMOTE_LINE_RE` matched a `remote:` line; the "NO" came from the `!` at its single
use site. A negation belongs at the test, not in the noun. Renamed, with no behaviour change
and therefore no test — a red/green pair for a rename would be exactly the vacuous shape this
log keeps arguing against.
