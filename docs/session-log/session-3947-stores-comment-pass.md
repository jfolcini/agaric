# Session 3947 — Stores comment pass

Issue #6568, checkbox "Comment volume: one bounded, verifiable pass over `src/stores`". Every non-test `.ts` under `src/stores` was read; comments in 32 of the 36 files were cut to their one reason (an invariant, a trade, a trap, a "why not X"). Issue history, narrative, restated code and figures that rot were deleted. `navigation-history.ts`, `resolve-titles.ts`, `show-page-in-graph.ts` and `page-move.ts` already met the bar and are unchanged. No token outside a comment changed.

## Decisions and traps

- Comments that had gone false were fixed against the code: `PageBlockState.moveToParent` / `moveBlocks` docs (both now splice optimistically, and `moveBlocks` is one `move_blocks_batch` call), `blocksById` ("rebuilt on every mutation"; it is copy-on-write), the command palette's `setPendingViewQuery` ("closes the palette"; the caller does), the recent-pages module doc (visits come from the tabs store's `navigateToPage`), the tabs `goBack` doc, the `advancedQuery` module doc (it still said sort and group were future work), and an `inline-property-commit` doc calling the file a `lib/` module. Pointers to a `pendingSplits` registry in `use-block-flush.ts`, which exists only in that file's test, were dropped.
- Two floating doc blocks were moved onto the functions they describe (`reconcileBatchMove`, `rescuePinnedAsBookmarks`). Moving a comment leaves the compiled output unchanged.
- Kept: every `oxlint-disable` directive, the `@public` tag on `blocks.ts`'s `FlatBlock` re-export (knip reads it), and `page-blocks-move.ts`'s note on why `handle` is assigned before the cast.
- `src/stores/blocks.ts`: the two NUL-separator lines and the comments above them are untouched, since another open PR edits them.
- esbuild 0.28 keeps `//` comments that sit at statement level in its default output, so the raw before/after output differs, on comment lines only. The issue assumed `--loader=ts` drops every comment. The proof below therefore runs two checks: the plain build with comments stripped from both sides, and esbuild's own `--minify-whitespace`, which drops comments and renames nothing.

## Proof

Edits went through a script that replaces only line ranges where every original and replacement line is a comment or blank, and refuses a range that starts or ends inside a comment block.

1. Plain compile of every non-test `.ts` under `src/stores` (`esbuild --loader=ts < file`, no bundle, no minify) before and after. Comments were then stripped from each output with `oxc-parser`, and `diff -r` over the stripped outputs printed nothing. The raw outputs differ only on `//` lines (`diff -r before after | grep '^[<>]' | grep -v '^[<>]\s*//'` prints nothing).
2. `git show HEAD:$f | esbuild --loader=ts --minify-whitespace` against the same command on the working file, for all 36 files: `diff -r` printed nothing.
3. Types, which esbuild erases, were checked too: each changed file's HEAD and working source, with comments removed by `oxc-parser` and whitespace collapsed, are equal ("32 changed files, 0 differ").

Comment share (comment-only lines / non-blank lines, counted with `oxc-parser`): `src/stores` went from 5379/11159 (48.2%) to 2333/8113 (28.8%).

## Checks run

`npm run typecheck`, `npm run lint`, `npx vitest run src/stores`, `prek run --all-files`, and the manual-stage hooks (`prek run --hook-stage manual --all-files` with the cargo hooks skipped). No cargo, no Playwright: comments only.
