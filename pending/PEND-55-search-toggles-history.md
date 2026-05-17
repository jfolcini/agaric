# PEND-55 — Search toggle row (`Aa` / `Ab|` / `.*`) + recent-query history

> Adds VSCode's three find-in-files toggles (case-sensitive, whole-word, regex) to `SearchPanel`'s input toolbar plus a **Zustand-persisted per-space search history** with browser-style `↑` / `↓` recall when the input is empty.
>
> **Depends on PEND-50** (foundation: `SearchFilter` struct, `SearchBlockRow.snippet`, grouped renderer, AppError prefix protocol). **Independent of PEND-54** (chip row above input vs toggle row to the right of input — different toolbar regions).
>
> Coordinates with **PEND-52** for the `Ctrl+F` ↔ `Ctrl+Shift+F` rebind: PEND-52 owns the rebind; this plan only updates the help dialog text.

## TL;DR

- **Backend:** ~M (~5-7 h). Append three `#[serde(default)] bool` fields to PEND-50's `SearchFilter` struct + an `Option<MatchOffset>` field on `SearchBlockRow`. New regex-mode no-FTS scan path (FTS5 MATCH cannot accept a regex). Post-FTS filter pipeline using the `regex` crate. `MatchOffset` carries **UTF-16 code-unit offsets** (not byte offsets) — critical for CJK / emoji highlight correctness.
- **Frontend:** ~M (~5-7 h). Three toggle buttons in the input toolbar using `lucide-react`'s `CaseSensitive` / `ALargeSmall` / `Regex` icons. Zustand-persisted `useSearchHistoryStore` at `agaric:search-history` (per-space, matching existing convention at `stores/recent-pages.ts:99`). Browser-style `↑` / `↓` recall when input empty.
- **Docs:** ~S (~1.5 h). Help dialog *Toggles*, *Regex syntax*, *Boolean operators*, *Tips* sections + `docs/SEARCH.md` extension + `AGENTS.md` invariants.
- **No migrations.** Reuses existing FTS5 trigram index; `regex = "1"` already in `src-tauri/Cargo.toml:128`.
- **Default UX unchanged.** Toggles off + no history = today's behaviour (after PEND-50). All new behaviour opt-in.

## Current state — verified against codebase

After PEND-50:

- `SearchFilter` request struct exists in `src-tauri/src/commands/queries.rs`. This plan appends three bool fields.
- `SearchBlockRow` response struct exists with `snippet: Option<String>`. This plan appends `match_offsets`.
- Grouped result rendering via `CollapsibleGroupList` is live.
- `<SearchResultBlockRow>` renders snippets as React nodes (no `dangerouslySetInnerHTML`). This plan extends it with an alternate `matchOffsets`-driven rendering path.

Verified codebase details:

- `regex = "1"` at `src-tauri/Cargo.toml:128` ✓ (Phase 2 verification confirmed).
- `lucide-react ^1.16.0` at `package.json:82`. **Direct icon substitutes exist**: `CaseSensitive` (for `Aa`), `ALargeSmall` or `CaseLower` (for `Ab|`-style "whole word"), `Regex` (for `.*`). No custom SVGs needed.
- Zustand persist convention at `stores/recent-pages.ts:99`, `stores/journal.ts:141`, `stores/navigation.ts:118` — name = `agaric:<feature>`. Per-space partitioning at `recent-pages.ts` (`recentPagesBySpace` keyed by space ID).
- `useLocalStoragePreference` at `src/hooks/useLocalStoragePreference.ts` is a typed defensive wrapper around localStorage **without cross-tab sync** (no `StorageEvent` listener). For history we use Zustand persist directly (cross-tab sync also unnecessary; histories are per-app-instance).
- `AppError` is `{kind: string, message: string}` via manual `Serialize` (`src-tauri/src/error.rs:152-165`). Validation errors flow through `AppError::Validation(format!("InvalidRegex: ..."))` and are parsed FE-side by prefix.
- `MAX_SEARCH_RESULTS = 100` at `src-tauri/src/fts/search.rs:17`.
- `useListKeyboardNavigation` (existing hook used at `SearchPanel.tsx:304`) — extended for the history dropdown listbox.

## Design

### UX

```text
┌────────────────────────────────────────────────────────────┐
│  (PEND-54 chip row, if landed; otherwise legacy chips)      │
│  [search…                              ] [Aa Ab| .*] ?     │  ← input + toggles + help
├────────────────────────────────────────────────────────────┤
│  ↑ Recent searches                                          │  ← on focus when input empty
│    TODO state:DOING                                         │
│    "sprint plan" tag:#review                                │
│    alpha cohort                                             │
│    Clear history                                            │
└────────────────────────────────────────────────────────────┘
```

- **Toggle row** renders to the right of the input, VSCode order: `Aa` (case-sensitive), `Ab|` (whole word), `.*` (regex). Each is a `<Toggle>` with `aria-pressed`, tooltip, and `lucide-react` icon. Container has `role="toolbar"`.
- **Toggles are query *modes*, not filters.** Intentionally **non-writable** as inline syntax (no `case:`, `regex:` token recognisers in PEND-54). Saved searches (filed in `pending/IDEAS.md`) must carry toggle state separately from the query string.
- **Toggle state** persists in component state across re-renders, **not** to disk for v1.
- **History dropdown** appears under the input on focus when empty. Lists last 20 distinct submitted queries, most-recent-first. Click → re-runs query. "Clear history" footer wipes the store.
- **`↑` / `↓` cycling** — when input empty (or caret at column 0, no selection), `↑` cycles backward through history into the input; `↓` forward. **Precedence rule** when PEND-54 has landed and PEND-54's autocomplete is open: autocomplete-open > history recall > result-list-nav (documented in AGENTS.md, owned by PEND-54).
- **History de-dupes on insert**: submitting the same query twice doesn't push duplicates.

### Toggle composition

The three toggles compose into a single regex pattern applied to the FTS candidate set (when at least one toggle is on):

| Toggle state | Pattern built from query `q` |
|---|---|
| (all off — default) | post-filter skipped entirely; FTS result is the final result |
| `Aa` only | `(?-i){escaped q}` |
| `Ab\|` only | `(?i)(?-u:\b){escaped q}(?-u:\b)` |
| `.*` only | `(?i){q}` (q is the user's regex, not escaped; sanitiser skipped) |
| `Aa` + `Ab\|` | `(?-i)(?-u:\b){escaped q}(?-u:\b)` |
| `Aa` + `.*` | `(?-i){q}` |
| `Ab\|` + `.*` | `(?i)(?-u:\b)(?:{q})(?-u:\b)` |
| All three | `(?-i)(?-u:\b)(?:{q})(?-u:\b)` |

**Case-sensitive note.** The FTS5 trigram index is `case_sensitive 0`. `Aa` forces the post-filter path even when no other toggle is set — FTS5 still returns a case-insensitive candidate set; the post-filter narrows it. Correct, but **not a free toggle**: enabling `Aa` always triggers the post-filter cost.

**Whole-word note.** The plan uses **`(?-u:\b)`** (explicit ASCII mode in the regex crate) rather than the default `\b`. CJK content (which the trigram FTS migration was justified to support) does NOT match the `\b` predicate because CJK characters aren't ASCII word characters — the boundary never asserts. **v1 documents this as ASCII-only whole-word**; a REVIEW-LATER tombstone files Unicode whole-word for future consideration. A test asserts the explicit behaviour (`\b会議\b` returns zero matches without panic).

### Regex mode — separate query path

When `is_regex = true`, the pipeline is **completely different** from the FTS path:

- **The sanitiser is skipped entirely** — the user's input is the regex pattern, verbatim.
- **FTS5 MATCH cannot accept a regex.** The FTS path is bypassed entirely.
- Instead: query `blocks` directly with the structural filters applied:

  ```sql
  SELECT b.id, b.block_type, b.content, b.parent_id, ..., NULL AS snippet
  FROM blocks b
  WHERE b.deleted_at IS NULL
    AND (?space_id IS NULL OR b.page_id IN (
      SELECT bp.block_id FROM block_properties bp
      WHERE bp.key = 'space' AND bp.value_ref = ?space_id))
    -- PEND-54's glob filters apply identically
    AND (?include_count = 0 OR b.page_id IN (SELECT pc.page_id FROM pages_cache pc WHERE LOWER(pc.title) GLOB LOWER(?inc1) OR …))
    AND (?exclude_count = 0 OR b.page_id NOT IN (...))
    -- PEND-53's typed-column filters apply identically
  ORDER BY b.created_at DESC
  LIMIT ?2 * 10  -- pre-filter cap; post-regex-filter trims to MAX_SEARCH_RESULTS
  ```

  Ordering is `created_at DESC` (most-recent-first) since `fts.rank` is unavailable in this path.

- **Pre-filter cap** (10× `limit`) bounds the regex scan: at most `1000` rows enter the regex matcher per query, of which at most `MAX_SEARCH_RESULTS = 100` survive. Document the cap; it's the only bound on regex-mode wall-time.
- Compile the regex via `regex::RegexBuilder::new(...).size_limit(1_000_000).dfa_size_limit(10_000_000).build()`. Compile failure → `AppError::Validation(format!("InvalidRegex: {}", err))`. FE parses the prefix.
- For each surviving row, run `regex::Regex::find_iter` against `stripped` (the FTS5 stripped column, retrievable via the FTS5 table by `block_id`, OR cached in `blocks` content). Emit byte offsets via `Match::start()` / `Match::end()`.
- **Convert byte offsets to UTF-16 code-unit offsets** before serialising (see next section).
- Cap **`MAX_OFFSETS_PER_BLOCK = 50`** — emitting thousands of offsets for a `.` regex would balloon the IPC payload. Document the cap in design; test exercises it.
- Re-emit pagination metadata (cursor recomputation against the filtered set).

**Document the trade-off** in `docs/SEARCH.md`: regex mode loses FTS-index acceleration; wall-time scales with the structurally-filtered block count, not the FTS candidate count. Recommend a literal seed term (≥3 chars) for tight queries; without it, the regex runs over `pre_filter_cap` candidates ordered by recency.

### UTF-8 → UTF-16 offset conversion

`regex::Match::start()` / `Match::end()` return **byte offsets** into a Rust UTF-8 `&str`. **JavaScript strings are UTF-16 code units** — `.length`, `.charCodeAt(i)`, `.substring(start, end)` all use UTF-16 indices. For ASCII content the offsets agree; for multi-byte UTF-8 they diverge:

- Rust UTF-8: `é` = 2 bytes, `日` = 3 bytes, `🌟` = 4 bytes.
- JS UTF-16: `é` = 1 code unit, `日` = 1 code unit, `🌟` = 2 code units (surrogate pair).

The conversion happens **in Rust** before the offsets are serialised:

```rust
pub struct MatchOffset {
    /// UTF-16 code-unit offset (matches JavaScript string indexing).
    pub start: u32,
    /// UTF-16 code-unit offset (matches JavaScript string indexing).
    pub end: u32,
}

fn byte_to_utf16_offsets(text: &str, byte_matches: &[(usize, usize)]) -> Vec<MatchOffset> {
    let mut utf16_offsets = Vec::with_capacity(byte_matches.len());
    let mut byte_to_u16: Vec<u32> = Vec::with_capacity(text.len() + 1);
    let mut u16_pos: u32 = 0;
    for (b_idx, c) in text.char_indices() {
        while byte_to_u16.len() <= b_idx {
            byte_to_u16.push(u16_pos);
        }
        u16_pos += c.len_utf16() as u32;
    }
    byte_to_u16.push(u16_pos);  // end sentinel
    for &(s, e) in byte_matches {
        utf16_offsets.push(MatchOffset { start: byte_to_u16[s], end: byte_to_u16[e] });
    }
    utf16_offsets
}
```

A test asserts offsets line up for `日本語` content (`prop:content="日本語"` regex search → `MatchOffset` values are JS-string-substring-safe).

### `SearchBlockRow` extension

```rust
pub struct SearchBlockRow {
    // ... PEND-50 fields including `snippet: Option<String>` ...
    /// UTF-16 code-unit offsets. Some(...) on the toggle path; None/empty on the default FTS path.
    #[serde(default)]
    pub match_offsets: Vec<MatchOffset>,
}
```

The TS-side projection (`Vec<MatchOffset>` → `MatchOffset[]`) is checked via `match_offsets.length > 0` to choose between the snippet-render path (PEND-50) and the offset-render path (this plan).

### `<SearchResultBlockRow>` extension

PEND-50's component accepts `row: SearchBlockRow`. Extended to:

- If `row.match_offsets.length > 0`: render `row.content` split by the offsets into alternating regular `<span>` and highlighted `<mark>` React nodes (NO `dangerouslySetInnerHTML`; identical DOM output to the snippet-render path).
- Else if `row.snippet`: render via the PEND-50 snippet-parser path.
- Else: render `row.content` plain.

### History storage

New `src/stores/search-history.ts`:

```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const MAX_HISTORY = 20

interface SearchHistoryState {
  byCSpace: Record<string, string[]>  // keyed by spaceId; per-space partitioning
  push: (spaceId: string, query: string) => void
  clear: (spaceId: string) => void
}

export const useSearchHistoryStore = create<SearchHistoryState>()(
  persist(
    (set) => ({
      byCSpace: {},
      push: (spaceId, query) => set((s) => {
        const existing = s.byCSpace[spaceId] ?? []
        const deduped = [query, ...existing.filter((q) => q !== query)].slice(0, MAX_HISTORY)
        return { byCSpace: { ...s.byCSpace, [spaceId]: deduped } }
      }),
      clear: (spaceId) => set((s) => ({ byCSpace: { ...s.byCSpace, [spaceId]: [] } })),
    }),
    { name: 'agaric:search-history' },
  ),
)
```

History triggers:

- Pushed on **submit** (Enter or debounce completion with non-empty parsed query). Pre-parse query string stored verbatim (preserves PEND-54 syntax).
- **Not** pushed on every keystroke.

### Components

- `src/components/search/SearchToggleRow.tsx` — three `<Toggle>` buttons (case-sensitive, whole-word, regex). `role="toolbar"` on the container. Each toggle has `aria-pressed`, tooltip via `<TooltipProvider>` (existing), `lucide-react` icon. State props passed down; no local state.
- `src/components/search/SearchHistoryDropdown.tsx` — Radix-popover-anchored listbox; appears on focus when input empty. `role="listbox"` with `role="option"` rows. Click fills input + triggers search. "Clear history" footer.
- `useSearchHistoryCycling(historyEntries, query, setQuery)` hook in `src/hooks/useSearchHistoryCycling.ts` — encapsulates the `↑`/`↓` browse-mode state machine (`{ mode: 'typing' | 'browsing', index: number }`), the column-0 / empty-input guards, and the reset on any non-arrow key.

### Edge cases (locked in)

- **`is_regex` set + empty query** → no-op, returns empty.
- **Regex compile fails** → `AppError::Validation` with `InvalidRegex:` prefix; inline red border on the input.
- **All toggles off** → post-filter skipped; PEND-50 snippet path used. Zero perf cost over today's behaviour.
- **History dropdown when history is empty** → "No recent searches" message; no "Clear history" entry.
- **History entry contains PEND-54 syntax** → restored verbatim; chip row (if PEND-54 landed) repopulates correctly via re-parse.
- **Multi-line regex** (`(?m)...`) → allowed; `regex` crate handles the flag.
- **Regex matching a zero-width pattern** (e.g. `(?=foo)`) → `find_iter` returns zero-width matches; emit empty offsets and drop the row (it's not a meaningful highlight).
- **Pathological regex** that matches thousands of times in a row → capped at `MAX_OFFSETS_PER_BLOCK = 50`; trailing matches dropped.

## Phase split

### Phase 1 — Toggle row + post-FTS filter (M, ~7-10 h)

- **Backend**: append `case_sensitive` / `whole_word` / `is_regex` to PEND-50's `SearchFilter` + `match_offsets: Vec<MatchOffset>` on `SearchBlockRow` + sanitiser carve-out for regex mode + **separate regex-mode SQL path** (no FTS5 MATCH) + post-FTS filter pipeline + byte→UTF-16 offset conversion + typed `AppError::Validation` with `InvalidRegex:` prefix.
- **Frontend**: `SearchToggleRow.tsx`; component-local toggle state; consume PEND-50's `<SearchResultBlockRow>` offset rendering path.
- Tests in a new file `src-tauri/src/commands/tests/toggle_filter_tests.rs` (avoid co-edit churn with `fts/tests.rs`).
- Help dialog populates *Toggles* and *Regex syntax* sections.

### Phase 2 — Search history (S, ~3-4 h)

- `useSearchHistoryStore` (Zustand persist at `agaric:search-history`, per-space partitioning).
- `SearchHistoryDropdown` + `useSearchHistoryCycling` hook.
- Wired into `SearchInput` (or `SearchInputWithFilters` if PEND-54 landed).
- Tests; help dialog *Tips* line.

### Phase 3 — Documentation polish (S, ~1 h)

- Help dialog *Boolean operators* tip line (sanitiser already supports `AND`/`OR`/`NOT`).
- `docs/SEARCH.md` extension: full regex / toggles / history reference + trade-off note about regex mode bypassing FTS.
- `AGENTS.md` invariants: regex-mode FTS bypass + UTF-16 offsets + `MAX_OFFSETS_PER_BLOCK` cap + `(?-u:\b)` for whole-word + history per-space.
- KeyboardShortcuts dialog: `↑` / `↓` recall row (`Ctrl+F` / `Ctrl+Shift+F` rebind owned by PEND-52).

## Testing surface

### Backend (`src-tauri/src/commands/tests/toggle_filter_tests.rs` — new file)

- All toggles off → post-filter skipped (verify via instrumentation: no `Regex::new` called).
- `case_sensitive` true → search for `Alpha` matches `Alpha`, not `alpha`; FTS still returns case-insensitive candidate set.
- `whole_word` true → `cat` matches `cat ran` but not `category`; ASCII-only verified explicitly.
- `is_regex` true with `^TODO` → matches blocks starting with `TODO`.
- `is_regex` true → FTS5 MATCH is **not called**; instrumentation verifies the separate query path is taken.
- `is_regex` true with invalid regex (`*`) → returns `AppError::Validation("InvalidRegex: ...")`.
- `size_limit` guard: compile a 2 MB regex string → typed error, no panic.
- All three toggles true with `\bTODO\b` → matches whole-word `TODO` case-sensitively.
- CJK whole-word `\b会議\b` → returns empty (documented behaviour with ASCII `(?-u:\b)`); no panic.
- **UTF-16 offset correctness**: `日本語` content matched by regex `本` → emitted `MatchOffset { start: 1, end: 2 }` (UTF-16 code units), not byte offsets.
- **Emoji** content `🌟Hello` matched by `Hello` → emitted offsets `start: 2, end: 7` (🌟 = 2 UTF-16 code units).
- `MAX_OFFSETS_PER_BLOCK = 50` enforced: regex `.` against a 100-char block emits exactly 50 offsets, not 100.
- Multi-match block: all match offsets returned in order.
- Empty query + `is_regex` true → returns empty without firing the regex pipeline.

### Frontend (`src/`)

**Component (`src/components/search/__tests__/`):**

- `SearchToggleRow.test.tsx`: each toggle has tooltip; `aria-pressed` flips on click; `role="toolbar"` on container.
- `SearchHistoryDropdown.test.tsx`: appears on focus when input empty; hides on blur/typing; click fills input + dispatches search.
- `useSearchHistoryCycling` hook tests: `↑` from empty fills with most-recent; walks back; at oldest, no-op; `↓` toward newest; at newest, clears input.
- `↑`/`↓` don't break result-list arrow nav when focus is in results.
- Clear history → confirms via `ConfirmDialog`, wipes Zustand store, dropdown shows "No recent searches".
- a11y: rendered tree passes `vitest-axe`.
- Per-space partitioning: history pushed in space A isn't visible in space B.

**Integration (`src/components/__tests__/SearchPanel.toggles.test.tsx` — new file):**

- Toggle `.*` + type `^TODO` → results contain only blocks starting with `TODO`.
- Toggle `Aa` + type `Alpha` → results don't contain `alpha`-only matches.
- Toggle `Ab|` + type `cat` → results don't contain `category` blocks.
- Invalid regex shows inline error (parsed from `AppError::Validation` with `InvalidRegex:` prefix).
- Submit query → history grows; recall via `↑`; deduping works.
- Toggle path renders highlights from `match_offsets` (DOM matches the default-path snippet output).
- **CJK regex highlight correctness**: search `本` in content `日本語` highlights only the middle character (verified via DOM snapshot).
- Backward-compat: pre-PEND-55 frontend bundle against post-PEND-55 backend works (default `false` for all three bools; `match_offsets` default `[]`).

## Documentation deliverables

| Artifact | Content added |
|---|---|
| `src/components/help/SearchHelpDialog.tsx` | *Toggles* (one line per toggle, ASCII-`\b` caveat); *Regex syntax* (Rust `regex` crate flavour, linear-time, no lookaround/back-refs, FTS-bypass trade-off, examples); *Boolean operators* (`AND`/`OR`/`NOT` work in non-regex mode); *Tips* (`↑` history recall) |
| `docs/SEARCH.md` | "Toggles & regex" + "Recent queries" sections mirroring help dialog + regex-mode trade-off explanation |
| `docs/architecture/search.md` | Toggle post-filter pipeline + regex-mode SQL path + UTF-16 offset emission + `MAX_OFFSETS_PER_BLOCK` rationale + size_limit defence rationale |
| `AGENTS.md` | Four invariants under "Search & FTS": regex-mode bypasses FTS entirely + `case_sensitive` forces post-filter + `match_offsets` are UTF-16 code-units, not bytes + history is per-space via Zustand persist; `(?-u:\b)` for whole-word; `MAX_OFFSETS_PER_BLOCK = 50` cap |
| KeyboardShortcuts dialog | `↑` / `↓` recall row (when input empty) |
| Inline tooltips | Each toggle, the `?` button, the history dropdown |

## New i18n keys (Phase 1-3)

Append in `src/lib/i18n/references.ts`:

- `search.toggle.caseSensitive` → "Case-sensitive (Aa)"
- `search.toggle.wholeWord` → "Whole word (Ab|)"
- `search.toggle.regex` → "Regex (.*)"
- `search.toggle.toolbarLabel` → "Search modes"
- `search.history.title` → "Recent searches"
- `search.history.empty` → "No recent searches"
- `search.history.clear` → "Clear history"
- `search.history.clearConfirmTitle` → "Clear search history?"
- `search.history.clearConfirmMessage` → "Recent searches for this space will be removed. This cannot be undone."
- `search.invalidRegex` → "{{message}}" (parsed from `AppError::Validation`)

## Cost / Impact / Risk

- **Cost:** Phase 1 ~7-10 h. Phase 2 ~3-4 h. Phase 3 ~1 h. **Total M (~11-15 h, ~1.5-2 focused days).**
- **Impact:** **High.** Closes the most-frequent power-user search ask (regex / case / whole-word) matched by every IDE. History adds a low-cost high-frequency convenience. CJK-correct highlighting (UTF-16 offsets) honours the trigram FTS migration's CJK-support charter.
- **Risk:** **Low-Medium.** Default-off semantics mean the existing FTS path is untouched when toggles are off. The riskiest new surface is (a) the regex-mode FTS-bypass query (mitigated by the pre-filter cap + `MAX_SEARCH_RESULTS` post-cap), (b) the UTF-16 offset conversion (mitigated by explicit CJK/emoji tests), (c) regex compile-time exhaustion (mitigated by `size_limit` + `dfa_size_limit`).

## Open questions

1. **History scope: per-space or global?** Plan chooses **per-space** because PEND-54 query strings can contain tag/path references that are space-specific. Global history would silently fail on cross-space recall. Confirm with the maintainer before scheduling.
2. **History entry cap.** 20 entries; adjust if real usage shows more depth is wanted.
3. **Regex-mode ordering.** `created_at DESC` chosen since `fts.rank` is unavailable. Could be configurable later. Document the choice in `docs/SEARCH.md`.

## Related

- `pending/PEND-50-search-vscode-ux.md` — foundation; defines `SearchFilter` struct + `SearchBlockRow.match_offsets` extension point.
- `pending/PEND-54-inline-filter-syntax.md` — independent; chip row above input vs toggle row to the right of input. Shared `↑`/`↓` precedence rule lives in AGENTS.md (PEND-54 documents it).
- `pending/PEND-52-in-page-find.md` — owns the `Ctrl+F` ↔ `Ctrl+Shift+F` rebind; this plan only updates help text.
- `pending/IDEAS.md` — saved searches require `(query, toggles)` not just `(query)` since toggles are non-writable as syntax.
- `src/components/SearchPanel.tsx` — main integration site.
- `src-tauri/src/fts/search.rs` — sanitiser carve-out + post-filter pipeline + new regex-mode SQL path.
- `src-tauri/src/commands/queries.rs` — `SearchFilter` extension.
- `src-tauri/Cargo.toml:128` — `regex = "1"` (verified present).
- `package.json:82` — `lucide-react ^1.16.0`; uses `CaseSensitive`, `ALargeSmall`, `Regex` icons.
- `stores/recent-pages.ts:99` — Zustand persist + `agaric:` prefix + per-space partitioning convention this plan follows.
- `src-tauri/src/error.rs:152-165` — `AppError` `{kind, message}` Serialize shape; validation errors flow through with `InvalidRegex:` prefix.
