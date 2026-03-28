# Developer Documentation — Block Notes App

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
├── index.html                         # Vite entry
├── package.json                       # Node deps + scripts
├── tsconfig.json                      # TS project references
├── tsconfig.app.json                  # App TS config (strict, @ alias)
├── tsconfig.node.json                 # Node TS config
├── vite.config.ts                     # Vite config (@ alias, Tauri env)
├── .github/workflows/ci.yml           # GitHub Actions CI
├── public/                            # Static assets
├── src/                               # React source
│   ├── main.tsx                       # React entry
│   ├── App.tsx                        # Root component (BootGate wrapper)
│   ├── App.css / index.css            # Styles
│   ├── components/BootGate.tsx        # Boot gate — blocks UI until ready
│   ├── stores/boot.ts                 # Zustand boot state machine
│   ├── lib/tauri.ts                   # Type-safe Tauri invoke wrappers
│   ├── __tests__/smoke.test.ts        # Vitest smoke test
│   ├── __tests__/boot-store.test.ts   # Vitest boot store tests
│   └── vite-env.d.ts                  # Vite type declarations
└── src-tauri/                         # Rust backend (Tauri 2)
    ├── Cargo.toml                     # Rust crate config
    ├── Cargo.lock                     # Rust lockfile
    ├── tauri.conf.json                # Tauri config
    ├── build.rs                       # Tauri build script
    ├── .env                           # DATABASE_URL for sqlx-cli
    ├── migrations/0001_initial.sql    # Full schema (13 tables, 7 indexes)
    ├── capabilities/default.json      # Tauri 2 ACL permissions
    ├── icons/                         # App icons (placeholders)
    ├── gen/                           # Auto-generated (schemas, ACL)
    ├── benches/                       # Criterion benchmarks
    │   ├── hash_bench.rs              # blake3 hash benchmarks
    │   ├── op_log_bench.rs            # Op log append benchmarks
    │   ├── cache_bench.rs             # Cache rebuild benchmarks
    │   ├── pagination_bench.rs        # Pagination query benchmarks
    │   └── soft_delete_bench.rs       # Soft-delete/purge benchmarks
    └── src/
        ├── main.rs                    # Binary entry
        ├── lib.rs                     # Library with Tauri setup + commands
        ├── commands.rs                # Tauri command handlers (p1-t24..t27)
        ├── cache.rs                   # Cache rebuild functions (ADR-08, p1-t18..t21)
        ├── db.rs                      # SQLite pool init (WAL, FK pragma, busy_timeout, migrations)
        ├── device.rs                  # Device UUID persistence (ADR-07)
        ├── draft.rs                   # Block draft writer — save/flush/delete (ADR-07)
        ├── error.rs                   # AppError enum + Serialize for Tauri 2
        ├── hash.rs                    # blake3 op hash computation (ADR-07)
        ├── materializer.rs            # Foreground + background queues (ADR-08)
        ├── op.rs                      # Op payload types + OpType enum (ADR-07)
        ├── op_log.rs                  # Op log writer — append_local_op (ADR-07)
        ├── pagination.rs              # Cursor/keyset pagination (ADR critical)
        ├── recovery.rs                # Crash recovery at boot (ADR-07)
        ├── soft_delete.rs             # Cascade soft-delete, restore, purge (ADR-06)
        ├── ulid.rs                    # BlockId newtype (ULID, case-normalized)
        └── integration_tests.rs       # Cross-module integration tests (test-only)
```

## Rust Modules (src-tauri/src/)

| Module | Purpose | Key types |
|--------|---------|-----------|
| `lib.rs` | Tauri app entry, setup hook (pool + device + recovery + materializer) | `run()` |
| `commands.rs` | Tauri command handlers — 7 commands (p1-t24..t27) | `create_block`, `edit_block`, `delete_block`, `restore_block`, `purge_block`, `list_blocks`, `get_block` |
| `cache.rs` | Cache rebuild: tags, pages, agenda, block_links (ADR-08) | `rebuild_tags_cache()`, `rebuild_pages_cache()`, `rebuild_agenda_cache()`, `reindex_block_links()`, `rebuild_all_caches()` |
| `db.rs` | SQLite pool with WAL + FK pragma + busy_timeout(5s) | `init_pool()` |
| `device.rs` | Device UUID generation + file persistence | `DeviceId`, `get_or_create_device_id()` |
| `draft.rs` | Block draft save/flush/delete (ADR-07) | `Draft`, `save_draft()`, `flush_draft()`, `delete_draft()`, `get_draft()`, `draft_count()`, `save_draft_if_changed()` |
| `error.rs` | Error types for commands | `AppError` (Db, Io, Ulid, Serde, Blake3, Tauri, Validation, InvalidOperation, Channel, NotFound) |
| `hash.rs` | blake3 hash for op log entries (ADR-07) | `compute_op_hash()`, `verify_op_hash()` |
| `materializer.rs` | Foreground + background materializer queues (ADR-08) | `Materializer`, `MaterializeTask`, `dispatch_op()`, `dispatch_background()`, `dedup_tasks()`, `QueueMetrics`, `shutdown()` |
| `op.rs` | Op payload types — 12 op types (ADR-07) | `OpType` (Display, FromStr, non_exhaustive), `OpPayload`, all payload structs |
| `op_log.rs` | Op log writer — append local ops | `OpRecord` (FromRow), `append_local_op()`, `append_local_op_at()`, `append_local_op_in_tx()`, `get_op_by_seq()`, `get_latest_seq()`, `get_ops_since()` |
| `pagination.rs` | Cursor/keyset pagination — all list queries | `Cursor`, `PageRequest`, `PageResponse`, `list_children()`, `list_by_type()`, `list_trash()`, `list_by_tag()`, `list_agenda()` |
| `recovery.rs` | Crash recovery at boot (ADR-07) | `RecoveryReport` (duration_ms, draft_errors), `recover_at_boot()` |
| `soft_delete.rs` | Cascade soft-delete, restore, purge (ADR-06) | `soft_delete_block()`, `cascade_soft_delete()` (returns count), `restore_block()`, `purge_block()` (batch O(k)), `is_deleted()`, `get_descendants()` |
| `ulid.rs` | ID generation and validation | `BlockId`, `AttachmentId`, `SnapshotId` |
| `integration_tests.rs` | Cross-module pipeline tests (16 tests, test-only) | Op chains, recovery sim, cascade delete, pagination, materializer |

## Test Coverage

- **385 Rust tests** + **5 Vitest frontend tests** = 390 total
- **Tarpaulin coverage: 99.64%** (839/842 lines)
- Per-module coverage: cache 100%, commands 100%, db 100%, device 100%, draft 100%, hash 96%, materializer 100%, op 100%, op_log 100%, pagination 99%, recovery 100%, soft_delete 100%, ulid 100%
- Untestable Tauri bootstrap (lib.rs::run, main.rs::main, 7 command wrappers) excluded via `#[cfg(not(tarpaulin_include))]`
- Defensive error handlers in materializer + recovery + device extracted into `#[cfg(not(tarpaulin_include))]` annotated helpers
- Remaining 3 uncovered lines: tarpaulin instrumentation artifacts on non-executable structural lines (error.rs:41 impl header, hash.rs:39 block-expr open, pagination.rs:147 struct field)

## Database

- **File:** `notes.db` in OS app data dir (`~/.local/share/com.blocknotes.app/`)
- **WAL mode** with `PRAGMA foreign_keys = ON` on every connection
- **Pool:** max 5 connections (1 writer + 4 readers under WAL)
- **Migrations:** `src-tauri/migrations/` — run automatically on pool init
- **Schema:** 13 tables, 7 indexes (see `0001_initial.sql` and ADR-05)

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

# Backend (source cargo env first: . "$HOME/.cargo/env")
cd src-tauri && cargo test     # Run Rust tests (385 tests)
cd src-tauri && cargo fmt --check  # Rust formatting
cd src-tauri && cargo clippy -- -D warnings  # Lint Rust

# Full Tauri app
cargo tauri dev          # Dev mode with hot reload
cargo tauri build        # Production build

# Pre-commit hooks (this IS the verification — see Tooling Rules below)
prek run --all-files     # Run all hooks on entire repo
prek run                 # Run hooks on staged files only
```

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
| biome-check | Biome lint + format | .js/.ts/.tsx/.json |
| tsc | TypeScript type checking | .ts/.tsx |
| vitest | Run frontend tests | .ts/.tsx |
| cargo-fmt | Rust formatting check | .rs |
| cargo-clippy | Rust linting (warnings = errors) | .rs |
| cargo-test | Rust tests | .rs |
| cargo-deny | Security advisories, licenses | Cargo.toml/lock only |
| cargo-machete | Unused dependency detection | Cargo.toml/lock only |

## CI Gates

- `cargo test` + `cargo fmt --check` + `cargo clippy -- -D warnings`
- `biome check` + `tsc -b --noEmit` + `vitest run`
- `cargo sqlx prepare --check` (offline cache must not be stale)

## Key Architectural Rules

1. **Op log is strictly append-only** — never mutate, never delete (except compaction)
2. **Materializer CQRS split** — commands write ops, materializer writes derived state
3. **Cursor-based pagination on ALL list queries** — no offset pagination anywhere
4. **Single TipTap instance** — roving editor, static divs for everything else
5. **Biome from day one** — no ESLint, no Prettier
6. **sqlx queries** — runtime `query_as()` in Phase 1; migrate to compile-time `query!` macros in Phase 2 (see REVIEW-LATER.md)
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
| `cargo test` | 1.2s | 385 tests in 0.8s |
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

### The Cycle

```
1. PLAN     — Pick tasks from project-plan.md, group by domain
2. BUILD    — Launch subagent(s), with worktrees only if parallel + multi-file
3. REVIEW   — Launch review subagent for each build subagent
4. MERGE    — Copy changed files back to main worktree
5. COMMIT   — git add + commit (prek hooks verify everything)
6. LOG      — Update SESSION-LOG.md with results
```

### Task Status

Tasks tracked in project-plan.md and SESSION-LOG.md use these statuses:

| Status | Meaning |
|--------|---------|
| `[BUILT]` | Code written by build subagent, not yet reviewed |
| `[REVIEWED]` | Reviewed by a separate review subagent |

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
3. Fix directly, verify with `cargo test`

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

---

## Phase 1 Progress — COMPLETE [REVIEWED]

### Wave 1: Scaffold
- [x] p1-t1: Tauri 2.0 workspace init
- [x] p1-t2: Vite + React 18 frontend
- [x] p1-t3: Biome config

### Wave 2: Foundation
- [x] p1-t4: GitHub Actions CI
- [x] p1-t5: Device UUID
- [x] p1-t6: sqlx bootstrap (CRITICAL)
- [x] p1-t7: Initial migration (CRITICAL)
- [x] p1-t8: .sqlx offline cache
- [x] p1-t9: Error types
- [x] p1-t10: ULID utility
- [x] p1-t30: Vitest config

### Wave 3: Core logic
- [x] p1-t11: Op log writer (CRITICAL)
- [x] p1-t12: blake3 hash
- [x] p1-t13: Op payload serde structs
- [x] p1-t14: Block draft writer
- [x] p1-t15: Crash recovery (CRITICAL)
- [x] p1-t16: Foreground queue (CRITICAL)
- [x] p1-t17: Background queue
- [x] p1-t18: tags_cache materializer
- [x] p1-t19: pages_cache materializer
- [x] p1-t20: agenda_cache materializer
- [x] p1-t21: block_links index materializer
- [x] p1-t22: Pagination — cursor-based (CRITICAL)
- [x] p1-t23: Soft-delete cascade

### Wave 4: Commands + Tests
- [x] p1-t24: Tauri command: create_block
- [x] p1-t25: Tauri command: edit_block
- [x] p1-t26: Tauri command: delete_block / restore_block / purge_block
- [x] p1-t27: Tauri command: list_blocks (paginated)
- [x] p1-t28: Boot state machine (Zustand)
- [x] p1-t29: cargo test suite (CRITICAL)
- [x] p1-t31: sqlx CI validation
