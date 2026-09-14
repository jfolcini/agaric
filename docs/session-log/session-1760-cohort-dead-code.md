# Session 1760 — deleting the cohort path, and a mutant that was wrong

`apply/pages_cache.rs` 882 → 725 lines. Nothing here changes behaviour; it
removes code that could not run and then removes the duplication that hid
underneath it.

## What was dead, and why it was safe to say so

The `Cohort` / `RestoreCohortAndAncestors` / `Purge` arms of
`maintain_pages_cache_counts_after_op` sat behind the #2042 early return, which
returns for exactly those three variants. The file kept them as "the canonical
documentation of each op's count impact". Deleted, along with the three helpers
reachable only from them — `collect_cohort_affected_pages` and its only callees
`distinct_pages_for_blocks` and `outbound_target_pages_for_blocks`, all `pub`,
none referenced anywhere else in the workspace (checked before deleting, and
again after: the compile is the proof).

`outbound_target_pages_for_block` — singular — stays. The `Edit` arm uses it.

What made this a deletion rather than a judgement call is #5028's
`cohort_ops_defer_the_count_recompute_2042`: before it, "those arms never run"
was a reading of the guard; after it, it is a test.

## The guard and the arm became the same statement

With the arms emptied, dropping the #2042 guard changed nothing — both paths now
add nothing to `affected`. Two spellings of one rule, listing the same three
variants twice, which is the shape this sweep keeps finding.

So the guard is gone and the arm carries it. The deferral is now **one**
statement, and — the part that matters — a **reachable** one: while the guard
existed, the arm was unreachable and no test could pin it. Now the test pins the
code that does the work.

## A surviving mutant meant the mutant was wrong

Checking that, the first attempt made the `Cohort` arm insert the cohort's block
ids into `affected`. It survived, and the tempting reading was "the arm still
isn't pinned".

It was the mutant that was wrong. `recompute_pages_cache_counts_for_pages` keys
on **page** ids; inserting block ids recomputes rows that do not exist and
touches nothing. The old arm resolved blocks to their owning pages first, which
is the step the mutant skipped.

The faithful mutant — resolve `page_id` per cohort block, then insert — is
killed, by `cohort_ops_defer_the_count_recompute_2042` alone: 1029 run, 1
failed.

Worth keeping, because it cuts against the habit this sweep has built: a
survivor is evidence about the mutant as much as about the code. Three readings
now, and the third is new — a real gap, a provable equivalence, or **a mutant
that does not do what its name claims**.

## The ratchet reclaimed its slack

Deleting `outbound_target_pages_for_blocks` removed a runtime-form
`sqlx::query` site, and `check-dynamic-sql` refused the commit until the
baseline came down with it (3 → 2 for this file). That is the guard doing its
job in the direction that is easy to forget: a ratchet that only ever holds the
line lets deleted debt stay booked.

## Also

`let title = content;` in `affected_pages_for_create` was a rebinding left over
from `content.as_str()` before the `&str` parameter; `content` binds into the
`query!` directly. (#5028's review note, folded in here rather than batched
because this PR was already rewriting the same function.)
