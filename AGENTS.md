# Developer Documentation — Block Notes App

Local-first block-based note-taking app inspired by Org-mode and Logseq. React + TipTap frontend, Rust + SQLite backend via Tauri 2. Append-only op log with CQRS materializer for offline-first sync.

> **No changes to this file (AGENTS.md) without explicit user approval. Ever.**

## Build Commands

```bash
# Frontend
npm run dev              # Vite dev server on :5173
npm run build            # Production build
npm run lint             # Biome check
npm run lint:fix         # Biome auto-fix
npm run test             # Vitest run
npm run test:coverage    # Vitest with v8 coverage
npx playwright test      # E2E tests

# Backend (source cargo env first: . "$HOME/.cargo/env")
cd src-tauri && cargo nextest run   # Rust tests
cd src-tauri && cargo fmt --check   # Formatting
cd src-tauri && cargo clippy -- -D warnings  # Lint

# Full Tauri app
cargo tauri dev          # Dev mode with hot reload
cargo tauri build        # Production build

# Pre-commit (this IS the verification)
prek run --all-files     # All hooks, entire repo
prek run                 # Staged files only
```

## Database

- **File:** `notes.db` in `~/.local/share/com.blocknotes.app/`
- **WAL mode**, `PRAGMA foreign_keys = ON` on every connection
- **Pool:** max 5 connections (1 writer + 4 readers)
- **Migrations:** `src-tauri/migrations/` — auto-run on pool init
- **Schema:** 13 tables + 1 FTS5 virtual table, 8 indexes

## Key Architectural Rules

1. **Op log is strictly append-only** — never mutate, never delete (except compaction)
2. **Materializer CQRS split** — commands write ops, materializer writes derived state
3. **Cursor-based pagination on ALL list queries** — no offset pagination anywhere
4. **Single TipTap instance** — roving editor, static divs for everything else
5. **Biome from day one** — no ESLint, no Prettier
6. **sqlx compile-time queries** — `query!` / `query_as!` / `query_scalar!` for static SQL. `.sqlx/` offline cache committed. Run `cargo sqlx prepare` after changing any SQL.
7. **PRAGMA foreign_keys = ON** — enforced on every connection
8. **ULID case normalization** — always uppercase Crockford base32 for blake3 determinism

## TypeScript Bindings (specta)

`src/lib/bindings.ts` is auto-generated from Rust types. The app imports from `src/lib/tauri.ts` (hand-written wrappers with object-style APIs). `bindings.ts` is a type-safety verification layer.

The `ts_bindings_up_to_date` pre-commit test ensures sync. If Rust types change, regenerate:
```bash
cd src-tauri && cargo test -- specta_tests --ignored
```

## Pre-commit & CI

- **Pre-commit:** `prek.toml` — file-type-aware hooks (Rust hooks skip when no `.rs` staged, etc.)
- **CI:** `.github/workflows/ci.yml`

## Tooling Efficiency Rules

**prek hooks ARE the verification.** Don't manually run the full suite before committing. Just `git add` + `git commit`. If hooks fail, fix and retry.

During development iteration, run only the relevant check:
- Editing Rust? → `cd src-tauri && cargo test specific_test_name`
- Editing TS? → `npx vitest run`
- Never run clippy/fmt/biome manually — hooks handle it
- Frontend checks are irrelevant when only Rust changed (and vice versa)

## Testing Conventions

- **vitest-axe, fast-check, insta snapshots** are all run by their respective test runners (vitest / cargo test). No separate hooks needed.
- **Criterion benches** — manual only (`cd src-tauri && cargo bench`), never in CI or pre-commit.
- **Tarpaulin** — expensive (~60s). Only run when working on coverage gaps.
- **Minimum bar:** Every exported function gets happy-path + error-path tests. Components get render + interaction + `axe(container)` a11y tests.
- **Test location:** `#[cfg(test)] mod tests` for Rust, `__tests__/` dirs for frontend.

Detailed conventions, patterns, and pitfalls:
- **Rust:** `src-tauri/tests/AGENTS.md`
- **Frontend:** `src/__tests__/AGENTS.md`

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

Every step is mandatory. Build subagents write tests. Review subagents verify coverage and add missing tests. No self-reviewed commits. See `.devin/rules/workflow.md` for detailed subagent guidance.

## State Files

| File | Purpose | When to update |
|------|---------|---------------|
| `SESSION-LOG.md` | Subagent activity log | After each subagent completes |
| `REVIEW-LATER.md` | Deferred items, tech debt | When a fix is deferred |
| `AGENTS.md` | This file | When project structure/workflow changes |
| `project-plan.md` | Master task list | When task status changes |
| `ADR.md` | Architecture decisions (20 ADRs) | Reference only |

### REVIEW-LATER.md Format

```markdown
## [date] <title>
- **Source:** <review session, task ID, or module>
- **Issue:** <what and why>
- **Priority:** low / medium / high
- **Phase:** <when to address>
- **Resolved:** no
```

When resolved: `- **Resolved:** yes — [commit hash] <note>`
