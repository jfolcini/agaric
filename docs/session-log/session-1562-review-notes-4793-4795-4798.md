# Session 1562 — Review notes from #4793, #4795 and #4798

Three non-blocking reviewer notes from merged PRs, folded in one chore.

`repair/journal_duplicates.rs` documented the child merge as happening "in `id` (creation) order" in both the module doc and above `select_children`, but the query has ordered by `(parent_id, position, id)` since it landed: children arrive grouped per duplicate page, in the sibling order that page displayed. Prose corrected in both places; no code change.

`QueryResult.test.tsx`'s row-navigation test asserted on `useNavigationStore` and the tab page stack after clicking a result row — but the `onNavigate` prop it passed was a `vi.fn` whose own body called `navigateToPage`, so those four assertions only re-checked the test's own mock. No production change could redden them. They are gone along with the mock body; `expect(onNavigate).toHaveBeenCalledWith('P1')` and the rendered-title assertion, which do cover the component, stay.

`apply/kernel.rs`'s #4661 replicated-record refusal ran after `apply_op_tx_with_mode` had already mutated the engine and projected, so the refusal depended on the caller rolling the transaction back to undo work that should never have started. The `query_scalar!` lookup and its `return Err` moved above the apply, still under `if advance_cursor`, making it a precondition. The SQL text is unchanged, so no `.sqlx` regeneration.
