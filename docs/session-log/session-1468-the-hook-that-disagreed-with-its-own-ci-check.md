# Session 1468 — the hook that disagreed with the CI check it exists to predict

Found by walking into it three times in one session. `scripts/dco-signoff.sh` is a
`prepare-commit-msg` hook whose stated purpose is that "the DCO check on CI never rejects a PR for a
forgotten `git commit -s`". It skipped whenever the message already carried a sign-off:

```sh
if grep -qiE '^[[:space:]]*signed-off-by:[[:space:]]' "$msg_file"; then
    exit 0
fi
```

CI does not accept any sign-off. `.github/workflows/dco.yml` accepts a commit only when some trailer
names the **commit author's** email. So a message carrying only a co-author's or an agent's sign-off
satisfied the local skip, suppressed the append, and produced a commit that passed every local hook
and failed `dco` on CI.

## Why it took three PRs to see

The misfiring input is this repo's dominant commit style. A message written with
`Signed-off-by: Claude <noreply@anthropic.com>` in it is authored by the human's git identity, so the
trailer never matches — and the hook reports `Passed` while doing nothing. Every commit I wrote this
session by heredoc carried that line, so every one of them was affected: #4539's review-fix commit,
#4560, and #4525's branch. #4557 hit the same wall independently on two commits pushed through the
GitHub API.

The tell was there the whole time and I misread it: the pre-existing commit on #4539's branch, which
I had not written, carried `Signed-off-by: Javier Folcini <...>` — the correct auto-appended trailer.
Mine carried only Claude's. Same hook, same repo, different outcome, because the hook's skip
condition was satisfied by a line I had typed myself.

This is the local mirror of #809, which was the remote half of the same family: `dco` reporting green
when the API call returned zero commits scanned. Both are a guard treating "I found nothing to
object to" as "there is nothing to object to". Filed as #4561.

## The fix, and the two things it must not get wrong

The match is now on the commit author's email, using the same two-stage form `dco.yml` uses:
`grep -iE` to select sign-off lines, then `grep -iF` on the bracketed address. The fixed-string
second stage is load-bearing rather than stylistic — a `+` in a valid address is a quantifier in an
ERE, so an ERE match would reject a legitimate `user+tag@example.com` sign-off *and* accept
`uservvtag@example.com`. `dco.yml` carries that note already, for a bug it had; the two now agree
because they do the same thing.

Author identity comes from `git var GIT_AUTHOR_IDENT`, not `git config user.email`. That is what the
resulting commit's author will actually be: it already accounts for `GIT_AUTHOR_EMAIL` and
`git commit --author=...`, both of which change what CI checks against while leaving `user.email`
untouched. Reading the config would have reproduced the same class of bug — checking a value adjacent
to the one that matters.

A second, smaller defect came out of writing the fixtures: the original always inserted a blank line
before the appended trailer, which splits a message ending in an agent sign-off into **two** trailer
blocks. CI greps the raw message and does not care, but `git interpret-trailers --parse` reads only
the last block, so the agent's trailer stopped being visible as a trailer at all. The append now
joins an existing block and still inserts the blank line after prose.

## The fixtures caught my own bad assertion first

The two new assertions for the trailer-block behaviour failed on their first run against code the
end-to-end check had already shown to be correct. The assertions were wrong, not the code: they used
`grep -qz` with `\n` in the pattern, and grep does not interpret `\n` as a newline. An assertion that
fails for the wrong reason is the same defect as one that passes for the wrong reason, and it is only
visible if you run it and read the output rather than trusting that a written test tests something.
They are exact `cmp` comparisons against expected content now.

Both arms of the real fix were falsified separately — reverting to the "any sign-off" condition
reddens the #4561 assertion, and swapping `grep -iF` back to `grep -iE` reddens both `+` assertions —
with the restore proven byte-identical by `cmp` each time.

## On the missing hook wiring

The suite is in the script as `--self-test` and is deliberately **not** wired into `prek.toml`.
Under #4556's own criterion 5 it earns one — a text-parsing guard with a recorded fail-open incident,
which is now exactly what this is. But #4556 is concurrently unwiring self-test hooks wholesale, and
adding a new one would fight that decision inside the file it is rewriting. Phase 2 of #4556 is where
self-tests get restaged, and that is where this belongs. The fixtures exist now regardless: an
unwired suite that can be run by hand is recoverable, and no suite at all is not.
