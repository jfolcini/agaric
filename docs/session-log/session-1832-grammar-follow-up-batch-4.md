# Session 1832 — follow-up batch 4: /repeat remove, picker fallbacks, planning lines (#5160)

Bugs found while building #5160, plus the review notes on Phases 3b, 4a and 4b that were small enough to fix now.

**What changed.**
- **`/repeat remove` works against the real backend.** `delete_property` refused every built-in key that isn't a column, including the recurrence rule, so the slash command failed with "Failed to remove repeat". The mock had no such guard, which is why no test caught it.
  - It now refuses only the keys that state transitions and recurrence write: `created_at`, `completed_at`, `repeat-seq`, `repeat-origin`.
  - The mock refuses the same four, pinned by a new conformance fixture.
  - An e2e-tauri spec drives `/repeat remove` through the real backend.
  - Clearing or renaming a `repeat-until` / `repeat-count` chip in the property editor failed the same way. It now goes to `delete_property`.
- **Picker fallbacks put back what was typed.** When a lookup fails, the `[[…]]` and `#[…]` input rules re-insert the typed token, brackets and label included, instead of the bare name.
  - Two pages with the same exact title are a tie, not whichever came first.
  - An anchor after a `|` title labels the chip with the text after the last `|`.
  - The mock leaves an anchored token whose whole title ties as text, as the backend does.
- **Export.**
  - A tag or page link after an odd run of backslashes is kept as its raw ref, so it reads back as the ref instead of as escaped text.
  - A relative `.md` link that climbs out of the vault is not a link.
- **Planning lines (Logseq/Org).**
  - A second line with a different repeater stays text.
  - A keyword with no `<…>` timestamp after it is prose, and gives no warning.
  - The `\SCHEDULED:` escape is Export/Import only, so Edit as Markdown and the clipboard show the text as typed.
- **Editor grammar.**
  - A line of only `#`…`######` is an empty heading in the editor too, and the serializer escapes a paragraph that is only a `#` run.
  - An HTML-only paste into a table cell or list item inserts its text.
  - An HTML-pasted `- [ ] task` spliced after text keeps its `- `.
- **Deleted.** Dead picker code, a `catch` whose only reason was a test double, and a duplicated label regex (one reader now). The fixpoint property also generates tabs.

**Review.** An independent reviewer ran the full suite and broke the claims on copies: 13 Rust and 11 TS mutations, each caught except one (below). It found no blocking defect. The three gaps above that the builder had left (the chip clear, the `#[…]` fallback, the page link after a backslash) were confirmed and fixed, each shown red first.

**Worth knowing:**
- `/repeat remove` deletes `repeat` only. `repeat-until` and `repeat-count` stay as visible chips and do nothing without `repeat`.
- The hidden `repeat-seq` also stays. If a count limit is added later, it counts the earlier occurrences.
- The property drawer and the page property table still show no remove button for `repeat-until` and `repeat-count`.
- A block whose whole content is a bare `#` run now renders as an empty heading, which is what the backend already read it as. The stored text is unchanged.
- The fixpoint property rarely generates the `#<tab>` case even with tabs in its alphabet: a serializer that stops escaping it passes at 5000 runs. The unit test is what catches it.

**Verified.**
- `cargo nextest run --workspace`: 6616 passed. Doc-tests: 10 passed. clippy and fmt are clean.
- The four `sqlx prepare --check` lanes pass, and `ts_bindings_up_to_date` passes.
- vitest: 19617 passed across 853 files.
- The typechecks (app, wdio) are clean.
- Playwright: 172 passed across 21 property, slash-command, paste, link, Source and import/export specs.
- The e2e-tauri spec typechecks; CI runs it.
