# Session 1530 — the arm that was not pinned

#4709: `buildPageTree` assigns `node.pageId = page.id` last-writer-wins, so two pages sharing a
title collapse onto one node and the earlier one has no node carrying its id. On the vault this
was measured against, 41 of 286 live pages are unreachable — including `Agaric` and `iadm`, two of
the newest pages in it.

## The shape, and why the brief's shape was wrong

The brief said a node must carry more than one page id. Reading the consumers refutes that: every
one of them assumes one node = at most one page — `buildMultiPageBranch`'s
`node.pageId && children.length === 0`, `collectDescendantPageIds`, `PageTreeItem`'s three-way
branch, the keyboard-Enter `byId.get(node.pageId)` mapping. An id list forces an array case into
all four, and the renderer then has to expand the list into sibling rows anyway.

Materialising the siblings in the builder does the same work in one place, and `matchedPageCount`
and `collectDescendantPageIds` then need no changes at all.

The load-bearing detail is that the duplicate is deliberately **not** registered in the per-level
index, so the first node keeps ownership of the namespace and the hybrid case (`work` plus
`work/tasks` plus a second `work`) still merges the child onto the first node.

## Three ways the work was short, all found by review

**A decision with no test.** That index-ownership decision — the one sentence above that the whole
hybrid case rests on — was completely unpinned. Registering the duplicate in the index, the exact
opposite of the decision, left **600 tests green**. Two tests claimed to cover it but both put the
duplicate last in the input, so neither exercised the choice. The missing case is a namespace
child arriving *after* a duplicate.

**A fix that closed one arm of the bug it named.** The change exists partly to stop a React key
collision from `key={child.fullPath}`. `PageTreeItem` has three `children.map` call sites; one was
fixed. The hybrid arm still collided, reproducibly — *"Encountered two children with the same
key"* — and it is reachable on the reporting vault, where `DevEx/workstations` is a hybrid. This
is the shape the review checklist names explicitly: one arm of a symmetric pair pinned and the
other open.

What let it through was the summary, not the code. Describing `PageTreeItem` as "one line" made it
a file that had been *handled*; it is three `map`s and two cue insertion points.

**A test asserting a state the system cannot produce.** The "two `tree-page` rows sharing a
`fullPath` get distinct DOM ids" test hand-built a row shape `buildMultiPageBranch` never emits —
duplicates always become flat `page` rows keyed by ULID, so `nodeKey` only ever lands on nested
children, which React keys and no DOM id touches. The test read as a11y protection and protected
nothing. Replaced with one that renders the real `PageBrowser` and walks `aria-activedescendant`.

That also explains a quieter thing: two comments asserting that the DOM-id and
`aria-activedescendant` sites "must stay in step" describe a hazard that cannot occur on any live
path. They are guards, and now say so.

## The cue had to carry a time

Duplicates are disambiguated by their ULID-decoded creation timestamp — the only property that
reliably differs, and free to compute.

The first version was date-only, and the review pointed out it does not separate the case that
motivated the issue: 15 pages titled `2026-05-05`, created within days of each other. By
pigeonhole, a handful of distinct labels across 15 rows means several rows share one. A cue that
cannot tell two rows apart is worse than no cue, because it looks like an answer.

ULIDs are millisecond precision, so `'full'` separates a same-day cohort almost always. It still
reads oddly on a date-titled page — `2026-05-05` next to `May 7, 2026, 02:00 PM` is two dates side
by side and the title is the one that matters — but that is inherent to disambiguating date-named
pages by creation time, and the alternative leaves them indistinguishable.

The test for it asserts the property rather than the format: two pages minted hours apart on one
day get different labels. Under date-only it fails with `expected 'May 5, 2026' not to be
'May 5, 2026'`.

## An extraction that was a copy

`DuplicateTitleCue` was extracted to satisfy a complexity lint — and then existed twice, verbatim,
in `PageTreeItem` and `DensityRow`, differing by a margin class. An extraction is real structure
only when there is one of it; otherwise it is lint-appeasement that has also doubled the thing it
was meant to name.
