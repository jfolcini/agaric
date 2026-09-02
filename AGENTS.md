# Developer Documentation — Agaric

Local-first block-based note-taking app inspired by Org-mode and Logseq. React 19 + TipTap frontend, Rust + SQLite backend via Tauri 2. Event sourcing with materialized views, offline-first sync between the user's own devices.

> Edit this file only with explicit maintainer approval.

## How we work

Read this section first. It outranks everything below it and every nested `AGENTS.md`.

- **Be pragmatic. Simplicity is a value in itself.** The smallest change that solves the actual problem wins. Boring beats clever.
- **Climb the ladder before writing.** Stop at the first rung that holds: it does not need to exist; the codebase already does it; the standard library or the platform does it; an installed dependency does it; one plain line does it; only then the minimum that works. The best code is the code never written.
- **Lazy about the solution, never about reading.** Read the code you touch and trace the real path before picking a rung. A small change you do not understand is a bug with a delay.
- **Lazy, not negligent.** Trust-boundary validation, data-loss handling, security, accessibility, and a test shown red are the floor under the ladder, not rungs on it.
- **Work and code earn their keep.** A guard, test, abstraction, rule, comment, or issue exists because it prevents a real problem someone hit. If it does not, do not add it; if it already exists, delete it.
- **Do not engineer for speculative situations.** "Could happen" is not a defect. Fix what broke, not what might. Threat model: one user, their own devices, no adversaries (see [Threat Model](#threat-model)).
- **No gold-plating.** No scope creep, no refactor-because-we-were-here, no second guard for the first guard, no observability for the observability, no helper for a one-off, no option nobody asked for.
- **Reviews judge impact.** A finding needs a concrete failure and a named victim. Otherwise fix it if trivial, or let it go. Filing an issue is the last resort, not the default. Over-building is a finding too: a helper, option, abstraction, or paragraph the fix did not need is deleted, not defended.
- **Say it once.** A rule and its one reason, in the same breath. No war stories, no archaeology. An issue number is a pointer, not a justification.
- **Names do the explaining.** A comment says why, never what; when the what needs a comment, rename.
- **Prefer deleting.** Removing a hook, a fallback, a config knob, or a paragraph needs no more justification than this section.

## Documentation Map

| Document | Purpose |
|----------|---------|
| **AGENTS.md** (this file) | Principles, invariants, conventions |
| [docs/BUILD.md](docs/BUILD.md) | Build guide: prerequisites, platforms, Android, CI, troubleshooting |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Deep-dive index: data model, op log, materializer, editor, sync, search |
| [docs/FEATURE-MAP.md](docs/FEATURE-MAP.md) | Feature inventory: schema, commands, sync, editor, stores, testing |
| [`src-tauri/tests/AGENTS.md`](src-tauri/tests/AGENTS.md) | Rust test fixtures and pitfalls |
| [`src/__tests__/AGENTS.md`](src/__tests__/AGENTS.md) | Frontend test conventions, with per-type splits in [`src/components/__tests__/AGENTS.md`](src/components/__tests__/AGENTS.md) and [`src/stores/__tests__/AGENTS.md`](src/stores/__tests__/AGENTS.md) |
| [`e2e/AGENTS.md`](e2e/AGENTS.md) | Playwright e2e against the mock backend |
| [`src-tauri/migrations/AGENTS.md`](src-tauri/migrations/AGENTS.md) | SQL migration rules |
| [`src-tauri/benches/AGENTS.md`](src-tauri/benches/AGENTS.md) | Criterion benches and the weekly lanes |
| [`src-tauri/src/commands/AGENTS.md`](src-tauri/src/commands/AGENTS.md) | Tauri command patterns |
| [`src-tauri/src/mcp/AGENTS.md`](src-tauri/src/mcp/AGENTS.md) | MCP server rules |
| [GitHub Issues](https://github.com/jfolcini/agaric/issues) | Backlog |

## Build Commands

Full guide: [docs/BUILD.md](docs/BUILD.md). Prefer the `just` recipes (`just --list`); each one shells out to the canonical command below.

```bash
bash scripts/setup.sh                            # one-command dev-env setup (= npm run setup = just setup)
npm run dev                                      # browser + tauri mock, ~50 ms HMR — pure UI work
cargo tauri dev                                  # desktop app with hot reload — backend work
npm run test                                     # vitest
npm run typecheck                                # tsc -b across all four tsconfig projects
cd src-tauri && cargo nextest run --workspace    # Rust tests
npx playwright test                              # e2e (see e2e/)
cargo tauri android build --target aarch64 --debug
prek run --all-files                             # every pre-commit hook
scripts/push.sh                                  # push after a Rust change (runs the pre-push verify first)
```

Four commands have a wrong-but-plausible form. Use the right one:

- **`npm run typecheck`, never `npx tsc --noEmit`.** The root tsconfig is solution-style, and `--noEmit` without `-b` checks an empty program and exits 0 (#3805).
- **`cargo nextest run --workspace`, never the bare form.** Bare `cargo nextest run` is scoped to the `agaric` package and silently skips `agaric-store`, `agaric-engine`, `agaric-sync`, `agaric-core` (#3212). Same for `cargo mutants --workspace`.
- **`just gen-sqlx`, never `cargo sqlx prepare`.** Four `.sqlx/` caches must move together (invariant 6).
- **`scripts/push.sh` for anything touching `.rs`, not raw `git push`.** Raw push holds the connection open through the multi-minute pre-push verify and GitHub drops it. `SKIP_CI_VERIFY='<real reason>' git push` skips the verify when it would only repeat what CI runs on the PR (docs, CI or tooling-only ranges, a re-push after a review nit, a range already run through the full suite); CI is the merge gate.

Setup auto-runs on Claude Code on the web via [`.claude/hooks/session-start.sh`](.claude/hooks/session-start.sh).

## Key Architectural Invariants

1. **The op log is append-only.** Never mutate or delete, except compaction.
2. **Event sourcing with materialized views.** Commands append to the op log and write primary state atomically in one `BEGIN IMMEDIATE` transaction; the materializer rebuilds derived views (FTS, tag inheritance, page ids, agenda, link graphs) in the background. Three layers: the op log is the typed, hash-chained history (local ops drive state; foreign devices' ops are stored as audit records with `is_replicated = 1` and never applied); the Loro engine (`loro_doc_state`) is the convergent merge truth for text, the block tree, and typed scalar properties, and disaster recovery reprojects from it (`db/recovery.rs`); SQLite is the derived query view and the home of all derivations. Enums, validation, and integrations live in the app layer, not Loro. The engine has a format version (`loro::engine::ENGINE_FORMAT_VERSION`); mismatched peers are rejected at the sync handshake.
3. **Cursor pagination on every list query.** No offset pagination. Exceptions: small fixed-size lookups may return a flat `Vec` with a `limit`; "fetch the Nth row" with a small constant bound may use `OFFSET`, with the reason at the call site.
4. **One roving TipTap instance per mounted `BlockTree`.** The editor roves to the focused block; every other block renders static. Focus is global, so only one block hosts `<EditorContent>` at a time, but the journal week and stream views mount one tree per day. App-level editor access goes through the focus-published registry `src/editor/active-editor.ts`, never a module-level slot.
5. **OXC only** (oxlint + oxfmt). No ESLint, Prettier, or Biome.
6. **sqlx compile-time queries** (`query!` and friends). After any SQL change run `just gen-sqlx` and commit all four `.sqlx/` caches (root, `agaric-store`, `agaric-engine`, `agaric-sync`) in the same commit. Each has its own CI lane.
7. **`PRAGMA foreign_keys = ON`** on every connection.
8. **ULIDs are uppercase** (Crockford base32), for hash determinism.
9. **Recursive CTEs over `blocks` bound `depth < 100`.** Active-block listings return the `ActiveBlockId` newtype, constructed via `verify_active(pool, &BlockId)`; the `From<String>` impl is for test fixtures only. Soft-deleted rows surface only through `list_trash` / `count_trash`.
10. **Pagination `limit` is validated, not clamped.** Backend IPCs reject out-of-range limits with `AppError::Validation`; frontend call sites take the `SafeLimit` brand from `src/lib/safe-limit.ts`. Caps: `list_blocks` 100, `PageRequest::new` 200, `list_projected_agenda` 500, MCP `list_pages` / `get_page` 100. "All of X" goes through a dedicated no-limit IPC (`list_all_pages_in_space`, `list_all_tags_in_space`, `load_page_subtree`, …). Details: `docs/architecture/queries.md`.

## Architectural Stability

No new tables, op types, Zustand stores, materializer queues, or sync message types without explicit maintainer approval. Nearly every feature fits the existing model:

- **Properties are the extension point.** New per-block metadata goes in `block_properties` + `property_definitions`, not new columns. Check `INTERNAL_PROPERTY_KEYS` (`src/lib/block-utils.ts`) before adding a reserved key.
- **Hot-path properties may be promoted to native columns** only when a measured JOIN cost justifies it and the access is per page load (`todo_state`, `priority`, `due_date`, `scheduled_date`, `page_id` today). The property row stays the source of truth; the column is a cache.
- Slash commands, filter dimensions, and UI components are additive and cheap. Prefer them.
- If a feature seems to need a migration, op type, or store, stop and ask.

## Coupled Dependency Updates

Some dependencies ship as a stack. Move the whole stack in one commit, or leave it alone and file a `dependencies` issue if the coupled bump needs a major we cannot take.

- **Tauri:** `tauri`, `tauri-build`, every `tauri-plugin-*`, `@tauri-apps/api`, `@tauri-apps/cli`, every `@tauri-apps/plugin-*`. The Android toolchain pins (AGP, Gradle wrapper, KGP, `src-tauri/gen/android/buildSrc/`) belong to `tauri-cli`; regenerate with `cargo tauri android init`, never hand-edit.
- **React:** `react`, `react-dom`, `@types/react*`, `@testing-library/react`, and every React peer (`@tiptap/react`, `@radix-ui/react-*`, `react-day-picker`, `react-i18next`, …).
- **TipTap:** every `@tiptap/*` on one version line. **Radix:** every `@radix-ui/*` on one major. **StrykerJS:** `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` pin each other exactly, so a split bump fails `npm ci`.
- **SQLx + `.sqlx/` caches:** bump the crate and run `just gen-sqlx` in the same commit.
- **specta + tauri-specta:** same exact `=2.0.0-rc.*`; `ts_bindings_up_to_date` fails on drift.
- **`src-tauri/fuzz/Cargo.lock`:** the fuzz crate is its own workspace that path-depends on the parent crates, so changing any `src-tauri/**/Cargo.toml` requirement invalidates it and `verify-lockfiles` reds. Refresh with `cd src-tauri/fuzz && cargo metadata --format-version 1 >/dev/null`. Never `cargo update` or `cargo generate-lockfile` there (it lifts deliberate holds). `scripts/bump-version.sh` handles this for releases.

If you bump `X` and wonder whether `Y` moves too, it does, in the same commit.

## Threat Model

Single user, multiple devices they own, no cloud. There is no malicious actor.

- Sync runs over the LAN between explicitly paired devices. Mutually authenticated QUIC (iroh) and TOFU identity pinning exist for integrity and to catch misconfiguration, not to defend against attackers.
- Pairing requires a passphrase proof before an unknown peer is pinned (#855). That is the whole authorization story; do not extend it.
- **Do not add hardening that assumes adversarial peers.** No DoS protection, rate limiting, or traversal guards against sync peers.
- Spend defensive effort on data integrity: no accidental corruption, hash-chain consistency, transaction atomicity.

## Database

- `notes.db` under the app data dir; WAL mode; foreign keys on; pool of 2 writers + 4 readers.
- Migrations in `src-tauri/migrations/`, auto-run on pool init, append-only. Rules: [`src-tauri/migrations/AGENTS.md`](src-tauri/migrations/AGENTS.md).
- New tables are `STRICT` (FTS5 virtual tables excepted).
- New timestamps are `<col>_ms INTEGER NOT NULL CHECK (<col>_ms >= 0)`, written from `crate::db::now_ms()`.

## Frontend Architecture

- **State:** Zustand stores in `src/stores/`. `usePageBlockStore` is a per-page factory (`createPageBlockStore(pageId)` + `PageBlockContext`); `useBlockStore` holds focus and selection only.
- **Editor:** one roving TipTap instance per mounted `BlockTree` (invariant 4) with the extensions in `src/editor/extensions/`. Serializer: `src/editor/markdown-serializer.ts`, no external deps.
- **Sync hooks:** `useSyncTrigger`, `useSyncEvents`, `useOnlineStatus`.
- **Logging:** `src/lib/logger.ts` dual-writes console + Rust IPC. Never swallow errors silently; `.catch(() => {})` is banned, use `logger.warn` / `logger.error`.
- **Style:** 2-space indent, single quotes, no semicolons, 100 columns (oxfmt).

## Frontend Development Guidelines

There is a design system. Use it, extend it, do not bypass it.

| Layer | Location | Contents |
|-------|----------|----------|
| Design tokens | `src/index.css` | OKLch colors, spacing, semantic status/priority tokens, themes, `prefers-contrast` / `prefers-reduced-motion` |
| UI primitives | `src/components/ui/` | Radix + CVA wrappers: Button, IconButton, Select, Dialog, Popover, Badge, Input, ScrollArea, Tooltip, Spinner, … |
| Shared components | `src/components/` (non-page) | EmptyState, LoadingSkeleton, ConfirmDialog, LoadMoreButton, SearchablePopover, RichContentRenderer, … |
| Shared hooks | `src/hooks/` | usePaginatedQuery, useListKeyboardNavigation, useDebouncedCallback, usePropertySave, … |
| Page components | `src/components/` (top level) | JournalPage, PageBrowser, HistoryView, SearchPanel |

Before writing frontend code, check those four places for an existing primitive, component, hook, or token. If nothing fits, add the reusable piece in the right layer, then use it.

**Mandatory patterns**

- CVA variants + `cn()` (`src/lib/utils.ts`) for every component with variants; `Badge` is the reference.
- Radix for every overlay (Select, Dialog, Popover, Tooltip, AlertDialog). Never hand-roll a dropdown or modal.
- Semantic color tokens, never raw Tailwind colors where a token exists. `ScrollArea` for scrollable containers, never bare `overflow-auto`.
- 44 px touch targets via `[@media(pointer:coarse)]`; `focus-visible:ring-[3px] focus-visible:ring-ring/50`; `aria-label` on every icon-only button, through `t()` i18n keys.
- `EmptyState` for empty lists, `LoadingSkeleton` for initial loads, `Spinner` for action feedback.
- Anything that creates DOM outside React (portals, `ReactRenderer`, `computePosition`) logs failures via `logger.warn`, guards stale callbacks, and is listed in `EDITOR_PORTAL_SELECTORS` if it must not blur the editor. Reference: `src/editor/suggestion-renderer.ts`.
- Searchable pickers and filter inputs debounce IPC with `useDebouncedCallback` at 300 ms; `cancel()` before the non-search path.
- Import `INTERNAL_PROPERTY_KEYS` (`src/lib/block-utils.ts`) and `NON_DELETABLE_PROPERTIES` (`src/lib/property-save-utils.ts`, mirrors `is_builtin_property_key` in Rust); never redeclare them inline.
- React 19: `ref` is a normal prop (`ref?: React.Ref<T>`); no `React.forwardRef`, no `React.ComponentRef`, no ambient `JSX.*`.
- No `instanceof` against `@tiptap/pm/*` classes in app code (ProseMirror can be loaded twice); duck-type (`'node' in selection`).
- No numeric `limit:` literals in IPC calls; use `safeLimit(n, max)` or a named cap (invariant 10).
- Do not weaken strict settings. An `oxlint-disable` or `@ts-ignore` needs a reason comment and the narrowest scope.
- Hook filenames: kebab-case in `src/editor/`, camelCase in `src/hooks/`.

Components past ~500 lines: extract hooks first, then presentational sub-components, keep re-exports, test each extracted unit.

## Backend Architecture

- **Errors:** `AppError` (`src-tauri/agaric-core/src/error.rs`) serializes to `{ kind, message, code? }`; `Validation` carries a structured `ValidationCode` (construct with `AppError::validation_coded`, read with `validationCode(err)` in TS).
- **Undo:** in-editor via ProseMirror history; page-level via `reverse.rs` inverse ops. `purge_block` and `delete_attachment` are non-reversible.
- **Materializer:** foreground queue (256, core tables + `BatchApplyOps`) and background queue (1024, caches/FTS). Failed or dropped tasks persist to `materializer_retry_queue` and are retried with backoff (1m → 1h cap); `ApplyOp` rows are a correctness backstop, cache rebuilds are staleness backstops. `ApplyOp` / `BatchApplyOps` handlers propagate errors for retry, never `.ok()` them.
- **Tag inheritance:** materialized `block_tag_inherited`, maintained transactionally plus a background rebuild.
- **Commands:** `src-tauri/src/commands/`, one module per domain; every command pairs a thin `#[tauri::command]` wrapper with a `*_inner(&SqlitePool, …)` function. Recipe: [`src-tauri/src/commands/AGENTS.md`](src-tauri/src/commands/AGENTS.md).
- **Sync:** `sync_daemon/` (mDNS discovery, QUIC server, `SyncOrchestrator`, per-peer `SyncScheduler`) over iroh in `transport/`. `endpoint::lan_only` keeps iroh's relay and DNS publishing off; its guard tests exist so a `cargo update` cannot re-enable them. `transport/identity.rs` holds the persistent device key that `peer_refs.endpoint_id` pins against.

**Patterns caught in review**

1. Every descendant walk bounds `depth < 100` (invariant 9).
2. Multi-op sequences that must be atomic use `_in_tx` variants or `BEGIN IMMEDIATE`, with a test.
3. Batch by `json_each()`, never N+1. Bulk inserts are chunked multi-row `INSERT … VALUES` under `MAX_SQL_PARAMS`.
4. `total_count` is the post-filter count.
5. No side effects inside `debug_assert!`; release builds compile the body out.

## TypeScript Bindings (specta)

`src/lib/bindings.ts` is generated from the Rust command surface. New code imports from `@/lib/bindings`; the legacy `@/lib/tauri` wrapper is frozen by the `tauri-import-baseline` ratchet and only shrinks. Regenerate after any command signature, arg/return type, or command-list change (the `ts_bindings_up_to_date` test fails on drift), including doc-comment-only changes:

```bash
cd src-tauri && cargo test -- specta_tests --ignored     # or: just gen-bindings
```

## Pre-commit & CI

- **Pre-commit:** `prek.toml` is the list. Formatters auto-fix and abort the commit once; re-stage and commit again. Tool config: `_typos.toml`, `.taplo.toml`, `.github/zizmor.yml`.
- **Pre-push:** `scripts/verify-ci-equivalent.sh` runs a `dev.db` migration preflight, every pre-commit hook over the whole tree, then vitest, nextest, doc-tests, and the four `sqlx prepare --check` lanes scoped to the pushed range. Not run locally: Playwright, the full suites, coverage and bundle-budget gates, bundle builds. Run one heavy gate at a time; two concurrent nextest/clippy runs get OOM-killed silently.
- **CI:** `.github/workflows/_validate.yml` is the reusable workflow (`detect-changes` gates `lint`, `docs-lint`, `vitest`, `playwright`, `cargo-tests`, `cargo-coverage`, `mcp-tests` behind `validate-all`). `ci.yml` adds the Linux bundle and Android builds; `release.yml` the cross-OS matrix, attestation, and upload; `scheduled-deep-checks.yml` the weekly benches and mutation sweep. Required contexts on `main`: `dco`, `validate-all`.
- **Reviewer:** `claude-code-review.yml` runs on every PR and casts the approving or changes-requested review that the ruleset counts. Its posture is the one in [How we work](#how-we-work): block only on a concrete correctness or security defect.

### Guards earn their keep

The hook list in `prek.toml` is capped (`scripts/check-hook-budget.mjs`). Adding a guard is a trade, not an addition. Add one only when all five hold:

1. The defect has occurred; cite where.
2. Nothing else already catches it (`rustc`, `tsc`, `oxlint`, `clippy`, `sqruff`, `typos`, `knip`, a test, another guard).
3. It runs in under 500 ms, or is CI-only (`stages = ["manual"]`).
4. It fails loudly: file, line, fix.
5. It fails closed: an input shape it cannot parse is a violation, not a skipped line.

Every hook carries a `# WHY: <defect class> — <#issue>` line directly above it. Adding a guard means deleting or justifying every guard it overlaps. A self-test exists only for a guard that parses source with its own parser; anything else that needs tests gets a vitest file. A guard that has never fired on a real defect is a liability: delete it. Deleting a guard needs no justification beyond this section.

## Releases

Maintainer only. `scripts/release.sh <version>` runs the preflight, the local release-build check, and `scripts/bump-version.sh <version> --commit --tag --push`, which bumps every version manifest (including `src-tauri/fuzz/Cargo.lock`), signs the commit and tag, and pushes. The tag push publishes; never push a release tag on the maintainer's behalf, never hand-edit manifests, and do not add a CI bump button backed by a PAT. A tag that fails `verify-version`: delete it (`git push --delete origin <tag> && git tag -d <tag>`) and re-cut. Guide: [docs/BUILD.md § Releasing](docs/BUILD.md#releasing).

## Testing

### Conventions

- Every exported function: happy path + error path. Every component: render + interaction + `axe(container)`. Every component that calls IPC: a rejection-path test.
- Rust tests in `#[cfg(test)] mod tests`; frontend in `__tests__/`. Details: [`src-tauri/tests/AGENTS.md`](src-tauri/tests/AGENTS.md), [`src/__tests__/AGENTS.md`](src/__tests__/AGENTS.md).
- Doc-tests only for pure helpers reachable through a public path; never for anything needing a pool or Tauri state. `cargo test --doc` runs them (nextest does not).
- Frameworks: vitest-axe, fast-check, insta. Benches: Criterion, run weekly by `scheduled-deep-checks.yml`, not per PR ([`src-tauri/benches/AGENTS.md`](src-tauri/benches/AGENTS.md)).
- Assert exact counts (`assert_eq!(count, 5)`), not inequalities.
- React 19: state updates from non-React sources (workers, timers, IPC promises) need `act(async …)`, `findBy*`, or `waitFor`. No sleeps.

### Acceptance is falsification

A test that cannot fail covers nothing. Before calling a test done, break the code it covers, see it go red, restore. Falsify against a copy (`cp f /tmp/f.bak`, mutate, run, restore, `cmp`), never in place: stubs left by an interrupted run have shipped (#4287, #4018, #4204). Run `git diff` before your final message. Where mutation testing reaches the code, a killed mutant is the strongest form:

```bash
node scripts/run-mutation.mjs <module>       # frontend
cd src-tauri && cargo mutants --workspace    # Rust; --workspace is mandatory
```

Three test shapes that look like coverage and are not: the vacuous assertion (restates a precondition the test set up), the unreachable condition (a branch that cannot be taken; delete the code), and the half-covered pair (one arm of a symmetric property pinned, the other open, including a guard body tested without its call site). Ask of every test: *what production change would redden this?*

The same applies to prose: a comment or issue body that claims something was checked is a hypothesis until re-run. Cite issue numbers, not "filed separately". Delete comments that describe deleted code. When something cannot be tested, say so in the module docs.

### Testing invariants (anti-drift)

The browser/e2e Tauri mock (`src/lib/tauri-mock/`) is a hand-maintained second implementation of the backend. Three rules keep it honest:

1. **Assert durable, re-queried effect, never call shape.** `expect(invoke).toHaveBeenCalledWith(…)` proves the frontend asked, not that anything persisted. Persist, re-query, assert the state.
2. **The mock is a contract pinned by conformance fixtures.** Every state-mutating handler is driven by a `conformance/fixtures/*.json` fixture whose `expected` is authored by the backend (`CONFORMANCE_UPDATE=1 cargo nextest run -E 'test(conformance_fixtures_match_backend)'`) and asserted by both sides. Read commands are pinned through `queries` steps the same way; `conformance-coverage.test.ts` fails a new command without a fixture or a reasoned waiver. Wiring: `conformance_query.rs` + the `WIRE` table in `conformance-query.ts`.
3. **A migration that touches a table the mock references updates the mock in the same PR.**

### Running tests efficiently

- Rust: `cd src-tauri && cargo nextest run --workspace -E 'test(name)'`. Use nextest, not `cargo test`, for anything that reads a process-global counter and asserts on the delta (`command_integration_tests::conformance` does); see `src-tauri/tests/AGENTS.md` § "Process-global state".
- TS: `npx vitest run <paths>`.
- Do not run clippy/fmt/oxlint/oxfmt by hand; the hooks do.

### Verifying UI at runtime

Playwright runs the real frontend against the in-memory mock, no native build needed: `npx playwright test e2e/<file>.spec.ts --workers=1 --reporter=list`. Helpers in `e2e/helpers.ts`; click by accessible name; screenshot with `page.screenshot` and read the image. When a manual check found something, land the spec. See [`e2e/AGENTS.md`](e2e/AGENTS.md).

## Code Quality Enforcement

Strict settings are project-wide; do not weaken them.

- TypeScript: `exactOptionalPropertyTypes`, `noImplicitReturns`; `paths: { "@/*": ["./src/*"] }` with no `baseUrl`.
- oxlint (`.oxlintrc.json`): `require-await`, `explicit-length-check`, `only-throw-error`, `no-default-export`, `no-non-null-assertion` all error.
- Rust: `unsafe_code = "deny"`; clippy warnings are errors.

## Performance Conventions

Baseline at 100K blocks: PK lookups ~23 µs; paginated lists stay flat; batch via `json_each()`. Lazy hash computation was rejected because the sync protocol verifies hashes up front. When replacing a query implementation, keep the old one as a `#[cfg(test)]` oracle and assert both agree. Background rebuilds read from the reader pool and take a write connection only for the final transaction.

## Search & FTS

Detail: [`docs/architecture/search.md`](docs/architecture/search.md).

1. New search filters are fields on `SearchFilter` (`src-tauri/agaric-store/src/search_types.rs`) with `#[serde(default)]`, never new positional args.
2. `SearchBlockRow.snippet` carries literal `<mark>` markers, not HTML. Renderers split on the markers and emit text nodes; never `dangerouslySetInnerHTML`.
3. The inline filter syntax parser at `src/lib/search-query/` is the single source of truth; register new prefixes through `registerTokenPrefix`, never fork the parser. `parse(serialize(parse(s))) === parse(s)` is property-tested.
4. `MatchOffset` is UTF-16 code units, converted in Rust (`fts::toggle_filter::byte_to_utf16_offsets`). The frontend slices `substring(start, end)` directly.

## Pages view

Detail: [`docs/architecture/pages-view.md`](docs/architecture/pages-view.md).

1. `list_pages_with_metadata` rejects stale cursors with `ValidationCode::RequiresRefresh`; the frontend drops the cursor and refetches page 1. New sort keys reuse the existing `Cursor` slots (`deleted_at`, `seq`, `position`, `id`), never new fields.
2. Density lives under the `page-browser-density` localStorage key; row heights only in `DENSITY_ROW_HEIGHT` (`src/hooks/usePageBrowserDensity.ts`); rows carry `data-density`.
3. `DensityRow` stays inside `src/components/PageBrowser/`.
4. Sort comparators do not allocate; materialize lookups before `Array.sort`.

## Filters

Detail: [`docs/architecture/filters.md`](docs/architecture/filters.md). A `FilterPrimitive` (`src-tauri/agaric-store/src/filters/primitive.rs`) is a value; a `Projection` compiles it per surface. Adding a primitive to a surface is a deliberate change in both that surface's `ALLOWED_KEYS` set and its `Projection` impl. New search filter dimensions go through `SearchProjection`, not the legacy fragments in `fts/filter_builder.rs`.

## Android

- Debug and release APKs build, install, and run. Release uses R8; verify keep-rules when adding reflection-based deps.
- Diagnose with `adb logcat | grep RustStdoutStderr`; it works on a release build. Only `run-as` needs a debuggable build.
- Generated project: `src-tauri/gen/android/`. Min SDK 30, target 36, NDK 27, Java 17. 64-bit only (`aarch64`, `x86_64`); do not re-add 32-bit targets.
- Emulator: `emulator -avd spike_test -gpu host &`. DB path: `/data/data/com.agaric.app/notes.db`. ADB recipes: [docs/BUILD.md](docs/BUILD.md#installing-on-emulator).

## State Files

| File | When |
|------|------|
| `docs/session-log/session-NNN-<slug>.md` | One file per session, never edited after merge; see `docs/session-log/README.md` |
| [GitHub Issues](https://github.com/jfolcini/agaric/issues) | Only for a user-visible failure you are deferring, something that blocks planned work, or a design decision; name who is hurt and how |
| `docs/FEATURE-MAP.md` | When a user-facing feature is added or changed |
| `AGENTS.md` | Only with maintainer approval |

Orchestration workflow: [the `batch-issues` skill](.claude/skills/batch-issues/SKILL.md).

<!-- code navigation -->
## Code Navigation

Prefer symbol-aware tools when the agent has them. `code-review-graph` is declared in [`.mcp.json`](.mcp.json) but optional (needs `uvx`); Serena is client-side. Neither is a prerequisite. If the tools are absent or fail on a target, use Grep/Glob/Read and move on; do not retry a missing tool. A symbol server's root is the main checkout, so edits from a git worktree must go through Read/Write/Edit with absolute paths.
