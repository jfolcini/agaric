# Session Log

## Session 14 — 2026-03-31 — Tier 6 Items #77, #78, #99

### Build 1a: useBlockDnD hook tests (#77)
- Created `src/hooks/__tests__/useBlockDnD.test.ts` — 31 tests
- All 5 drag handlers, memo correctness, edge cases, sensors config
- Mocks: @dnd-kit/core, @dnd-kit/sortable, tree-utils, SortableBlock

### Build 1b: useBlockResolve hook tests (#78)
- Created `src/hooks/__tests__/useBlockResolve.test.ts` — 45 tests (41 build + 4 review)
- Resolve callbacks, searchPages dual strategy, searchTags, onCreatePage, "Create new" logic
- Review added 4 error propagation tests

### Build 2: keyboard-shortcuts.spec.ts (#99)
- Replaced all 13 `waitForTimeout` calls with proper Playwright waits
- Techniques: expect.poll() for CSS, toHaveText/toHaveAttribute for DOM, toPass() for retry blocks
- Review found 1 minor race condition (toBeVisible on already-visible element) — fixed with toHaveAttribute

### Reviews: 2 subagents
- Hook tests review: useBlockDnD passed clean, useBlockResolve got 4 error propagation tests added
- E2E review: found potential race in move-up assertion — fixed with auto-retrying toHaveAttribute

### Test counts
- Vitest: 76 new tests (31 + 45) — all pass
- E2E: 18 keyboard-shortcuts tests — all pass (0 waitForTimeout remaining)

### Items resolved: 3

## Session 13 — 2026-03-31 — Tier 6 Final Item (#102)

### Commit: purge E2E tests

**Build: Purge E2E tests (#102)**
- Added 4 E2E tests to `e2e/features-coverage.spec.ts` Trash describe block:
  1. Purge button shows confirmation
  2. Purge No dismisses without deleting
  3. Purge Yes permanently removes block
  4. Purge Escape dismisses without deleting (review-added)
- All 20 tests in features-coverage.spec.ts pass

**Review:** Found missing Escape key dismissal test (TrashView supports Escape handler). Added as 4th test.

### Items resolved: 1 (#102 — Tier 6 now fully complete)

## Session 12 — 2026-03-31 — Tier 6 Testing Items (#136, #137, #138)

### Commit: `35b0ca7`

**Build 1: Mock enhancement + E2E tests (#136, #137)**
- Enhanced `tauri-mock.ts` with operational op log — undo/redo/revert/history now actually modify in-memory state
- `MockOpLogEntry` interface + `pushOp()` for create/edit/delete/move/restore tracking
- `undo_page_op`: finds Nth undoable op, reverses it (create→delete, delete→restore, edit→old content, move→old position)
- `redo_page_op`: re-applies original operation
- `list_page_history`: returns op log in reverse chronological order
- `revert_ops`: batch reverse with newest-first ordering
- Updated existing mock tests to work with stateful implementation
- **3 E2E tests** in `e2e/undo-redo-blocks.spec.ts`: undo create, undo delete, redo
- **5 E2E tests** in `e2e/history-revert.spec.ts`: history entries display, selection+dialog, batch revert create_block, batch revert delete_block, cancel dialog

**Build 2: Rust concurrent undo test (#138)**
- `concurrent_undo_from_multiple_devices` in `src-tauri/src/commands.rs`
- Creates page + 2 children from different devices, edits both, spawns concurrent `undo_page_op_inner` via `tokio::spawn` + `tokio::join!`
- Verifies: both succeed, distinct op refs, blocks readable, op_log integrity

**Reviews:** 2 review subagents. Review 1 found 2 mock bugs (incorrect `redoOpType`, missing `restore_block` case in redo) — fixed. Review 2 raised concerns about concurrent assertion logic — analyzed and determined test is correct (both undos can succeed due to SELECT outside transaction).

### Test counts
- Vitest: 1312 tests, 49 files — all pass
- E2E: 8 new tests (3 undo + 5 history) — all pass
- Rust: 1 new test — passes

### Items resolved: 3 (Tier 6 complete)

## Session 11 — 2026-03-30 — Journal Tri-Mode, Slash Commands, Checkboxes, Fixes

### Features built (3 parallel subagents)

**Subagent A: Journal tri-mode + calendar**
- Daily/Weekly/Monthly mode switcher tabs
- Floating calendar picker (react-day-picker + Radix Popover)
- Monthly: semantic table grid with content dot indicators
- Weekly: Mon-Sun stacked BlockTrees
- New components: popover.tsx, calendar.tsx
- 25 JournalPage tests

**Subagent B: Slash commands + undo/redo fix + linking fix**
- `/` slash command TipTap extension (slash-command.ts)
- /TODO, /DOING, /DONE set block property
- /date creates/finds date page and inserts block link
- Undo/redo fix: `state.reconfigure({ plugins })` preserves keymaps
- Cross-page linking: BlockTree.handleNavigate detects foreign targets
- PageEditor threads onNavigateToPage to BlockTree
- 6 new tests

**Subagent C: Checkboxes**
- Interactive checkbox UI (empty square / blue indeterminate / green checkmark)
- DONE blocks get line-through + opacity-50
- `- [ ] ` → TODO and `- [x] ` → DONE markdown syntax (processed on blur)
- 13 new tests

**Result**: Commit `1acbf3e` — 17 files changed. 718 frontend + 885 Rust = 1,603 total tests.

---

## Session 10 — 2026-03-30 — Journal Workflow Features

### Task: Implement journal workflow (excluding templates)

**Features built** (4 parallel + 1 sequential subagent):

**Wave 1** (parallel):
- **1A: Scrollable past journals** — JournalPage rewritten to show 7 stacked days + "Load older days". 13 new tests.
- **1B: Backend property commands** — `set_property`, `delete_property`, `get_properties` Tauri commands + frontend wrappers + mock. 5 new Rust tests.
- **1C: Collapse/expand children** — Chevron toggle, `Ctrl+.` shortcut, client-side state, focus rescue. 16 new tests.

**Wave 2** (sequential, depends on 1B):
- **Task markers (TODO/DOING/DONE)** — Block properties for task state, visual icons, click-to-cycle, `Ctrl+Enter` shortcut. 21 new tests.

**Results**: Commit `c9ac3fc` — 13 files changed. 686 frontend + 885 Rust = 1,571 total tests.

**COMPARISON.md updated**: Journal workflow verdict upgraded Partial → Good. Task management 0 → 4. Block CRUD 9 → 10. Daily journal 5 → 7. Tier 1 items #1 and #4 marked Done. Tier 2 item #9 marked Done.

---

## Session 9 — 2026-03-30 — sqlx Migration + UX Polish Remaining Items

### Task 1: Migrate ~147 sqlx runtime queries to compile-time macros (REVIEW-LATER #1)

**Approach**: Audit all `query_as()` calls → test migration pattern → 4 parallel build subagents → verify + commit.

**Audit**: 147 `query_as()` calls across 12 files. 98.6% migratable (11 must remain runtime: 8 PRAGMA, 1 FTS5, 1 dynamic IN, 1 test helper).

**Build** (4 parallel subagents):
- A: snapshot.rs (37) + recovery.rs (18) = 55 calls
- B: commands.rs = 35 calls
- C: soft_delete.rs (44) + cache.rs (21) + db.rs (13) = 78 calls
- D: fts (7) + tag_query (5) + merge (3) + dag (1) + integration tests (17) = 33 calls

**Infrastructure**: Generated `.sqlx/` offline cache (82 query files). Updated `prek.toml` to exclude `.sqlx/` from biome/check-json hooks.

**Result**: Commit `1824e0a` — 95 files changed (12 Rust + 82 .sqlx/ cache + 1 prek.toml). 880/880 Rust tests pass.

### Task 2: UX polish items #62-#67

**Build** (2 parallel subagents):
- A: #62 skeleton loading (3 components) + #63 formatTimestamp utility + #64 debounce indicator
- B: #65 AND/OR tooltip + #66 inline CTAs + #67 shortcuts grouping

**Result**: Commit `af32df7` — 11 files changed (1 new utility + 10 components/tests). 651/651 frontend tests pass.

**Remaining**: #68 (shared EmptyState component) and #69 (minor polish collection) — both low-priority refactoring, not visual bugs.

---

## Session 8 — 2026-03-30 — UX Component Visual Polish

### Task: Comprehensive visual review + fix all 19 components

**Approach**: 4 parallel review subagents → consolidated review → 4 parallel build subagents → 4 review subagents → commit.

**Review phase** (4 parallel subagents):
- Group A: Editor Core (BlockTree, EditableBlock, StaticBlock, SortableBlock, FormattingToolbar, PageEditor)
- Group B: Navigation & Pages (App, BootGate, JournalPage, PageBrowser, BacklinksPanel)
- Group C: Search & Tags (SearchPanel, TagList, TagPanel, TagFilterPanel)
- Group D: System Views (StatusPanel, HistoryPanel, ConflictList, TrashView, KeyboardShortcuts)
- Findings consolidated into `UX-COMPONENT-REVIEW.md` (58 issues: 4 critical, 18 major, 28 minor, 8 nits)
- Visual spot checks via chrome-browser MCP confirmed all findings

**Build phase** (4 parallel subagents):
- Build A: 7 source + 2 test files (chip CSS, focus ring, hover states, drag handle, spacing, toolbar, title hint)
- Build B: 5 source + 1 test file (tags separator, boot states, empty states, skeleton loading, badge variants)
- Build C: 4 source + 1 test file (Badge component, empty states, spacing, section headers, skeleton loading)
- Build D: 5 source + 3 test files (destructive buttons, confirmation layout, badge/truncation, metric cards, kbd styling)
- Note: Builds B/D reverted A/C changes via git stash; A/C re-applied successfully

**Review phase** (4 parallel subagents):
- Review A: LGTM
- Review B: LGTM
- Review C: LGTM
- Review D: Found/fixed missing `min-w-0` on truncation parents in TrashView + ConflictList

**Result**: Commit `eff5293` — 28 files changed (19 source + 1 CSS + 8 tests), 651/651 tests pass.

---

## Session 1 — 2026-03-28

### Phase 1 — Foundation (Waves 1-2)

#### [11:37] Session start
- Read ADR.md (20 ADRs) and project-plan.jsx → converted to project-plan.md
- Created SESSION-LOG.md and REVIEW-LATER.md

#### [11:52] Environment check + Rust install
- Confirmed Node.js v22.22.0, installed Rust 1.94.1, Tauri system deps confirmed
- Created AGENTS.md

#### [11:55] Subagent A: Repo Scaffold [REVIEWED]
- **Tasks:** p1-t1 (Tauri 2.0), p1-t2 (Vite + React 18), p1-t3 (Biome)
- **Result:** Full project skeleton. cargo check + npm lint pass.
- **Commit:** (part of initial commits)

#### [12:05] Subagent B: Database & Backend Foundation [REVIEWED]
- **Tasks:** p1-t6 (sqlx), p1-t7 (migration), p1-t9 (error types), p1-t10 (ULID)
- **Result:** db.rs, error.rs, ulid.rs, 0001_initial.sql
- **Review fixes:** PRAGMA foreign_keys=ON, Serialize impl on AppError, ULID uppercase normalization, removed unused anyhow

#### [12:05] Subagent C: CI + Tooling [REVIEWED]
- **Tasks:** p1-t4 (CI), p1-t5 (device UUID), p1-t8 (.sqlx cache), p1-t30 (Vitest)
- **Result:** CI workflow, device.rs, .sqlx offline cache, vitest + smoke test
- **Review fixes:** op_log migration SQL PRIMARY KEY position, Vitest step in CI

---

## Session 2 — 2026-03-28

### Phase 1 — Wave 3 (Core Logic) + Wave 4 (Commands)

#### [12:46] Subagent D: Op Log Core [REVIEWED]
- **Tasks:** p1-t11 (op log writer), p1-t12 (blake3 hash), p1-t13 (op payload structs)
- **Result:** op.rs (12 op types), hash.rs (blake3), op_log.rs (append_local_op). 13 tests.
- **Commit:** 64147e1

#### [12:55] Subagent E: Block Drafts + Crash Recovery [REVIEWED]
- **Tasks:** p1-t14 (block draft writer), p1-t15 (crash recovery)
- **Result:** draft.rs, recovery.rs. 23 tests total.
- **Review fixes:** 2 flaky test timing issues (explicit timestamps)
- **Commit:** 31cefd3

#### [13:05] Subagent F: Materializer Queues [REVIEWED]
- **Tasks:** p1-t16 (foreground queue), p1-t17 (background queue)
- **Result:** materializer.rs (Materializer struct, dispatch_op, 5 task variants). 34 tests.
- **Commit:** 6b8b85e

#### [13:15] Subagent G: Cache Materializers [REVIEWED]
- **Tasks:** p1-t18 (tags), p1-t19 (pages), p1-t20 (agenda), p1-t21 (block_links)
- **Result:** cache.rs with 4 rebuild functions. 55 tests.
- **Review fixes:** INSERT OR IGNORE bug in agenda_cache, prek.toml cargo env sourcing
- **Commit:** 954e49e

#### [13:45] Subagent I: Cursor Pagination + Soft-Delete [REVIEWED]
- **Tasks:** p1-t22 (cursor pagination), p1-t23 (soft-delete cascade)
- **Result:** pagination.rs, soft_delete.rs. 80 tests.
- **Review:** No bugs found.
- **Commit:** cb24cb3

#### [14:15] 9-Group Parallel Review Sweep [REVIEWED]
- **Scope:** All Wave 3 modules — code improvements + test hardening + benchmarks
- **Result:** Tests 80 → 189. 5 new criterion benchmarks. Improvements across all 9 modules.
- **Commit:** 86a0dff

#### [14:45] Subagent: Tauri Commands [REVIEWED]
- **Tasks:** p1-t24 (create), p1-t25 (edit), p1-t26 (delete/restore/purge), p1-t27 (list)
- **Result:** commands.rs (7 handlers), materializer wired in lib.rs, busy_timeout fix. 214 tests.
- **Commit:** a9a85ea

#### [14:55] 3 Parallel Subagents: Frontend + Integration + CI [REVIEWED]
- **Tasks:** p1-t28 (boot store), p1-t29 (integration tests), p1-t31 (sqlx CI)
- **Result:** Zustand boot store, BootGate, 16 integration tests, sqlx offline check in CI. 235 tests.
- **Commit:** f4b9e10

**Phase 1 complete.** All 31 tasks done.

---

## Session 3 — 2026-03-28

### Post-Phase 1 — Code Review + Hardening

#### [15:15] 8-Group Code Review + Fixes [REVIEWED]
- **Scope:** All Rust modules against ADRs
- **9 fixes:** Atomic transactions, FK violation guard, UNIQUE violation fix, purge/restore validation, block_type validation, dead code removal, device TOCTOU fix
- **Commit:** 3622519

#### [16:00] Crate Auditing Tools [REVIEWED]
- Installed cargo-deny + cargo-machete, created deny.toml, added prek hooks
- **Commit:** 18ffc69

#### [16:30] Test Quality Sweep (5 parallel worktrees) [REVIEWED]
- Rewrote all 14 module test blocks. Tests: 262 → 330.
- **Commit:** 0a42606

#### [17:00] Command Integration Tests + Benchmarks (2 parallel worktrees) [REVIEWED]
- 46 new command integration tests, 11 Criterion benchmarks. Tests: 330 → 376.
- **Commit:** 70a6355

#### [17:30] Coverage Push [REVIEWED]
- Annotated untestable Tauri bootstrap with tarpaulin exclusion. Tests: 376 → 379. Coverage: 91% → 97.61%.
- **Commit:** 26172d2

---

## Session 4 — 2026-03-28

### Post-Phase 1 — 7-Group Review + Tier 1-2 Fixes + Coverage

#### [18:00] 7-Group Parallel Code Review [REVIEWED]
- **Scope:** Full codebase audit (16 Rust + 6 frontend files + migration SQL) vs ADRs
- **Findings:** 4 Tier 1 (fix now), 6 Tier 2 (fix before Phase 2), 8 Tier 3 (nice to have), 5 false positives dismissed
- Tier 1: missing sync_all, edit_block cache dispatch, fire-and-forget materializer
- Tier 2: TOCTOU in delete/restore/purge, parent_seqs sorting, list_trash index

#### Tier 1 + Tier 2 Fixes [REVIEWED]
- device.rs: sync_all + readonly parent test
- materializer.rs: edit_block cache dispatch + error handler extraction
- commands.rs: fire-and-forget dispatch + atomic transactions
- op_log.rs: parent_seqs sorting
- migration: idx_blocks_deleted index
- recovery.rs: error handler extraction + DB failure test

#### Coverage Push [REVIEWED]
- Coverage: 97.61% → 99.64% (839/842). Tests: 379 → 385. +6 tests.
- 3 remaining lines are tarpaulin artifacts.
- **Commit:** 5ef0b0a

---

## Session 5 — 2026-03-28

### Workflow Optimization

#### AGENTS.md Rewrite [BUILT]
- Added Tooling Efficiency Rules section (prek-as-verification, compilation cost table, subagent verification rules)
- Streamlined workflow cycle from 11 steps to 6
- Added task status definitions ([BUILT], [REVIEWED])
- Slimmed subagent prompt template (minimal context, subagents read files themselves)
- Added worktree decision criteria (3 conditions)
- Added subagent sizing guidance
- Fixed stale test count in build commands (was 262, now 385)
- Removed project-plan.jsx from structure (deleted in prior session)

#### SESSION-LOG.md Rewrite [BUILT]
- Added [REVIEWED] tag retroactively to all completed entries
- Condensed entries (removed redundant detail, kept results + commits)

---

## Session 6 — 2026-03-28

### Phase 1.5 — Daily Driver Frontend

#### Markdown Serializer [BUILT]
- **Tasks:** p15-t1..t5
- **Result:** `src/editor/markdown-serializer.ts`, `src/editor/types.ts`, 84 Vitest tests. Hand-rolled parser/serializer for bold/italic/code/tag_ref/block_link. Round-trip identity verified.
- **Commit:** 5d3a277

#### TipTap Extensions + Roving Editor + Keyboard Hook [BUILT]
- **Tasks:** p15-t6..t9
- **Result:** `tag-ref.ts`, `block-link.ts` extensions, `use-roving-editor.ts`, `use-block-keyboard.ts`. Mount/unmount lifecycle, serialize on blur.
- **Commit:** 91274ba

#### Block Store + Tree Renderer + Auto-Split + CRUD UI [BUILT]
- **Tasks:** p15-t10, t14..t16
- **Result:** `blocks.ts` Zustand store, `BlockTree.tsx`, `EditableBlock.tsx`, `StaticBlock.tsx`. Auto-split on blur, Enter to create, Backspace to delete.
- **Commit:** a582373

#### Tag Picker + Block-Link Picker Extensions [BUILT]
- **Tasks:** p15-t11, t12
- **Result:** `at-tag-picker.ts`, `block-link-picker.ts`, `SuggestionList.tsx`, `suggestion-renderer.ts`. Installed `@tiptap/suggestion`. Fuzzy search via TipTap suggestion plugin.
- **Commit:** 519bedd

#### Viewport Intersection Observer [BUILT]
- **Tasks:** p15-t13
- **Result:** `useViewportObserver.ts` hook, integrated into BlockTree. Off-screen blocks rendered as static divs.
- **Commit:** 5412526

#### Indent/Dedent + move_block Command [BUILT]
- **Tasks:** p15-t17
- **Result:** `move_block` Rust command added to `commands.rs` + `lib.rs`. Frontend `indent()`/`dedent()` in blocks store. Tab/Shift+Tab in BlockTree.
- **Commit:** 62ef596

#### Tag Panel + add_tag/remove_tag Commands [BUILT]
- **Tasks:** p15-t18, t19
- **Result:** `TagPanel.tsx`, `add_tag`/`remove_tag` Rust commands. Apply/remove tags from blocks.
- **Commit:** 3ca3d77

#### Journal Page + Date Nav + Page Browser [BUILT]
- **Tasks:** p15-t20..t22
- **Result:** `JournalPage.tsx`, `PageBrowser.tsx`. Date navigation (today/prev/next), paginated page list. Updated `list_blocks` with `agenda_date` param.
- **Commit:** fc54ca4

#### Trash View + Restore + Purge UI [BUILT]
- **Tasks:** p15-t23..t25
- **Result:** `TrashView.tsx`. Paginated trash list, restore with deleted_at_ref, purge with confirmation dialog.
- **Commit:** 6317216

**NOTE:** All Phase 1.5 commits above were built without review subagents — workflow violation. Retroactive review completed below.

#### Retroactive Review — 5 Parallel Subagents in Worktrees [REVIEWED]
- **Scope:** All Phase 1.5 code (p15-t1..t25)
- **Group A (serializer):** Fixed unclosed-italic revert dropping nested bold `**` delimiter. Found bold-inside-italic data-loss limitation (see REVIEW-LATER.md). 100% coverage (stmts/branch/funcs/lines). +26 tests (84→110).
- **Group B (editor):** clearHistory on mount via state.reconfigure (ADR-01 undo leak fix). Extracted testable `handleBlockKeyDown` pure function. +47 tests.
- **Group C (components):** Fixed captured `activeBlockId` before `unmount()` in EditableBlock + BlockTree (content loss on focus-switch). +45 tests.
- **Group D (Rust):** TOCTOU fix — moved validation inside `BEGIN IMMEDIATE` for move_block, add_tag, remove_tag. +23 Rust tests (421 total).
- **Group E (views):** JournalPage missing cursor pagination (ADR violation — fixed). PageBrowser sort comment fix. +32 tests.
- **Also fixed:** Materializer `tokio::spawn` → `cfg(test)`/`cfg(not(test))` split to fix Tauri setup hook panic.
- **Tests after review:** 421 Rust + 239 Vitest = 660 total.
- **Commit:** dbfbf65

#### App Layout — Collapsible Sidebar [BUILT]
- **Result:** Sidebar with Journal/Pages/Tags/Trash navigation. Opens Journal by default. Replaced Tauri template CSS.
- **Commit:** dbfbf65 (same commit as review)

---

## Session 7 — 2026-03-28

### UI Modernization — shadcn/ui + Tailwind CSS v4 + Slate Theme

#### shadcn/ui Foundation [BUILT]
- Installed Tailwind CSS v4 + `@tailwindcss/vite` plugin
- Installed shadcn/ui dependencies (CVA, clsx, tailwind-merge, lucide-react, radix-ui)
- Set up `index.css` with **slate** theme CSS variables (light + dark mode via oklch)
- Created `cn()` utility (`src/lib/utils.ts`) and `components.json` config
- 10 shadcn components installed: sidebar, button, badge, card, input, scroll-area, separator, tooltip, sheet, skeleton

#### Sidebar + Views → shadcn Components (3 parallel subagents) [BUILT]
- **App.tsx:** Rewrote with `SidebarProvider` > `Sidebar collapsible="icon"` + `SidebarRail`. Lucide icons (Calendar, FileText, Tag, Trash2). Header bar with `SidebarTrigger` + breadcrumb view title. Gutted App.css.
- **JournalPage:** shadcn `Button` (outline/ghost) for date nav, `Badge` for block types, Lucide chevrons
- **PageBrowser:** shadcn `Button` for load-more, `FileText` icon per page item
- **TagPanel:** shadcn `Badge` for tag chips, `Input` for search, `Button` for add/create/cancel, Lucide `Plus`/`X` icons
- **TrashView:** shadcn `Badge` for block types, `Button` for restore/purge, `AlertTriangle` + `RotateCcw` icons

#### Remaining Components → shadcn/Tailwind (3 parallel subagents) [BUILT]
- **BootGate:** Spinning `Loader2` icon, shadcn `Button variant="outline"` for retry, Tailwind layout classes
- **SuggestionList:** Popover-styled with `bg-popover`, `shadow-md`, `rounded-lg border`, accent highlight via `cn()`
- **BlockTree:** Tailwind for loading/empty states, dashed border empty state
- **StaticBlock:** Tailwind hover/focus styling, muted italic placeholder

**Result:** Zero custom components using inline styles or raw HTML buttons. All UI uses shadcn components + Tailwind utilities on the slate theme. 213/213 Vitest tests passing, tsc clean.
- **Commit:** (pending)

#### Usability Wiring (JournalPage, PageBrowser, TagList) [BUILT]
- **JournalPage:** Rewritten with find-or-create daily page model. First block auto-creates page; deleting last block auto-deletes it. Add block form with Input + Button. Hover-reveal delete buttons.
- **PageBrowser:** "New Page" button creates Untitled page, prepends to list.
- **TagList:** New component (`src/components/TagList.tsx`). Lists all tags, inline add form, hover-delete. Replaces TagPanel in sidebar tags view.
- **Tests:** 233 Vitest tests passing, tsc clean.
- **Commit:** (pending)

---

## Session 8 — 2026-03-28

### Browser Preview Infrastructure + Button Fix

#### Browser Mock for Chrome DevTools MCP [BUILT]
- **Problem:** Tauri webview (WebKitGTK) doesn't expose Chrome DevTools Protocol. The `chrome-devtools-mcp` server can't connect to the Tauri app for visual inspection.
- **Solution:** Created `src/lib/tauri-mock.ts` using `@tauri-apps/api/mocks` — mocks all IPC commands with in-memory store. `src/main.tsx` auto-loads mock when `window.__TAURI_INTERNALS__` is absent. Added type declaration in `src/vite-env.d.ts`.
- **Result:** App renders at `http://localhost:5173` in Chrome with functional mock data. `chrome-browser` MCP server (launches its own Chrome) connects and provides `take_screenshot`, `take_snapshot`, `navigate_page`, `click`, `fill`, etc.
- **Key discovery:** Use `chrome-browser` server (not `chrome-devtools`) — it launches its own headless Chrome, no user setup needed.
- **Files:** `src/lib/tauri-mock.ts` (new), `src/main.tsx` (modified), `src/vite-env.d.ts` (modified)

#### Button Consistency Fix [BUILT]
- **Problem:** Action buttons used inconsistent variants — JournalPage "Add" and TagList "Add Tag" used `default` (solid primary), PageBrowser "New Page" used `outline`. Same hierarchy level, different appearance.
- **Fix:** Standardized all action buttons to `variant="outline" size="sm"`. Three levels: outline (actions), ghost+xs (utility like "Today"), ghost+icon-xs (hover-reveal delete icons).
- **Files:** `src/components/JournalPage.tsx`, `src/components/TagList.tsx`

#### AGENTS.md Updated [BUILT]
- Added `src/lib/tauri-mock.ts` to project structure
- Added "Browser Preview (Chrome DevTools MCP)" section with full autonomous workflow (start Vite, use `chrome-browser` MCP, screenshot/snapshot/interact cycle)
- Documented MCP server comparison table (`chrome-browser` preferred vs `chrome-devtools`)
- MCP tool cheatsheet
- **Commit:** (pending)

---

## Session 8 — 2026-03-28

### Serializer Bug Fix + Property-Based Tests

#### Serializer Review Completion
- **Bug fixed:** Unclosed italic revert was dropping nested `**` bold delimiter. `parse('*italic **bold')` produced `text("*italic bold")` instead of `text("*italic **bold")`. Fixed by splitting reverted nodes at bold boundary.
- **26 new tests** added (84 → 110 total), 100% coverage across all metrics.
- **Known limitation documented:** Bold-inside-italic mark merging causes data loss (REVIEW-LATER.md, high priority, Phase 2).
- **Commit:** `7b224c8`

#### fast-check Property-Based Tests
- Added `fast-check` dependency for generative fuzzing of the serializer.
- **12 property tests**, 500 random inputs each (6,000 generated cases per run):
  - Parse safety (random + markdown-shaped strings)
  - Serialize safety (any valid doc)
  - Round-trip stabilization (normalized structural equality)
  - Idempotence (string equality after two round-trips)
  - Doc round-trip (normalize → serialize → parse → compare)
  - ULID token preservation, text content preservation
  - Structural invariants (paragraph hierarchy, non-empty text nodes, newline counts)
- Custom `Arbitrary` generators: mark combos → text nodes → inline sequences → paragraphs → docs.
- fast-check found during development: adjacent same-mark text node merging, empty code span splitting — both handled via `normalizeDoc()` helper.
- **Commit:** `e4d579d`

### ADR Status Annotations + Task-ADR Cross-References

#### ADR.md — Status markers on all 20 ADRs
- 2 **FULLY IMPLEMENTED**: ADR-04 (Database), ADR-05 (Schema)
- 1 **FULLY IMPLEMENTED** (decision-only): ADR-15 (Encryption)
- 1 **CLOSED**: ADR-18 (Tag Inheritance)
- 2 **N/A**: ADR-14 (Dropped API), ADR-17 (Deferred Graph View)
- 11 **Phase 1/1.5 complete** with remaining work noted
- 3 **Not started**: ADR-09 (Sync), ADR-10 (CRDT), ADR-12 (Search)

#### project-plan.md — ADR refs on 128/129 tasks
- Every task now has `[ADR-XX]` prefix in Notes column (except p5-t10 Tauri updater — no ADR).
- Most referenced ADRs: ADR-01 (22 tasks), ADR-06 (20), ADR-07 (18), ADR-08 (18).

---

## Session 9 — 2026-03-28

### Button Fix + RTL Tests + Insta Snapshots + Specta Bindings

#### Button Icon Spacing Fix [BUILT]
- **Problem:** Button icon spacing used negative margin hacks (`-ml-1`, `-mr-1`).
- **Fix:** Changed default button gap from `gap-2` to `gap-1.5`, removed negative margins.
- **Commit:** `d279180`

#### RTL Component Tests + vitest-axe a11y [REVIEWED]
- Rewrote PageBrowser and TrashView tests from raw `createRoot`/`act()` to `@testing-library/react`.
- New test files: JournalPage (11 tests), TagList (7 tests), App (8 tests).
- Added `vitest-axe` for a11y testing in all component test files.
- New deps: `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `vitest-axe`.
- Created `src/vitest-axe.d.ts` for TypeScript type augmentation.
- Updated `src/test-setup.ts` with RTL cleanup, ResizeObserver polyfill, matchMedia stub.
- Excluded `src/lib/bindings.ts` from `tsconfig.app.json` and `biome.json`.
- **Tests:** 279 Vitest frontend tests, zero act() warnings.
- **Commit:** `c943f1c`

#### Insta Snapshot Tests + Specta/Tauri-Specta TypeScript Bindings [REVIEWED]
- **Insta snapshots (19 files):** Op payload serialization (12 variants), op log (2), commands (3), pagination (2).
- **Specta integration:** `specta::Type` derives on all response structs, `#[specta::specta]` on 10 commands, `AppErrorSchema` proxy, `tauri-specta Builder` replaces `generate_handler!`.
- **Binding test split:** `ts_bindings_up_to_date` (runs in CI, compares temp file) + `regenerate_ts_bindings` (`#[ignore]`, writes to disk).
- **Config fixes:** Added RUSTSEC-2024-0436 (paste) to deny.toml ignore, excluded bindings.ts from biome prek hook.
- **Tests:** 430 Rust tests pass.
- **Commit:** `f530837`

---

## Session 3 — 2026-03-28 (continued)

### Android Spike (p15-t26..t29)

#### [23:05] Android Spike — Setup
- Installed JDK 17, Android SDK (platform-tools, build-tools 34, NDK 27, emulator)
- Installed Rust Android targets (aarch64, armv7, i686, x86_64)
- Ran `cargo tauri android init` — generated Android project at `src-tauri/gen/android/`

#### [23:40] Android Spike — Build + Test
- Created AVD (spike_test, Pixel 6, Android 14 x86_64)
- Fixed esbuild missing dep (Vite 8 change)
- Manually installed Gradle 8.14.3 (network timeout workaround)
- Built debug APK: `cargo tauri android build --target x86_64 --debug` — 154MB
- Installed and launched on emulator — app renders correctly
- **Rust backend init:** SQLite + WAL + device ID + crash recovery completed in 9ms
- **IME/keyboard:** Virtual keyboard appears, text input works, autocomplete shows
- **IPC reads:** `list_blocks` works, date navigation works
- **IPC writes:** `create_block` fails with `Uncaught (in promise) #<Object>` — ~~needs debugging~~ **Update 2026-03-31:** confirmed working after `pm clear`; original failure was stale migration data, not a code bug
- **Spike decision:** PROCEED — core architecture proven viable on Android
- **Commit:** `441d5ea`

### Types Re-export + UI Fixes + ADR Updates

#### [earlier] Subagent: Types migration + UI fixes [REVIEWED]
- **Tasks:** Re-export types from bindings.ts, ADR-01/ADR-13 status updates, button icon scaling, duplicate titles, sidebar A height, double-click rail
- **Result:** 8 manual interfaces removed from tauri.ts, replaced with re-exports from bindings.ts. UI fixes for icon scaling, duplicate headings, sidebar height, rail double-click.
- **Commit:** `967e79a`

---

### Phase 2 Wave 1 — Backend Queries + Frontend Panels

#### [00:05] Subagent: Backend queries + commands [REVIEWED]
- **Tasks:** p2-t3 (backlinks query), p2-t6 (history query), p2-t12 (conflicts query), p2-t15 (status command)
- **Build:** list_backlinks, list_block_history, list_conflicts in pagination.rs; get_backlinks, get_block_history, get_conflicts, get_status in commands.rs; StatusInfo on Materializer
- **Review:** All correct, added 6 more tests (cursor roundtrip, backward compat, empty results, conflicts pagination)
- **Tests:** 452 Rust tests passing

#### [00:30] Subagent: Frontend panels + IPC wrappers [REVIEWED]
- **Tasks:** p2-t4/t5 (backlinks panel), p2-t7/t8 (history panel), p2-t13/t14 (conflict UI), p2-t16/t17 (status panel)
- **Build:** BacklinksPanel, HistoryPanel, StatusPanel, ConflictList components; 4 IPC wrappers + 7 mock handlers; Status/Conflicts nav in App.tsx
- **Review:** Fixed optional params bug in getBacklinks (params? → params required), added 9 edge-case tests
- **Tests:** 330 frontend tests passing
- **Commit:** `4c755bd`

### Phase 2 Wave 2 — Link Navigation + Decorations

#### [00:55] Subagent: Link nav + broken link + deleted tag [REVIEWED]
- **Tasks:** p2-t4 (link chip navigation), p2-t5 (broken link decoration), p2-t14 (deleted tag decoration)
- **Build:** BlockLink/TagRef NodeViews with resolveStatus, ref-based callback wiring, handleNavigate in BlockTree, renderRichContent in StaticBlock
- **Review:** Clean pass, added 8 tests (NodeView update/destroy, both deleted decorations, missing onNavigate)
- **Tests:** 368 frontend tests passing
- **Commit:** `bca657c`

### Phase 2 Wave 3 — Move, Merge, Indent

#### [01:18] Subagent: DnD reorder + block merge [REVIEWED]
- **Tasks:** p2-t9 (drag-to-reorder), p2-t10 (move to parent — already done via indent/dedent), p2-t11 (block merge on Backspace)
- **Build:** @dnd-kit/core+sortable, SortableBlock wrapper, reorder store action, onMergeWithPrev keyboard handler, handleMergeWithPrev in BlockTree
- **Review:** Fixed 3 bugs: splice off-by-one (critical), position calc for forward moves (critical), redundant unmount (minor). Added 4 tests.
- **Known limitation:** Position collision with consecutive integer positions → tracked in REVIEW-LATER.md
- **Tests:** 390 frontend tests passing
- **Commit:** `3edc1a8`

### Phase 2 — Wave 4 (E2E Testing)

#### [23:05] Subagent: P2 Wave 4 Build — Playwright E2E setup [BUILT]
- **Tasks:** p2-t18, p2-t19
- **Result:** Playwright config with Vite webServer auto-start, 15 E2E tests (3 smoke + 12 editor lifecycle), `@playwright/test` devDep, npm scripts
- **New files:** `playwright.config.ts`, `e2e/smoke.spec.ts`, `e2e/editor-lifecycle.spec.ts`
- **Tests:** 15 Playwright + 390 Vitest passing

#### [23:15] Subagent: P2 Wave 4 Review — Playwright E2E tests [REVIEWED]
- **Tasks:** p2-t18, p2-t19
- **Fixes:** aria-label on delete button (a11y), fragile CSS selectors → semantic roles, 3 new edge-case tests, tsconfig.node.json includes playwright.config.ts
- **CI:** Added Playwright install + run steps to `.github/workflows/ci.yml`, added Playwright artifacts to `.gitignore`
- **Tests:** 18 Playwright + 390 Vitest = 408 frontend, 452 Rust = 860 total
- **Commit:** `d3026ec`

### Phase 3 — Wave 1 (FTS5 Backend)

#### [23:30] Subagent: P3 Wave 1 Build — FTS5 backend [BUILT]
- **Tasks:** p3-t1, p3-t2, p3-t3, p3-t4
- **Result:** FTS5 virtual table (0002_fts5.sql), fts.rs module with strip pass + search + optimize, materializer routing for 4 new task variants, search_blocks command, cursor pagination on (rank, rowid)
- **New files:** `src-tauri/migrations/0002_fts5.sql`, `src-tauri/src/fts.rs`
- **Modified:** lib.rs, materializer.rs, commands.rs, pagination.rs, bindings.ts
- **Tests:** 484 passing (33 new FTS tests)

#### [23:45] Subagent: P3 Wave 1 Review — FTS5 backend [REVIEWED]
- **Tasks:** p3-t1, p3-t2, p3-t3, p3-t4
- **Fixes:** Defense-in-depth empty query guard in search_fts, 10 additional tests (2 search edge cases, 4 command handler, 4 materializer dedup)
- **Tests:** 494 Rust + 390 Vitest + 18 Playwright = 902 total
- **Commit:** `36239ed`

### Phase 3 — Wave 2 (Search UI + CJK Notice)

#### [00:30] Subagent: P3 Wave 2 Build — Search UI [BUILT]
- **Tasks:** p3-t5, p3-t6
- **Result:** SearchPanel component with debounced input (300ms), cursor pagination, block type badges, CJK notice. searchBlocks IPC wrapper + mock. Search view in sidebar nav.
- **New files:** `src/components/SearchPanel.tsx`, `src/components/__tests__/SearchPanel.test.tsx`
- **Modified:** App.tsx, tauri.ts, tauri-mock.ts, tauri.test.ts
- **Tests:** 406 frontend passing (16 new)

#### [00:45] Subagent: P3 Wave 2 Review — Search UI [REVIEWED]
- **Tasks:** p3-t5, p3-t6
- **Fixes:** A11y (role="search" on form, aria-label on input), 3 new tests (whitespace guard, error handling, search landmark). Biome lint fixes (import formatting, non-null assertions → optional chain).
- **Tests:** 409 Vitest + 494 Rust + 18 Playwright = 921 total
- **Commit:** `4e0d7e9`

### Phase 3 Wave 3 — Tag Queries

#### [01:00] Subagent: P3 Wave 3 Build — Tag Query Backend [BUILT]
- **Tasks:** p3-t7, p3-t8
- **Result:** `tag_query.rs` — TagExpr tree (Tag, Prefix, And, Or, Not) with FxHashSet evaluation, `eval_tag_query()` paginated, `list_tags_by_prefix()`. Added `rustc-hash` dep. Commands: `query_by_tags`, `list_tags_by_prefix` in commands.rs + lib.rs.
- **Tests:** 523 Rust (28 new: 20 tag_query + 8 commands)

#### [01:00] Subagent: P3 Wave 3 Build — Tag Filter Frontend [BUILT]
- **Tasks:** p3-t9
- **Result:** `TagFilterPanel.tsx` — prefix search (debounced 300ms), tag selection badges, AND/OR toggle, paginated results. IPC wrappers + mocks for both commands.
- **Tests:** 430 frontend (15 new TagFilterPanel + 8 tauri wrapper)

#### [01:30] Subagent: P3 Wave 3 Review — Backend + Frontend [REVIEWED]
- **Tasks:** p3-t7, p3-t8, p3-t9
- **Bug fixed:** SQL LIKE injection — `%` and `_` in prefix not escaped. Added `escape_like()` helper + `ESCAPE '\'` clause in both LIKE queries. 7 new tests.
- **Tests:** 531 Rust + 430 Vitest + 18 Playwright = 979 total
- **Commit:** `c3f160b`

### Phase 3 Wave 4 — Performance + Tooling

#### [02:00] Orchestrator: cargo-nextest migration (p3-t10) [REVIEWED]
- **Result:** Installed cargo-nextest 0.9.132. Created `src-tauri/.config/nextest.toml` (retries, slow-timeout profiles). Updated prek.toml hook and CI workflow.
- 534 tests pass with nextest (parallel execution, ~3.3s)

#### [02:00] Subagent: FTS5 perf benchmark (p3-t11) [REVIEWED]
- **Result:** `src-tauri/benches/fts_bench.rs` — 4 benchmark groups (search, rebuild, update, optimize) parameterized at 1k/10k/100k corpus sizes. Varied content with ~10% search hit rate.

#### [02:00] Subagent: Materializer queue monitoring (p3-t12) [REVIEWED]
- **Result:** High-water marks (`fg_high_water`, `bg_high_water`) via `AtomicU64::fetch_max`. `check_queue_pressure()` logs warnings at 75% capacity. StatusInfo expanded. 4 new tests.
- **Tests:** 534 Rust + 430 Vitest + 18 Playwright = 982 total
- **Commit:** `19587d9`

**Phase 3 complete.** All 12 tasks done.

---

## Session 11 — 2026-03-29

### Phase 4 Wave 1 — DAG + Merge

#### [08:00] Subagent: DAG primitives build (p4-t3/t4/t5) [BUILT]
- **Result:** `dag.rs` — insert_remote_op (idempotent, hash-verified), append_merge_op (multi-parent), find_lca (two-pointer walk), text_at, get_block_edit_heads. 23 new tests.
- **Tests:** 557 Rust passing

#### [08:15] Subagent: DAG primitives review [REVIEWED]
- **Fixes:** Extracted shared `serialize_inner_payload` (was duplicated from op_log.rs → now `pub(crate)`). Added 2 edge-case tests (find_lca with create_block as input).
- **Tests:** 559 Rust passing

#### [08:15] Subagent: Merge logic build (p4-t6/t7/t8/t9) [BUILT]
- **Result:** `merge.rs` — merge_text (diffy::merge), create_conflict_copy (atomic tx, is_conflict=1), resolve_property_conflict (LWW + device_id tiebreaker), merge_block orchestrator. Added `diffy` dep. 24 new tests.
- **Tests:** 578 Rust passing

#### [08:30] Subagent: Merge logic review [REVIEWED]
- **Bug fixed:** resolve_property_conflict was non-commutative when timestamps and device_ids matched — added seq as second tiebreaker. 7 new tests (commutativity, unicode, null position, multi-paragraph).
- **Tests:** 584 Rust + 430 Vitest + 18 Playwright = 1032 total
- **Commit:** `aba7ed3`

### Phase 4 Wave 2 — Snapshot + Compaction

#### [23:15] Subagent: snapshot.rs build (p4-t19/t20/t21/t22) [BUILT]
- **Result:** `snapshot.rs` — zstd+ciborium encoding/decoding, crash-safe create_snapshot (pending→complete), apply_snapshot RESET path (wipe+insert in tx), compact_op_log 90-day retention, get_latest_snapshot. Added `zstd` 0.13 + `ciborium` 0.2 deps. `Snapshot(String)` error variant.
- **Tests:** 13 new snapshot tests, 598 Rust passing

#### [23:30] Subagent: snapshot.rs review [REVIEWED]
- **Bug fixed:** `collect_frontier` crashed with `RowNotFound` on empty op_log — added early-return guard with clear error message.
- **New tests:** 4 added (CBOR float round-trip, empty op_log, multi-device compaction, FK violation rejection).
- **Tests:** 602 Rust + 430 Vitest + 18 Playwright = 1050 total
- **Commit:** `656c8c5`

---

### Comprehensive Code Audit

#### [20:00] Phase 1: 10 Find-Issues subagents
- **Scope:** All Rust modules (schema, op-log, drafts, DAG, materializer, pagination, merge, FTS, commands, serialization)
- **Result:** 204 confirmed findings, 2 rejected, 5 new findings discovered during validation

#### [20:30] Phase 2: 10 Validate-Issues subagents
- **Result:** Validated all 204 findings. Key escalations: `reconfigure` drops all plugins (critical), escape desync (high)

#### [21:00] Phase 3: 10 Fix subagents + 1 re-apply subagent [BUILT]
- **Domains:** Schema+DataModel, Op Log Core, Drafts+Recovery, DAG+Snapshots, Materializer+Cache, Pagination+Tags, Merge, FTS5, Commands, Serialization
- **Parallel execution:** 10 subagents in same worktree caused file conflicts; 5 domains required re-application via targeted subagent
- **Critical fixes:** BlockId deserialization normalization, TOCTOU races in commands, FTS5 query injection, restore CTE bug, crash recovery content update, merge op creation on conflict, multi-device pagination
- **New modules:** (serializer.rs, org_parser.rs, org_emitter.rs were added but later removed — org-mode syntax not used)

#### [21:30] Phase 4: 2 Review subagents [REVIEWED]
- **Review 1 (Backend Core):** Found 3 missing snapshot.rs fixes (read tx, defer_foreign_keys, BEGIN IMMEDIATE). Applied.
- **Review 2 (Commands+FTS+Merge+Pagination+Serialization):** Found missing fts_blocks cleanup in inlined purge. Applied.
- **Tests:** 794 Rust (753 lib + 41 serializer integration) + 430 Vitest = 1224 total
- **Commit:** `e4531ea`

### Code Audit Round 2

#### [23:05] Phase 1: 10 Explore subagents (re-audit all domains)
- **Domains:** Schema+DataModel, Op Log Core, Drafts+Recovery, DAG+Snapshots, Materializer+Cache, Pagination+Tags, Merge, FTS5, Commands, Serialization
- **Result:** 8 of 10 domains pass clean. 2 critical findings in Op Log Core domain.

#### [23:30] Phase 2: Fix critical findings [REVIEWED]
- **F-01 (CRITICAL):** `normalize_block_ids()` not called before serialization in `append_local_op_in_tx` — added call before `serialize_inner_payload()`. Ensures deterministic blake3 hashes for Phase 4 sync.
- **F-02 (CRITICAL):** `validate_set_property()` never called in production — added validation in `append_local_op_in_tx` for SetProperty ops.
- **F-04 (MEDIUM):** Updated `hash.rs` docs to document ULID normalization requirement.
- **Deferred:** F-03 (json_extract O(n)), recovery timestamps, merge docs → REVIEW-LATER.md
- **5 new tests:** ULID normalization, hash determinism, SetProperty validation (3 tests)
- **Review:** Separate review subagent confirmed all fixes correct, no issues found
- **Tests:** 759 Rust (758 passed + 1 ignored specta) + 41 serializer integration + 430 Vitest = 1230 total
- **Commit:** `e5d048c`

## Session 3 — 2026-03-29

### UX Improvements Wave

#### [22:30] Branding + UI Infrastructure
- Added Agaric branding (logo SVG, favicon, App.tsx header)
- Created UX-TODOS.md with 13 UX issues
- Added sonner toast + radix AlertDialog UI primitives
- **Commits:** `63c5412`, `45423e2`

#### [22:45] Subagent A: Tags & Pages UX [REVIEWED]
- **Tasks:** UX #1 (tag delete confirmation), #2 (page delete confirmation), #7 (clickable tag names), #8 (toast errors), #10 (disabled state)
- **Files:** TagList.tsx, PageBrowser.tsx + tests
- **Tests:** +18 new tests (TagList: 18, PageBrowser: 14)
- **Worktree:** `/tmp/wt-ux-tags/`

#### [22:45] Subagent B: Editor & Block UX [REVIEWED]
- **Tasks:** UX #3 (block delete button), #4 (empty block visibility), #5 (detail panel collapsed), #6 (header label), #12 (sidebar active state)
- **Files:** PageEditor.tsx, SortableBlock.tsx, BlockTree.tsx, StaticBlock.tsx, EditableBlock.tsx, App.tsx, test-setup.ts + tests
- **Tests:** +10 new tests
- **Worktree:** `/tmp/wt-ux-editor/`

#### [23:00] Review + Merge
- Review subagent found & fixed: missing `aria-label` on trash buttons, updated test selectors to semantic `getByRole`
- Wired up `onTagClick` in App.tsx (navigates to page-editor for tag)
- Fixed Biome lint (non-null assertions → type casts)
- **Tests:** 557 Vitest passing (+127 new), all prek hooks pass
- **Commit:** `eba2d9d`

## Session 5 — 2026-03-29

### UX Improvements Wave 2 + REVIEW-LATER Fixes

#### [22:26] Build: UX remaining items (#9 #11 #13) [BUILT]
- **Tasks:** Keyboard shortcut help sheet, tag filter feedback text, skeleton loading states
- **Files:** KeyboardShortcuts.tsx (new), App.tsx, TagFilterPanel.tsx, PageBrowser.tsx, TagList.tsx, JournalPage.tsx, SearchPanel.tsx + tests
- **Result:** 571 Vitest tests passing

#### [22:40] Review: UX items [REVIEWED]
- Added `?` shortcut self-reference, singular tag feedback test
- **Tests:** 571 Vitest passing

#### [22:50] Visual Review
- Screenshotted all 8 views via chrome-browser MCP (Journal, Shortcuts, Search, Pages, Tags, Trash, Status, Conflicts)
- **Result:** No visual issues found

#### [23:00] Build: REVIEW-LATER fixes #24 #25 #26 #47 [BUILT]
- **#24:** NaN/Infinity validation in `validate_set_property()` (op.rs)
- **#25:** Position validation in `create_block_inner()` + `move_block_inner()` (commands.rs)
- **#26:** Date format validation `validate_date_format()` in `list_blocks_inner()` (commands.rs)
- **#47:** `unwrap()` → `expect()` in `compute_op_hash()` (hash.rs)
- Collateral: fixed 0-based → 1-based positions in integration tests
- **Tests:** 809 Rust tests passing

#### [23:15] Review: REVIEW-LATER fixes [REVIEWED]
- All 4 fixes verified correct
- Added 3 more tests: day=32 rejection, "not-a-date" rejection, negative move position
- **Tests:** 811 Rust tests passing

#### [23:30] Commit
- Updated REVIEW-LATER.md: #24, #25, #26, #47 marked RESOLVED

---

## Session 8 — 2026-03-30

### UX Review Findings — Triage & Fix

#### [12:00] UX-TODOS.md review — 4 parallel review subagents
- Reviewed all 13 UX findings from UX-TODOS.md against current source code
- **9 of 13 already resolved** in prior commits (issues #1-4, #6-9, #13)
- **4 confirmed** needing fixes: #5 (detail panel layout), #10 (button disabled state), #11 (tag prefix highlight), #12 (sidebar active state)
- Updated UX-TODOS.md with RESOLVED/CONFIRMED status for each

#### [12:05] Build subagent A: Issue 5 fix [REVIEWED]
- **Worktree:** /tmp/wt-ux-issue5
- **Change:** Added `max-h-60 overflow-y-auto` to PageEditor detail panel content div
- **Test:** Added bounded-height assertion test (23/23 pass)

#### [12:05] Build subagent B: Issues 10, 11, 12 fixes [REVIEWED]
- **Worktree:** /tmp/wt-ux-polish
- **Changes:**
  - button.tsx: `disabled:opacity-50` → `disabled:opacity-35`
  - TagFilterPanel.tsx: Added `HighlightPrefix` component for bold prefix matching
  - sidebar.tsx: Added `data-[active=true]:border-l-2 border-l-primary`
- **Tests:** Added prefix highlight test + updated 3 existing tests (21/21 pass)

#### [12:10] Review subagents (2 parallel) — both APPROVED
- No issues found in either fix set
- All tests verified passing

#### [12:12] Merge & commit
- Merged from worktrees, 582 frontend tests pass
- All prek hooks pass (biome, tsc, vitest)
- **Commit:** fcf6354

---

## Session 12 — 2026-03-30 — Benchmark Fixes & Scale Benchmarks

### Benchmark compilation fixes + deprecation cleanup

- **commands_bench.rs:** Added `BenchmarkId` import, fixed all `list_blocks_inner` calls for 8-arg signature (new `agenda_date` param added in Session 10), fixed 0-based position to 1-based in `seed_blocks` and `bench_create_block_with_parent`
- **hash_bench.rs:** Replaced deprecated `criterion::black_box` with `std::hint::black_box` (5 call sites)
- **draft_bench.rs:** Fixed `flush_draft` nested-runtime panic — `iter_batched` setup closure called `rt.block_on()` inside criterion's async runtime. Replaced with combined save+flush measurement (save_draft benchmarked separately for subtraction)

### Scale benchmarks added

- **commands_bench.rs:** 3 new benchmark groups (`create_block_at_scale`, `edit_block_at_scale`, `list_blocks_at_scale`) — each parameterized at 100/1K/10K existing DB blocks
- **cache_bench.rs:** Extended tags/pages/agenda rebuild from [10, 100, 1000] to include 10,000
- **pagination_bench.rs:** Extended all pagination groups from [10, 100, 1000] to include 10,000

### Verification

All 8 bench binaries compile and run cleanly:
- hash_bench, draft_bench, commands_bench, cache_bench, pagination_bench, soft_delete_bench, op_log_bench, fts_bench

**Commit:** `048178e`

---

<!-- Template:
#### [HH:MM] Subagent: <title> [BUILT|REVIEWED]
- **Tasks:** <task IDs>
- **Result:** <outcome>
- **Commit:** <hash>
-->
