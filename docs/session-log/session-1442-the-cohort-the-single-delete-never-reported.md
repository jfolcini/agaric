# Session 1442 — the cohort the single delete never reported

#4523. #4521 established that the delete cascade filters on `deleted_at` and depth with **no
`block_type` stop**, so trashing a page also tombstones its nested pages, and fixed the batch path:
`delete_blocks_by_ids` returns `affected_page_ids` and the toolbar evicts the union.

`usePageDeleteAction` — the single-page delete — goes through `delete_block`, which reported no
cohort. Deleting one page with page children evicted only the root from the origin `[[` cache; the
children lingered exactly as before #4450, and selecting one linked to a page in the trash.

The single delete is the **more common gesture** than the multi-select, so this was never the
narrower half of #4521. It was the wider one, shipped later.

## "The same source" — said at the strength it has

#4521's rule is that the reported set and the tombstoned set must come from the same place, so they
cannot drift. The batch arm can bind its literal `UPDATE` payload. The single path's `UPDATE` lives
inside `project_delete_block_to_sql`, so that exact binding is not available here.

What is available is `effects.deleted_cohort`, `collect_delete_cohort`'s pre-`UPDATE` capture — and
the response **already** describes it: `descendants_affected` is its length, documented as "the same
set of rows the `UPDATE` touched". So this adds no new assumption about the cascade. It reads a
different column off a set the response was already trusting. That is a weaker claim than the
batch's and it is the true one; asserting parity with #4521 here would have been an overclaim.

Incidental confirmation that the query really is the batch's: an attempted falsification that edited
the SQL string was refused by `SQLX_OFFLINE` with "no cached data for this query". Byte-identical
SQL, one cache entry, no new `.sqlx` file.

## The trap the issue warned about, reproduced rather than trusted

The issue's acceptance has two halves — the deleted children stop being offered, **and** an
unrelated sibling survives — and it warned that the second half cannot fail on its own, because a
full-cache wipe self-heals in this harness: the list refetches synchronously from a static mock.

Confirmed empirically. Under an always-`invalidateNameCaches()` mutation the sibling arm **passed**
while the event-count assertion reddened. So the over-eviction guard has to be
`expect(changes).toEqual([...])` on the real bus, not a rendered-list check.

One correction to the inherited wording while I was there: the wipe *is* caught here, by the
`not.toContain('PAGE_ROOT')` arm — the static mock brings the root back too. The arm that genuinely
cannot fail is specifically "the sibling survives". The test comment says that now instead of
repeating #4521's slightly-too-broad version.

## Four decisions the issue did not dictate

**A field on `DeleteResponse`, not a parallel type.** The type has exactly one consumer; a
`SingleDeleteResponse` would have churned 106 `delete_block_inner` call sites for nothing.

**The fan-out budget applies here too.** The issue only asked for eviction. But a one-page delete
can cascade to arbitrarily many nested pages, so measuring the budget against the union rather than
against `1` is what makes the threshold reachable at all. Pinned by a falsification that is
non-tautological precisely because `1 <= 25` always holds.

**Union with the requested id, though this command has no skipped-input case.** Unlike the batch,
`delete_block` errors rather than skipping, so the seed is always already in the cohort. Kept
anyway — one `Set` entry — so both delete paths read identically and a future narrowing of the
cohort cannot silently strand the deleted page itself. Recorded as belt-and-braces rather than
dressed up as necessary.

**`NAME_CACHE_FANOUT_MAX_IDS` moved to `src/lib/name-change-bus.ts`.** Not cosmetic and not
optional: a hook importing a component is a fresh `check-lib-layering` violation (hooks rank 2,
components rank 3), and a copied threshold drifts from its measurement table. A baseline bump would
have been the wrong tool — the safe construct expresses this fine once the constant sits at the
layer that owns it.

## Verification

10 new tests — the count is over added `#[tokio::test]` and `it(` cases in
`git diff origin/main...HEAD`, which is also what the enumeration below sums to.
Rust: a page with a content child, a nested page and *its* content child, plus a live
same-space sibling; and a refusals case covering three paths with per-row `deleted_at`
assertions. Frontend: four on the hook, three on the mock handler, one wrapper passthrough.

**Ten falsifications**, each against a copied backup with the restore proven byte-identical. Worth
listing what they separate, because several look redundant and are not:

- reporting the seed only, and dropping the `block_type = 'page'` filter — the second also reddens
  the insta snapshot, which is a second independent witness;
- removing the already-deleted guard, and a refusal path that stamps its target before erroring;
- the hook reverting to seed-only eviction, and the hook always invalidating — these are the two
  opposite failures, narrow and over-broad, and only the second is the one the harness cannot see;
- the budget measured against the requested id rather than the union;
- replacement instead of union;
- the mock reporting the seed only, dropping its page filter, and the wrapper narrowing the reply —
  three separate places the cohort can be lost after the backend gets it right.

Rust: 62 tests over the delete, snapshot and bindings filters. Frontend: the full suite, 18248
passed. `tsc -b` clean; `check-lib-layering`, `check-tauri-mock-parity`, `check-doc-code-paths`,
`check-import-cycles`, `check-snapshot-redaction`, `check-hook-deps` and `check-ipc-error-path` all
green.

## Left for the follow-up, deliberately

The eviction block is a hand-rolled `Set` + budget check + loop — which is exactly
`notifyPagesRemoved`'s job. That publisher landed in PR #4534 (closing #4524) after this
branch was written, so it is not imported here. Substituting it is a straight swap, and the
constant is already sitting where that publisher wants it.

Closes #4523.
