# Session 2622 — a deep link opens what the block is, not what the link says

#5899: `agaric://page/<id>` on a content block opened the block as a page,
and `useBlockAutoCreateFirstBlock` added an empty child under it on every
visit, because `load_page_subtree` returns nothing for a non-page root in
the block's space.

`handleNavigatePayload` now goes by the block's `block_type`: a page or tag
opens as itself; a content block opens its page (`page_id`, else the
parent walk) with the block as the scroll target, whichever kind of link
named it. Two fallbacks that opened a non-page id as a page are gone: a
failed `getBlock` and a parent walk that ends without a page now open
nothing and show the "Link target not found" toast an in-app link to a
missing block shows, since the router cannot tell a page from a content
block there. `kind` decided nothing any more, so the parameter and
`NavigateTargetKind` are deleted. `load_page_subtree` is unchanged (embeds
and prefetch call it).

Tests: the router's vitest (72): a page link to a content block, a page
link whose walk ends on a content block, a tag link; six cases that pinned
the old fallbacks now assert nothing opens. Each revert went red on the
predicted cases. The mock refuses `load_page_subtree` for a content-block
root, so no Playwright spec can show the original bug.
