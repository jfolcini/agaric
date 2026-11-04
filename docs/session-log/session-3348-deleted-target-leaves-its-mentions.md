# Session 3348 — a deleted page's or tag's name leaves its mentions

#6243: deleting a page or tag left its name in the index text of every
block that mentions it (`[[P]]`, `#[T]`), and restoring it did not give
the name back to a mention re-stripped in between. The two cohort helpers,
`remove_deleted_cohort_fts` and `reindex_restored_cohort_fts`, touched only
the cohort's own rows. Every local and apply-path delete or restore site
calls them, so the fix lives there: each helper now re-strips the blocks
that mention a page or tag in the cohort.

The #6242 referrer lookup became set-based so a cohort pays one pass:
`json_each` seeks over `block_tags`, `block_links` and
`block_links_unresolved`, and one content scan for every tag in the set.
`page_and_tag_referrers` filters the cohort to pages and tags first, so a
content-only delete pays one extra indexed `SELECT` and no scan.
`reindex_fts_references` uses the same lookup for one id.

Remote delete and restore already healed, through the import's
`changed_page_and_tag_ids` (#5241). The two-device test checks B before A,
so the red run on the old helpers failed on A after B had passed, which
confirms it.

The reviewer's catches: a public doc linked a private fn and would have
failed `cargo-doc-links`, and no test passed two targets in one call. A
first-target-only mutant survived 1222 tests until the batch delete and
restore-all test was added.

Ran: the targeted filter (`test(6243) | test(6242) |
test(reindex_fts_references) | test(_4733)`), red on the old helpers for
each half; the first-target mutant; the `cargo-doc-links` flags; `cargo
clippy --workspace --all-targets`. The reviewer ran the full workspace
nextest in three partitions. `bench-slo` is dispatched on the branch
because `bench_delete_restore_block` times a path whose SQL changed.
