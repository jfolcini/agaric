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
├── project-plan.jsx                   # Original plan (React component)
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
│   ├── App.tsx                        # Root component
│   ├── App.css / index.css            # Styles
│   ├── __tests__/smoke.test.ts        # Vitest smoke test
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
    └── src/
        ├── main.rs                    # Binary entry
        ├── lib.rs                     # Library with Tauri setup + commands
        ├── cache.rs                   # Cache rebuild functions (ADR-08, p1-t18..t21)
        ├── db.rs                      # SQLite pool init (WAL, FK pragma, migrations)
        ├── device.rs                  # Device UUID persistence (ADR-07)
        ├── draft.rs                   # Block draft writer — save/flush/delete (ADR-07)
        ├── error.rs                   # AppError enum + Serialize for Tauri 2
        ├── hash.rs                    # blake3 op hash computation (ADR-07)
        ├── materializer.rs            # Foreground + background queues (ADR-08)
        ├── op.rs                      # Op payload types + OpType enum (ADR-07)
        ├── op_log.rs                  # Op log writer — append_local_op (ADR-07)
        ├── recovery.rs                # Crash recovery at boot (ADR-07)
        └── ulid.rs                    # BlockId newtype (ULID, case-normalized)
```

## Rust Modules (src-tauri/src/)

| Module | Purpose | Key types |
|--------|---------|-----------|
| `lib.rs` | Tauri app entry, setup hook, command handlers | `run()` |
| `cache.rs` | Cache rebuild: tags, pages, agenda, block_links (ADR-08) | `rebuild_tags_cache()`, `rebuild_pages_cache()`, `rebuild_agenda_cache()`, `reindex_block_links()` |
| `db.rs` | SQLite pool with WAL + FK pragma | `init_pool()` |
| `device.rs` | Device UUID generation + file persistence | `DeviceId`, `get_or_create_device_id()` |
| `draft.rs` | Block draft save/flush/delete (ADR-07) | `Draft`, `save_draft()`, `flush_draft()`, `delete_draft()` |
| `error.rs` | Error types for commands | `AppError`, `CommandError` |
| `hash.rs` | blake3 hash for op log entries (ADR-07) | `compute_op_hash()` |
| `materializer.rs` | Foreground + background materializer queues (ADR-08) | `Materializer`, `MaterializeTask`, `dispatch_op()` |
| `op.rs` | Op payload types — 12 op types (ADR-07) | `OpType`, `OpPayload`, all payload structs |
| `op_log.rs` | Op log writer — append local ops | `OpRecord`, `append_local_op()` |
| `recovery.rs` | Crash recovery at boot (ADR-07) | `RecoveryReport`, `recover_at_boot()` |
| `ulid.rs` | ID generation and validation | `BlockId`, `AttachmentId`, `SnapshotId` |

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
cd src-tauri && cargo check    # Type check Rust
cd src-tauri && cargo test     # Run Rust tests
cd src-tauri && cargo fmt --check  # Rust formatting
cd src-tauri && cargo clippy -- -D warnings  # Lint Rust
cargo sqlx prepare             # Update .sqlx/ offline cache

# Full Tauri app
cargo tauri dev          # Dev mode with hot reload
cargo tauri build        # Production build

# Pre-commit hooks
prek run --all-files     # Run all hooks on entire repo
prek run                 # Run hooks on staged files only
prek install             # (Re)install git hooks
```

## Pre-commit Hooks (prek)

Config: `prek.toml`. Installed via `prek install`. Runs on every `git commit`.

| Hook | What it checks |
|------|---------------|
| trailing-whitespace | No trailing whitespace (auto-fixes) |
| end-of-file-fixer | Files end with newline (auto-fixes) |
| check-yaml | YAML syntax |
| check-toml | TOML syntax |
| check-json | JSON syntax (excludes tsconfig JSONC files) |
| check-merge-conflict | No conflict markers |
| check-added-large-files | No files > 500KB |
| no-commit-to-branch | Block direct push to main (pre-push stage) |
| biome-check | Biome lint + format for JS/TS/JSON |
| tsc | TypeScript type checking |
| vitest | Run frontend tests |
| cargo-fmt | Rust formatting check |
| cargo-clippy | Rust linting (warnings = errors, dead_code allowed) |
| cargo-test | Rust tests |

## CI Gates (Phase 1)

- `cargo test`
- `cargo fmt --check`
- `cargo clippy -- -D warnings`
- `biome check`
- `tsc -b --noEmit`
- `vitest run`
- `cargo sqlx prepare --check` (offline cache must not be stale)

## Key Architectural Rules

1. **Op log is strictly append-only** — never mutate, never delete (except compaction)
2. **Materializer CQRS split** — commands write ops, materializer writes derived state
3. **Cursor-based pagination on ALL list queries** — no offset pagination anywhere
4. **Single TipTap instance** — roving editor, static divs for everything else
5. **Biome from day one** — no ESLint, no Prettier
6. **sqlx compile-time queries** — all `query!` macros validated at compile time
7. **PRAGMA foreign_keys = ON** — enforced on every SQLite connection
8. **ULID case normalization** — always uppercase Crockford base32 for blake3 determinism

---

## Subagent Orchestration Workflow

This project is built using a subagent-driven workflow. Each unit of work follows this cycle:

### The Cycle

```
1. PLAN    — Identify next tasks from project-plan.md
2. LOG     — Update SESSION-LOG.md with "LAUNCHING" entry
3. BUILD   — Run subagent to implement the tasks
4. REVIEW  — Run review subagent to audit + improve the code
5. VERIFY  — Confirm builds pass (cargo check, npm lint, npm test, prek run)
6. DOCS    — Update AGENTS.md with new modules/commands/structure
7. COMMIT  — git add + commit with conventional commit message
8. LOG     — Update SESSION-LOG.md with "COMPLETED" entry + results
9. REPEAT  — Next task batch
```

### Files that track state

| File | Purpose | When to update |
|------|---------|---------------|
| `SESSION-LOG.md` | Chronological log of every subagent launch and result | Before and after every subagent |
| `REVIEW-LATER.md` | Items that need revisiting in future phases | When something is deferred or flagged |
| `AGENTS.md` | Developer docs: env, structure, commands, modules | After every subagent cycle that changes project structure |
| `project-plan.md` | Master task list with all phases and task IDs | Reference only (do not modify task definitions) |
| `ADR.md` | Architecture decisions (20 ADRs) | Reference only (source of truth for all design decisions) |

### Subagent rules

- **One subagent at a time** — sequential, not parallel (allows review between each)
- **Every build subagent gets a review subagent** — the reviewer audits against ADRs and fixes issues
- **Commit after each review cycle** — atomic commits per logical unit of work
- **prek hooks validate on commit** — all 13 hooks must pass
- **Source Rust env** — every subagent that touches Rust must run `. "$HOME/.cargo/env"` first
- **Never modify tracking files from subagents** — only the orchestrator updates SESSION-LOG.md, AGENTS.md, etc.

### Subagent prompt template

When launching a build subagent, include:
1. Working directory and Rust crate path
2. Environment notes (cargo env sourcing, tool versions)
3. Current state of relevant files (Cargo.toml, lib.rs module list, etc.)
4. Exact task IDs and descriptions from project-plan.md
5. Relevant ADR excerpts
6. What NOT to modify
7. Verification steps

When launching a review subagent, include:
1. Full content of all files the build subagent created/modified
2. ADR requirements to check against
3. Specific review checklist
4. Known issues to investigate
5. Instructions to fix directly and verify builds pass

---

## Phase 1 Progress

### Wave 1: Scaffold — DONE
- [x] p1-t1: Tauri 2.0 workspace init
- [x] p1-t2: Vite + React 18 frontend
- [x] p1-t3: Biome config

### Wave 2: Foundation — DONE
- [x] p1-t4: GitHub Actions CI
- [x] p1-t5: Device UUID
- [x] p1-t6: sqlx bootstrap (CRITICAL)
- [x] p1-t7: Initial migration (CRITICAL)
- [x] p1-t8: .sqlx offline cache
- [x] p1-t9: Error types
- [x] p1-t10: ULID utility
- [x] p1-t30: Vitest config

### Wave 3: Core logic — IN PROGRESS
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
- [ ] p1-t22: Pagination — cursor-based (CRITICAL)
- [ ] p1-t23: Soft-delete cascade

### Wave 4: Commands + Tests — PENDING
- [ ] p1-t24: Tauri command: create_block
- [ ] p1-t25: Tauri command: edit_block
- [ ] p1-t26: Tauri command: delete_block / restore_block / purge_block
- [ ] p1-t27: Tauri command: list_blocks (paginated)
- [ ] p1-t28: Boot state machine (Zustand)
- [ ] p1-t29: cargo test suite (CRITICAL)
- [ ] p1-t31: sqlx CI validation
