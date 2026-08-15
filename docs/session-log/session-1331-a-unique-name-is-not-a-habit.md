# Session 1331

## A unique name is not a habit

Two PRs shipped another PR's description, `Closes` lines included (#3731). That is not a cosmetic
mix-up: `Closes #NNNN` auto-closes issues that were never fixed, silently, discoverable only when
someone later notices a closed issue with no corresponding change.

The mechanism is worth stating precisely, because the timing is the whole thing. The scratchpad
directory is keyed on **session**, not agent, so concurrent subagents share it. An agent wrote its
body to a generic name — `msg.txt`, with `pr.md`, `prbody.md`, `body.md` and `msg2.txt` all live at
once — then:

1. `git commit -F msg.txt` — immediate, correct;
2. `push.sh` — **~15 minutes** of CI-equivalent gate;
3. `gh pr create --body-file msg.txt` — read *after* the wait.

A concurrent agent overwrote the path during step 2. The diff was right, the commit message was
right, the sign-off was right. Only the body was another PR's, which is exactly why nothing caught
it.

### The precedent, which is the argument for the shape

`verify-ci-equivalent.sh` hit the identical class in #3257 — fixed paths under `/tmp` colliding
between concurrent workers — and was fixed in #3379 with per-invocation `mktemp -d`. Same failure,
same fix, two years of distance and nobody generalised it.

So `scripts/scratch-file.sh new <label>` mints through `mktemp -d`, whose atomicity comes from
`mkdir(2)` failing `EEXIST` — not `mkstemp`/`O_CREAT|O_EXCL`, which is what the header first claimed
and the review corrected. Substance right, citation wrong; worth fixing because a wrong citation in a
security-adjacent comment is the kind of thing the next reader reasons from.

The predictable filename lives *inside* the unique directory, so it cannot collide, and `set -euo
pipefail` means a `mktemp` failure aborts rather than degrading to a fixed path. An allocator with
one fallback path is not an allocator.

### The honest limit: structural once called, conventional until

The review would not let the claim stand unqualified, and it is right.

`new`'s uniqueness **is** structural — proven by patching a copy to use a fixed path and running the
self-test against it: three of seven assertions fail (identical-label distinctness, 25-way
concurrency, the incident replay). The real script passes 7/7. So the test genuinely discriminates
the fix from a naive implementation rather than decorating it.

But **whether it gets invoked at all is still convention.** `push.sh` has no reference to
`scratch-file.sh`. The prek hook tests the tool's own correctness when the tool changes; nothing
checks that a given commit actually *used* it rather than `echo body > scratchpad/msg.txt`. The
`fingerprint`/`verify` half — the part aimed squarely at read-after-wait — exists as documented usage
with nothing calling it automatically.

So the accurate claim is: this converts "remember to give it a unique name" from a thing an agent
must recall into a one-line command with a correct implementation and a real regression test. It does
not make skipping that command impossible. Given the issue's own point is that convention already
failed twice, saying so plainly matters more than the fix reading well.

A follow-up that would close it: a hook flagging `git commit -F` or `gh pr create --body-file`
pointed at a generic scratchpad name.

### No cleanup, stated rather than discovered later

Nothing removes the minted directories in production use — only the self-test cleans its own fixture.
The `${TMPDIR:-/tmp}` fallback, used when `CLAUDE_SCRATCHPAD_DIR` is unset, has no cleanup at all.
There is no cleanup-versus-live-holder race, for the unsatisfying reason that there is no cleanup
code.

### The other half of the batch was already done

#3728 listed six gaps in the findings check. Eleven of twelve findings across it and a second review
pass were already fixed in #3736 — re-verified against current source rather than taken from the
thread: reviewer scoping, the any-`#NNNN` hole, duplicate check runs, the `provesMovement` asymmetry,
a stale `@returns`, and the metric-provable `files` key. `summarize-review-findings.mjs --self-test`
37/37, `check-metric-provable.mjs --self-test` 60+.

What keeps it open is the `defaultSeeds` cross-file blind spot, where the maintainer explicitly
declined a patch — "a real change to a 4,100-line file with an elaborate live-tree self-test, not a
follow-up" — so it was left rather than attempted in a rush.

One asymmetry recorded rather than smoothed: five of the six fixes are regression-tested; the
duplicate-check-run fix lives entirely in workflow YAML with no extracted script and no hook, so a
future edit reverting to an unconditional POST would not be caught locally. Correct by inspection,
unguarded in practice — which is a different status from the other five and should not be reported
as the same.
