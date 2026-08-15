# Session 1326

## A guard with a declared blind spot

Four `.sqlx` caches carried a rollup-query entry that no source hashes to (#3910), and a
`cargo sqlx prepare` run from the wrong directory silently prunes entries from a cache it did
not observe (#3901). Deleting the dead entries is worth almost nothing on its own — they come
back the next time someone runs the command the wrong way. The durable output is the guard.

### The two issues are not cause and effect

Tempting to read #3910 as a consequence of #3901, and it is not. #3901 is **over**-deletion:
the tool prunes what it did not observe this run. #3910 is **under**-deletion: #3894 changed a
query's text, the new hash landed correctly in `agaric-store`, and the old copies simply survived
in the three caches nobody regenerated.

Structurally opposite mechanisms. What they share is the actual gap — nothing guarantees the four
caches move in lockstep — which is what the guard now enforces, and why fixing either one alone
would have left the other's shape open.

Also worth recording so the next person does not redo the search: the wrapper and the
documentation the issue asks for **already exist** (`just gen-sqlx`, `AGENTS.md` invariant #6,
which even carries the "never regenerate a member cache with the bare `cargo sqlx prepare`"
language). The missing piece was only enforcement.

### What the guard actually decides

An entry deleted from one cache while an identically-named entry survives in a sibling is
suspicious; an entry that disappears from every cache at once is the legitimate full-retirement
shape and is never flagged. The escape valve is a diff that also removes a `query!`-family call
site.

Review found that valve was **diff-wide**: one legitimate query retirement anywhere in the commit
exonerated an arbitrary number of unrelated bad deletions. Demonstrated with a fixture carrying
two real cross-cache drifts plus one unrelated legitimate retirement — the guard passed. It is now
a count bound: removed call sites must be at least as many as suspicious entries.

### The blind spot, stated rather than hidden

Entries that exist in **only one** cache have no protection at all, because the guard's whole
signal is "a sibling still has it". Most of root's ~600 entries are not duplicated, so this is not
a corner: it is exactly #3901's failure mode, unguarded.

It is not fixable by a diff-based check without reconstructing sqlx's content hash, and that hash
is empirically **not** `sha256(sql-text)` — checked, rather than assumed. A hand-rolled matcher
that had not been verified against the real hashing would be worse than the gap, because it would
read as coverage.

So the header names it as a known scope limit and names CI's `cargo sqlx prepare --check` as the
backstop of record for that shape. The guard closes part of #3901 at the pre-commit layer and says
which part it does not.

That is the point worth keeping: a guard that declares its blind spot is more useful than one that
implies it has none, because the second one silently retires the question.

### Two things verified rather than reasoned about

`always_run = true` looked like unnecessary cost on every commit. It is not — prek's changed-file
set **excludes deletions**, confirmed in a disposable repo by staging a deletion of a file matching
the hook's `files` pattern and watching it report `(no files to check) Skipped`. A deletion-detecting
hook filtered on changed files would never run.

And #3722's hazard — a hook running git in a fixture repo inheriting `GIT_DIR` and writing to the
real repository — was stress-tested rather than inspected: a victim repo was created, `GIT_DIR` and
`GIT_WORK_TREE` exported at it, and the self-test run without any extra protection. The script's own
unset block neutralised it, and the victim's refs were byte-identical afterwards.

### The counts, reproduced

605→604, 181→180, 217→216, and `agaric-store` unchanged at 177 — 1180→1177 in total, reproduced from
`git ls-tree` independently rather than repeated from the report. The dead hash is referenced by zero
`.rs` files in the workspace, and all four lanes pass `cargo sqlx prepare --check` after the cleanup.

A number that has been recomputed is a different kind of claim from a number that has been quoted.
