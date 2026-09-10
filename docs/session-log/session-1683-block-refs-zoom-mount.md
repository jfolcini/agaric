# Session 1683 — linked references follow the zoom, and know their kind

#4551, second of three PRs. With the `kind` column on `block_links`
(session 1681), the two user-facing halves of change 5 could land: Linked
References mounted on a block, and a link-kind filter with an anchor
highlight.

The mount is the zoom pane, per the maintainer's decision. `useBlockZoom`
gains an `onZoomChange` callback, ref-held and fired from an effect on
`zoomedBlockId`; `BlockTree` threads it and `PageEditor` keeps the value in
local state and renders `LinkedReferences` with `targetId = zoomedBlockId ??
pageId`. No store field. The prop rename from `pageId` to `targetId` is
mechanical; the journal's `DaySection` keeps passing the day page.

The kind filter is an optional `kind` argument on `list_backlinks_grouped`
(`LinkKind`, `page_link` | `block_ref`), spliced as `AND (? IS NULL OR
bl.kind = ?)` into the four SQLs that touch `block_links`: the total count,
the filtered count, the group page and the member page. The plan named
three; the fourth, the filtered count, has its own falsification. All four
are dynamic queries, so no `.sqlx` cache moved; the bindings regenerated.
The mock honours the argument with the kind its link edges carry, and three
`queries` steps in `block_ref_kind.json` pin the unfiltered, page-link and
block-ref answers, including the source that carries both forms landing in
`block_ref` only.

The anchor highlight is one `anchorRefId` on the render context: a chip
whose id equals it gets `ref-chip-anchor`, one outline rule in
`src/index.css`. A row that links a decoy gets none; a test drives the real
renderer to pin both.

The reviewer found the one defect worth the name: the kind toggle sat
inside `ListViewState`, whose skeleton and empty branches discard their
children, so every click remounted the three buttons (a keyboard user's
focus fell to the document body) and a kind with no matches made the toggle
vanish with no way back to All. It now sits beside the always-visible
header, with two tests that redden when it is gated on the rows again. Two
things were noted and left: a journal day does not pass `onZoomChange`
(zooming there does not retarget its panel), and in a single-chip row the
anchor outline decorates the only chip.

## Verified

- `cargo nextest run --workspace -E 'test(backlink) | test(conformance) | test(ts_bindings_up_to_date)'`:
  380 passed, by the builder and the reviewer; clippy `-D warnings` exit 0.
- vitest over the backlinks, block-tree, `useBacklinkGroups`, conformance,
  `PageEditor`, `DaySection` and `RichContentRenderer` tests: 49 files,
  1457 passed.
- `npm run typecheck` exit 0; the IPC error-path, mock-parity,
  dynamic-SQL and command-arity guards exit 0.
- Playwright `e2e/block-linked-references.spec.ts` against the mock:
  zooming into a block retargets the panel and zooming out restores it;
  passed, twice.
- Falsified on copies, restored `cmp`-clean: the zoom effect's dependency
  dropped; the panel passing `kind: null`; the anchor class made
  unconditional; `anchorRefId` not threaded; the mock ignoring `kind`; the
  predicate dropped from each of the four SQLs in turn; a wrong `PageEditor`
  wiring (vitest and e2e both red); the member predicate replaced by an
  always-true one; the toggle re-gated on the rows.
- Not run locally: the full suites (CI carries them; the laptop is in use).
