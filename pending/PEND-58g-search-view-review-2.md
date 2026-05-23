# PEND-58g — Search-view deep-review findings, round 2 (post-verification)

Branch: `pend-58f-search-view-hardening`.

**This is the single search-view plan of record.** It supersedes PEND-58f (fully
shipped). The original round-2 review was a read-only deep review by 7 specialist
subagents + 3 anti-hallucination verifiers; the full verification ledger and the
"dropped / down-ranked" notes are in git history (Session 814/815 era).

Scope: the full **search view** — FTS/SQL layer, backend command/IPC, the client
search-query DSL, the SearchPanel/SearchSheet UI tree (incl. `<SearchAutocomplete>`
and results virtualization), stores/hooks, docs, and e2e/test coverage.

## Batch 1 — shipped (Session 815)

Closed: **DSL-A8 / UX-A4** (cluster 1 — regex mode now applies structural filters;
it was a frontend-only bug, the backend `regex_mode_query` already bound every
filter), **FE-A5 / FE-A7 / FE-A8** (cluster 3 — virtualization a11y), **DSL-A1**
(quoted-phrase whitespace), **DOC-A1 / A2 / A3 / A5 / A6**, **BE-A4 / SQL-A4 /
SQL-A5 / SQL-A6** (regex-path robustness), and **FE-A13 / FE-A12 / UX-A11 / UX-A2**.

Cluster-1 contract (decided with the user): regex mode is symmetric with non-regex
mode — filter tokens are parsed out and applied as SQL filters; the free-text
remainder is the regex pattern (matched against raw `blocks.content`).

## Batch 2 — shipped (Session 816)

Closed: **Cluster 2 — pagination/`has_more`** (SQL-A1 cursor over-cap now rejects to
mirror BE-2; SQL-A2 regex partitioned `has_more` correct at the cap; SQL-A3/BE-A1
filter-aware over-fetch so post-filtered pages don't under-fill or drop rows;
**BE-A10** tests), the **FilterHelperPopover hardening** (FE-A20 debounce+latest-wins
race guard; UX-A3 i18n; UX-A6 combobox/listbox a11y), and **DOC-A4 / A7 / A8 / A9**.
Also fixed **NEW-4** (priority autocomplete suggested stale `A/B/C` — now derives
from the configurable `usePriorityLevels()`; surfaced by the DOC-A7 work).

---

## Remaining — Correctness / data bugs

- **UX-A1 (High)** `SearchSheet.tsx:178`. Mobile "all pages" renders the command
  palette, not `SearchPanel`; toggles/filters/regex/history/help are only reachable
  by escalating to the full view. Fix: route all-pages to `SearchPanel`, or surface
  the toggle row + help in the sheet. (Needs a mobile UX product decision.)

## Remaining — Performance / robustness (backend)

- **BE-A5 (Low)** `commands/queries.rs`. The detached partitioned task holds a
  read-pool connection until its next cancel checkpoint (≤200ms). Bounded; note
  only if pool saturation is observed.

## Remaining — Product / UX / a11y

- **UX-A5 (Medium)** the `+ Filter` builder only offers tag/path; the other six
  filter types (`state`/`priority`/`due`/`scheduled`/`prop` + not-variants) are
  syntax-only. Adding them to the popover builder is a feature expansion (deferred
  from the FilterHelperPopover hardening batch).
- **UX-A9 (Low)** `help/SearchHelpDialog.tsx` — help "Icon" column shows
  `Aa`/`Ab|`/`.*` text but the toolbar renders lucide icons.
- **UX-A7 (Low)** Clear-all link + history-row body lack coarse-pointer 44px
  targets (the category rows already have them). **UX-A8 (Low)** add an always-
  visible/long-press toggle-mode explanation for touch.
- **UX-A10 / UX-A12 / UX-A13 (uncertain)** history dropdown in normal flow vs
  overlaid; capped + error co-render; RTL physical spacing — verify at runtime.

## Remaining — Maintainability

- **FE-A18 (Medium)** `SearchPanel.tsx` is still ~970 lines. Continue FE-9: extract
  `useSearchResults` (queryFn + usePaginatedQuery + pageTitles + groups + nav) and
  `useSearchHistoryControls`; move the filter-param projection to its own module.
  (Per PROMPT: hook-extraction sweeps stall in subagents — run orchestrator-direct
  or split by file boundary.)
- **BE-A7 (Low, by-design)** `filters/primitive.rs`. `SearchProjection` / `compile_*`
  are dead at runtime (1=1 placeholders) — intentional Phase-2 scaffolding behind a
  clear banner. Either finish the wiring or keep the banner.
- **FE-A19 (Low)** mixed `t`-prop vs `useTranslation()` across the search subtree.
  **DSL-A3/A4/A6/A7 (Low/info)** brace-truncate-vs-error (test-only caller), no NFC
  on tag-name matching, `isInsideQuote` model drift, one dead `tag:#` arm.

## Remaining — E2E / test coverage

- **No test at any layer:** the capped (5000) result notice (E2E-A4) and the
  palette→panel `pendingViewQuery` handoff (E2E-A5).
- **e2e gaps:** `not-state:`/`not-priority:`/`not-prop:` → IPC (E2E-A1),
  `scheduled:` → IPC (E2E-A2), Load-More pagination (E2E-A3),
  `not-path:`→`excludePageGlobs` (E2E-A11); priority/due/scheduled autocomplete
  anchors (E2E-A7); `prop:key=` empty-contract pin (E2E-A8); full SearchPanel at a
  mobile viewport (E2E-A9); history per-space isolation (E2E-A10).
- **Weak assertions:** `search-filters.spec.ts` `searchUntil` is near-tautological;
  several result/alias specs assert only that *a* page title appears, not *which*.
- **Harness blind spot (E2E-A6):** `<mark>` highlight + the real Rust FTS/regex
  pipeline are unreachable on the web+mock harness; would need a Tauri-driven e2e
  harness.

## New follow-ups (open)

- **NEW-1 (Medium, discoverability)** The autocomplete popover is suppressed in
  regex mode (`SearchPanel.tsx` `suppressed={toggles.isRegex}`), but structural
  filters now apply in regex mode — so a user building `tag:#urgent ^TODO` gets no
  `tag:`/`state:` autocomplete help for the part that works. Consider allowing the
  *prefix* autocomplete (`tag:`, `state:`) in regex mode and suppressing only once
  the caret is in the free-text remainder.
- **NEW-2 (Low, discoverability)** No visual cue that the input free-text is a regex
  (only the `.*` toggle's pressed state). Consider a monospace/placeholder/aria hint
  on the input when regex mode is on. Pre-existing.
- **NEW-3 (Medium, pre-existing, both modes)** A *filter-only* search (empty free
  text + only structural filters, e.g. `tag:wip` with no pattern) returns empty in
  BOTH non-regex and regex modes: the cursor `search_blocks_inner` short-circuits a
  blank query to zero rows before applying filters. To make "filters apply on their
  own" true (as the SearchPanel `enabled` gate intends), rework the short-circuit to
  proceed when structural filters are present, and handle the empty/match-all pattern
  on both the FTS and regex paths. Symmetric across modes — not a regex regression.

---

## Suggested action order (remaining)

1. **NEW-3** (filter-only search applies filters) + **NEW-1** (regex-mode prefix
   autocomplete) — close out the cluster-1 follow-ups.
2. **UX-A1** (mobile SearchSheet parity — needs a product decision).
3. **UX-A5** (the `+ Filter` builder gains the remaining filter types).
4. **Test gaps** (E2E-A1..A5, A7..A11).
5. **Maintainability** (FE-A18 hook extraction; FE-A19; DSL-A3/A4/A6/A7) + NEW-2 +
   the low-priority UX items (UX-A7/A8/A9).
