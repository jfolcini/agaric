# Features Map

> Exhaustive feature inventory for Block Notes. Every entry maps to an ADR, a
> Logseq comparison gap, or both. Use this as the canonical development guide.
>
> **Last updated:** 2026-03-31

## Status Legend

| Status | Meaning |
|--------|---------|
| **Done** | Fully implemented — frontend + backend working |
| **Backend** | Rust command/logic exists, no UI yet |
| **Partial** | Some aspects shipped, gaps remain |
| **Planned** | In ADR or project plan, implementation not started |
| **Idea** | Mentioned in comparison/discussions, no ADR commitment |

## Test Coverage Legend

| Code | Meaning |
|------|---------|
| **U** | Rust unit tests (`#[test]` / `#[tokio::test]`) or Vitest unit tests (`it()` / `test()`) |
| **I** | Rust integration tests (`command_integration_tests.rs`, `integration_tests.rs`) |
| **C** | Vitest component tests (`*.test.tsx` in `components/__tests__/`) |
| **E** | Playwright E2E tests (`*.spec.ts` in `e2e/`) |
| **—** | No tests (planned/idea features) |
| **none** | Done feature with no dedicated tests |

## Test Coverage Summary

| Layer | Files | Tests | Coverage |
|-------|-------|-------|----------|
| Rust unit tests | 22 modules | ~672 | Core data model, op log, hash, pagination, materializer, FTS, merge, snapshots |
| Rust integration tests | 3 files | ~138 | Full command lifecycle, crash recovery, cascade, pagination, hash chains |
| Vitest unit + component tests | 27 files | ~684 | Serializer (100%), keyboard hooks, editor extensions, stores, tree utils, all major UI components with a11y (axe) checks |
| Playwright E2E | 2 files | ~18 | Block CRUD, navigation, journal, page creation |
| **Total** | **54 files** | **~1,512** | |

## Summary

| Category | Done | Backend | Partial | Planned | Idea | Total |
|----------|------|---------|---------|---------|------|-------|
| 1. Block Model & Structure | 14 | 0 | 0 | 1 | 0 | 15 |
| 2. Page Management | 5 | 0 | 1 | 2 | 0 | 8 |
| 3. Editor Core (TipTap) | 15 | 0 | 0 | 4 | 0 | 19 |
| 4. Text Formatting | 3 | 0 | 3 | 3 | 2 | 11 |
| 5. Content Serialization | 8 | 0 | 0 | 0 | 0 | 8 |
| 6. Linking & References | 7 | 0 | 1 | 1 | 2 | 11 |
| 7. Tag System | 11 | 0 | 0 | 0 | 0 | 11 |
| 8. Properties System | 3 | 3 | 0 | 4 | 0 | 10 |
| 9. Task Management | 4 | 0 | 1 | 4 | 1 | 10 |
| 10. Daily Journal | 7 | 0 | 1 | 7 | 0 | 15 |
| 11. Search & FTS | 6 | 0 | 0 | 2 | 0 | 8 |
| 12. Query System | 2 | 0 | 1 | 4 | 0 | 7 |
| 13. History & Versioning | 4 | 0 | 0 | 0 | 0 | 4 |
| 14. Trash & Recovery | 5 | 0 | 0 | 0 | 0 | 5 |
| 15. Drag-and-Drop & Reordering | 4 | 0 | 0 | 1 | 0 | 5 |
| 16. Collapse & Focus | 3 | 0 | 0 | 2 | 0 | 5 |
| 17. Conflict Resolution | 5 | 0 | 0 | 0 | 0 | 5 |
| 18. Sync Protocol | 0 | 0 | 0 | 11 | 0 | 11 |
| 19. Snapshots & Compaction | 4 | 0 | 0 | 1 | 0 | 5 |
| 20. Export & Import | 0 | 0 | 0 | 4 | 2 | 6 |
| 21. Android | 0 | 0 | 2 | 3 | 0 | 5 |
| 22. i18n & Localization | 0 | 0 | 1 | 2 | 0 | 3 |
| 23. CJK Support | 1 | 0 | 0 | 4 | 0 | 5 |
| 25. UI Shell & Components | 9 | 0 | 0 | 0 | 0 | 9 |
| 26. State Management | 4 | 0 | 0 | 2 | 0 | 6 |
| 27. Database Architecture | 8 | 0 | 0 | 0 | 0 | 8 |
| 28. Dev Tooling & Testing | 10 | 0 | 0 | 0 | 0 | 10 |
| 29. Security & Integrity | 5 | 0 | 0 | 1 | 0 | 6 |
| 30. Auto-updates | 0 | 0 | 0 | 2 | 0 | 2 |
| 31. Future Ideas | 0 | 0 | 0 | 0 | 4 | 4 |
| **Total** | **146** | **3** | **11** | **66** | **11** | **237** |

---

## 1. Block Model & Structure

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 1 | Block tree via `parent_id` + `position` | Done | 1 | U I C | Unit: commands.rs (3), soft_delete.rs (2). Integ: command_integration_tests (3), integration_tests (1). Comp: tauri-mock.test.ts (2) |
| 2 | ULID block identifiers | Done | 1 | U I | Unit: ulid.rs (37), commands.rs (1). Integ: command_integration_tests (2) |
| 3 | Block types: content, tag, page | Done | 1 | U I | Unit: commands.rs (5). Integ: command_integration_tests (3), integration_tests (1) |
| 4 | Create block (`create_block` op) | Done | 1 | U I C E | Unit: commands.rs, op.rs. Integ: command_integration_tests, integration_tests. Comp: blocks.test.ts, tauri.test.ts. E2E: editor-lifecycle |
| 5 | Edit block (`edit_block` op) | Done | 1 | U I C E | Unit: commands.rs (7). Integ: command_integration_tests (4), integration_tests (2). Comp: blocks.test.ts (3), tauri-mock.test.ts (5). E2E: editor-lifecycle (1) |
| 6 | Soft-delete with cascade (`delete_block` op) | Done | 1 | U I C E | Unit: commands.rs (4), soft_delete.rs (11). Integ: command_integration_tests (5), integration_tests (3). Comp: blocks.test.ts (4), tauri.test.ts (3). E2E: editor-lifecycle (2) |
| 7 | Restore soft-deleted block (`restore_block` op) | Done | 1 | U I | Unit: commands.rs (4), soft_delete.rs (3). Integ: command_integration_tests (3), integration_tests (2) |
| 8 | Permanent purge (`purge_block` op) | Done | 1 | U I | Unit: commands.rs (4), soft_delete.rs (14). Integ: command_integration_tests (4), integration_tests (2) |
| 9 | Move block / reparent (`move_block` op) | Done | 1.5 | U I C | Unit: commands.rs (8), op.rs (1). Integ: command_integration_tests (6). Comp: blocks.test.ts (11), tauri.test.ts (2) |
| 10 | Integer position ordering with compaction | Done | 1 | U I | Unit: commands.rs (12). Integ: command_integration_tests (5), integration_tests (2) |
| 11 | `archived_at` column for working-set filtering | Done | 1 | none | Schema present. No tests — no archive UI or queries yet |
| 12 | Conflict copy blocks (`is_conflict` flag) | Done | 4W1 | U | Unit: commands.rs (1 — get_conflicts) |
| 13 | Block drafts (2s autosave) | Done | 1 | U I | Unit: draft.rs (28). Integ: integration_tests (3) |
| 14 | `prev_edit` causal pointer on every edit | Done | 1 | U I | Unit: commands.rs (1), op.rs (1), draft.rs (1), recovery.rs (3). Integ: command_integration_tests (1), integration_tests (1) |
| 15 | Auto-purge trash after 30 days | Planned | 2 | — | |

---

## 2. Page Management

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 16 | Pages as `block_type='page'` | Done | 1 | U I | Unit: via block_type tests. Integ: command_integration_tests (1), integration_tests (1) |
| 17 | Page browser (list all pages) | Done | 1.5 | C | Comp: PageBrowser.test.tsx (15) |
| 18 | Page creation from browser UI | Done | 1.5 | C E | Comp: BlockTree.test.tsx (4), PageBrowser.test.tsx (in flow). E2E: editor-lifecycle (1) |
| 19 | Page deletion with confirmation | Done | 1.5 | C | Comp: PageBrowser.test.tsx (4) |
| 20 | Page title inline editing | Done | 1.5 | C | Comp: PageEditor.test.tsx (3) |
| 21 | Page nesting (pages under pages or blocks) | Partial | 1.5 | none | Schema supports parent_id on pages — tested indirectly via parent_id tests. No nested browsing UI |
| 22 | Page aliases (multiple names → same page) | Planned | — | — | |
| 23 | Namespaced pages (`Project/Backend/API`) | Planned | — | — | |

---

## 3. Editor Core (TipTap)

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 24 | Single roving TipTap instance | Done | 1.5 | C | Comp: EditableBlock.test.tsx (14) — tests mount/unmount lifecycle indirectly |
| 25 | Mount: parse markdown → setContent | Done | 1.5 | U | Unit: use-roving-editor.test.ts (5 — replaceDocSilently) |
| 26 | Unmount: serialize → compare → flush if dirty | Done | 1.5 | C | Comp: EditableBlock.test.tsx (4 — unmount save, split, no-op on unchanged) |
| 27 | Static `<div>` rendering for non-focused blocks | Done | 1.5 | C | Comp: StaticBlock.test.tsx (5), EditableBlock.test.tsx (2), BlockTree.test.tsx (1) |
| 28 | Auto-split on blur (newline → new blocks) | Done | 1.5 | U C | Unit: blocks.test.ts (4 — splitBlock). Comp: EditableBlock.test.tsx (2) |
| 29 | Cross-block paste (multi-line → multi-block) | Done | 1.5 | none | Same splitOnNewlines path as auto-split — covered indirectly by #28 tests |
| 30 | Keyboard: ArrowUp/Left at pos 0 → previous block | Done | 1.5 | U | Unit: use-block-keyboard.test.ts (5) |
| 31 | Keyboard: ArrowDown/Right at end → next block | Done | 1.5 | U | Unit: use-block-keyboard.test.ts (4) |
| 32 | Keyboard: Backspace on empty block → delete + focus prev | Done | 1.5 | U | Unit: use-block-keyboard.test.ts (3) |
| 33 | Keyboard: Enter → create new sibling below | Done | 1.5 | U | Unit: use-block-keyboard.test.ts (1) |
| 34 | Keyboard: Tab → indent (change parent) | Done | 1.5 | U | Unit: use-block-keyboard.test.ts (2) |
| 35 | Keyboard: Shift+Tab → dedent | Done | 1.5 | U | Unit: use-block-keyboard.test.ts (1) |
| 36 | Keyboard: Escape → blur/deselect | Done | 1.5 | U | Unit: use-block-keyboard.test.ts (1) |
| 37 | Block merge (Backspace at start of non-empty) | Done | 2 | U | Unit: use-block-keyboard.test.ts (5) |
| 38 | Viewport virtualization (Intersection Observer) | Done | 1.5 | U | Unit: useViewportObserver.test.ts (12) |
| 39 | Multi-line within a block (Shift+Enter) | Done | 1.5 | U | Unit: use-block-keyboard.test.ts (1 — Shift+Enter does nothing, TipTap default) |
| 40 | Block-level selection (multi-select with Esc + arrows) | Planned | — | — | |
| 41 | Visual tree lines and bullet points | Planned | — | — | Indentation-only hierarchy hard to scan; Logseq uses bullets + tree lines |
| 42 | Batch property fetch (single IPC call) | Planned | — | — | Current N+1 getProperties per block on mount is slow for large trees |
| 43 | Global resolve cache (Zustand store) | Planned | — | — | Resolve cache ref-based hack; listBlocks duplicated per mount |

---

## 4. Text Formatting

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 41 | Bold (`**text**`) | Done | 1.5 | U C | Unit: markdown-serializer.test.ts (serialize + parse + round-trip). Comp: StaticBlock.test.tsx (2) |
| 42 | Italic (`*text*`) | Done | 1.5 | U | Unit: markdown-serializer.test.ts (serialize + parse + round-trip) |
| 43 | Inline code (`` `text` ``) | Done | 1.5 | U | Unit: markdown-serializer.test.ts (serialize + parse + round-trip + isolation tests) |
| 44 | Formatting toolbar (Bold/Italic/Code/Undo/Redo) | Done | 2 | C | Comp: FormattingToolbar.test.tsx (18), StaticBlock.test.tsx (6) |
| 45 | Strikethrough (`~~text~~`) | Planned | — | — | |
| 46 | Highlight (`==text==`) | Planned | — | — | |
| 47 | Headings within blocks (`# H1`, `## H2`) | Partial | 2 | C | Parsed and rendered in StaticBlock (styled h1-h6). No heading support in TipTap editor |
| 48 | Code blocks with syntax highlighting | Partial | 2 | C | Parsed and rendered in StaticBlock (`<pre><code>`). No language-aware highlighting |
| 49 | Math/LaTeX rendering (`$$E=mc^2$$`) | Planned | — | — | |
| 50 | Tables within blocks | Planned | — | — | |
| 51 | Blockquotes (`> quote`) | Idea | — | — | |
| 52 | Slash commands (`/` menu) | Partial | 1.5 | C | Comp: BlockTree.test.tsx (53 total; searchTags, searchPages, searchSlashCommands, onCreatePage tests) |
| 53 | Keyboard shortcuts help dialog | Done | 2 | C | Comp: KeyboardShortcuts.test.tsx (9) |
| 54 | Superscript / subscript | Idea | — | — | |

---

## 5. Content Serialization

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 55 | Custom standalone markdown serializer | Done | 1.5 | U | Unit: markdown-serializer.test.ts (141), property.test.ts (12). 100% coverage |
| 56 | Parse: Markdown string → ProseMirror document | Done | 1.5 | U | Unit: markdown-serializer.test.ts (~30 parse tests + property safety tests) |
| 57 | Serialize: ProseMirror document → Markdown string | Done | 1.5 | U | Unit: markdown-serializer.test.ts (~25 serialize tests + property safety tests) |
| 58 | Round-trip identity (`serialize(parse(s)) === s`) | Done | 1.5 | U | Unit: markdown-serializer.test.ts (22 round-trip + 9 mark coalescing + 14 link round-trips + 25 bracket round-trips) |
| 59 | Escape rules (`\*` for literal asterisk, etc.) | Done | 1.5 | U | Unit: markdown-serializer.test.ts (8 serialize + 7 parse + 14 round-trip escape tests) |
| 60 | Unknown node stripping with logged warning | Done | 1.5 | U | Unit: markdown-serializer.test.ts (2) |
| 61 | `hardBreak` → `\n` handling (auto-split trigger) | Done | 1.5 | U | Unit: markdown-serializer.test.ts (1) |
| 62 | Paste normalization (paragraph wrapper → content) | Done | 1.5 | U | Unit: markdown-serializer.test.ts (multi-paragraph tests cover this path) |

---

## 6. Linking & References

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 63 | Page links `[[ULID]]` with chip rendering | Done | 1.5 | U C | Unit: markdown-serializer.test.ts (several), extensions.test.ts (8), node-views.test.ts (13). Comp: StaticBlock.test.tsx (5), BacklinksPanel.test.tsx (2) |
| 64 | `[[` picker (page autocomplete + create new) | Done | 1.5 | U | Unit: suggestion-renderer.test.ts (3) |
| 65 | Block link click → navigate to target | Done | 2 | C | Comp: StaticBlock.test.tsx (2), SearchPanel.test.tsx (3), TagFilterPanel.test.tsx (2) |
| 66 | Broken/deleted link decoration | Done | 2 | C | Comp: StaticBlock.test.tsx (2), BacklinksPanel.test.tsx (1) |
| 67 | Backlinks panel (per-block) | Done | 2 | C | Comp: BacklinksPanel.test.tsx (17), PageEditor.test.tsx (2) |
| 68 | External URL links `[text](url)` | Done | 2 | U C | Unit: markdown-serializer.test.ts (24 serialize + parse + 14 round-trip + 25 bracket/paren). Comp: StaticBlock.test.tsx (4) |
| 69 | `block_links` materializer index | Done | 1 | U I | Unit: cache.rs (11). Integ: integration_tests (1) |
| 70 | Unlinked references (FTS for page title mentions) | Planned | — | — | |
| 71 | Custom link labels (`[display text]([[page]])`) | Planned | — | — | |
| 72 | Backlinks grouped by source page with context | Partial | 2 | C | Comp: BacklinksPanel.test.tsx covers flat list; no grouping tests |
| 73 | `block_links` on tag references (`#[ULID]`) | Done | 1 | U | Unit: tracked via block_tags path (separate from block_links) |
| 74 | Block references / embeds / inline queries | Idea | — | — | |

---

## 7. Tag System

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 75 | Tags as `block_type='tag'` (first-class blocks) | Done | 1 | U I | Unit: commands.rs (2). Integ: command_integration_tests (2) |
| 76 | Tag creation UI (inline form in TagList) | Done | 1.5 | C | Comp: TagList.test.tsx (10) |
| 77 | Tag deletion UI with confirmation | Done | 1.5 | C | Comp: TagList.test.tsx (3) |
| 78 | `@` picker (tag autocomplete) | Done | 1.5 | U | Unit: suggestion-renderer.test.ts (3) |
| 79 | Tag chip rendering (`#[ULID]` → styled name) | Done | 1.5 | U C | Unit: markdown-serializer.test.ts (several), extensions.test.ts (8), node-views.test.ts (8). Comp: StaticBlock.test.tsx (3), BacklinksPanel.test.tsx (1) |
| 80 | Deleted tag decoration | Done | 2 | U C | Unit: node-views.test.ts (4). Comp: StaticBlock.test.tsx (1) |
| 81 | Apply tag to block (`add_tag` op) | Done | 1 | U I | Unit: commands.rs (5). Integ: command_integration_tests (7) |
| 82 | Remove tag from block (`remove_tag` op) | Done | 1 | U I | Unit: commands.rs (2). Integ: command_integration_tests (5) |
| 83 | Tag panel (apply/remove tags on focused block) | Done | 1.5 | C | Comp: TagFilterPanel.test.tsx (2) |
| 84 | `tags_cache` with usage counts | Done | 1 | U | Unit: cache.rs (45 total across all cache tests; 8 tags_cache-specific) |
| 85 | Tag prefix search (`LIKE 'work/%'`) | Done | 3 | U C | Unit: commands.rs (3), tag_query.rs (4). Comp: BlockTree.test.tsx (2), TagFilterPanel.test.tsx (1) |
| 86 | Tag-on-tag (tag blocks can be tagged) | Done | 1 | none | Natural consequence of unified model — no dedicated tests |

---

## 8. Properties System

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 87 | Block properties table (`block_properties`) | Done | 1 | I | Integ: tested indirectly via purge_block cleanup tests |
| 88 | `set_property` command | Backend | 1 | U | Unit: commands.rs (3), op.rs (1) |
| 89 | `delete_property` command | Backend | 1 | U | Unit: commands.rs (1) |
| 90 | `get_properties` command | Backend | 1 | U | Unit: commands.rs (1) |
| 91 | Properties UI (view/edit on blocks and pages) | Planned | 2 | — | |
| 92 | Property name autocomplete (`::` trigger) | Planned | — | — | |
| 93 | Property value autocomplete (suggest used values) | Planned | — | — | |
| 94 | Multi-value properties (comma-separated) | Planned | — | — | |
| 95 | Property conflict LWW resolution | Done | 4W1 | U | Unit: merge.rs (multiple resolve_property_conflict tests) |
| 96 | Property types: DateTime, Checkbox, URL | Done | — | U | Unit: op_log.rs (3), op.rs (11 — validate_set_property tests) |

---

## 9. Task Management

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 97 | Task markers (TODO / DOING / DONE) | Done | 1.5 | C | Comp: SortableBlock.test.tsx (6) |
| 98 | Task state cycling (click or Ctrl+Enter) | Done | 1.5 | C | Comp: SortableBlock.test.tsx (3) |
| 99 | Task visual indicators (icons per state) | Done | 1.5 | C | Comp: SortableBlock.test.tsx (5) |
| 100 | Slash commands for tasks (/TODO, /DOING, /DONE) | Done | 1.5 | C | Comp: tested via slash command framework in BlockTree.test.tsx |
| 101 | Priority levels ([#A], [#B], [#C]) | Planned | — | — | |
| 102 | Scheduled date semantics | Partial | — | none | Timestamps parsed but no scheduling behavior tested |
| 103 | Deadline date semantics | Planned | — | — | |
| 104 | Task queries / dashboard view | Planned | — | — | |
| 105 | Custom task keywords (configurable markers) | Planned | — | — | |
| 106 | Recurring tasks | Idea | — | — | |

---

## 10. Daily Journal

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 107 | Auto-created daily journal pages | Done | 1.5 | C E | Comp: JournalPage.test.tsx (5), App.test.tsx (2). E2E: editor-lifecycle (1) |
| 108 | Journal as default landing page | Done | 1.5 | C | Comp: App.test.tsx (1 — "defaults to Journal view") |
| 109 | Daily / Weekly / Monthly view modes | Done | 1.5 | C | Comp: JournalPage.test.tsx (13) |
| 110 | Date picker / calendar navigation | Done | 1.5 | C | Comp: JournalPage.test.tsx (3) |
| 111 | Scrollable past journals (7 days + load older) | Partial | 1.5 | none | Weekly: 7-day sections. Monthly: stacks all month days (perf issue). No "Load older days" button or infinite scroll |
| 112 | Content indicators per day | Done | 1.5 | none | No dedicated test |
| 113 | "Open in page editor" per journal day | Done | 1.5 | C | Comp: JournalPage.test.tsx (2) |
| 114 | Journal templates (auto-populate new days) | Planned | — | — | |
| 115 | Configurable date format for journal titles | Planned | — | — | |
| 116 | Natural language date input ("next friday") | Planned | — | — | |
| 117 | /date slash command | Done | 1.5 | C | Comp: BlockTree.test.tsx (searchSlashCommands returns all 4 commands including 'date') |
| 118 | Auto-create today's journal page on launch | Planned | — | — | User must click "Add block" on empty today; Logseq auto-creates |
| 119 | Journal keyboard nav shortcuts (g n / g p / g t) | Planned | — | — | Power users expect fast date navigation |
| 120 | Monthly view as calendar grid | Planned | — | — | Current stacked 28-31 sections is a perf issue; replace with grid |
| 121 | "Load older days" infinite scroll | Planned | — | — | No way to access journal entries beyond current view |

---

## 11. Search & FTS

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 118 | FTS5 virtual table (`fts_blocks`) | Done | 3 | U | Unit: fts.rs (58 total — update, remove, rebuild, optimize, search, strip tests) |
| 119 | FTS5 strip pass (markdown → plain text for index) | Done | 3 | U | Unit: fts.rs (strip_for_fts tests for bold, italic, code, tag, page, footnotes, escapes) |
| 120 | FTS5 scheduled optimize | Done | 3 | U | Unit: fts.rs (fts_optimize, rebuild_fts_index) |
| 121 | Full-text search command (`search_blocks`) | Done | 3 | U | Unit: fts.rs (search_fts rank, pagination, sanitize, empty, caps), commands.rs |
| 122 | Search UI (debounced input + paginated results) | Done | 3 | C | Comp: SearchPanel.test.tsx (24) |
| 123 | CJK limitation notice in search UI | Done | 3 | C | Comp: SearchPanel.test.tsx (2) |
| 124 | Search scope filtering (pages only, tags only) | Planned | — | — | |
| 125 | Recent pages quick access in search | Planned | — | — | |

---

## 12. Query System

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 126 | Boolean tag queries (AND / OR / NOT) | Done | 3 | U | Unit: tag_query.rs (33 total — resolve_tag, resolve_and, resolve_or, resolve_not, eval, prefix) |
| 127 | Tag filter panel UI (multi-tag, AND/OR toggle) | Done | 3 | C | Comp: TagFilterPanel.test.tsx (14) |
| 128 | Date-based queries (agenda view) | Partial | 1.5 | U I | Unit: cache.rs (12 — agenda_cache tests). Integ: command_integration_tests (4) |
| 129 | Property-based queries (`WHERE property = value`) | Planned | — | — | |
| 130 | Task queries (filter by marker, priority, date) | Planned | — | — | |
| 131 | Query results as table (selectable columns) | Planned | — | — | |
| 132 | User-customizable sort on query results | Planned | — | — | |

---

## 13. History & Versioning

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 133 | Per-block edit chain query (`get_block_history`) | Done | 2 | U | Unit: commands.rs (1), pagination.rs (list_block_history tests) |
| 134 | History panel UI | Done | 2 | C | Comp: HistoryPanel.test.tsx (12) |
| 135 | Non-text op history (tags, properties, moves) | Done | 2 | C | Comp: HistoryPanel.test.tsx (3 — non-edit_block, malformed payload tests) |
| 136 | Restore from history (revert to previous version) | Done | 2 | C | Comp: HistoryPanel.test.tsx (2) |

---

## 14. Trash & Recovery

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 137 | Trash view (list soft-deleted blocks) | Done | 1.5 | U I C | Unit: pagination.rs (list_trash tests). Integ: command_integration_tests (2), integration_tests (1). Comp: TrashView.test.tsx (7) |
| 138 | Restore from trash | Done | 1.5 | C | Comp: TrashView.test.tsx (2) |
| 139 | Permanent delete (purge) with confirmation | Done | 1.5 | U C | Unit: soft_delete.rs (14 purge tests). Comp: TrashView.test.tsx (2) |
| 140 | Crash recovery at boot | Done | 1 | U I | Unit: recovery.rs (22). Integ: integration_tests (4) |
| 141 | Boot state machine (booting → recovering → ready) | Done | 1 | U | Unit: boot-store.test.ts (5) |

---

## 15. Drag-and-Drop & Reordering

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 142 | Drag-to-reorder blocks | Done | 2 | U C | Unit: blocks.test.ts (11 — reorder). Comp: SortableBlock.test.tsx (7) |
| 143 | Tree-aware DnD (horizontal offset → indent level) | Done | 2 | U | Unit: tree-utils.test.ts (27 — buildFlatTree, getDragDescendants, getProjection, computePosition) |
| 144 | DnD visual indicators (drop line) | Done | 2 | C | Comp: SortableBlock.test.tsx (2 — opacity tests) |
| 145 | Move block to different parent (DnD or Tab) | Done | 2 | U | Unit: blocks.test.ts (indent/dedent tests cover this) |
| 146 | Move block up/down keyboard shortcut (Alt+Shift+arrows) | Planned | — | — | |

---

## 16. Collapse & Focus

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 147 | Chevron toggle to collapse/expand children | Done | 1.5 | C | Comp: SortableBlock.test.tsx (8), BlockTree.test.tsx (2) |
| 148 | Ctrl+. keyboard shortcut for toggle | Done | 1.5 | none | No dedicated test for the keyboard shortcut binding |
| 149 | Client-side collapse state | Done | 1.5 | C | Comp: SortableBlock.test.tsx (expanded/collapsed state rendering tests) |
| 150 | Zoom into block (focus mode — subtree only) | Planned | — | — | |
| 151 | Persist collapse state across sessions | Planned | — | — | localStorage or `collapsed` block property. Current state lost on reload |

---

## 17. Conflict Resolution

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 151 | Three-way text merge via diffy | Done | 4W1 | U | Unit: merge.rs (34 total — merge_text clean, conflict, block orchestration, conflict copy, property LWW) |
| 152 | Conflict copy creation on merge failure | Done | 4W1 | U | Unit: merge.rs (create_conflict_copy tests) |
| 153 | Conflict list UI (Keep / Discard actions) | Done | 2 | C | Comp: ConflictList.test.tsx (15) |
| 154 | Property conflict LWW resolution | Done | 4W1 | U | Unit: merge.rs (resolve_property_conflict tests) |
| 155 | Conflict audit in Status View | Done | 2 | C | Comp: StatusPanel.test.tsx (8) |

---

## 18. Sync Protocol

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 156 | mDNS peer discovery (local network) | Planned | 4 | — | |
| 157 | 4-word EFF passphrase generation | Planned | 4 | — | |
| 158 | QR code display (passphrase + host address) | Planned | 4 | — | |
| 159 | WebSocket + TLS transport (`tokio-tungstenite` + `rustls`) | Planned | 4 | — | |
| 160 | Head exchange + divergence walk | Planned | 4 | — | |
| 161 | Op streaming (sender + receiver) | Planned | 4 | — | |
| 162 | RESET_REQUIRED detection + user confirm | Planned | 4 | — | |
| 163 | `peer_refs` atomic maintenance | Planned | 4 | — | |
| 164 | Merge op creation (multi-parent `parent_seqs`) | Planned | 4 | U | Unit: dag.rs (26 — insert_remote_op, append_merge_op, find_lca tests). Logic ready, sync trigger not built |
| 165 | Sync UI (pairing flow, progress, conflict alerts) | Planned | 4 | — | |
| 166 | Attachment binary transfer (separate from op stream) | Planned | 4 | — | |

---

## 19. Snapshots & Compaction

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 167 | zstd + CBOR snapshot encoding | Done | 4W2 | U | Unit: snapshot.rs (25 total — encode_decode round-trip, schema version, create, apply, compact) |
| 168 | Crash-safe snapshot write sequence | Done | 4W2 | U | Unit: snapshot.rs (pending→complete cycle) |
| 169 | Snapshot apply (RESET path) | Done | 4W2 | U | Unit: snapshot.rs (apply wipes and restores, deferred FKs) |
| 170 | 90-day op log compaction scheduler | Done | 4W2 | U | Unit: snapshot.rs (compact creates snapshot, respects retention, no-op when none old) |
| 171 | Old snapshot cleanup (retain N most recent) | Planned | 4 | — | |

---

## 20. Export & Import

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 172 | Export serializer (ULID → human names) | Planned | 5 | — | |
| 173 | Export UI (per-page and full vault) | Planned | 5 | — | |
| 174 | Frontmatter YAML for properties on export | Planned | 5 | — | |
| 175 | Round-trip import (Markdown → blocks with ULIDs) | Planned | 5 | — | |
| 176 | JSON/EDN data export | Idea | — | — | |
| 177 | OPML outline export | Idea | — | — | |

---

## 21. Android

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 178 | Android build pipeline (Tauri 2 target) | Partial | 4 | — | Spike only — no automated tests |
| 179 | Android layout (virtual keyboard + safe areas) | Partial | 4 | — | Manual spike validation only |
| 180 | Android mDNS + sync UI | Planned | 4 | — | |
| 181 | Android IME composition (CJK input) | Planned | 4 | — | |
| 182 | ~~Android-specific write IPC fix~~ | Likely resolved | 4 | — | Retested 2026-03-31: all IPC works after `pm clear`. Original failure was stale migration, not code bug. |

---

## 22. i18n & Localization

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 183 | i18n framework + UI string extraction | Planned | 5 | — | |
| 184 | RTL layout validation | Partial | 5 | — | Tailwind `rtl:` variants prepared; no tests |
| 185 | Noto Sans font bundling (CJK + Arabic coverage) | Done | 1 | none | In CSS font stack; system fallback covers all platforms |

---

## 23. CJK Support

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 186 | CJK text rendering (Noto Sans) | Done | 1 | none | UTF-8 storage — implicitly tested via unicode content tests |

---

## 25. UI Shell & Components

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 193 | Sidebar navigation (collapsible, view switching) | Done | 1.5 | U C E | Unit: navigation.test.ts (16). Comp: App.test.tsx (8). E2E: editor-lifecycle (1), smoke (1) |
| 194 | Boot gate (loading / recovering / error states) | Done | 1 | C E | Comp: App.test.tsx (2). E2E: smoke (2) |
| 195 | Page editor wrapper (title + detail panels) | Done | 1.5 | C | Comp: PageEditor.test.tsx (23), EditableBlock.test.tsx (14) |
| 196 | Status panel (materializer monitoring) | Done | 2 | C | Comp: StatusPanel.test.tsx (8) |
| 197 | Empty state component (reusable) | Done | 2 | C E | Comp: EmptyState.test.tsx (9), referenced in 5+ other component tests. E2E: editor-lifecycle (1) |
| 198 | Toast notifications (sonner) | Done | 1.5 | C | Comp: TagList.test.tsx (3), PageBrowser.test.tsx (3) — "shows toast on failed" tests |
| 199 | Skeleton loading states | Done | 1.5 | C | Comp: PageBrowser.test.tsx (1), TagList.test.tsx (1), SearchPanel.test.tsx (1) |
| 200 | Alert dialogs for destructive actions | Done | 1.5 | C | Comp: PageBrowser.test.tsx (3), TagList.test.tsx (3) — confirmation dialog tests |
| 201 | shadcn/ui component library (copy-paste, owned) | Done | 1 | N/A | Infrastructure — no dedicated tests needed |

---

## 26. State Management

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 202 | Zustand boot store (booting → recovering → ready) | Done | 1 | U | Unit: boot-store.test.ts (5) |
| 203 | Zustand block tree store (CRUD + tree ops) | Done | 1.5 | U | Unit: blocks.test.ts (46) |
| 204 | Zustand journal store (mode, date, navigation) | Done | 1.5 | none | No dedicated store unit tests (covered indirectly by JournalPage component tests) |
| 205 | Zustand navigation store (view, page stack, selection) | Done | 1.5 | U | Unit: navigation.test.ts (25) |
| 206 | Custom query hooks (usePaginatedQuery, usePollingQuery) | Done | 2 | U | Unit: usePaginatedQuery.test.ts (16), usePollingQuery.test.ts (11) |

---

## 27. Database Architecture

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 208 | sqlx async SQLite with WAL mode | Done | 1 | U | Unit: db.rs (4 — init_pool WAL, init_pools write/read WAL) |
| 209 | Single write connection (serialized writes) | Done | 1 | U | Unit: db.rs (2 — write_pool can write, query_only is off), op_log.rs (1) |
| 210 | Read pool (4 concurrent readers) | Done | 1 | U | Unit: db.rs (5 — rejects writes/update/delete, allows select, query_only pragma) |
| 211 | Schema: 13 tables + 1 FTS5 virtual table | Done | 1-3 | U | Unit: db.rs migration tests create tables |
| 212 | 8 database indexes | Done | 1 | none | Indexes tested implicitly via query performance; no explicit index existence tests |
| 213 | Cursor-based pagination on ALL list queries | Done | 1 | U I | Unit: pagination.rs (54). Integ: command_integration_tests (3), integration_tests (5) |
| 214 | Stale-while-revalidate cache strategy | Done | 1 | U | Unit: materializer.rs (54 — queue dispatch, dedup, metrics, shutdown, flush) |
| 215 | `PRAGMA foreign_keys = ON` on every connection | Done | 1 | U | Unit: db.rs (4 — enables FK, enforces constraint, both pools) |

---

## 28. Dev Tooling & Testing

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 216 | Biome linter + formatter (non-negotiable day one) | Done | 1 | N/A | Enforced by pre-commit hooks |
| 217 | GitHub Actions CI | Done | 1 | N/A | Infrastructure |
| 218 | Vitest frontend test suite | Done | 1 | N/A | This IS the test infrastructure |
| 219 | cargo-nextest backend test suite | Done | 3 | N/A | This IS the test infrastructure |
| 220 | Playwright E2E tests | Done | 2 | N/A | This IS the test infrastructure |
| 221 | insta snapshot tests | Done | 2 | N/A | 19 snapshots integrated into cargo test |
| 222 | specta TypeScript bindings generation | Done | 2 | U | Unit: ts_bindings_up_to_date test gate |
| 223 | Pre-commit hooks (prek) | Done | 1 | N/A | Infrastructure |
| 224 | `.sqlx/` offline cache in CI | Done | 1 | N/A | `cargo sqlx prepare --check` gate |
| 225 | FTS5 performance benchmarks (10k/100k blocks) | Done | 3 | N/A | Criterion benches — separate from test suite |

---

## 29. Security & Integrity

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 226 | blake3 hash chain on op log | Done | 1 | U I | Unit: hash.rs (24 — determinism, vectors, verify, tamper detection). Integ: integration_tests (2 — hash chain linking) |
| 227 | Device UUID v4 persistence | Done | 1 | U | Unit: device.rs (12 — create, read-back, normalize, corrupt file, edge cases) |
| 228 | Crash-safe operations (draft recovery at boot) | Done | 1 | U I | Unit: draft.rs (4 — atomic tx tests), soft_delete.rs (1). Integ: integration_tests (4 — crash recovery simulation) |
| 229 | Filesystem-level encryption (LUKS / Android FBE) | Done | — | N/A | Decision-only ADR — no application code |
| 230 | ULID case normalization for hash determinism | Done | 1 | U | Unit: ulid.rs (8), op_log.rs (2), op.rs (3 — normalize_block_ids) |
| 231 | Input length validation on commands | Planned | 4 | — | |

---

## 30. Auto-updates

| # | Feature | Status | Phase | Tests | Notes |
|---|---------|--------|-------|-------|-------|
| 232 | Tauri updater setup | Planned | 5 | — | |
| 233 | Platform-specific distribution | Planned | 5 | — | |

---

## 31. Future Ideas

These are noted as potential features, not committed to any ADR or phase.
They are listed here as single line items intentionally — each would need
its own design discussion before being split into implementation tasks.

| # | Feature | Status | Source | Tests | Notes |
|---|---------|--------|--------|-------|-------|
| 234 | Block references `((id))` — inline rendering of referenced block content, live-updating | Idea | Comparison | — | Core Zettelkasten feature. Would need new inline syntax + resolver + TipTap node |
| 235 | Block/page embeds `{{embed}}` — full subtree rendered inline, editable in-place | Idea | Comparison | — | Content reuse. Would need embed component + nested editor |
| 236 | Inline query blocks — embedded live query results within content | Idea | Comparison | — | Task dashboards, project overviews. Would need query renderer + backend support |
| 237 | Plugin/extension system — user-installable extensions | Idea | Comparison | — | Logseq has marketplace with 100+ plugins. Long-term extensibility |

---

## Test Gaps: Done Features Missing Tests

| # | Feature | Status | Gap | Suggested Action |
|---|---------|--------|-----|-----------------|
| 11 | `archived_at` column | Done | No tests | Add query test filtering by `archived_at` |
| 29 | Cross-block paste | Done | No dedicated test | Covered by auto-split (#28); add explicit multi-line paste test |
| 86 | Tag-on-tag | Done | No dedicated test | Add test: create tag, tag it with another tag, verify block_tags |
| 102 | Scheduled date semantics | Partial | No tests | Needs design before tests — feature is incomplete |
| 111 | Scrollable past journals | Done | No dedicated test | Add JournalPage test for "Load older days" button |
| 112 | Content indicators per day | Done | No dedicated test | Add JournalPage test verifying indicator badge |
| 148 | Ctrl+. keyboard shortcut | Done | No dedicated test | Add keyboard handler test for Ctrl+. binding |
| 186 | CJK text rendering | Done | No dedicated test | Implicit; add explicit CJK block create + read test if desired |
| 204 | Zustand journal store | Done | No unit tests | Add journal store test for mode switching and date navigation |
| 212 | 8 database indexes | Done | No dedicated test | Implicit via query perf; add explicit index existence check if desired |
| — | Block merge with complex content (headings, code) | Done | No test for merge edge cases | `handleMergeWithPrev` ProseMirror position fragile with headings/code |
| — | Auto-split with headings/code blocks | Done | No test for split with complex content | splitBlock parser-based split not tested with multi-block-type content |

---

## Cross-Reference: REVIEW-LATER Items

These items from `REVIEW-LATER.md` affect specific features above. Fix
before the noted phase.

| RL# | Affects Feature | Phase | Summary |
|-----|----------------|-------|---------|
| 1 | #226 (blake3 hash) | 4 | Payload canonical JSON ordering for cross-version determinism |
| 2 | #226 (blake3 hash) | 4 | Op payload `block_id` fields are String, not BlockId |
| 3 | #140 (crash recovery) | 4 | `find_prev_edit ORDER BY created_at` needs DAG rework |
| 4 | #231 (input validation) | 4 | No input length limits on command string parameters |
| 5 | #133 (history query) | 4 | `json_extract` on op_log is O(n) — needs materialized column |
| 6 | #151 (three-way merge) | 4 | `find_lca` compaction guard missing |
| 10 | #215 (WAL) | 4 | No explicit WAL checkpoint configuration |
| 12 | #171 (snapshot cleanup) | 4 | Old snapshots accumulate without cleanup |
| 13 | #214 (materializer) | 4 | `handle_foreground_task` is a no-op stub |
| 20 | #214 (cache strategy) | — | Cache rebuilds use full DELETE+INSERT (no incremental) |
| 21 | #126 (tag queries) | — | NOT expression loads all block IDs into memory |
| 23 | #208 (database) | — | Response type divergence BlockResponse/BlockRow |

---

## Phase Roadmap Summary

| Phase | Status | Key Features Delivered |
|-------|--------|----------------------|
| **1 — Foundation** | **Complete** | Schema, op log, materializer, pagination, CI, device ID, crash recovery |
| **1.5 — Daily Driver** | **Complete** | TipTap editor, serializer, block CRUD UI, journal, tags, trash, Android spike |
| **2 — Full Editor** | **Complete** | Backlinks, history, DnD, block merge, conflicts, status, E2E tests, specta |
| **3 — Search** | **Complete** | FTS5, tag queries, search UI, nextest, benchmarks |
| **4W1 — DAG + Merge** | **Complete** | Multi-parent ops, LCA, diffy merge, conflict copies, property LWW |
| **4W2 — Snapshots** | **Complete** | zstd+CBOR encoding, crash-safe write, RESET apply, 90-day compaction |
| **4 — Sync + Android** | **Complete** | mDNS, pairing, op streaming, RESET protocol, full Android |
| **5 — Polish** | **Planned** | i18n, export, auto-updates |
