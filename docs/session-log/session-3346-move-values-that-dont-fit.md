# Session 3346 — move a key's values that don't fit to another key

#6206's last slice. The Settings review of a key's values that don't fit gains **Move to…**: pick another key of the same space, preview how many values move, how many blocks already hold that key and how many wouldn't fit it, then move them in one `rewrite_properties` op (reason `move_unfit`) that undoes as one step.

- `preview_unfit_property_move` / `move_unfit_property_values` (`commands/property_unfit.rs`). `plan_move` is shared by both. The move re-plans inside `BEGIN IMMEDIATE` and, like Remove and Convert, refuses an acknowledgement the vault has moved past (`UnacknowledgedPropertyLoss`). Per block it writes the removal under the source key first, then the write under the target. Nothing to move appends no op.
- **Occupied is checked before fit.** A block that already holds the target counts as `occupied` even when its value wouldn't fit there, so `unfit_there` counts only blocks the move could have written. Both the Rust test and the conformance fixture pin this: the fixture ends with a `set_property` whose value wouldn't fit, on a block that holds the target, so the mock went red when flipped to fit-first.
- The target is written in its own slot, as `fitted` reads the value under the target's type, not as the raw value.
- UI: `MoveUnfitValues.tsx`; the button hides when no key qualifies. History labels the op `source → target`, and `moveLabel` reads the second write (`valuesKey(values, at)`). The review footer wraps, so five actions no longer clip Cancel.

**Review.** The first review was interrupted. A second one found no defect in the command, undo/redo, mock, UI or docs. It simplified `moveLabel`, dropping a dead `Array.isArray` guard flagged by CI's mutation report. It pinned the occupied-before-fit rule in the fixture and fixed two doc comments. While re-authoring the fixture, the update run reordered four unrelated fixtures; those were restored from HEAD.

**Reds re-run on a quiet container**, each at the predicted assertion with the code restored on exit:

- the empty-plan early return removed: "no op to undo";
- the two writes swapped: the `writes(&payload) == want` check;
- the occupied branch dropped: `counts(4, 1, 0)`;
- the acknowledgement check dropped: the stale-acknowledgement test.

Fit-first in Rust reddens `a_block_holding_the_target_counts_as_holding_it_even_if_its_value_doesnt_fit_6206` at `counts(1, 1, 3)`. Writing the raw value instead of `fit` reddens `a_text_moves_into_the_slot_of_the_key_that_reads_it_6206` only at its engine assertion: the SQL write path puts a raw text into the column its key reads, so the `block_properties` checks pass either way, and the doc holding `Bool(true)` is what pins `fit`.

**Flakes checked.** `PageModeEditor.test.tsx`'s date-picker chip test and `markdown-reveal.property.test.ts` both pass when run alone (the first three times, then its whole file). Their failures in the review container came from load.

**Suites:** the 56 `#6206` nextest tests across the workspace and `conformance_fixtures_match_backend` (non-update), on a quiet container; in the review container, typecheck, lint, the targeted and conformance vitest files, `e2e/property-unfit-values.spec.ts` and half the vitest shards. The full Rust suite and clippy are CI's.
