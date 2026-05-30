## Session 913 — #213 PR 2 (part): block-ref picker "type 2 chars" empty-state (2026-05-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-30 |
| **Subagents** | orchestrator-direct build + 1 review |
| **Items closed** | — (partial: #213 PR 2 empty-state half) |
| **Items modified** | #213 |
| **Tests added** | +2 (below-threshold hint / at-threshold no-match) |
| **Files touched** | 3 |

**Summary:** Shipped the empty-state half of #213 PR 2. The block-ref picker's `searchBlockRefs` returns `[]` for queries under 2 chars (`if (q.length < 2) return []`), so the picker showed "No results — block references can only point at existing blocks" — reading as "broken" rather than "keep typing". `SuggestionList` now receives the live `query` (already in the suggestion-renderer props bag) and, for the `((` trigger below the 2-char threshold, shows a "Type at least 2 characters to search" hint instead. Scoped to `((` only — the page picker `[[` has no <2 gate (it uses the preloaded cache for short queries).

**Files touched (this session):**
- `src/editor/SuggestionList.tsx` (+`query?` prop; below-threshold branch in the empty-state, mirroring the resolver's `replace(/\)+$/,'').trim()` normalization)
- `src/lib/i18n/editor.ts` (+`suggestion.hint.minChars`)
- `src/editor/__tests__/SuggestionList.test.tsx` (+2 tests: below-threshold → hint incl. the `a))` strip; at-threshold → no-match message)

**Verification:**
- `npx vitest run SuggestionList.test.tsx` — 49 pass. tsc clean, oxlint clean.
- No renderer change needed: `query` already flows via the `{ ...props }` spread (onStart) and `updateProps(props)` merge (onUpdate).

**Process notes:**
- **Split PR 2**: shipped only the empty-state half. The **alias-badge half was deferred** — the alias text is baked into the picker-item label (`mergeAliasPrefixMatches`), and that label feeds create-new suppression (`foldForSearch(p.label) === qFolded`, useBlockResolve.ts:235), so moving it to a badge is not purely cosmetic. Flagged on #213 with two options for the maintainer to choose.

**Commit plan:** single commit / pushed.
