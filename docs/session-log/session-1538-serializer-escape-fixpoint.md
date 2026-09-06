# Session 1538 — The escape verdict follows the split

Third PR of the batch run alongside a second agent in another container (sessions 1536 and 1537 carry the first two and the PR-board decisions). This PR closes #4731.

`escapeText` decides whether a `_` needs escaping per text node, but the parser leaves a run split wherever a degenerate delimiter pair collapses (`a====\_a` parses to `text "a"`, `text "_a"`). The second node starts with `_`, so it is escaped as edge-adjacent; the serialized string reparses into one node where the same `_` is intraword and is emitted bare. Not a fixed point, so the stored content churned on the second save and the idempotence property reddened unrelated PRs whenever a seed reached the shape.

The issue proposed merging adjacent unmarked text nodes before the escape pass. The builder shipped exactly that, and the reviewer showed it was not enough: the same split happens inside a mark run (`**a====\_b**` gives `**a\_b**` then `**a_b**`, and likewise for italic, strike, underline and highlight). The merge criterion is now "adjacent text nodes with identical marks", keyed on the full mark JSON so two links with different hrefs never merge, with `code` carved out because each code node is its own backtick span. It runs once at the paragraph entry so the escaping walk, `defuseLeadingItalicMarker` and `groupByLink` all read the same nodes. Merging same-marked neighbours is lossless because the serializer emits them back to back with no delimiter between them.

Verified: fixtures pin the issue's repro as an exact string and a fixpoint, the mark-run split, the builder-level unmarked and same-mark merges, and one negative case for both carve-outs. Both halves falsified against copies: the merge disabled reddens four fixtures; the carve-outs removed reddens the negative fixture plus two pre-existing consecutive-link tests. The idempotence property passed at 20000 runs (restored to 500, `cmp` clean). Full vitest: 807 files, 18592 passed, 1 expected fail, 37 skipped. Typecheck and oxlint clean.

Shipped: fix for #4731.
