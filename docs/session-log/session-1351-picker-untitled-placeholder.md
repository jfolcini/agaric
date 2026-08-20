# Session 1351 — picker Untitled placeholder: trim + i18n, without deciding #4152 (2026-08-19)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-19 |
| **Subagents** | orchestrator-only (adversarial review of an existing uncommitted diff) |
| **Items closed** | `#4153` |
| **Items modified** | `#4152` (comment added; left open, not implemented) |
| **Tests added** | +4 (frontend) |
| **Files touched** | 2 |

**Summary:** Reviewed an uncommitted diff in `src/components/block-tree/use-block-resolve.ts`
that claimed to close both #4153 (untranslated, exact-empty `'Untitled'` placeholder) and
#4152 (NULL-content pages unfindable by typing "untitled"). The #4153 portion was sound and
is kept. The #4152 portion inverted a test #4150 deliberately locked in
(`does NOT match a NULL-content page by searching its "Untitled" placeholder text`) on the
strength of the builder's own reading of #4152 — but #4152's own text explicitly frames the
question as "a product call, not a bug" and lists three options "in increasing cost" without
picking one; the issue carries the `idea` label, zero comments, and is still open. The PR that
filed it (#4154) says so explicitly: *"No `Closes #` line: #4152 and #4153 are deliberately
left open — this PR records the decisions, it does not implement them."* No comment thread,
commit, or PR anywhere in the repo shows a maintainer choosing "match the placeholder at
filter/match time" over the other two options. Reverted that half of the diff — restored the
original locked-in test and the raw-title match keys in `searchPagesViaCache` and
`searchPagesViaFts` — and left `#4152` open with the product question still unresolved, matching
the precedent #4154 already set.

**Files touched (this session):**
- `src/components/block-tree/use-block-resolve.ts` (+49/-11 net vs. pre-review diff; kept
  the `untitledOr(title)` helper and its two DISPLAY-site call sites, dropped its use as a
  search-match key)
- `src/components/block-tree/__tests__/use-block-resolve.test.ts` (+151/-0 net vs. base;
  4 new #4153 tests kept, the #4152 test inversion and the new FTS-cache-supplement #4152 test
  reverted/removed)

**What shipped (#4153, both defects fixed):**
1. `untitledOr(title)` — a trimmed (`title.trim() === ''`, not `=== ''`), i18n'd
   (`translate('block.untitled')`, not the hardcoded `'Untitled'` literal) replacement for the
   two ad hoc placeholder checks in `makePagePickerItem` and `mergeAliasPrefixMatches`. A
   whitespace-only page title (`'   '`, `'\n'`) now renders the placeholder instead of a blank,
   unlabelled picker row; a non-English catalog (this app is currently single-locale by design,
   see `src/lib/i18n/index.ts`) would get the localized string instead of English.
2. The two `'Untitled'` literals in `searchBlockRefs` (the `((` block-ref picker) were switched
   to `translate('block.untitled')` for i18n, but deliberately kept their exact-`null` test
   rather than routed through `untitledOr`. This is not an inconsistency: the issue text itself
   scopes the trim fix to `makePagePickerItem` and `mergeAliasPrefixMatches` only, and the
   `((` picker renders BLOCK content (a different surface with its own truncation rules, not a
   page title) — the same distinction #4154 already drew for this file. A whitespace-only block
   would still render blank there; that gap is real but out of scope for #4153 and not filed
   separately, since it is unchanged pre-existing behavior, not something this diff touched.

**What was reverted (#4152, not sanctioned):**
- `searchPagesViaCache`'s `matchSorter` key was changed from `['title']` to
  `[(p) => untitledOr(p.title)]`; reverted to `['title']`.
- `searchPagesViaFts`'s cache-supplement filter was changed from
  `matchesSearchFolded(p.title, q)` to `matchesSearchFolded(untitledOr(p.title), q)`; reverted.
- The test `does NOT match a NULL-content page by searching its "Untitled" placeholder text`
  had been inverted in place (`.not.toContain` → `.toContain`) with a comment claiming #4152
  "answers" the product question. Restored to the original assertion; the inversion comment
  was replaced with one explaining why the reversal isn't sanctioned by #4152's own text.
- A new test asserting the FTS-cache-supplement half of the #4152 match (searching "untitled")
  was removed along with the behavior it tested.
- Left a docblock note on `untitledOr` recording why it isn't used as a match key, so the next
  session doesn't have to re-derive this.

**Other review findings, checked and cleared:**
- i18n completeness: `block.untitled` exists in `src/lib/i18n/block.ts`, the only catalog —
  this is a deliberately single-locale app (`src/lib/i18n/index.ts`: *"Do NOT add new locale
  resources"*), so there is no second-locale gap to check.
- All 4 new #4153 tests were checked for vacuousness by reasoning through the pre-fix
  production code against each assertion (whitespace title → blank label under the old
  `=== ''` check; i18n-override tests → the pre-fix hardcoded `'Untitled'` literal would not
  reflect the override) — each genuinely reddens against the code it replaces.
- `axe(container)` a11y audit: N/A — this file exports a hook (`useBlockResolve`, tested via
  `renderHook`), not a component; nothing here renders DOM.
- Since the #4152 match-key change was reverted, its search-side-effect and #4138 sort-key
  concerns are moot — the stored/sort title and the match key are both still the raw `''`.

**Verification:**
- `npx tsc -b --noEmit` — clean.
- `npx vitest run` — 777 test files, 17639 passed, 1 expected fail (pre-existing STRICT-mode
  negative fixture, same baseline #4150 recorded).

**Lessons learned (for future sessions):** An issue that narrates multiple options "in
increasing cost" and explicitly defers the call to a maintainer is not authorization to pick
one — especially when the specific test being inverted was filed by the same review chain
(#4150 → #4154 → #4152) as the record of a deliberate non-decision. Zero comments + an `idea`
label + a PR that says "records the decisions, it does not implement them" is about as clear a
"not yet decided" signal as this repo produces; treat it as a hold, not a green light.

**Commit plan:** not committed — working tree left as corrected diff for the caller to commit.
