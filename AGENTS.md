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

# Full Tauri app (build on each target platform — no cross-compilation)
cargo tauri dev          # Dev mode with hot reload
cargo tauri build        # Production build
# Linux → .deb + .AppImage
# Windows → .msi + .exe (NSIS)
# macOS → .dmg + .app (universal binary: --target universal-apple-darwin)

# Android (requires Android SDK + NDK 27 + emulator)
cargo tauri android init                          # First-time project setup
cargo tauri android build --target x86_64 --debug # Debug APK for emulator
cargo tauri android build --target aarch64 --debug # Debug APK for arm64 device
cargo tauri android build --release               # Release APK (all archs)
cargo tauri android dev --target x86_64           # Build + install + run on emulator
cargo tauri android dev --target aarch64          # Build + install + run on device
adb logcat -s RustStdoutStderr:V                  # View Rust logs on Android

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
- **CI:** `.github/workflows/ci.yml` — 3 jobs: `check` (lint/test on Linux), `build` (matrix: Linux + Windows + macOS), `android-build`

## Android

- **Status:** APK builds and launches. All IPC commands (read + write) confirmed working as of 2026-03-31. Block creation, editing, and persistence across restarts verified on emulator. Original write IPC failure (REVIEW-LATER.md #22) was a stale-migration issue, not a code bug.
- **Generated project:** `src-tauri/gen/android/` — created by `cargo tauri android init`, committed to repo
- **Min SDK:** 24, **Target SDK:** 36, **NDK:** 27 (set in `gen/android/app/build.gradle.kts`)
- **Emulator AVD:** `spike_test` (x86_64, API 34) — start with `emulator -avd spike_test -gpu host &`
- **DB path on Android:** `/data/data/com.blocknotes.app/notes.db` (via `app.path().app_data_dir()`)
- **Known issues:** 24 open items in REVIEW-LATER.md Tier 4 (Android) + Tier 5 (A11y/UX)
- **ProGuard:** `isMinifyEnabled = true` for release but keep rules are empty — release APK will crash (REVIEW-LATER.md #63)

### Headless Android Testing (ADB)

AI agents can build, install, run, and interact with the Android app entirely via CLI. No display needed.

```bash
# Boot emulator headless
emulator -avd spike_test -gpu swiftshader_indirect -no-window -no-audio &
adb wait-for-device
adb shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done'

# Build + install + launch
cargo tauri android build --target x86_64 --debug
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell am start -n com.blocknotes.app/.MainActivity
sleep 3  # wait for WebView + Rust init

# Observe
adb exec-out screencap -p > /tmp/screenshot.png    # screenshot (read with image tool)
adb logcat -s RustStdoutStderr:V -d                 # Rust backend logs
adb shell dumpsys activity top | head -100          # activity/view state

# Interact
adb shell input tap 512 400                         # tap at (x,y)
adb shell input text "hello"                        # type text
adb shell input swipe 500 800 500 200               # swipe/scroll
adb shell input keyevent KEYCODE_BACK               # back button
adb shell input keyevent KEYCODE_ENTER              # enter key

# Inspect app data (debug builds only)
adb shell run-as com.blocknotes.app ls files/
adb shell run-as com.blocknotes.app cat files/device-id

# WebView JS execution via Chrome DevTools Protocol
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.blocknotes.app)
curl -s http://localhost:9222/json                   # list pages

# Cleanup
adb shell am force-stop com.blocknotes.app
adb emu kill
```

**Workflow for debugging Android issues:**
1. Build + install + launch (commands above)
2. Screenshot to see current state
3. Read logcat for Rust errors or JS console errors
4. Use `adb shell input` to interact (tap, type, swipe)
5. Screenshot again to verify result
6. Forward CDP port and `curl` the `/json` endpoint for WebView inspection
7. Repeat as needed — `adb shell am force-stop` + relaunch to reset

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
