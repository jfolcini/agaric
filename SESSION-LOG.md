# Session Log

## Quick Reference

- **This file:** sessions 801 – 828 (latest entry 2026-05-24).
- **Archived sessions:** 1 – 400 in [`docs/session-log/2024-2025.md`](docs/session-log/2024-2025.md); 401 – 800 in [`docs/session-log/2026-sessions-401-800.md`](docs/session-log/2026-sessions-401-800.md).
- **Previously-resolved counter:** 1342+ REVIEW-LATER items across 828 sessions.
- **Entry format:** see `PROMPT.md` § "Session log entry template". Each entry has a metadata table, summary, REVIEW-LATER impact, files touched, verification, optional process notes / lessons, commit plan.

## Session 828 — PEND-69 finalize: prod noNonNullAssertion fix + category triage + full-toolchain verification (2026-05-24)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-24 |
| **Subagents** | orchestrator-only |
| **Items closed** | PEND-69 prod `noNonNullAssertion` (1 fixed, 1 mock keep); `noBannedTypes` triaged (all-test) |
| **Items modified** | PEND-69 (rows + action order + Status section) |
| **Tests added** | 0 (fold-for-search suite still passes) |
| **Files touched** | 1 src + 2 plan/log |

**Summary:** Final PEND-69 burn-down sweep — closed the last low-risk actionable
prod suppressions and triaged the rest. `fold-for-search.ts` dropped its
`noNonNullAssertion` by switching `haystack[i]!` → `haystack.charAt(i)` (returns
`string`; bounds already guaranteed by the loop's break). The other prod `!`
(`tauri-mock/index.ts`, the e2e error-injection path guarded by
`hasInjectedError()`) is kept. Confirmed `noBannedTypes` is **0 prod / 38 test**
(acceptable keep) and that the only remaining prod debt is
`noExcessiveCognitiveComplexity` (13 across 9 files) — a deliberately-deferred,
regression-risky sub-function-extraction refactor that's suppressed (CI green), so
NOT churned into this release. Added a Status section to PEND-69 recording that
every actionable low-risk suppression is now burned down or audited-justified.

**REVIEW-LATER impact:**
- **PEND-69:** prod `noNonNullAssertion` cleared (1 fixed + 1 justified mock keep);
  `noBannedTypes` triaged (all-test); Status section added. Remaining: deferred
  `noExcessiveCognitiveComplexity` refactor (13), by-design keeps, dep-blocked
  MAINT-227.
- **Previously resolved:** 1341+ → 1342+ across 827 → 828 sessions.

**Files touched (this session):**
- `src/lib/fold-for-search.ts` (`!` → `charAt`, suppression dropped)
- `pending/PEND-69-tooling-hygiene-suppression-debt.md`, `SESSION-LOG.md`

**Verification:**
- `npx tsc -b --noEmit` clean; `biome check` on the change clean; fold-for-search
  suite 39 passed.
- `prek run --all-files` — full umbrella (fmt, clippy, nextest, tsc, biome, vitest,
  + all hooks) green.

**Commit plan:** single commit; this branch (`pend-58f-search-view-hardening`,
26 unpushed commits spanning PEND-58f/58g search hardening, session-log archival,
and the PEND-69 burn-down) is then pushed and a PR opened against `main`.

---

## Session 827 — PEND-69 hygiene: useExhaustiveDependencies audit (high-risk tranche) (2026-05-24)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-24 |
| **Subagents** | orchestrator-only (read-only correctness audit) |
| **Items closed** | PEND-69 `useExhaustiveDependencies` (high-risk tranche deep-verified) |
| **Items modified** | PEND-69 (row + action order) |
| **Tests added** | 0 |
| **Files touched** | 0 src (no bugs found) + 2 plan/log |

**Summary:** Audited the `useExhaustiveDependencies` suppressions (56 prod, the
plan's "highest latent-bug value" category). Deep-verified the highest-risk
members — every site where a value is **read in the effect body but omitted from
the deps**, which is where a stale-closure bug would actually live:
- `PageBrowser.tsx:631` (filter-announce): reads `filters`/`t` but deps on
  `wireFiltersKey`. Correct — `wireFiltersKey` faithfully tracks the chip set, so
  the effect re-runs with the current render's `filters`/`t` on every real change;
  a language-only `t` change has nothing to announce.
- `BlockHistoryItem.tsx:125` (compared-diff): reads `comparedDiff/Loading/Failed`
  as guards but omits them. Correct — they're SET by the effect; including them
  causes a self-cancelling fetch loop (documented, incl. the test-vs-prod timing
  subtlety).
- The `resolveVersion` ref-cache identity-bump pattern (`useBacklinkResolution`
  ×3 et al.): the callbacks read a `useRef` cache (not a dep) plus `currentSpaceId`
  (which IS listed); `resolveVersion` is an intentional identity-bump so memoized
  callbacks pick up cache updates.
- The `stableKey`/digest array-substitute hooks (`useBatchProperties`,
  `useBlockPropertiesBatch`): a membership digest correctly substitutes for the
  array identity (covariant with the read array).

All correct — **no stale-closure bugs, no code changes.** The remaining ~49 are
documented variants of vetted patterns: trigger-key "re-run on X; body doesn't
read X" (safe by construction), ref/stable-handle reads, effect-set guard state,
mount-only hydration. Recorded the audit + taxonomy in PEND-69.

**REVIEW-LATER impact:**
- **PEND-69:** `useExhaustiveDependencies` row marked audited (risky surface clean);
  action-order item 1 addressed. A full line-by-line pass of the remaining ~49 is
  available but low-ROI (all lower-risk than the verified set).
- **Previously resolved:** 1340+ → 1341+ across 826 → 827 sessions.

**Files touched (this session):**
- `pending/PEND-69-tooling-hygiene-suppression-debt.md`, `SESSION-LOG.md` (docs only)

**Verification:**
- Read-only audit; no source edits, so the tsc/biome/test baseline is unchanged.
  `prek run` on the staged docs passes.

**Lessons learned:** Like the cast + unsafe audits, this category was already
well-managed — every suppression carries a specific inline reason and follows an
idiomatic pattern. For mature suppression surfaces, deep-verify the genuinely
risky members (here: "read in body but omitted") and taxonomize the rest, rather
than exhaustively re-reading documented idiomatic effects for a near-zero bug yield.

**Commit plan:** single doc-only commit. Not pushed.

---

## Session 826 — PEND-69 hygiene: prod noExplicitAny → TFunction + dangerouslySetInnerHtml audit (2026-05-24)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-24 |
| **Subagents** | 2 build (frontend TFunction conversion + test-mock fixes); orchestrator: HTML-sink audit + mermaid hardening + docs/log |
| **Items closed** | PEND-69 prod `noExplicitAny` (11) + `noDangerouslySetInnerHtml` (2) |
| **Items modified** | PEND-69 (both rows + action order) |
| **Tests added** | 0 (8 test files had mock `t` casts; existing suites still pass) |
| **Files touched** | 20 src/test + 2 plan/log |

**Summary:** First frontend PEND-69 batch (unblocked once the concurrent agent
finished). **Typed all 11 prod `t: (...args: any[]) => any` workarounds as
`TFunction`** (from i18next) and dropped their `noExplicitAny` suppressions. 4
files (`GraphFilterBar`, `AddFilterRow`, the two `block-tree` hooks) converted
cleanly; the other 7 are consumed by unit tests that pass a bare mock `t` lacking
`TFunction`'s nominal `$TFunctionBrand`, so 8 test files got an
`as unknown as TFunction` cast at the mock-assignment site (runtime mock shape
unchanged — still `vi.fn((k) => k)`). **Audited both `dangerouslySetInnerHtml`
sinks:** `MermaidDiagram` renders user-authored diagram source, so pinned
`securityLevel: 'strict'` explicitly (mermaid's sanitizing default — made a hard
invariant so a future config tweak can't silently open an XSS hole);
`PairingQrDisplay` renders a backend-generated QR SVG (trusted), left as a
justified keep. Both sinks stay (required to render SVG).

**REVIEW-LATER impact:**
- **PEND-69:** prod `noExplicitAny` cleared (only test-mock `any`s remain, ~156,
  acceptable); `noDangerouslySetInnerHtml` audited + hardened; action-order item 2
  done. Remaining high-value: the `useExhaustiveDependencies` audit (59).
- **Previously resolved:** 1338+ → 1340+ across 825 → 826 sessions.

**Files touched (this session):**
- 11 prod: `GraphFilterBar.tsx`, `backlink-filter/AddFilterRow.tsx`,
  `block-tree/use-block-auto-create-first-block.ts`, `block-tree/use-block-flush.ts`,
  `hooks/useBlockSlashCommands/types.ts`, `hooks/useBlockDatePicker.ts`,
  `hooks/useBlockNavigateToLink.ts`, `hooks/useBlockKeyboardHandlers.ts`,
  `hooks/useBlockMultiSelect.ts`, `hooks/useTemplateSelection.ts`,
  `hooks/useCheckboxSyntax.ts` (`any` → `TFunction`, ignore dropped)
- 8 test: the matching `__tests__` files (mock `t` cast `as unknown as TFunction`)
- `components/MermaidDiagram.tsx` (explicit `securityLevel: 'strict'`)
- `pending/PEND-69-tooling-hygiene-suppression-debt.md`, `SESSION-LOG.md`

**Verification:**
- `npx tsc -b --noEmit` — No errors found.
- `npx vitest run` (the 8 affected hook suites + Mermaid/QR) — green (215 + 31 passed).
- `./node_modules/.bin/biome check` on all changed files — 0 findings.
- `prek run` on the staged files — all hooks pass.

**Process notes:** Two sequential subagents — the first found that forcing
`TFunction` on all 11 breaks 8 test mocks (137 `$TFunctionBrand` errors) and was
scoped out of editing tests, so it converted only the 4 test-free files; the
second was authorized to fix the test mocks and finished the other 7. Lesson: when
a "type it properly" lint fix tightens a shared interface, budget for the
test-mock fallout up front rather than discovering it mid-batch.

**Commit plan:** 3 commits — (1) TFunction typing, (2) mermaid securityLevel
hardening, (3) docs. Not pushed.

---

## Session 825 — PEND-69 hygiene: Rust cast + unsafe audit (audit-only) (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | orchestrator-only (read-only audit) |
| **Items closed** | PEND-69 `cast_possible_truncation`/`_wrap` + `unsafe` review |
| **Items modified** | PEND-69 (cast rows, unsafe section, action order) |
| **Tests added** | 0 |
| **Files touched** | 0 src (audit found no changes needed) + 2 plan/log |

**Summary:** Audited the two correctness-related Rust suppression categories and
found both already fully justified — **no code changes warranted**. The 11
`cast_possible_truncation` + 1 `cast_possible_wrap` allows each already document
the invariant that makes truncation impossible (the 6 production casts are
`f64 → i64/usize` of non-negative whole numbers from SQLite REAL columns — `f64`
has no `std` fallible `try_into`, so documenting the invariant is the prescribed
resolution; `op_log_histogram::permyriad_from_share` `clamp`s to `[0,1]` before
scaling; the 6 test casts are controlled-input data generation like
`(i % 256) as u8`). The 2 real `unsafe` blocks in `sync_daemon/android_multicast.rs`
(`JavaVM::from_raw`, `JObject::from_raw`) already carry detailed `// SAFETY:`
comments and the file-level `#![allow(unsafe_code)]` is documented. Recorded the
audit conclusion in PEND-69 so the categories aren't re-litigated.

**This effectively completes the conflict-free Rust portion of PEND-69.** The
remaining Rust allows are by-design keeps (`too_many_arguments` ×41 — optional
request-struct folding; `deprecated` ×1 blocked on MAINT-227's
`tauri-plugin-opener`; `type_complexity`/`match_same_arms`/`assertions_on_constants`
×1 each — justified). The high latent-bug-value remaining work
(`useExhaustiveDependencies` ×59, prod `noExplicitAny` ×11,
`noDangerouslySetInnerHtml` ×2) is all **frontend** (`src/`) and was deferred to
avoid colliding with the concurrent agent active in `src/components`.

**REVIEW-LATER impact:**
- **PEND-69:** cast rows + unsafe section marked audited; action-order item 6 done.
- **Previously resolved:** 1337+ → 1338+ across 824 → 825 sessions.

**Files touched (this session):**
- `pending/PEND-69-tooling-hygiene-suppression-debt.md`, `SESSION-LOG.md` (docs only)

**Verification:**
- Audit only; the `cargo clippy`/`nextest` baseline from Session 824 is unchanged
  (no source edits). `prek run` on the staged docs passes.

**Commit plan:** single doc-only commit. Not pushed.

---

## Session 824 — PEND-69 hygiene: Rust `dead_code` audit (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | orchestrator-only (per-case judgment + iterative clippy) |
| **Items closed** | PEND-69 `dead_code` category (audited all ~23 allows) |
| **Items modified** | PEND-69 (table row + action order) |
| **Tests added** | 0 (hygiene; `cargo nextest` 3956 still pass) |
| **Files touched** | 4 src-tauri + 2 plan/log |

**Summary:** Second PEND-69 burn-down batch — audited every `#[allow(dead_code)]`
in `src-tauri`. **Deleted** the genuinely-dead `apply_purge_block_sql_only`
wrapper in `materializer/handlers.rs` (zero callers; a thin pass-through to the
live `purge_block_sql_cascade`, whose doc was preserved). **Converted 3** never-
read intentional keeps from `#[allow]` to `#[expect(dead_code, reason)]` so they
self-report if they ever go live: the `SyncOrchestrator::materializer` field
(held for API stability), `dag.rs`'s `depth` (selected only for SQL `ORDER BY`),
and `db.rs`'s `CommandTx::label` (reserved for a planned Drop-time debug-assert).
The remaining ~19 `#[allow(dead_code)]` were reviewed and confirmed JUSTIFIED
keeps (documented scaffolding, `gcal_push` test-shims, `mcp::SocketKind` platform
variants, `cfg_attr(not(test))`-scoped helpers, specta-read `AppErrorSchema`,
`recurrence::handle_recurrence` kept as future API + test helper, `is_empty`/`len`
symmetry).

**Done orchestrator-direct** — per-case wire/scope/delete judgment with iterative
clippy, not delegable; `src-tauri`-only so conflict-free with the frontend agent.

**REVIEW-LATER impact:**
- **PEND-69:** `dead_code` row marked audited (23 → ~19 justified keeps);
  action-order item 4 done. Remaining PEND-69 targets:
  `cast_possible_truncation` (11), prod `noExplicitAny` (11) +
  `noDangerouslySetInnerHtml` (2), the `useExhaustiveDependencies` audit (59).
- **Previously resolved:** 1336+ → 1337+ across 823 → 824 sessions.

**Files touched (this session):**
- `src-tauri/src/materializer/handlers.rs` (deleted dead wrapper; doc moved to `purge_block_sql_cascade`)
- `src-tauri/src/sync_protocol/orchestrator.rs`, `src-tauri/src/dag.rs`, `src-tauri/src/db.rs` (`#[allow]` → `#[expect(dead_code, reason)]`)
- `pending/PEND-69-tooling-hygiene-suppression-debt.md`, `SESSION-LOG.md`

**Verification:**
- `cargo fmt --check` — clean.
- `cargo clippy --all-targets --all-features --no-deps` — No issues found (all three `#[expect]`s fulfilled; no `unfulfilled_lint_expectations`).
- `cargo nextest run` — 3956 passed, 6 skipped.
- `prek run` on the staged files — all hooks pass.

**Lessons learned:** `#[expect(dead_code)]` is only safe for code dead in EVERY
compiled config — `clippy --all-targets` includes tests, so an item used by a
test (e.g. `handle_recurrence`) must stay `#[allow]` (or `cfg_attr(not(test),
allow)`), not `#[expect]`, or it trips `unfulfilled_lint_expectations`.

**Commit plan:** single commit (PEND-69 dead_code). Not pushed.

---

## Session 823 — PEND-69 hygiene: Rust `unused_imports` burn-down (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | 1 build (Rust, src-tauri test files); orchestrator: fmt/clippy gate + docs/log |
| **Items closed** | PEND-69 `unused_imports` category (19 file-level test allows) |
| **Items modified** | PEND-69 (table row + action order) |
| **Tests added** | 0 (hygiene; `cargo nextest` 3956 still pass) |
| **Files touched** | 19 src-tauri test files + 2 plan/log |

**Summary:** First PEND-69 (suppression-debt) burn-down batch. Removed the 19
defensive file-level `#![allow(unused_imports)]` attributes from
`src-tauri/src/commands/tests/*` and deleted/narrowed the 4 imports the compiler
then flagged as genuinely unused (`crate::op_log` in block_cmd_tests,
`super::*` in common, `SearchToggles` in toggle_filter_tests, `DeleteBlockPayload`
in undo_redo_tests). None needed `#[cfg]`-gating — all are platform-agnostic DB
tests. The 4 item-level `unused_imports` allows in `snapshot/mod.rs` (2) and
`sync_daemon/mod.rs` (2) were intentionally KEPT: they guard `pub(crate) use`
re-exports consumed only by a separate integration-test crate, so they can't be
`#[cfg(test)]`-gated without breaking that crate.

**Rust domain chosen deliberately** — the concurrent agent was active in the
frontend (`src/components`), so a `src-tauri`-only batch stayed conflict-free.

**REVIEW-LATER impact:**
- **PEND-69:** `unused_imports` row 23 → 4 (the 4 are justified keeps); action-order
  item 3 marked done. Next PEND-69 targets: `dead_code` (~23, Audit),
  `cast_possible_truncation` (11), prod `noExplicitAny` (11) + `noDangerouslySetInnerHtml` (2),
  the `useExhaustiveDependencies` audit (59).
- **Previously resolved:** 1335+ → 1336+ across 822 → 823 sessions.

**Files touched (this session):**
- `src-tauri/src/commands/tests/{agenda,block,common,compaction,edge_case,gcal_hook,glob_filter,history,metadata_filter,page,property,query,search_blocks_struct,snapshot,status,sync,tag,toggle_filter,undo_redo}*_tests.rs` / `common.rs` (19 files: blanket allow removed; unused imports cleaned)
- `pending/PEND-69-tooling-hygiene-suppression-debt.md`, `SESSION-LOG.md`

**Verification:**
- `cargo fmt --check` — clean (after `cargo fmt` collapsed the two narrowed import groups).
- `cargo clippy --all-targets --all-features --no-deps` — No issues found.
- `cargo nextest run` — 3956 passed, 6 skipped (unchanged baseline).
- `prek run` on the staged files — all hooks pass.

**Process notes:** The single Rust subagent owned all `cargo` runs to avoid
`target/` lock contention with the orchestrator; the orchestrator ran the final
fmt/clippy gate only after the subagent finished. IDE `unused_imports` diagnostics
fired stale (mid-edit) and disagreed with the final file state — verified ground
truth by reading the files + re-running `cargo check`/clippy rather than trusting
the LSP snapshot.

**Commit plan:** single commit (PEND-69 unused_imports). Not pushed.

---

## Session 822 — PEND-58g search-view round-2: Batch 8 (test-coverage gaps + 2 pre-existing e2e fixes) (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | 1 build (vitest integration tests); orchestrator: e2e specs + Playwright runs + pre-existing fixes + docs/log |
| **Items closed** | E2E-A4, E2E-A5, E2E-A9, weak result-assertions |
| **Items modified** | PEND-58g (Batch 8 section; E2E section + action order trimmed) |
| **Tests added** | +6 (frontend vitest: 3 capped + 3 handoff) / +2 e2e (mobile viewport) ; +3 e2e assertions tightened ; +2 pre-existing e2e repaired |
| **Files touched** | 5 src/test + 2 plan/log |

**Summary:** Closed the verifiable search test-coverage gaps. **E2E-A4** (capped
5000-result notice) and **E2E-A5** (palette→panel `pendingViewQuery` handoff) had
no test at any layer; both are now covered at the SearchPanel integration layer
(`SearchPanel.capped.test.tsx` mocks `usePaginatedQuery` to assert the notice
renders iff `capped`; `SearchPanel.handoff.test.tsx` asserts the mount effect
seeds + fires `search_blocks` and clears the slot, incl. the empty-string
PEND-61 case). jsdom can't reach the 5000-row cap or a viewport, so these are
vitest, not e2e. **E2E-A9** — new `search-view-mobile.spec.ts` reaches the full
find-in-files panel via the mobile sheet escalation and asserts it lays out +
functions at iPhone width. **Weak result-assertions** — the three
`search-results.spec.ts` navigation checks now assert the specific destination
page.

**Pre-existing fixes (surfaced by the full-suite regression run):**
`search-toggles.spec.ts` had two failures that were masked because the spec was
not in the Batch 3–6 run sets — both located the input by its placeholder *after*
toggling regex, but NEW-2 (Batch 3) swaps the placeholder in regex mode; switched
to the mode-agnostic `getByRole('combobox', { name: 'Search blocks' })`. One of
the two also encoded the obsolete pre-cluster-1 "regex forwards raw query"
contract; rewrote it to the current symmetric behavior (DSL-A8 / UX-A4) and fixed
the stale file-header comment.

**REVIEW-LATER impact:**
- **PEND-58g open items:** closed E2E-A4/A5/A9 + the weak-assertion cleanup. The
  E2E section now holds only the harness blind spot (E2E-A3/A6, needs a
  Tauri-driven harness). Remaining overall: BE-A5, UX-A8, UX-A10/A12/A13, BE-A7,
  E2E-A3/A6.
- **Previously resolved:** 1331+ → 1335+ across 821 → 822 sessions.

**Files touched (this session):**
- `src/components/__tests__/SearchPanel.capped.test.tsx` (new, +3 tests)
- `src/components/__tests__/SearchPanel.handoff.test.tsx` (new, +2 tests)
- `e2e/search-view-mobile.spec.ts` (new, +2 tests)
- `e2e/search-results.spec.ts` (3 navigation assertions tightened)
- `e2e/search-toggles.spec.ts` (2 pre-existing failures fixed)
- `pending/PEND-58g-search-view-review-2.md`, `SESSION-LOG.md`

**Verification:**
- `npx vitest run` (capped + handoff) — 6 passed.
- `npx playwright test` (full search suite: filters, autocomplete, results,
  history, help, toggles, sheet-mobile, view-mobile) — green (64 passed, 1 skip).
- `prek run` on the staged files — all hooks pass.

**Process notes:** The vitest integration tests were delegated to a self-verifying
subagent; the e2e work was orchestrator-direct because only the orchestrator can
run Playwright against the single shared dev server. The full-suite run is also
what surfaced the two stale `search-toggles` tests (cf. Batch 6's stale
tag-picker fix — running specs that recent batches skipped catches latent rot). A
concurrent agent was active in `src/components/{DonePanel,DuePanel,AgendaResults,
HistoryListView}.tsx` + `src/index.css`; all staging was by file name.

**Commit plan:** single commit (Batch 8). Not pushed.

---

## Session 821 — PEND-58g search-view round-2: Batch 7 (SearchPanel hook extraction + i18n convergence) (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | orchestrator-direct build (hook-extraction sweep — per PROMPT, not delegated) + 1 technical review |
| **Items closed** | FE-A18, FE-A19 |
| **Items modified** | PEND-58g (Batch 7 section; Maintainability + action-order updated) |
| **Tests added** | +3 (frontend: `searchFilterParams` unit) / 0 (backend) |
| **Files touched** | 9 src/test + 2 plan/log |

**Summary:** Closed the search-view maintainability cluster. **FE-A18** decomposed
the 996-line `SearchPanel.tsx` god-component: the results pipeline (AST→IPC
projection, `usePaginatedQuery`, the inline regex-error derive, breadcrumb
page-title resolution, page grouping + collapse, the roving
`useListKeyboardNavigation` model, result/recent-page navigation) moved into a new
`useSearchResults` hook; the per-space search-history surface (store wiring,
`useSearchHistoryCycling`, listbox id, recall/clear/remove/toggle handlers) moved
into `useSearchHistoryControls`; and the filter-param projection
(`SearchFilterParams` + `astFilterParams`) moved to a pure `searchFilterParams.ts`
module with a focused unit test. **FE-A19** converged the search subtree on the
dominant `useTranslation()` convention — dropped the drilled `t: TFunction` prop
from `SearchHeader`, `SearchStatusRegion`, `SearchResultGroups`, and the new
`useSearchResults` hook (the pure `getSearchStatusText` helper still takes `t`).

**Behaviour-preserving:** every memo/effect dependency array was lifted unchanged;
the full search integration suite stayed green (no test assertions changed beyond
removing the now-invalid `t={t}` prop from `SearchResultGroups.test.tsx`).
`SearchPanel.tsx`: 996 → 625 lines (the remainder is the JSX tree).

**REVIEW-LATER impact:**
- **PEND-58g open items:** closed FE-A18 + FE-A19. The Maintainability section now
  holds only BE-A7 (by-design Phase-2 scaffolding). Remaining: BE-A5, UX-A8,
  UX-A10/A12/A13, BE-A7, E2E-A4/A5/A9, weak result-assertions, E2E-A3/A6 (harness).
- **Previously resolved:** 1329+ → 1331+ across 820 → 821 sessions.

**Files touched (this session):**
- `src/components/SearchPanel.tsx` (−371 LOC; now calls `useSearchResults` +
  `useSearchHistoryControls`)
- `src/components/SearchPanel/useSearchResults.ts` (new, +309)
- `src/components/SearchPanel/useSearchHistoryControls.ts` (new, +113)
- `src/components/SearchPanel/searchFilterParams.ts` (new, +63)
- `src/components/SearchPanel/__tests__/searchFilterParams.test.ts` (new, +3 tests)
- `src/components/SearchPanel/SearchHeader.tsx`,
  `src/components/SearchPanel/SearchStatusRegion.tsx`,
  `src/components/search/SearchResultGroups.tsx` (drop `t` prop → `useTranslation()`)
- `src/components/search/__tests__/SearchResultGroups.test.tsx` (drop `t={t}`)
- `pending/PEND-58g-search-view-review-2.md`, `SESSION-LOG.md`

**Verification:**
- `npx tsc -b --noEmit` — no errors.
- `npx vitest run` (SearchPanel.* + search subtree + SearchPanel/ hooks) — 257
  tests passed across 15 files.
- `prek run` on the staged files — all hooks pass.

**Process notes:** Hook extraction was run orchestrator-direct (PROMPT.md flags
hook-extraction sweeps as a class that stalls when delegated to subagents). A
concurrent agent was active in `src/components/DonePanel.tsx` + `src/index.css`;
all staging was by file name to avoid touching its WIP, and prek was scoped to
this session's files rather than `--all-files` (which would lint the other agent's
unstaged changes).

**Commit plan:** single commit (Batch 7). Not pushed.

---

## Session 820 — PEND-58g search-view round-2: Batch 6 (E2E coverage gaps + a pre-existing test fix) (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | 3 build (e2e by spec file); orchestrator: Playwright suite verification + pre-existing-test fix + docs/log |
| **Items closed** | E2E-A1, E2E-A2, E2E-A7, E2E-A8, E2E-A10, E2E-A11 (E2E-A3 reclassified → harness blind spot) |
| **Items modified** | PEND-58g (Batch 6 section; E2E section + action order updated) |
| **Tests added** | +12 e2e (search-filters: 7 IPC-marshalling; autocomplete: 3 anchors; search-results: 1 single-page contract; search-history: 1 per-space isolation) + 1 pre-existing test repaired |
| **Files touched** | 4 (e2e specs) + 2 plan/log |

**Summary:** Closed the verifiable E2E coverage gaps for the search view. Added
IPC-marshalling assertions for the negated filters (`not-state:`→`excludedStateFilter`,
`not-priority:`→`excludedPriorityFilter`, `not-prop:`→`excludedPropertyFilters`),
`scheduled:`→`scheduledFilter` (named + op shapes), `not-path:`→`excludePageGlobs`, and
the `prop:key=` empty-value key-presence contract (`{key, value:''}`) — all in
`search-filters.spec.ts`'s E2E-6 block via the existing `searchUntil`/`latestFilter`
helpers. Added autocomplete-anchor coverage for `priority:`/`due:`/`scheduled:`
(`autocomplete.spec.ts`) and per-space search-history isolation
(`search-history.spec.ts`, pre-boot localStorage seed). Installed the Playwright
Chromium browser (absent in the dev env) and ran the suite: **47 search e2e tests
green**.

**Pre-existing bug fixed:** `search-filters.spec.ts`'s "adds a tag filter via the tag
picker" queried `getByRole('button', { name: '#work' })`, but the Batch-2 UX-A6 a11y
work made the tag items `role="option"`, so the assertion timed out. It had slipped
through because the e2e browser wasn't installed locally. Confirmed it was NOT a
Batch-5 regression by reverting `FilterHelperPopover.tsx` to the pre-Batch-5 version —
it failed identically — then switched the query to `getByRole('option', …)`.

**REVIEW-LATER impact:**
- **PEND-58g open items:** closed E2E-A1/A2/A7/A8/A10/A11; E2E-A3 (Load-More)
  reclassified as a web+mock harness blind spot (the mock returns one page; the
  append path stays unit-covered) alongside E2E-A6. Remaining: BE-A5, UX-A8,
  UX-A10/A12/A13, FE-A18, BE-A7, FE-A19, E2E-A4/A5/A9, weak result-assertions.
- **Previously resolved:** 1323+ → 1329+ across 819 → 820 sessions.

**Files touched (this session):**
- `e2e/search-filters.spec.ts` (E2E-A1/A2/A8/A11 IPC tests + tag-picker `role="option"` fix)
- `e2e/autocomplete.spec.ts` (E2E-A7 priority/due/scheduled anchors)
- `e2e/search-results.spec.ts` (E2E-A3 single-page contract pin)
- `e2e/search-history.spec.ts` (E2E-A10 per-space isolation)
- `pending/PEND-58g-search-view-review-2.md`, `SESSION-LOG.md`

**Verification:**
- `npx playwright test e2e/{search-filters,autocomplete,search-results,search-history}.spec.ts` — 47 passed, 0 failed.
- `npx tsc -b --noEmit` + `biome check` on the e2e files — clean.

**Process notes:** Build subagents wrote tests but did NOT run Playwright (one shared
dev server; parallel runs collide), so the orchestrator ran the suite once — which is
also what surfaced the pre-existing tag-picker failure. A concurrent agent was active
in `src-tauri/` (sync/recovery); all work here stayed in `e2e/` + docs and was staged
by name to avoid touching it.

**Commit plan:** single commit (Batch 6). Not pushed.

---

## Session 819 — PEND-58g search-view round-2: Batch 5 (filter-builder expansion + DSL cleanup) (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | 2 build (UX-A5 frontend; DSL-A3/A4/A6/A7) + 3 review (UX-A5 technical, UX-A5 UX/a11y, DSL technical); orchestrator-direct: TS-diagnostic fix, dead-i18n-key + stale-comment cleanup, docs/log |
| **Items closed** | UX-A5, DSL-A3, DSL-A4, DSL-A6, DSL-A7 |
| **Items modified** | PEND-58g (Batch 5 section; UX-A5 + DSL-A3/A4/A6/A7 removed from Remaining; suggested action order updated) |
| **Tests added** | +31 frontend (UX-A5: +17 FilterHelperPopover incl. per-category emit/toggle/disabled-gating, axe per form, +2 focus-on-open regression; DSL: +11 autocomplete quote/parity, +2 NFC, +1 brace-cap contract) |
| **Files touched** | 16 (src + tests) + 2 plan/log |

**Summary:** Filter-builder feature expansion plus search-DSL cleanup. **UX-A5** — the
`+ Filter` builder popover now offers the remaining structural categories
(`state` / `priority` / `due` / `scheduled` / `prop`), each with an include/exclude
toggle for the `not-` variants, via new sub-forms under
`src/components/search/filter-forms/`. The popover builds a `FilterToken` and routes
through the existing `addFilter` → `serialize` path (DSL untouched; purely additive
UI). Vocabulary is shared with the caret autocomplete — state + date buckets reuse the
now-exported `STATE_VALUES` / `DATE_BUCKET_VALUES`, priority reuses
`usePriorityLevels()`. Forms manage focus-on-open (Radix `SelectTrigger` swallows
`autoFocus`) and meet the 44px coarse-pointer convention. **DSL cleanup** — **DSL-A6**:
`isInsideQuote` now delegates to `tokenize()` so its quote model can't drift from the
parser; **DSL-A7**: removed the dead `tag:#` autocomplete arm; **DSL-A4**: NFC-normalise
tag names at the `astToFilterProjection` funnel so composed/decomposed Unicode tags
match the NFC-indexed backend (chip/serialized form stays verbatim); **DSL-A3**: pinned
the `expandBraces`/`EXPANSION_CAP` truncate-not-error parity contract (by-design scaffold,
no production caller) with a test + banner.

**REVIEW-LATER impact:**
- **PEND-58g open items:** closed UX-A5 (the Medium feature expansion) and the four
  DSL-A* low/info items. Remaining: BE-A5, UX-A8, UX-A10/A12/A13, FE-A18, BE-A7, FE-A19,
  and the E2E/test-coverage gaps.
- **Previously resolved:** 1318+ → 1323+ across 818 → 819 sessions.

**Files touched (this session):**
- `src/components/search/FilterHelperPopover.tsx` (UX-A5 — new categories + sub-form routing + `onAddFilter`)
- `src/components/search/filter-forms/{IncludeExcludeToggle,StateFilterForm,PriorityFilterForm,DateFilterForm,PropFilterForm}.tsx` (new)
- `src/components/SearchPanel.tsx` (UX-A5 — `handleAddFilter` wiring)
- `src/hooks/useAutocompleteSources.ts` (UX-A5 — export `STATE_VALUES`/`DATE_BUCKET_VALUES`)
- `src/lib/i18n/references.ts` (UX-A5 category/helper keys; dead `not*` keys dropped)
- `src/components/search/__tests__/FilterHelperPopover.test.tsx` (UX-A5 + focus tests)
- `src/lib/search-query/autocomplete.ts` (DSL-A6 `isInsideQuote`; DSL-A7 dead-arm removal; stale-comment cleanup)
- `src/lib/search-query/to-search-filter.ts` (DSL-A4 NFC)
- `src/lib/search-query/glob-validate.ts` (DSL-A3 banner)
- `src/lib/search-query/__tests__/{autocomplete,to-search-filter,glob-validate}.test.ts` (DSL tests)
- `pending/PEND-58g-search-view-review-2.md`, `SESSION-LOG.md`

**Verification:**
- `npx vitest run` (touched suites: FilterHelperPopover, SearchPanel, i18n, search-query) — 337 pass, 0 fail.
- `prek run` (Batch 5 scope) — all hooks pass. (NB: `--all-files` surfaces a
  *pre-existing, unrelated* cognitive-complexity error in
  `src/hooks/useAppKeyboardShortcuts.ts:248` `handleGlobalShortcuts` (40 > 25) — an
  untouched file pristine at HEAD, not introduced by Batch 5; flagged for a follow-up.)

**Process notes:** Two parallel build subagents on non-overlapping file sets (search UI/hooks vs `src/lib/search-query/`), reviews pipelined as each build landed. The UX/a11y review caught two real blockers the build missed — orphaned focus on sub-form open (Radix `SelectTrigger` ignores `autoFocus`) and a biome `useSemanticElements` failure on the `role="radio"` buttons — and fixed both with regression tests. The DSL "A3/A4" labels were swapped in the build report but both items were handled correctly.

**Commit plan:** single commit (Batch 5). Not pushed.

---

## Session 818 — PEND-58g search-view round-2: Batch 4 (mobile escalation CTA, touch targets, help icons) (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | 1 build (UX-A1 mobile CTA) + 1 review (combined technical/UX/a11y); orchestrator-direct: UX-A7, UX-A9 + their tests, docs/log |
| **Items closed** | UX-A1, UX-A7, UX-A9 |
| **Items modified** | PEND-58g (Batch 4 section; UX-A1/A7/A9 removed from Remaining; UX-A8 split out of its shared bullet and kept deferred with a design note) |
| **Tests added** | +9 frontend (UX-A1: 5 CommandPalette mobile-CTA incl. axe; UX-A7: 1 coarse-pointer; UX-A9: 2 help-dialog incl. axe; +1 helper) |
| **Files touched** | 7 (src + tests) + 2 plan/log |

**Summary:** Mobile/touch/a11y polish for the search view. **UX-A1** — the user chose
"better escalation only", so the mobile all-pages palette now renders an
always-visible, prominent two-line "Filters & regex / Open full search" CTA
(`showMobileEscalation` gate; the desktop inline footer and shared
`showEscalationFooter` are untouched). It's visible even on a cold/empty-query open, so
the path to toggles/filters/regex/history is discoverable. **UX-A7** — the history
rows, Clear-history, and enable/disable toggle gained `[@media(pointer:coarse)]:min-h-11`
44px targets. **UX-A9** — the help dialog's Toggles "Icon" column renders the toolbar's
`CaseSensitive`/`WholeWord`/`Regex` lucide icons (exact match to `SearchToggleRow`)
instead of `Aa`/`Ab|`/`.*` text.

**REVIEW-LATER impact:**
- **PEND-58g open items:** closed UX-A1 (the last High-priority correctness item), UX-A7,
  UX-A9; the "Remaining — Correctness / data bugs" section is now empty and removed.
  UX-A8 remains open (deferred: needs a touch-affordance design decision + runtime check).
- **Previously resolved:** 1315+ → 1318+ across 817 → 818 sessions.

**Files touched (this session):**
- `src/components/CommandPalette.tsx` (UX-A1 mobile CTA + `showMobileEscalation` gate)
- `src/lib/i18n/common.ts` (UX-A1 `searchSheet.escalateCtaTitle`/`escalateCtaHint`; reworded `escalateLabel`)
- `src/components/__tests__/CommandPalette.test.tsx` (UX-A1 — 5 mobile-CTA tests)
- `src/components/search/SearchHistoryDropdown.tsx` (UX-A7 coarse-pointer targets)
- `src/components/search/__tests__/SearchHistoryDropdown.test.tsx` (UX-A7 test)
- `src/components/help/SearchHelpDialog.tsx` (UX-A9 lucide icons)
- `src/components/help/__tests__/SearchHelpDialog.test.tsx` (new — UX-A9 tests)
- `pending/PEND-58g-search-view-review-2.md`, `SESSION-LOG.md`

**Verification:**
- `npx tsc -b --noEmit` — clean. `npx vitest run src/components` — 5843/5843 pass (1083 suites), incl. the coarse-pointer test under the full sweep.
- `prek run` (staged scope) — hooks pass. (NB: `--all-files` was NOT used — the working tree carries unrelated in-progress changes from another agent: ring-inset focus rings in 8 components + a `WEBKIT_DISABLE_DMABUF_RENDERER` fix in `src-tauri/src/lib.rs`. Batch 4 staged only its own files.)

**Process notes:** UX-A8 was scoped but deferred — Radix tooltips don't fire on
touch-tap and inline labels overflow a phone row, so a real touch-affordance design +
runtime verification is needed rather than a half-baked fix. A build subagent
misattributed a timing artifact (the coarse-pointer test ran before the toggle-button
class landed) to "test ordering"; confirmed benign — `toHaveClass` is order-independent.

**Commit plan:** single commit (Batch 4), staged by name to exclude the unrelated WIP. Not pushed.

---

## Session 817 — PEND-58g search-view round-2: Batch 3 (filter-only search, regex-mode autocomplete + cue) (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | 2 build (backend NEW-3 · frontend NEW-1/NEW-2) + 3 review (backend technical w/ mutation testing · frontend technical · frontend UX); orchestrator-direct: docs, stale-comment update, i18n polish, formatting |
| **Items closed** | NEW-1, NEW-2, NEW-3 |
| **Items modified** | PEND-58g (Batch 3 section added; "New follow-ups" section cleared; action order renumbered); PEND-68 (markdownlint MD040/MD004 fix, separate commit) |
| **Tests added** | +5 frontend (2 autocomplete-contract, 3 regex-cue incl. axe) / +13 backend (`new3_*`, incl. the exact-multiple `has_more` boundary added by the reviewer) |
| **Files touched** | 11 (src + src-tauri + docs) + 2 plan/log (+ PEND-68 in its own commit) |

**Summary:** Actioned Batch 3 — the cluster-1 follow-ups. **NEW-3 (filter-only
search):** a blank free-text query carrying ≥1 structural filter now returns the
filtered blocks recency-ordered (`b.id DESC`) instead of empty, in BOTH the cursor and
partitioned paths and mode-independent. FTS5 MATCH can't express "match all", so a new
`filter_only_scan` (+ `fts_fetch_filter_only_page` cursor / `fts_fetch_filter_only_partitioned`)
bypasses FTS/regex; the old blank-query short-circuits in `search_blocks_inner` /
`search_blocks_partitioned_inner` were removed (the decision moved into
`search_with_toggles*`). `space_id` is excluded from the "has filters" test (always
supplied), so a space-only blank query still returns empty. **NEW-1 (regex-mode prefix
autocomplete):** the over-broad `suppressed={isRegex}` gate is gone — the caret anchor
detector already returns null on free-text, so filter prefixes (`tag:`, `state:`, …)
autocomplete in regex mode while the regex remainder stays suppressed. **NEW-2 (regex
cue):** the input gains a regex placeholder + monospace + an sr-only `aria-describedby`
hint when regex mode is on. Also fixed the two markdownlint errors in PEND-68 (separate
commit).

**REVIEW-LATER impact:**
- **PEND-58g open follow-ups:** 3 → 0 (NEW-1/NEW-2/NEW-3 closed; the "New follow-ups"
  section removed and the suggested action order renumbered to start at UX-A1).
- **Previously resolved:** 1312+ → 1315+ across 816 → 817 sessions.

**Files touched (this session):**
- `src-tauri/src/fts/toggle_filter.rs` (+~410 — `filter_only_scan`, `fts_fetch_filter_only_page`, `fts_fetch_filter_only_partitioned`, blank-query dispatch in `search_with_toggles*`)
- `src-tauri/src/commands/queries.rs` (removed leading empty-query short-circuits + dead `empty_partition()`)
- `src-tauri/src/fts/tests.rs` (+~700 — `new3_*` tests + helpers)
- `src/components/SearchPanel.tsx` (drop `suppressed`, add `regexMode`; refreshed the stale `enabled`-gate comment)
- `src/components/SearchPanel/SearchAutocomplete.tsx` (removed the `suppressed` prop; anchor memo unconditional)
- `src/components/SearchPanel/SearchHeader.tsx` (regex placeholder + `font-mono` + sr-only `aria-describedby` hint)
- `src/components/__tests__/SearchPanel.autocomplete.test.tsx`, `src/components/__tests__/SearchPanel.toggles.test.tsx`
- `src/lib/i18n/references.ts` (`search.searchPlaceholderRegex`, `search.regexModeHint`)
- `docs/SEARCH.md`, `docs/architecture/search.md` (filter-only path + regex-mode autocomplete)
- `pending/PEND-58g-search-view-review-2.md`, `SESSION-LOG.md`
- `pending/PEND-68-page-actions-and-recent-quick-nav.md` (separate commit — MD040/MD004 fix)

**Verification:**
- `cd src-tauri && cargo nextest run` — 3954 passed, 0 failed, 6 skipped.
- `prek run --all-files` — all hooks pass (after applying `cargo fmt` + biome formatting to the new tests / the wrapped placeholder).

**Lessons learned (for future sessions):**
- Precise, fully-designed build prompts paid off: all 5 subagents finished without the
  session-limit deaths that plagued Batch 2. For a cohesive cross-cutting backend change
  (NEW-3), front-loading the exact SQL/cursor design into the subagent prompt — rather
  than "implement filter-only search" — was the difference.
- Mutation testing in the backend review caught a real gap a reading review would miss:
  the `has_more` `>`→`>=` mutation only diverges when the filtered set is an exact
  multiple of the page limit, which the original fixture never hit. Re-applied the
  Batch-2 lesson too: independent `grep MUTATION` + boundary-residue scan after the
  mutation-testing review (clean this time).

**Commit plan:** two commits — (1) `docs(pending)` PEND-68 markdownlint fix; (2) `feat(search)` PEND-58g Batch 3. Not pushed.

---

## Session 816 — PEND-58g search-view round-2: Batch 2 (pagination/has_more, FilterHelperPopover a11y, docs, priority autocomplete) (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | 3 build (backend Cluster-2 · FilterHelperPopover · docs) + 5 review/recovery (docs, backend test-writer, backend re-review, FilterHelperPopover+NEW-4, + a stuck/dead-agent recovery); orchestrator-direct: FilterHelperPopover combobox completion, NEW-4, leftover-mutation revert |
| **Items closed** | SQL-A1, SQL-A2, SQL-A3/BE-A1, BE-A10, FE-A20, UX-A3, UX-A6, DOC-A4, DOC-A7, DOC-A8, DOC-A9, NEW-4 |
| **Items modified** | PEND-58g trimmed (Batch 2 section; Docs section cleared; UX-A5 kept deferred) |
| **Tests added** | +frontend (FilterHelperPopover 16, useAutocompleteSources +2) / +backend (7 `be_a10_*` pagination tests) |
| **Files touched** | 9 (src + src-tauri + docs) |

**Summary:** Actioned Batch 2 of the PEND-58g round-2 review. **Cluster 2
(pagination/`has_more`):** the cursor over-cap now REJECTS (mirrors the partitioned
BE-2 contract) instead of silently capping (SQL-A1); the regex partitioned `has_more`
is correct at exactly the cap (SQL-A2 — clamp widened to `MAX_SEARCH_RESULTS+1`); and
the case/word post-filter no longer under-fills pages or drops rows — a new
filter-aware `fts_fetch_post_filtered_page` over-fetches candidate windows (FTS cursor
advances by last candidate; `next_cursor` = last returned survivor), with the
partitioned path over-fetching to the ceiling then truncating (SQL-A3/BE-A1). Seven
`be_a10_*` tests lock it, each verified to fail under an 8-mutation battery.
**FilterHelperPopover hardening:** debounce + latest-wins race guard (FE-A20),
i18n (UX-A3), and an ARIA combobox/listbox tag picker with arrow/enter/escape (UX-A6).
**Docs:** DOC-A4/A7/A8/A9. **NEW-4:** priority autocomplete suggested stale `A/B/C`
while the parser uses numeric `1/2/3` — now derives from the configurable
`usePriorityLevels()` (surfaced by the DOC-A7 work).

- **Process / resilience.** Both Batch-2 build subagents hit a session limit mid-task;
  their compiling-but-untested work was salvaged (backend logic was correct — the
  test-writer found no bugs and added the missing tests; FilterHelperPopover's combobox
  was finished orchestrator-direct). A retry subagent stuck with an empty transcript was
  stopped via `TaskStop`. The first backend *review* subagent died leaving a
  `// MUTATION-2` in the tree (it was mutation-testing per its brief and never
  reverted); the orchestrator caught it via a `grep MUTATION` + diff read and reverted
  it, then a fresh re-review re-verified from a clean baseline and strengthened one
  tautological bound test.

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-58g Batch 2 (12 findings) closed; Docs section now
  empty; remaining = UX-A1, UX-A5, the low-priority UX/maintainability items, the e2e
  gaps, and follow-ups NEW-1/2/3.
- **Previously resolved:** 1300+ → 1312+ across 815 → 816 sessions.

**Files touched (this session):**
- backend: `src-tauri/src/fts/search.rs`, `src-tauri/src/fts/toggle_filter.rs`, `src-tauri/src/commands/queries.rs`, `src-tauri/src/fts/tests.rs`
- frontend: `src/components/search/FilterHelperPopover.tsx`, `src/hooks/useAutocompleteSources.ts`, + tests (`FilterHelperPopover` (new), `useAutocompleteSources`), `src/lib/i18n/references.ts`
- docs: `docs/SEARCH.md`, `docs/architecture/search.md`, `pending/PEND-58g-search-view-review-2.md`

**Verification:**
- `cd src-tauri && cargo nextest run` — full suite green (fts: 254 passed).
- `npx vitest run` + `npx tsc -b --noEmit` — green.
- `prek run --all-files` — all hooks pass.

**Process notes:** No bindings/SQL/migration changes (pagination logic is Rust-side;
no `query!` macros touched) so no `bindings.ts` / `sqlx prepare` regen. Subagent
session-limit deaths are recoverable but require the orchestrator to (a) verify the
salvaged tree compiles, (b) `grep MUTATION` after any mutation-testing review, and
(c) re-run the gate — don't trust a cut-off agent's unreported state.

**Commit plan:** single commit on `pend-58f-search-view-hardening`; not pushed.

---

## Session 815 — PEND-58g search-view round-2: Batch 1 (regex filters, a11y, DSL, docs, regex-path robustness) (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | 5 build (SearchPanel/Cluster-1 · search a11y · DSL · docs · backend regex-robustness) + 6 review (DSL, docs, a11y, backend, SearchPanel-technical, SearchPanel-UX); orchestrator-direct integration (FE-A8 `resetKey` wiring, UX-review fixups) |
| **Items closed** | DSL-A8/UX-A4 (cluster 1), FE-A5/A7/A8 (cluster 3), DSL-A1, DOC-A1/A2/A3/A5/A6, BE-A4, SQL-A4/A5/A6, FE-A13, FE-A12, UX-A11, UX-A2 |
| **Items modified** | BE-A10 (regex-under-cancellation half now covered); PEND-58g trimmed + 3 new follow-ups (NEW-1/2/3) |
| **Tests added** | +frontend (SearchPanel toggles/grouping, SearchResultGroups, useListKeyboardNavigation, classify) / +backend (fts: regex tag-filter contract, raw-len guard, mixed-case tag dedup, partitioned regex cancellation) |
| **Files touched** | 17 (src + src-tauri + docs) |

**Summary:** Actioned Batch 1 of the PEND-58g round-2 review across five
file-disjoint build subagents, pipelined with six review subagents (two dimensions —
technical + UX — for the user-facing SearchPanel change). **Headline (Cluster 1):**
structural filters (`tag:`/`path:`/`state:`/…) now apply in **regex mode**. The user
chose "apply filters in regex mode"; investigation showed the backend `regex_mode_query`
already binds every filter — the bug was frontend-only (`regexModeFilterParams()`
zeroed them and the full query was sent as the pattern). Fix: regex mode is now
symmetric with FTS mode — filter tokens are parsed out and applied as SQL filters;
the free-text remainder is the regex pattern. **Cluster 3 (a11y):** the FE-3
virtualization vs roving-listbox regressions — focus clamps instead of resetting to
row 0 on collapse/Load-More (FE-A8, wired via `resetKey={debouncedQuery}`), the
results region stays tabbable when no row is focused (FE-A7), and the active row gets
a page-level `scrollIntoView` across groups (FE-A5). Plus DSL-A1 (quoted-phrase
whitespace), the doc accuracy set (DOC-A1/A2/A3/A5/A6), regex-path backend robustness
(BE-A4 cancellation, SQL-A4 raw-length guard, SQL-A5 dead code, SQL-A6 ULID dedup),
and four SearchPanel fixes (FE-A13 aria parity, FE-A12 ast reuse, UX-A11 info-styled
hint, UX-A2 single-announce invalid-regex).

- **Review-driven corrections (orchestrator-direct):** the UX reviewer caught stale
  copy now that filters apply in regex mode — fixed the in-app help string
  (`references.ts`) and a contradictory `SEARCH.md` line. The technical reviewer
  flagged a filter-only-regex empty-result path; verified it's **pre-existing and
  symmetric** (the cursor `search_blocks_inner` short-circuits any blank query in
  both modes, not a regex regression) → logged as NEW-3 instead of force-fixing. The
  FE-A13 fix initially advertised `aria-controls` for a listbox that doesn't render
  in the history-off+empty case; corrected so the combobox aria tracks the actual
  listbox (`historyListboxVisible`).
- **Deferred (collide on the same files / own focused session):** Cluster 2
  pagination/`has_more` (SQL-A1/A2/A3/BE-A1), the FilterHelperPopover cluster
  (UX-A3/A5/A6, FE-A20), UX-A1 mobile parity, FE-A18 hook extraction, and the e2e
  gaps — all carried in PEND-58g.

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-58g Batch 1 (19 findings) closed; file trimmed to
  the remaining clusters + 3 new follow-ups.
- **Previously resolved:** 1281+ → 1300+ across 814 → 815 sessions.

**Files touched (this session):**
- frontend: `src/components/SearchPanel.tsx`, `src/components/SearchPanel/SearchStatusRegion.tsx`,
  `src/components/search/SearchResultGroups.tsx`, `src/components/search/VirtualizedResultListbox.tsx`,
  `src/hooks/useListKeyboardNavigation.ts`, `src/lib/search-query/classify.ts`,
  `src/lib/i18n/references.ts`, + tests (`SearchPanel.toggles`, `SearchPanel.grouping`,
  `SearchResultGroups`, `useListKeyboardNavigation`, `classify`)
- backend: `src-tauri/src/fts/toggle_filter.rs`, `src-tauri/src/fts/search.rs`, `src-tauri/src/fts/tests.rs`
- docs: `docs/SEARCH.md`, `docs/architecture/search.md`, `pending/PEND-58g-search-view-review-2.md`

**Verification:**
- `npx vitest run` — 10591 passed.
- `npx tsc -b --noEmit` — clean.
- `cd src-tauri && cargo nextest run` — 3934 passed, 6 skipped.
- `prek run --all-files` — all hooks pass.

**Process notes:** No bindings/SQL/migration changes (Cluster 1 was frontend-only;
backend robustness was Rust-side only) so no `bindings.ts` / `sqlx prepare` regen.
`tsc -b` (not `tsc --noEmit`) is the real type gate — the root `tsconfig.json` has
`files: []`, so a bare `tsc --noEmit` checks nothing; the prek `tsc` hook (`tsc -b`)
caught test-file type errors a plain `tsc --noEmit` missed.

**Commit plan:** single commit on `pend-58f-search-view-hardening`; not pushed.

---

## Session 814 — PEND-58f search-view: hardening + performance trilogy (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | 5 build (backend SQL/BE, docs, e2e coverage, UX-3 i18n, FE-2, FE-3) + orchestrator-direct (DSL, FE correctness, UX wire-ups, FE-9/FE-10) |
| **Items closed** | DSL-1/2/3/4/5/10, FE-1/2/3/4/5/6/8/9/10/11/12/13/14, UX-1/2/3/4/5/7/8/9/10/11/12/15, SQL-1/3/4/5/6/7/8/9, BE-1/3/4/5/6/8/9, DOC-1/2/3/4/6/7/8/9/10/11, E2E-1/3..10 |
| **Items modified** | E2E-2 (covered + underlying onError bug fixed) |
| **Tests added** | +large (DSL/store/hook/component vitest, 6 new e2e search specs ~47 tests, Rust SQL/BE tests) |
| **Files touched** | ~45 across `src/`, `src-tauri/`, `e2e/`, docs |

**Summary:** Actioned the PEND-58f search-view deep-review findings across SQL/FTS,
backend Rust/IPC, the search-query DSL, the SearchPanel/autocomplete UI, stores/hooks,
docs and e2e. The performance trilogy: FE-2 (abort superseded searches via
AbortController), FE-3 (per-group results virtualization preserving the roving-listbox
a11y), FE-10 (caret state isolated into `<SearchAutocomplete>` so caret moves don't
re-render the panel). Also wired up + i18n'd the SearchHelpDialog (UX-1/3), fixed the
invalid-regex inline error (E2E-2), and added `scripts/push.sh` (verify-then-push) to
fix the long-pre-push-hook SSH timeout.

**Files touched (highlights):**
- `src/components/SearchPanel.tsx`, `src/components/SearchPanel/SearchAutocomplete.tsx` (new),
  `src/components/SearchPanel/useTagResolution.ts` (new), `useFilterSyntaxIntroToast.ts` (new)
- `src/components/search/SearchResultGroups.tsx`, `VirtualizedResultListbox.tsx` (new),
  `SearchHistoryDropdown.tsx`, `SearchHelpDialog.tsx`
- `src/hooks/usePaginatedQuery.ts`, `src/lib/tauri.ts`, `src/lib/search-query/*`
- `src-tauri/src/fts/*`, `src-tauri/src/commands/queries.rs`, `src-tauri/src/filters/primitive.rs`
- `e2e/search-*.spec.ts` (new), `scripts/push.sh` (new), docs

**Verification:**
- `npx tsc -b --noEmit` clean; `prek run --all-files` pass; full vitest + Playwright + cargo green.

**Commit plan:** pushed to `pend-58f-search-view-hardening` (separate PR from PEND-58 / PR #48).

---

## Session 813 — PEND-58e: Pages-view deep-review findings, fully actioned (E1–E21) (2026-05-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-22 |
| **Subagents** | 5 build (Rust-filters · Rust-materializer · filter-UI · PageBrowser-logic · tauri-mock), parallel by file-ownership + orchestrator-direct (docs, E14 sibling, prek fixups). Verification: full-suite + diff review by orchestrator (no separate review subagents). |
| **Items closed** | PEND-58e E1–E21 (all 21 post-verification findings) |
| **Items modified** | PEND-58d (deep-review-findings note cleared; only deferred D23a remains) |
| **Tests added** | +28 frontend unit (vitest 10497→10525) + e2e cursor-contract/same-page (F3) / +4 backend non-ignored (nextest 3908→3912) + 1 `#[ignore]` perf gate |
| **Files touched** | 25 (+ the PEND-58e plan file removed) |

**Summary:** Actioned every confirmed finding from the second whole-feature deep review (E1–E21) across SQL, backend Rust, frontend React, the tauri-mock, and docs, in five parallel file-disjoint subagents plus orchestrator-direct docs. **P1:** the Priority facet now drives its offered values from `usePriorityLevels()` (was a hardcoded `A/B/C` against `1/2/3` data → zero matches out of the box) (E1); `docs/PAGES.md`'s limitations note rewritten so it no longer contradicts the shipped D24 exclude / not-equals / not-exists controls (E2). **P2:** `LastEdited` custom Range extends a bare `YYYY-MM-DD` `end` to the last instant of the day (`T23:59:59.999Z`), fixing silent loss of end-day edits (E3); cross-page `MoveBlock` recomputes `child_block_count` for both source and destination pages in-tx and enqueues `RebuildPagesCache` after `RebuildPageIds`, fixing latent count drift (E4); the `tag:` placeholder corrected to "Tag id" and a `tagResolver` wired so the chip shows the tag name (E5); filter pills truncate with `max-w` + title tooltip (E6); the count chip + SR announcement use a distinct matched-**page** count instead of the grouped-row array, fixing namespaced/starred mis-counts (E7); `docs/architecture/filters.md` updated to the D8 `HasProperty { predicate: PropertyPredicate }` shape (E8). **P3:** EXPLAIN tests now plan the IPC's REAL composed SQL via a `#[cfg(test)]` accessor (E9); the materializer parity helper derives counts from first principles (breaks the shared-shape blind spot) + a cross-page-move parity test (E10); `Orphan` reranked to cost tier 3 (its outbound half is a correlated subquery) with realistic perf-gate seeds (link skew, op-log depth) + a filtered-query gate (E11); the tauri-mock mirrors the backend — null `total_count` on cursor pages, emits `RequiresRefresh:`, same-page inbound exclusion — with e2e coverage (E12); count-chip basis shares one "loaded" denominator under a text query (E13); client re-sort tiebreaks by `id ASC` to match the server keyset, in both `usePageBrowserGrouping` and `usePageBrowserSort` (E14); the delete decrement moved out of the `setPages` updater (StrictMode double-fire) (E15); clear-all announces a single dedicated SR message (E16); `sortTopLevelUnits` decorates-once instead of allocating per comparison (E17); the `InvalidFilter:` error prefix is recognised with a specific toast (E18); popover descriptions for the five value facets + clear-all documented (E19); dead `pageBrowser.export*` i18n keys removed (E20); stale recompute comment anchors corrected to cite migration 0070 + `recompute_pages_cache_counts_for_pages` (E21).

- **Parallelization.** Five subagents on disjoint file sets — two Rust by module (filters/validation vs materializer), three frontend by ownership (filter-UI vs PageBrowser+grouping vs tauri-mock). `src/lib/i18n/pages.ts` was shared by two frontend agents but only via surgical, non-overlapping edits (placeholder/descriptions/removals vs two new keys) and reconciled clean. Docs and the E14 `usePageBrowserSort` sibling were orchestrator-direct.
- **No migrations; no IPC type change** — Priority levels were already on the wire as strings, so `src/lib/bindings.ts` is unchanged.

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-58e fully resolved and its plan file removed; PEND-58d now lists only the deferred D23a.
- **Previously resolved:** 1260+ → 1281+ across 812 → 813 sessions.

**Files touched (this session):**
- backend: `src-tauri/src/filters/primitive.rs`, `commands/pages.rs`, `commands/tests/list_pages_with_metadata_tests.rs`, `materializer/handlers.rs`, `materializer/dispatch.rs`, `materializer/tests.rs`
- frontend: `src/components/PageBrowser.tsx`, `PageBrowser/AddFilterPopover.tsx`, `PageBrowser/PageBrowserFilterRow.tsx`, `src/components/ui/filter-pill.tsx`, `src/hooks/usePageBrowserGrouping.ts`, `src/hooks/usePageBrowserSort.ts`, `src/lib/i18n/pages.ts`, `src/lib/tauri-mock/handlers.ts`, `src/lib/tauri-mock/seed.ts`, + tests (`__tests__/PageBrowser.test.tsx`, `PageBrowser/__tests__/{AddFilterPopover,PageBrowserFilterRow}.test.tsx`, `ui/__tests__/filter-pill.test.tsx`, `hooks/__tests__/{usePageBrowserGrouping,usePageBrowserSort}.test.ts`, `src/lib/__tests__/tauri-mock.test.ts`, `e2e/pages-view.spec.ts`)
- docs/meta: `docs/PAGES.md`, `docs/architecture/filters.md`, `pending/README.md`, `pending/PEND-58e-pages-view-deep-review-findings.md` (removed)

**Verification:**
- `cd src-tauri && cargo nextest run` — 3912 passed, 6 skipped.
- `npx vitest run` — 10525 passed; `npx tsc -b` — clean.
- `prek run --all-files` — all hooks pass.
- `scripts/verify-ci-equivalent.sh` (full pre-push: vitest + cargo + **playwright e2e** + sqlx + MCP smoke) — PASSED.

**Process notes:** The pre-push CI-equivalent (which prek does *not* cover — it adds the full Playwright e2e + sqlx-prepare check) surfaced flakes and a few real e2e breaks that the per-builder vitest gate missed. Stabilized in a follow-up commit: (1) the e2e value-facet selectors and the priority/tag fixtures were updated for the E1/E5/E19 behaviour changes (e2e is not in the prek gate, so the build subagents couldn't have caught these); (2) F3's E12 same-page seed edge was reverted off the shared "Quick Notes" fixture (it reordered rendered blocks and broke the editor/keyboard/inner-links specs) — the same-page exclusion is now covered by a runtime mock unit test instead; (3) **pre-push reliability**: `verify-ci-equivalent.sh` now serializes the vitest and cargo phases (they oversubscribed the box and starved timing-sensitive frontend tests — CI never hits this because it shards them onto separate runners), `src/test-setup.ts` raises the Testing-Library `asyncUtilTimeout` so `axe()` audits survive CPU pressure, and `playwright.config.ts` caps local workers + enables local retries to match CI.

**Commit plan:** two commits onto `pend-58-phase2-pages-primitives` (PR #48) — the PEND-58e delivery, then the e2e/pre-push stabilization — both pushed.

---

## Session 812 — PEND-58d: comprehensive Pages-view e2e suite + deep review kickoff (2026-05-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-22 |
| **Subagents** | 1 build (e2e) + 5 review (SQL · backend · frontend · UX · testing — read-only, findings-only). Adversarial verification round + maintainer presentation follow. |
| **Items closed** | PEND-58d comprehensive e2e suite (the last fix task) |
| **Items modified** | PEND-58d (only deferred D23a + the open deep-review findings remain) |
| **Tests added** | +36 e2e (new `pages-view.spec.ts`) + repaired 11 in `pages-filter.spec.ts` |
| **Files touched** | 5 |

**Summary:** Built the behavioural Playwright suite covering every Pages-view capability — new `e2e/pages-view.spec.ts` (36 tests across 13 describe blocks) plus an extended/repaired `e2e/pages-filter.spec.ts` (19), 55 passing and stable across three runs. Coverage spans facet narrowing (each facet incl. the four last-edited buckets, path substring/anchored/exclude, property exists/is/is-not/doesn't-exist), compound AND + widen + soft-cap, zero-result + recovery, clear-all, the three count-chip bases, search/alias/chip orthogonality, all seven sorts + the frontend-sort cue + persistence, density toggle + persistence, pagination/windowing, CRUD + star grouping, flag default-on/opt-out, metadata badges, cursor re-pagination, a11y (arrow-key + `aria-activedescendant` + axe in filtered/zero-result/popover-open states), and responsive header wrap. The seed gained one opt-in `seedFacetFixturePage()` (page-level tag+priority) so the Tag/Priority facets narrow to a concrete set without disturbing the default 6-page seed. Two areas are explicitly not reachable in the mock harness and were noted rather than faked: cursor `RequiresRefresh` recovery (the mock never emits that AppError) and "export all pages" (no wired UI; the `pageBrowser.exportAll` key is orphaned).

- **Process catch:** D24's facet descriptions had broken 11 existing e2e selectors on the branch — e2e is not in the prek gate, so the Session 811 commit shipped with the e2e suite red. The e2e builder repaired them (anchored `^Label` regex helper) and added a chip-dedupe test.
- **Deep review (in flight):** five read-only perspective reviewers (SQL/data, backend Rust, frontend React, product/UX, testing/e2e) plus an adversarial verification round are producing a triaged findings report for the maintainer; those findings are NOT actioned in this session (the maintainer decides).

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-58d fix scope complete; deferred D23a + the deep-review findings remain (tracked in `pending/`).
- **Previously resolved:** 1259+ → 1260+ across 811 → 812 sessions.

**Files touched (this session):**
- `e2e/pages-view.spec.ts` (new), `e2e/pages-filter.spec.ts`, `src/lib/tauri-mock/seed.ts`
- docs/meta: `pending/PEND-58d-pages-view-hardening.md`, `pending/README.md`

**Verification:**
- `npx playwright test e2e/pages-view.spec.ts e2e/pages-filter.spec.ts` — 55 passed (stable ×3).
- `npx vitest run src/lib/__tests__/tauri-mock.test.ts` — 241 passed (seed change is opt-in); `npx tsc -b --noEmit` — clean.
- `prek run --all-files` — all hooks pass.

**Commit plan:** committed onto `pend-58-phase2-pages-primitives` (PR #48). Not pushed.

---

## Session 811 — PEND-58d P2+P3: Pages-view hardening (HasProperty reshape, count-basis, clear-all, validation, +20 fixes) (2026-05-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-22 |
| **Subagents** | 7 build (backend-core · tauri-mock · PageBrowser+Header · popover+filter-row · RowRenderer-test · HasProperty-backend · HasProperty-frontend) + orchestrator-direct (D27 docs, i18n pre-add, docs/PAGES.md). Deep multi-perspective review deferred to its own user-requested phase. |
| **Items closed** | PEND-58d P2 (D5–D15) + P3 (D16–D27), except D23a (deferred). All backend/frontend unit + tauri-mock tests (T-B2/B3/B4/B7, T-F1–F4, T-M1/M2). |
| **Items modified** | PEND-58d (only the comprehensive e2e suite + D23a remain) |
| **Tests added** | +~45 frontend / +~18 backend |
| **Files touched** | 24 |

**Summary:** Shipped every P2/P3 finding of the whole-feature review across SQL, backend Rust, frontend React, and docs — 22 items in two waves of parallel subagents. **Backend:** `RecentlyModified` perf gate + ceiling doc (D5); `total_count` gated to the first page, FE retains it (D6); `LastEdited` NULL symmetry via a common epoch sentinel (D7) + date validation (`InvalidDateFilter:`, D15); `Orphan` outbound now joins the target and excludes deleted/same-page edges (D19); `WhereClause.unsupported` became a boolean field (D18); module doc fix (D16); `Space` kept + documented as a harmless no-op (D17). **HasProperty overhaul (D8 + D26):** the IPC type was reshaped from `{op, value: Option}` to a nested `predicate: PropertyPredicate` (`Exists | NotExists | Eq{value} | Ne{value}`) so invalid states are unrepresentable; all predicate × `Text`/`Ref` combos now compile (incl. the previously-rejected `value_ref` / `Ne` cases); bindings regenerated; the popover, summary, and tauri-mock migrated to the new shape. **Frontend:** load-more wrapped in `role="row"`/`gridcell` (D9); optimistic-create reloads under active chips (D10); count-chip basis fixed with a `countMatching` branch (D11); clear-all control (D12); header `flex-wrap` (D13); empty-value Apply disabled (D14); count decremented on delete (D20); HasProperty editor `autoFocus`+Enter (D21); chip dedupe (D22); `aria-activedescendant` guarded to rendered rows (D23b); D24 added the path-`exclude` toggle, property op selector (is/is-not/exists/doesn't-exist), and per-facet chip tooltips with distinct Orphan vs No-inbound copy; popover focus model + dead/redundant i18n cleanup (D25). **Docs:** AGENTS.md + `docs/architecture/filters.md` reconciled to the current Pages-only reality (D27); `docs/PAGES.md` documents the new controls. **tauri-mock** now genuinely filters PathGlob/HasProperty/LastEdited and returns a real `total_count` (T-M1), unblocking behavioural e2e.

- **Parallelization.** Wave 1 ran 5 subagents on disjoint files (one Rust-backend, three frontend by component-ownership, one tauri-mock) — Rust and TS compile independently, and the frontend split avoided shared-file conflicts; the `onClearAll` prop contract was specified to both sides and converged on tsc. i18n keys were pre-added orchestrator-side. Wave 2 sequenced the HasProperty IPC reshape (backend → bindings regen → frontend consumers) because it crosses the wire boundary.
- **Measured, not assumed.** D5's ceiling note is a `//` (not `///`) comment — a doc comment would have drifted `src/lib/bindings.ts` (specta emits doc comments) and failed the bindings-parity test.

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-58d P2+P3 resolved; only the comprehensive e2e suite + the deferred D23a remain (kept listed in `pending/README.md`).
- **Previously resolved:** 1258+ → 1259+ across 810 → 811 sessions.

**Files touched (this session):**
- backend: `src-tauri/src/filters/primitive.rs`, `src-tauri/src/filters/mod.rs`, `src-tauri/src/commands/pages.rs`, `src-tauri/src/commands/tests/list_pages_with_metadata_tests.rs`
- frontend: `src/components/PageBrowser.tsx`, `PageBrowser/PageBrowserHeader.tsx`, `PageBrowser/AddFilterPopover.tsx`, `PageBrowser/PageBrowserFilterRow.tsx`, `src/lib/tauri-mock/handlers.ts`, `src/lib/tauri-mock/seed.ts`, `src/lib/i18n/pages.ts`, `src/lib/bindings.ts` (specta regen), + tests (`__tests__/PageBrowser.test.tsx`, `PageBrowser/__tests__/{PageBrowserHeader,AddFilterPopover,PageBrowserFilterRow,PageBrowserRowRenderer}.test.tsx`, `src/lib/__tests__/tauri-mock.test.ts`)
- e2e: `e2e/pages-filter.spec.ts` (stale fixme removed)
- docs/meta: `AGENTS.md`, `docs/architecture/filters.md`, `docs/PAGES.md`, `pending/PEND-58d-pages-view-hardening.md`, `pending/README.md`

**Verification:**
- `cd src-tauri && cargo nextest run` — 3908 passed, 5 skipped.
- `npx vitest run` — 10497 passed; `npx tsc --noEmit -p tsconfig.app.json` — clean.
- `prek run --all-files` — all hooks pass.

**Process notes:** The comprehensive e2e suite (Session 812) and the user-requested deep multi-perspective review + adversarial verification follow this commit.

**Commit plan:** committed onto `pend-58-phase2-pages-primitives` (PR #48), same-PR convention. Not pushed.

---

## Session 810 — PEND-58d P1: Pages-view hardening (PathGlob, inbound-count, sort cue, cost-reorder) (2026-05-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-22 |
| **Subagents** | 3 build (filters/D1+D4 · materializer/D2 · frontend/D3) + 2 review (frontend · backend) + orchestrator-direct (D1 `cost_hint`/EXPLAIN-test correction, docs) |
| **Items closed** | PEND-58d P1: D1, D2, D3, D4 |
| **Items modified** | PEND-58d (P2/P3/Testing/e2e remain) |
| **Tests added** | +7 frontend / +4 backend (plus stale-shape parity-test repairs) |
| **Files touched** | 16 |

**Summary:** Shipped the four P1 (correctness/perf) findings of the whole-feature review. **D1:** `PathGlob` now compiles to the documented `title COLLATE NOCASE LIKE ? ESCAPE '\'` via a `glob_to_like` translator (`*`→`%`, `?`→`_`, bare word → `%substring%`), fixing the user-visible inversion (the old `LOWER(title) GLOB ?` matched an *exact* lowercased title for a bare word while the docs promised a substring) and dropping the per-row `LOWER()`. **D2:** the materialised `pages_cache.inbound_link_count` now excludes same-page / self / deleted-source edges — mirroring `backlink/grouped.rs` — via a corrected materializer recompute + a one-shot migration-0070 backfill, so `Orphan` / `HasNoInboundLinks` / `MostLinked` / the `↗N` badge stop over-counting. **D3:** a muted "Sorted within loaded pages" cue (with tooltip) surfaces when a frontend-only sort (`alphabetical`/`recent`/`created`) is active while more pages are unloaded, so the in-page-only ordering at scale is no longer silent. **D4:** a cost-reorder IPC test exercises the `[Priority(cost1), Tag(cost0)]` → Tag-first stable-sort + `?`→`?N` bind-renumber path that both prior compound-filter tests missed.

- **Key discovery (measured, not assumed).** The plan assumed `title COLLATE NOCASE LIKE ?` would be index-backed. It is **not**: SQLite (3.50.6, the family sqlx bundles) won't use a NOCASE index — nor a `LOWER(title)` expression index — for a *case-insensitive* `LIKE`; only an explicit `COLLATE NOCASE >= p AND < p++` range hits the index. Since `pages_cache` is one row per page (a title scan is sub-ms) and a hand-rolled NOCASE prefix range is Unicode-fiddly, the scan was accepted and `cost_hint` made truthful (all `PathGlob` = full scan) rather than asserting an index hit that never happens. The builder's EXPLAIN test (which asserted the index) was replaced with a compiled-shape regression guard.
- **Review caught two stale parity tests** still on the old over-counting inbound shape (`op_log.rs` post-migration parity test — `PAGE_B` 3→2 once a deleted source is excluded — and a `refresh_page_cache_counts` test helper); both were realigned to the D2 shape so they lock the real contract instead of masking a regression.

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-58d P1 resolved; P2 (D5–D15), P3 (D16–D27), and the Testing/e2e expansion remain (kept listed in `pending/README.md`).
- **Previously resolved:** 1257+ → 1258+ across 809 → 810 sessions.

**Files touched (this session):**
- backend: `src-tauri/src/filters/primitive.rs`, `src-tauri/src/commands/pages.rs`, `src-tauri/src/commands/tests/list_pages_with_metadata_tests.rs`, `src-tauri/src/materializer/handlers.rs`, `src-tauri/src/materializer/tests.rs`, `src-tauri/src/op_log.rs`, `src-tauri/migrations/0070_pages_cache_inbound_link_count_exclude_same_page.sql` (new)
- frontend: `src/hooks/usePageBrowserSort.ts`, `src/components/PageBrowser.tsx`, `src/components/PageBrowser/PageBrowserHeader.tsx`, `src/lib/i18n/pages.ts`, + tests (`hooks/__tests__/usePageBrowserSort.test.ts`, `PageBrowser/__tests__/PageBrowserHeader.test.tsx`)
- docs/meta: `pending/PEND-58d-pages-view-hardening.md` (P1 marked shipped), `pending/README.md`, `pending/PEND-58c-pages-filters-followups.md` (deleted — folded into PEND-58d)

**Verification:**
- `cd src-tauri && cargo nextest run` — 3893 passed, 4 skipped, 0 failed.
- `npx tsc --noEmit -p tsconfig.app.json` — clean; D3 vitest suites — 26 passed.
- `prek run --all-files` — all hooks pass.

**Process notes:** Two Rust subagents ran sequentially in the warm main tree (incremental) while the frontend subagent ran in parallel (vitest, no cargo contention) — chosen over worktrees because the 149G target dir made cold worktree compiles costlier than sequential incremental builds. Mid-session the user ran `cargo clean` (reclaiming 174.8 GiB of accumulated `incremental/`+`deps/` cruft), so the D2 subagent paid one cold rebuild.

**Lessons learned (for future sessions):** Verify index-usage claims with `EXPLAIN QUERY PLAN` against real SQLite before encoding them as `cost_hint`/test invariants — SQLite silently declines the LIKE optimization for case-insensitive matches, which no amount of NOCASE indexing fixes. When a change shifts a materialised-count semantic, grep for **every** parity test/helper using that count shape (there were three beyond the obvious one); a self-consistent stale test passes while silently locking the wrong contract.

**Commit plan:** committed onto `pend-58-phase2-pages-primitives` (PR #48), same-PR convention. Not pushed.

---

## Session 809 — PEND-58b: Pages compound-filters review remediation (2026-05-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-22 |
| **Subagents** | 3 build + 3 review (backend / PageBrowser / popover+summary) + orchestrator-direct docs |
| **Items closed** | PEND-58b — every confirmed finding from the multi-perspective + adversarial-verification review. |
| **Items modified** | — |
| **Tests added** | +~16 frontend (incl. a 19-case parameterized summary table) / +7 backend |
| **Files touched** | 17 |

**Summary:** Fixed every confirmed PEND-58b finding across backend SQL, frontend a11y/UX, and docs. Backend: scoped the `Orphan` outbound `NOT EXISTS` page-wide (it keyed on the page block, ignoring body-block links → wrong results); computed a real `total_count` on the metadata path (the page-count chip had silently vanished after the default-on flip); promoted the silent unsupported-filter `1=0` to an `AppError::Validation` in all build profiles; reranked the `LastEdited` cost hint; deduped the allowed-key vocabulary behind an exhaustive test. Frontend: chip-only zero-result now renders the no-match state (not "Create your first page"); added a polite live-region announcement on chip add/remove + result settle; `role="dialog"` on the Add-filter popover; per-facet helper descriptions + the missing "Last edited" group label; value-aware `OlderThan` summary. Docs: corrected the inverted `densityV1` flag section (now default-on / `'false'` opt-out), made the bucket table + soft-cap qualitative, noted negation/exclusion are Search-side. Also folds in the previously-uncommitted P0-D/P0-E work (list-virtualization windowing + load-more scroll-jump fix + their e2e).

- **Parallelization.** Rust (`src-tauri`) and TS (`src`) compile independently, so one backend + two frontend build subagents ran concurrently in the main tree on disjoint files with zero compile interference; the only shared write surface (i18n keys) was pre-added orchestrator-side. Each build was reviewed by a separate subagent (no self-reviews); all three reviews returned clean.
- **Orphan SQL.** `src.page_id = b.id AND src.deleted_at IS NULL` mirrors the inbound materialization (migration 0069) — the two halves are now symmetric. EXPLAIN confirms it uses `idx_block_links_source`.
- **total_count.** A single `COUNT(*)` over the same space + compiled-filter predicates (no keyset/cursor/limit, no per-row metadata subqueries) — index-served, within the 20k perf-gate headroom. Known minor redundancy: recomputed on each load-more page (deferred; cheap to gate on `cursor.is_none()`).

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-58b resolved (kept listed in `pending/README.md` until PR #48 merges, per the PR-spanning convention).
- **Previously resolved:** 1256+ → 1257+ across 808 → 809 sessions.

**Files touched (this session):**
- backend: `src-tauri/src/filters/primitive.rs`, `src-tauri/src/commands/pages.rs`, `src-tauri/src/commands/tests/list_pages_with_metadata_tests.rs`
- frontend: `src/components/PageBrowser.tsx`, `src/components/PageBrowser/AddFilterPopover.tsx`, `src/components/PageBrowser/PageBrowserFilterRow.tsx`, `src/lib/i18n/pages.ts`, + tests (`__tests__/PageBrowser.test.tsx`, `PageBrowser/__tests__/AddFilterPopover.test.tsx`, `PageBrowser/__tests__/PageBrowserFilterRow.test.tsx`)
- P0-D/E (carried): `e2e/pages-filter.spec.ts`, `src/lib/tauri-mock/handlers.ts`, `src/lib/tauri-mock/seed.ts`
- docs/meta: `docs/PAGES.md`, `pending/README.md`, `pending/PEND-58b-compound-filters-review-fixes.md`, `.gitignore`

**Verification:**
- `cd src-tauri && cargo nextest run` — 3889 passed, 4 skipped (`#[ignore]` perf gates), 0 failed.
- `npx vitest run` (PageBrowser suites) — green; `npx tsc --noEmit -p tsconfig.app.json` — clean.
- `prek run --all-files` — all hooks pass (cargo-fmt auto-fix applied + re-verified).

**Lessons learned (for future sessions):**
- Rust/TS compile isolation lets backend + frontend build subagents share one working tree safely; the only real conflict surface is a shared i18n file — pre-adding the keys orchestrator-side removes it and lets the frontend subagents reference fixed keys.

**Commit plan:** committed onto `pend-58-phase2-pages-primitives` (PR #48), same-PR convention. Not pushed.

---

## Session 808 — Pages view: flip `pageBrowser.densityV1` to default-on (opt-out) (2026-05-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-22 |
| **Subagents** | orchestrator-only |
| **Items closed** | PEND-56 rollout step — the density-rows + metadata-IPC + compound-filter path is now the default Pages view. |
| **Items modified** | The `pageBrowser.densityV1` flag is now opt-OUT (`'false'` = rollback) rather than opt-in. |
| **Tests added** | 0 (5 existing legacy-IPC tests pinned to the rollback path) |
| **Files touched** | 3 |

**Summary:** Flipped `usePageBrowserDensityV1Flag` from opt-in (`=== 'true'`, default off) to opt-out (`!== 'false'`, default on), so the `list_pages_with_metadata` + `<DensityRow>` + compound-filter path is what users get by default; setting the key to `'false'` is the rollback. The legacy `listBlocks` + `PageRow` path stays in place as that rollback target (removal is a later cleanup).

- **Blast-radius reality check.** A first measurement via the rtk-wrapped vitest run reported "FAIL (17)", which looked like a large cross-file migration. The authoritative `--reporter=json` run showed the real count: **5 failures, all in `PageBrowser.test.tsx`** — the other PageBrowser-rendering suites (App, ViewDispatcher, BlockTree, …) already pass on the metadata path because they use the shared tauri-mock, which handles `list_pages_with_metadata`. The "17" was a wrapper miscount; always confirm failure counts with the JSON reporter before scoping a migration.
- **The 5 failures were all legacy-path-specific** — four assert the `list_blocks` IPC shape (mount, cursor pagination, auto-load) and one is the "filter row hidden on the flag-off path" test. Each now pins `localStorage.setItem('pageBrowser.densityV1', 'false')` so it documents the rollback path explicitly; the metadata-path equivalents already exist in the `PEND-56 — density-v1 flag` describe block.
- **e2e.** `e2e/starred-pages.spec.ts` (7) + `e2e/breadcrumb-navigation.spec.ts` / `e2e/spaces-coverage.spec.ts` (5) + `e2e/pages-filter.spec.ts` (2) all pass on the new default — `<DensityRow>` preserves the title button, star, delete, and `id="page-row-…"` affordances those specs key on. The `pages-filter` flag-off test now sets `'false'` before boot.

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged. Follow-up cleanup (remove the legacy `listBlocks`/`PageRow` path + the flag entirely) is left for after a stable release, per the PEND-56 plan's staged-rollout note.
- **Previously resolved:** 1256+ → 1256+ across 807 → 808 sessions.

**Files touched (this session):**
- `src/components/PageBrowser.tsx` (`usePageBrowserDensityV1Flag` → opt-out default-on; updated doc comment)
- `src/components/__tests__/PageBrowser.test.tsx` (5 legacy-IPC tests pinned to `'false'`)
- `e2e/pages-filter.spec.ts` (flag-off test sets `'false'` before boot)

**Verification:**
- `npx vitest run --reporter=json` — 10388 pass, 0 fail (the 5 prior failures fixed).
- `npx vitest run src/components/__tests__/PageBrowser.test.tsx` — 121 pass.
- `npx playwright test e2e/starred-pages.spec.ts e2e/pages-filter.spec.ts e2e/breadcrumb-navigation.spec.ts e2e/spaces-coverage.spec.ts` — 14 pass.
- `npx tsc --noEmit -p tsconfig.app.json` — clean. `prek run --all-files` — 48 hooks pass, 0 failed.

**Lessons learned (for future sessions):**
- Confirm test-failure counts with `--reporter=json`, not the rtk-wrapped `PASS/FAIL` summary — the wrapper over-counted 5 real failures as 17 and made a 3-file change look like a ~17-file migration.
- Flipping a UI-path flag's default is lower-risk than it looks when the shared test mock already serves the new IPC: only the tests that *assert the old IPC shape* break, and those are exactly the ones that should pin the rollback path.

**Commit plan:** committed onto `pend-58-phase2-pages-primitives` (PR #48) per the user's "same PR" convention. PR #48 now spans PEND-58 Phases 2-6 + the PEND-56 default-on flip.

---

## Session 807 — Pages view: PEND-58 Phase 5+6 — docs + e2e (and a zero-result chip-row UX fix) (2026-05-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-22 |
| **Subagents** | 3 launched (1 succeeded: docs/PAGES.md; 2 died on 529 overloads → written orchestrator-direct) |
| **Items closed** | PEND-58 Phase 6 (docs) + the Phase 5 e2e gap. PEND-58 is now functionally complete (Phases 1-6). |
| **Items modified** | — |
| **Tests added** | +2 e2e (Pages compound-filter UI flow: add Stub chip / remove; flag-off renders no row) |
| **Files touched** | 5 (3 new docs/e2e + README + a PageBrowser gating fix) |

**Summary:** Completed PEND-58's documentation + e2e. Wrote `docs/PAGES.md` (user-facing facet reference) and `docs/architecture/filters.md` (the shared `FilterPrimitive` / `Projection` / `ALLOWED_KEYS` contract), added a README pointer, and a Playwright spec for the chip-row flow. The e2e surfaced a real UX bug — the filter row was gated on `pages.length > 0`, so a filter that narrowed results to **zero** unmounted the row and stranded the user with no way to clear the filter that emptied the view. Fixed the gate to `flagOn && (pages.length > 0 || filters.length > 0)`.

- **`docs/PAGES.md`** — overview + flag gating, the full facet table (Pages-only orphan/stub/no-inbound-links + last-edited buckets + shared tag/path/has-property/priority) with real semantics (Stub = zero non-title descendants; inbound = "page or any descendant"), two worked grooming flows, the 8-chip soft cap, chip-only rationale. All code-path citations validated by the `doc-vs-code-paths` prek hook.
- **`docs/architecture/filters.md`** — the one-sentence contract (value vs projection), the enum groups + wire/specta shape, the `Projection` trait + `unsupported()` default, the per-surface allow-list gate invariant, SQL composition (cost-ordering, explicit-`?N` bind renumbering, the `LEFT JOIN pages_cache pc` requirement), the materialised-column performance note (migration 0069), and extension points (Search wiring + saved views).
- **`README.md`** — one line under "Blocks and Pages" pointing at `docs/PAGES.md`.
- **`e2e/pages-filter.spec.ts`** — 2 tests: (1) flag-on → open Add-Filter popover → pick Stub → chip renders → remove → grid returns; (2) flag-off → no filter row. Uses `Stub` (not `Orphan`) because the tauri-mock doesn't model `block_links`, so only `childBlockCount`-based facets narrow meaningfully in e2e (documented in the spec).
- **PageBrowser gating fix** — the chip row now stays mounted whenever filters are active, so a zero-result filter is always clearable.

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-58 complete across all six phases. The plan file can be removed in a follow-up (left in place this cycle since the PR is still open).
- **Previously resolved:** 1256+ → 1256+ across 806 → 807 sessions (PEND-58 retires on PR #48 merge).

**Files touched (this session):**
- `docs/PAGES.md` (new, +110)
- `docs/architecture/filters.md` (new, ~+130)
- `README.md` (+1 line under Blocks and Pages)
- `e2e/pages-filter.spec.ts` (new, 2 tests)
- `src/components/PageBrowser.tsx` (filter-row gating: `pages.length > 0` → `pages.length > 0 || filters.length > 0`)

**Verification:**
- `npx playwright test e2e/pages-filter.spec.ts` — 2/2 pass (after `npx playwright install chromium` — the browser binary had been version-bumped out of cache).
- `npx vitest run src/components/__tests__/PageBrowser.test.tsx src/components/PageBrowser/__tests__/` — 173 pass.
- `npx tsc --noEmit -p tsconfig.app.json` — clean.
- `prek run --all-files` — 48 hooks pass, 0 failed (incl. `doc-vs-code-paths` validating every doc citation).

**Process notes:** the subagent pool returned two more 529 Overloaded errors (one agent died after 8 tool uses without writing `filters.md`; the e2e agent after 1). As in Session 806, the orchestrator wrote those deliverables directly. The one surviving subagent (PAGES.md) again ran in an auto-created worktree but its output landed in the main tree intact.

**Lessons learned (for future sessions):**
- Don't gate a filter/chip surface on result-count — a filter that returns zero rows must keep its own controls mounted so the user can undo it. Gate on `hasResults || hasActiveFilters`.
- e2e specs that depend on a facet's semantics must check what the tauri-mock actually models — `block_links` is not modelled, so orphan/inbound facets are no-ops in e2e; use `childBlockCount`-based facets (Stub) for meaningful assertions.
- `npx playwright install chromium` may be needed after a Playwright version bump (the cached browser path is version-stamped).

**Commit plan:** committed onto `pend-58-phase2-pages-primitives` (PR #48) per the user's "same PR" instruction. PR #48 now spans PEND-58 Phases 2-6.

---

## Session 806 — Pages view: PEND-58 Phase 3+4 — compound-filter IPC wiring + chip-row + Add-Filter popover (2026-05-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-22 |
| **Subagents** | 1 build (backend, isolated worktree) + orchestrator-direct frontend (subagent pool was API-overloaded — 2 consecutive 529s, 0 tokens, so the frontend was built directly) |
| **Items closed** | PEND-58 Phase 3 (IPC integration + chip-row) + Phase 4 (Add-Filter popover) |
| **Items modified** | PEND-58 (Phases 5-6 — broader test matrix + docs — remain) |
| **Tests added** | +29 (8 backend: serde/cost_hint/allowed-keys + IPC filter compose/cursor/reject; +21 frontend: 11 AddFilterPopover, 8 PageBrowserFilterRow, 2 PageBrowser integration) |
| **Files touched** | 9 (2 new frontend components + 2 new test files + 5 modified) |

**Summary:** Completed the compound-filter feature end-to-end. The backend exposes `FilterPrimitive` on the IPC boundary as a clean internally-tagged TS union and `list_pages_with_metadata` now compiles a `Vec<FilterPrimitive>` into its WHERE clause (allowed-keys gated, cost-ordered, binds renumbered to explicit positions so SQLite's positional binding stays unambiguous). The frontend adds a chip-row + an Add-Filter popover (modelled on `GraphFilterBar`) wired into `PageBrowser` behind the `pageBrowser.densityV1` flag. Search-only primitives are never offered on the Pages surface; filters reset pagination + scroll + focus on change.

- **Backend IPC** (`src-tauri/src/filters/primitive.rs`, `src-tauri/src/commands/pages.rs`) — `FilterPrimitive` + `PropertyOp` / `PropertyValue` / `LastEditedSpec` / `SnippetSpec` gain `Serialize`/`Deserialize`/`specta::Type` (newtype variants converted to single-field struct variants so serde's internal tagging produces a `{ type, ...fields }` union matching the `BacklinkFilter` convention). `ListPagesWithMetadataFilter` gains `filters: Vec<FilterPrimitive>` (default empty). `cost_hint(&self) -> u8` orders index-backed primitives first. `SortKeyset::apply` was parameterised with a bind-offset `base` and `compile_pages_filters` renumbers each fragment's anonymous `?` to explicit `?N` positions — fixing a latent positional-bind ambiguity, confirmed by a filter+cursor test.
- **Frontend** — `src/components/PageBrowser/PageBrowserFilterRow.tsx` (chips via the reused `FilterPill`, `pageFilterSummary` formatter, 8-chip soft-cap warning) + `src/components/PageBrowser/AddFilterPopover.tsx` (categorised menu: Shared facets Tag/Path/HasProperty/LastEdited/Priority + Pages facets Orphan/Stub/HasNoInboundLinks; boolean facets add on click, value facets use an inline editor; Esc restores focus to the trigger). Wired into `PageBrowser.tsx`: `filters` state with `_addId`-stamped chips, `wireFilters` (id stripped) threaded into the metadata queryFn, filter change added to the pagination/scroll/focus reset effects. Flag-off path unchanged (no filter row, legacy `listBlocks`).
- **Mock + wrapper** — `src/lib/tauri.ts`'s `listPagesWithMetadata` accepts an optional `filters` param; the tauri-mock handler honours `Stub` / `HasNoInboundLinks` / `Orphan` / `Tag` / `Priority` (others permissive no-ops). Bindings regenerated via `cargo test -- specta_tests --ignored`.

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-58 Phases 3+4 closed. Phases 5 (broader test matrix — cross-surface parser table, e2e) + 6 (docs/PAGES.md, docs/architecture/filters.md) remain.
- **Previously resolved:** 1256+ → 1256+ across 805 → 806 sessions (PEND-58 not fully retired yet).

**Files touched (this session):**
- `src-tauri/src/filters/primitive.rs` (serde/specta derives, struct variants, `cost_hint`, +unit tests)
- `src-tauri/src/commands/pages.rs` (`filters` field, `compile_pages_filters`, bind renumbering, +integration tests)
- `src-tauri/src/commands/tests/list_pages_with_metadata_tests.rs` (filter compose / cursor / allowed-keys-reject tests)
- `src/lib/bindings.ts` (regenerated — `FilterPrimitive` union + sub-types)
- `src/lib/tauri.ts` (`filters` param on the wrapper)
- `src/lib/tauri-mock/handlers.ts` (mock honours filters)
- `src/components/PageBrowser/PageBrowserFilterRow.tsx` (new)
- `src/components/PageBrowser/AddFilterPopover.tsx` (new)
- `src/components/PageBrowser.tsx` (filter state + queryFn threading + reset effects + render)
- `src/components/PageBrowser/__tests__/PageBrowserFilterRow.test.tsx` (new, 8 tests)
- `src/components/PageBrowser/__tests__/AddFilterPopover.test.tsx` (new, 11 tests)
- `src/components/__tests__/PageBrowser.test.tsx` (+2 integration tests)
- `src/lib/i18n/pages.ts` (`pageBrowser.filter.*` strings)

**Verification:**
- `cd src-tauri && cargo nextest run` — backend green incl. new filter IPC tests.
- `npx vitest run src/components/__tests__/PageBrowser.test.tsx src/components/PageBrowser/__tests__/` — 173 pass.
- `npx tsc --noEmit -p tsconfig.app.json` — clean.
- `prek run --all-files` — 48 hooks pass, 0 failed.

**Process notes:** the backend build subagent ran in an **isolated worktree branched off `b992afa4`** (the pre-Phase-2 commit), so its `primitive.rs` lacked this branch's Phase 2 materialised-column refactor. Merging the worktree branch into the PR branch hit a 3-way conflict on `LastEditedSpec` (Phase 2 doc table vs Phase 3 serde derives) and required converting Phase 2's `LastEditedSpec::Rolling(u32)` test usages to the new struct-variant form. **Lesson:** when delegating to a worktree subagent on a stacked branch, ensure it branches off the branch tip, not an ancestor — otherwise its output silently lacks intervening commits. The frontend was built orchestrator-direct after the subagent pool returned consecutive 529 Overloaded errors (0 tokens) — for net-new component creation this is a safe fallback per PROMPT.md.

**Lessons learned (for future sessions):**
- Worktree subagents inherit the base commit at spawn time; on a stacked branch verify the base is the branch tip before merging back, or expect a 3-way merge that drops intervening work on conflicting hunks.
- jsdom drives the real Radix Popover fine under `userEvent.click` (the integration test opens the Add-Filter popover and picks a facet without mocking) — component-level tests still mock `@/components/ui/popover` for speed, but a full integration path is testable.

**Commit plan:** committed onto the existing `pend-58-phase2-pages-primitives` branch (PR #48) per the user's request to keep Phase 2+3+4 in one PR.

---

## Session 805 — Pages view: PEND-58 Phase 2 — Orphan/Stub/HasNoInboundLinks now read materialised pages_cache columns (2026-05-21)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-21 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | PEND-58 Phase 2 (Pages-only filter primitives refactor) |
| **Items modified** | — |
| **Tests added** | +6 backend (2 SQL-shape snapshots + 4 EXPLAIN QUERY PLAN assertions) |
| **Files touched** | 1 (src-tauri/src/filters/primitive.rs only) |

**Summary:** Refactored the three Pages-only `FilterPrimitive` variants (`Orphan`, `Stub`, `HasNoInboundLinks`) so their `PagesProjection::compile_*` outputs read from `pages_cache.{inbound_link_count, child_block_count}` (materialised in PEND-56b) instead of the raw `block_links` / `COUNT(*)` correlated subqueries that hit the same 20k-page latency cliff PEND-56b closed. Also corrected `Stub`'s threshold from a placeholder `< 3` to the spec-correct `= 0` (PEND-58 vocabulary: "Page whose only block is its own title row (zero non-title descendants)"). The IPC wiring of `Vec<FilterPrimitive>` belongs to Phase 3 — this cycle is backend primitives + tests only.

- **Refactored compile fragments:**
  - `Orphan` → `COALESCE(pc.inbound_link_count, 0) = 0 AND NOT EXISTS (SELECT 1 FROM block_links WHERE source_id = b.id)`. Inbound side index-served; outbound side still scans `block_links` (no materialised `outbound_link_count` yet — filed as a follow-up if measurement shows it dominating).
  - `Stub` → `COALESCE(pc.child_block_count, 0) = 0`.
  - `HasNoInboundLinks` → `COALESCE(pc.inbound_link_count, 0) = 0`.
- **Composition contract** documented in a code comment above the three fns: the caller must splice into a SELECT that already `LEFT JOIN pages_cache pc ON pc.page_id = b.id` (canonical example: `commands::pages::list_pages_with_metadata_inner`). The `COALESCE(_, 0)` defends against the materializer-guaranteed-not-to-happen "no `pages_cache` row" case.
- **Inbound-semantic alignment** (raised by the tech reviewer as NEEDS_DISCUSSION) — `pc.inbound_link_count` counts "edges targeting the page OR any non-deleted descendant", broader than the Phase-1 placeholder's `target_id = b.id`. This is the same definition the metadata IPC + `MostLinked` sort + `<DensityRow>`'s `↗` badge already use. Aligning the filter makes Pages internally consistent — a user clicking `orphan:` after seeing "0 ↗" on a row always agrees with the surfaced count. Doc comments now document this explicitly on `compile_orphan` + `compile_has_no_inbound_links`.
- **`LastEditedSpec` review** — confirmed the existing `Rolling(u32)` / `OlderThan(u32)` / `Range { start, end }` variants already cover PEND-58's full bucket vocabulary (`today` / `this-week` / `this-month` / `older` / `>=YYYY-MM-DD`). Added a chip-token → variant mapping table to the enum's doc comment. No new variant needed.
- **EXPLAIN QUERY PLAN tests** — `pages_only_primitives_use_indexed_paths` (4 sub-cases): each Pages-only primitive's composed query plan contains `pages_cache` (any row reading it) and lacks the pre-PEND-56b `block_links` scan for the inbound side. `Orphan` retains a `block_links` scan for the outbound `source_id` half — intentional, documented.

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-58 Phase 2 closed. Phase 3 (Pages frontend chip-row + IPC integration of `Vec<FilterPrimitive>`) remains.
- **Previously resolved:** 1256+ → 1256+ across 804 → 805 sessions (PEND-58 still has Phase 3-6 open).

**Files touched (this session):**
- `src-tauri/src/filters/primitive.rs` (+337 / −16; refactored compile fragments + composition-contract doc comment + 6 new tests).

**Verification:**
- `cd src-tauri && cargo nextest run --test-threads=4 filters` — 47/47 pass.
- `cd src-tauri && cargo nextest run` — 3874 / 3874 pass (3868 baseline + 6 new), 3 `#[ignore]`d.
- `cd src-tauri && cargo clippy --all-targets -- -D warnings` — clean.
- `prek run --all-files` — 48 hooks pass, 0 failed.

**Process notes:** small single-file backend cycle — one build subagent + one review subagent (no parallel build splits since the work was bounded to one file). Reviewer caught the inbound-semantic divergence and recommended documenting the alignment rather than reverting; orchestrator applied the doc-comment fix and shipped.

**Lessons learned (for future sessions):**
- When a refactor changes a SQL fragment that other surfaces also expose to users (`inbound_link_count` here surfaces in the `↗` badge, the `MostLinked` sort, AND filters), align the semantic across all of them in one PR rather than leaving the filter on the narrow definition. Tech-review's "this is a behavior change" flag is the right signal to either align or revert — never ship a silent divergence.

**Commit plan:** single commit on topic branch `pend-58-phase2-pages-primitives`; PR against `main`.

---

## Session 804 — Pages view: PEND-56b materialisation (closes the 20k-page MostLinked cliff, 335 ms → 34 ms) (2026-05-21)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-21 |
| **Subagents** | 3 build (parallel where independent, sequential where dependent) |
| **Items closed** | PEND-56b (materialisation follow-up to PEND-56). PEND-56's "Phase 1 perf cliff" risk is now retired. |
| **Items modified** | — |
| **Tests added** | +7 backend (1 schema-guard migration test + 4 materializer-parity tests + 2 EXPLAIN-QUERY-PLAN assertions + 1 `#[ignore]`d 20k-page perf bench) |
| **Files touched** | 6 (1 new migration, 4 modified .rs, 1 modified SESSION-LOG) |

**Summary:** Materialised `pages_cache.inbound_link_count` + `pages_cache.child_block_count` so the `most-linked` / `most-content` sort paths no longer pay the 335 ms / 20k-page COUNT(DISTINCT) cliff. The materializer maintains both columns byte-identically to the canonical SELECT in `commands/pages.rs:1666-1675` on every block-lifecycle op (CreateBlock / EditBlock / DeleteBlock / RestoreBlock / PurgeBlock), with a 4-test parity assertion exercising the full lifecycle. The IPC's SELECT now LEFT JOINs `pages_cache` and reads the cached columns directly; bench drops from **335 ms → 34 ms (10× win)** at 20k pages, well under PEND-56b's 50 ms acceptance criterion.

- **Migration 0069** — `ALTER TABLE pages_cache ADD COLUMN inbound_link_count / child_block_count INTEGER NOT NULL DEFAULT 0`, backfilled with the IPC's exact SELECT shape (not via `page_link_cache`, to absorb any drift). Header documents the no-index decision: at ≤20k pages, the quick-sort-into-top-K plan is sub-50 ms; a secondary index on `inbound_link_count DESC` would add maintenance cost on every link change without paying for itself.
- **Materializer maintenance** (`src-tauri/src/materializer/handlers.rs`) — added `recompute_pages_cache_counts_for_pages`, `maintain_pages_cache_counts_after_op`, `refresh_inbound_counts_after_reindex`, plus small parsing/resolution helpers. The chosen approach is **recompute-on-touch** (run the canonical SELECT for affected pages on each op) over delta-math — trades a small per-op cost for total correctness, and the parity test catches any drift. Touch sites: `apply_op_tx` post-projection + the `MaterializeTask::ReindexBlockLinks` arm (where the existing per-block link diff already happens).
- **SortKeyset extraction + IPC refactor** (`src-tauri/src/commands/pages.rs`) — refactored `list_pages_with_metadata_inner` from a 263-line 5-arm match into an 83-line `keyset.apply(...)` + 4-line bind loop (-68 % LOC at the touch site). The new `SortKeyset` enum covers four shapes (`StringAsc`, `StringDescNullCoalesced` for the `LAST_MOD_NULL_SENTINEL` path, `I64Desc`, `IdOnly`) — descriptor co-located in `pages.rs` (no new module). `EXPLAIN QUERY PLAN` for `most-linked` confirms the plan now uses `SEARCH pc USING INDEX sqlite_autoindex_pages_cache_1` — no `block_links` scan, no `CORRELATED SCALAR SUBQUERY`.
- **Parity contract** — `pages_cache_count_parity` test module: 4 tests, mixed 10-page fixture, asserts `materialised == computed` after every materializer op. Reduced from PEND-56b's proposed 1000-page fixture (the parity contract is op-agnostic so fixture size affects CI cost only, not coverage).
- **Bench** — `most_linked_perf_gate_20k_pages` (`#[ignore]`d): 20k seeded pages, 3× warmup, median of 5 samples → **34 ms** (samples: 34, 34, 34, 34, 35 ms).

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-56b retired (file removed from `pending/` in this commit). PEND-56's deferred risk on the most-linked path is closed. PEND-58's `orphan:` / `has-no-inbound-links:` facets — which would have hit the same cliff — now inherit the materialised counts for free.
- **Previously resolved:** 1255+ → 1256+ across 803 → 804 sessions.

**Files touched (this session):**
- `src-tauri/migrations/0069_pages_cache_link_and_content_counts.sql` (new, +50)
- `src-tauri/src/op_log.rs` (+95; schema-guard test for the new columns + canonical-SELECT parity assertion on a 6-block / 5-link / 2-page fixture)
- `src-tauri/src/materializer/handlers.rs` (+710 / −15; helper module + recompute-on-touch wiring at the 5 touch sites)
- `src-tauri/src/materializer/tests.rs` (+520; `pages_cache_count_parity` test module, 4 tests, 10-page fixture)
- `src-tauri/src/commands/pages.rs` (+245 / −180; `SortKeyset` enum + `keyset_for` + `impl::apply` + `SqlBind` + LEFT JOIN `pages_cache`; 263-line IPC body → 83 lines)
- `src-tauri/src/commands/tests/list_pages_with_metadata_tests.rs` (+200; existing helpers seed `pages_cache`; 2 new EXPLAIN QUERY PLAN tests + 1 `#[ignore]`d 20k-page perf bench)
- `src-tauri/src/mcp/tools_ro.rs` (drive-by: clippy `doc_lazy_continuation` warning fix for a `+ cache-init + metrics tasks` comment line that markdown was reading as a list bullet)
- `pending/PEND-56b-pages-materialization-followup.md` (removed in this commit — the plan is shipped)

**Verification:**
- `cd src-tauri && cargo nextest run` — 3868 tests pass, 3 `#[ignore]`d (the perf bench + 2 pre-existing).
- `cd src-tauri && cargo nextest run pages_cache_count_parity` — 4/4 pass.
- `cd src-tauri && cargo sqlx prepare --workspace -- --tests` — succeeded; 3 new query JSONs landed under `src-tauri/.sqlx/`.
- `prek run --all-files` — 48 hooks pass, 0 failed.

**Process notes:** parallel-cycle execution per `PROMPT.md` — Wave 1 (migration + materializer hooks) launched concurrently with the build subagents coordinating on column names + types via the prompt contract (both prompts named the same `inbound_link_count` / `child_block_count` shape so the merge was conflict-free). Wave 2 (SortKeyset extraction + IPC refactor) ran sequentially after both Wave 1 agents finished, since the IPC depends on the materialised columns existing. The orchestrator handled the cross-cutting cleanup (clippy `doc_lazy_continuation` in `tools_ro.rs` — pre-existing warning surfaced by the current Rust toolchain's stricter lints; one-line wording fix to avoid the leading `+` markdown bullet).

**Lessons learned (for future sessions):**
- When the materializer maintains a derived column, **recompute-on-touch** beats delta-math for first-cut correctness. The per-op cost is bounded by the affected-page count (typically 1-5), and the parity test catches any drift the delta math would silently introduce. PEND-58's grooming facets should adopt the same pattern.
- Pre-existing clippy warnings can surface unexpectedly when a sub-component change pulls the lint into a wider scope. The `doc_lazy_continuation` lint reads `+ word` at line-start as a markdown bullet — avoid putting `+` (or `-` / `*` followed by a space) as the first non-`///` character in doc comments.

**Commit plan:** single commit on topic branch `pend-56b-pages-materialization`; PR against `main`. Stacks logically on top of Cycle 1's branch (PR #46, merged as Session 803 below) but doesn't depend on it — touches different files.

---

## Session 803 — Pages view: PEND-56 Phase 3 integration (DensityRow + IPC switch + flag-gated wiring) (2026-05-21)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-21 |
| **Subagents** | 4 build + 3 review (parallel, pipelined per PROMPT.md) |
| **Items closed** | — (PEND-56 Phase 3 lands; Phases 4-5 fold into this session via the integration tests + docs subagents) |
| **Items modified** | PEND-56 (status note: Phases 1-3 shipped; PEND-56b still queued as the materialisation follow-up) |
| **Tests added** | +46 frontend (28 DensityRow, 5 Header, 13 PageBrowser integration; +1 pre-existing 3→7 sort-options assertion fixed) |
| **Files touched** | 11 (3 new + 8 modified) |

**Summary:** Landed the third phase of PEND-56 — wired the existing `list_pages_with_metadata` IPC + the `usePageBrowserSort` (7 modes) + `usePageBrowserDensity` hook through a new `<DensityRow>` primitive, gated behind a `pageBrowser.densityV1` localStorage flag so the legacy `listBlocks` + `PageRow` path stays the rollback target. The wiring also introduces a `withCursorRecovery` helper that catches the backend's `AppError::Validation("RequiresRefresh: …")` and retries the IPC once with `cursor: undefined` — the recovery contract the cursor-v2 schema bump locked in during Phase 1.

- **DensityRow primitive** (`src/components/PageBrowser/DensityRow.tsx`, +360 LOC) — memoised typed-primitive-prop row with three modes (32 / 44 / 68 px). Compact folds metadata into the row's `title` tooltip with zero-suppression for `↗ 0` / `⊟ 0`; regular caps property-flag badges at 1; expanded renders all flags. Pure helpers `formatRelativeShort` and `collectFlagTokens` exported for unit testing. `data-density={mode}` + stable `id="page-row-{pageId}"` are the contract integration tests assert against. ARIA structure mirrors the legacy `PageRow` (role=row / nested role=gridcell, `aria-activedescendant`-friendly).
- **PageBrowserHeader extension** — added a `Density ▾` selector next to the existing `Sort ▾`, surfaced the 4 new sort modes (`recently-modified`, `most-linked`, `most-content`, `default`) with a `<SelectSeparator>` between the legacy 3 and the new 4. All visible strings i18n-keyed in `src/lib/i18n/pages.ts`.
- **Orchestrator wiring** (`PageBrowser.tsx`, +200 LOC) — flag read once at mount via `useState(() => localStorage.getItem(...))`; `queryFn` switches between `listBlocks` and `listPagesWithMetadata` based on the flag; `pageSortWireFor(sortOption)` maps the 7 frontend modes to 4 wire values; `estimateSize` reads `DENSITY_ROW_HEIGHT[density]`; scroll-restoration + focused-row reset re-arm on density change. The `(BlockRow | PageWithMetadataRow)[]` union is cast at the leaf where the metadata-rich shape is needed; downstream grouping reads only shared fields.
- **PageBrowserRowRenderer swap** — `flagOn=true` renders `<DensityRow>` with the full primitive-prop bundle (memo-stable across parent re-renders via `useCallback` on the bridge handler); `flagOn=false` keeps the legacy `PageRow` byte-identical.
- **Docs** — new `docs/architecture/pages-view.md` (7 sections: overview / data flow / sort modes / density / cursor v1→v2 / metadata aggregation / extension points). PEND-56b cross-linked for the 20k-page scaling cliff (`most-linked` first-page latency 95→335 ms). Four new invariants in `AGENTS.md`'s new `## Pages view` section (cursor schema, density preference key, `DensityRow` Pages-scope rule, comparator allocation invariant).
- **Pipelined reviews** — three independent tech reviewers caught: (a) locale-leaking `data-page-flag` attribute on the property-flag badge → fixed inline (now uses a stable token + translated label); (b) `<DensityRow>` `onSelect` bridge re-allocating per render → fixed inline (wrapped in `useCallback`); (c) phantom `Cursor.last_sort_key` field reference in the doc → fixed. The compact-tooltip zero-suppression was a MED flag from the DensityRow reviewer that the orchestrator folded in directly.

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged. PEND-56 itself stays open until PEND-56b lands (the materialisation follow-up that retires the `most-linked` scaling cliff); Phase 3 wiring is the green path for ≤10k-page vaults today.
- **Previously resolved:** 1255+ → 1255+ across 802 → 803 sessions.

**Files touched (this session):**
- `src/components/PageBrowser/DensityRow.tsx` (+360, new)
- `src/components/PageBrowser/__tests__/DensityRow.test.tsx` (+330, new; 28 tests)
- `src/components/PageBrowser/__tests__/PageBrowserHeader.test.tsx` (+120, new; 5 tests)
- `docs/architecture/pages-view.md` (+170, new)
- `src/components/PageBrowser.tsx` (+200 / −38; flag, density wiring, IPC switch, cursor recovery)
- `src/components/PageBrowser/PageBrowserHeader.tsx` (+41; density Select + 4 new sort items)
- `src/components/PageBrowser/PageBrowserRowRenderer.tsx` (+115; `DensityRow` dispatch behind `flagOn`)
- `src/components/__tests__/PageBrowser.test.tsx` (+601; 13 new integration tests, 1 fixed)
- `src/lib/i18n/pages.ts` (+22; `pageBrowser.metadata.*`, `pageBrowser.density*`, 4 new `pageBrowser.sort*`)
- `AGENTS.md` (+9; new `## Pages view` section, 4 invariants)
- `pending/PEND-56-pages-view-density-sort.md` (+2; status note: Phases 1-3 shipped)

**Verification:**
- `npx vitest run src/components/__tests__/PageBrowser.test.tsx src/components/PageBrowser/__tests__/` — 152 tests run, all passed.
- `npx tsc --noEmit -p tsconfig.app.json` — clean.
- `prek run --all-files` — 48 hooks pass, 0 failed.

**Process notes:** parallel-cycle execution per `PROMPT.md` — Wave 1 (DensityRow + Header + Docs) launched concurrently, Wave 2 (orchestrator wiring) gated on Wave 1's DensityRow API, Wave 3 (integration tests + tech review of the orchestrator wiring) launched in parallel. Three pipelined tech-review subagents ran alongside Wave 2/3 builders, catching the locale-leaking attr, the memo-defeating arrow allocation, and the phantom `Cursor.last_sort_key` reference before merge.

**Lessons learned (for future sessions):**
- The `AGENTS.md` "no changes without explicit user approval" banner blocked the docs subagent. Sub-agent prompts that modify AGENTS.md should always carry "the user has explicitly approved this addition" language; the orchestrator should pause and confirm before delegating AGENTS.md edits, even when the PEND plan calls for them. Worked here because the addition was small and clearly scoped to a single new section, but a larger change would have wasted the docs subagent's run.
- biome's `useAriaPropsSupportedByRole` rule rejects `aria-label` on a plain `<span>`. Use `<span aria-hidden>{visual}</span><span className="sr-only">{label}</span>` pairs instead — keeps the visual badge and the SR text decoupled while satisfying the lint.

**Commit plan:** single commit on topic branch `pend-56-phase3-pagebrowser-integration`; PR against `main`.

---

## Session 802 — PEND-49 OpenSSF Silver: 5a assurance case + 5b first security review + 5c Flathub scaffold (2026-05-20)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-20 |
| **Subagents** | orchestrator-only (3 doc-heavy cycles) |
| **Items closed** | PEND-49 §5a (assurance case), PEND-49 §5b (security review structure + first pass), PEND-49 §5c (Flathub manifest scaffold pre-submission) |
| **Items modified** | PEND-49 open question 1 resolved ("yes, go for Silver"); 5d still PEND-48 |
| **Tests added** | 0 (doc + manifest scaffold; no code paths) |
| **Files touched** | 4 new (3 docs + 1 plan update) + 3 new manifest files |

**Summary:** Maintainer answered PEND-49 open question 1 with "yes — go for Silver". Shipped the three engineering items that don't need maintainer-only access (5d PEND-48 reproducible builds is multi-week; Bucket 1 needs you to log into bestpractices.dev). Silver criterion form-fields will flip after the maintainer points the bestpractices.dev links at the new section anchors.

- **5a — assurance case.** New section in `docs/architecture/threat-model.md` ([anchor](docs/architecture/threat-model.md#assurance-case)). Six top-level claims reframed from the existing STRIDE-per-boundary rows, each linked to (a) the cited STRIDE row that mitigates the claim and (b) the CI evidence that verifies the mitigation in production. Narrative-not-GSN shape on purpose — the threat model stays the load-bearing artefact; a separate GSN doc would just drift against it (per PEND-49 §5a's stated reasoning). Maintenance contract spelled out: any STRIDE row update touches the cited claim's evidence line in the same commit.
- **5b — security review structure + first pass.** New `docs/security/` directory with `README.md` (cadence + scope + disposition contract) and `review-2026-05-20.md` (the first review report against the cadence). The first pass: STRIDE walk of B1–B5 + diff-sweep of all in-scope code (`commands/`, `sync_*`, `commands/gcal.rs`, `gcal_push/`, the `tauri-plugin-updater` integration in `lib.rs`, `mcp/`) since project inception. One finding (the CI release-notes regression discovered during this branch's work) with disposition `Fixed` in `4de0e241`. No new REVIEW-LATER rows or PEND-NN-* entries opened. Next review trigger: `0.X.0` minor cut OR 2027-05-20.
- **5c — Flathub manifest scaffold.** New `packaging/flathub/` directory with `io.github.jfolcini.Agaric.yml` (Flatpak manifest that mirrors the existing AppImage `.deb` rather than recompiling Rust in the sandbox — 4x build wall-clock savings, behavioural identity), `io.github.jfolcini.Agaric.metainfo.xml` (AppStream presentation page), and a `README.md` with status + 4 open questions that block actual Flathub submission (AppImage→Flatpak data migration, release-time manifest bumps, screenshot URL host, Wayland-only test pass).

PEND-49 itself updated: open question 1 resolved; new "Status (2026-05-20)" block notes 5a/5b shipped locally + 5c scaffolded + 5d still on PEND-48; original "Open questions" body kept (question 1 struck through with the resolution, 2/3 still live).

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-49's 4 engineering items now: 3 shipped locally, 1 still tracked separately (PEND-48). Bucket 1 form-update still pending the maintainer.
- **Previously resolved:** 1252+ → 1255+ across 801 → 802 sessions.

**Files touched (this session):**
- `docs/architecture/threat-model.md` (+73; new "Assurance case" section between Out-of-scope and Open-questions)
- `docs/security/README.md` (new, +57; cadence + scope + naming contract)
- `docs/security/review-2026-05-20.md` (new, +164; first review report)
- `packaging/flathub/io.github.jfolcini.Agaric.yml` (new, +66; Flatpak manifest)
- `packaging/flathub/io.github.jfolcini.Agaric.metainfo.xml` (new, +73; AppStream MetaInfo)
- `packaging/flathub/README.md` (new, +73; status + open questions + submission checklist)
- `pending/PEND-49-ossf-silver-roadmap.md` (+16 / −3; status block + open question 1 struck through)

**Verification:**
- `prek run --files <touched>` — green (markdownlint, lychee, doc-citations, typos, yaml, secrets).
- No code paths touched; no vitest / cargo-nextest run needed.

**Maintainer follow-ups (NOT autonomous-safe — your action):**
1. **Bucket 1 form update** on bestpractices.dev — `test_statement_coverage90` + `test_branch_coverage80`. ~15 minutes.
2. **5a + 5b form-row flips** — point `assurance_case` at `docs/architecture/threat-model.md#assurance-case` and `security_review` at `docs/security/review-2026-05-20.md`. ~5 minutes.
3. **5c open questions** — answer the 4 before opening the Flathub PR. Most are policy-shaped (migration path, screenshot hosting); the Wayland test needs a real-machine run.
4. **5d PEND-48** — schedule when a contiguous multi-week window opens.

**Commit plan:** appended to existing topic branch `fix-release-notes-autogen` (PR #44). Total branch-commit count: 10.

---

## Session 801 — autonomous backlog sweep: release-notes fix + PEND-68 + pending-folder hygiene (2026-05-20)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-20 |
| **Subagents** | orchestrator-only (5 small cycles, no parallelism benefit) |
| **Items closed** | PEND-68 (tablet/keyboard detection) |
| **Items modified** | Deleted shipped plans: PEND-62, PEND-69, PEND-70, PEND-71, PEND-75. Refreshed PEND-66 status + file references. CI release-notes bug fixed. |
| **Tests added** | +14 frontend (8 useHasHardwareKeyboard, 6 useShouldShowMobileChrome) |
| **Files touched** | 11 |

**Summary:** Autonomous sweep on the new `fix-release-notes-autogen` topic branch (off main at `4080ca51`). Five cycles, all that were autonomous-safe — the remaining pending items either need maintainer judgment or external triggers.

- **CI release-notes bug** — Both `Ensure draft release exists` steps in `.github/workflows/release.yml` (build-and-release matrix + generate-vex job) were creating drafts with `--notes "Release notes will be finalized by the workflow."` as literal text, but nothing in the workflow ever finalised it. Every release since the workflow landed (0.1.37, 0.1.38) shipped with that placeholder + SLSA recipe and NO "What's Changed" changelog. Swapped both occurrences for `--generate-notes` — GitHub auto-generates the PR-title changelog at draft creation; the existing `finalize-release-notes` step continues to append the SLSA recipe to whatever lands in the body. 0.1.38's notes backfilled manually via `gh release edit --notes-file` against the live release.
- **PEND-68 — tablet + hardware-keyboard detection.** Two new hooks (`useHasHardwareKeyboard` sticky-true probe, `useShouldShowMobileChrome` composite gate) + one `App.tsx` swap. Pure-touch iPad users now see the mobile search trigger; iPad-with-keyboard sessions stay on desktop chrome + Cmd+K. Latch is module-level so a second consumer in the same session reads `true` synchronously. 14 unit tests.
- **Pending-folder hygiene** — Deleted 5 stale plan files (PEND-62 / 69 / 70 / 71 / 75), all shipped via prior PRs. Updated README index + the "Recommended order" paragraph to reflect that the search overhaul is fully shipped (only PEND-66 remains as a watch-and-act item).
- **PEND-66 doc refresh** — Watch-and-act review: all 4 triggers still negative. Updated stale file reference (`SearchPalette.tsx` → `CommandPalette.tsx`, renamed during PEND-61); added pointer to PEND-73 Phase 3.U8's selection-range wrapping; refreshed last-checked date.

Cycles attempted and skipped:
- **design-system-perf-review-2026-05-09.md** — Both items (Tier 1.3 lazy TipTap, Tier 2.6 BlockListRenderer + BlockTree windowing) explicitly defer-pending-measurement in the doc itself. Not autonomous-safe; needs maintainer judgment.

**REVIEW-LATER impact:**
- **Top-level open count:** pending/ index drops from 11 entries → 6 entries (PEND-62 / 68 / 69 / 70 / 71 / 75 deleted; PEND-68's content shipped as a hook + App.tsx swap).
- **Previously resolved:** 1245+ → 1252+ across 800 → 801 sessions.

**Files touched (this session):**
- `.github/workflows/release.yml` (+28 / −2; --generate-notes swap on both occurrences with explanatory comments)
- `src/hooks/useHasHardwareKeyboard.ts` (new, +101)
- `src/hooks/useShouldShowMobileChrome.ts` (new, +54)
- `src/hooks/__tests__/useHasHardwareKeyboard.test.tsx` (new, +101)
- `src/hooks/__tests__/useShouldShowMobileChrome.test.tsx` (new, +120)
- `src/App.tsx` (+8 / −1; useShouldShowMobileChrome import + selector + comment)
- `pending/PEND-62-mobile-unified-search.md` (deleted, −143)
- `pending/PEND-66-replace-execcommand.md` (status refresh; +7 / −4)
- `pending/PEND-68-tablet-keyboard-detection.md` (deleted, −86 after shipping)
- `pending/PEND-69 / 70 / 71 / 75` (deleted, −368 total)
- `pending/README.md` (5 index rows removed; "Recommended order" refreshed)

**Verification:**
- `npx vitest run` — 10326 / 10326 pass (+14 vs prior 10312, the new hook tests).
- `npx tsc -b --noEmit` — clean.
- `prek run --files <touched>` per commit — green (biome / tsc / vitest / markdownlint / yaml / actionlint).

**Process notes:** The CI release-notes bug was pre-existing (predates this session and PR #43); spotted when the user inspected 0.1.38's release page. Manual backfill of 0.1.38 used a hand-written changelog summary because GitHub's `releases/generate-notes` API listed PR #42 redundantly — the 0.1.37 tag points at `f0aa9f6a` (the original pre-squash branch state) which isn't an ancestor of main's `e333d748` (the squash-merge), so the API can't cleanly diff "what's new in 0.1.38". Future releases bumped after the workflow fix will get a clean changelog without this fallback because GitHub will diff against the previous tag's commit-which-IS-an-ancestor (the bump-version commit itself).

**Commit plan:** single topic branch `fix-release-notes-autogen` carrying 5 commits; one PR.

---
