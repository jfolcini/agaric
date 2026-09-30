# Session 1837 — follow-up batch 6: removing a repeat rule clears its bounds (#5160)

The review notes from #5177, #5178 and #5179, 13 items.

**What changed.**
- **Removing `repeat` no longer leaves a born-exhausted rule.**
  - Before: `/repeat remove` deleted only `repeat`, so `repeat-count`, `repeat-until` and the hidden `repeat-seq` stayed. A rule added later was already used up, and completing the task created no next occurrence.
  - Now `delete_property` and a Source save that drops the `repeat::` line also delete whichever of those bounds the block holds, in the same transaction, with one undo. The mock follows.
  - A new e2e-tauri spec re-adds a rule after `/repeat remove` and checks that a third occurrence appears.
- **The drawer and page table offer remove for every key `delete_property` accepts** (`SYSTEM_MANAGED_PROPERTY_KEYS`, mirroring Rust). Removing `repeat` there also clears its bounds from the screen.
- **Anchors and headings.**
  - Anchored names stay in the page id map, so an inline query naming `Issue #42` still remaps to the page.
  - One import reports its dropped link labels in a single warning.
  - A link into the page being written (`[[ThisPage#H]]`) refs its saved heading in paste and Source.
  - The stale "cross-note block anchors are not supported" warning is reworded.
- **Mock drift.**
  - The mock's paste escapes a line-start marker as the backend does (a new `paste_blocks.json` step).
  - Its import counts only the values the backend accepts.
  - `e2e/import-export.spec.ts` imports an undeclared key.
- **Small items.**
  - Dead column-key guards in `BlockPropertyEditor` are deleted.
  - The `((…))` fallback puts back what was typed.
  - The unreachable `.unwrap_or_else` is now an `.expect`.
  - The ULID regex copies import `ULID_RE`.
  - Comments and docs are corrected.
- **The pages-view load-more flake is fixed.** `click()` scrolled the button into view, the scroll auto-loaded, and the button unmounted mid-click. The specs dispatch the click without scrolling: 22 of 80 runs failed before, 80 of 80 pass after.

**Review.** An independent reviewer ran the full suite and broke 11 claims on copies; every mutation was caught. It fixed one defect: removing `repeat` in the drawer or table left `repeat-count` and `repeat-until` on screen until reopened.

It also reverted item 6. Two same-text headings in a file are again resolved to the FIRST occurrence, as Obsidian does, rather than left unresolved. The maintainer chose conventions over compatibility.

**Worth knowing:**
- The cross-page anchor pass still needs exactly one matching heading, where Obsidian takes the first. Aligning it needs a new query (follow-up).
- Undoing `/repeat remove` restores a bound only if it was last set on this device, the general limit on undoing synced values.
- `[[ThisPage#H]]` in Source resolves against the headings saved before the save.

**Verified.**
- `cargo nextest run --workspace`: 6629 passed, 13 skipped. Doc-tests: 10 passed. clippy and fmt are clean. No `.sqlx` change.
- vitest, the full suite: 19624 passed, 51 skipped, 1 expected fail. `npm run typecheck` and `tsc -p tsconfig.wdio.json` are clean.
- Playwright, the full suite: 831 passed, 4 skipped.
- The e2e-tauri spec typechecks; it runs in CI.
