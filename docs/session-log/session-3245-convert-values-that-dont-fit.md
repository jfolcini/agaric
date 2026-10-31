# Session 3245 — convert the values that don't fit

#6206 PR 5A. The Settings review of a key's values that don't fit gains a Convert step next to Remove and Add to options. Move to another key is the last PR, 5B, which closes #6206.

- `list_distinct_unfit_property_values` groups a key's values that don't fit by their shown text, with live and Trash counts, paged by cursor.
- `convert_unfit_property_values` writes each mapped value's replacement in one `rewrite_properties` op (reason `convert_unfit`), recording each write's prior in the form it held, so one undo restores them.
  - It refuses a replacement that doesn't fit (read under the key's type and admitted by `check_property_value`), a ref key, and a stale per-value acknowledgement (`UnacknowledgedPropertyLoss`).
- The undo's value walk (`forward_in_space`) now reads only a rewrite's values, so a reason this build doesn't know can't fail an undo.
- The Convert step lists each distinct value with a field for its replacement, under the key's type. A text or url key prefills each row with its own value.
- The mock follows the backend through `property_unfit_convert.json`, including a mixed group (text "5" and a peer's number 5) and its undo.

**Review.** A separate reviewer found a test gap on the data-safety path. Nothing converted a group that held one value in several forms, and nothing restored a number or boolean prior: recording the prior as its shown text left all nine convert tests green. It added `convert_replaces_every_form_of_a_value_and_undo_gives_each_back_6206` and doc-form assertions, plus two fixture steps. It also added vitest cases for paging, a boolean's Yes and a typed number, and replaced the review's description on the Convert step. It reproduced ten reds, among them the undo walk reading the full payload, the per-group acknowledgement, `fitted` skipping `check_property_value`, and the mock recording a number prior as text.

**Accepted:** after leaving Settings and coming back, Undo on a still-visible toast restores the values but not the list on screen. That is pre-existing and affects every definition write that offers Undo.

**Suites:** full `cargo nextest run --workspace` (both partitions), clippy, the `SQLX_OFFLINE` check, the four `sqlx prepare --check` lanes, `cargo test --doc`, `npm run typecheck`, `npm run lint`, full vitest, `prek` (both stages), and the Playwright lane `just e2e-related` selects; after the rebase, the targeted Rust and vitest runs.
