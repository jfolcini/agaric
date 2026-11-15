# Session 4219 — a list in filters, queries and tables (#6741, PR 3 of 4)

PR 3 of the approved plan for properties that hold a list, plus the undo gap and the #6802 review notes the maintainer added to it.

## What shipped

- **The any-item rule** on every property filter surface: the shared Pages / Search / advanced-query compiler (`PagesProjection::compile_has_property`), the backlink compiler and its resolvers, and `filtered_blocks_query` with the agenda's filter. A text, ref or date comparand compares a list's string items and a number its number items (`json_each.type`, the list's stand-in for the scalar `IS NOT NULL` guard: SQLite orders every number below every text). "Not equals" holds when no item is equal; on the backlink surface it still needs the key, as for a scalar.
- **`filtered_blocks_query`** tests a list through an uncorrelated set (`bp.block_id IN (SELECT … json_each …)`), not a correlated `EXISTS`: the plan guard `pushdown_plan_looks_blocks_up_by_candidate_id` forbids `CORRELATED` (#5426).
- **Grouping** by a list key puts a block in each item's group; global aggregates take no group join, so they count it once. **The value typeahead** offers the items of a text, select or URL list, never ref ids, dates or numbers.
- **The query table** shows a list's items, edits it with the list editor and sorts it by its first item. A multi-select is no board column, and a list key no References sort field.
- **A real-backend case** in `e2e-tauri/advanced-query-group-by.e2e.ts` groups by a list key; the mock stubs grouping. The view keeps its working set across that file's cases, so the case resets the grouping and summaries first.
- **The mock** mirrors every evaluator. `query_property_list_filters.json` pins every predicate over a list row on the advanced query, backlinks, `filtered_blocks_query` and the typeahead.
- **The bench** group `property_filter_list` puts an equality filter over 20,000 list rows beside 20,000 text rows at 100,000 blocks. One dev-profile run gave overlapping intervals, so no difference is claimed.
- **Undo:** `forward_property_key` follows an option rename into each text item of a list, so undoing a set after a rename restores the item under its new name.
- **Review notes from #6802:**
  - One item ↔ value mapping: `From<&PropertyListItem> for PropertyValue` and `PropertyValue::into_list_item`.
  - One number rule for list items: TS `readFiniteNumber` uses the `f64::from_str` grammar.
  - `write_property_list` and `joinListItems` quote line breaks.
  - The three surviving mutants are pinned.
  - A text under a list key is written as a list of one, so its line reads back as one item.

## Decisions and traps

- **`pagination::query_by_property` stays exact-column.** Its callers are mostly app-owned keys (`template`, `completed_at`) whose equality plans an `OR` would change; the plan's PR 3 names only the surfaces above.
- **A lone text under a list key** (#6802 note 3). Edit as Markdown already writes nothing for an unchanged line (`PropertyChanges::between` compares T0 and T1). The split happened in Duplicate and in an edited line. Written as a list of one, the text becomes one item in a copy, or a refused copy when that item does not fit the type. Before, it was silently saved as the items its comma split it into.
- **`CONFORMANCE_UPDATE=1` rewrites every fixture's formatting.** Run `npx oxfmt --write conformance/fixtures/*.json` afterwards and check that only the intended fixtures differ.
- **`split-debuginfo` `.dwo` files fill the cloud disk.** Repeated rebuilds left 18 GB of them in `target/debug/deps`; deleting them is safe.

## What ran

- Rust: the builder's whole workspace nextest before the fixture and bench, then targeted runs; workspace clippy.
- TS: vitest over the mock, conformance and every touched module; typecheck.
- e2e: the related Playwright specs and the new `e2e/query-table-list-filter.spec.ts`; the grouping spec under `just e2e-real`, after `apt-get install webkit2gtk-driver openbox dbus-x11 xdotool` and `cargo install tauri-driver --locked`. The app build needs `CARGO_INCREMENTAL=0` and the `.dwo` files cleared to fit the cloud disk.
- Each new test was shown red by breaking the code it covers.
