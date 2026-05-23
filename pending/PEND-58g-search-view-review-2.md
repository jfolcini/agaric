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

## Batch 3 — shipped (Session 817)

Closed the cluster-1 follow-ups: **NEW-3** (filter-only search) — a blank free-text
query carrying ≥1 structural filter now returns the filtered blocks (recency-ordered,
`b.id DESC`) instead of empty, in BOTH the cursor and partitioned paths and
mode-independent. FTS5 MATCH can't express "match all", so a new `filter_only_scan`
(+ `fts_fetch_filter_only_page` cursor and `fts_fetch_filter_only_partitioned`)
bypasses FTS/regex; the old blank-query short-circuits in `search_blocks_inner` /
`search_blocks_partitioned_inner` were removed (the decision moved into
`search_with_toggles*`). `space_id` is excluded from the "has filters" test (it's
always supplied), so a space-only blank query still returns empty. **NEW-1**
(regex-mode prefix autocomplete) — the over-broad `suppressed={isRegex}` gate is
gone; the caret anchor detector already returns null for free-text, so filter
prefixes (`tag:`, `state:`, …) now autocomplete in regex mode while the free-text
regex remainder stays suppressed. **NEW-2** (regex visual cue) — the input gains a
regex placeholder + monospace + an sr-only `aria-describedby` hint when regex mode
is on. Backend reviewed with empirical mutation testing (cursor `<`/`has_more`
boundaries) which caught + fixed an exact-multiple `has_more` test gap.

## Batch 4 — shipped (Session 818)

Closed the mobile/touch/a11y polish cluster. **UX-A1** (mobile escalation
discoverability) — per the product decision ("better escalation only"), the mobile
all-pages palette now shows an always-visible, prominent two-line "Filters & regex /
Open full search" CTA (replacing the muted, query-gated footer), so toggles, filters,
regex, and history are discoverable from the sheet via the full search view (a new
`showMobileEscalation` gate; desktop inline footer unchanged). **UX-A7** — the history
rows, Clear-history, and the enable/disable toggle gained coarse-pointer 44px
(`min-h-11`) targets (the per-row delete already had one). **UX-A9** — the search help
dialog's Toggles "Icon" column now renders the same `CaseSensitive` / `WholeWord` /
`Regex` lucide icons the toolbar shows, instead of `Aa` / `Ab|` / `.*` text glyphs.

**UX-A8 deferred** (kept open): an always-visible/long-press toggle-mode explanation
for touch needs a real design decision (Radix tooltips don't fire on touch-tap; inline
labels overflow a narrow phone row) plus runtime verification — not shipped to avoid a
half-baked touch affordance.

---

## Remaining — Performance / robustness (backend)

- **BE-A5 (Low)** `commands/queries.rs`. The detached partitioned task holds a
  read-pool connection until its next cancel checkpoint (≤200ms). Bounded; note
  only if pool saturation is observed.

## Remaining — Product / UX / a11y

- **UX-A5 (Medium)** the `+ Filter` builder only offers tag/path; the other six
  filter types (`state`/`priority`/`due`/`scheduled`/`prop` + not-variants) are
  syntax-only. Adding them to the popover builder is a feature expansion (deferred
  from the FilterHelperPopover hardening batch).
- **UX-A8 (Low)** add an always-visible/long-press toggle-mode explanation for touch.
  Deferred from Batch 4: needs a design decision (Radix tooltips don't fire on
  touch-tap; inline labels overflow a narrow phone row) + runtime verification.
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

## Suggested action order (remaining)

1. **UX-A1** (mobile SearchSheet parity — needs a product decision).
2. **UX-A5** (the `+ Filter` builder gains the remaining filter types).
3. **Test gaps** (E2E-A1..A5, A7..A11).
4. **Maintainability** (FE-A18 hook extraction; FE-A19; DSL-A3/A4/A6/A7) +
   the low-priority UX items (UX-A7/A8/A9).
