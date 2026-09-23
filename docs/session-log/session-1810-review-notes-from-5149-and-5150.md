# Session 1810 — review notes from #5149 and #5150

These are the follow-ups for two merged PRs. AGENTS.md § How we work lands a non-blocking note from an approved PR afterwards, off fresh `main`, instead of pushing it onto the approved branch.

**One paste, one undo entry (#5149).** `pasteBlocks` notifies the undo store once per depth level. Until now it relied on the 500 ms group window to join those notifications into one entry. When one level's `create_blocks_batch` took longer than the window, for example a paste of hundreds of blocks or a retry backoff, the paste split in two, and Ctrl+Z reverted only the deepest level. Each paste now passes its own `coalesceKey`, which groups the notifications however long they take. The ONE-entry test used to pass only because its stubbed batches resolved quickly. It now steps `Date.now` past the window on every batch, and a second test pins that two pastes stay two entries. An older op-refs test asserted the exact two-argument call, so the pre-push vitest run caught it. It now asserts the paste's key as well, and dropping the key reddens it.

**An unterminated fence in a source buffer (#5150, note 1 of both reviews).**
- **The defect.** When a block's code fence never closed, its ` ^ID` landed inside the fence, so the block lost its anchor on parse. A child at a deeper depth also folded into the block's content, because #2866's recovery only closes a fence at the same or a shallower depth. Nothing parses a buffer back yet, but once a save does, this loses data.
- **The fix.** When a block's last line is code, source mode now writes the `^ID` on a line of its own, and the parser ends an open fence at that line. A code line shaped like an anchor line is backslash-escaped. The escape probe looks past leading whitespace and backslashes, which keeps the escape injective, as `needs_list_marker_escape` does.
- **The generator.** The round-trip proptest's generator used to exclude exactly this shape. It now leaves fences open and writes anchor-shaped code lines with 0 to 2 leading backslashes.

Notes 2 and 3 from #5150's second review (the unreachable `NameSnapshot`, and the too-wide `pub`) are resolved by #5151, which adds the caller and makes both items private again.

**Verified.** The workspace nextest filter `markdown|source|import|export` passes 415 of 415. The round-trip proptest passes at `PROPTEST_CASES=3000`, and the pre-commit clippy hook is clean.

**Falsified against copies.** Each mutation below was restored and checked with `cmp`, and each one reddened the source tests:
- The parser not ending a fence at an anchor line: 4 tests failed.
- The writer keeping the anchor at the end of a code line: 4 tests failed.
- The writer not escaping an anchor-shaped code line: 1 test failed, the proptest.
- The parser keeping that escape: 2 tests failed.
- The escape probe not looking past backslashes: 1 test failed, the proptest.
- Appending the anchor to the written line instead of re-rendering it: 1 test failed, the `key::` case.

The proptest regression seeds those mutants left were deleted, because they record mutants rather than defects.
