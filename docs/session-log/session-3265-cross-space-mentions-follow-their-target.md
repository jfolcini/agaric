# Session 3265 — search follows a cross-space mention's target

#6242: a note that mentions a page or tag in another space stayed indexed
under `""` when it synced in before its target, and under the old name
after a rename. The full rebuild and the oracle index a cross-space target by
its real name (the maintainer confirmed that rule), but
`reindex_fts_references` found referrers only through `block_tags`,
`block_links` and `block_tag_refs`, and the last two drop cross-space targets.

The fix follows plan v2 on the issue. `reindex_fts_references` now seeds
from `block_links_unresolved` (the `[[PAGE]]` tokens `block_links` drops)
and, for a tag only, scans `blocks.content` for its `#[ULID]` token. The
scan replaces the `block_tag_refs` seed, which it subsumes. No new index:
the bench decides whether one is ever needed.

One trap in the tests: re-stripping a note resolves every token in it, so a
note that mentions both a page and a tag hides a missed tag behind the
page's reindex. The first app test passed on `main` that way. The fixture
now has one note per target, and the move test asserts that the move really
dropped the tag edge.

Two existing tests changed as the plan says. The store test that planted a
`block_tag_refs` row no longer does, and the oracle `fts_fixture` lost its
planted row and the comment saying the reindex never scans content.

`bench_reindex_fts_references` (`interactive_slo`) times the tag reindex,
the page reindex, and the `block_tag_refs` rebuild a tag-carrying import
already pays. The rule, fixed in advance: if the scan (tag − page) costs more
than that rebuild, or more than 200 ms, build the plan's §8 index instead.

Ran: the targeted nextest filter `test(6242) | test(reindex_fts_references) |
test(fts_index_reports)`, red on `main` for the new tests, plus four
mutations of `index.rs` (revert, drop scan, drop unresolved seed, tag gate
always true), each red on the predicted tests. The reviewer also ran a
654-test FTS, sync and oracle filter. `cargo clippy --workspace
--all-targets` is clean. The bench is verified by branch dispatches of
`bench-smoke` and `bench-slo`, recorded on the PR.
