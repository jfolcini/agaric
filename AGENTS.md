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
| Git | 2.43.0 | /usr/bin/git |
| Python | 3.12.3 | /usr/bin/python3 |
| Biome | 2.4.9 | node_modules/@biomejs/biome |

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
├── biome.json                         # Biome 2 lint/format config
├── index.html                         # Vite entry
├── package.json                       # Node deps + scripts
├── tsconfig.json                      # TS project references
├── tsconfig.app.json                  # App TS config (strict, @ alias)
├── tsconfig.node.json                 # Node TS config
├── vite.config.ts                     # Vite config (@ alias, Tauri env)
├── public/                            # Static assets
├── src/                               # React source
│   ├── main.tsx                       # React entry
│   ├── App.tsx                        # Root component
│   ├── App.css / index.css            # Styles
│   └── vite-env.d.ts                  # Vite type declarations
└── src-tauri/                         # Rust backend (Tauri 2)
    ├── Cargo.toml                     # Rust crate config
    ├── Cargo.lock                     # Rust lockfile
    ├── tauri.conf.json                # Tauri config
    ├── build.rs                       # Tauri build script
    ├── capabilities/default.json      # Tauri 2 ACL permissions
    ├── icons/                         # App icons (placeholders)
    ├── gen/                           # Auto-generated (schemas, ACL)
    └── src/
        ├── main.rs                    # Binary entry
        └── lib.rs                     # Library with Tauri commands
```

## Build Commands

```bash
# Frontend
npm run dev              # Vite dev server on :5173
npm run build            # Production build → dist/
npm run lint             # Biome check (lint + format check)
npm run lint:fix         # Biome check --write (auto-fix)
npm run format           # Biome format --write
npm run format:check     # Biome format (check only)

# Backend (source cargo env first: . "$HOME/.cargo/env")
cd src-tauri && cargo check    # Type check Rust
cd src-tauri && cargo test     # Run Rust tests
cd src-tauri && cargo fmt --check  # Rust formatting
cargo sqlx prepare             # Update .sqlx/ offline cache

# Full Tauri app
cargo tauri dev          # Dev mode with hot reload
cargo tauri build        # Production build
```

## CI Gates (Phase 1)

- `cargo test`
- `cargo fmt --check`
- `biome check`
- `cargo sqlx prepare --check` (offline cache must not be stale)

## Key Architectural Rules

1. **Op log is strictly append-only** — never mutate, never delete (except compaction)
2. **Materializer CQRS split** — commands write ops, materializer writes derived state
3. **Cursor-based pagination on ALL list queries** — no offset pagination anywhere
4. **Single TipTap instance** — roving editor, static divs for everything else
5. **Biome from day one** — no ESLint, no Prettier
6. **sqlx compile-time queries** — all `query!` macros validated at compile time

## Phase 1 Task Execution Order

### Wave 1: Scaffold
- p1-t1: Tauri 2.0 workspace init
- p1-t2: Vite + React 18 frontend
- p1-t3: Biome config

### Wave 2: Foundation (parallel after scaffold)
- p1-t4: GitHub Actions CI
- p1-t5: Device UUID
- p1-t6: sqlx bootstrap (CRITICAL)
- p1-t7: Initial migration (CRITICAL)
- p1-t8: .sqlx offline cache
- p1-t9: Error types
- p1-t10: ULID utility
- p1-t30: Vitest config

### Wave 3: Core logic (parallel after foundation)
- p1-t11: Op log writer (CRITICAL)
- p1-t12: blake3 hash
- p1-t13: Op payload serde structs
- p1-t14: Block draft writer
- p1-t15: Crash recovery (CRITICAL)
- p1-t16: Foreground queue (CRITICAL)
- p1-t17: Background queue
- p1-t18–t21: Cache materializers
- p1-t22: Pagination (CRITICAL)
- p1-t23: Soft-delete cascade

### Wave 4: Commands + Tests (after core logic)
- p1-t24–t27: Tauri commands
- p1-t28: Boot state machine (Zustand)
- p1-t29: cargo test suite (CRITICAL)
- p1-t31: sqlx CI validation
