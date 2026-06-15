# Developer Documentation — Agaric

Local-first block-based note-taking app inspired by Org-mode and Logseq. React 19 + TipTap frontend, Rust + SQLite backend via Tauri 2. Event sourcing with materialized views, offline-first sync.

> **No changes to this file (AGENTS.md) without explicit user approval. Ever.**

## Table of Contents

1. [Documentation Map](#documentation-map)
2. [Build Commands](#build-commands)
3. [Key Architectural Invariants](#key-architectural-invariants)
4. [Architectural Stability](#architectural-stability)
5. [Coupled Dependency Updates](#coupled-dependency-updates)
6. [Threat Model](#threat-model)
7. [Database](#database)
8. [Frontend Architecture](#frontend-architecture)
9. [Frontend Development Guidelines](#frontend-development-guidelines)
10. [Backend Architecture](#backend-architecture)
11. [TypeScript Bindings (specta)](#typescript-bindings-specta)
12. [Pre-commit & CI](#pre-commit--ci)
13. [Releases](#releases)
14. [Testing](#testing)
15. [Code Quality Enforcement](#code-quality-enforcement)
16. [Performance Conventions](#performance-conventions)
17. [Backend Patterns](#backend-patterns-commonly-caught-in-review)
18. [Android](#android)
19. [State Files](#state-files)

## Documentation Map

| Document | Purpose |
|----------|---------|
| **AGENTS.md** (this file) | Invariants, conventions, architecture overview |
| **[docs/BUILD.md](docs/BUILD.md)** | Build guide: prerequisites, platforms, Android, CI, troubleshooting |
| **docs/ARCHITECTURE.md** | Deep-dive: data model, op log, materializer, editor, sync, search |
| **[docs/FEATURE-MAP.md](docs/FEATURE-MAP.md)** | Complete feature inventory: schema, commands, sync, editor, stores, testing. Use for discovery and review. |
| [`src-tauri/tests/AGENTS.md`](src-tauri/tests/AGENTS.md) | Rust test patterns, fixtures, pitfalls |
| [`src/__tests__/AGENTS.md`](src/__tests__/AGENTS.md) | Frontend test orientation + cross-links to per-test-type splits |
| [`src/components/__tests__/AGENTS.md`](src/components/__tests__/AGENTS.md) | Component test patterns (querying, mocks, axe, React 19 timing, checklist) |
| [`src/stores/__tests__/AGENTS.md`](src/stores/__tests__/AGENTS.md) | Zustand store testing (global / per-page / undo store) |
| [`e2e/AGENTS.md`](e2e/AGENTS.md) | Playwright e2e patterns (mock backend, portal-scoped helpers, undo/redo helpers) |
| [`src-tauri/migrations/AGENTS.md`](src-tauri/migrations/AGENTS.md) | SQL migration rules (append-only, STRICT tables, index timing) |
| [`src-tauri/benches/AGENTS.md`](src-tauri/benches/AGENTS.md) | Bench pitfalls: only `interactive_slo` runs in CI, the E0308 `Pool<Sqlite>` build-race (run prebuilt binaries), fixture schema-drift checklist, cold `--test` vs warm budgets |
| [`src-tauri/src/commands/AGENTS.md`](src-tauri/src/commands/AGENTS.md) | Tauri command patterns (`_inner` split, `CommandTx`, `MAX_BATCH_BLOCK_IDS`, `LAST_APPEND`, `AppError` prefixes) |
| [`src-tauri/src/mcp/AGENTS.md`](src-tauri/src/mcp/AGENTS.md) | MCP server rules (rmcp adapter, `ACTOR.scope`, activity-feed emission, `MCP_DISCONNECT_GRACE_PERIOD`, RO/RW split) |
| [GitHub Issues](https://github.com/jfolcini/agaric/issues) | Deferred items, tech debt backlog, future features |

## Build Commands

See **[docs/BUILD.md](docs/BUILD.md)** for the full build guide (prerequisites, platform-specific instructions, Android signing, CI pipeline, troubleshooting).

```bash
# Quick reference
cargo tauri dev              # Dev mode with hot reload
cargo tauri build            # Production build (per-platform)
npm run test                 # Vitest (frontend test suite)
cd src-tauri && cargo nextest run   # Rust tests
npx playwright test          # E2E tests (see `tests/` for spec inventory)
cargo tauri android build --target aarch64 --debug   # Android debug APK
cargo tauri android build --target aarch64            # Android release APK (~24 MB)
prek run --all-files         # Pre-commit hooks
```

**Daily dev loop:** prefer `npm run dev` (browser, ~50 ms HMR) for pure UI work; reach for `cargo tauri dev` (~10-20 s per Rust edit) only when touching backend behaviour. Backend-only iteration: `bacon` in a sidecar terminal. Linux: activate the staged mold linker (`sudo apt install mold && cp .cargo/config.toml{.example,}`) to drop incremental link time ~3-4×. Full guidance in [docs/BUILD.md § Development](docs/BUILD.md#development).

## Key Architectural Invariants

1. **Op log is strictly append-only** — never mutate, never delete (except compaction)
2. **Event sourcing with materialized views** — commands append to the op log AND write the primary state atomically in a single `BEGIN IMMEDIATE` transaction (synchronous primary-state materialization); the materializer rebuilds derived materialized views (FTS, tag inheritance, page-id lookup, agenda projection, link graphs) asynchronously in the background. **Three-layer responsibility boundary** (PEND-80): the **op log is the canonical, typed, hash-chained domain history** (audit, undo, the rebuild/migration source, Loro-independent); the **Loro engine is a derived merge index**, rebuildable from op-log replay, owning merge + storage of *mergeable* data only — text content, the block tree, and typed scalar field values; **SQLite is the derived query/index view** plus the home of all derivations (tag inheritance, `page_id`, the soft-delete descendant cascade, agenda/recurrence). Enums/`property_definitions`, validation, and integrations stay in the app layer — **not** in Loro. The engine models the block hierarchy as a `LoroTree` (convergent moves + deterministic cycle rejection) and stores property values with their native type (`LoroValue::Double`/`Bool`/`String`), so engine→SQL re-projection is lossless. The engine has a **format version** (`loro::engine::ENGINE_FORMAT_VERSION`): old flat-map snapshots migrate forward to the tree on load (`migrate_flat_blocks_to_tree`, idempotent); two peers on different engine formats must not merge raw bytes (gated by the sync handshake, PEND-81)
3. **Cursor-based pagination** on ALL list queries — no offset pagination. Carve-outs: (a) named small-cardinality lookups that return a fixed-size set (`list_property_keys` — bounded in practice by user vocabulary, not data volume) may return a flat `Vec<T>` with a `limit` parameter; (b) "fetch the Nth row" operations (e.g., `undo_page_op_inner` using `LIMIT 1 OFFSET ?`) where N is upper-bounded by a small constant (≤1000) are not list queries and may use `OFFSET` — document the rationale inline at the call site.
4. **Single TipTap instance** — roving editor, static divs for non-focused blocks
5. **OXC only (oxlint + oxfmt)** — no ESLint, no Prettier, no Biome
6. **sqlx compile-time queries** — `query!` / `query_as!` / `query_scalar!`. `.sqlx/` cache committed. Run `cargo sqlx prepare` after SQL changes.
7. **PRAGMA foreign_keys = ON** — enforced on every connection (both pools)
8. **ULID uppercase normalization** — Crockford base32 for blake3 hash determinism
9. **Recursive CTEs over `blocks` must bound `depth < 100`** in the recursive member to prevent runaway recursion on corrupted `parent_id` chains. **Active-block listings carry the typed `ActiveBlockId` newtype**: the pagination leaves (`list_children`, `list_by_type`, `list_by_tag`, `list_agenda*`, `list_trash`'s active siblings), search, projected agenda, backlinks, and tag query return `PageResponse<ActiveBlockRow>`. Construct an `ActiveBlockId` from raw input via `verify_active(pool, &BlockId)` (DB-checked, `deleted_at IS NULL`), never via the `From<String>` impl, which exists only for test fixtures / in-process trusted round-trips. Surfacing soft-deleted rows lives behind the dedicated `list_trash` / `count_trash` IPCs.
10. **Pagination `limit` is loud at both ends** — backend IPCs reject out-of-range `limit` values with `AppError::Validation` (no silent `clamp(1, cap)` anywhere); frontend wrappers in `src/lib/tauri.ts` accept only the `SafeLimit` brand from `src/lib/safe-limit.ts`, so a naked numeric literal does not compile.  Caps: `list_blocks` → 100, `pagination::PageRequest::new` (the shared paginator behind `query_by_property`, `list_unfinished_tasks`, `list_tags_by_prefix`, `list_backlinks`, search, history, …) → 200, `list_projected_agenda` → 500, MCP `list_pages` / `get_page` → 100.  Callers that genuinely need "all of X" must route through one of the no-clamp dedicated IPCs (`list_all_pages_in_space`, `list_all_tags_in_space`, `count_trash`, `load_page_subtree`, `list_template_page_ids_in_space`) — these take no `limit` argument because the upper bound is intrinsic to the space.  See `docs/ARCHITECTURE.md §5 — Pagination limits` and SESSION-LOG sessions 700–703 for the BUG-48 history.

## Architectural Stability

Do not introduce significant architectural changes (new tables, new op types, new stores, new materializer queues, new sync message types) without explicit user approval. Most features should be expressible within existing abstractions:

- **Properties system is the primary extension point.** New per-block metadata (effort, assignee, repeat rules, end conditions, custom fields) should use `block_properties` + `property_definitions` — not new columns on `blocks` or new tables. The typed key-value model (text/number/date/ref) is deliberately flexible. Reserved keys that the app treats specially live in `INTERNAL_PROPERTY_KEYS` (`src/lib/block-utils.ts`) — check that set before adding a new key so it doesn't silently collide with `space`, `priority`, `due_date`, `todo_state`, etc.
- **Hot-path properties may be promoted to native columns** as a deliberate, narrow exception. A small set of properties currently live on both `block_properties` *and* as native columns on `blocks` (`todo_state`, `priority`, `due_date`, `scheduled_date`; migrations `0012_block_fixed_fields.sql` + `0013_block_scheduled_date.sql`), plus the denormalized ancestor `page_id` (migration `0027_add_page_id.sql`). They earn columns because every agenda / list-by-X / projected-agenda query on every page load would otherwise force a JOIN to `block_properties`. The property row stays the source of truth; the column is a maintained cache. Promotion is a non-trivial commitment: migration + dual-write in command handlers (`commands/blocks/crud.rs`, `commands/mod.rs`, `materializer/handlers/apply.rs`) + materializer rebuild logic + drift tests. **Default to `block_properties` only; promote with explicit user approval when the JOIN cost is measurable and the access pattern is per-page-load, not per-feature.**
- **New slash commands, filter dimensions, UI components** are additive and low-risk. Prefer these over structural changes.
- **If a feature seems to require schema migration, a new op type, or a new Zustand store** — stop and discuss with the user first. There is almost always a way to achieve it within the existing model.

## Coupled Dependency Updates

**Distinct from Architectural Stability:** This section covers *version pinning* of interdependent packages. The Architectural Stability section above covers *schema, op-types, and store changes*. Both require user approval, but for different reasons.

Some dependencies ship as a **stack** — upstream locks multiple packages to the same major/minor and breaks when one slice moves ahead of the others. **Never bump one slice of a coupled stack on its own.** Move the whole stack in one commit, and only when every required upstream piece has a release this repo can consume. If the coupled bump requires a major we are not ready for, leave the entire stack alone and file a GitHub issue (`gh issue create --label dependencies`).

**Known coupled stacks in this repo:**

- **Tauri + Android toolchain.** The AGP pin (`com.android.tools.build:gradle:8.11.0`), Gradle wrapper version (`gradle-8.14.3`), Kotlin Gradle Plugin (`1.9.25`), and the `src-tauri/gen/android/buildSrc/` scaffold are all owned by `tauri-cli` and regenerated by `cargo tauri android init`. Do **not** edit the AGP `classpath(...)` pin, do **not** run `./gradlew wrapper --gradle-version=…` against this repo, do **not** hand-patch files under `src-tauri/gen/android/buildSrc/` or `tauri.settings.gradle`. Bump via the `tauri` / `tauri-build` crate versions (and matching `@tauri-apps/cli`) and regenerate the scaffold. Gradle 9 / AGP 9 in particular is blocked on Tauri 3 (upstream PR `tauri-apps/tauri#14984`).
- **Tauri crates + CLI + JS plugins.** `tauri`, `tauri-build`, every `tauri-plugin-*` crate, `@tauri-apps/api`, `@tauri-apps/cli`, and every `@tauri-apps/plugin-*` package move together. Bump the whole set in one commit.
- **React + React-dependent ecosystem.** `react`, `react-dom`, `@types/react`, `@types/react-dom`, `@testing-library/react`, and every package that peer-depends on React (`@tiptap/react`, `@radix-ui/react-*`, `react-day-picker`, `react-i18next`, …) follow React's major. Never update one slice without the rest.
- **TipTap.** All `@tiptap/*` packages (`core`, `pm`, `react`, `suggestion`, every `extension-*`) share one version line (currently `3.22.4`). Bump atomically.
- **Radix UI.** `@radix-ui/*` primitives ship as an API-compatible set. Never mix majors across them.
- **SQLx + `.sqlx/` cache.** The `sqlx` crate version and the committed `.sqlx/` query cache must match. If `sqlx` is bumped, regenerate `.sqlx/` with `cargo sqlx prepare` in the same commit — do not land a version bump with a stale cache.
- **specta + tauri-specta.** Pinned to the exact same `=2.0.0-rc.*` in `src-tauri/Cargo.toml`. The `ts_bindings_up_to_date` pre-commit test fails if they drift. Move both in lockstep or not at all.

**Rule of thumb:** if you open `Cargo.toml` or `package.json` to bump package `X` and find yourself wondering "should I also bump `Y`?", the answer is almost always **yes** — and it is one commit, not two. Check the upstream release notes for the coupling before landing the bump. If the upstream coupling requires a major this repo cannot take yet (e.g., React 20, Tauri 3), do not bump any slice of the stack — leave it pinned and file a `MAINT-*` item describing the blocker.

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
- **Migrations:** `src-tauri/migrations/` — auto-run on pool init (append-only, never modify shipped migrations)
- **Schema:** application tables + an FTS5 virtual table (`fts_blocks`, trigram tokenizer) + internal/cache tables (`materializer_retry_queue`, `materializer_apply_cursor`, `_op_log_mutation_allowed`); indexes and triggers maintained across the migrations directory. See `src-tauri/migrations/` for the current schema set.
- **`STRICT` tables for new schema.** Every new `CREATE TABLE` in a migration must use `STRICT`. Existing tables are not retrofitted. FTS5 virtual tables (`CREATE VIRTUAL TABLE … USING fts5`) don't accept `STRICT` — they're carved out from the rule. Rationale: SQLite's silent type coercion is a known correctness footgun; `STRICT` mode (3.37+) catches it at insert time.
- **Timestamp encoding for new tables: INTEGER ms since the Unix epoch.** Issue #109 — every new timestamp column must be declared `<col>_ms INTEGER NOT NULL CHECK (<col>_ms >= 0)` and every writer must source the value from `crate::db::now_ms()` (`src-tauri/src/db/pool.rs`). Range scans on staleness windows become direct integer comparisons (`WHERE col_ms <= ?`); no `strftime` parsing, no `Z` vs `+00:00` lex-collation hazard. Precedent: `loro_doc_state.updated_at` (migration 0052) and `app_settings.updated_at` (migration 0053) already follow this shape. Legacy TEXT ISO-8601 columns (`blocks.deleted_at`, `op_log.created_at`, `materializer_retry_queue.created_at`, etc.) keep `crate::now_rfc3339()` until Phase 2 of #109 migrates each one in turn.

## Frontend Architecture

- **State:** Zustand stores — `useBootStore`, `useBlockStore` (focus/selection only), `useNavigationStore`, `useJournalStore`, `usePageBlockStore` (per-page factory via `createPageBlockStore(pageId)` + `PageBlockContext` provider), `useResolveStore`, `useUndoStore`, `useSyncStore`, `useSpaceStore` (active space + bootstrapped `Personal` / `Work`), `useTabsStore` (per-space tabs, split out from navigation in MAINT-127), `useRecentPagesStore` (per-space recent-pages MRU strip). See `src/stores/` for the current set.
- **Editor:** Single roving TipTap instance with custom extensions (TagRef, BlockLink, BlockRef, ExternalLink, AtTagPicker, BlockLinkPicker, BlockRefPicker, PropertyPicker, CheckboxInputRule, SlashCommand). See `src/editor/extensions/` for the canonical list.
- **Serializer:** Custom Markdown serializer (`src/editor/markdown-serializer.ts`) — zero external deps, handles `#[ULID]` and `[[ULID]]` tokens
- **Sync hooks:** `useSyncTrigger` (exponential backoff periodic sync), `useSyncEvents` (Tauri event listener), `useOnlineStatus` (navigator.onLine)
- **Error logging:** Dual-write logger (`src/lib/logger.ts`) — console + Rust IPC bridge. Stack capture, cause chain extraction (3 levels), rate limiting (5/min). Global error/rejection handlers in `main.tsx`.
- **Code style:** 2-space indent, single quotes, no semicolons, 100-char line width (oxfmt)

## Frontend Development Guidelines

The app has a design system. **Use it. Extend it. Never bypass it.**

Every frontend change — new component, bugfix, feature — must build on existing primitives and patterns rather than reinventing them inline. The goal is a coherent, consolidated visual language that is responsive, accessible, modern, and intuitive. If a pattern doesn't exist yet, create it as a reusable abstraction in the right layer so the next session benefits from it.

### Component hierarchy — where things live

| Layer | Location | Purpose | Examples |
|-------|----------|---------|---------|
| **Design tokens** | `src/index.css` | CSS custom properties (OKLch colors, spacing, semantic status/priority tokens), light/dark themes, `prefers-contrast` and `prefers-reduced-motion` support | `--status-done`, `--priority-urgent`, `--indent-width` |
| **UI primitives** | `src/components/ui/` | Thin wrappers around Radix UI + CVA variants. Atomic building blocks. | Button, IconButton, Select, Dialog, Popover, Badge, Input, ScrollArea, Tooltip, FilterPill, StatusIcon, Spinner, Label, FormField, MetricCard, SectionGroupHeader, FeaturePageHeader |
| **Shared components** | `src/components/` (non-page) | Reusable composed components used across multiple views | CollapsiblePanelHeader, EmptyState, LoadingSkeleton, ConfirmDialog, LoadMoreButton, SearchablePopover, BlockGutterControls, RichContentRenderer, BatchActionToolbar |
| **Shared hooks** | `src/hooks/` | Reusable stateful logic | useBlockNavigation, usePaginatedQuery, useListKeyboardNavigation, useDebouncedCallback, usePropertySave, useDateInput, useQueryExecution, useBacklinkResolution |
| **Page components** | `src/components/` (top-level) | Full views composed from the layers above | JournalPage, PageBrowser, HistoryView, SearchPanel |

### Before writing any frontend code

1. **Check `src/components/ui/`** — does a primitive already exist? Button, Select, Dialog, Popover, Badge, ScrollArea, Tooltip, Calendar, Sheet, AlertDialog, Skeleton are all there.
2. **Check `src/components/`** — is there a shared component for this pattern? CollapsiblePanelHeader, EmptyState, LoadingSkeleton, ConfirmDialog, LoadMoreButton.
3. **Check `src/hooks/`** — is there a hook for this behavior? Pagination, keyboard navigation, debounce, block navigation, DnD, polling, viewport observation.
4. **Check `src/index.css`** — are there semantic tokens for the colors/spacing you need? Status colors, priority colors, conflict colors, indent widths are all defined.
5. **If nothing exists** — create the reusable abstraction first (in the right layer), then use it. Do not inline a one-off solution that the next session will duplicate.

### Mandatory patterns

- **CVA variants** for any component with visual variants. Follow the Button/Badge pattern: `cva()` base + variants + `cn()` for merging. `Badge` is the canonical example: `tone` (`default | secondary | destructive | outline | ghost | link | priority | status`) × `size` (`xs | sm | compact | default | lg`) × `shape` (`pill | rounded`); status/priority colours flow in via `statusState` / `priorityLevel`.
- **Radix UI** for all interactive overlays (Select, Dialog, Popover, Tooltip, AlertDialog). Never build custom dropdowns, modals, or tooltips from scratch.
- **`cn()` utility** (`src/lib/utils.ts`) for all className composition. Never concatenate class strings manually.
- **Semantic color tokens** from `index.css` for status, priority, conflict colors. Never hardcode Tailwind color classes (e.g., `text-red-700`) when a semantic token exists (e.g., `text-status-overdue`).
- **`ScrollArea`** from `ui/scroll-area.tsx` for any scrollable container. Never use bare `overflow-auto`.
- **Touch targets**: all interactive elements must meet 44px minimum on touch via `[@media(pointer:coarse)]`. Button already handles this — use its `size` variants.
- **Focus management**: use `focus-visible:ring-[3px] focus-visible:ring-ring/50` consistently. Button/Input already implement this — match their pattern.
- **`aria-label`** on every icon-only button. Use `t()` i18n keys, not hardcoded English strings.
- **`EmptyState`** component for all empty list/panel states. Never `return null` or show raw text for empty states.
- **`LoadingSkeleton`** for initial load states. Inline spinners only for action feedback (submit buttons, pagination).
- **Floating UI lifecycle logging**: Any component that creates DOM outside the React tree (portals, `document.body.appendChild`, `ReactRenderer`), manages capture-phase outside-click listeners, or uses `computePosition` must:
  1. Log failures at warn level via `logger.warn`.
  2. Guard callback invocations on stale/null state and log the desync.
  3. Handle positioning `.catch()` with a logged fallback.
  4. Be listed in `EDITOR_PORTAL_SELECTORS` if it should prevent editor blur.

  See `src/editor/suggestion-renderer.ts` as the reference implementation.
- **Picker / filter debouncing hook**: searchable pickers and filter inputs debounce their IPC fan-out via `useDebouncedCallback` (`src/hooks/useDebouncedCallback.ts`) at the conventional 300 ms. The hook exposes `schedule(value)` / `cancel()`, manages its timer ref internally, and cleans up on unmount. Always `cancel()` before the non-search path (clearing input, selecting a result) and before scheduling a new value — `TagValuePicker.tsx` is the canonical clear-then-cancel-then-schedule sequence. The "Picker / filter input without debouncing" anti-pattern below documents the regression path (PERF-28).
- **Property-key filter sets — use the canonical exports, never inline**: two distinct sets must be imported rather than redeclared at call sites:
  - `INTERNAL_PROPERTY_KEYS` (`src/lib/block-utils.ts`) — properties tracked by the materializer but hidden from the per-block UI. Filter sites import this set; do not hand-roll the list inline.
  - `NON_DELETABLE_PROPERTIES` (`src/lib/property-save-utils.ts`) — broader set used for delete-guard UI; mirrors `is_builtin_property_key` in `src-tauri/src/op.rs`. Adding a builtin requires updating both the Rust source of truth and this TS mirror together.

  The two sets are deliberately distinct (the deletion-guard set is broader). Add to either at its canonical location, never at the call site.
- **Ref-as-prop (React 19)**: components that accept a ref declare `ref?: React.Ref<ElementType>` as a normal optional prop — either inherited via `React.ComponentProps<typeof X>` / `React.ComponentProps<'tag'>` (which include `ref?` automatically in React 19) or added explicitly to the props interface. Never wrap in `React.forwardRef` — it is deprecated. For imperative handles, declare `ref` as a prop and call `useImperativeHandle(ref, () => ...)` directly inside the function body (see `src/editor/SuggestionList.tsx`).

  **❌ Deprecated:**

  ```tsx
  export const MyComponent = React.forwardRef<HTMLDivElement, Props>(({ ... }, ref) => { ... })
  ```

  **✅ React 19:**

  ```tsx
  export const MyComponent = ({ ref, ... }: Props & { ref?: React.Ref<HTMLDivElement> }) => { ... }
  ```

### Anti-patterns — do not do these

- **Inline `<Loader2 className="animate-spin">`** — use the shared `Spinner` component from `ui/spinner.tsx`.
- **Ad-hoc hover/focus classes** per component — reuse the established patterns from Button/Input or define a shared utility.
- **Hardcoded color classes** (`bg-red-100`, `text-amber-600`) when semantic tokens exist.
- **Custom dropdown/select implementations** — always use `ui/select.tsx` or `ui/popover.tsx`.
- **Duplicating existing shared components** instead of importing them.
- **Skipping responsive/touch considerations** — every interactive element must work on both desktop and mobile (pointer:coarse).
- **Skipping accessibility** — `aria-label`, `role`, `aria-busy`, `aria-expanded` are not optional.
- **N+1 query patterns** — use `json_each()` batch queries on the backend instead of loops. See `fts.rs` batch resolve.
- **Numeric `limit:` literals in IPC calls** — every pagination-aware wrapper in `src/lib/tauri.ts` takes `limit?: SafeLimit | undefined`, not `number`.  Wrap with `safeLimit(n, max)` or one of the per-IPC helpers (`listBlocksLimit`, `paginationLimit`, `listProjectedAgendaLimit`), or use a named cap constant (`PAGINATION_LIMIT`, `AGENDA_QUERY_LIMIT`, `AGENDA_LIST_BLOCKS_LIMIT`).  See invariant #10.
- **Picker / filter input without debouncing** — every searchable picker or filter input must debounce its IPC fan-out with `useDebouncedCallback` at **300 ms**. `TagFilterPanel`'s `useDebouncedCallback(handleSearch, 300)` is the canonical example; `SearchPanel`, the picker plugins, and the property picker all follow it. Direct `onChange → invoke(...)` chains hit the backend on every keystroke and were the root cause of PERF-28.
- **Silent `.catch(() => {})` blocks** — always use `logger.warn` or `logger.error`. Silent error swallowing masks real bugs.
- **Weakening strict settings** — do not add `@ts-ignore` or `oxlint-disable` without a clear justification comment. Acceptable only when: (a) the rule is genuinely too strict for the context (e.g., `noExcessiveCognitiveComplexity` when splitting a component would create worse prop-drilling); (b) the comment explains the tradeoff; (c) the ignore is scoped to the minimal range (single line or function, not whole file). Do not relax `exactOptionalPropertyTypes`, `noImplicitReturns`, or `unsafe_code = "deny"`.
- **`React.forwardRef` wrappers** — deprecated in React 19. Accept `ref` as a normal prop instead (see "Ref-as-prop" in Mandatory patterns above). Likewise **never use `React.ComponentRef<typeof X>`** (deprecated) or the ambient `JSX.*` namespace (React 19 dropped the global — use `React.JSX.IntrinsicElements` / `React.ReactElement`).

### Common frontend review catches

These show up repeatedly in code review:

- **Missing `aria-label` on icon-only buttons** — every icon button must have an accessible label. Use `t()` i18n keys, not hardcoded English.
- **Hardcoded Tailwind colors** — use semantic tokens from `src/index.css` (e.g., `text-status-overdue` instead of `text-red-700`).
- **Bare `overflow-auto`** — always use `ScrollArea` from `ui/scroll-area.tsx` for consistent styling and mobile support.
- **Forgetting touch targets** — interactive elements must be ≥44px on touch devices. Use Button's `size` variants or `[@media(pointer:coarse)]:h-11` on custom elements.
- **Skipping error-path tests for Tauri IPC** — every component that calls `invoke()` must test the rejection path (mock `invoke` to throw, verify graceful degradation).
- **Silent `.catch(() => {})`** — always log via `logger.warn` / `logger.error`. Silent swallowing masks real bugs.

### When extending the design system

If you need a new primitive, shared component, or hook:

1. Check open GitHub issues — the needed component may already be filed there with a design spec.
2. Follow the CVA + Radix + `cn()` patterns established by existing `ui/` components.
3. Place it in the correct layer (see table above).
4. Add tests: render + interaction + `axe(container)` a11y.
5. Update docs/FEATURE-MAP.md if it adds a user-facing capability.

The measure of good frontend work is not just "does it work" but "does it make the next feature easier to build."

### Component decomposition

Components exceeding ~500 lines are candidates for extraction. The established pattern:

1. Extract hooks first (state + effects → `useXyz` in `src/hooks/`).
2. Extract presentational sub-components next (render blocks → named components).
3. Maintain backward compatibility via re-exports from the original file.
4. Every extracted unit gets its own test file with full coverage.

## Backend Architecture

- **Error handling:** `AppError` enum (variants include `Database`, `Migration`, `Io`, `Json`, `Ulid`, `NotFound`, `InvalidOperation`, `Channel`, `Snapshot`, `Validation`, `NonReversible`) serializes to `{ kind, message }` for Tauri 2 IPC. Specta-derived TS bindings. See `src-tauri/src/error.rs` for the current variant set.
- **Undo/redo:** Two-tier model. In-editor: TipTap/ProseMirror history (cleared on blur). Page-level: `reverse.rs` computes inverse ops from op log. Non-reversible: `purge_block`, `delete_attachment`.
- **Materializer:** Foreground queue (256 cap, core tables + `BatchApplyOps`) + background queue (1024 cap, caches/FTS). Auto-dedup, silent drop on backpressure. Background tasks use split read/write pools — reads from reader pool, writes only for the final transaction. Foreground consumer batch-drains and parallelizes independent block_id groups via JoinSet.
- **Materializer task durability.** Idempotent per-block tasks (`UpdateFtsBlock`, `ReindexBlockLinks`, `ReindexBlockTagRefs`) AND global cache rebuilds (`RebuildTagsCache`, `RebuildPagesCache`, `RebuildAgendaCache`, `RebuildProjectedAgendaCache`, `RebuildTagInheritanceCache`, `RebuildPageIds`, `RebuildBlockTagRefsCache`) are persisted to `materializer_retry_queue` on handler failure or queue saturation (PEND-03). Global tasks use the literal `'__GLOBAL__'` as `block_id` because SQLite STRICT mode forbids NULL in PK columns. The sweeper retries with exponential backoff (1m → 5m → 30m → 1h cap), so the **worst-case staleness window for caches is bounded by the 1h backoff cap** — until either (a) the next block-structure mutation re-dispatches the rebuild, or (b) the persistent retry-queue sweeper picks the dropped task up. The `bg_dropped` (total) and `bg_dropped_global` (subset attributable to global rebuilds) counters surface drop-then-persist events on `StatusInfo`. Truly non-retryable tasks (`ApplyOp`, `BatchApplyOps`, `Barrier`, `RebuildFtsIndex`, `FtsOptimize`, `CleanupOrphanedAttachments`, `RemoveFtsBlock`, `ReindexFtsReferences`) are intentionally not persisted.
- **Tag inheritance:** Materialized `block_tag_inherited` table, maintained transactionally by command handlers + background rebuild task. Replaces recursive CTEs for `include_inherited=true` queries.
- **Commands:** Tauri command handlers in `src-tauri/src/commands/` (split across files by domain: `blocks/`, `pages.rs`, `tags.rs`, `properties.rs`, `agenda.rs`, `attachments.rs`, `history.rs`, `journal.rs`, `queries.rs`, `sync_cmds.rs`, `compaction.rs`, `drafts.rs`, `link_metadata.rs`, `logging.rs`). Each command has an `inner_*` function taking `&SqlitePool` for testability.
- **Sync daemon:** `sync_daemon/` — background task with mDNS discovery, TLS WebSocket server, initiator-side sync via `SyncOrchestrator`. Per-peer backoff via `SyncScheduler`. Supports file (attachment) transfer alongside op sync.
- **Sync cert:** `sync_cert.rs` — persistent TLS certificate (generate-once-then-load pattern). `PersistedCert` managed state.

## TypeScript Bindings (specta)

`src/lib/bindings.ts` is auto-generated from Rust types. The app imports from `src/lib/tauri.ts` (hand-written wrappers with object-style APIs). `bindings.ts` is a type-safety verification layer.

The `ts_bindings_up_to_date` pre-commit test ensures sync. If Rust types change, regenerate:
```bash
cd src-tauri && cargo test -- specta_tests --ignored
```

## Pre-commit & CI

- **Pre-commit:** `prek.toml` — broad file-type-aware hook surface at pre-commit, plus pre-push hooks (`no-commit-to-branch` + the parallel `verify-ci-equivalent` umbrella below). Coverage includes builtin file checks; secret + workflow security (gitleaks, zizmor); actionlint; oxlint + oxfmt + tsc + vitest (frontend lint/format/test); cargo fmt/clippy/nextest/deny/machete (Rust); sqruff + sqlx prepare + migrations-immutable (DB); typos + shellcheck + taplo + markdownlint + lychee (cross-cutting); repo-specific guards (no-hsl-rgb-var-wrap, no-legacy-react-apis, no-ui-store-imports, tauri-mock-parity, tauri-command-sanitize, ipc-error-path-coverage, snapshot-redaction, axe-presence, test-file-naming, md-link-targets); npm audit + license-checker + depcheck + knip + audit.toml-in-sync. See `prek.toml` for the current hook list. Hook-tool config for typos / taplo / zizmor lives in `_typos.toml`, `.taplo.toml`, and `.github/zizmor.yml` respectively. The `migrations-immutable` hook enforces invariant #1 from the [invariants list](#key-architectural-invariants) at commit time.
- **Pre-push:** `verify-ci-equivalent` (`scripts/verify-ci-equivalent.sh`) runs everything `.github/workflows/_validate.yml` runs, parallelized across cores (≈3-4 min wall on a warm cache). Catches CI failures before the push reaches GitHub. `SKIP_CI_VERIFY=1 git push` escape hatch for docs-only typo fixes. Release pre-flight bundle build is opt-in via `scripts/verify-release-build.sh` (not in pre-push — too slow for daily cadence).
- **CI:** `.github/workflows/_validate.yml` — split into focused jobs after PEND-39: `lint`, `vitest` (sharded matrix), `playwright` (sharded matrix), `cargo-tests`, `validate-all` (aggregate). See `.github/workflows/_validate.yml` for the current job graph and shard counts. `ci.yml` consumes the workflow + adds the desktop build matrix (`ubuntu-24.04`, `windows-2025`, `macos-15`) and Android job. `release.yml` adds the bundle build + SLSA attest + release upload on tag pushes.

## Releases

Cut a release with one command from a clean `main`:

```bash
scripts/release.sh <new-version>        # e.g. scripts/release.sh 0.2.1
```

`scripts/release.sh` is the single canonical entry point (full guide: [`docs/BUILD.md` § Releasing](docs/BUILD.md#releasing)). It runs a preflight (clean tree, `HEAD` on `main`, local `main` in sync with origin, tag not already taken locally or on origin), then a local release-build check (`scripts/verify-release-build.sh`), then delegates to `scripts/bump-version.sh <version> --commit --tag --push`. The Release workflow (`.github/workflows/release.yml`) fires on the resulting tag push: `verify-version` (the first job — **fails fast** if the tag and the manifests disagree) → `validate` → desktop build matrix → Android APK → provenance/SBOMs → **draft** GitHub Release. The workflow **drafts** the release; a human reviews it and clicks Publish — **do not publish on the maintainer's behalf.**

**Always use the automation; never hand-edit manifests for a release.** `scripts/bump-version.sh` is the source of truth for the lockstep bump: it updates all 5 manifests (`package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`), GPG-signs the commit + annotated tag, and pushes `main` + the tag. The `package-lock.json` bump is a two-field `jq` edit (pinned-dependencies-safe; restore `npm install --package-lock-only --ignore-scripts` only if a future bump needs a dependency-graph change). It refuses to run on a dirty tree, off `main`, or over an existing tag. Use its flags to stop short of a full push (`--commit`, `--tag`, `--push` are cumulative), or `scripts/release.sh --dry-run` to bump + tag locally without pushing.

**There is no CI bump/release button, and you must not add one backed by a PAT.** A bump means pushing a commit to `main`, which needs a branch-ruleset bypass. The in-workflow `GITHUB_TOKEN` is not a bypass actor (and its pushes don't trigger workflows), so a CI bump can't land without a long-lived PAT — rejected on security grounds. The maintainer is an admin bypass actor, so the bump is cut locally. Keep branch protection as-is (1 review + admin bypass).

**Direct `git tag X.Y.Z && git push origin X.Y.Z` will reliably fail at the verify-version gate if you forgot to bump the manifests first.** `scripts/release.sh` exists to make sure that doesn't happen.

The manifest lockstep rule is non-negotiable because:
1. `verify-version` greps Cargo.lock with `awk '/^name = "agaric"$/{getline; print; exit}'` and compares to the tag.
2. SemVer drift between manifests would silently produce installers labeled with the wrong version on the artifact page.
3. The `package-lock.json` mirror of `package.json` is enforced by `npm` itself; pushing a tag without regenerating it leaves the lock at the previous version and `verify-version` fails.

If a release tag fails at `verify-version`: delete it (`git push --delete origin <tag> && git tag -d <tag>`), then re-cut with `scripts/release.sh <tag>` on a clean main.

## Testing

### Conventions

- **Minimum bar:** Every exported function gets happy-path + error-path tests. Components get render + interaction + `axe(container)` a11y tests. **Every component with Tauri IPC calls must have error-path tests** — mock invoke rejection and verify graceful degradation (toast, fallback UI, no crash).
- **Test location:** `#[cfg(test)] mod tests` for Rust, `__tests__/` dirs for frontend.
- **Frameworks:** vitest-axe, fast-check (property tests), insta (Rust snapshots)
- **Benchmarks:** Criterion — manual only (`cd src-tauri && cargo bench`), never in CI. Bench files live in `src-tauri/benches/`, parameterized at multiple scales (100/1K/10K/100K where relevant).
- **Tarpaulin:** Expensive (~60s). Only run when working on coverage gaps.
- **Exact count assertions:** Prefer `assert_eq!(count, 5)` over `assert!(count >= 1)`. Inequality assertions hide duplicate results and missing filters.
- **Silent catch blocks forbidden:** Never use `.catch(() => {})`. Use `logger.warn` or `logger.error` for all catch blocks — silent error swallowing masks real bugs.
- **React 19 test timing:** state updates originating from non-React event sources — worker `dispatchEvent`, `window.setTimeout` / `setInterval` callbacks, IPC promise resolutions chained off external events — no longer flush within a bare `await new Promise(r => setTimeout(r, 0))` tick. Wrap such waits in `act(async () => { ... })`, switch sync `getByText` to async `findByText`, or `waitFor` on the observable end state. Do not add arbitrary sleeps.
- **Detailed conventions:** `src-tauri/tests/AGENTS.md` (Rust), `src/__tests__/AGENTS.md` (frontend)

### Running tests efficiently

During development, run only the relevant check:

- Editing Rust? → `cd src-tauri && cargo nextest run -E 'test(specific_test_name)'`. Use `cargo nextest`, NOT plain `cargo test`: the engine-path integration tests (`command_integration_tests::conformance`, `::undo_integration`) share a process-global Loro registry and `clear()` it under one `TEST_SPACE_ID`, so they only isolate when nextest forks a process per test. Plain `cargo test` runs them multi-threaded in one process and they flake (#1079).
- Editing TS? → `npx vitest run`
- Never run clippy/fmt/oxlint/oxfmt manually — prek hooks handle it at commit time
- Frontend checks are irrelevant when only Rust changed (and vice versa)

### Verifying UI behavior at runtime (Playwright + mock backend)

For UI work where unit tests can't fully prove behavior — toolbar buttons, pickers, overflow, popovers, editor round-trips — **drive the real app** instead of deferring. The Playwright e2e harness runs the actual frontend against the in-memory **tauri mock backend**, no native build required:

- `playwright.config.ts` auto-starts the dev server (`webServer: npm run dev`); the mock backend auto-activates in dev (`main.tsx` → `setupMock()` when `!import.meta.env.PROD && !window.__TAURI_INTERNALS__`). No flag needed.
- Run one spec: `npx playwright test e2e/<file>.spec.ts --workers=1 --reporter=list` (~60s incl. boot; chromium is installed).
- Helpers in `e2e/helpers.ts` (`waitForBoot`, `openPage(page, 'Getting Started')`, `focusBlock`, `saveBlock`, `selectEditorRange`); seed data documented in `src/lib/tauri-mock/` and spec headers. Click controls by accessible name (`getByRole('button', { name: 'Divider' })`); assert the static render via `[data-testid="sortable-block"]` + markers (`horizontal-rule`, `callout-block`, `<ol>`, …). For visual checks, `await page.screenshot({ path })` and read the image.
- **Make the verification permanent:** land the spec in the PR. A one-off manual check rots; an e2e spec guards the behavior in CI. This workflow caught a real round-trip bug (#258) while verifying #253 — exactly the class of defect unit tests miss.

## Code Quality Enforcement

Strict compiler and linter settings are enabled project-wide. **Do not weaken these.**

- **TypeScript:** `exactOptionalPropertyTypes: true`, `noImplicitReturns: true` — use `| undefined` for optional properties, never pass `undefined` implicitly. On TypeScript 6 the deprecated `baseUrl` in `tsconfig.app.json` was removed; `paths: { "@/*": ["./src/*"] }` resolves relative to the tsconfig directory (the repo root) — keep it that way.
- **OXC (oxlint):** `typescript/require-await: error`, `unicorn/explicit-length-check: error`, `typescript/only-throw-error: error`, `import/no-default-export: error` — test files have `require-await` overridden where needed. Config lives in `.oxlintrc.json`.
- **Rust:** `unsafe_code = "deny"` in `[lints.rust]`. All clippy warnings must be resolved.
- **Non-null assertions:** Banned (`typescript/no-non-null-assertion` in oxlint). Use `as Type` casts or proper narrowing instead of `!`.

## Performance Conventions

Baseline performance at 100K blocks (established by benchmarks):

- **O(1) operations** (PK lookups, property gets) — ~23µs regardless of scale. No action needed.
- **Paginated lists** — cursor pagination keeps individual page loads fast even at 100K.
- **Batch operations** — use `json_each()` for batch resolve/count. Single query, not N+1.
- **Graph/agenda queries** — superlinear at 100K (open GitHub issues track known items). Frontend caching can mitigate.
- **Lazy hash computation rejected** — breaks sync protocol integrity. `verify_op_record()` in `sync_protocol` requires upfront hashes.
- **CTE oracle pattern:** When optimizing a query (e.g., replacing recursive CTEs with materialized tables), preserve the old implementation as a `#[cfg(test)]` oracle function and add a test verifying both paths produce identical results.
- **Split read/write pool pattern for background rebuild tasks:** read from reader pool, acquire write connection only for the final INSERT/DELETE transaction. Reduces write-connection hold time.

## Backend Patterns (commonly caught in review)

1. **Recursive CTE correctness:** every descendant walk (`list_children`, `list_page_links`, cascade ops) must follow invariant #9 (see "Key Architectural Invariants") — bound `depth < 100`. Missing bound allows runaway recursion on corrupted data.
2. **Transaction wrapping for atomic multi-op sequences:** when a feature requires multiple ops atomically (e.g., create block + set property for recurrence), use `_in_tx` variants or wrap in `BEGIN IMMEDIATE`. All-or-nothing semantics must be verified in tests.
3. **Batch via `json_each()`, not N+1:** when resolving/counting many IDs, pass a JSON array and use `json_each()` with a single query. See `backlink/query.rs` and `fts.rs` for examples.
4. **`total_count` uses post-filter count:** when a query filters after fetch (self-reference filtering in backlinks, etc.), set `total_count` from filtered length, not pre-filter length.
5. **Materializer error propagation:** `ApplyOp` / `BatchApplyOps` tasks must propagate errors for retry, not swallow with `.ok()`. Background cache rebuild errors must bubble up so retry logic can kick in.
6. **Multi-row INSERT for bulk data:** use chunked `INSERT INTO ... VALUES (?,?,...), (?,?,...)` with a `MAX_SQL_PARAMS` constant (SQLite limit ~999, chunk size depends on columns-per-row). See `apply_snapshot`.

## Search & FTS

Architectural contract for the search surface. Detail and rationale live in [`docs/architecture/search.md`](docs/architecture/search.md); the invariants below are the load-bearing rules — a contributor must follow them to avoid breaking the codebase.

1. **`SearchFilter` is the canonical extension struct for `search_blocks`.** New filter dimensions land as additional fields on `SearchFilter` in `src-tauri/src/commands/queries.rs` — never as new positional arguments on the Tauri command. Every new field MUST carry `#[serde(default)]` so older frontend bindings stay backward-compatible across the regen cycle. Mirrors the `ExtraQueryFilters` precedent in `src-tauri/src/commands/mod.rs`.
2. **`SearchBlockRow.snippet` carries literal `<mark>` boundaries from FTS5.** The boundaries are opaque marker strings, not HTML. The frontend never feeds this field to `dangerouslySetInnerHTML`. Renderers split the string on the literal marker pairs and emit alternating React text nodes and `<mark>` elements; React escapes stray `<`, `&`, or HTML-shaped content as text. No DOMPurify dep, no XSS surface. **New rendering paths consuming `snippet` must follow the same pattern.**
3. **Filter primitives — the parser is the single source of truth.** The inline filter syntax (`tag:#name`, `path:GLOB`, `state:`, `priority:`, `due:`, `prop:` …) lives at `src/lib/search-query/`. The query string is the canonical state; chips and IPC fields are derived by `parse()` + `astToFilterProjection()`. Surfaces consuming the AST MUST NOT fork the parser — register new token prefixes through `registerTokenPrefix` and declare their `ALLOWED_KEYS` statically rather than re-parsing the query string. The round-trip invariant `parse(serialize(parse(s))) === parse(s)` is enforced by `fast-check` property tests.
4. **`MatchOffset` carries UTF-16 code-unit offsets, NOT bytes.** Rust `regex` matches return byte offsets into UTF-8 buffers; JavaScript indexes UTF-16. The conversion happens in Rust before serialising (`fts::toggle_filter::byte_to_utf16_offsets`) so the frontend can slice `row.content.substring(start, end)` directly. `日`/`本`/`語` are 3 bytes / 1 UTF-16 code unit each; `🌟` is 4 bytes / 2 UTF-16 code units. Frontend renderers must NOT re-convert.

## Pages view

Architectural contract for the Pages browser. Detail and rationale live in [`docs/architecture/pages-view.md`](docs/architecture/pages-view.md); the invariants below are the load-bearing rules — a contributor must follow them to avoid breaking the codebase.

1. **PageBrowser cursor schema is v2 over the existing `Cursor` struct.** `list_pages_with_metadata` (`src-tauri/src/commands/pages/metadata.rs`) rejects mismatched / stale cursors with `AppError::Validation("RequiresRefresh: …")`; the frontend recognises the `RequiresRefresh:` prefix as a recovery signal (drop cursor, refetch page 1, optionally toast). `CURRENT_CURSOR_VERSION` itself stays at `1`; the v2 designation refers to the semantic schema layered over the existing `Cursor` slots. The new sort modes encode their primary-sort key into existing slots (`Cursor.deleted_at` for ISO timestamps / strings, `Cursor.seq` for i64 counts, `Cursor.position` for the sort-mode discriminator, `Cursor.id` as tiebreaker). **Any new paginator using a non-id sort key must reuse the existing typed slots in the same compound-overload pattern, not add a new field to the `Cursor` struct.**
2. **Density preference lives under the `page-browser-density` localStorage key.** Default `regular`. The mode is the bare string (`compact` / `regular` / `expanded`), not JSON-wrapped. Row heights are defined once in `DENSITY_ROW_HEIGHT` (`src/hooks/usePageBrowserDensity.ts`); no other component hardcodes 32/44/68. Every row carries `data-density={mode}` — that attribute is the contract integration tests assert against.
3. **`DensityRow` is Pages-specific.** Lives at `src/components/PageBrowser/DensityRow.tsx`. **Do not import it from outside `PageBrowser/`.** If a second consumer (TrashView, HistoryView, …) needs this shape, propose an extraction PR first — premature extraction couples three views to a single primitive that has to grow optional props for each one's metadata.
4. **Sort comparators must not allocate per-comparison.** Any expensive lookup (the `getRecentPages()` `Map`, the metadata accessor) is materialised once before `Array.sort`; the comparator body reads scalars off rows and returns an integer. No `.map`, no `new Date()`, no closure-over-row inside the comparator. Adding a sort mode to `usePageBrowserSort` follows this pattern.

## Filters

Cross-surface filter contract. Detail and rationale live in [`docs/architecture/filters.md`](docs/architecture/filters.md); the invariant below is the load-bearing rule.

1. **The `FilterPrimitive` / `Projection` engine governs the Pages surface; it is the *intended* (not yet realized) cross-surface contract.** A `FilterPrimitive` (`src-tauri/src/filters/primitive.rs`) is a *value*; a `Projection` impl is *how it compiles to SQL* for a surface. Per-surface behaviour lives **only** in two places: the `PAGES_ALLOWED_KEYS` / `SEARCH_ALLOWED_KEYS` static sets (which keys a surface admits) and that surface's `Projection` `compile_*` impl (how it compiles). Adding a primitive to a surface is a **deliberate diff in both** `ALLOWED_KEYS` and the `Projection` impl — never a silent two-codepath drift. Pages-only `compile_*` reads materialised `pages_cache` columns and requires the caller to `LEFT JOIN pages_cache pc ON pc.page_id = b.id`; compiled fragments are cost-ordered (`cost_hint`) and have their `?` placeholders renumbered to explicit `?N` positions before splicing. **Current reality (PEND-58d D27):** only `PagesProjection` is wired into an IPC. Search still filters through its own subsystem — the inline-query parser at `src/lib/search-query/` (see *Search & FTS* invariant 3) plus `src-tauri/src/fts/` — and `SearchProjection` is a compiled-but-unwired stub. So the "single source of truth shared with Search" guarantee is **aspirational**: do not assume a primitive added here changes Search behaviour, and do not delete the legacy Search filter path on the belief that this engine already backs it.

## Android

- **Status:** Both debug and release APKs build, install, and launch successfully.
- **Release APK:** ~24 MB (vs ~400 MB debug). ProGuard/R8 minification works — keep rules verified.
- **Generated project:** `src-tauri/gen/android/`
- **Min SDK:** 30 (Android 11, Sep 2020), **Target SDK:** 36, **NDK:** 27, **Java/Kotlin target:** 17
- **Architectures:** 64-bit only — `aarch64` (release, physical devices) and `x86_64` (emulator smoke tests). 32-bit `armv7-linux-androideabi` and `i686-linux-android` Rust targets are **not** supported; do not re-add them to docs/BUILD.md, CI, or `scripts/patch-android-build.sh`.
- **Emulator AVD:** `spike_test` (x86_64, API 34) — start with `emulator -avd spike_test -gpu host &`
- **DB path:** `/data/data/com.agaric.app/notes.db` (via `app.path().app_data_dir()`)
- **Known issues:** See open GitHub issues (deferred by design).
- **Headless testing:** See [docs/BUILD.md](docs/BUILD.md#installing-on-emulator) for ADB recipes and emulator setup.

## State Files

| File | Purpose | When to update |
|------|---------|---------------|
| `SESSION-LOG.md` | Subagent activity log | After each subagent completes |
| [GitHub Issues](https://github.com/jfolcini/agaric/issues) | Deferred items, tech debt, future features | File with `gh issue create` when a fix is deferred |
| `docs/FEATURE-MAP.md` | Complete feature inventory for discovery/review | When features are added/changed (keep in sync with SESSION-LOG updates) |
| `AGENTS.md` | This file | Only with explicit user approval |

For orchestrator workflow details, see [the `batch-issues` skill § 2. BUILD](.claude/skills/batch-issues/SKILL.md).

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
