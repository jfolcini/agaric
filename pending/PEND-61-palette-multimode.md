# PEND-61 — Refactor Cmd+K palette to cmdk + multi-mode growth + `search_blocks_partitioned` IPC

> Refactors the hand-rolled `<SearchPalette>` (PEND-51, ~830 LOC component) onto **cmdk**, opening the door for the Linear-style multi-mode command surface the maintainer wants: search / nav / actions / settings / spaces / agents. Same trip backfills the **`search_blocks_partitioned` IPC** the original PEND-51 plan specced but skipped — one FTS round-trip per palette keystroke instead of two.
>
> Depends on **PEND-59** (cmdk foundation).

## TL;DR

- **Frontend refactor.** ~M-L (~10-14 h). Replace the hand-rolled `<SearchPalette>` with a cmdk `<Command>` shell. Lazy-mounted as today, opens on `Cmd+K`.
- **Backend.** ~S (~2-3 h). Add `search_blocks_partitioned` Tauri command returning `{ pages: PageResponse<SearchBlockRow>, blocks: PageResponse<SearchBlockRow> }` in one FTS call; reuses the existing `SearchFilter` shape with `block_type_filter` honoured server-side as a partition key.
- **Mode infrastructure.** Introduce a `PaletteMode` enum (`search` is v1; `actions`, `nav`, `settings`, `spaces`, `agents` reserved). cmdk's `<Command.Group>` carries the mode boundary; an `Esc`-style "back" gesture pops back to the mode picker.
- **Behaviour preserved.** Fuzzy ranking (Jaro-Winkler), `[[page]]` autocomplete, escalation footer, recent-pages empty state, Cmd-click new-tab — all migrated to the cmdk path.
- **`<SearchPalette>` retired** as the hand-rolled component; the new component lives at `src/components/CommandPalette.tsx`.

## Current state — verified

- `src/components/SearchPalette.tsx` — 832 LOC, hand-rolled cmdk-like shell (Dialog wrapper, input + scroll list + keyboard nav). Two parallel `searchBlocks` calls per keystroke (one with `blockTypeFilter: 'page'`, one unrestricted).
- `src/stores/useSearchPaletteStore.ts` — 86 LOC; open state + query + previousFocusedElement + pendingViewQuery.
- `src/lib/jaro-winkler.ts` — 114 LOC; the fuzzy rescorer; reused.
- Tests: `src/components/__tests__/SearchPalette.test.tsx` — 16 cases including axe + IPC error path.
- `SearchFilter.block_type_filter: Option<String>` already exists (PEND-51 added it).

## Design

### Multi-mode shell

The palette opens to **search mode** by default. Users can switch modes via:

- Typing `>` opens the mode picker (matches VSCode's Cmd+P "> for commands" convention).
- Or: prefix-binding (`> nav` jumps to navigation, `> set` to settings; aliased).
- Or: a small ⌘ chip in the input shows the current mode; clicking it opens the mode picker.

```text
┌─────────────────────────────────────────────────────────┐
│ 🔍  alpha                                            ⌘ S│  ← S = search mode chip
├─────────────────────────────────────────────────────────┤
│ ▼ 📄 Project Alpha                              ↩       │
│      🧩  …alpha review on Friday…                       │
│      🧩  …alpha cohort is the test bed…                 │
│ ▼ 📄 Roadmap                                            │
│      🧩  …mentions alpha cohort under Q3…               │
├─────────────────────────────────────────────────────────┤
│ Search in all pages with toggles →           ⌘⇧F        │
└─────────────────────────────────────────────────────────┘
```

```text
┌─────────────────────────────────────────────────────────┐
│ >  (mode picker active)                              ⌘  │
├─────────────────────────────────────────────────────────┤
│ Commands                                                │
│   ⏵ Run agent…                                          │
│   ⏵ Switch space                                        │
│   ⏵ Open settings                                       │
│   ⏵ New page                                            │
│ Navigation                                              │
│   ⏵ Pages                                               │
│   ⏵ Trash                                               │
│   ⏵ Templates                                           │
└─────────────────────────────────────────────────────────┘
```

### Mode enumeration

`PaletteMode = 'search' | 'commands' | 'nav' | 'spaces' | 'agents' | 'settings'` — strict union; closed enum. New modes require updating `PaletteMode` AND adding a `<Command.Group>` config entry. **v1 ships `search` and `commands` modes**; `nav` / `spaces` / `agents` / `settings` are reserved (the slots exist; the items are empty pending separate PEND files).

### `search_blocks_partitioned` IPC

```rust
// New Tauri command. Same SearchFilter shape; honours block_type_filter as a partition key.
#[tauri::command]
#[specta::specta]
pub async fn search_blocks_partitioned(
    pool: tauri::State<'_, SqlitePool>,
    query: String,
    page_limit: u32,
    block_limit: u32,
    filter: SearchFilter,
) -> Result<PartitionedSearchResponse, AppError>;

pub struct PartitionedSearchResponse {
    pub pages: PageResponse<SearchBlockRow>,   // block_type='page' rows, capped at page_limit
    pub blocks: PageResponse<SearchBlockRow>,  // unrestricted rows, capped at block_limit
}
```

Implementation: one FTS5 scan; split rows by `block_type` server-side; each partition gets its own cap. The palette's two-parallel-call cost (PEND-51) collapses to one round-trip.

### Behaviour migration checklist

| PEND-51 feature | Migration |
|---|---|
| `Cmd+K` opens via store | Same store, same keybinding |
| 8 page-groups × 2 matches per group | cmdk's `<Command.Group>` + per-group cap (cmdk doesn't natively cap; the palette filters before passing to cmdk) |
| Jaro-Winkler fuzzy rescorer | Same `src/lib/jaro-winkler.ts`; runs before passing items to cmdk |
| `[[page]]` autocomplete mode | Same store flag; cmdk renders a different mode |
| Escalation footer | A non-selectable `<CommandItem disabled>` row, or a footer outside `<Command.List>` |
| Recent-pages empty state | Initial cmdk items when query empty |
| Cmd-click new-tab | onSelect handler reads modifier keys |
| Stale-response guard | Same `generationRef` counter |

## Phase split

### Phase 1 — Backend `search_blocks_partitioned` IPC (S, ~2-3 h)

- Define `PartitionedSearchResponse` in `src-tauri/src/commands/queries.rs`.
- Implement `search_blocks_partitioned_inner` in `src-tauri/src/fts/search.rs` — one FTS scan, partition by `block_type` in the SELECT.
- Tauri command wrapper.
- Backend tests: cardinality, partition correctness, empty-result, error-path.
- Specta bindings regen.

### Phase 2 — Frontend `<CommandPalette>` shell (M, ~4-5 h)

- New `src/components/CommandPalette.tsx` (cmdk shell + Dialog/Sheet).
- New `src/stores/useCommandPaletteStore.ts` (extends the PEND-51 store with `mode: PaletteMode`).
- Rewire `useAppKeyboardShortcuts.ts` to mount `<CommandPalette>` on `Cmd+K`.
- Search mode behaviour parity with PEND-51 (groupings, fuzzy, autocomplete, footer).

### Phase 3 — Commands mode (M, ~3-4 h)

- Define the initial command registry: ~10 commands (open settings, new page, switch space, run agent…, search across pages, etc.).
- `<Command.Group>` per category.
- Mode picker via `>` prefix or chip click.

### Phase 4 — Retire `SearchPalette` (S, ~1 h)

- Delete `src/components/SearchPalette.tsx` + `useSearchPaletteStore.ts` once `<CommandPalette>` has feature parity.
- Migrate tests.

## Tests

- Backend: `search_blocks_partitioned_inner` happy path; partition cardinality; cap honored per partition; error-path IPC.
- Frontend: `<CommandPalette>` in search mode matches PEND-51 test parity; commands mode renders + dispatches; mode switching via `>` works; `[[page]]` autocomplete preserved.
- a11y: each new component test carries a `vitest-axe` audit; IPC error-path coverage.

## Open questions

1. **Mode chip vs prefix-only switching** — show a visible `⌘ S` mode chip, or rely only on `>` prefix for discoverability? Recommendation: ship both; chip is a visual reminder, prefix is the keyboard-driven path.
2. **Commands mode item set in v1** — settle on a small initial set (open settings, switch space, search across, new page) and add more as separate PEND plans. Don't bundle the full Linear-style command catalog here.
3. **Mobile** — PEND-62 owns the mobile UI; the palette's mode picker probably needs a different gesture on mobile (segment control vs `>` prefix).

## Acceptance criteria

- `Cmd+K` opens `<CommandPalette>` (not `<SearchPalette>`).
- Search-mode behaviour parity with PEND-51: 8 page-groups × 2 matches, fuzzy rank, `[[page]]` autocomplete, escalation footer, Cmd-click new-tab, recent-pages empty state.
- `search_blocks_partitioned` returns both partitions in one FTS scan; the palette consumes it.
- Commands mode lists ≥ 5 initial commands; each dispatches to its handler.
- Mode picker via `>` prefix works; mode chip visible in input.
- `vitest-axe` passes on both modes.
- `SearchPalette.tsx` and `useSearchPaletteStore.ts` deleted; no dangling imports.

## Related

- `pending/PEND-59-cmdk-foundation.md` — depends on cmdk landing.
- `pending/PEND-62-mobile-unified-search.md` — mobile UI uses this palette's cmdk shell.
- `src/components/SearchPalette.tsx` — replaced.
- `src/components/CommandPalette.tsx` — new.
- `src-tauri/src/commands/queries.rs` — `search_blocks_partitioned` lands alongside `search_blocks`.
- `src-tauri/src/fts/search.rs` — partitioning implementation.
