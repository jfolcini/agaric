# Session 3196 — Review notes from #5841 S1–S4

One chore PR for the non-blocking notes the reviews of S1 (#6187), S2 (#6196), S3 (#6204) and S4 (#6211) left. Each was checked against the code first.

**Done:**
- **A page-table option rename keeps the open page's redo.** `reloadChangedPageStores` takes `{ reanchorUndo }`, default true. The rename passes false: its op is keyed by the space, so it never shifts a page's positional undo, and re-anchoring had thrown away a pending redo.
- **History icons.** The four definition ops showed the generic circle; they now show the property icon `set_property` uses.
- **`history-utils` mutation survivors.** Tests for each guard of the definition-op summaries raise the module's score from 89.2% to 99.6%. The one survivor left is equivalent and already accepted.
- **The definition-op invalidation propagates a parse failure** instead of rebuilding the agenda anyway. A payload the loose hint cannot read also fails the apply's strict parse, so that op changed nothing; this is the shape the `create_block` and `edit_block` arms already have.
- **`project_property_value_writes` deletes in one `json_each` statement,** not one per write. Every producer writes each `(block, key)` at most once, so the order of deletes and inserts doesn't matter.
- **`fit_reverse_to_declared_type` passes the declaration itself,** not a copy without options. A select value outside the options now fails the options check, then `coerce` keeps it unchanged, so the outcome is the same.
- **Docs:** undoing a merge restores each moved value as it was, overwriting an edit made since.

**Skipped:**
- **The type-change dialog's tab surviving a re-preview** is not a bug. Every preview clears the shown preview first, which unmounts the tabs. A test of the described sequence passed on unchanged code.
- **An early return in `forward_property_key` for built-in keys** is an unmeasured optimisation.

**Left for the maintainer:** `src/stores/AGENTS.md` says `reloadChangedPageStores` re-anchors undo; it now can skip that for a space-level op. Editing it needs approval.

**Ran:**
- clippy and fmt clean.
- Targeted nextest over the touched modules, the property commands and conformance: 652 passed.
- vitest over the touched areas: 3,642 passed.
- typecheck.
- Playwright: the properties, history and history-revert specs, 19 passed.
- Mutation run on `history-utils`.
