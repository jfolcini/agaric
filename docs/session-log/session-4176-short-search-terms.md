# Session 4176 — Search: a term under three characters returns results (#6752)

Set out to build #6752 by its plan: measure option 1 (a bounded substring scan for the short terms) with a new `interactive_slo` probe, ship it if it stays inside the search budget, and stop without building a second index if it does not.

## The measurement

`bench-slo` on the branch, run 43586310226, warm, the `FIXTURE_SIZE` vault. Each line is the accumulated mean, with Criterion's interval for the same samples:

| Probe | Mean | Criterion interval |
| --- | --- | --- |
| 2-char term in 20 of 100K blocks (one full pass) | 35.77 ms | 35.06 to 36.80 ms |
| 2-char term in nearly every block (one page) | 0.38 ms | 0.378 to 0.382 ms |
| word + 2-char term, 10K trigram candidates | 24.17 ms | 24.10 to 24.60 ms |
| existing 3-char query, 10K matches, same run | 24.18 ms | 24.05 to 24.89 ms |

The worst case is the rare term: the scan reads every block once. It is 1.5x the existing 3-char probe and under a fifth of the 200 ms product ceiling. Beside a longer word the short term costs nothing that shows: the two 10K-candidate probes sit inside each other's interval. That was read as inside the search budget, so option 1 shipped and no second index was built.

One run, not several: the issue asks for budgets from the first run, where `src-tauri/benches/AGENTS.md` prefers recent runs. The budgets are the smallest 1-2-5 step at least 3x each mean (200, 2 and 100 ms), so one run's noise does not decide them.

The fixture's blocks are about 45 bytes. The scan's cost follows the bytes it reads, so a vault of long blocks pays more for the rare-term case than this number says.

## What shipped (PR #6781)

- `parse_query` (`fts/search/sanitizer.rs`) returns the terms under `TRIGRAM_MIN_LEN` beside the MATCH expression. `sanitize_fts_query` returns the same expression as before, so the backlink filters and the query engine's text filter still ignore a short term.
- `build_fts_fetch` answers short terms with `b.content LIKE ? ESCAPE '\'`: one more predicate beside a MATCH, and alone a scan of `blocks` with the MATCH query's placeholder layout and row shape (constant rank, no snippet, `b.id` keyset, newest first). Keeping that shape is what let the cursor path, the toggle post-filter and the palette's partitioned scan take short terms with no code of their own.
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

- The scan reads raw content, as the issue says. A two-character run inside a `[[ULID]]` token can match (`Q3`; not `UI`, `AI` or `go`, whose letters Crockford base32 lacks). Scanning `fts_blocks.stripped` would avoid that and lose the early stop.
- Replace across pages keeps its three-character floor.
- The backlink `Contains` filter and the query block's text filter still drop short terms.

## What ran

Store crate `cargo nextest` in full; the search, FTS, MCP and conformance suites with `--workspace`; `cargo clippy --workspace --all-targets -- -D warnings`; `npm run typecheck`, `npm run lint`, the mock, SearchPanel and i18n vitest files; the three page-mode Playwright specs after the mock fix; `scripts/push.sh`'s verification on the first push. The six `short_term_*` tests were shown red on the unchanged search code, and the new conformance steps red on the old mock. `e2e-tauri/search-short-term.e2e.ts` ran only in CI, where it passed.
