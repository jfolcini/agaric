# PEND-58f — Search-view deep-review findings (post-verification)

Branch: `pend-58f-search-view-hardening` (extends PR #48 / PEND-58, separate PR).
Scope: the full **search view** — FTS/SQL layer, backend command/IPC, the client
search-query DSL, the SearchPanel/SearchSheet UI tree, stores/hooks, docs, and
e2e/test coverage.

## Method

Read-only deep review by **7 specialist subagents** (SQL/FTS, backend Rust/IPC,
frontend components/state, search-query DSL, product/UX+a11y, dedicated e2e
coverage auditor, docs), each required to cite `file:line` and quote real code.
Then an **anti-hallucination round of 3 verifier subagents** independently
re-opened every cited location, traced data flow, and ran reference/grep checks
for all "dead code" / "no coverage" claims.

## Verification ledger

| Domain | Findings | Confirmed | Exaggerated | False | Uncertain |
|---|---|---|---|---|---|
| SQL/FTS (SQL-1..9) | 9 | 9 | 0 | 0 | 0 |
| Backend (BE-1..10) | 10 | 10 | 0 | 0 | 0 |
| Frontend (FE-1..16) | 16 | 15 | 1 (FE-16) | 0 | 0 |
| DSL (DSL-1..11) | 11 | 9 | 2 (DSL-1, DSL-11) | 0 | 0 |
| UX (UX-1..16) | 16 | 14 | 1 (UX-16) | 0 | 1 (UX-6) |
| Docs (DOC-1..11) | 11 | 10 | 0 | 1 (DOC-5) | 0 |
| E2E gaps (E2E-1..10) | 10 | 10 | 0 | 0 | 0 |
| **Total** | **83** | **77** | **4** | **1** | **1** |

**Dropped after verification:**

- **DOC-5 (FALSE)** — claimed the `+ Filter` button renders no `▾`; the verifier
  found `FilterHelperPopover.tsx:96-98` renders a separate `aria-hidden` `▾` span.
  Doc/UI actually match.
- **UX-16 (non-issue)** — the `aria-expanded`/`aria-controls` gates are mutually
  exclusive; the claimed mismatch can't occur in current code. Informational only.

**Severity corrected:**

- **DSL-1 High→Medium** — the cited single-stray-quote example does NOT reproduce
  (`indexOf` returns -1, quote degrades to a word, `path:` survives). The real bug
  needs an interior **quote pair** spanning a filter (`hello "world tag:#x more"`),
  which silently swallows the filter token. Real, narrower than stated.
- **DSL-11** — keep Medium but drop the "no two-due-token test" item (that test
  exists at `to-search-filter.test.ts:94`); narrow the brace-cap item to "no test
  at exactly 64".
- **E2E-1 Critical→High** — the toggle pipeline works and is component-tested; only
  the real-backend e2e layer is missing. Still the highest-value e2e gap.
- **FE-16** stays Low — premise right (positional focus index) but the symptom is
  mis-described: `useListKeyboardNavigation` resets `focusedIndex` to 0 on any
  count change, so Load-More snaps focus to row 0 (it doesn't silently drift).
- **UX-6 (uncertain)** — slow-search escalation is genuinely absent, but severity
  depends on unmeasured regex wall-times; left as a measure-first item.

---

## Cross-cutting clusters (fix once, resolves several)

1. **SearchHelpDialog is dead + stale** → UX-1, UX-3, UX-12, DOC-4, E2E-7.
   The component is never imported/rendered, there's no `?` button, its body is
   hardcoded English, and its content is stale ("prop: matches value_text only"
   contradicts the live 4-column SQL). Docs/toast promise a `?` help that doesn't
   exist. Decision needed: **wire it up + fix content + i18n**, or **delete it +
   fix the docs/toast that reference it.**
2. **`limit_plus_one_capped` at the 100-result boundary** → SQL-3 + BE-2. One
   helper, two lenses: `has_more` can never be true at the cap, and the partitioned
   command silently caps instead of rejecting (diverging from the cursor path's
   "reject, don't truncate" contract).
3. **Dead `SearchProjection` primitive machinery** → BE-1 + BE-5. The
   `compile_*` stubs emit `1=1` SQL never executed on the live search path; one even
   binds an unused param; `SnippetSpec` is unvalidated. Either finish PEND-58
   Phase 2 wiring or gate behind a clear not-yet-wired banner.
4. **Regex-cap metric table duplicated 4×** → DOC-6 + DOC-7 (+ SearchHelpDialog +
   the constants). Violates the project no-hardcoded-counts rule.
5. **Search request lifecycle** → FE-1 + FE-2 + FE-4. No id-bump on disable, no IPC
   abort, no nav generation guard — three facets of the same "in-flight request
   isn't owned" problem.

---

## Findings — Correctness / data bugs

- **SQL-1 (High)** `fts/search.rs:506-509,627-629` + `toggle_filter.rs:547-550`.
  Duplicate tag IDs make the "ALL tags" filter compare `COUNT(DISTINCT tag_id)`
  against the raw list length → **silently returns zero rows**. `filter.tag_ids`
  has no dedup anywhere (FTS path *and* regex path). Fix: dedupe before binding the
  count.
- **FE-1 (High)** `SearchPanel.tsx:502-514` + `usePaginatedQuery.ts:82-144`.
  Clearing the input while a `searchBlocks` request is in flight repopulates the
  cleared list: `enabled=false` skips `load()`, so `requestIdRef` never bumps and
  the stale response wins. Fix: bump the request id unconditionally when `enabled`
  flips false.
- **DSL-5 (Medium)** `to-search-filter.ts:90-97`. Two `due:`/`scheduled:` tokens →
  both chips render but only the last reaches the backend. Visible chips disagree
  with the effective query. Fix: compose a range, or drop/flag shadowed tokens.
- **DSL-2 (Medium)** `autocomplete.ts:68-85`. `tag:foo#bar` returns null from the
  anchor detector (kills autocomplete) yet the classifier accepts it as a valid
  tag — parse and autocomplete disagree. Fix: strip prefix then a single leading
  `#`; drop the `!includes('#')` guard.
- **DSL-1 (Medium, corrected)** `tokenize.ts:46-57`. An interior quote **pair**
  spanning a filter swallows the structured token into a phantom phrase (chip
  vanishes, glob falls into free-text). Fix: require close-quote at a token
  boundary, or surface an "unterminated quote" chip. Add the multi-quote test.
- **DSL-10 (Low; Medium defensible)** `registry.ts:83-90` + `classify.ts:60-69`.
  A pasted URL `http://example.com` matches the unknown-prefix regex (`key='http'`),
  becomes an invalid chip, and is **stripped from free-text** → URL silently lost.
  Fix: don't treat `key:` as a prefix when followed by `//`.
- **FE-4 (Medium)** `SearchPanel.tsx:780-811`. `handleResultClick` only blocks a
  repeat click on the *same* row; clicking a different row mid-flight races two
  navigations and clears the wrong spinner. Fix: nav generation ref.
- **SQL-5 (Medium)** `toggle_filter.rs:511-517,657-666`. Regex mode scans **raw
  `blocks.content`** while FTS matches the stripped/reference-resolved/NFC text:
  a regex on a tag/page name misses `#[ULID]` tokens; regex can match raw markdown;
  NFC/NFD mismatch. Surprising, undocumented divergence. Fix: decide+document one
  contract (run regex on stripped text, NFC-normalise the pattern).
- **SQL-3 (Medium)** `fts/search.rs:949-954`. Partitioned `has_more` is always
  false at the 100-result cap (`limit_plus_one_capped(100)=100`); the single-
  partition path adds +1 after capping (→101) and survives — the two disagree.
  A test enshrines the buggy behaviour. Fix: cap the page limit, then fetch +1.
- **SQL-8 (Low)** `toggle_filter.rs:629-637`. Regex search SQL-fetches at most the
  newest 1000 filtered blocks then post-filters in Rust, and **always** returns
  `has_more:false` — older matches silently invisible with no truncation signal.
  Fix: surface a truncation flag when the pre-filter returns exactly the cap.
- **FE-6 (Low)** `SearchPanel.tsx:876-878`. "Clear all filters" reads
  `debouncedAst.freeText` (last commit) not live `query`, dropping just-typed text.
- **FE-5 (Low)** `SearchPanel.tsx:263-302`. `tagNameMap` keys on lowercased name
  with no space dimension and is never invalidated → cross-space tag-id collision
  if the panel doesn't remount on space switch.
- **SQL-6 (Low, latent)** `metadata_filter.rs:595-603`. `NOT IN (…, NULL)` 3-valued
  trap; unreachable today (null sentinel split out first). Defensive filter only.
- **DSL-3 (Medium)** `register.ts:181-198` vs `metadata_filter.rs:187`. `state:NONE`
  works (backend case-insensitive) but `due:NONE` is rejected (FE lowercase-only) —
  inconsistent `none` handling.

## Findings — Performance

- **FE-2 (Medium)** `tauri.ts:703-775`. `searchBlocks` takes no abort signal despite
  existing `withAbort`/`isCancellation` plumbing; fast typing runs every backend
  scan to completion. Fix: thread an `AbortController` through `usePaginatedQuery`.
- **FE-10 (Medium)** `SearchPanel.tsx:764-778`. `setCaretPos` fires on every
  keyup/click/select/focus and re-renders the entire 1069-line panel; caret state is
  only needed by the autocomplete subtree. Fix: move caret state into the popover.
- **FE-3 (Medium)** `SearchResultGroups.tsx:105-147`. Results list isn't virtualized
  (up to the 5000-item cap renders eagerly) while `@tanstack/react-virtual` is
  already used elsewhere in the repo. Fix: virtualize the flat `visibleRows`.
- **SQL-2 (Medium)** `fts/search.rs:545-551` + migration 0068. Page-glob filter
  `LOWER(pc.title) GLOB '*x*'` can't use the `title COLLATE NOCASE` index (expression
  mismatch + GLOB + leading wildcard) → full scan of `pages_cache` per pattern; the
  migration comment claiming index usage is wrong. Fix: `LIKE ? ESCAPE` or an
  expression index; at minimum fix the comment.
- **FE-11 (Low)** `SearchPanel.tsx:442-478`. `batchResolve` re-fires for the entire
  accumulated result set on every Load-More. Fix: diff against already-resolved ids.
- **FE-12 (Low)** `useAliasResolution.ts:52-99`. `resolvePageByAlias` re-fires on
  every `results` identity change. Fix: resolve on `[trimmed, spaceId]` only.
- **BE-7 (Low)** `queries.rs:818-826`. Cursor `search_blocks` has no cancellation
  while `search_blocks_partitioned` does — asymmetric wasted work.
- **BE-10 (Low)** `queries.rs:1038-1057`. Partitioned spawned task is detached, not
  aborted, on wrapper-drop (runs to next checkpoint, holding a read connection); the
  `is_cancelled()` arm is effectively dead (await-not-abort).

## Findings — Robustness / validation / maintainability (backend)

- **BE-1 (Medium)** `filters/primitive.rs:752-808`. `SearchProjection`/`compile_*`
  are dead code on the live path; stubs emit `1=1` SQL and one binds an unused param.
- **BE-2 (Medium)** `queries.rs:1012-1019`. `search_blocks_partitioned` silently caps
  `page_limit`/`block_limit` to 100 instead of rejecting (cursor path rejects).
- **BE-3 (Medium)** `queries.rs:467-491,933-948`. Filter marshalling duplicated
  "bug-for-bug" across the two inner fns. Fix: extract `prepare_search_filter`.
- **BE-6 (Medium)** No command-layer test covers `search_blocks_partitioned_inner`
  (has_more probe, block_type drop, fail-fast, cancellation envelope).
- **SQL-4 (Medium)** `fts/search.rs:164-214`. No length cap on the FTS query string
  (regex path caps at 1 KiB). Fix: add `MAX_QUERY_LEN`, reject over-long up front.
- **BE-4 (Low)** `queries.rs:875-877`. `block_type_filter` silently dropped by the
  partitioned command — per-endpoint semantics on one shared wire type.
- **BE-5 (Low)** `primitive.rs:163-167`. `SnippetSpec.max_tokens`/markers unbounded
  and unvalidated (latent until Phase 2 wiring).
- **BE-8 (Low)** `queries.rs:223-231`. Empty `prop:` key isn't rejected (the
  dedicated property command does) → silent no-match clause.
- **BE-9 (Low)** `queries.rs:260-265`. `space_id: Some("")` = "match nothing" is a
  space-isolation invariant enforced only in SQL; add a command-layer regression.
- **FE-14 (Low)** `SearchPanel.tsx:213-216` + `search-history.ts:79`. Persisted
  toggles/history hydrated with no validation (`as` cast). Fix: coerce on read.
- **FE-13 (Low)** `SearchHistoryDropdown.tsx:88-92`. `key={entry}` couples view
  correctness to the store's case-sensitive dedup; the aria id is index-based.
- **FE-8 (Low)** `useSearchSheetStore.ts:65-67`. `setQuery` action is dead; the
  bridge writes via `setState` — two write paths.
- **FE-9 (Medium)** `SearchPanel.tsx` is a ~1069-line god component (autocomplete +
  tag-resolution + combobox-ARIA state machines inline). Fix: extract hooks.
- **SQL-7 (Low)** `fts/search.rs:27,38`. Timing thresholds documented as "measured"
  but are round design figures (log-only). Soften wording / derive from bench.
- **SQL-9 (Low)** `fts/search.rs:475-476`. Cursor rank epsilon `1e-9` couples
  pagination to bm25's numeric scale; document the assumption.
- **FE-7 (Low, no-action)** filter-syntax toast effect — confirmed benign.
- **FE-15 (no-action)** `fold-for-search.ts` is not used by the search surface
  (server-side folding is in Rust); scoping note only.
- **DSL-4/7/8/9 (Low)** free-text whitespace collapse (lossy round-trip);
  glob bracket-content under-validation (FE/BE parity holds); brace-cap ±1 at
  exactly 64; `isIsoDate` stricter than chrono (safe). Mostly document/test.

## Findings — Product / UX / a11y

- **UX-1 (High)** SearchHelpDialog dead code — entire filter/regex/syntax reference
  unreachable; no `?` button in the header.
- **UX-2 (High)** `SearchStatusRegion.tsx:36-45` + `SearchPanel.tsx:1014`. Generic
  (non-regex) search errors render a **blank panel** — no EmptyState, no inline
  error, no aria-live announcement (toast-only). Fix: error branch + visible state.
- **UX-3 (High)** `SearchHelpDialog.tsx:53-307`. Dialog body 100% hardcoded English
  (only the title uses `t()`). (Tied to UX-1.)
- **UX-7 (Medium)** placeholder/hint promise "3+ chars" but search fires at 1 char.
  Align copy with the gate (or the gate with the copy).
- **UX-4 (Medium)** `usePaginatedQuery` exposes `capped` but SearchPanel never reads
  it — the 5000-item cap is hit silently. Fix: "refine your search" notice.
- **UX-14 (Medium)** `SearchSheet.tsx:38-39`. Mobile "all pages" renders the command
  palette, not SearchPanel — toggles/chips/history/grouping unavailable on touch.
- **UX-11 (Medium)** `search-history.ts:48-82`. Queries persisted verbatim; only an
  all-or-nothing per-space clear. Consider a disable setting / per-row delete.
- **UX-5 (Medium)** loading isn't announced to screen readers (live region silent
  by design); add a polite "Searching…".
- **UX-8 (Medium)** recent-pages list and the alias-match card sit outside the
  results roving-listbox a11y model.
- **UX-15 (Medium)** `SearchToggleRow.tsx:99-108`. Active toggle cued only by a
  low-contrast fill + subtle shadow — no non-colour cue (the modes change result
  semantics). Add a ring/border/icon-state.
- **UX-10 (Low)** `FilterChipRow.tsx:69-71` valid-chip `groupAriaLabel` hardcodes
  English `Filter:` (invalid branch is translated).
- **UX-12 (Low)** intro toast says "Press ? for help" — dead CTA (UX-1); re-toasts
  when localStorage is unavailable.
- **UX-9 (Low)** history vs autocomplete have divergent Enter/Tab commit semantics.
- **UX-13 (Low, no-action)** redundant Search button on desktop (taste).
- **UX-6 (Uncertain)** no slow-search escalation / cancel affordance — measure regex
  wall-times before deciding severity.

## Findings — Docs

- **DOC-1 (High)** `architecture/search.md:33`. Snippet window stated "64-96"; code
  ships `32` (`fts/search.rs:460`). Replace with a qualitative description + point to
  the constant.
- **DOC-4 (High)** `SEARCH.md:12`. Claims the `?` help mirrors the doc, but the help
  is unreachable (UX-1) and its `prop:` text is stale vs the live 4-column SQL.
- **DOC-2 (Medium)** `architecture/search.md:74`. "four arguments" then lists five;
  signature has five.
- **DOC-3 (Medium)** `architecture/search.md:53-69`. Canonical `SearchBlockRow`
  excerpt omits the shipped `match_offsets` field.
- **DOC-6 / DOC-7 (Medium)** regex-cap metric table duplicated in
  `architecture/search.md:143-149`, `SEARCH.md:257-263` (+ SearchHelpDialog + the
  constants) — 4 hand-synced copies. Violates the no-hardcoded-counts rule.
- **DOC-9 (Low)** future-tense PEND references for already-shipped features.
- **DOC-10 (Low)** `architecture/search.md:125` attributes glob checks to
  `register.ts`; they live in `glob-validate.ts`.
- **DOC-8 (Low)** "3-char minimum" doc treats FE (UTF-16 units) and BE (Unicode
  scalars per word) as one rule.
- **DOC-11 (Low)** `SEARCH.md:222-228` PEND-54 migration archaeology in an evergreen
  guide.

## Findings — E2E / test coverage (dedicated audit)

~70 search features inventoried; **~53 have no e2e coverage**. The DSL parser and
React components are heavily unit/component-tested (vitest); the Playwright layer is
nearly empty (`features-coverage.spec.ts` 1 search test, `autocomplete.spec.ts`
`state:` only, `search-sheet-mobile.spec.ts`). The full feature→coverage matrix is
in the e2e audit (reproduce via the review fleet if needed).

- **E2E-1 (High, was Critical)** toggles (case/word/regex) never exercised against
  the real Rust pipeline — only jsdom payload-flag assertions.
- **E2E-2 (High)** invalid-regex inline error untested at any level (needs the real
  regex compiler).
- **E2E-3 (High)** `FilterHelperPopover` (`+ Filter` builder) has zero tests anywhere.
- **E2E-4 (High)** chip lifecycle (type→chip, remove, clear-all, invalid pill) —
  component-only; SearchPanel wiring untested e2e.
- **E2E-5 (High)** search history (dropdown, ↑/↓ recall, pick, clear) — the
  focus/caret/mousedown interplay is browser-specific and untested e2e.
- **E2E-6 (High)** structured DSL filters (`tag:`/`path:`/`state:`/`due:`/`prop:`/…)
  never driven through the live SQL and asserted against a seeded result set.
- **E2E-7 (Medium)** SearchHelpDialog untested (and unreachable — see UX-1).
- **E2E-8 (Medium)** result click-through, grouping counts, `<mark>` highlight, and
  keyboard nav not exercised e2e.
- **E2E-9 (Low)** alias-match card untested e2e.
- **E2E-10 (Low)** autocomplete dynamic sources (tag IPC, path MRU, prop keys)
  untested e2e (only `state:` covered).

---

## Suggested action order

1. **Silent-wrong-results bugs first:** SQL-1, FE-1, DSL-5, DSL-2, DSL-10, DSL-1,
   FE-4, SQL-3/BE-2.
2. **SearchHelpDialog decision** (wire-up vs delete) — unblocks UX-1/3/12, DOC-4,
   E2E-7 and the dead intro-toast CTA.
3. **UX-2** blank-panel-on-error + **UX-7** char-count copy + **UX-4** result cap.
4. **Performance:** FE-2 (abort), FE-10 (caret re-render), FE-3 (virtualize),
   SQL-2 (glob scan).
5. **Backend cleanup:** BE-1 (dead Projection), BE-3 (dedupe marshalling), SQL-4
   (query length cap), BE-2 validation.
6. **Docs drift + metric tables:** DOC-1, DOC-4, DOC-2/3, DOC-6/7.
7. **E2E suite** (after behaviour is settled): E2E-1..6 as the priority Playwright
   specs, then E2E-7..10.

---

## Remediation status (this branch)

**Done — frontend / DSL / UX** (batches 1–2):

- DSL-1, DSL-2, DSL-3, DSL-4, DSL-5, DSL-10 (+ tests). DSL-7/8/9 = no-action /
  backend-owned (the 64 brace-cap lives in backend brace-expansion).
- FE-1, FE-4, FE-5, FE-6, FE-8, FE-11, FE-12, FE-13, FE-14 (+ tests).
- UX-1/3/12 (SearchHelpDialog wired: `?` button + `?` shortcut + render; headings
  & description i18n'd; stale `prop:` text and hardcoded regex-cap table removed),
  UX-2, UX-4, UX-7, UX-10, UX-11, UX-15 (+ tests).

**Done — docs:** DOC-1, DOC-2, DOC-3, DOC-6, DOC-7, DOC-8, DOC-9, DOC-10, DOC-11.
DOC-4 resolved by the dialog wire-up + content fix (the `?` help is now reachable
and accurate). DOC-5 was FALSE.

**Done — second batch:**

- Pre-push reliability: `scripts/push.sh` (verify-then-push) runs the CI-equivalent
  verification BEFORE git opens the SSH connection, fixing the "Connection closed by
  remote host" failure where the long pre-push hook held the connection until GitHub
  timed it out.
- FE-9 (extracted `useTagResolution` + `useFilterSyntaxIntroToast` hooks).
- UX-3 (full SearchHelpDialog body-prose i18n — 52 keys, `t()`/`<Trans>`), UX-5
  (loading announcement), UX-8 (recent-pages + alias-card a11y), UX-9 (Escape-cancel
  consistency).
- E2E-1, E2E-3..E2E-10 Playwright specs (45+ tests across `e2e/search-*.spec.ts` +
  autocomplete). E2E-2 (invalid-regex inline error) is covered AND its underlying
  bug fixed: SearchPanel no longer passes `onError` (which clobbered the raw IPC
  message), so the inline regex error + the UX-2 visible error state both work.

**Deferred (correctness unaffected; each warrants its own focused change):**

- FE-2 (abort signal — cross-cutting IPC/hook/component plumbing), FE-3 (virtualize
  the result list — rewrites the roving-listbox a11y model; win only at the 5000-item
  cap), FE-10 (move caret state out of the panel). The request-id guard already
  prevents stale results, so these are pure performance/structure work.
- E2E-2 `<mark>` highlight + the literal "real Rust pipeline" assertions: not
  reachable on the web+mock harness (mock returns no snippet/match_offsets and no
  real regex compiler); covered at the unit layer.

**Backend (SQL/BE):** see the `search(backend)` commit on this branch.
