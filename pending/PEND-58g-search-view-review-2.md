# PEND-58g — Search-view deep-review findings, round 2 (post-verification)

Branch: `pend-58f-search-view-hardening` (the PEND-58f hardening already landed +
pushed at `cbe9db64`).

**This is the single search-view plan of record.** It supersedes PEND-58f, which
is fully implemented (DSL-1..10, FE-1..14, UX-1..15, SQL-1..9, BE-1..10, DOC-1..11,
the E2E suite, and the FE-2/FE-3/FE-9/FE-10 performance trilogy — all shipped this
session; PEND-58f's only deferred item, the harness-limited `<mark>` e2e, is carried
forward below as E2E-A6). PEND-58f's plan file was deleted per the `pending/`
delete-on-completion convention; all *remaining* search-view work is consolidated
here.

Scope: the full **search view** — FTS/SQL layer, backend command/IPC, the client
search-query DSL, the SearchPanel/SearchSheet UI tree (incl. the new
`<SearchAutocomplete>` extraction + results virtualization), stores/hooks, docs,
and e2e/test coverage.

## Method

Read-only deep review by **7 specialist subagents** (SQL/FTS, backend Rust/IPC,
frontend components/state, search-query DSL, product/UX+a11y, dedicated e2e
coverage auditor, docs), each required to cite `file:line` and quote real code.
Then an **anti-hallucination round of 3 verifier subagents** independently
re-opened every cited location, traced data flow, and ran reference/grep checks
for all "dead code" / "no coverage" / "diverges" claims, classifying each finding
Confirmed / Exaggerated / False / Uncertain.

## Verification ledger

| Domain | Raw | Confirmed | Exaggerated | False | Uncertain / by-design |
|---|---|---|---|---|---|
| SQL/FTS (SQL-A1..6) | 6 | 6 | 0 | 0 | 0 |
| Backend (BE-A1..10) | 7 | 5 | 2 (BE-A2, BE-A8) | 0 | BE-A7 by-design |
| Frontend (FE-A*) | 12 | 9 | 0 | 0 | FE-A4 uncertain; FE-A2/A6 by-design/cosmetic |
| DSL (DSL-A1..8) | 8 | 8 | 0 | 0 | 0 (A7/A8 info-level) |
| UX (UX-A1..13) | 13 | 8 | 2 (UX-A7, UX-A8) | 0 | UX-A10/A12/A13 uncertain |
| E2E (E2E-A1..12) | 12+ | 10 | 0 | 0 | E2E-A6 harness-limited |
| Docs (DOC-A1..10) | 10 | 9 | 0 | 0 | DOC-A10 uncertain |

No hallucinated `file:line` references were found.

**Dropped / down-ranked after verification:**

- **BE-A2 (exaggerated)** — the `space_id: Option<String>` field + `#[serde(default)]`
  (`queries.rs:264-265`) does contradict the "required" doc (`:492`), and `None`
  means unscoped/global in SQL — but no live caller can reach `None`: the MCP
  schema marks it required and the TS wrappers type `spaceId: string`. Defense-in-
  depth gap, not a reachable cross-space leak.
- **BE-A8 (exaggerated)** — SQL-fragment duplication is real for the `space`
  clause (3 sites) but the tag/glob predicates are not uniformly triplicated
  (`filtered_blocks_query_inner` uses a different inheritance-aware EXISTS + a
  `LIKE` glob).
- **UX-A7 (partly false)** — the `FilterHelperPopover` category rows DO have a
  44px coarse-pointer target (`PopoverMenuItem` CVA base). Confirmed only for the
  Clear-all link and the history-row body; the tag-picker list buttons also lack it.
- **UX-A8 (exaggerated)** — toggle meaning is in a touch-inaccessible tooltip, but
  `aria-label`/`title` cover screen readers and the help dialog (touch-reachable)
  explains the modes. Real gap is narrower: no always-visible touch explanation.
- **FE-A2 / FE-A6 / FE-A14 / BE-A7 (real but by-design/cosmetic)** — stale-while-
  revalidate keep-items, virtualizer estimate self-corrects within a frame, the
  `InvalidRegex:` magic-string is a documented convention, the `SearchProjection`
  machinery is intentional not-yet-wired Phase-2 scaffolding.
- **FE-A4 (uncertain)** — a caret-anchor race between an autocomplete apply and a
  concurrent native caret event is theorised but not demonstrated; needs runtime.

---

## Cross-cutting clusters (fix once, resolves several)

1. **Regex mode silently drops ALL structural filters** → DSL-A8 + UX-A4 + DOC-A
   (SEARCH.md). `regexModeFilterParams()` zeroes every filter param when regex is
   on (`SearchPanel.tsx:295-298`), yet the chips still render from the parsed query
   (`:831`) and `docs/SEARCH.md:267,297` claims the filters still apply. Decision
   needed: **apply structural filters in regex mode** (wire them into the regex SQL
   path), or **hide/disable the chip row in regex mode + fix the doc**.
2. **Toggle/regex `has_more` + pagination contract** → SQL-A1 + SQL-A2 + SQL-A3 +
   BE-A1. The case/word post-filter runs after `has_more`/`next_cursor` are set
   (sparse pages, under-fill), the cursor path caps where the partitioned path
   rejects, and the regex partitioned `has_more` is dead at the 100 boundary.
3. **Virtualization vs roving-listbox** → FE-A5 + FE-A7 + FE-A8 (+ FE-A6). The
   per-group scroll containers, the focus-reset-to-0, and the tabbable-group gap
   are all consequences of the PEND-58f FE-3 virtualization meeting the existing
   `useListKeyboardNavigation` model.
4. **FilterHelperPopover is the weak surface** → UX-A3 + UX-A5 + UX-A6 + FE-A20 +
   UX-A7. Hardcoded English, only tag/path categories, non-combobox tag picker, a
   race-prone tag fetch, and small touch targets.

---

## Findings — Correctness / data bugs

- **FE-A5 (High)** `search/VirtualizedResultListbox.tsx:96,86-87` + `SearchResultGroups.tsx:103-107`.
  Each expanded group is its own `overflow-y-auto` container and `scrollToIndex`
  only scrolls within the focused group; there is no page-level `scrollIntoView`,
  so cross-group keyboard roving can put `aria-activedescendant` on a row below the
  fold. Fix: virtualize against the window/outer scroller, or add a page-level
  `scrollIntoView({block:'nearest'})` on the active row.
- **UX-A1 (High)** `SearchSheet.tsx:178`. Mobile "all pages" renders the command
  palette, not `SearchPanel`; toggles/filters/regex/history/help are only reachable
  by escalating to the full view. Fix: route all-pages to `SearchPanel`, or surface
  the toggle row + help in the sheet.
- **DSL-A8 / UX-A4 (High, cluster 1)** regex mode drops structural filters silently
  while chips still render (`SearchPanel.tsx:125-139,295-298,831`).
- **SQL-A1 (Medium)** `fts/search.rs:343` vs `commands/queries.rs:988-993`. Cursor
  search silently caps `limit→100`; partitioned rejects over-cap. `PageRequest`
  allows ≤200, so 101–200 is reachable. Align: reject (mirror BE-2) or document.
- **SQL-A3 / BE-A1 (Medium)** `fts/toggle_filter.rs:196,340`. The case/word
  post-filter runs after `has_more`/`next_cursor` are computed, so pages render
  sparse/empty with `has_more=true`; the partitioned path can't paginate
  (`next_cursor: None`) so the dropped rows are unrecoverable (under-fill). Fix:
  post-filter a larger candidate window, then truncate + derive `has_more`.
- **SQL-A2 (Medium)** `fts/toggle_filter.rs:257-258` vs `:556,291`. Regex
  partitioned `has_more` can never be true at exactly `limit==100` (probe clamped).
- **FE-A8 (Medium)** `hooks/useListKeyboardNavigation.ts:173-175`. `focusedIndex`
  resets to 0 on any `itemCount` change → group collapse / Load-More snaps focus to
  row 0. Fix: reset only on query change; clamp instead of forcing 0.
- **FE-A7 (Medium)** `search/SearchResultGroups.tsx:164`. When `focusedRow` is
  undefined (post-collapse window) no group is `tabIndex=0` → results region not
  tabbable. Fix: fall back to first group when `focusedRow` is undefined.
- **FE-A13 (Medium)** `SearchPanel.tsx:498` vs `:791`. History-disabled + empty:
  dropdown visible but input `aria-expanded=false` / no `aria-controls`. Fix: share
  one `historyDropdownVisible` predicate.
- **DSL-A1 (Medium)** `lib/search-query/classify.ts:99`. The trailing
  `.replace(/\s+/g,' ')` collapses whitespace inside surviving quoted phrases,
  breaking the "verbatim phrase" contract. Fix: collapse only outside quoted spans.
- **UX-A2 (Medium, a11y)** `SearchPanel/SearchStatusRegion.tsx:46-48`. Invalid
  regex double-announces (generic "Search failed" in the status live region AND the
  specific regex message in the header alert). Fix: suppress the status branch when
  `regexError != null`.

## Findings — Performance / robustness (backend)

- **BE-A4 (Medium)** `fts/toggle_filter.rs:241-304,482`. Regex-mode partitioned
  path ignores the cancellation token (FTS path honors it). Add an early
  `is_cancelled()` + a `select!` around the regex `fetch_all`.
- **SQL-A4 (Low)** `fts/toggle_filter.rs:524` vs `:385`. Regex path NFC-normalises
  the full raw query before the `MAX_PATTERN_LEN` check — add an up-front raw-length
  guard mirroring the FTS `MAX_QUERY_LEN`.
- **SQL-A6 (Low, latent)** `fts/search.rs:550-553` + `toggle_filter.rs:584-587`.
  Tag-id dedup is byte-exact (`HashSet<String>`); a mixed-case ULID duplicate could
  re-break the `COUNT(DISTINCT)=len` ALL-tags predicate. Normalise to canonical ULID
  or document the precondition.
- **BE-A5 (Low)** `commands/queries.rs:1100-1111`. The detached partitioned task
  holds a read-pool connection until its next cancel checkpoint (≤200ms). Bounded;
  note only if pool saturation is observed.
- **SQL-A5 (Low)** `fts/toggle_filter.rs:556-557`. Dead `let _ = limit;` + stale
  comment (`limit` is used at `:744`). Delete.
- **FE-A20 (Medium)** `search/FilterHelperPopover.tsx:62-70`. The popover tag fetch
  has no debounce/race guard (the other two `listTagsByPrefix` callers do) →
  out-of-order responses can show stale suggestions. Consolidate behind one cached
  source.

## Findings — Maintainability

- **FE-A18 (Medium)** `SearchPanel.tsx` is still 973 lines. Continue FE-9: extract
  `useSearchResults` (queryFn + usePaginatedQuery + pageTitles + groups + nav) and
  `useSearchHistoryControls`; move the filter-param projection to its own module.
- **BE-A7 (Low, by-design)** `filters/primitive.rs:796-881`. `SearchProjection` /
  `compile_*` are dead at runtime (1=1 placeholders) — intentional Phase-2
  scaffolding, behind a clear banner. Either finish the wiring or keep the banner.
- **FE-A12 (Low)** `SearchPanel.tsx:726,736` re-`parse(query)` instead of reusing
  the `ast` memo. **FE-A19 (Low)** mixed `t`-prop vs `useTranslation()` across the
  search subtree. **DSL-A3/A4/A6/A7 (Low/info)** brace-truncate-vs-error (test-only
  caller), no NFC on tag-name matching, `isInsideQuote` model drift, one dead
  `tag:#` arm.

## Findings — Product / UX / a11y

- **UX-A3 (Medium)** `FilterHelperPopover.tsx:162,191,194` — hardcoded English
  ("Back"/"Back"/"Add"). **UX-A5 (Medium)** the `+ Filter` builder only offers
  tag/path; the other six filter types are syntax-only. **UX-A6 (Medium, a11y)**
  the popover tag picker is a plain input + `<ul>` of buttons, not a
  combobox/listbox with arrow nav.
- **UX-A9 (Low)** `help/SearchHelpDialog.tsx:168,173,178` — help "Icon" column
  shows `Aa`/`Ab|`/`.*` text but the toolbar renders lucide icons.
- **UX-A11 (Low)** `SearchPanel.tsx:844-847` — the min-char hint uses alert-warning
  styling though search still runs at 1–2 chars; soften to info.
- **UX-A7 (Low)** Clear-all link + history-row body lack coarse-pointer 44px
  targets (the category rows already have them). **UX-A8 (Low)** add an always-
  visible/long-press toggle-mode explanation for touch.
- **UX-A10 / UX-A12 / UX-A13 (uncertain)** history dropdown in normal flow vs
  overlaid; capped + error co-render; RTL physical spacing — verify at runtime.

## Findings — Docs

- **DOC-A1 (Medium)** `architecture/search.md:56-76` — `SearchBlockRow` excerpt uses
  fabricated `Option<ActiveBlockId>` / `i32` types + a false "inherited from
  ActiveBlockRow" framing; actual (`queries.rs:400-431`) is standalone `String`/`i64`.
- **DOC-A2 (Low-Med)** `architecture/search.md:46-53` — `SearchFilter` excerpt uses
  `ActiveBlockId`; actual is `String`/`Vec<String>`.
- **DOC-A3 (Medium)** `architecture/search.md:146` + `SEARCH.md:267` — hardcoded
  `1000` (REGEX_PRE_FILTER_CAP) violates the docs' own no-hardcoded-counts rule.
- **DOC-A5 (Medium)** the regex-matches-raw-content (vs stripped/reference-resolved/
  NFC) divergence is documented in code (`toggle_filter.rs:496-518`) but absent from
  both docs — a real user sharp-edge.
- **DOC-A6 (Low)** the arch doc grouped-render section omits `SearchResultGroups.tsx`
  / `VirtualizedResultListbox.tsx` (FE-3). **DOC-A8 (Low)** stale future-tense
  PEND-62 (`SEARCH.md:153`). **DOC-A9 (Low)** "help dialog mirrors the section list"
  over-claims (dialog has 5 of the doc's 8 sections). **DOC-A4/A7 (Low)** inline
  `MAX_SEARCH_RESULTS=100`; priority `A/B/C` vs `priority:1` inconsistency.

## Findings — E2E / test coverage

- **No test at any layer:** the capped (5000) result notice (E2E-A4) and the
  palette→panel `pendingViewQuery` handoff (`SearchPanel.tsx:265-279`, E2E-A5).
- **e2e gaps:** `not-state:`/`not-priority:`/`not-prop:` → IPC (E2E-A1),
  `scheduled:` → IPC (E2E-A2), Load-More pagination (E2E-A3),
  `not-path:`→`excludePageGlobs` (E2E-A11); priority/due/scheduled autocomplete
  anchors (E2E-A7); `prop:key=` empty-contract pin (E2E-A8); full SearchPanel at a
  mobile viewport (E2E-A9); history per-space isolation (E2E-A10).
- **Weak assertions:** `search-filters.spec.ts` `searchUntil` is near-tautological;
  several result/alias specs assert only that *a* page title appears, not *which*.
- **Backend:** no test for regex-mode-under-cancellation or toggle
  `has_more`-vs-post-filter (BE-A10).
- **Harness blind spot (E2E-A6):** `<mark>` highlight + the real Rust FTS/regex
  pipeline are unreachable on the web+mock harness; would need a Tauri-driven e2e
  harness.

---

## Suggested action order

1. **Cluster 1 — regex-mode-drops-filters** (DSL-A8/UX-A4/DOC): decide + implement
   the contract; highest correctness/UX impact.
2. **Cluster 3 — virtualization a11y regressions** (FE-A5, FE-A8, FE-A7): the
   keyboard-nav breakage from the just-landed FE-3.
3. **UX-A1** (mobile parity) + **UX-A2** (regex double-announce).
4. **Cluster 2 — pagination/has_more** (SQL-A1, SQL-A3/BE-A1, SQL-A2).
5. **FilterHelperPopover** (FE-A20 race, UX-A6 combobox, UX-A3 i18n, UX-A5 coverage).
6. **DSL-A1** (quoted whitespace) + **DSL-A2** (glob length cap) + **SQL-A4/A6**,
   **BE-A4** (regex cancellation).
7. **Docs** (DOC-A1/A2/A3/A5/A6) + **test gaps** (E2E-A1..A5, A11; BE-A10).
8. **Maintainability** (FE-A18 hook extraction; SQL-A5; FE-A12/A19).
