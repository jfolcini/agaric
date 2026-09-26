# Session 1831 — properties: refused values, key spelling, recurrence (#5160 Phase 4b)

Phase 4b of #5160: decisions D11 (a refused value stays text) and D13 (keys fold), plus P4 (recurrence lines) and P7 (a value-less line clears).

**What changed.**
- **Recurrence (P4).** Source, clipboard, Duplicate and export show and read back `repeat`, `repeat-until` and `repeat-count`, so a duplicated or copied repeating task keeps repeating. `repeat-seq` and `repeat-origin` stay hidden. A rule the engine cannot read refuses the save, because the Source path writes below the command that would validate it.
- **Clearing (P7).** In Edit as Markdown, `key::` and `key:: ` both delete the property; no raw error code reaches the user and the block keeps its anchor. On import and paste, a value-less line stays text. `::` followed by a tab is a property line in the editor too.
- **Key spelling (D13).** Case, `-` and `_` fold for reserved keys and existing definitions, and the canonical key is stored. There are no aliases. A key that folds to two definitions stays as typed.
- **Refused values (D11).** Import and paste keep a refused `key:: value` line as text in its block, with one warning naming it, instead of aborting the file.
  - A refused checkbox, task keyword or `[#C]` cookie stays in front of the text. This covers Phase 4a's task syntax when the user has narrowed the options.
  - Paste warnings now reach the user: `paste_blocks` returns them.
  - Edit as Markdown still refuses the save and names the line.
  - A ref value accepts a live block id in the same space, `[[Title]]` or a plain title, never guessing a tie.

**Review.** An independent reviewer ran the full suite and broke every claim on copies (33 Rust and 9 TS mutations).
- **One data-loss defect, fixed and shown red first.** Edit as Markdown folded the buffer's keys but not the base's, so a save on any block rewrote keys the user never touched. One case refused the save over a line the user didn't write. Another overwrote a `due_date` with a legacy `due-date` row and deleted the row. A key the block already holds as written now keeps its spelling.
- **Tests added** for three claims that nothing covered: the repeat-rule check, the cross-space ref check and the fold tie rule.
- **Pre-existing bug, confirmed, not fixed here:** `/repeat remove` calls `delete_property` on a built-in key, which the backend refuses, so the slash command fails in the real app (the mock accepts it). It is next in the follow-up batch. Until then, deleting the `repeat::` line in Edit as Markdown removes the rule.
- **Worth knowing:**
  - A typed `word::` for a key the block doesn't hold vanishes from the text in Source without a warning.
  - The Source refusal names the folded key.
  - Legacy custom rows whose key folds to a reserved key (`Template`, `Created-At`) now read back as text.

**Verified.**
- `cargo nextest run --workspace`: 6592 passed.
- Doc-tests: 10 passed. clippy and fmt are clean.
- The four `sqlx prepare --check` lanes pass, and `ts_bindings_up_to_date` passes.
- vitest: 19551 passed across 853 files.
- The three typechecks are clean.
- Playwright: 281 passed across 26 property, paste, duplicate, Source, slash-command and toolbar specs.
- The e2e-tauri spec (Duplicate a repeating task through the real backend) typechecks; CI runs it.
- After the rebase onto #5175:
  - One test literal from #5175 needed 4b's new `task_markers` field.
  - Then clippy was clean, and 2294 targeted nextest tests passed, including the conformance oracle and `ts_bindings_up_to_date`.
  - vitest: 4582 tests passed across the mock, the conformance suite, the picker and page-blocks.
  - Both typechecks are clean.
