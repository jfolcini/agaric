# Session 2481 — search filter chip edits re-run the search

The #5738 sweep found a Search bug. Four chip actions changed the query text
but never ran the search, so the results stayed stale until Enter:
- adding a chip from *Add filter*;
- removing a chip;
- *Clear all*;
- the zero-results *Clear filters*. It removed the chip but left "No
  results" showing over a matching block.

Results come from `debouncedQuery`. Typing, autocomplete, Enter, a history
pick and the palette handoff set it. The chip handlers, all routed through
`patchQuery`, only set the input text.

**Changed:**
- **`patchQuery`** cancels any pending debounce, clears the typing
  indicator and runs the search at once, as Enter and a history pick do. A
  chip edit is one action, not a keystroke. *Clear all* now goes through
  `patchQuery`, so typed words that were not yet sent are kept.
- **A chip edit that empties the query** clears the results the way
  emptying the input does: no "No results", and "Search cleared" announced.
- **The docs** no longer describe a page picker. Search scopes by page-path
  include and exclude globs, several `path:` chips OR-combine and tag chips
  AND-combine (`docs/features/views.md`, `docs/UI-MAP.md`).
- **The `SearchPanel.tsx` header** no longer names three deleted files or
  a wrong shortcut.

**Spec:** `e2e/search-filter-chips.spec.ts`.
- Two page-path chips scope the results without Enter. Removing one narrows
  them to the other page, and *Clear all* brings back all three.
- The zero-results *Clear filters* brings back the matching hit.

**Shown red:**
- **Both specs and all six new unit tests,** against the unfixed handlers.
- **Each handler reverted alone:** adding a chip, removing one, and *Clear
  all*.
- **Single lines dropped from the fix:**
  - without the debounce cancel, a stale typed search undoes the chip edit;
  - without the cleared state, nothing announces the cleared search.

**Ran:**
- the new spec with `--repeat-each=3`;
- every `e2e/search-*` spec;
- vitest over the Search panel, `src/components/search` and
  `src/lib/search-query`;
- `npm run typecheck`, type-aware oxlint and oxfmt.
