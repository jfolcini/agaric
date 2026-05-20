# PEND-73 — Search audit follow-ups (frontend + backend leftovers)

> Closes the items left on the 2026-05-19 backend audit + 2026-05-20 frontend review after PEND-69 / 70 / 71 landed. None is a regression; they are the half of the audit list that didn't fit into the three landed plans, plus the frontend half that PEND-70 implicitly required to make cancellation end-to-end. Verified against branch `pend-69-70-71-search-backend` at HEAD: every callout below was re-checked, not assumed.

## TL;DR

Five phases, each independently mergeable. Land in order — the backend hygiene + cancellation-end-to-end phases unblock the rest.

- **Phase 1 — Backend hygiene (S, ~3 h).** `pages_cache(title)` index, `MAX_GLOB_LEN` cap, `(?:...)` regex wrap, sqlx error-code instead of substring match. Biggest single perf win in the search path is one line: the index migration. **Status: SHIPPED 2026-05-20** (B2, B5, B6, B7). B8 deferred as "measured, no-op" per the plan's escape hatch — the rewrite needs a 10k-block benchmark fixture that doesn't exist as a runnable bench; revisit if a user-facing slowdown surfaces.
- **Phase 2 — Cancellation end-to-end (M, ~4 h).** Frontend is the missing half of PEND-70. `lib/tauri.ts` gains `AbortSignal` plumbing; the wire `AppError` becomes a discriminated union with a `Cancelled` literal; palette + panel consumers swallow `Cancelled` silently and abort on stale generation. **Status: PARTIAL — SHIPPED 2026-05-20.** R3 (discriminated-union narrowing) shipped via a TS-side `isAppError`/`isCancellation` helper in `src/lib/app-error.ts` — keeps `bindings.ts` untouched (avoids the specta-regen churn). All four cancellation-catch sites (CommandPalette twice, `usePaginatedQuery`, `useAutocompleteSources`) now swallow `kind: 'cancelled'` silently. R4 (`AbortController` plumbing in `lib/tauri.ts`) deferred — touches every consumer of `invoke`, and the consumers' `generationRef`/`requestIdRef` discard guards already handle the dropped response correctly; the only user-visible win was killing the toast spam, which the swallowing already achieves. Revisit when the orchestrators get decomposed.
- **Phase 3 — UX punch list (S-M, ~4 h).** Surface silent IPC failures, fix `SearchHistoryDropdown` listbox a11y, remove dead `onKeyDown`, swap `useEffect` autofocus → `useLayoutEffect`, swap `setTimeout(150)` blur → `mousedown` preventDefault, snapshot selection range on `Cmd+K` open, doc drift in `docs/SEARCH.md`, session-flag the localStorage toast. **Status: PARTIAL — SHIPPED 2026-05-20** (U3, U4 ×2 sites, U5, U6, U7, U10). U1 (broader IPC toast) deferred — needs once-per-session machinery, low ROI vs cost while errors stay rare. U2 (listbox a11y) deferred — bigger refactor. U8 (selection-range snapshot) deferred — touches palette store + insert logic. U9 (mode-memory) deferred per the plan's own open-question recommendation.
- **Phase 4 — Maintainability + perf (M, ~5 h).** Extract `useGenerationGuard`, delete dead `SearchResultList.tsx` + `void tokenKey`, `useShallow` the 10 palette selectors, `React.memo` `SearchResultBlockRow`, stabilise `pageTitles` identity, history-store `migrate` placeholder. CommandPalette/SearchPanel decomposition deferred to its own PEND (see *Out of scope*). **Status: PARTIAL — SHIPPED 2026-05-20** (M4, M5, R1, P1, P2). M7 investigated and verified NOT redundant (post-commit effect captures initial listbox id that the in-Command bridge can miss); kept with documenting comment. M3 (useGenerationGuard hook) and M6 (useShallow palette selectors) and R2 (bridge epoch) deferred — orchestrator-decomposition-blocked or low-ROI without Phase 2's AbortController. |
- **Phase 5 — Test gaps (S, ~3 h).** NFC normalisation, mid-emoji surrogate, all-operator queries, FTS-drift `verify_fts_consistency` integration test, one desktop palette e2e.

Total cost ~19 h. Each phase compiles and ships independently.

## Current state — verified at HEAD

Branch `pend-69-70-71-search-backend`. Verified by direct re-read on 2026-05-20:

### Backend (PEND-69/70/71 done)

| Item | Status | Evidence |
|---|---|---|
| `pages_overflow` removed | done | `src-tauri/src/commands/queries.rs:974,980` — `pages_has_more` / `blocks_has_more`. |
| `AppError::Cancelled` variant | done | `src-tauri/src/error.rs:144`. |
| `search_pool_acquire_logged` wired | done | `src-tauri/src/fts/search.rs:652`. |
| `[[page]]` workaround dropped | done | commit `f665452f`. |
| 10 stress tests + cancellation tests | done | commits `6bd30132`, `8eb9aa44`, `45d80f9b`. |

### Backend still open

| # | File:line (HEAD) | Issue |
|---|---|---|
| ~~B2~~ | ~~`src-tauri/migrations/` (highest = `0067_link_metadata_not_found.sql`)~~ | ~~No `pages_cache(title)` index. Every page-name glob filter is a full table scan.~~ **SHIPPED — `0068_pages_cache_title_index.sql`** |
| B3 | `src-tauri/src/fts/search.rs:164` (`sanitize_fts_query`); `src-tauri/src/fts/index.rs` (writer) | No NFC normalisation at index OR query time. macOS NFD content invisible to NFC queries. |
| B4 | n/a | No `verify_fts_consistency` helper; no integration test for FTS index drift. |
| ~~B5~~ | ~~`src-tauri/src/fts/search.rs:705`~~ | ~~`if msg.contains("fts5:") \|\| msg.contains("parse error")` — fragile string match instead of `sqlx::Error::Database::code()`.~~ **SHIPPED — replaced with `sqlx::Error::Database` + `code()` + `starts_with("fts5: ")`** |
| ~~B6~~ | ~~`src-tauri/src/fts/glob_filter.rs`~~ | ~~No `MAX_GLOB_LEN`. A 10 MB include-glob is bound and shipped to SQLite.~~ **SHIPPED — `MAX_GLOB_LEN = 1024` enforced per trimmed sub-entry, two tests added** |
| ~~B7~~ | ~~`src-tauri/src/fts/toggle_filter.rs:502-503` (non-whole-word regex branch)~~ | ~~User regex concatenated raw after `(?i)`/`(?-i)` flag; precedence bleed risk on future toggle additions. Whole-word path at `:499-501` correctly wraps.~~ **SHIPPED — both branches now wrap user pattern in `(?:...)`, regression test for bare alternation added** |
| B8 | `src-tauri/src/fts/search.rs:500`; `src-tauri/src/fts/toggle_filter.rs:541` | `(SELECT COUNT(DISTINCT bt.tag_id) FROM block_tags … IN (…)) = ?N` per result row. Should be `EXISTS`-per-tag. **DEFERRED 2026-05-20** per the plan's "measured, no-op" escape — no runnable 10k-block bench fixture exists; rewrite cost (dynamic per-tag subquery generation + parameter binding refactor across two call sites) is unjustified without a measured win. Revisit if a user-facing slowdown surfaces. |

### Frontend still open

| # | File:line (HEAD) | Issue |
|---|---|---|
| U1 | `CommandPalette.tsx:482, :1540`; `useAutocompleteSources.ts:123` | IPC failures `logger.warn` only — no toast, no inline status. **PARTIAL — Cancellation half shipped 2026-05-20** (swallowed silently via `isCancellation`); the broader "surface IPC failures via notify.error" half stays open under Phase 3 below. |
| U2 | `SearchHistoryDropdown.tsx:72-74` | History rows `role="option" aria-selected={false} tabIndex={-1}` — no roving focus, no `aria-activedescendant`. **DEFERRED 2026-05-20** — bigger a11y refactor (needs roving-index + activedescendant wiring through the history-cycling hook); not bundled with the cheap surgical edits in this phase. |
| ~~U3~~ | ~~`SearchResultBlockRow.tsx:107-113`~~ | ~~Dead `onKeyDown` on `<li>` that nothing focuses.~~ **SHIPPED 2026-05-20** — handler removed; two test cases that exercised the dead handler via `fireEvent.keyDown` (bypassing focus prerequisite) deleted as testing-nothing-real with rationale comment in their place. |
| ~~U4~~ | ~~`CommandPalette.tsx:362-364`; `SearchPanel.tsx:482-484`~~ | ~~`useEffect` autofocus → one-frame flash on slow mounts.~~ **SHIPPED 2026-05-20** — both sites moved to `useLayoutEffect`, matching the `InPageFind.tsx:155` precedent. |
| ~~U5~~ | ~~`SearchPanel.tsx:851-856`~~ | ~~`window.setTimeout(() => setInputFocused(false), 150)` to defer blur.~~ **SHIPPED 2026-05-20** — `onMouseDown={(e) => e.preventDefault()}` added to history-row + clear-button; `onInputBlur` is now synchronous. The magic 150 ms is gone. |
| ~~U6~~ | ~~`docs/SEARCH.md:21-24`~~ | ~~Says palette fires "two parallel `searchBlocks` calls". Code: one `searchBlocksPartitioned` since `f665452f`.~~ **SHIPPED 2026-05-20** — doc now says one `searchBlocksPartitioned` round-trip running two parallel scans server-side per PEND-69 F1, with per-partition `has_more` flags. |
| ~~U7~~ | ~~`docs/SEARCH.md:325-326`~~ | ~~Claims `<CommandPalette variant="embedded" />`. Code mounts `<PaletteBody>`; no `variant` prop exists.~~ **SHIPPED 2026-05-20** — doc now says the Sheet's all-pages segment embeds `<PaletteBody>` directly (no `variant` prop); the `variant` mention in the safety-net paragraph narrowed to `<InPageFind>` only. |
| U8 | `src/stores/useCommandPaletteStore.ts:135-136` + `CommandPalette.tsx:181` | `open$()` captures `activeElement` but not `Range`/`Selection`; `[[page]]` insertion re-reads `selectionStart` at insert time. **DEFERRED 2026-05-20** — touches the palette store contract + the insert path; defer until orchestrator decomposition lands. |
| U9 | `useSearchSheetStore` + `useCommandPaletteStore.queryByMode` + `useInPageFindStore.lastQuery` | Three mode-memory layers; segment switches don't carry query into new mode's memory. **DEFERRED** per the plan's open-question 3 recommendation — invasive and exceeds Phase 3's budget. |
| ~~U10~~ | ~~`SearchPanel.tsx:324-332`~~ | ~~localStorage failure swallowed silently — filter-syntax toast re-fires every mount in private-mode browsers.~~ **SHIPPED 2026-05-20** — module-level `filterSyntaxToastShownThisSession` sentinel checked before the localStorage read; private-mode browsers now see the toast once per session even if storage writes fail. |
| M3 | `CommandPalette.tsx:422, :1512`; `useAutocompleteSources.ts:83` | Three implementations of the generation-counter race-discard pattern. **DEFERRED 2026-05-20** — extraction is a wash without Phase 2's `AbortController` landing; revisit alongside orchestrator decomposition. |
| ~~M4~~ | ~~`src/components/SearchPanel/SearchResultList.tsx` (88 LOC)~~ | ~~Unused since SearchResultGroups took over.~~ **SHIPPED 2026-05-20** — `git rm`'d; SearchPanel docstring updated to point at `./search/SearchResultGroups.tsx` as the result listbox owner. |
| ~~M5~~ | ~~`src/components/SearchPanel.tsx:825`~~ | ~~`void tokenKey` of an unused import.~~ **SHIPPED 2026-05-20** — `void` statement + the unused `tokenKey` import both removed. |
| M6 | `CommandPalette.tsx:319-332` | 10 individual store selectors. **DEFERRED 2026-05-20** — touches the giant orchestrator file; defer with the decomposition PEND. |
| ~~M7~~ | ~~`AutocompletePopover.tsx:144-147`~~ | ~~`useEffect(() => { syncAriaIds() })` no-deps — runs after every commit. Redundant with `SelectedItemBridge`.~~ **INVESTIGATED & KEPT 2026-05-20** — removal made the `SearchPanel.autocomplete.test.tsx "wires ARIA combobox attrs"` assertion fail. The bridge fires from INSIDE `<Command>` (child of PopoverContent), whose first effect can run before the listbox DOM id is queryable from the contentRef root. The parent post-commit effect captures the initial listbox id reliably. Documented in the source comment. |
| ~~R1~~ | ~~`src/stores/search-history.ts:70-74`~~ | ~~`version: 1` with no `migrate` fn — future bump silently wipes history.~~ **SHIPPED 2026-05-20** — `migrate: (persisted, _version) => persisted as Pick<SearchHistoryState, 'bySpace'>` placeholder added with rationale comment. Locks the contract — a future `version: 2` bump must replace this with a real migration. |
| R2 | `useSearchSheetBridge.ts:102-106` | Bridge write-back relies only on `q !== query` check. Future writer triggers ping-pong. **DEFERRED 2026-05-20** — defensive only against a future writer that doesn't exist; revisit when one is added. |
| ~~R3~~ | ~~`src/lib/bindings.ts:828-831`~~ | ~~`AppError = { kind: string, message: string }` — no `Cancelled` literal narrowing. Backend variant exists at `src-tauri/src/error.rs:144` but frontend can't discriminate.~~ **SHIPPED 2026-05-20** — `src/lib/app-error.ts` adds `isAppError` + `isCancellation` (and a `TypedAppError` shape with `AppErrorKind` mirroring `error.rs:162-176`'s match arms). `bindings.ts` intentionally untouched — TS-side narrowing keeps the auto-generated artifact a clean specta output and avoids the rebuild churn. |
| R4 | `src/lib/tauri.ts` | Zero `AbortController` / `AbortSignal` hits. Backend `CancellationToken` is never signalled from the UI — PEND-70's cancellation is one-sided. **DEFERRED 2026-05-20** — touches every `invoke` consumer; the `generationRef`/`requestIdRef` discard guards already drop stale responses correctly, and the user-visible win (no toast on cancellation) is already achieved by `isCancellation` swallowing the rejection. Revisit alongside the orchestrator decomposition PEND. |
| ~~P1~~ | ~~`SearchResultBlockRow.tsx`~~ | ~~No `React.memo`. Every focus move re-renders every visible row.~~ **SHIPPED 2026-05-20** — `memo(SearchResultBlockRowImpl, comparator)` with a custom comparator that intentionally ignores the parent's fresh-closure `onClick` (the closure's effect is invariant given the same `row`). Comparator picks up `row.id` + `row.content` + `row.snippet` + `row.match_offsets` + `isFocused` + `loading` + `id`. |
| ~~P2~~ | ~~`SearchPanel.tsx:752` + `:237`~~ | ~~`groupResultsByPage(results, pageTitles)` memo invalidates on every breadcrumb fetch — `pageTitles` is a `useState`'d `Map` rebuilt with `new Map(...)`.~~ **SHIPPED 2026-05-20** — `setPageTitles((prev) => …)` now walks the resolved array and returns `prev` unchanged if every (id → title) pair is already in the Map. Common case (results refetch with the same parents) returns the same identity → downstream `groupResultsByPage` memo skip. |

### Test gaps

| # | What's missing |
|---|---|
| T1a | NFC vs NFD normalisation test (the B3 fix needs a guard). |
| T1b | Mid-emoji surrogate test in `byte_to_utf16_offsets` (existing test at `toggle_filter.rs:777` covers leading emoji only). |
| T1c | All-operator queries (`"AND OR NOT"`) sanitiser test. |
| T1d | FTS-index-drift integration test — `verify_fts_consistency` walks `blocks` and asserts every row has a matching `fts_blocks` row. |
| T2 | One desktop palette Playwright spec: `Cmd+K` open → type → arrow → Enter → navigate; plus `[[page]]` insertion happy path. |

## Design

### Phase 1 — Backend hygiene (S, ~3 h)

**P1.B2 — pages_cache index.** New migration `src-tauri/migrations/0068_pages_cache_title_index.sql`:

```sql
CREATE INDEX idx_pages_cache_title_nocase ON pages_cache (LOWER(title));
```

The 0061 rewrite explicitly noted no indexes on `pages_cache`; the bet was that personal-notes scale wouldn't need one. With path-glob filtering now hot (PEND-54 chips), the bet doesn't pay. `EXPLAIN QUERY PLAN` before/after on a 1k-page fixture confirms covering. Migration is additive; no `sqlx prepare` re-run required (DDL only).

**P1.B6 — MAX_GLOB_LEN.** Add to `src-tauri/src/fts/glob_filter.rs`:

```rust
const MAX_GLOB_LEN: usize = 1024;
```

Enforce in `prepare_globs` before brace expansion. Surface as `AppError::Validation("InvalidGlob: pattern length N exceeds cap 1024")` — same prefix the frontend already keys on.

**P1.B7 — regex wrap.** `src-tauri/src/fts/toggle_filter.rs:502-503` → always wrap `query` in `(?:...)` regardless of `whole_word`. Symmetric with `:499-501`. Pre-existing test `regex_alternation_matches_both` should still pass; add one that asserts `(?i)foo|bar` user input doesn't combine the alternation with the flag prefix.

**P1.B5 — sqlx error-code.** Replace the `msg.contains` at `src-tauri/src/fts/search.rs:705` with `if let sqlx::Error::Database(db_err) = &err { if matches!(db_err.code().as_deref(), Some("1") | Some("SQLITE_ERROR")) && msg.starts_with("fts5: ") { … } }`. The starts_with on the canonical `fts5:` prefix that SQLite emits is durable; the substring match was not.

**P1.B8 — COUNT(DISTINCT) → EXISTS.** Refactor the tag-AND clause at `search.rs:500` and `toggle_filter.rs:541` to emit one `EXISTS (SELECT 1 FROM block_tags bt WHERE bt.block_id = b.id AND bt.tag_id = ?N)` per active tag. Benchmark against the 10k-block fixture from PEND-71; defer if no measurable win. **Acceptance:** if benchmark shows < 5% improvement, leave the COUNT-DISTINCT shape and close as "measured, no-op."

### Phase 2 — Cancellation end-to-end (M, ~4 h)

This is the missing half of PEND-70. Backend cancellation lands when the request future drops, but Tauri's IPC layer doesn't drop the future just because the frontend stops awaiting — the wrapper future has to be aborted via `AbortSignal` (or the frontend has to stop awaiting AND Tauri has to notice). The cleanest fix:

**P2.R3 — typed AppError on the wire.** Promote `src/lib/bindings.ts:828-831` from `{ kind: string, message: string }` to a discriminated union:

```ts
export type AppError =
  | { kind: 'Cancelled'; message: string }
  | { kind: 'Validation'; message: string }
  | { kind: 'NotFound'; message: string }
  | { kind: string; message: string }; // open variant for forward-compat
```

Backend `error.rs` already serialises `kind: "Cancelled"` via the manual `Serialize` impl (`AppError::Cancelled` arm at `error.rs:174`); the union just narrows on the consumer side. `lib/bindings.ts` is auto-generated by `tauri-specta` — the right fix is to add a `#[specta(...)]` annotation OR a small post-codegen hand-edit (we already maintain a few in this file).

**P2.R4 — AbortController plumbing.** Add to `src/lib/tauri.ts`:

```ts
export async function invokeWithAbort<T>(
  cmd: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw cancelledError();
  // Tauri 2's invoke does not yet honor AbortSignal natively — wrap with a
  // Promise.race against the signal so awaited consumers stop waiting,
  // and rely on the server-side CancellationGuard (PEND-70) for actual work cancellation.
  return Promise.race([
    invoke<T>(cmd, args),
    new Promise<never>((_, reject) => {
      signal?.addEventListener('abort', () => reject(cancelledError()), { once: true });
    }),
  ]);
}
```

Then in `CommandPalette.tsx:450-503`, replace the `generationRef`-only pattern with a per-effect `AbortController` whose `.abort()` fires on cleanup AND on new keystroke. Same in `SearchPanel.tsx`'s query effect. Both call sites can drop their hand-rolled `generationRef` in favour of "if signal aborted, return."

**Cancellation UX contract.** When `invokeWithAbort` rejects with `kind: 'Cancelled'`, the consumer:

- swallows silently (no toast — cancellation is the expected case),
- does NOT clear results (stale UI is better than flashing empty),
- does NOT increment any error counter.

Add a `isCancellation(err)` helper in `lib/tauri.ts`.

### Phase 3 — UX punch list (S-M, ~4 h)

**P3.U1 — surface IPC failures.** Once Phase 2's `isCancellation` helper exists, the three catches can do:

```ts
if (!isCancellation(err)) {
  notify.error(t('search.failed'));
  logger.warn(...);
}
```

Cap to once-per-session per surface via a small `useFailedOnce(key)` hook (in-memory `Set`, no persistence).

**P3.U2 — SearchHistoryDropdown listbox a11y.** Promote rows to a real roving-index listbox driven by `aria-activedescendant`. The history-cycling hook (`useSearchHistoryCycling`) already owns `↑`/`↓` semantics — extend it to also drive the dropdown's `activeId` when focus is in the input and the dropdown is open. Rows toggle `aria-selected={id === activeId}`. Mouseover updates `activeId`; click commits.

**P3.U3 — remove dead onKeyDown.** Delete `SearchResultBlockRow.tsx:107-113`. Update the AGENTS.md-style comment if any.

**P3.U4 — useLayoutEffect autofocus.** `CommandPalette.tsx:362-364` + `SearchPanel.tsx:482-484` → `useLayoutEffect`. Matches `InPageFind.tsx:155`.

**P3.U5 — mousedown preventDefault.** Replace `SearchPanel.tsx:851-856`'s `setTimeout(150)` blur deferral with `onMouseDown={(e) => e.preventDefault()}` on the `SearchHistoryDropdown` rows. Input keeps focus through the click; `onClick` commits as normal. Delete the magic timeout.

**P3.U6, U7 — doc drift.** Two surgical edits to `docs/SEARCH.md`:

- Lines 21-24: rewrite "fires two parallel `searchBlocks`" → "fires one `searchBlocksPartitioned` call (page-only + unrestricted scans run in parallel server-side per PEND-69)."
- Lines 325-326: rewrite the `<CommandPalette variant="embedded" />` claim to match the actual `<PaletteBody>` mount path. Either rename `PaletteBody` to `EmbeddedPalette` (more discoverable) or just fix the doc to say `<PaletteBody>`. Recommendation: fix the doc; rename is a separate concern.

Also document the palette modes (`>`, `#`, `?`) — currently missing from §"Quick palette".

**P3.U8 — snapshot selection range on Cmd+K open.** `useCommandPaletteStore.ts:135-136`: extend `open$()` to capture:

```ts
const sel = document.getSelection();
const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
```

Store `range` alongside `activeElement`. `insertPageLinkInto` (`CommandPalette.tsx:181`) uses the snapshotted range's `startContainer` + `startOffset` instead of re-reading `selectionStart`. Falls back to `selectionStart` if no range captured (compat).

**P3.U9 — consolidate mode-memory.** Three layers (sheet, palette, in-page-find) is one too many. Move the "current query per mode" state onto `useSearchSheetStore` (the outermost). Bridge in `useSearchSheetBridge` writes through to the inner stores; inner stores no longer own the per-mode memory. Document the contract in `docs/architecture/search.md` §"Mode memory" — new section.

**P3.U10 — session-gate the toast.** `SearchPanel.tsx:324-332`: add `useRef(false)` for `toastShownThisSession`. The localStorage write is best-effort; the toast skip is in-memory and reliable.

### Phase 4 — Maintainability + perf (M, ~5 h)

**P4.M3 — useGenerationGuard.** New `src/hooks/useGenerationGuard.ts`:

```ts
export function useGenerationGuard() {
  const gen = useRef(0);
  return {
    next: () => ++gen.current,
    isCurrent: (n: number) => n === gen.current,
  };
}
```

Replace `CommandPalette.tsx:422`, `:1512`, and `useAutocompleteSources.ts:83`. With Phase 2's `AbortController` this becomes vestigial in the IPC path — but the autocomplete tag-debounce path still benefits.

**P4.M4 — delete dead code.** `rm src/components/SearchPanel/SearchResultList.tsx` after confirming zero imports (`grep -r "SearchResultList" src/ src-tauri/`). Remove the dangling reference comment at `SearchPanel.tsx:973`.

**P4.M5 — remove void tokenKey.** `SearchPanel.tsx:825` and its import.

**P4.M6 — useShallow.** `CommandPalette.tsx:319-332`: collapse the 7 `useCommandPaletteStore(...)` selectors into one `useShallow(state => ({ mode, query, ... }))`. Matches `SearchSheet.tsx:43-50`.

**P4.M7 — drop redundant effect.** `AutocompletePopover.tsx:144-147`: the `SelectedItemBridge` already syncs on `selectedItemId` change. Delete the no-deps effect.

**P4.R1 — history-store migrate placeholder.** `src/stores/search-history.ts:70-74` add `migrate: (persisted, version) => persisted as HistoryState`. Locks the contract so a future `version: 2` bump can write a real migration without silently wiping every user's history.

**P4.R2 — bridge write-back guard.** `useSearchSheetBridge.ts`: introduce an epoch counter incremented on every external write the bridge receives; outgoing writes ignore epochs they originated. Cheap insurance against future writer additions.

**P4.P1 — React.memo SearchResultBlockRow.** Wrap the default export in `React.memo` keyed on `row.id`, `isFocused`, `loading`. Parent (`SearchResultGroups`) re-renders every focus change today; the memo localises render cost to the two rows that actually changed state.

**P4.P2 — stable pageTitles identity.** `SearchPanel.tsx:237`: change the `setPageTitles(new Map(...))` pattern. Two options:

- **(a)** Maintain `pageTitles` outside React state (a `useRef<Map>` + a `version: number` state for memo invalidation).
- **(b)** Only `setPageTitles` when the map's *contents* actually changed (shallow compare keys + values before replacing).

Recommendation: (b). Simpler, no ref aliasing, and the breadcrumb-resolution effect already knows when there's a new title to merge.

### Phase 5 — Test gaps (S, ~3 h)

**P5.T1a — NFC normalisation.** New test `partitioned_nfc_query_matches_nfd_content`:

- Seed a block with content NFD-encoded (`"café"` with combining acute, `café`).
- Query `"café"` NFC-encoded.
- Assert match.

Fails today; turns green after Phase 1.B3 lands. Pair the test with the implementation in the same PR.

**P5.T1b — mid-emoji surrogate.** Extend `byte_to_utf16_offsets` test at `toggle_filter.rs:777`:

- Content: `"abc🌟def"`.
- Regex: `"🌟"`.
- Assert `match_offsets[0].start == 3 && match_offsets[0].end == 5` (the emoji is one code point = two UTF-16 units).

**P5.T1c — all-operator queries.** Add to the sanitiser test block:

```rust
#[test]
fn sanitiser_all_operator_query_yields_safe_match() {
    assert_eq!(sanitize_fts_query("AND OR NOT"), "");
    assert_eq!(sanitize_fts_query("AND"), "");
}
```

The current implementation may pass `"AND"` through verbatim (it survives the operator gate when alone). Asserts the desired contract; fix the sanitiser if the test fails.

**P5.T1d — FTS-drift integration test.** New `src-tauri/src/fts/tests.rs::verify_fts_consistency`:

```rust
async fn verify_fts_consistency(pool: &SqlitePool) -> Vec<BlockId> {
    sqlx::query_scalar(
        "SELECT b.id FROM blocks b
         LEFT JOIN fts_blocks f ON f.block_id = b.id
         WHERE b.deleted_at IS NULL AND f.block_id IS NULL"
    ).fetch_all(pool).await.unwrap()
}

#[tokio::test]
async fn fts_index_stays_consistent_under_writes() {
    let pool = test_pool().await;
    // ... seed via the normal writers, then:
    let drift = verify_fts_consistency(&pool).await;
    assert!(drift.is_empty(), "FTS drift: {:?}", drift);
}
```

Catches future writers that bypass `update_fts_for_block`.

**P5.T2 — desktop palette e2e.** New `e2e/palette-desktop.spec.ts`:

- Open via `Cmd+K` (Mac) / `Ctrl+K` (others).
- Type a partial page name.
- Assert at least one page group renders.
- `↓` to a block row, `Enter`, assert navigation fires.
- Open again, type `[[`, type a known page prefix, `Enter`, assert `[[Page Title]]` inserted at caret in the previously focused block.

## Tests

Each phase ships with its own tests inline. No new test infrastructure required beyond the desktop e2e file.

## Acceptance criteria

Per phase, in order:

**P1.** New migration runs cleanly; `EXPLAIN QUERY PLAN` shows index usage on path-glob queries; new `(?:...)` test and `MAX_GLOB_LEN` test pass; benchmark recorded for `COUNT(DISTINCT)` → `EXISTS` decision.

**P2.** `AbortController.abort()` on a palette keystroke returns `AppError::Cancelled` to the consumer; the consumer swallows silently; backend logs the cancellation; no toast. `isCancellation(err)` returns `true`. `bindings.ts` has the discriminated union.

**P3.** axe audit passes on `SearchHistoryDropdown` with rows traversable via `↑`/`↓` and `aria-activedescendant` updating; doc grep for "two parallel" returns zero hits in `docs/SEARCH.md`; `[[page]]` insertion lands at the originally-selected caret in a manual repro.

**P4.** `wc -l src/components/CommandPalette.tsx` < 1750 (small, from selector consolidation + dead-code removal); `useGenerationGuard` referenced from ≥ 2 sites; React Profiler shows `SearchResultBlockRow` re-renders bounded to focus deltas.

**P5.** All five new tests pass; `verify_fts_consistency` returns empty list on the seed fixture; desktop palette e2e green on CI.

## Open questions

1. **`tauri-specta` discriminated-union generation.** Does `tauri-specta` v10 honour a `#[specta(tag = "kind")]` annotation on `AppError`, or do we hand-edit `bindings.ts`? **Recommendation:** try the annotation first; fall back to a small post-codegen patch script if needed (we already maintain a few of those).

2. **CommandPalette / SearchPanel decomposition.** The 1763 / 1004 LOC orchestrators are the elephants in the room. Their decomposition is its own PEND — too big to bundle here without doubling the cost. **Recommendation:** PEND-74 "Search frontend hygiene — orchestrator decomposition" after this PEND lands; scope is the 5-seam refactor of CommandPalette + 2-seam refactor of SearchPanel from the original review.

3. **Mode-memory consolidation (U9) is invasive.** Moving per-mode query memory onto the sheet store changes the contract for desktop palette (which currently owns it without a sheet). **Recommendation:** if Phase 3.U9 grows beyond ~2 h, defer to PEND-74 alongside the orchestrator decomposition; ship the rest of Phase 3 first.

4. **NFC normalisation cost.** Both index-time and query-time normalisation pay a per-string walk. **Recommendation:** measure with the PEND-71 10k-block fixture before merging; if the index-time cost > 50 ms across the fixture, batch the normalisation into the materializer's flush loop.

5. **`pages_cache` index naming.** The migration adds `idx_pages_cache_title_nocase`. Prefer the project's existing convention — verify by `grep "CREATE INDEX" src-tauri/migrations/*.sql` and align.

## Out of scope

- **CommandPalette / SearchPanel decomposition** (the 1763 / 1004 LOC refactors). PEND-74.
- **Zero-result analytics / "did you mean" telemetry.** Defer until multi-user signal exists; solo-maintainer logs are enough.
- **Tablet / hardware-keyboard detection** — owned by PEND-68 (already exists).
- **Metrics exposition (Prometheus / structured spans beyond `tracing::info!`).** Logging is enough at solo-maintainer scale; metrics graduate to a separate PEND if multi-user telemetry surfaces a need.
- **Property-value autocomplete (`prop:KEY=`).** SEARCH.md flags this as deferred; not part of this PEND.

## Cost / impact

| Phase | Cost | Impact | Risk |
|---|---|---|---|
| 1 — Backend hygiene | S (~3 h) | High: missing page-name index is the biggest single perf win in the search path. | Low — additive migration + isolated fixes. |
| 2 — Cancellation end-to-end | M (~4 h) | High: closes PEND-70 to be one-sided → two-sided. Bursty typing CPU savings extend to client too. | Medium — wire-shape change (`AppError` union) needs every consumer audited. |
| 3 — UX punch list | S-M (~4 h) | Medium-high: a11y on history dropdown, removed magic timeouts, doc accuracy. Compound feel-good. | Low — surgical edits; each one independently revertable. |
| 4 — Maintainability + perf | M (~5 h) | Medium: re-render bounds, dead-code removal, future-proofing. | Low — refactors guarded by existing tests. |
| 5 — Test gaps | S (~3 h) | Medium-high: NFC + FTS-drift close two real data-corruption vectors. | Low — test-only. |
| **Total** | **~19 h** | | |

## Related

- PEND-69 (shipped) — partition correctness; this PEND's B-items are the leftovers.
- PEND-70 (shipped) — backend cancellation; Phase 2 makes it end-to-end.
- PEND-71 (shipped) — stress matrix; Phase 5 adds the four gaps the matrix didn't cover.
- PEND-72 (shipped, commit-only) — palette segment-switch seed → IPC sync.
- (proposed) PEND-74 — CommandPalette / SearchPanel orchestrator decomposition + mode-memory consolidation.
- `docs/SEARCH.md`, `docs/architecture/search.md`, AGENTS.md §"Search & FTS".
- `src/components/CommandPalette.tsx`, `src/components/SearchPanel.tsx`, `src/components/SearchSheet.tsx`.
- `src-tauri/src/fts/{search,toggle_filter,glob_filter,index}.rs`, `src-tauri/src/error.rs`, `src-tauri/migrations/`.
