# Developer Documentation — Block Notes App

Local-first block-based note-taking app inspired by Org-mode and Logseq. React + TipTap frontend, Rust + SQLite backend via Tauri 2. Append-only op log with CQRS materializer for offline-first sync.

> **No changes to this file (AGENTS.md) without explicit user approval. Ever.**

## Documentation Map

| Document | Purpose |
|----------|---------|
| **AGENTS.md** (this file) | Build commands, invariants, conventions |
| **ARCHITECTURE.md** | Deep-dive: data model, op log, materializer, editor, sync, search (~1160 lines) |
| `src-tauri/tests/AGENTS.md` | Rust test patterns, fixtures, pitfalls |
| `src/__tests__/AGENTS.md` | Frontend test patterns, mocking, a11y |
| `.devin/rules/workflow.md` | Subagent workflow, worktrees, compilation costs |
| `project-plan.md` | Master task list, ADRs (19 decisions), phase tracking |
| `REVIEW-LATER.md` | Deferred items, tech debt backlog |

## Build Commands

```bash
# Frontend
npm run dev              # Vite dev server on :5173
npm run build            # Production build (tsc + vite)
npm run lint             # Biome check
npm run lint:fix         # Biome auto-fix
npm run test             # Vitest run
npm run test:coverage    # Vitest with v8 coverage
npx playwright test      # E2E tests

# Backend (source cargo env first: . "$HOME/.cargo/env")
cd src-tauri && cargo nextest run   # Rust tests
cd src-tauri && cargo fmt --check   # Formatting
cd src-tauri && cargo clippy -- -D warnings  # Lint

# Full Tauri app (build on each target platform — no cross-compilation)
cargo tauri dev          # Dev mode with hot reload
cargo tauri build        # Production build

# Android (requires Android SDK + NDK 27 + emulator)
cargo tauri android build --target x86_64 --debug   # Debug APK for emulator
cargo tauri android dev --target x86_64             # Build + install + run

# Pre-commit (this IS the verification)
prek run --all-files     # All hooks, entire repo
prek run                 # Staged files only
```

## Key Architectural Invariants

1. **Op log is strictly append-only** — never mutate, never delete (except compaction)
2. **CQRS split** — commands write ops → materializer writes derived state
3. **Cursor-based pagination** on ALL list queries — no offset pagination
4. **Single TipTap instance** — roving editor, static divs for non-focused blocks
5. **Biome only** — no ESLint, no Prettier
6. **sqlx compile-time queries** — `query!` / `query_as!` / `query_scalar!`. `.sqlx/` cache committed. Run `cargo sqlx prepare` after SQL changes.
7. **PRAGMA foreign_keys = ON** — enforced on every connection (both pools)
8. **ULID uppercase normalization** — Crockford base32 for blake3 hash determinism (ADR-07)

## Database

- **File:** `notes.db` in `~/.local/share/com.blocknotes.app/` (Linux) or app data dir (Android)
- **WAL mode**, foreign keys ON on every connection
- **Pool:** 1 writer + 4 readers (5 total)
- **Migrations:** `src-tauri/migrations/` (10 files) — auto-run on pool init
- **Schema:** 12 tables + 1 FTS5 virtual table (trigram tokenizer), 13 indexes, 2 triggers

## Frontend Architecture

- **State:** 7 Zustand stores — `useBootStore`, `useBlockStore`, `useNavigationStore`, `useJournalStore`, `useResolveStore`, `useUndoStore`, `useSyncStore`
- **Editor:** Single roving TipTap instance with 6 custom extensions (TagRef, BlockLink, ExternalLink, AtTagPicker, BlockLinkPicker, SlashCommand)
- **Serializer:** Custom Markdown serializer (`src/editor/markdown-serializer.ts`) — zero external deps, handles `#[ULID]` and `[[ULID]]` tokens
- **Sync hooks:** `useSyncTrigger` (exponential backoff periodic sync), `useSyncEvents` (Tauri event listener), `useOnlineStatus` (navigator.onLine)
- **Code style:** 2-space indent, single quotes, no semicolons, 100-char line width (Biome)

## Backend Architecture

- **Error handling:** `AppError` enum (11 variants) serializes to `{ kind, message }` for Tauri 2 IPC. Specta-derived TS bindings.
- **Undo/redo:** Two-tier model. In-editor: TipTap/ProseMirror history (cleared on blur). Page-level: `reverse.rs` computes inverse ops from op log. Non-reversible: `purge_block`, `delete_attachment`.
- **Materializer:** Foreground queue (256 cap, core tables + `BatchApplyOps`) + background queue (1024 cap, caches/FTS). Auto-dedup, silent drop on backpressure.
- **Commands:** 41 Tauri command handlers in `commands.rs` (36 core + 5 sync). Each has an `inner_*` function taking `&SqlitePool` for testability.
- **Sync daemon:** `sync_daemon.rs` — background task with mDNS discovery, TLS WebSocket server, initiator-side sync via `SyncOrchestrator`. Per-peer backoff via `SyncScheduler`.
- **Sync cert:** `sync_cert.rs` — persistent TLS certificate (generate-once-then-load pattern). `PersistedCert` managed state.

## TypeScript Bindings (specta)

`src/lib/bindings.ts` is auto-generated from Rust types. The app imports from `src/lib/tauri.ts` (hand-written wrappers with object-style APIs). `bindings.ts` is a type-safety verification layer.

The `ts_bindings_up_to_date` pre-commit test ensures sync. If Rust types change, regenerate:
```bash
cd src-tauri && cargo test -- specta_tests --ignored
```

## Pre-commit & CI

- **Pre-commit:** `prek.toml` — 15 hooks, file-type-aware (Rust hooks skip when no `.rs` staged, etc.)
- **CI:** `.github/workflows/ci.yml` — 3 jobs: `check` (lint/test on Linux), `build` (matrix: Linux + Windows + macOS), `android-build`

## Testing Conventions

- **Minimum bar:** Every exported function gets happy-path + error-path tests. Components get render + interaction + `axe(container)` a11y tests.
- **Test location:** `#[cfg(test)] mod tests` for Rust, `__tests__/` dirs for frontend.
- **Frameworks:** vitest-axe, fast-check (property tests), insta (Rust snapshots)
- **Benchmarks:** Criterion — manual only (`cd src-tauri && cargo bench`), never in CI.
- **Tarpaulin:** Expensive (~60s). Only run when working on coverage gaps.
- **Detailed conventions:** `src-tauri/tests/AGENTS.md` (Rust), `src/__tests__/AGENTS.md` (frontend)

## Tooling Efficiency

During development, run only the relevant check:
- Editing Rust? → `cd src-tauri && cargo test specific_test_name`
- Editing TS? → `npx vitest run`
- Never run clippy/fmt/biome manually — prek hooks handle it at commit time
- Frontend checks are irrelevant when only Rust changed (and vice versa)

## Android

- **Status:** APK builds and launches. All IPC confirmed working (2026-03-31).
- **Generated project:** `src-tauri/gen/android/`
- **Min SDK:** 24, **Target SDK:** 36, **NDK:** 27
- **Emulator AVD:** `spike_test` (x86_64, API 34) — start with `emulator -avd spike_test -gpu host &`
- **DB path:** `/data/data/com.blocknotes.app/notes.db` (via `app.path().app_data_dir()`)
- **Known issues:** 12 open items in REVIEW-LATER.md. ProGuard keep rules empty — release APK crashes (#63).
- **Headless testing:** See `.devin/rules/android-testing.md` for ADB recipes and debugging workflow.

## Subagent Workflow

```
1. PLAN     — Pick tasks, group by domain
2. BUILD    — Launch subagent(s), with worktrees if parallel + multi-file
3. TEST     — Comprehensive tests for ALL new code
4. REVIEW   — Separate review subagent for each build (mandatory)
5. MERGE    — Copy changed files back
6. COMMIT   — git add + commit (prek verifies)
7. LOG      — Update SESSION-LOG.md and project-plan.md
```

Every step is mandatory. No self-reviewed commits. See `.devin/rules/workflow.md` for worktree criteria, compilation costs, and prompt guidelines.

## State Files

| File | Purpose | When to update |
|------|---------|---------------|
| `SESSION-LOG.md` | Subagent activity log | After each subagent completes |
| `REVIEW-LATER.md` | Deferred items, tech debt | When a fix is deferred |
| `AGENTS.md` | This file | Only with explicit user approval |
| `project-plan.md` | Master task list + ADRs | When task status changes |

When resolving REVIEW-LATER items: remove the item entirely (table row + detail section). Record the removal in the summary log.
