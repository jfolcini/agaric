# Session 3353 — review notes from #6295

#6295 keeps a picker's previous rows on screen while the next fetch runs. Its reviewer left two non-blocking notes.

- **Stale create row.** If Enter lands in that window on the `#`/`@` create row, and the name now typed is exactly an existing tag, the row still created a new tag. `onCreateTag` does not dedupe, so the user got a second tag with the same name. The command now looks the typed name up first, with the folding `use-block-resolve` uses, and links the existing tag. Only a stale row pays that lookup: when the row's name is the typed name, its fetch already checked it.
  - Pinned by a new `at-tag-picker.test.ts` case, red with the lookup removed.
- **Duplicate import.** `suggestion-renderer.ts` imported from `SuggestionList` twice. That is now one import.

Ran: vitest over `at-tag-picker.test.ts` and `suggestion-renderer.test.ts`, `npm run typecheck`, oxlint.
