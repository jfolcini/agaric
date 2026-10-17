# Session 2350 — Page mode spike: one WYSIWYG document per page, saved per block

#5691's spike, built to the design the maintainer approved on 2026-10-17. It
sits behind a per-device `editMode` preference (default `blocks`) and a Blocks
| Page switch in the page header. It is desktop only, and a page over 500
blocks stays in block mode with a notice. It is a draft, not for merge.

**Model.** The page is one flat document of `pageBlock(blockId, depth)`
nodes over block mode's own content nodes, marks, chips and pickers. Ids
follow the source buffer's rules:
- the id stays with the text where its block starts;
- a paste brings new ids;
- duplicates are dropped;
- depth is kept a valid tree.

Joining an empty block keeps the second id, which the source buffer's rule
implies and the design missed.

**Save.** It runs on idle (700 ms), on blur, on a mode switch and on leaving
the page. Only blocks whose text changed since their last save are written,
in the order creates, moves, edits, deletes. A block's saved state advances
only when its write succeeds. An undone delete is brought back with
`restore_block`. Three of the design's premises were wrong:
- `create_blocks_batch` takes no client ids, so creates go one at a time
  through `create_block(…, blockId)`;
- `move_blocks_batch` moves one contiguous run, so moves use `move_block`;
- `restore_block` also restores deleted ancestors, so the save re-reads the
  tree afterwards.

**Remote edits.** A block whose text changed elsewhere is patched in place,
outside undo, when its local text is unchanged since the last save. The
property test found that comparing node identity instead hid a peer's edit
after an Enter, and that delete bookkeeping shifted the next create by one.
Both are fixed and pinned.

**Measured** with `AGARIC_PERF=1 npx playwright test e2e/perf.spec.ts -g 'page
mode'`: Chromium against the mock, medians of 3 with their bands.
- At 500 blocks, typing matches block mode, and opening costs about 370 ms.
- At 2,000, key-to-paint p95 doubles.
- At 5,000, INP reaches about 150 ms unthrottled.
- Two causes grow with page size: `CodeBlockLowlight` rescans the whole
  document on every edit (and is installed twice), and ProseMirror walks
  every top-level node.

The 500 cap holds until those are fixed.

**Deferred to the MVP:**
- remote creates, moves and deletes;
- a block deleted elsewhere while edited here;
- multi-paragraph paste from outside;
- cut and paste as a move;
- Shift+Tab's flat-model difference from block mode;
- chip navigation;
- the slash menu, `::`, list input rules and block chrome;
- the export flush.

Gates:
- vitest over `src/editor`, `src/components/pages` and preferences: 3,722,
  of which 50 are page mode's. Every new test was shown red: 22 mutations,
  4 of them against the fast-check property, which runs 120 cases per pass.
- typecheck, lint and knip.
- Playwright `e2e/page-mode.spec.ts` (8, with axe), and 17 editor and page
  specs with the preference off (143).
- The three `e2e-tauri` specs (restart, sync peer, `((ref))`) are written
  and typecheck, but have not run yet.
