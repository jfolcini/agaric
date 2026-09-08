# Session 1598 — #4667 criterion 2, and the ratchet was mostly already paid

## The list of 14 was stale

#4667's acceptance names 14 self-labelled "fixture candidate: not written yet"
read commands. Ten of them are already pinned — `query_by_property`,
`query_by_tags`, `query_by_tag_expr`, `list_trash`, `list_all_pages_in_space`,
`list_all_tags_in_space`, `list_tags_by_prefix`, `list_property_keys`,
`list_property_values`, `list_template_page_ids_in_space` all sit in `WIRE` and
in no allowlist, pinned by fixtures that landed under #3827/#3829 after the
audit was written. `query_backlinks_filtered` is gone from `bindings.ts`
entirely.

So the real debt was three, not fourteen. Worth saying because the issue body
is the thing a reader plans from.

## Pinned: get_backlinks

`conformance/fixtures/query_backlinks.json`, wired in both runners. Five steps,
all ordered — every linking block is a seed block, so `bl.source_id ASC` is
comparable across stacks and no step needs `unordered`. Full listing, page 1 and
page 2 chained through `cursor_from`, a declared-empty step on an unlinked page,
and a `Global`-scope step. `expected` authored by the backend.

## What the steps found: get_backlinks never paginated

The mock returned the whole result set with `has_more: false` and
`next_cursor: null`, ignoring `limit` and `cursor` outright — every page was the
first page. The backend is `ORDER BY bl.source_id ASC LIMIT ?limit + 1` over a
`Cursor::for_id` `{id}` keyset.

Fixed by reusing `paginateKeyset` + `idKey` from `handlers/blocks.ts` rather
than growing a second cursor codec free to drift from the backend's `Cursor`
shape. Same shape as #3870's `list_blocks` fix.

## And the #4805 shape again

`get_backlinks_inner` goes through `PageRequest::new`, which REJECTS a limit
outside `[1, 200]` rather than clamping. The mock accepted anything, so it
answered where the backend errors — invariant 10, and the exact defect that made
the child-pages tree dead for every user while the estate stayed green.
The first fix mirrored `listBlocksLimit` — and that was the wrong precedent:
`handlers/search.ts` already held `PAGINATION_MAX_PAGE_SIZE`,
`PAGINATION_DEFAULT_PAGE_SIZE` and the identical range test, and `links.ts`
already imports from it. Reviewer-caught, so the check is now one exported
`pageRequestLimit` both handlers call rather than a third copy with its own
wording. `backlinks-limit.test.ts` pins both arms; reverting the validator
reddens the three reject cases while the accept cases keep passing, and a wrong
`PAGINATION_DEFAULT_PAGE_SIZE` reddens the default case — which needed 51
seeded sources, since with one the assertion held for any default above zero.

## Skipped, with the blocker named rather than "not written yet"

`list_backlinks_grouped` and `list_unlinked_references` both answer with
`GroupedBacklinkResponse` — `groups[]` of `{page_id, page_title, blocks,
truncated}`, no flat row list. The harness has one grouped projector and it is
wired to `run_advanced_query`'s bucket shape (`key`, `count`, `members`,
`aggregates`); pointed at a `BacklinkGroup` it emits `<missing-key>#count=null`
and drops every member. That is a projection extension, not a missing fixture,
so both waivers now say so.

Unproven lead for whoever builds that extension: the backend groups by
`b.page_id` and excludes same-page sources
(`agaric-store/src/backlink/grouped.rs`), while the mock groups by `parent_id`
with no exclusion (`handlers/links.ts`).

## Not fixed here: #4848

A first draft of the fixture soft-deleted a block still holding a `[[ULID]]`
token and reddened the SNAPSHOT leg: the backend keeps the tombstoned source's
`block_links` row by design and filters at read time, while the mock's
`deriveLinkEdges` skips deleted sources. The counts agree today because
`pages_cache` counts with `src.deleted_at IS NULL`, so only the raw-table
projection diverges. Closing it means touching two counting consumers outside
these 14 commands, so the fixture was narrowed and the gap filed as #4848 —
which is also why `get_backlinks`' own `deleted_at` filter stays unpinned.

## Note for the next person running CONFORMANCE_UPDATE=1

It rewrote 31 unrelated fixtures with whitespace-only churn (it expands compact
arrays that oxfmt collapses). Each was verified semantically identical to HEAD
and restored to its committed bytes.
