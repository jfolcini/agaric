# Session 3453 — The stored form is the editor's form (#6277 C3)

Set out to build #6277 C3: every block content Rust stores should come back from the editor's `serialize(parse(c))` unchanged, or as a reviewed canonical form, so a one-character edit stops rewriting the rest of the line and the user's mirrored file.

**Survey first.** The round-trip over the 16 existing `block-content.vectors.json` rows plus 168 corpus blocks failed 23 rows. Two of the item's premises were wrong. C1/C2 fixed reading, not writing: the serializer still writes backtick fences, `---` and its own table delimiter row. And the Document reader's raw output is not what an import stores, since names become `[[ULID]]`. The maintainer's decisions (#6277 comments 6641118463 and 6642863191, relayed through the coordinator) settled the rest:
- corpus rows in the stored form;
- source-form normalizations as reviewed `editorCanonical` rows;
- the image inside a link as its own issue, #6342;
- list start and callout case kept as the editor writes them.

**What shipped.**
- The vectors writer (`the_block_content_vectors_carry_what_rust_reads`) also authors a `corpusBlocks` array: each distinct Document-reader block of `agaric-engine/tests/markdown-corpus/*.txt`, rewritten by the importer's own name rewrite as an empty space resolves it, with ULIDs from blake3 so the file is stable. Rust keeps a row's reviewed `editorCanonical` and `knownLoss` by name and never writes `editorFlush`.
- `block-content-conformance.test.ts` asserts the round trip for every `blocks` and `corpusBlocks` row. A `knownLoss` row (#6342) asserts the loss still shows, so fixing it reddens the row.
- A code fence keeps its whole info string; one holding a backtick keeps a tilde fence. The static view auto-highlights an info string that names no grammar, as the editor does.
- The heading escape, the first small defect, shipped separately as #6343.

**Merged with B3 (#6330).** The same writer now authors `rustReads`, `fts` and `corpusBlocks`. `corpusBlocks` carries no `fts`. B3's tilde-fence indexing quirk went to its owner as #6348; whichever of #6348 and this PR lands second re-authors the vectors.

**Trades.** An info string that starts with `~` and holds a backtick (`~~~ ~`x`) still re-reads differently on the next save. It was dropped outright before, and no user is known to write one. A stale `knownLoss` on a row whose content changes stays green, because the "differs" check holds for any normalized row. That covers one row.

**Tests.** Reds shown for: the parser's old filter, the tilde choice, `_` emphasis, a `***` rule, a revealed fence, the static highlight fallback, and the Rust rewrite and kept fields. Gates: editor, lib and components vitest (21621), typecheck, lint, all hooks, vectors/source/import nextest (404), clippy, and 100 fence-related Playwright tests.
