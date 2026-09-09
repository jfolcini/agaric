# Session 1640 — the reconciliation oracle behind a command

#4886 asks for the reconciliation oracle to run against a real vault. The oracle
is the strongest integrity check in the repo and it had only ever seen synthetic
fixtures: `src-tauri/src/reconciliation_oracle.rs` opened with `#![cfg(test)]`,
so none of its rebuild-and-diff code existed in a release binary. This session is
the backend half — the move out of `cfg(test)` and one Tauri command in front of
it. The opt-in setting that calls the command is the next commit on the same
branch and is not described here.

## What moved, and what stayed

The rebuild functions and the diff logic now compile in every build. Nothing in
them changed in substance; the header's "Where this runs" section says the
release entry point exists and what it may not do (read, compare, return — never
repair, never panic). Three things stayed behind `cfg(test)`, in a new
`reconciliation_oracle/harness.rs` that the parent re-exports so the proptest
drivers' `crate::reconciliation_oracle::settle_*` paths still resolve.

The `settle_*` helpers had to stay: every one of them WRITES, by calling a
production rebuild (`rebuild_pages_cache`, `rebuild_page_ids`,
`reindex_page_link_cache_for_block`, …) so a driver can bring a fixture to the
settled state the oracle is a statement about. A release oracle that could reach
those would be a repair tool with an audit tool's name. The `assert_*` and
`*_reconciliation_failure` pairs are the panic-or-format wrappers proptest feeds
to `prop_assert!`; the coverage counters (`OracleCoverage`,
`BlockLinksCoverage`, `BlockLinksUnresolvedCoverage`) are the non-vacuity
assertions the tests make about their own fixtures. Six thin
`rebuild_*_from_base` wrappers went with them — `rebuild_pages_cache_rows`,
`_page_ownership`, `_block_space_ids`, `_block_links_from_content`,
`_block_tag_refs_from_content`, `_block_links_unresolved_from_content` — because
each is `Ok(fold(&dump_blocks(pool).await?))` and only a test ever calls it;
the release diffs call the folds directly. Where a wrapper carried the rationale
for its artefact and the fold had none, the doc moved onto the fold rather than
leaving with the wrapper. The issue counts twelve rebuild functions; the twelve
folds they wrap are all in release, six of them still under their own name and
six under the fold's.

Two things only showed up once the module was compiled outside `cfg(test)`.
`reconcile` was 280 code lines, tolerated by the crate-root
`cfg_attr(test, allow(clippy::too_many_lines))`; it is now seven `diff_*`
functions, one per artefact, with the owner strings hoisted to constants, and
`reconcile` is the twenty-line orchestration that states the root-cause-first
order. Three folds sat at the 70-line threshold and lost a shared
`fold_template_pages`, a `remaining_occurrences`, and an
`unresolved_target_state` each. The second was the SQL. The dumps were dynamic
`sqlx::query_as` literals, every marker reading "test-only oracle read-back",
which was the whole justification and stopped being true. They are
`sqlx::query!` now, like every other production query, with one exception the
build forced: a column select over `fts_blocks` makes `sqlx-macros` SIGSEGV
during describe — reproducibly, at the same frames, with `RUST_MIN_STACK`
doubled and quadrupled — and no cache in the workspace has ever held one, only
`COUNT(*)` and writes. That read stays a static literal with a marker naming the
crash, and is the one entry the dynamic-SQL baseline gained.

One coupling is worth a paragraph for the next person who moves a module out of
`cfg(test)`. `scripts/check-dynamic-sql.py`'s self-test used
`reconciliation_oracle.rs` as its fixture for "a whole-file `#![cfg(test)]`
module with runtime SQL sites", and asserts that fixture is still out of scan
scope — so removing the inner attribute reddened the guard's self-test before it
reddened anything the guard polices. The fixture now points at
`bulk_equivalence/mod.rs`, the only other such file in the tree. `harness.rs`
carries its own `#![cfg(test)]` so the whole-file rule applies to it as well;
its filename matches none of the guard's test globs, and the eight coverage
counters in it are dynamic reads that would otherwise have needed a baseline
entry of their own. The other thing a private module gains when a public one
starts linking to it: `cargo doc` with `private_intra_doc_links` denied refuses
a `[`Divergence`]` in the command module's docs, since `reconciliation_oracle`
is private; that link is a code span.

## The command and the shape of its answer

`commands::reconciliation::compute_reconciliation_report` takes the reader pool
and nothing else. Its `_inner` takes `today` as a parameter, because the
projected-agenda rebuild is the one artefact that is not a pure function of the
database, and the wrapper passes `chrono::Local::now().date_naive()` — the same
clock `rebuild_projected_agenda_cache` reads. The oracle gained one function for
it, `reconcile_all`, which runs `reconcile` and then the six artefacts `reconcile`
deliberately leaves out. Those six are the triaged deep checks whose MISSING arms
can fire on eventual-consistency residue rather than a defect, which is why the
per-op proptest gate excludes them; a whole-vault, user-triggered run is the
triage lane, so it includes them and lets the artefact name carry the caveat.

The report is per artefact: its name, a count, and up to ten row keys, plus
`blocks_scanned` and `today` at the top. "17 rows of
`pages_cache.child_block_count` disagree, starting with these ids" is the
sentence the shape is built to produce. Two things are deliberately absent. The
`expected` / `actual` strings the oracle computes quote values — a stripped FTS
body, a tag's name, an attachment's path — and the bug-report dialog embeds its
metadata in a public issue body, so the report carries keys (opaque ULIDs,
hashes, dates) and never values, the line #609 and #4854 drew for the rest of
the bundle. The `owner` text is absent too: it is a static paragraph per
artefact, and the header table in the oracle maps the artefact name to it, so a
maintainer reading an issue loses nothing. `blocks_scanned` is the non-vacuity
figure: zero divergences over zero blocks is a statement about an empty vault.

## The mock and the conformance ratchet

The mock got a handler, not a `KNOWN_UNMOCKED` entry — that list is empty and
the browser dev path the settings UI will be built against needs the command to
answer. What it answers is `total_divergences: 0` over `blocks.size`, and that is
honest rather than a stub: the mock keeps no derived tables at all, every read
recomputes from `blocks`, so there is nothing that could diverge, and a real
vault whose derived state agrees with its base tables gives the same answer.

For the conformance ratchet the command is waived in `READ_NO_QUERY_ALLOWLIST`
and listed as debt in `NOT_YET_PINNED_READ`, not as principled. The reason is
the same one `list_projected_agenda` carries, one level up: the report CARRIES
`today`, so a backend-authored `expected` binds the day it was generated on. The
second half of the reason is what a query step would actually compare — the
mock's constant against a diff over tables the mock does not keep — which would
pin nothing about the rule. It is filed as debt rather than principled because
"the mock has no derived tables" is a statement about the snapshot's scope, and
the file's own rule is that scope is a thing a widened snapshot fixes.

## What the tests prove, and what they cannot

The corruption test seeds a page and a child through `create_block_inner`,
flushes the materializer, and asserts the report is exactly two blocks scanned,
zero divergences, no artefacts — the clean arm, and it is the arm that turned out
to carry information: the real command path settled clean on the first run,
which is the oracle's B6 property restated over the command. Then it adds five
to that page's `child_block_count` in `pages_cache` and asserts the report is
exactly one artefact, `pages_cache.child_block_count`, count one, sample key
that page's id, total one — the other arm, and the one that would have stayed
green against a report that grouped wrongly, sampled the wrong field, or
swallowed a divergence. A third test drops `agenda_cache` and asserts the
`_inner` returns `AppError::Database` rather than a report: a vault the oracle
cannot read is not a clean vault. The grouping fold has its own pure test over
thirteen synthetic divergences that pins the count as every row, the sample as
exactly ten, and the order as first-seen. The production code was broken once
against a copy — `reconcile_all` skipping `reconcile`, the grouping's sample
bound removed, the sweep's error swallowed into an empty report — and each break
went red before being restored: three of the four command tests failed, the
clean-vault test alone passed, and both files came back byte-identical under
`cmp`.

What none of this can say is what the oracle finds on a vault with years of op
history, which is the whole reason for the issue and is now a setting away. Two
properties of that run are worth stating before anyone reads a real report. The
run is not snapshot-isolated: every dump is its own statement on a pooled
connection, so an edit or an inbound sync landing mid-run can put a base table
and its derived view on opposite sides of a maintainer that has not caught up
yet, and that reads as a divergence a second run will not reproduce. Making it
consistent means threading one read transaction through every dump, a
mechanical but wide signature change across the module, and a decision I have
not taken. And it is deliberately naive — `rebuild_pages_cache_counts_from_base`
is a fold over every block per page, O(pages × blocks) — which is the point of an
oracle and fine for a user-triggered action, but it runs on the async executor
thread with awaits between the folds, so on the largest vault it will hold a
worker for a few seconds. Neither is a defect to fix before the first real run;
both are things the first real run will show the size of.

## Verification

`cargo check --workspace --all-targets`; `SQLX_OFFLINE=true cargo check
--workspace` after `cargo clean -p agaric`, because stable rustc does not track
`SQLX_OFFLINE` and the first offline pass had been a fingerprint hit that proved
nothing; `just gen-sqlx` with twelve new app-crate entries and no leaf-crate
drift; the bindings regenerated and `ts_bindings_up_to_date` green;
`check-dynamic-sql.py` and its self-test green; the full `cargo nextest run
--workspace` at 6328 passed and the eleven standing skips; `cargo clippy
--workspace --all-targets -- -D warnings`, `cargo fmt --check`, the
`cargo-doc-links` invocation, `npm run typecheck`, and vitest over
`src/lib/tauri-mock` (the parity and conformance-coverage ratchets read the
regenerated bindings) all clean.
