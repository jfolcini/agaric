# Session 3150 — Change a property's type, with a preview (#5841 S3)

Slice S3 of #5841, built on S1 (#6187) and S2 (#6196). The maintainer decided its twelve open questions in issue comment 6507641357, each as recommended.

**Shipped:**
- **No new op.** The type change is `rewrite_properties` with `reason: change_type`: one definition write, and one value write for each value whose form changes. There is no format bump.
- **`coerce(value, to)`** (`agaric-engine/src/loro/coerce.rs`) is pure. Its conversion rules:
  - **number:** trimmed text in Rust's f64 grammar, finite only;
  - **boolean:** exactly `true` or `false`;
  - **date:** strict `YYYY-MM-DD`;
  - **ref:** a ULID shape, stored uppercase;
  - booleans and numbers never convert into each other;
  - select option membership is the change's own check, never the projection's or undo's.
- **Commands:**
  - `preview_property_type_change` and the cursor-paged `list_property_type_change_values` read the space's SQL rows, Trash included. A value only the doc holds is not counted.
  - `change_property_type` takes the acknowledged counts and refuses a stale acknowledgement with `UnacknowledgedPropertyLoss`.
  - The list reads rows as a stream and stops at `limit + 1`.
- **Projection.** A `Str` is projected through `coerce` against its declared type. A stray string under boolean or date, or a non-finite number, now reads as absent instead of `value_bool 0` or unchecked text in `value_date`. Numbers and booleans keep their native column whatever the type (decision 6).
  - The review checked every writer: no value the app writes becomes hidden.
  - A stray string under boolean that used to show as false disappears the next time its block is re-projected. There is no repair (decision 11).
- **Apply.** It also re-projects a retyped key's holders whose stored form doesn't change, for example text → date for a valid date.
- **Undo:**
  - S1's restore guard now runs only for a merge's undo. A type change's undo writes back the values it converted itself, so the guard would have refused almost every undo.
  - Undoing an older set into a retyped key converts the value, or refuses with "change its type back first" (`fit_reverse_to_declared_type`). It checks the slot only, never select options, and finds Trash blocks and the space block itself.
  - The plan put this fix in `find_prior_property`. As in S2, the real funnel is `with_recorded_prior_in_tx`.
- **Settings › Properties** gets *Change type…*. The dialog shows the counts with a Trash note, and Removed and Converted tabs with Load more, ref titles, a stale-acknowledgement re-preview and an Undo toast. History labels `rewrite_properties` "Properties rewritten", with a summary for each reason.
- **Mock.** It mirrors `coerce` exactly, including Rust's trim and its f64 display (`-0`, no exponent). `isIsoDate` had read years 0–99 as 1900–1999 through `Date.UTC`; it now sets the full year, which also fixes the search date filter.

**Accepted, not fixed:**
- **Undoing a type change after a later rename of the key brings the old key back** next to the new one. Nothing is lost, and S2's merge undo behaves the same way.
- **Redo re-applies the change's absolute writes over later edits.** No UI path reaches a redo of it today.

**Ran:**
- clippy clean.
- Full nextest: 3652 + 3644 passed, plus doc-tests.
- After the review fixes: 1037 targeted Rust tests passed.
- Full vitest: 24,124 passed.
- The whole Playwright lane: 1,581 passed. Its only failures are the two `diagram-legibility` cases, which fail the same way on `main` in this container.
- `prek`, manual and default stages.
- The coerce proptests at 20,000 cases.
- Not run here: `e2e-tauri/property-type-change.e2e.ts`, which runs in CI.
