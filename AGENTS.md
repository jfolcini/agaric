# Developer Documentation — Block Notes App

> **ABSOLUTE RULE: No changes to this file (AGENTS.md) without explicit user approval. Ever.**

## Environment

| Tool | Version | Path |
|------|---------|------|
| OS | Ubuntu 24.04.4 LTS (Noble Numbat) | — |
| Kernel | 6.17.0-19-generic | — |
| Node.js | v22.22.0 | /usr/bin/node |
| npm | 10.9.4 | /usr/bin/npm |
| Rust | 1.94.1 (stable) | ~/.cargo/bin/rustc |
| Cargo | 1.94.1 | ~/.cargo/bin/cargo |
| cargo-tauri | 2.10.1 | ~/.cargo/bin/cargo-tauri |
| sqlx-cli | 0.8.6 | ~/.cargo/bin/sqlx |
| prek | 0.3.8 | ~/.local/bin/prek |
| Git | 2.43.0 | /usr/bin/git |
| Biome | 2.4.9 | node_modules/@biomejs/biome |
| Vitest | (latest) | node_modules/.bin/vitest |
| cargo-deny | 0.19.0 | ~/.cargo/bin/cargo-deny |
| cargo-machete | 0.9.1 | ~/.cargo/bin/cargo-machete |
| cargo-tarpaulin | (latest) | ~/.cargo/bin/cargo-tarpaulin |
| cargo-nextest | 0.9.132 | ~/.cargo/bin/cargo-nextest |

### Tauri 2.0 System Dependencies (confirmed installed)

- `libwebkit2gtk-4.1-dev` 2.50.4
- `libgtk-3-dev` 3.24.41
- `libssl-dev` 3.0.13
- `librsvg2-dev` 2.58.0
- `libsoup-3.0-dev` 3.4.4
- `pkg-config` 1.8.1
- `build-essential` 12.10

## Project Structure

```
org-mode-for-the-rest-of-us/          # Root = React frontend (Vite)
├── ADR.md                             # Architecture Decision Records (20 ADRs)
├── AGENTS.md                          # This file — developer documentation
├── REVIEW-LATER.md                    # Items to revisit
├── SESSION-LOG.md                     # Subagent session tracking
├── project-plan.md                    # Plan converted to Markdown
├── prek.toml                          # Pre-commit hooks config (prek)
├── biome.json                         # Biome 2 lint/format config
├── vitest.config.ts                   # Vitest config (jsdom, v8 coverage)
├── playwright.config.ts               # Playwright E2E config
├── index.html                         # Vite entry
├── package.json                       # Node deps + scripts
├── tsconfig.json                      # TS project references
├── tsconfig.app.json                  # App TS config (strict, @ alias)
├── tsconfig.node.json                 # Node TS config
├── vite.config.ts                     # Vite config (@ alias, Tauri env)
├── .github/workflows/ci.yml           # GitHub Actions CI
├── public/                            # Static assets
├── e2e/                               # Playwright E2E tests
│   ├── smoke.spec.ts                  # Navigation, sidebar, CRUD smoke
│   └── editor-lifecycle.spec.ts       # Editor create/edit/delete flows
├── src/                               # React source
│   ├── main.tsx                       # React entry
│   ├── App.tsx                        # Root component (sidebar + router)
│   ├── App.css / index.css            # Styles
│   ├── components/                    # UI components
│   │   ├── BootGate.tsx               # Boot gate — blocks UI until ready
│   │   ├── BlockTree.tsx              # Recursive block tree renderer
│   │   ├── EditableBlock.tsx          # TipTap roving editor wrapper
│   │   ├── StaticBlock.tsx            # Static block display (non-editing)
│   │   ├── SortableBlock.tsx          # Drag-and-drop block wrapper
│   │   ├── SearchPanel.tsx            # FTS5 search UI (debounced, paginated)
│   │   ├── TagFilterPanel.tsx         # Boolean tag filter (AND/OR toggle)
│   │   ├── TagList.tsx                # Tag management panel
│   │   ├── TagPanel.tsx               # Tag detail view
│   │   ├── PageBrowser.tsx            # Page list + navigation
│   │   ├── JournalPage.tsx            # Daily journal view
│   │   ├── BacklinksPanel.tsx         # Backlink reference list
│   │   ├── HistoryPanel.tsx           # Op log history viewer
│   │   ├── ConflictList.tsx           # Merge conflict viewer
│   │   ├── TrashView.tsx              # Soft-deleted blocks view
│   │   ├── StatusPanel.tsx            # System status dashboard
│   │   ├── ui/                        # shadcn/ui primitives (badge, button, card, input, etc.)
│   │   └── __tests__/                 # Component tests (13 test files)
│   ├── editor/                        # TipTap editor integration
│   │   ├── index.ts                   # Editor factory + config
│   │   ├── markdown-serializer.ts     # Org-mode ↔ TipTap serializer
│   │   ├── use-roving-editor.ts       # Roving editor hook
│   │   ├── use-block-keyboard.ts      # Block-level keyboard shortcuts
│   │   ├── SuggestionList.tsx         # Autocomplete suggestion dropdown
│   │   ├── suggestion-renderer.ts     # Suggestion popup renderer
│   │   ├── types.ts                   # Editor type definitions
│   │   ├── extensions/                # TipTap extensions (tag-ref, block-link, pickers)
│   │   └── __tests__/                 # Editor tests (7 test files)
│   ├── hooks/                         # Custom React hooks
│   │   ├── useViewportObserver.ts     # Intersection observer for virtualization
│   │   └── use-mobile.ts             # Mobile breakpoint detection
│   ├── stores/                        # Zustand state management
│   │   ├── boot.ts                    # Boot state machine
│   │   └── blocks.ts                  # Block CRUD + tree state
│   ├── lib/                           # Shared utilities
│   │   ├── tauri.ts                   # Type-safe Tauri invoke wrappers
│   │   ├── tauri-mock.ts              # Browser IPC mock (auto-loaded outside Tauri)
│   │   ├── bindings.ts                # Auto-generated specta bindings
│   │   ├── format.ts                  # Shared formatTimestamp utility
│   │   └── utils.ts                   # Shared helpers (cn, etc.)
│   ├── __tests__/                     # Root-level tests
│   │   ├── smoke.test.ts              # Vitest smoke test
│   │   └── boot-store.test.ts         # Boot store tests
│   ├── test-setup.ts                  # Vitest global setup
│   └── vite-env.d.ts                  # Vite type declarations
└── src-tauri/                         # Rust backend (Tauri 2)
    ├── Cargo.toml                     # Rust crate config
    ├── Cargo.lock                     # Rust lockfile
    ├── tauri.conf.json                # Tauri config
    ├── build.rs                       # Tauri build script
    ├── .env                           # DATABASE_URL for sqlx-cli
    ├── .config/nextest.toml           # nextest config
    ├── .sqlx/                         # sqlx offline query cache (82 files, committed)
    ├── migrations/0001_initial.sql    # Full schema (13 tables, 7 indexes)
    ├── migrations/0002_fts5.sql       # FTS5 virtual table + triggers
    ├── capabilities/default.json      # Tauri 2 ACL permissions
    ├── icons/                         # App icons (placeholders)
    ├── gen/                           # Auto-generated (schemas, ACL)
    ├── tests/                         # Integration test binaries
    │   └── serializer_tests.rs        # Org-mode serializer integration tests (41 tests)
    ├── benches/                       # Criterion benchmarks
    │   ├── hash_bench.rs              # blake3 hash benchmarks
    │   ├── op_log_bench.rs            # Op log append benchmarks
    │   ├── cache_bench.rs             # Cache rebuild benchmarks
    │   ├── commands_bench.rs          # Command handler benchmarks
    │   ├── pagination_bench.rs        # Pagination query benchmarks
    │   ├── soft_delete_bench.rs       # Soft-delete/purge benchmarks
    │   └── fts_bench.rs              # FTS5 perf benchmark
    └── src/
        ├── main.rs                    # Binary entry
        ├── lib.rs                     # Library with Tauri setup + commands
        ├── commands.rs                # Tauri command handlers (18 commands)
        ├── command_integration_tests.rs # Command handler integration tests (test-only)
        ├── cache.rs                   # Cache rebuild functions (ADR-08, p1-t18..t21)
        ├── dag.rs                     # DAG traversal — LCA, text_at, remote ops (ADR-07, Phase 4)
        ├── db.rs                      # SQLite pool init (WAL, FK pragma, busy_timeout, migrations)
        ├── device.rs                  # Device UUID persistence (ADR-07)
        ├── draft.rs                   # Block draft writer — save/flush/delete (ADR-07)
        ├── error.rs                   # AppError enum + Serialize for Tauri 2
        ├── fts.rs                     # FTS5 full-text search backend (ADR-12)
        ├── hash.rs                    # blake3 op hash computation (ADR-07)
        ├── materializer.rs            # Foreground + background queues (ADR-08)
        ├── merge.rs                   # Three-way merge with diffy (ADR-10, Phase 4)
        ├── op.rs                      # Op payload types + OpType enum (ADR-07)
        ├── op_log.rs                  # Op log writer — append_local_op (ADR-07)
        ├── org_emitter.rs             # Org-mode inline emitter — AST to string (ADR-20)
        ├── org_parser.rs              # Org-mode inline parser — string to AST (ADR-20)
        ├── pagination.rs              # Cursor/keyset pagination (ADR critical)
        ├── recovery.rs                # Crash recovery at boot (ADR-07)
        ├── serializer.rs              # Org-mode serializer config, entity maps (ADR-20)
        ├── soft_delete.rs             # Cascade soft-delete, restore, purge (ADR-06)
        ├── snapshot.rs                # Snapshot encoding, RESET apply, compaction (ADR-07)
        ├── tag_query.rs               # Boolean tag queries with FxHashSet (ADR-08)
        ├── ulid.rs                    # BlockId newtype (ULID, case-normalized)
        ├── integration_tests.rs       # Cross-module integration tests (test-only)
        └── snapshots/                 # Insta snapshot files (22 .snap files)
```

## Rust Modules (src-tauri/src/)

| Module | Purpose | Key types |
|--------|---------|-----------|
| `lib.rs` | Tauri app entry, setup hook (pool + device + recovery + materializer) | `run()` |
| `commands.rs` | Tauri command handlers — 18 commands (CRUD, search, tags, status, snapshot, history, sync) | `create_block`, `edit_block`, `delete_block`, `restore_block`, `purge_block`, `list_blocks`, `get_block`, `search_blocks`, `query_by_tags`, `list_tags_by_prefix`, `get_status`, `create_snapshot`, `get_history`, `move_block`, `reorder_block`, `set_property`, `get_conflicts`, `resolve_conflict` |
| `command_integration_tests.rs` | Command handler integration tests (test-only) | Full command pipeline tests |
| `cache.rs` | Cache rebuild: tags, pages, agenda, block_links (ADR-08) | `rebuild_tags_cache()`, `rebuild_pages_cache()`, `rebuild_agenda_cache()`, `reindex_block_links()`, `rebuild_all_caches()` |
| `dag.rs` | DAG traversal primitives (ADR-07, Phase 4) | `insert_remote_op()`, `append_merge_op()`, `find_lca()`, `text_at()`, `get_block_edit_heads()` |
| `db.rs` | SQLite pool with WAL + FK pragma + busy_timeout(5s) | `init_pool()` |
| `device.rs` | Device UUID generation + file persistence | `DeviceId`, `get_or_create_device_id()` |
| `draft.rs` | Block draft save/flush/delete (ADR-07) | `Draft`, `save_draft()`, `flush_draft()`, `delete_draft()`, `get_draft()`, `draft_count()`, `save_draft_if_changed()` |
| `error.rs` | Error types for commands | `AppError` (Db, Io, Ulid, Serde, Blake3, Tauri, Validation, InvalidOperation, Channel, NotFound, Snapshot) |
| `fts.rs` | FTS5 full-text search (ADR-12) | `strip_for_fts()`, `update_fts_for_block()`, `rebuild_fts_index()`, `fts_optimize()`, `search_fts()` |
| `hash.rs` | blake3 hash for op log entries (ADR-07) | `compute_op_hash()`, `verify_op_hash()` |
| `materializer.rs` | Foreground + background materializer queues, FTS tasks, high-water mark monitoring (ADR-08) | `Materializer`, `MaterializeTask`, `dispatch_op()`, `dispatch_background()`, `dedup_tasks()`, `QueueMetrics`, `shutdown()` |
| `merge.rs` | Three-way merge with diffy (ADR-10) | `merge_text()`, `create_conflict_copy()`, `resolve_property_conflict()`, `merge_block()`, `MergeResult`, `MergeOutcome` |
| `op.rs` | Op payload types — 12 op types (ADR-07) | `OpType` (Display, FromStr, non_exhaustive), `OpPayload`, all payload structs |
| `op_log.rs` | Op log writer — append local ops (validates + normalizes ULIDs before hashing) | `OpRecord` (FromRow), `append_local_op()`, `append_local_op_at()`, `append_local_op_in_tx()`, `get_op_by_seq()`, `get_latest_seq()`, `get_ops_since()` |
| `org_emitter.rs` | Org-mode inline emitter — AST nodes to org-mode string (ADR-20) | `emit_inline()`, `InlineNode` rendering |
| `org_parser.rs` | Org-mode inline parser — org-mode string to AST nodes (ADR-20) | `parse_inline()`, org-mode syntax recognition |
| `pagination.rs` | Cursor/keyset pagination — all list queries | `Cursor`, `PageRequest`, `PageResponse`, `list_children()`, `list_by_type()`, `list_trash()`, `list_by_tag()`, `list_agenda()` |
| `recovery.rs` | Crash recovery at boot (ADR-07) | `RecoveryReport` (duration_ms, draft_errors), `recover_at_boot()` |
| `snapshot.rs` | Snapshot encoding, RESET apply, compaction (ADR-07) | `SnapshotData`, `encode_snapshot()`, `decode_snapshot()`, `create_snapshot()`, `apply_snapshot()`, `compact_op_log()`, `get_latest_snapshot()` |
| `soft_delete.rs` | Cascade soft-delete, restore, purge (ADR-06) | `soft_delete_block()`, `cascade_soft_delete()` (returns count), `restore_block()`, `purge_block()` (batch O(k)), `is_deleted()`, `get_descendants()` |
| `serializer.rs` | Org-mode serializer config, entity maps, round-trip pipeline (ADR-20) | `serialize_to_org()`, `parse_from_org()`, entity/special char maps |
| `tag_query.rs` | Boolean tag queries (ADR-08) | `TagExpr`, `eval_tag_query()`, `list_tags_by_prefix()`, `escape_like()` |
| `ulid.rs` | ID generation and validation | `BlockId`, `AttachmentId`, `SnapshotId` |
| `integration_tests.rs` | Cross-module pipeline tests (16 tests, test-only) | Op chains, recovery sim, cascade delete, pagination, materializer |

## Test Coverage

- **885 Rust tests** (844 lib + 41 serializer integration) + **686 Vitest frontend tests** + **18 Playwright E2E tests** = 1,589 total
- Phases 1–3 complete + Phase 4 Waves 1-2 (DAG + merge + snapshots/compaction)
- Untestable Tauri bootstrap (lib.rs::run, main.rs::main, command wrappers) excluded via `#[cfg(not(tarpaulin_include))]`

## Test Tooling Guide

### When to use which tool

| Tool | Layer | Use for | Run with |
|------|-------|---------|----------|
| **Vitest** | Frontend | Unit tests, store logic, pure functions | `npx vitest run` |
| **@testing-library/react** | Frontend | Component render + interaction tests | Via vitest (jsdom) |
| **vitest-axe** | Frontend | Accessibility audits (WCAG violations) | Via vitest — `axe(container)` in any test |
| **fast-check** | Frontend | Property-based / fuzz testing (serializer) | Via vitest — `fc.assert(fc.property(...))` |
| **insta** | Rust | Snapshot tests (JSON/YAML structure assertions) | `cargo test` — `insta::assert_yaml_snapshot!()` |
| **Criterion** | Rust | Benchmarks (perf regression detection) | `cargo bench` — never in CI or pre-commit |
| **cargo-tarpaulin** | Rust | Line coverage reporting | `cargo tarpaulin` — expensive (~60s), on-demand only |
| **Playwright** | E2E | Full user flows in browser (mock backend) | `npx playwright test` |
| **specta binding test** | Rust→TS | Verify bindings.ts matches Rust types | `cargo test specta_tests` — runs in pre-commit via cargo-test |

### Rules

- **vitest-axe tests ARE vitest tests.** No separate hook needed — the `vitest` prek hook runs them all. Every new component test should include an `axe(container)` a11y check.
- **insta snapshots ARE cargo tests.** No separate hook — the `cargo-test` prek hook runs them. Use `insta::assert_yaml_snapshot!()` for any structured data you want to guard against accidental changes.
- **fast-check tests ARE vitest tests.** Use for any serializer/parser work or when you want to fuzz input boundaries.
- **Criterion benches are never run in CI or pre-commit.** Run manually with `cd src-tauri && cargo bench` when optimizing hot paths.
- **Tarpaulin is expensive.** Only run when specifically working on coverage gaps. Never in pre-commit.
- **Specta binding test (`ts_bindings_up_to_date`)** compares a temp-generated file against the committed `src/lib/bindings.ts`. If Rust types change, this test fails → regenerate with `cd src-tauri && cargo test -- specta_tests --ignored`.

### Writing new tests

| Scenario | Tool | Example |
|----------|------|---------|
| New Rust function | `#[cfg(test)] mod tests` + `#[test]` | Happy path + error path minimum |
| New Rust struct serialization | insta `assert_yaml_snapshot!()` | Catches field renames/reorders |
| New React component | `@testing-library/react` + `vitest-axe` | Render, interact, check a11y |
| New store action | Vitest unit test | Call action, assert state |
| Serializer / parser changes | fast-check property tests | Fuzz with random inputs |
| Cross-module Rust workflow | `integration_tests.rs` | Op → materialize → query pipeline |
| E2E user flow | Playwright in `e2e/` | Navigation, CRUD, cross-view persistence |
| Performance-sensitive code | Criterion bench in `benches/` | Compare before/after |

## TypeScript Bindings (specta / tauri-specta)

`src/lib/bindings.ts` is auto-generated from Rust types via specta. It provides:
- Type definitions derived directly from Rust structs (`BlockResponse`, `BlockRow`, `PageResponse<T>`, etc.)
- Command wrappers on a `commands` object with `Result<T, E>` return types
- Event infrastructure (unused currently)

**Current setup:** The app imports from `src/lib/tauri.ts` (hand-written wrappers with ergonomic APIs — object params, default nulls). `bindings.ts` exists as a type-safety verification layer.

**Why not switch yet:** `bindings.ts` uses positional args (e.g., `listBlocks(null, null, null, null, null, null, null)`) — less readable than the object-style API in `tauri.ts`. Migration is Phase 2 work: either adopt bindings.ts directly and adjust call sites, or re-export types from bindings.ts while keeping tauri.ts wrappers.

**The `ts_bindings_up_to_date` test** ensures bindings.ts stays in sync with Rust types. If you change a command signature or response struct, the test fails at commit time. Regenerate with:
```bash
cd src-tauri && cargo test -- specta_tests --ignored
```

## Database

- **File:** `notes.db` in OS app data dir (`~/.local/share/com.blocknotes.app/`)
- **WAL mode** with `PRAGMA foreign_keys = ON` on every connection
- **Pool:** max 5 connections (1 writer + 4 readers under WAL)
- **Migrations:** `src-tauri/migrations/` — run automatically on pool init
- **Schema:** 13 tables + 1 FTS5 virtual table, 8 indexes (see `0001_initial.sql`, `0002_fts5.sql`, and ADR-05)
- **FTS5:** `fts_blocks` virtual table for full-text search (migration 0002)

## Build Commands

```bash
# Frontend
npm run dev              # Vite dev server on :5173
npm run build            # Production build -> dist/
npm run lint             # Biome check (lint + format check)
npm run lint:fix         # Biome check --write (auto-fix)
npm run format           # Biome format --write
npm run test             # Vitest run
npm run test:watch       # Vitest watch mode
npm run test:coverage    # Vitest with v8 coverage
npx playwright test     # Playwright E2E tests (18 tests)

# Backend (source cargo env first: . "$HOME/.cargo/env")
cd src-tauri && cargo nextest run  # Run Rust tests (800 tests)
cd src-tauri && cargo fmt --check  # Rust formatting
cd src-tauri && cargo clippy -- -D warnings  # Lint Rust

# Full Tauri app
cargo tauri dev          # Dev mode with hot reload
cargo tauri build        # Production build

# Pre-commit hooks (this IS the verification — see Tooling Rules below)
prek run --all-files     # Run all hooks on entire repo
prek run                 # Run hooks on staged files only
```

## Browser Preview (Chrome DevTools MCP)

The Tauri webview (WebKitGTK on Linux) does not expose a Chrome DevTools Protocol (CDP) endpoint, so the `chrome-devtools-mcp` server cannot connect to it directly. To enable visual inspection via MCP:

### How it works

1. **`src/lib/tauri-mock.ts`** — mocks all Tauri IPC commands (`create_block`, `list_blocks`, `delete_block`, etc.) with an in-memory store using `@tauri-apps/api/mocks`.
2. **`src/main.tsx`** — detects `!window.__TAURI_INTERNALS__` at startup and dynamically imports the mock before rendering.
3. **`src/vite-env.d.ts`** — declares the `Window.__TAURI_INTERNALS__` type.

### Autonomous visual development workflow

Follow these steps to visually inspect and iterate on the UI:

**Step 1 — Start Vite dev server** (if not already running):
```bash
# Run in background
npm run dev
# Verify it's listening:
ss -tlnp | grep 5173
```

**Step 2 — Use `chrome-browser` MCP server** (launches its own Chrome — no user setup needed):
```
# Verify connection
mcp_call_tool(chrome-browser, list_pages)

# Navigate to the app
mcp_call_tool(chrome-browser, navigate_page, {type: "url", url: "http://localhost:5173"})

# Take a screenshot to see the current state
mcp_call_tool(chrome-browser, take_screenshot, {filePath: "/tmp/app-screenshot.png"})
# Then read the screenshot:  read("/tmp/app-screenshot.png")

# Get the a11y tree to find element uids for interaction
mcp_call_tool(chrome-browser, take_snapshot)

# Interact: click buttons, fill inputs, etc. using uids from snapshot
mcp_call_tool(chrome-browser, click, {uid: "<uid>", includeSnapshot: true})
mcp_call_tool(chrome-browser, fill, {uid: "<uid>", value: "text", includeSnapshot: true})
```

**Step 3 — Iterate:** After editing code, Vite hot-reloads automatically. Take another screenshot to verify changes.

### MCP servers

Two `chrome-devtools-mcp` servers are configured:

| Server | Flag | Use case |
|--------|------|----------|
| `chrome-browser` | (none) | **Preferred.** Launches its own headless Chrome. Fully autonomous — no user action needed. |
| `chrome-devtools` | `--autoConnect` | Connects to user's Chrome. Requires `google-chrome --remote-debugging-port=9222`. Use only if you need the user's browser session. |

Always use **`chrome-browser`** for autonomous visual development.

### MCP tool cheatsheet

| Tool | Purpose |
|------|---------|
| `list_pages` | List open Chrome tabs — also verifies MCP connection |
| `take_screenshot` | Screenshot of page or element (by uid). Save to `/tmp/` and `read()` to view. |
| `take_snapshot` | A11y tree text snapshot — lists elements with uids for interaction |
| `navigate_page` | Navigate to URL, back, forward, reload |
| `click` | Click element by uid |
| `fill` | Type into input by uid |
| `evaluate_script` | Run JS in the page (e.g., check state, scroll) |

### Important

- The mock is **dev-only** — it is tree-shaken out of production builds (dynamic import behind a runtime check).
- Mock data is ephemeral (in-memory Map, resets on page reload).
- The mock does NOT replicate backend logic (op log, materializer, pagination cursors). It returns minimal valid responses so the UI renders.

## Pre-commit Hooks (prek)

Config: `prek.toml`. Installed via `prek install`. Runs on every `git commit`. **Hooks are file-type-aware** — Rust hooks only run when `.rs` files are staged, frontend hooks only when `.ts/.tsx` files are staged.

| Hook | What it checks | Triggers on |
|------|---------------|-------------|
| trailing-whitespace | No trailing whitespace (auto-fixes) | all files |
| end-of-file-fixer | Files end with newline (auto-fixes) | all files |
| check-yaml | YAML syntax | .yml/.yaml |
| check-toml | TOML syntax | .toml |
| check-json | JSON syntax (excludes tsconfig JSONC) | .json |
| check-merge-conflict | No conflict markers | all files |
| check-added-large-files | No files > 500KB | all files |
| no-commit-to-branch | Block direct push to main | pre-push only |
| biome-check | Biome lint + format (excludes bindings.ts) | .js/.ts/.tsx/.json |
| tsc | TypeScript type checking | .ts/.tsx |
| vitest | Run frontend tests | .ts/.tsx |
| cargo-fmt | Rust formatting check | .rs |
| cargo-clippy | Rust linting (warnings = errors) | .rs |
| cargo-test | Rust tests (nextest) | .rs |
| cargo-deny | Security advisories, licenses | Cargo.toml/lock only |
| cargo-machete | Unused dependency detection | Cargo.toml/lock only |

## CI Gates

- `cargo nextest run --profile ci` + `cargo fmt --check` + `cargo clippy -- -D warnings`
- `biome check` + `tsc -b --noEmit` + `vitest run`
- `npx playwright test`
- `cargo sqlx prepare --check` (offline cache must not be stale)

## Key Architectural Rules

1. **Op log is strictly append-only** — never mutate, never delete (except compaction)
2. **Materializer CQRS split** — commands write ops, materializer writes derived state
3. **Cursor-based pagination on ALL list queries** — no offset pagination anywhere
4. **Single TipTap instance** — roving editor, static divs for everything else
5. **Biome from day one** — no ESLint, no Prettier
6. **sqlx queries** — compile-time `query!` / `query_as!` / `query_scalar!` macros for all static SQL. `.sqlx/` offline cache committed. 11 runtime queries remain (PRAGMAs, FTS5, dynamic SQL). Run `cargo sqlx prepare` after changing any SQL query.
7. **PRAGMA foreign_keys = ON** — enforced on every SQLite connection
8. **ULID case normalization** — always uppercase Crockford base32 for blake3 determinism

---

## Tooling Efficiency Rules

These rules exist to avoid redundant work. Follow them strictly.

### prek hooks ARE the verification

**Do NOT manually run the full check suite before committing.** Just `git add` + `git commit`. prek hooks run all relevant checks automatically and are file-type-aware (Rust hooks skip if no `.rs` files staged, etc.). If hooks fail, fix and retry.

The only time to run checks manually is **during development iteration** on a specific change — and then run only the single relevant check:
- Editing Rust? → `cd src-tauri && cargo test` (or `cargo test specific_test_name` for faster feedback)
- Editing TS? → `npx vitest run`
- Never run clippy/fmt/biome manually before committing — hooks handle it

### Compilation cost awareness

Measured timings (incremental, no code changes):

| Command | Time | Notes |
|---------|------|-------|
| `cargo fmt --check` | 0.1s | No compilation |
| `cargo nextest run` | ~1.3s | 800 tests in parallel |
| `cargo clippy` | 2.0s | Separate analysis pass |
| `biome check` | 0.2s | |
| `tsc -b --noEmit` | 1.0s | |
| `vitest run` | 1.0s | |
| `cargo tarpaulin` | ~60s | Full instrumented rebuild — expensive |

Cold compile (first build in a worktree): **~15s**. This is the cost of each worktree subagent.

Rules:
- **One `cargo test` during development, hooks do the rest at commit time**
- **Use `cargo test module::tests::specific_test` during iteration**, full suite only at commit
- **Never run tarpaulin unless specifically working on coverage**
- **Skip `cargo check --benches` unless bench files changed**
- **Frontend checks are irrelevant when only Rust changed** (and vice versa) — don't run them

### Subagent verification

Build subagents should verify **only their own work compiles and tests pass**:
- `cargo test` (or just the relevant module tests)

They should NOT run clippy, fmt, biome, or the full prek suite. The orchestrator runs prek once after merging all subagent results. This avoids each subagent paying the full verification tax independently.

Review subagents that make fixes should run `cargo test` to verify their changes. Clippy/fmt issues get caught at commit time.

---

## Subagent Workflow

> **THIS WORKFLOW IS NON-NEGOTIABLE.** Every step must be followed for every task.
> No step may be skipped for convenience, time pressure, or "it's just a small change."
> Violations undermine the entire quality process. If a step seems unnecessary,
> update this document first — don't silently skip it.

### The Cycle

```
1. PLAN     — Pick tasks from project-plan.md, group by domain
2. BUILD    — Launch subagent(s), with worktrees if parallel + multi-file
3. TEST     — Comprehensive tests for ALL new code (see Testing Requirements below)
4. REVIEW   — Launch review subagent for each build subagent (MANDATORY, no exceptions)
5. MERGE    — Copy changed files back to main worktree
6. COMMIT   — git add + commit (prek hooks verify everything)
7. LOG      — Update SESSION-LOG.md AND project-plan.md with results
```

**Every step is mandatory.** In particular:
- **Step 3 (TEST):** Build subagents must write tests for their code. Review subagents must verify test coverage and add missing tests.
- **Step 4 (REVIEW):** A separate review subagent must review every build before commit. No self-reviewed commits.
- **Step 7 (LOG):** Both SESSION-LOG.md and project-plan.md must be updated after every commit. Task status must reflect reality at all times.

### Testing Requirements

**Every new module, component, function, or feature must have comprehensive tests.** This is not optional.

| Layer | What to test | Tool |
|-------|-------------|------|
| Rust unit tests | Every public function, error paths, edge cases | `cargo test` |
| Rust integration tests | Cross-module workflows, command pipelines | `integration_tests.rs` |
| Frontend unit tests | Store logic, pure functions, hooks | Vitest |
| Frontend component tests | Rendering, user interactions, state changes | Vitest + jsdom |
| Serializer tests | Round-trip identity, edge cases, escapes | Vitest |

Rules:
- **Build subagents** write tests alongside implementation. No code ships without tests.
- **Review subagents** verify test quality and add missing coverage. If a review finds untested paths, the reviewer writes the tests.
- **Minimum bar:** Every exported function has at least one happy-path test and one error-path test. Components have render + interaction tests.
- **Test files live next to source** — `__tests__/` dirs for frontend, `#[cfg(test)] mod tests` for Rust.

### Task Status

Tasks tracked in project-plan.md and SESSION-LOG.md use these statuses:

| Status | Meaning |
|--------|---------|
| `[BUILT]` | Code written by build subagent, not yet reviewed |
| `[REVIEWED]` | Reviewed and tested by a separate review subagent |

Everything in Phase 1 has been built and reviewed.

### When to use worktrees

Use worktrees when **all three** conditions are met:
1. Two or more subagents running in parallel
2. Each touches different files (no overlap)
3. Each involves 3+ file changes (enough work to justify the ~15s cold-compile cost)

**Skip worktrees** for: sequential work, single-file edits, direct orchestrator edits, review-only subagents (they can work in the main tree if nothing else is writing).

### Subagent sizing

Prefer **fewer, larger subagents** over many small ones. Each subagent pays fixed overhead (context loading, cold compile in worktree). A subagent that creates 3 related files is better than 3 subagents creating 1 file each.

Guideline: a build subagent should do **2-5 related tasks** in one domain. If a task is a 1-line change, batch it with other changes or do it directly as the orchestrator.

### Subagent prompts

Keep prompts **minimal**. Subagents can read AGENTS.md and source files themselves. Include only:
1. Working directory path
2. `. "$HOME/.cargo/env"` reminder (for Rust subagents)
3. Which files to create/modify and what to implement
4. Relevant ADR numbers (not full excerpts — say "see ADR-07 in ADR.md")
5. What NOT to modify
6. Verification: `cd src-tauri && cargo test`

For review subagents:
1. Which files to review (with paths)
2. What to check for (specific concerns, not generic checklists)
3. Verify test coverage — add missing tests for untested paths
4. Fix directly, verify with `cargo test` (Rust) or `npx vitest run` (frontend)

**Do NOT include** in prompts: full file contents (subagent can read them), full ADR text, environment table, tool versions, long checklists.

### Files that track state

| File | Purpose | When to update |
|------|---------|---------------|
| `SESSION-LOG.md` | Log of subagent activity and results | After each subagent completes (one entry per subagent) |
| `REVIEW-LATER.md` | Deferred items, tech debt, known issues | When a fix is deferred or a limitation is found |
| `AGENTS.md` | Developer docs (this file) | When project structure, modules, or workflow changes |
| `project-plan.md` | Master task list with phases and task IDs | When task status changes |
| `ADR.md` | Architecture decisions (20 ADRs) | Reference only |

### REVIEW-LATER.md Policy

Every deferred item goes in `REVIEW-LATER.md`. Entry format:

```markdown
## [date] <title>
- **Source:** <review session, task ID, or module>
- **Issue:** <what and why>
- **Priority:** low / medium / high
- **Phase:** <when to address>
- **Resolved:** no
```

When resolved: `- **Resolved:** yes — [commit hash] <note>`
