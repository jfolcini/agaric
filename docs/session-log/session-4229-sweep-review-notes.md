# Session 4229 — the non-blocking review notes of the sweep

One follow-up PR for the notes the reviewer left on the PRs merged in this sweep, plus the oxlint `complexity` warnings the #6848 case labels caused.

## What shipped

- **#6839:** the JSX comment over `MenuPopoverContent` in `PageTagSection.tsx` is gone; `SelectContent` calls `keepFocusThatMovedOn` instead of its own copy.
- **#6847:** a copy noted each undeclared list by `(key, text)`, so a text under the same key whose line read the same as another block's list came out as a list, and a front matter list did the same to a block's line. Each noted list now names its holder (`HeldBy`: the front matter, or the copied block's id), and a line reads as a list only for that holder. `undeclared_lists` is now `held_lists`, and its doc comment says it returns every text or number list, declared or not.
- **#6848:** `pageFilterSummary`, `canonicalToGraphFilter` and `leafWords` are back under the threshold. The first and last move branches into small helpers. `canonicalToGraphFilter` returns `null` for the non-graph kinds through one typed list (`NON_GRAPH_KINDS`) ahead of a switch that names every graph kind, so a new kind still fails to compile until it is placed.
- **#6849:** the header and section titles of `model.mutants.test.ts` name functions, not line numbers.
- **#6828:** the bench-slo Loro step's comment says it reuses the dependencies, not the build, and the step is `continue-on-error`, so it cannot redden the SLO results already in. The figures note on `src-tauri/benches/AGENTS.md` was not applied: no #6828 review note asks for it, and an AGENTS.md edit needs the maintainer's own approval.
- **#6850:** the purge call sites re-strip their referrers through `reindex_purge_referrers_fts`, which calls `reindex_fts_for_ids` directly, without the `page_and_tag_referrers` lookup that finds nothing for a referrer.
- **#6823:** no change. `rebuild_fts_index/100000` (`query_bench`, release without LTO, this container) took 5.21 s [5.16–5.27] at this branch and 5.43 s [5.36–5.50] at the commit before #6823, so the per-byte origin Vec does not slow a full rebuild.

## What ran

- `node scripts/run-mutation.mjs filters-model`: 171 killed, 0 survived, 0 no coverage. `query-text` and `PageBrowserFilterRow` are not enrolled modules.
- Removing a name from `NON_GRAPH_KINDS` fails `npm run typecheck` (TS2366).
- The new Duplicate test goes red at its text assertion when every block holder collapses into one; both #6843 tests go red when `reindex_purge_referrers_fts` reindexes nothing.
- `just check-fe`, `just test-be-related`, the #6741, markdown, duplicate, front matter, purge and #6843 nextest filters, and `cargo clippy --workspace --all-targets -- -D warnings`.
