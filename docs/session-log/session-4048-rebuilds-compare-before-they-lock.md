# Session 4048 — Five whole-vault rebuilds compare on the read pool and lock only to rewrite what is stale

#6522 follow-on. After #6656 a content delete still enqueued whole-vault rebuilds that opened `BEGIN IMMEDIATE` before their scan (`block_tag_refs`, `tags_cache`, `agenda_cache`), and a restore added two that never used the read pool (`pages_cache` rows, `block_tag_inherited`). The next foreground write waited for those scans.

Picked up from the handover (#6667): one unreviewed `wip:` commit from a builder that was cut off.

## What changed

- Each of the four cache rebuilds has two halves. The read half compares the whole desired state with the whole cache on the read pool and keeps the ids that disagree (blocks, source blocks, tags, pages). The write half takes the writer lock only when there are any, and derives those ids' rows again from the tables as they are then. It writes nothing the read half computed, so a write that commits between the halves is never overwritten with older rows.
- A row that goes stale after the read half is left to the rebuild or refresh its own write enqueues. The background queue removes duplicates within one drained batch only, so that rebuild runs after this one.
- `tag_inheritance::rebuild_all_split` compares on the read pool and runs `rebuild_all`, unchanged and under the lock, only when the table is stale.
- The single-pool entry points are the split ones with one pool for both halves. Each rebuild it replaced is kept in the test module as `replaced`, the oracle.
- `derivations::record_split` reads the recorded version first, so a rebuild that found nothing stale takes no lock to record it.
- Two notes from #6656's review: the page-count rebuild's read half, write half and oracle share one count text (`with_computed_page_counts!`), and the lifecycle debounce binds the parsed op once, which leaves no unparsed case to choose a default for.
- `interactive_slo`: the delete/restore probe gives its materializer the app's read pool, and reports the slowest one-row write issued every 2 ms while each settle drains.

## Traps

- A plan test that builds its own copy of the SQL filter cannot see the filter production uses. The macros that scope a statement to an id list now hold that filter (`among <ids>`), and the tests read the production statement.
- `sweep_shed_not_counted_and_backoff_not_rewound_2541` used `RebuildTagsCache` as a task that always waits for the writer lock. It no longer does on a clean cache, so the test plants a tag with no cache row first. Its assertions are unchanged.
- The wip was committed with `--no-verify`, so the commit guards had never judged it. The random-write generator is test-only and is named `random_vault_tests.rs` so the dynamic-SQL and table-ownership guards skip it. `agenda.rs` and `tags.rs` each gained two runtime `sqlx::query_as` sites, so every such site in them carries a `// dynamic-sql:` reason and their baseline entries rose; the texts are named constants because the derivation golden, the plan tests and the oracles read them as values, which a `query!` literal cannot be.
- The wip held a command-sequence test against the reconciliation oracle. It is not in the PR: it cannot go green, because it reaches two divergences that are on `main` and outside this change (written up on #6522). An orphan tag adopted by `add_tag` gets none of a space move's rebuilds, and deleting a content block leaves the `pages_cache` row of a page nested under it.
- The branch's first commit after the merge of `main` holds main's tree plus the bench change. It exists so the bench lane could be dispatched on main's rebuilds with the new measurement.

## Verified

- Every new test was shown red on the assertion predicted for it: read halves that miss a class of stale row, write halves that stop narrowing to the ids named, a lock taken before the comparison, an id filter that cannot seek, a write half that keeps a name loser.
- `cargo nextest run --workspace` in two halves (8018 passed), `cargo clippy --workspace --all-targets -- -D warnings`, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, doc-tests, and `just gen-sqlx`'s command, which left no diff.
- The bench lanes run only on a branch dispatch; the numbers are on the PR.
