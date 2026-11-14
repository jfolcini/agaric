# Session 4176 — Search: a term under three characters returns results (#6752)

Set out to build #6752 by its plan: measure option 1 (a bounded substring scan for the short terms) with a new `interactive_slo` probe, ship it if it stays inside the search budget, and stop without building a second index if it does not.

## The measurement

`bench-slo` on the branch, warm, the `FIXTURE_SIZE` vault. Each line is the accumulated mean, with Criterion's interval for the same samples. The first run (43586310226) timed the raw-content scan; the second (43597361575) the shipped one, which tests the stripped text:

| Probe | Raw content | Stripped text | Budget |
| --- | --- | --- | --- |
| 2-char term in 20 of 100K blocks (one full pass) | 35.77 ms (35.06 to 36.80) | 79.52 ms (79.34 to 79.71) | 200 ms |
| 2-char term in nearly every block (one page) | 0.38 ms (0.378 to 0.382) | 0.44 ms (0.41 to 0.46) | 2 ms |
| word + 2-char term, 10K trigram candidates | 24.17 ms (24.10 to 24.60) | 24.52 ms (24.40 to 24.90) | 100 ms |
| existing 3-char query, 10K matches, same run | 24.18 ms (24.05 to 24.89) | 16.60 ms (16.14 to 17.49) | 30 ms |

The second run's runner was faster (the 3-char probe fell by a third), so against its sibling the stripped scan costs about 3x the raw one in the rare case: each block it walks is one more index lookup into FTS5's content table. Beside a word the short term now shows (1.5x the 3-char probe, where raw content sat inside its interval). Both are under their budgets.

The rare term's mean moved a 1-2-5 step: 3x is 239 ms, so the rule would give 500 ms. The budget stays at 200 ms, the product target for an interactive command (`docs/architecture/operations.md` § Product SLO); a gate above the product target would let the probe miss it unflagged.

The fixture's blocks are about 45 bytes. The scan's cost follows the bytes it reads, so a vault of long blocks pays more for the rare-term case than this number says.

## What shipped (PR #6781)

- `parse_query` (`fts/search/sanitizer.rs`) returns the terms under `TRIGRAM_MIN_LEN` beside the MATCH expression. `sanitize_fts_query` returns the same expression as before, so the backlink filters and the query engine's text filter still ignore a short term.
- `build_fts_fetch` answers short terms with `add_shown_text_contains` (`fts/filter_builder.rs`): `EXISTS (SELECT 1 FROM fts_blocks_content s WHERE s.c0 = b.id AND s.c1 LIKE ? ESCAPE '\')`, the block's stripped text read by `block_id` through `idx_fts_blocks_content_block`. Beside a MATCH it is one more predicate; alone it filters a scan of `blocks` with the MATCH query's placeholder layout and row shape (constant rank, no snippet, `b.id` keyset, newest first). Keeping that shape is what let the cursor path, the toggle post-filter and the palette's partitioned scan take short terms with no code of their own.
- A first version tested raw `blocks.content`; the maintainer chose the stripped text, so a short term never matches markup or the inside of a reference id. A `LIKE` on `fts_blocks` itself was rejected: it scans the whole index and sorts before the first row (a common term measured near 200 ms locally).
- The scan is `INDEXED BY sqlite_autoindex_blocks_1`. Left to the planner it took `idx_blocks_space_type` and sorted every match: a local timing of the common-term case went from about 120 ms to under 1 ms with the hint. The common-term probe exists to keep that.
- `highlight_short_term_rows` gives rows of a query with a short term `match_offsets` for all its terms.
- The two notes under the search box and their i18n keys are gone. The MCP `search` description and the docs restate the floor.
- The mock's two search handlers split short terms the same way, pinned by seven conformance steps the backend authored.

## Traps

- **The mock regression CI caught.** The mock's MATCH is a whole-query substring test. With the short words taken out, the first version joined the rest into one phrase, which is no longer a substring: the palette found nothing for a page titled "Lines in a block", and three page-mode Playwright specs that open a page by such a title went red. The longer words now match one by one, as the backend AND-joins them.
- A short term beside `OR` or after `NOT` stays out of the query. Requiring the operand of a `NOT` would invert it.
- A repeated short term (`a a a`) is scanned for once; an app test used a hundred of them.
- `CONFORMANCE_UPDATE=1` rewrites every fixture's formatting. Restore the ones you did not touch and run `oxfmt` on the ones you did.
- A doc link from a `pub` item to a `pub(in …)` one fails the pre-push `cargo doc` hook, which clippy and nextest do not run.
- The pre-push verify filled the disk allowance mid-build; `target/debug/incremental` was 18 GB.

## Left for the maintainer

- The rare-term budget is held at 200 ms, under what the 3x rule gives (500 ms); see the measurement.
- Replace across pages keeps its three-character floor.
- The backlink `Contains` filter and the query engine's text filter still drop short terms. Since #6779 a query block's free text reaches the latter (`sanitize_fulltext`): a block of only short words is refused, and a short word beside a longer one is dropped.
- Two non-blocking review notes, left for a follow-up: a non-ASCII short term misses mixed-case content (`яб` does not find `яБ`), since `LIKE` folds ASCII only and the term is tried in four case forms; and `highlight_short_term_rows` computes offsets on raw content, so a longer term split by markup (`foo**bar**`) is left unmarked and the row drops the snippet that marked it.

## What ran

Store crate `cargo nextest` in full; the search, FTS, MCP and conformance suites with `--workspace`; `cargo clippy --workspace --all-targets -- -D warnings`; `npm run typecheck`, `npm run lint`, the mock, SearchPanel and i18n vitest files; the three page-mode Playwright specs after the mock fix; `scripts/push.sh`'s verification on the first push. The six `short_term_*` tests were shown red on the unchanged search code, and the new conformance steps red on the old mock. `e2e-tauri/search-short-term.e2e.ts` ran only in CI, where it passed.
