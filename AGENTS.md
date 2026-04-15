# Developer Documentation — Agaric

Local-first block-based note-taking app inspired by Org-mode and Logseq. React + TipTap frontend, Rust + SQLite backend via Tauri 2. Append-only op log with CQRS materializer for offline-first sync.

> **No changes to this file (AGENTS.md) without explicit user approval. Ever.**

## Documentation Map

| Document | Purpose |
|----------|---------|
| **AGENTS.md** (this file) | Invariants, conventions, architecture overview |
| **[BUILD.md](BUILD.md)** | Build guide: prerequisites, platforms, Android, CI, troubleshooting |
| **ARCHITECTURE.md** | Deep-dive: data model, op log, materializer, editor, sync, search (~1160 lines) |
| **[FEATURE-MAP.md](FEATURE-MAP.md)** | Complete feature inventory: schema, commands, sync, editor, stores, testing. Use for discovery and review. |
| `src-tauri/tests/AGENTS.md` | Rust test patterns, fixtures, pitfalls |
| `src/__tests__/AGENTS.md` | Frontend test patterns, mocking, a11y |
| `REVIEW-LATER.md` | Deferred items, tech debt backlog, future features |

## Build Commands

See **[BUILD.md](BUILD.md)** for the full build guide (prerequisites, platform-specific instructions, Android signing, CI pipeline, troubleshooting).

```bash
# Quick reference
cargo tauri dev              # Dev mode with hot reload
cargo tauri build            # Production build (per-platform)
npm run test                 # Vitest (~6000 tests)
cd src-tauri && cargo nextest run   # Rust tests (~1700 tests)
npx playwright test          # E2E tests (21 spec files)
cargo tauri android build --target aarch64 --debug   # Android debug APK
cargo tauri android build --target aarch64            # Android release APK (~24 MB)
prek run --all-files         # Pre-commit hooks
```

## Key Architectural Invariants

1. **Op log is strictly append-only** — never mutate, never delete (except compaction)
2. **CQRS split** — commands write ops → materializer writes derived state
3. **Cursor-based pagination** on ALL list queries — no offset pagination
4. **Single TipTap instance** — roving editor, static divs for non-focused blocks
5. **Biome only** — no ESLint, no Prettier
6. **sqlx compile-time queries** — `query!` / `query_as!` / `query_scalar!`. `.sqlx/` cache committed. Run `cargo sqlx prepare` after SQL changes.
7. **PRAGMA foreign_keys = ON** — enforced on every connection (both pools)
8. **ULID uppercase normalization** — Crockford base32 for blake3 hash determinism

## Architectural Stability

The architecture is mature and robust. **Do not introduce significant architectural changes** (new tables, new op types, new stores, new materializer queues, new sync message types) without explicit user approval. Most features should be expressible within existing abstractions:

- **Properties system is the primary extension point.** New per-block metadata (effort, assignee, repeat rules, end conditions, custom fields) should use `block_properties` + `property_definitions` — not new columns on `blocks` or new tables. The typed key-value model (text/number/date/ref) is deliberately flexible.
- **New slash commands, filter dimensions, UI components** are additive and low-risk. Prefer these over structural changes.
- **If a feature seems to require schema migration, a new op type, or a new Zustand store** — stop and discuss with the user first. There is almost always a way to achieve it within the existing model.

## Threat Model

Agaric is a **single-user, multi-device, local-first** application with **no cloud connectivity**. The threat model reflects this:

- **There is no malicious actor.** The only people with access to the app's data are the user and their own devices. Sync happens over the local network between devices the user has explicitly paired.
- **TLS + mTLS between devices** is for data integrity and device authentication (preventing accidental cross-talk), not for defending against adversaries on the network.
- **TOFU cert pinning** is a convenience to detect device re-installs or misconfigurations, not a defense against MITM attacks.
- **Do not add security hardening that assumes adversarial peers.** The sync protocol's peers are the user's own devices. DoS protection, rate limiting, path traversal guards against sync peers, and similar measures are unnecessary and add complexity without value.
- **Focus defensive effort on data integrity** — preventing accidental corruption, hash chain consistency, transaction atomicity — not on defending against attack scenarios that don't apply.

## Database

- **File:** `notes.db` in `~/.local/share/com.agaric.app/` (Linux) or app data dir (Android)
- **WAL mode**, foreign keys ON on every connection
- **Pool:** 2 writers + 4 readers (6 total)
- **Migrations:** `src-tauri/migrations/` (22 files) — auto-run on pool init
- **Schema:** 15 tables + 1 FTS5 virtual table (trigram tokenizer), 23 indexes, 2 triggers

## Frontend Architecture

- **State:** 8 Zustand stores — `useBootStore`, `useBlockStore` (focus/selection only), `useNavigationStore`, `useJournalStore`, `usePageBlocksStore` (per-page factory with context provider + registry), `useResolveStore`, `useUndoStore`, `useSyncStore`
- **Editor:** Single roving TipTap instance with 10 custom extensions (TagRef, BlockLink, BlockRef, ExternalLink, AtTagPicker, BlockLinkPicker, BlockRefPicker, PropertyPicker, CheckboxInputRule, SlashCommand)
- **Serializer:** Custom Markdown serializer (`src/editor/markdown-serializer.ts`) — zero external deps, handles `#[ULID]` and `[[ULID]]` tokens
- **Sync hooks:** `useSyncTrigger` (exponential backoff periodic sync), `useSyncEvents` (Tauri event listener), `useOnlineStatus` (navigator.onLine)
- **Error logging:** Dual-write logger (`src/lib/logger.ts`) — console + Rust IPC bridge. Stack capture, cause chain extraction (3 levels), rate limiting (5/min). Global error/rejection handlers in `main.tsx`.
- **Code style:** 2-space indent, single quotes, no semicolons, 100-char line width (Biome)

## Frontend Development Guidelines

The app has a design system. **Use it. Extend it. Never bypass it.**

Every frontend change — new component, bugfix, feature — must build on existing primitives and patterns rather than reinventing them inline. The goal is a coherent, consolidated visual language that is responsive, accessible, modern, and intuitive. If a pattern doesn't exist yet, create it as a reusable abstraction in the right layer so the next session benefits from it.

### Component hierarchy — where things live

| Layer | Location | Purpose | Examples |
|-------|----------|---------|---------|
| **Design tokens** | `src/index.css` | CSS custom properties (OKLch colors, spacing, semantic status/priority tokens), light/dark themes, `prefers-contrast` and `prefers-reduced-motion` support | `--status-done`, `--priority-urgent`, `--indent-width` |
| **UI primitives** | `src/components/ui/` | Thin wrappers around Radix UI + CVA variants. Atomic building blocks. | Button, Select, Dialog, Popover, Badge, Input, ScrollArea, Tooltip, FilterPill, StatusIcon, Spinner, Label |
| **Shared components** | `src/components/` (non-page) | Reusable composed components used across multiple views | CollapsiblePanelHeader, EmptyState, LoadingSkeleton, ConfirmDialog, LoadMoreButton, SearchablePopover, BlockGutterControls, RichContentRenderer |
| **Shared hooks** | `src/hooks/` | Reusable stateful logic | useBlockNavigation, usePaginatedQuery, useListKeyboardNavigation, useDebouncedCallback, usePropertySave, useDateInput, useQueryExecution, useBacklinkResolution |
| **Page components** | `src/components/` (top-level) | Full views composed from the layers above | JournalPage, PageBrowser, HistoryView, SearchPanel |

### Before writing any frontend code

1. **Check `src/components/ui/`** — does a primitive already exist? Button, Select, Dialog, Popover, Badge, ScrollArea, Tooltip, Calendar, Sheet, AlertDialog, Skeleton are all there.
2. **Check `src/components/`** — is there a shared component for this pattern? CollapsiblePanelHeader, EmptyState, LoadingSkeleton, ConfirmDialog, LoadMoreButton.
3. **Check `src/hooks/`** — is there a hook for this behavior? Pagination, keyboard navigation, debounce, block navigation, DnD, polling, viewport observation.
4. **Check `src/index.css`** — are there semantic tokens for the colors/spacing you need? Status colors, priority colors, conflict colors, indent widths are all defined.
5. **If nothing exists** — create the reusable abstraction first (in the right layer), then use it. Do not inline a one-off solution that the next session will duplicate.

### Mandatory patterns

- **CVA variants** for any component with visual variants. Follow the Button/Badge pattern: `cva()` base + variants + `cn()` for merging.
- **Radix UI** for all interactive overlays (Select, Dialog, Popover, Tooltip, AlertDialog). Never build custom dropdowns, modals, or tooltips from scratch.
- **`cn()` utility** (`src/lib/utils.ts`) for all className composition. Never concatenate class strings manually.
- **Semantic color tokens** from `index.css` for status, priority, conflict colors. Never hardcode Tailwind color classes (e.g., `text-red-700`) when a semantic token exists (e.g., `text-status-overdue`).
- **`ScrollArea`** from `ui/scroll-area.tsx` for any scrollable container. Never use bare `overflow-auto`.
- **Touch targets**: all interactive elements must meet 44px minimum on touch via `[@media(pointer:coarse)]`. Button already handles this — use its `size` variants.
- **Focus management**: use `focus-visible:ring-[3px] focus-visible:ring-ring/50` consistently. Button/Input already implement this — match their pattern.
- **`aria-label`** on every icon-only button. Use `t()` i18n keys, not hardcoded English strings.
- **`EmptyState`** component for all empty list/panel states. Never `return null` or show raw text for empty states.
- **`LoadingSkeleton`** for initial load states. Inline spinners only for action feedback (submit buttons, pagination).

### Anti-patterns — do not do these

- **Inline `<Loader2 className="animate-spin">`** — use the shared `Spinner` component from `ui/spinner.tsx`.
- **Ad-hoc hover/focus classes** per component — reuse the established patterns from Button/Input or define a shared utility.
- **Hardcoded color classes** (`bg-red-100`, `text-amber-600`) when semantic tokens exist.
- **Custom dropdown/select implementations** — always use `ui/select.tsx` or `ui/popover.tsx`.
- **Duplicating existing shared components** instead of importing them.
- **Skipping responsive/touch considerations** — every interactive element must work on both desktop and mobile (pointer:coarse).
- **Skipping accessibility** — `aria-label`, `role`, `aria-busy`, `aria-expanded` are not optional.
- **N+1 query patterns** — use `json_each()` batch queries on the backend instead of loops. See `fts.rs` batch resolve.
- **Silent `.catch(() => {})` blocks** — always use `logger.warn` or `logger.error`. Silent error swallowing masks real bugs.
- **Weakening strict settings** — do not add `@ts-ignore` or `biome-ignore` without a clear justification comment. Do not relax `exactOptionalPropertyTypes`, `noImplicitReturns`, or `unsafe_code = "deny"`.

### When extending the design system

If you need a new primitive, shared component, or hook:

1. Check REVIEW-LATER.md — the needed component may already be filed there with a design spec.
2. Follow the CVA + Radix + `cn()` patterns established by existing `ui/` components.
3. Place it in the correct layer (see table above).
4. Add tests: render + interaction + `axe(container)` a11y.
5. Update FEATURE-MAP.md if it adds a user-facing capability.

The measure of good frontend work is not just "does it work" but "does it make the next feature easier to build."

### Component decomposition

Components exceeding ~500 lines are candidates for extraction. The established pattern:

1. Extract hooks first (state + effects → `useXyz` in `src/hooks/`).
2. Extract presentational sub-components next (render blocks → named components).
3. Maintain backward compatibility via re-exports from the original file.
4. Every extracted unit gets its own test file with full coverage.

## Backend Architecture

- **Error handling:** `AppError` enum (11 variants) serializes to `{ kind, message }` for Tauri 2 IPC. Specta-derived TS bindings.
- **Undo/redo:** Two-tier model. In-editor: TipTap/ProseMirror history (cleared on blur). Page-level: `reverse.rs` computes inverse ops from op log. Non-reversible: `purge_block`, `delete_attachment`.
- **Materializer:** Foreground queue (256 cap, core tables + `BatchApplyOps`) + background queue (1024 cap, caches/FTS). Auto-dedup, silent drop on backpressure. Background tasks use split read/write pools — reads from reader pool, writes only for the final transaction. Foreground consumer batch-drains and parallelizes independent block_id groups via JoinSet.
- **Tag inheritance:** Materialized `block_tag_inherited` table, maintained transactionally by command handlers + background rebuild task. Replaces recursive CTEs for `include_inherited=true` queries.
- **Commands:** 74 Tauri command handlers in `commands.rs`. Each has an `inner_*` function taking `&SqlitePool` for testability.
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

- **Minimum bar:** Every exported function gets happy-path + error-path tests. Components get render + interaction + `axe(container)` a11y tests. **Every component with Tauri IPC calls must have error-path tests** — mock invoke rejection and verify graceful degradation (toast, fallback UI, no crash).
- **Test location:** `#[cfg(test)] mod tests` for Rust, `__tests__/` dirs for frontend.
- **Frameworks:** vitest-axe, fast-check (property tests), insta (Rust snapshots)
- **Benchmarks:** Criterion — manual only (`cd src-tauri && cargo bench`), never in CI. 24 bench files with 40+ benchmarks covering 62/72 non-trivial commands, parameterized at multiple scales (100/1K/10K/100K).
- **Tarpaulin:** Expensive (~60s). Only run when working on coverage gaps.
- **Silent catch blocks forbidden:** Never use `.catch(() => {})`. Use `logger.warn` or `logger.error` for all catch blocks — silent error swallowing masks real bugs.
- **Detailed conventions:** `src-tauri/tests/AGENTS.md` (Rust), `src/__tests__/AGENTS.md` (frontend)

## Tooling Efficiency

During development, run only the relevant check:
- Editing Rust? → `cd src-tauri && cargo test specific_test_name`
- Editing TS? → `npx vitest run`
- Never run clippy/fmt/biome manually — prek hooks handle it at commit time
- Frontend checks are irrelevant when only Rust changed (and vice versa)

## Code Quality Enforcement

Strict compiler and linter settings are enabled project-wide. **Do not weaken these.**

- **TypeScript:** `exactOptionalPropertyTypes: true`, `noImplicitReturns: true` — use `| undefined` for optional properties, never pass `undefined` implicitly.
- **Biome:** `noEvolvingTypes: error`, `useAwait: error`, `noUndeclaredDependencies: error`, `useExplicitLengthCheck: error` — test files have `useAwait` overridden where needed.
- **Rust:** `unsafe_code = "deny"` in `[lints.rust]`. All clippy warnings must be resolved.
- **Non-null assertions:** Banned (`noNonNullAssertion` in Biome). Use `as Type` casts or proper narrowing instead of `!`.

## Performance Conventions

Scalability analysis (session 302) established baseline performance at 100K blocks:

- **O(1) operations** (PK lookups, property gets) — ~23µs regardless of scale. No action needed.
- **Paginated lists** — cursor pagination keeps individual page loads fast even at 100K.
- **Batch operations** — use `json_each()` for batch resolve/count. Single query, not N+1.
- **Graph/agenda queries** — superlinear at 100K (see REVIEW-LATER for P-15, P-16). Frontend caching can mitigate.
- **Lazy hash computation rejected** — breaks sync protocol integrity. `verify_op_record()` in `sync_protocol.rs` requires upfront hashes.
- **CTE oracle pattern:** When optimizing a query (e.g., replacing recursive CTEs with materialized tables), preserve the old implementation as a `#[cfg(test)]` oracle function and add a test verifying both paths produce identical results.

## Android

- **Status:** Both debug and release APKs build, install, and launch successfully (2026-04-02).
- **Release APK:** 24 MB (vs 402 MB debug). ProGuard/R8 minification works — keep rules verified.
- **Generated project:** `src-tauri/gen/android/`
- **Min SDK:** 24, **Target SDK:** 36, **NDK:** 27
- **Emulator AVD:** `spike_test` (x86_64, API 34) — start with `emulator -avd spike_test -gpu host &`
- **DB path:** `/data/data/com.agaric.app/notes.db` (via `app.path().app_data_dir()`)
- **Known issues:** See REVIEW-LATER.md for open items (deferred by design).
- **Headless testing:** See [BUILD.md](BUILD.md#installing-on-emulator) for ADB recipes and emulator setup.

## Subagent Workflow

```
1. PLAN     — Pick tasks, group by domain
2. BUILD    — Launch subagent(s), with worktrees if parallel + multi-file
3. TEST     — Comprehensive tests for ALL new code
4. REVIEW   — Separate review subagent for each build (mandatory)
5. MERGE    — Copy changed files back
6. COMMIT   — git add + commit (prek verifies)
7. LOG      — Update SESSION-LOG.md
```

Every step is mandatory. No self-reviewed commits. Review subagents consistently catch real bugs — missing SQL filters (`is_conflict = 0`), incorrect CTE ordering, unused struct fields, TOCTOU race conditions, stale test assertions. Do not skip or abbreviate the review step.

## State Files

| File | Purpose | When to update |
|------|---------|---------------|
| `SESSION-LOG.md` | Subagent activity log | After each subagent completes |
| `REVIEW-LATER.md` | Deferred items, tech debt, future features | When a fix is deferred |
| `FEATURE-MAP.md` | Complete feature inventory for discovery/review | When features are added/changed (keep in sync with SESSION-LOG updates) |
| `AGENTS.md` | This file | Only with explicit user approval |

When resolving REVIEW-LATER items: remove the item entirely (table row + detail section). Record the removal in the summary log.
