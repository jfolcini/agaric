# Session 3887 — Find in page searches the whole page (#6557)

Ctrl+F walked DOM text nodes, so on a long page it only saw painted rows: off-screen rows are empty placeholders, rows past the mount cap and children of collapsed blocks are not mounted. A 200-row page reported 4 of 40 matches and "0 of 0" for a phrase in the last row.

Find now counts over the page store when the find container holds a `BlockTree`. `src/lib/in-page-find/block-text.ts` derives each block's visible text from its parsed markdown (link and tag chips as their resolved titles, query and embed blocks as nothing) and keeps `{ blockId, start, end }` matches. Which stores are "in the container" is decided by the bus registry of mounted trees (`mountedTreeStores`) intersected with the `li[data-block-id]` rows inside the container, so page mode and the journal month grid (no tree) still take the old DOM walker path.

Painting re-runs the matcher over a hydrated row's own content text (`block-static`, or the editor's `.ProseMirror`), joined across text nodes, and takes the k-th DOM match for the block's k-th match. That keeps a small gap between derived and drawn text (footnote numbers, KaTeX) local to one block, and lets a match cross a mark (`FindMatch.endNode`). Chrome outside block content is no longer counted.

Navigating to a match outside the DOM sets `revealBlockId` on the find store; `useFindReveal` (called from `BlockTree`, one small hunk) expands collapsed ancestors with the persisted `expandBlock` and raises the mount cap. The transient `expandAncestors` reveal was not used: it is exclusive with the focus reveal and the two effects would undo each other. Focusing the block was not used either: it mounts the editor and takes focus from the find input. Once the row exists, `InPageFind` scrolls the placeholder in so it hydrates, and a `MutationObserver` repaints and scrolls to the match.

`useBlockFindVersion` re-runs find when a tree's blocks change, a tree mounts or unmounts, or resolved titles change. In practice a tree also re-registers on the bus when its blocks change, so the e2e edit test cannot isolate the per-store subscription; it goes red only with all triggers removed.

Not handled: a match outside the active zoom pane is counted but not revealed; journal agenda panels and the page title are no longer searched; `InPageFind.tsx` grew past its old size (the refresh effects went into a hook, the driver did not).

Checks run: the new long-page describe in `e2e/in-page-find.spec.ts` red on main, then green with the existing find tests (re-premised from 5 to 3 matches: chrome no longer counts), `keyboard-chords-page` and `search-sheet-mobile`; vitest for `block-text`, `use-find-reveal`, `InPageFind`, the find store, `SearchSheet`, `PageEditor` and the BlockTree suites; `npm run typecheck`. Each new e2e assertion and vitest was shown red by a mutation.
