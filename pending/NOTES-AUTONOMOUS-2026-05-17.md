# Notes — autonomous implementation cycle (2026-05-17 overnight)

> The maintainer asked me to implement pending/ plans cycle-after-cycle while sleeping,
> with the standing rule: **don't ask questions if I can help it; log decisions here**.
> This file is the audit trail for every non-trivial decision I made without their input.
> Review before scheduling the next cycle.

## Scope I picked up

Plans tackled in dependency order (each its own commit):

1. **PEND-50** — search foundation (page-grouped renderer + FTS5 snippet highlighting)
2. **PEND-54** — inline filter syntax framework (depends on PEND-50)
3. **PEND-52** — in-page find (frontend-only, independent)
4. **PEND-55** — toggle row + search history (depends on PEND-50)
5. **PEND-51** — Cmd+K palette (depends on PEND-50)
6. **PEND-53** — property filters (depends on PEND-54)

## Plans I deliberately skipped (rationale)

- **PEND-10 (iroh transport adoption)** — explicitly L scale (14-19 weeks), needs the
  maintainer's iroh-stability spike decision. Not autonomously implementable.
- **PEND-36 (Play Store publishing)** — has 3 open maintainer decisions (D1-D3) about
  account ownership, paperwork path, and the closed-test cohort. Not autonomously
  decidable.
- **PEND-49 (OSSF Silver roadmap)** — requires the maintainer to fill in the
  bestpractices.dev self-assessment form. Not autonomously fillable.
- **PEND-56/57/58 (Pages view trio)** — substantial scope (~55-67 h combined), and the
  three were authored in the very session that ran out of time; landing them on top of
  fresh plans is high-risk. Deferred to the maintainer's next supervised cycle.
- **design-system-perf-review-2026-05-09.md** — two open items, neither scoped tightly
  enough for an autonomous pass.

## Standing decisions applied across every plan

These resolve the "Open questions" sections where the plan offered a recommendation;
I took the **Recommendation** verbatim unless noted otherwise.

- **Feature flags.** Where a plan proposes a flag (e.g. PEND-50's `searchV1` rollout
  flag, PEND-55's `searchToggles` etc.), I shipped behind the flag default-on, and added
  a localStorage override so a downgrade leaves users on the old path. **Why:** keeps
  rollback cheap if the maintainer dislikes any landed change.
- **i18n keys.** Every new string lands as an English-default i18n key in
  `src/i18n/locales/en.json`. No machine-translation; the maintainer adds other locales
  when they want.
- **Telemetry.** No telemetry instrumentation added in this autonomous pass. The plans
  call out instrumentation as deferred; I left it deferred.
- **Backend wire compat.** Every IPC change is additive (`#[serde(default)]` on new
  fields). Old frontends keep working against new backend, and vice versa.

## Per-plan decisions (filled in as each cycle lands)

### PEND-50 — search foundation — LANDED (`95a55773`)

- **Page-name-only counts:** "1 match (in name)" via new `search.matchCountInGroupNameOnly` i18n key (plan's recommendation).
- **`<mark>` highlight contrast:** reused `--accent` / `--accent-foreground` theme tokens (light ≈ 7.1:1, dark ≈ 8.0:1; both clear WCAG AA). No new tokens.
- **Snippet window constant:** left at backend default 32. Bumping deferred to a later perf pass.
- **`useListKeyboardNavigation` not extended:** kept the hook unchanged; routed `onKeyDown` through a new `listOnKeyDown` prop on `CollapsibleGroupList`. Workaround is short + idiomatic; no TODO needed.
- **i18n delivery shape:** the codebase uses TS-namespace files (`src/lib/i18n/references.ts`), not JSON locale files. The plan's step referring to `src/i18n/locales/en.json` collapses into the references.ts additions.
- **SearchHelpDialog export shape:** named export (Biome `lint/style/noDefaultExport` is enforced project-wide).
- **Existing tests migrated:** `src/lib/__tests__/tauri.test.ts` and `src/components/__tests__/SearchPanel.test.tsx` updated to the new struct shape; behaviour assertions unchanged.
- **Test delta:** +43 (10 backend, 33 frontend). 9925 / 9925 vitest, 3682 / 3682 nextest, clippy clean.
- **Biome rule ignores added (2, both with rationale comments):** `aria-activedescendant` on conditional-role `<ul>` in `CollapsibleGroupList`; `role="option"` on `<li>` in `SearchResultBlockRow`. Both are canonical WAI-ARIA listbox patterns the linter misclassifies.

### PEND-54 — inline filter syntax — LANDED

- **Phases shipped:** Phase 1 (parser/AST/registry/autocomplete primitives) + Phase 2 (UI chip-row + helper popover + backend GLOB) + Phase 3 (docs).
- **Phase deferred (review-worthy):** the **caret-anchored autocomplete popover** rendering. Pure detection logic (`detectAutocompleteAnchor` + `applyAutocompleteReplacement`) is implemented and unit-tested; the *in-input rendered popover* that anchors to the caret position is deferred. Rationale: requires coordination with PEND-55 (history-recall arrow-key contention on the input) and PEND-51 (palette autocomplete). Chip + helper-popover paths already deliver discoverability; caret popover is a polish layer.
- **Helper popover keyboard nav:** simplified to "swap popover content in place" rather than nesting Radix popovers. Avoids focus-trap issues. `useListKeyboardNavigation` not invoked inside the inline `<ul>` — Enter + click are sufficient for now.
- **Bare-token substring** (plan recommendation): backend `wrap_substring` wraps any pattern without `*`/`?`/`[` with `*…*`. Done verbatim.
- **Brace-expansion cap = 64** (plan recommendation): both Rust + TS implementations enforce. Tests accept either truncation OR an `InvalidGlob: expansion exceeded` error as valid (safer-side acceptance).
- **Comma-split inside `path:` value:** must respect top-level vs brace-internal commas. Hand-rolled `split_top_level_commas` in both Rust + TS.
- **MCP search tool:** hard-coded empty globs there; the MCP contract is unchanged.
- **Migration toast:** localStorage flag `agaric:searchFilterSyntaxToast:v1`, `t('search.filterSyntaxIntro')`. Wrapped in try/catch for jsdom resilience.
- **Legacy chip UI deleted:** `searchFilterReducer.ts`, `SearchFilters.tsx`, `usePopoverEntity.ts`, and their tests. Eight legacy i18n keys removed (`search.addPage`, `addTag`, …).
- **Test delta:** +290 vitest cases (parser suite + chip row + axe), +20 nextest (glob filter + IPC integration). 9994 vitest pass, 3704 nextest pass.
- **Fix-up cycle:** prek's stricter `tsc -b` flagged 6 type-narrowing issues + a direct `sonner` import + a clippy `too_many_arguments` warning + an out-of-sync bench. All fixed in a follow-up subagent pass; no behaviour change.
- **Follow-ups for the maintainer's next supervised cycle:** (1) caret-anchored autocomplete popover rendering, (2) integration test `SearchPanel.filters.test.tsx` for the end-to-end typed-token → IPC flow, (3) lift `tagNameMap` to a global store if tag-resolution becomes hot.

### PEND-52 — in-page find — LANDED

- **Architecture deviation (significant — review-worthy):** the plan called for ProseMirror `Decoration` + `DecorationSet` in a TipTap extension. Agaric's roving-editor pattern means only the focused block has a ProseMirror instance — every other block is static DOM via `StaticBlock.tsx`. A DecorationSet would only cover one block. Switched to the **CSS Custom Highlight Registry** (`CSS.highlights` + `Highlight` + `Range`) — modern browser primitive for native-style highlighting, paints over text without mutating DOM, works across all blocks uniformly. The TipTap extension file is a documented stub reserving the slot for future per-block decorations on the focused block. Deviation documented inline in `matcher.ts`, `in-page-find.ts`, and `docs/SEARCH.md`.
- **Hand-rolled vs `prosemirror-search`:** stayed hand-rolled. The plan's 350-LOC budget for switching is moot because `prosemirror-search` only works against a ProseMirror document, which Agaric doesn't have at page level.
- **Mobile entry point (plan Q1):** SKIPPED. No long-press menu, no page-header action sheet. Desktop keyboard binding works; `window.visualViewport` keyboard-aware positioning is in place so a laptop-with-touchscreen renders correctly. Pure touch users have no entry point — review needed.
- **Selection-as-initial-query (Q3):** locked-in behaviour implemented (selection > current query > `lastQuery`).
- **Regex divergence with PEND-55 (Q4):** documented in `docs/SEARCH.md`. JS RegExp (this plan) has lookaround + backrefs + Unicode-`\b`; Rust regex (PEND-55, future) is linear-time but no lookaround.
- **Regex caps in place:** 1 KB pattern length cap, 10 KB text-node skip, 50-node `requestIdleCallback` chunks, cancellable in-flight walker. Each cap covered by tests.
- **Test-env note:** happy-dom lacks `CSS.highlights`, so the highlighter no-ops in tests; the matcher (load-bearing logic) is fully testable; component tests assert counter / aria-pressed / navigation via store state.
- **Test delta:** +39 (17 matcher, 10 store, 12 component including vitest-axe). Suite: 9965 / 9965 pass.
- **Keyboard rebind:** `Ctrl+F` now opens in-page find; `Ctrl+Shift+F` opens find-in-files. Matches universal convention; users coming from prior versions see a one-line release note + KeyboardShortcuts dialog entry.

### PEND-55 — toggle row + search history — LANDED

- **All three phases shipped:** backend toggle/regex pipeline + frontend toggle row + history dropdown + cycling hook + docs.
- **Backend `SearchFilter` extensions:** `case_sensitive`, `whole_word`, `is_regex` (all `#[serde(default)]`). `SearchBlockRow` gains `match_offsets: Vec<MatchOffset>`. Wire-compat additive — old frontends keep working.
- **Regex engine:** Rust `regex` crate (linear-time, no lookaround); `size_limit(10 MB)`. Pattern length cap, result count cap (`MAX_OFFSETS_PER_BLOCK = 50`). Inline errors via `AppError::Validation("InvalidRegex: …")` prefix (same convention as PEND-54's `InvalidGlob:`).
- **Toggle persistence (deliberate deviation from plan ambiguity):** persisted to localStorage `agaric:searchToggles:v1`. Plan was ambiguous; pre-flight instructions resolved it as persisted.
- **Regex-mode ordering** (open Q3): `b.id DESC` (ULID = time-sortable) since the `blocks` table has no `created_at` column. Same recency-first behaviour without a schema change. Documented.
- **`MAX_HISTORY = 20`** (open Q2 — plan recommendation).
- **Per-space history** (open Q1 — plan recommendation; safer since `tag:` / `path:` references are space-specific).
- **`is_regex` skips PEND-54's filter projection.** In regex mode, the typed string IS the regex; the chip parser is bypassed. Structural filters (parent, tag, space, glob) still apply via the regex-mode SQL path. Documented in `docs/SEARCH.md` Tips.
- **History dropdown role:** `<div role="listbox">` instead of `<ul>` to satisfy Biome's `noNoninteractiveElementToInteractiveRole` rule cleanly.
- **Defensive offset clamping:** frontend renderer guards out-of-range / inverted / overlapping offsets; backend guarantees ordered + capped, but the renderer must never throw on a stale bundle.
- **Snippet cleared when `match_offsets` populated** (post-filter path) — prevents double-rendering on pre-PEND-55 frontends.
- **Inline regex error UX:** parses `InvalidRegex:` prefix; renders red border + tooltip on the input.
- **Test delta:** +53 vitest cases (toggle/history/cycling/integration), +15 nextest cases (Rust toggle filter + IPC integration). Suite: 10037 / 10037 vitest, 3728 / 3728 nextest.
- **Fix-up cycle for prek-stricter `tsc -b`:** 8 TS4111 errors in `SearchPanel.toggles.test.tsx` (index-signature access via `['key']`), 1 TS4104 in `search-history.ts` (return type made `ReadonlyArray<string>` to match the `EMPTY_HISTORY` sentinel), added an axe audit (axe-presence hook requires every component test to carry one), cargo fmt.

### PEND-51 — Cmd+K palette — LANDED

- **All phases shipped.** Dialog/Sheet palette opens via Cmd/Ctrl+K, fuzzy-rescored page-grouped results, `[[page]]` autocomplete, escalation footer to find-in-files (now `Ctrl+Shift+F` post-PEND-52), recent-pages empty state, Cmd-click new-tab.
- **Backend `SearchFilter` extension:** new `block_type_filter: Option<String>` (`#[serde(default)]`). Wire-compat additive.
- **Skipped the new `search_blocks_partitioned` Tauri command** the plan specced — used **two parallel `searchBlocks` calls** instead per the task brief. One extra FTS scan per palette keystroke; `MAX_PAGE_GROUPS = 8` keeps the page-only query trivial. Adding the dedicated command later is a pure backend optimisation.
- **Fuzzy ranking:** hand-rolled Jaro-Winkler (`src/lib/jaro-winkler.ts`, 40 LOC). `match-sorter` is in deps but JW gives the prefix-boost the palette UX wants. Blend 0.7 band-ordering + 0.3 JW; bands wide enough that JW only reorders within bands (never promotes content-only above exact-title).
- **`[[page]]` insertion** uses `document.execCommand('insertText', false, value)` for contenteditable (preserves editor undo history) and direct selection mutation + synthetic `input` event for `<input>`/`<textarea>`. Detached / no-prior-focus → silent no-op. (Note: `execCommand` is deprecated; replacement uses Selection/Range APIs, but execCommand is still the only way to preserve undo history in contenteditable.)
- **Mobile virtual-keyboard handling deferred** — palette renders via `useDialogOrSheet('dialog')` which uses Radix Sheet on mobile; Sheet handles keyboard offsets natively via dvh + inset. No `visualViewport` handler.
- **Stale-response guard:** `generationRef` counter per keystroke; promise resolvers check snapshot.
- **Surplus "+N more" pill escalates to find-in-files** (same handoff as the explicit footer button). Cleaner than a no-op scroll.
- **Test delta:** +29 (15 SearchPalette, 9 jaro-winkler, 5 store). Suite: 10067 / 10067 vitest, 3728 / 3728 nextest.
- **Fix-up cycle:** docs typos corrected (one in SEARCH.md, one in the JW test), cargo fmt, added an IPC error-path test (the prek hook requires every component-that-invokes to carry one).

### PEND-53 — property filters — LANDED

- **Backend `SearchFilter` extensions:** `state_filter`, `priority_filter`, `due_filter`, `scheduled_filter`, `property_filters`, `excluded_property_filters` (every field `#[serde(default)]`). New `DateFilter` and `SearchPropertyFilter` types.
- **`SearchPropertyFilter` struct name** (deviation): the plan called it `PropertyFilter` but there's an existing `PropertyFilter` in `queries.rs` (typed-value operator carrier). Disambiguated to `SearchPropertyFilter` for the inline `prop:` token's simple `(key, value)` shape.
- **`not-state:` / `not-priority:` are visual-only in v1:** chips render but project nothing to IPC (a literal `NOT state IN (...)` would invert the OR-set semantics dangerously). Documented in `to-search-filter.ts` and `docs/SEARCH.md`. Follow-up plan can wire excluded-state if real demand surfaces.
- **`state:none` / `priority:none` sentinel:** split from values, emitted as `IS NULL` disjunction. A literal `"none"` state value is treated as the sentinel (case-insensitive).
- **Date-range vocabulary:** `today, yesterday, overdue, this-week, this-month, next-week, older, none`. Final set documented.
- **`DateOp` wire shape:** Rust enum uses `lt/lte/eq/gte/gt` strings via `#[serde(rename_all = "lowercase")]`; frontend AST uses `<`/`<=`/`=`/`>=`/`>`. `searchBlocks` wrapper translates at the IPC boundary.
- **Last-write-wins for duplicate `due:` tokens** — `due:today due:this-week` sends only `this-week`. Documented.
- **`prop:key=` empty value** = "block has this key at all" (omits `value_text=?` in the EXISTS).
- **`MetadataPredicates` is `pub`** (not `pub(crate)`) because `benches/fts_bench.rs` is an external crate and needs to construct a default value.
- **Phases deferred (review-worthy):**
  1. `+ Filter ▾` popover extension — Phase 2 of the plan listed adding categories (`+ State`, `+ Priority`, `+ Date`, `+ Property…`) to `FilterHelperPopover`. Scaffolding's in place but only the original 3 categories render. Users type tokens directly; autocomplete catches `state:`/`priority:`/`due:`/`prop:` prefixes. Caret popover for value lists still deferred (carry-over from PEND-54).
  2. `SearchablePopover`-style autocomplete UI for `state:` / `prop:` — `detectAutocompleteAnchor` returns the right shape; the renderer is still deferred (PEND-54 carry-over).
  3. `scheduled:` semantics for repeating tasks — `b.scheduled_date` literal column only; documented limitation.
  4. Numeric / date / reference property values — `prop:KEY=VALUE` matches `value_text` only. Plan to add `propnum:` / `propdate:` tokens for the other typed columns deferred.
- **Test delta:** +74 vitest, +25 nextest. Suite: 10121 / 10121 vitest, 3758 / 3758 nextest, all 49 prek hooks pass.

## State at end of autonomous cycle

(populated when the loop terminates — final commit, final CI status, what's
landed vs. what's not, anything red the maintainer needs to triage)
