# Session 3803 — Review notes from #6495 and #6497

The follow-up for the reviewer's non-blocking notes on #6497 (versioned derivations and the integrity report) and #6495 (the History phone layout).

## What shipped

- The derivation golden test's message says a pure reformat of the hashed source needs only a new golden, not a version bump: the Agenda and PageLink goldens hash Rust source text, and a bump would rebuild every vault for nothing.
- Rewrapped the `reconciliation_oracle.rs` module docs and the `history-row-cell` comment in `src/index.css`.
- `.history-item-device` drops `text-xs text-muted-foreground`, which it inherits from `.history-item-device-group`.
- In the block History sheet the device label could overflow its row. `BlockHistoryItem` renders `HistoryItemCore` without `history-row-cell`, so the label shares the meta line with the op type and the time. At 320px the 17-character `remove_page_alias` pushed the row 19px past its edge and cut the label mid-character. The device group now shrinks and truncates with an ellipsis.

## Traps

- The device label is `dev:` plus the first eight characters of the id, so it is at most twelve characters. A full UUID swapped into the DOM shows an overflow the app never renders; the op-type badge is what varies. The space-wide op types (`rename_property_option`, `rewrite_properties`) are longer but never reach one block's history.

## Tests

- New `e2e/block-history-sheet.spec.ts` case: at 320px, a stubbed `remove_page_alias` row's content stays inside the row. It failed with an overflow of 17 before the fix.
- `HistoryListItem.test.tsx` 'shows device_id with full opacity' now asserts on the group that carries the colour, since the label inherits it; adding `/60` to the group turns it red.
