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
18. [Search & FTS](#search--fts)
19. [Pages view](#pages-view)
20. [Filters](#filters)
21. [Android](#android)
22. [State Files](#state-files)
23. [Code Navigation](#code-navigation)

## Documentation Map

| Document | Purpose |
|----------|---------|
| **AGENTS.md** (this file) | Invariants, conventions, architecture overview |
| **[docs/BUILD.md](docs/BUILD.md)** | Build guide: prerequisites, platforms, Android, CI, troubleshooting |
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | Deep-dive index: data model, op log, materializer, editor, sync, search |
| **[docs/FEATURE-MAP.md](docs/FEATURE-MAP.md)** | Complete feature inventory: schema, commands, sync, editor, stores, testing. Use for discovery and review. |
| [`src-tauri/tests/AGENTS.md`](src-tauri/tests/AGENTS.md) | Rust test patterns, fixtures, pitfalls |
| [`src/__tests__/AGENTS.md`](src/__tests__/AGENTS.md) | Frontend test orientation + cross-links to per-test-type splits |
| [`src/components/__tests__/AGENTS.md`](src/components/__tests__/AGENTS.md) | Component test patterns (querying, mocks, axe, React 19 timing, checklist) |
| [`src/stores/__tests__/AGENTS.md`](src/stores/__tests__/AGENTS.md) | Zustand store testing (global / per-page / undo store) |
| [`e2e/AGENTS.md`](e2e/AGENTS.md) | Playwright e2e patterns (mock backend, portal-scoped helpers, undo/redo helpers) |
| [`src-tauri/migrations/AGENTS.md`](src-tauri/migrations/AGENTS.md) | SQL migration rules (append-only, STRICT tables, index timing) |
| [`src-tauri/benches/AGENTS.md`](src-tauri/benches/AGENTS.md) | Bench pitfalls: the scheduled `bench-smoke` / `bench-slo` lanes, the E0308 `Pool<Sqlite>` build-race (run prebuilt binaries), fixture schema-drift checklist, cold `--test` vs warm budgets |
| [`src-tauri/src/commands/AGENTS.md`](src-tauri/src/commands/AGENTS.md) | Tauri command patterns (`_inner` split, `CommandTx`, `MAX_BATCH_BLOCK_IDS`, `LAST_APPEND`, `ValidationCode`) |
| [`src-tauri/src/mcp/AGENTS.md`](src-tauri/src/mcp/AGENTS.md) | MCP server rules (rmcp adapter, `ACTOR.scope`, activity-feed emission, `MCP_DISCONNECT_GRACE_PERIOD`, RO/RW split) |
| [GitHub Issues](https://github.com/jfolcini/agaric/issues) | Deferred items, tech debt backlog, future features |

## Build Commands

See **[docs/BUILD.md](docs/BUILD.md)** for the full build guide (prerequisites, platform-specific instructions, Android signing, CI pipeline, troubleshooting).

```bash
# Quick reference
bash scripts/setup.sh        # ONE-command dev-env setup (Node + deps + .env + dev DB + prek hook toolchain); = npm run setup = just setup
cargo tauri dev              # Dev mode with hot reload
cargo tauri build            # Production build (per-platform)
npm run test                 # Vitest (frontend test suite)
npm run typecheck            # TypeScript — all four projects (NEVER bare `npx tsc --noEmit`, see below)
cd src-tauri && cargo nextest run --workspace   # Rust tests (bare form runs only the app crate)
npx playwright test          # E2E tests (see `e2e/` for spec inventory)
cargo tauri android build --target aarch64 --debug   # Android debug APK
cargo tauri android build --target aarch64            # Android release APK
prek run --all-files         # Pre-commit hooks
```

**Typecheck with `npm run typecheck` — never bare `npx tsc --noEmit`.** The root [`tsconfig.json`](tsconfig.json) is solution-style: `"files": []` plus four `references`, and no `include`. `--noEmit` does **not** follow project references (only `--build`/`-b` does), so `npx tsc --noEmit` type-checks an *empty* program and **exits 0 no matter how broken the code is** (#3805) — not a check that reports nothing, a green result that means nothing. It waves through exactly the class of mistake a typecheck exists to catch (a missing narrowing guard under `noUncheckedIndexedAccess`, say). `npm run typecheck` is `tsc -b --noEmit`, and prek's `tsc` pre-commit hook, CI's typecheck step and `beforeDevCommand` all now invoke that same script rather than re-spelling the command — so a local green means those will be green too, structurally rather than by coincidence. It covers all four projects (`tsconfig.app.json`, `.node`, `.e2e`, `.wdio`) and automatically covers any project added to `references` later. It emits nothing but `.tsbuildinfo` under the gitignored `node_modules/.tmp/`. Narrower loops: `npm run typecheck:e2e`, `npm run typecheck:e2e-tauri`. With `just`: `just typecheck`.

**Dev-env setup is one command.** `bash scripts/setup.sh` (identical: `npm run setup`; or `just setup`) is the single canonical bootstrap and handles everything, idempotently: it provisions the `.nvmrc`-pinned Node version via `nvm` when the active `node` does not satisfy `engines.node` (`^22.22.2 || ^24.15.0 || >=26.0.0`; Claude's cloud VMs ship Node 20–22, so this matters there — a 22.22.2+ VM is now supported as-is), runs `npm ci`, seeds `.env` (from `src-tauri/.env.example`) and the sidecar placeholder, provisions the dev DB, and installs the prek hook toolchain. **It auto-runs on Claude Code on the web** via the committed `SessionStart` hook ([`.claude/hooks/session-start.sh`](.claude/hooks/session-start.sh), gated on `CLAUDE_CODE_REMOTE=true`), so a fresh cloud session is ready with no manual step. See [docs/BUILD.md → Claude Code on the web](docs/BUILD.md#claude-code-on-the-web) (incl. why prek's three git-cloned hooks stay unwired in repo-scoped sandboxes). **Prek toolchain:** every hook in `prek.toml` is `language = "system"`, so `scripts/setup-hooks.sh` installs each host binary the hooks shell out to — mirroring CI's install set — and runs `prek install`; best-effort and idempotent (re-run to fill gaps).

**`just` task runner — prefer it for everyday commands.** A [`justfile`](justfile) is a thin, discoverable façade over the canonical commands — every recipe shells out to the real `npm`/`cargo`/`prek`/`scripts/*` entry point, so it cannot drift, and it is the single place where tricky flag combinations (e.g. the workspace-wide sqlx regen) live correctly. **`scripts/setup.sh` installs `just` for you** (via `scripts/setup-hooks.sh`), so it's available after bootstrap — run `just --list` to discover recipes and **reach for a `just` recipe whenever one exists** rather than retyping the raw command. Common: `just setup` (full bootstrap), `just install-hooks` ((re)install the prek toolchain + git hooks), `just dev`, `just test`, `just check` (= `prek run --all-files`), `just verify` (pre-push CI mirror), `just gen-sqlx` / `just gen-bindings` (codegen). It stays a convenience layer — CI and the git hooks invoke the underlying tools directly, so nothing *depends* on `just` — but for local work it is the recommended entry point.

**Daily dev loop:** prefer `npm run dev` (browser, ~50 ms HMR) for pure UI work; reach for `cargo tauri dev` (~10-20 s per Rust edit) only when touching backend behaviour. Backend-only iteration: `bacon` in a sidecar terminal. Linux: activate the staged mold linker (`sudo apt install mold && cp .cargo/config.toml{.example,}`) to drop incremental link time ~3-4×. Full guidance in [docs/BUILD.md § Development](docs/BUILD.md#development).

## Key Architectural Invariants

1. **Op log is strictly append-only** — never mutate, never delete (except compaction)
2. **Event sourcing with materialized views** — commands append to the op log AND write the primary state atomically in a single `BEGIN IMMEDIATE` transaction (synchronous primary-state materialization); the materializer rebuilds derived materialized views (FTS, tag inheritance, page-id lookup, agenda projection, link graphs) asynchronously in the background. **Three-layer responsibility boundary**: the **op log is the canonical, typed, hash-chained domain history** (audit, undo, the *local-op* migration source, Loro-independent) — **globally-replicated for audit/History but device-local for state**: since #2481 phase 1 it also holds *foreign* devices' ops as append-only, hash-verified **audit** records (`is_replicated = 1`, streamed via `SyncMessage::OpLogBatch` after the Loro deltas) that are **never applied to state** (every state path — boot replay, materializer, undo, whole-state rebuild — filters `is_replicated = 0`). So for state it is **not** a complete whole-state rebuild source on a synced device: a full-log replay reconstructs only locally-authored content and silently omits remote-authored blocks/properties/tags (#2504). The **complete convergent state truth is the Loro engine** (`loro_doc_state` snapshots); disaster recovery **is** engine-first (`db/recovery.rs::reproject_blocks_from_engine` reprojects `blocks`/properties/tags/`deleted_at` from the per-space engine snapshots via the canonical Loro→SQL projection, #2504), with the device-local op-log replay reduced to the migration-target scaffold and the last-resort fallback that logs loudly when engine state is present but unreadable. The **Loro engine is a derived merge index**, rebuildable from op-log replay of *local* ops, owning merge + storage of *mergeable* data only — text content, the block tree, and typed scalar field values; **SQLite is the derived query/index view** plus the home of all derivations (tag inheritance, `page_id`, the soft-delete descendant cascade, agenda/recurrence). Enums/`property_definitions`, validation, and integrations stay in the app layer — **not** in Loro. The engine models the block hierarchy as a `LoroTree` (convergent moves + deterministic cycle rejection) and stores property values with their native type (`LoroValue::Double`/`Bool`/`String`), so engine→SQL re-projection is lossless. The engine has a **format version** (`loro::engine::ENGINE_FORMAT_VERSION`, currently `2`): a legacy v1 (flat-map) snapshot is **rejected loudly on load** (`reject_legacy_v1_snapshot`, #332) rather than migrated forward, and a snapshot stamped with a **newer** engine format than this build supports is likewise rejected at import (`reject_unknown_format_version`, #1584). Two peers on different engine formats are kept from merging raw bytes primarily **by the sync handshake** (#2130): `HeadExchange` carries `engine_format_version` alongside the sync-*protocol* version (`LORO_SYNC_PROTOCOL_VERSION`) and per-space Loro version vectors, and the responder rejects a non-zero mismatched peer up front (`SyncState::Failed`) before any raw-byte Loro merge (`sync_protocol/session_state_machine.rs`); a legacy peer that omits the field (value `0`) falls through to the **receiver-side post-import rejection** (`reject_legacy_v1_snapshot` / `reject_unknown_format_version`) as the fallback guard
3. **Cursor-based pagination** on ALL list queries — no offset pagination. Carve-outs: (a) named small-cardinality lookups that return a fixed-size set (`list_property_keys` — bounded in practice by user vocabulary, not data volume) may return a flat `Vec<T>` with a `limit` parameter; (b) "fetch the Nth row" operations (e.g., `undo_page_op_inner` using `LIMIT 1 OFFSET ?`) where N is upper-bounded by a small constant (≤1000) are not list queries and may use `OFFSET` — document the rationale inline at the call site.
4. **One roving TipTap instance per mounted `BlockTree`** — within a tree the editor roves to the focused block and every other block renders as a static div; app-wide, only one block hosts `<EditorContent>` at any moment, because focus is global. But `Editor` objects are **not** an app-wide singleton: the journal week and stream views render one `DaySection` → one `BlockTree` per day (`src/components/journal/WeeklyView.tsx`, `src/components/journal/StreamView.tsx`, `src/components/journal/DaySection.tsx`) and the daily view renders exactly one, and every mounted tree lazily constructs its own ~50-extension `Editor` on an idle callback (`src/hooks/useLazyRovingEditor.ts`) — up to 7 live editors in the weekly view. The **month** view mounts none: `MonthlyView.tsx` renders a `MonthlyDayCell` calendar grid that imports no `BlockTree`. Memory is bounded by mounted trees, not by blocks. App-level editor access (command-palette insertion, a global formatting action, a crash-flush) must therefore read the **focus-published** registry `src/editor/active-editor.ts`, never a module-level slot filled on mount — mount order is not caret position
5. **OXC only (oxlint + oxfmt)** — no ESLint, no Prettier, no Biome
6. **sqlx compile-time queries** — `query!` / `query_as!` / `query_scalar!`. Run **`just gen-sqlx`** after SQL changes, then commit ALL FOUR regenerated `.sqlx/` caches in the same commit (the `-- --tests` scope is required so test-only queries are cached — the verifier runs `cargo sqlx prepare --check -- --tests` against each). **Multi-crate workspace caveat:** the workspace has several query-bearing crates (`agaric` i.e. `src-tauri`, `agaric-store`, `agaric-engine`, `agaric-sync`, and the bin-only `agaric-diagnostics`; `agaric-core` currently carries none). The CI `lint` job compiles them all *offline* (`cargo clippy --workspace --all-targets`, no `DATABASE_URL`), so every crate's queries must be in a committed `.sqlx/` somewhere. A bare `cargo sqlx prepare` only builds the default member (`agaric`) + its deps and **silently drops leaf crates nothing depends on** (e.g. `diagnostics`), reddening `lint` on the next non-docs PR — `just gen-sqlx`'s root pass forces cargo's `--workspace` through (`cargo sqlx prepare --workspace -- --workspace --tests`) so leaf-crate queries are captured there too. **Four crates additionally keep their OWN crate-local `.sqlx/` cache, each checked by its own CI lane** (`.github/actions/sqlx-offline-check`, called once per crate from `_validate.yml`): `agaric` (`src-tauri/.sqlx`), `agaric-store`, `agaric-engine`, `agaric-sync` (#2621 layered-workspace split — `diagnostics` and `agaric-core` have no lane of their own, since they either have no queries or are covered by the root `--workspace` pass). `just gen-sqlx` regenerates all four in one shot — the root pass, then one pass per member crate run from within that crate's directory against a throwaway absolute-path SQLite DB (a relative `DATABASE_URL` fails there: `query!` resolves it at compile time from rustc's CWD, the workspace root, not the crate dir). Never regenerate a member cache with the bare `cargo sqlx prepare` command — always go through the recipe so all four stay in lockstep.
7. **PRAGMA foreign_keys = ON** — enforced on every connection (both pools)
8. **ULID uppercase normalization** — Crockford base32 for blake3 hash determinism
9. **Recursive CTEs over `blocks` must bound `depth < 100`** in the recursive member to prevent runaway recursion on corrupted `parent_id` chains. **Active-block listings carry the typed `ActiveBlockId` newtype**: the pagination leaves (`list_children`, `list_by_type`, `list_by_tag`, `list_agenda*`, `list_trash`'s active siblings), search, projected agenda, backlinks, and tag query return `PageResponse<ActiveBlockRow>`. Construct an `ActiveBlockId` from raw input via `verify_active(pool, &BlockId)` (DB-checked, `deleted_at IS NULL`), never via the `From<String>` impl, which exists only for test fixtures / in-process trusted round-trips. Surfacing soft-deleted rows lives behind the dedicated `list_trash` / `count_trash` IPCs.
10. **Pagination `limit` is loud at both ends** — backend IPCs reject out-of-range `limit` values with `AppError::Validation` (no silent `clamp(1, cap)` anywhere); the pagination-aware frontend call sites accept only the `SafeLimit` brand from `src/lib/safe-limit.ts`, so a naked numeric literal does not compile. Caps: `list_blocks` → 100, `pagination::PageRequest::new` (the shared paginator behind `query_by_property`, `list_unfinished_tasks`, `list_tags_by_prefix`, `list_backlinks`, search, history, …) → 200, `list_projected_agenda` → 500, MCP `list_pages` / `get_page` → 100. Callers that genuinely need "all of X" must route through one of the no-clamp dedicated IPCs (`list_all_pages_in_space`, `list_all_tags_in_space`, `count_trash`, `load_page_subtree`, `list_template_page_ids_in_space`) — these take no `limit` argument because the upper bound is intrinsic to the space. See `docs/architecture/queries.md § Pagination invariant` and SESSION-LOG sessions 700–703 for the history.

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
- **Tauri crates + CLI + JS plugins.** `tauri`, `tauri-build`, every `tauri-plugin-*` crate, `@tauri-apps/api`, `@tauri-apps/cli`, and every `@tauri-apps/plugin-*` package move together. Bump the whole set in one commit. This drags `tao` transitively (see `src-tauri/Cargo.lock` for the current pin) — when it moves, re-check the `ndk_glue` stdout-redirection claim in [Android](#android), which names a `tao` module path that is not verifiable from this checkout.
- **React + React-dependent ecosystem.** `react`, `react-dom`, `@types/react`, `@types/react-dom`, `@testing-library/react`, and every package that peer-depends on React (`@tiptap/react`, `@radix-ui/react-*`, `react-day-picker`, `react-i18next`, …) follow React's major. Never update one slice without the rest.
- **TipTap.** All `@tiptap/*` packages (`core`, `pm`, `react`, `suggestion`, every `extension-*`) share one version line (see `@tiptap/*` in `package.json` for the current pin). Bump atomically.
- **Radix UI.** `@radix-ui/*` primitives ship as an API-compatible set. Never mix majors across them.
- **SQLx + `.sqlx/` cache.** The `sqlx` crate version and all four committed `.sqlx/` query caches (root + `agaric-store`/`agaric-engine`/`agaric-sync`) must match. If `sqlx` is bumped, regenerate every cache with `just gen-sqlx` in the same commit — do not land a version bump with a stale cache. (`just gen-sqlx` runs the workspace-wide root pass `cargo sqlx prepare --workspace -- --workspace --tests` plus one pass per member crate; see invariant #6 for the full shape and why the bare command silently drops leaf-crate queries.)
- **Parent manifests + `src-tauri/fuzz/Cargo.lock`.** `src-tauri/fuzz` is its own workspace with its own lock, but it path-depends on several of the parent crates (read `src-tauri/fuzz/Cargo.toml` for which — deliberately not enumerated here, because that list grew by one in #4497 and a hand-maintained copy of a manifest is the exact drift #2945 cost this lane) — so that lock resolves every requirement declared in the parent manifests too. **Adding or changing a dependency *requirement* in any `src-tauri/**/Cargo.toml` invalidates `src-tauri/fuzz/Cargo.lock` as well**, and `_validate.yml`'s `verify-lockfiles` job (#4142) reds until it is regenerated — even when the PR never touches `src-tauri/fuzz`. Refreshing only `src-tauri/Cargo.lock` is not enough; no parent-workspace cargo command reaches the fuzz lock. Fix it in the same commit with `cd src-tauri/fuzz && cargo metadata --format-version 1 >/dev/null` (any cargo command *without* `--locked` rewrites the lock conservatively, keeping every pin that still satisfies the manifests; `cargo metadata` is just the cheapest — it runs no build). **Never `cargo generate-lockfile` or a bare `cargo update` there:** both re-resolve the whole graph to the newest compatible versions and lift deliberate holds — measured on this lock, 882 packages relocked and `loro` 1.13.6 → 1.13.9 straight through the #3161 hold that `.github/dependabot.yml` pins. A Dependabot PR against `/src-tauri` can trip this and cannot repair itself (its `/src-tauri/fuzz` entry is `lockfile-only` by design, #3432), so that one-command fix is a human step — see the `verify-lockfiles` header comment in `.github/workflows/_validate.yml`. That commit lands on **Dependabot's own branch**, which Dependabot can force-push out from under it (a `@dependabot rebase`/`recreate`, or a superseding release) with no trace left behind, and by default a clean squash-merge takes the **PR title** as the squash **subject** on `main` (`squash_merge_commit_title` is `COMMIT_OR_PR_TITLE`) — identical to Dependabot's own commit subject only while the PR is untouched, and diverging the moment anyone retitles it — demoting this one's message to a bullet inside the squash body rather than dropping it (#4360) — always follow it with a `gh pr comment` stating what broke and what you did, verify the push actually landed (`git ls-remote origin <branch>`; a Dependabot rebase can beat you to it silently), and merge with `gh pr merge <n> --squash --subject "<human commit subject>"`, leaving `--body` unset, to promote this commit's subject to the headline — which leaves Dependabot's bump line in the body too, since `--subject` does not displace the default concatenation (observed on #4436 → `d8b2840`); see [`references/pitfalls.md` § "A commit pushed onto a Dependabot branch survives only if you make it survive"](.claude/skills/batch-issues/references/pitfalls.md#a-commit-pushed-onto-a-dependabot-branch-survives-only-if-you-make-it-survive) for the one stated position on this and the evidence behind it. A *version bump* is the one case that is automated: `scripts/bump-version.sh` regenerates and stages the fuzz lock itself.
- **StrykerJS.** `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` declare each other as an **exact** peer version, not a range — so a split bump yields a dependency set that cannot install at all. Each half alone fails `npm ci` with `ERESOLVE` before a single test, lint rule or Playwright spec runs, which surfaces as eight unrelated-looking red checks rather than an obvious dependency error (#4332 / #4333). Landing them independently would break `npm ci` on `main` at whichever merged first, in either order. `.github/dependabot.yml` now groups `@stryker-mutator/*` at every update level, majors included, because the catch-all `minor-and-patch` group already covered the lesser bumps — the major was the one that escaped. Separately, note that Stryker's sandbox tsconfig rewrite still calls `ts.parseConfigFileTextToJson`, which this repo's native-port `typescript@^7` does not provide; `stryker.config.mjs` points `tsconfigFile` at a deliberately missing path to skip that branch. Re-verified against Stryker 10 — **do not create that file**.
- **specta + tauri-specta.** Pinned to the exact same `=2.0.0-rc.*` in `src-tauri/Cargo.toml`. The `ts_bindings_up_to_date` pre-commit test fails if they drift. Move both in lockstep or not at all.

**Rule of thumb:** if you open `Cargo.toml` or `package.json` to bump package `X` and find yourself wondering "should I also bump `Y`?", the answer is almost always **yes** — and it is one commit, not two. Check the upstream release notes for the coupling before landing the bump. If the upstream coupling requires a major this repo cannot take yet (e.g., React 20, Tauri 3), do not bump any slice of the stack — leave it pinned and file a `MAINT-*` item describing the blocker.

## Threat Model

Agaric is a **single-user, multi-device, local-first** application with **no cloud connectivity**. The threat model reflects this:

- **There is no malicious actor.** The only people with access to the app's data are the user and their own devices. Sync happens over the local network between devices the user has explicitly paired.
- **Mutually authenticated QUIC between devices** (iroh; previously TLS + mTLS) is for data integrity and device authentication (preventing accidental cross-talk), not for defending against adversaries on the network.
- **TOFU identity pinning** is a convenience to detect device re-installs or misconfigurations, not a defense against MITM attacks.
- **Pairing does not cryptographically bind the typed passphrase to the pinned certificate (residual — #1559, #855; re-evaluate, see below).** The joiner's `confirm_pairing` no longer compares anything locally (that comparison was #3463, the defect that made two-device pairing impossible); it arms a TTL-bounded `pairing_proof` of the typed passphrase. The responder then requires an unpaired peer to present a matching proof before TOFU-pinning it (#855), so passphrase knowledge and the pinned certificate now arrive over the *same* authenticated connection. **That is materially stronger than when #1559 was written**, and whether a meaningful residual remains has not been re-analysed since #3463 landed — treat the risk statement here as stale rather than settled. What is certainly unchanged: the QR payload is still `{v, passphrase}` only, carrying no cert hash, because mDNS owns discovery and address resolution. Under the iroh port (plan #3464) the *binding* question dissolves — identity is the key, so there is no separately-claimed certificate to bind the passphrase to — but **the passphrase proof itself does not go with it.** QUIC answers *which key is this*; it does not answer *may this key sync my vault*, and anyone can generate a keypair and dial. Without the #855 proof the pairing window would admit, and TOFU-pin, any endpoint that connected during it. The proof's job narrows from "defend against a spoofed identity being pinned as the victim" to "authorize a genuine but unknown identity" — narrower, still required. Do not fix reflexively; it follows from the "peers are the user's own trusted devices" model above.
- **Do not add security hardening that assumes adversarial peers.** The sync protocol's peers are the user's own devices. DoS protection, rate limiting, path traversal guards against sync peers, and similar measures are unnecessary and add complexity without value.
- **Focus defensive effort on data integrity** — preventing accidental corruption, hash chain consistency, transaction atomicity — not on defending against attack scenarios that don't apply.

## Database

- **File:** `notes.db` in `~/.local/share/com.agaric.app/` (Linux) or app data dir (Android)
- **WAL mode**, foreign keys ON on every connection
- **Pool:** 2 writers + 4 readers (6 total)
- **Migrations:** `src-tauri/migrations/` — auto-run on pool init (append-only, never modify shipped migrations)
- **Schema:** application tables + an FTS5 virtual table (`fts_blocks`, trigram tokenizer) + internal/cache tables (`materializer_retry_queue`, `materializer_apply_cursor`, `_op_log_mutation_allowed`); indexes and triggers maintained across the migrations directory. See `src-tauri/migrations/` for the current schema set.
- **`STRICT` tables for new schema.** Every new `CREATE TABLE` in a migration must use `STRICT`. Existing tables are not retrofitted. FTS5 virtual tables (`CREATE VIRTUAL TABLE … USING fts5`) don't accept `STRICT` — they're carved out from the rule. Rationale: SQLite's silent type coercion is a known correctness footgun; `STRICT` mode (3.37+) catches it at insert time.
- **Timestamp encoding for new tables: INTEGER ms since the Unix epoch.** Issue #109 — every new timestamp column must be declared `<col>_ms INTEGER NOT NULL CHECK (<col>_ms >= 0)` and every writer must source the value from `crate::db::now_ms()` (defined in `src-tauri/agaric-store/src/db/mod.rs`, re-exported through the app crate's `db` module). Range scans on staleness windows become direct integer comparisons (`WHERE col_ms <= ?`); no `strftime` parsing, no `Z` vs `+00:00` lex-collation hazard. Precedent: `loro_doc_state.updated_at` (migration 0052) and `app_settings.updated_at` (migration 0053) already follow this shape. Phase 2 of #109 has since migrated the legacy TEXT ISO-8601 timestamp columns to this `_ms` shape — `materializer_retry_queue.created_at` (migration 0077), `op_log.created_at` (0079), `blocks.deleted_at` (0080), plus `link_metadata.fetched_at`, `peer_refs.*`, `apply_cursor.updated_at`, `pages_cache.updated_at`, `attachments.created_at`, and `block_drafts.updated_at` (migrations 0074–0082). `crate::now_rfc3339()` is retained only for any column not yet migrated and for non-DB (log/display) use.

## Frontend Architecture

- **State:** Zustand stores — `useBootStore`, `useBlockStore` (focus/selection only), `useNavigationStore`, `useJournalStore`, `usePageBlockStore` (per-page factory via `createPageBlockStore(pageId)` + `PageBlockContext` provider), `useResolveStore`, `useUndoStore`, `useSyncStore`, `useSpaceStore` (active space + bootstrapped `Personal` / `Work`), `useTabsStore` (per-space tabs, split out from navigation in), `useRecentPagesStore` (per-space recent-pages MRU strip). See `src/stores/` for the current set.
- **Editor:** One roving TipTap instance **per mounted `BlockTree`** (invariant #4 — the journal week and stream views mount several at once, the month view none; reach the live editor from app-level code via `src/editor/active-editor.ts`, which publishes on focus) with custom extensions (TagRef, BlockLink, BlockRef, ExternalLink, AtTagPicker, BlockLinkPicker, BlockRefPicker, PropertyPicker, CheckboxInputRule, SlashCommand). See `src/editor/extensions/` for the canonical list.
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

**Hook filename casing (`src/editor/` vs `src/hooks/`)** — the two directories use different, deliberate conventions: `src/editor/` hook files are kebab-case (`use-block-keyboard.ts`, `use-roving-editor.ts`), matching that directory's general file-naming style; `src/hooks/` files are camelCase (`useBlockActionOrchestration.ts`, `useViewportObserver.ts`), matching the exported hook identifier. When adding a hook, name the file to match whichever directory it lives in — don't carry one directory's casing into the other.

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
- **Picker / filter debouncing hook**: searchable pickers and filter inputs debounce their IPC fan-out via `useDebouncedCallback` (`src/hooks/useDebouncedCallback.ts`) at the conventional 300 ms. The hook exposes `schedule(value)` / `cancel()`, manages its timer ref internally, and cleans up on unmount. Always `cancel()` before the non-search path (clearing input, selecting a result) and before scheduling a new value — `TagValuePicker.tsx` is the canonical clear-then-cancel-then-schedule sequence. The "Picker / filter input without debouncing" anti-pattern below documents the regression path.
- **Property-key filter sets — use the canonical exports, never inline**: two distinct sets must be imported rather than redeclared at call sites:
  - `INTERNAL_PROPERTY_KEYS` (`src/lib/block-utils.ts`) — properties tracked by the materializer but hidden from the per-block UI. Filter sites import this set; do not hand-roll the list inline.
  - `NON_DELETABLE_PROPERTIES` (`src/lib/property-save-utils.ts`) — broader set used for delete-guard UI; mirrors `is_builtin_property_key` in `src-tauri/agaric-store/src/op.rs`. Adding a builtin requires updating both the Rust source of truth and this TS mirror together.

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
- **Numeric `limit:` literals in IPC calls** — pagination-aware call sites take `limit?: SafeLimit | undefined`, not `number`.  Wrap with `safeLimit(n, max)` or one of the per-IPC helpers (`listBlocksLimit`, `paginationLimit`, `listProjectedAgendaLimit`), or use a named cap constant (`PAGINATION_LIMIT`, `AGENDA_QUERY_LIMIT`, `AGENDA_LIST_BLOCKS_LIMIT`).  See invariant #10.
- **Picker / filter input without debouncing** — every searchable picker or filter input must debounce its IPC fan-out with `useDebouncedCallback` at **300 ms**. `TagFilterPanel`'s `useDebouncedCallback(handleSearch, 300)` is the canonical example; `SearchPanel`, the picker plugins, and the property picker all follow it. Direct `onChange → invoke(...)` chains hit the backend on every keystroke and were the root cause of.
- **Silent `.catch(() => {})` blocks** — always use `logger.warn` or `logger.error`. Silent error swallowing masks real bugs.
- **Weakening strict settings** — do not add `@ts-ignore` or `oxlint-disable` without a clear justification comment. Acceptable only when: (a) the rule is genuinely too strict for the context (e.g., `noExcessiveCognitiveComplexity` when splitting a component would create worse prop-drilling); (b) the comment explains the tradeoff; (c) the ignore is scoped to the minimal range (single line or function, not whole file). Do not relax `exactOptionalPropertyTypes`, `noImplicitReturns`, or `unsafe_code = "deny"`.
- **`React.forwardRef` wrappers** — deprecated in React 19. Accept `ref` as a normal prop instead (see "Ref-as-prop" in Mandatory patterns above). Likewise **never use `React.ComponentRef<typeof X>`** (deprecated) or the ambient `JSX.*` namespace (React 19 dropped the global — use `React.JSX.IntrinsicElements` / `React.ReactElement`).
- **`instanceof TextSelection` / `NodeSelection` (or any `@tiptap/pm/*` class) in app code** — ProseMirror can be loaded as more than one module copy, so `instanceof` is silently always-false even for a genuine match (this broke the bubble menu). Duck-type instead: `'node' in selection` for a `NodeSelection`, `selection.empty` / `.from` / `.to` for text selections. Run the editor e2e locally before pushing bubble-menu / selection changes. See [docs/architecture/editor-and-content.md](docs/architecture/editor-and-content.md#picker-plugins-inline-references).

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

- **Error handling:** `AppError` (`src-tauri/agaric-core/src/error.rs`) serializes to `{ kind, message, code? }` for Tauri 2 IPC. Variants: `Database`, `NotFound`, `PoolTimedOut` (kind `pool_busy`), `Conflict`, `Migration`, `Io`, `Json`, `Ulid`, `InvalidOperation`, `Channel`, `Internal`, `Snapshot`, `Validation`, `NonReversible`, `Cancelled`. `kind` and `code` are specta-generated string-literal unions in `bindings.ts`, narrowed on the frontend via `@/lib/app-error`. `Validation` carries an optional structured `ValidationCode` sub-kind (#2251 — a real wire field, **not** a `"<Code>: …"` message prefix): construct with `AppError::validation_coded(...)`, discriminate with `err.validation_code()` in Rust or `validationCode(err)` in TS.
- **Undo/redo:** Two-tier model. In-editor: TipTap/ProseMirror history (cleared on blur). Page-level: `reverse.rs` computes inverse ops from op log. Non-reversible: `purge_block`, `delete_attachment`.
- **Materializer:** Foreground queue (256 cap, core tables + `BatchApplyOps`) + background queue (1024 cap, caches/FTS). Auto-dedup, silent drop on backpressure. Background tasks use split read/write pools — reads from reader pool, writes only for the final transaction. Foreground consumer batch-drains and parallelizes independent block_id groups via JoinSet.
- **Materializer task durability.** Two classes persist to `materializer_retry_queue` on handler failure or queue saturation: (a) idempotent per-block tasks (`UpdateFtsBlock`, `ReindexBlockLinks`, `ReindexBlockTagRefs`, `RefreshTagUsageCount`) and global cache rebuilds (`RebuildTagsCache`, `RebuildPagesCache`, `RebuildPagesCacheCounts`, `RebuildAgendaCache`, `RebuildProjectedAgendaCache`, `RebuildTagInheritanceCache`, `RebuildPageIds`, `SetBlockPageId`, `RebuildBlockTagRefsCache`, `RebuildPageLinkCache`) — pure cache-staleness machinery, rebuildable from primary state; and (b) `ApplyOp` (keyed by `(device_id, seq)`, packed into `task_kind` as `"ApplyOp:<seq>:<device_id>"`) — a **correctness** backstop for a primary-state apply that exhausted its in-memory retry, exercised on every boot's replay of the prior session's un-cursor-advanced local ops (see `docs/architecture/data-and-events.md` § "Durable retry: correctness vs. staleness (#2509)" for why `ApplyOp` loss is not recoverable by the next boot the way a cache is). Global cache tasks use the literal `'__GLOBAL__'` as `block_id`, and `ApplyOp` uses `'__APPLY_OP__'`, because SQLite STRICT mode forbids NULL in PK columns. The sweeper retries with exponential backoff (1m → 5m → 30m → 1h cap), so the **worst-case staleness window for caches is bounded by the 1h backoff cap** — until either (a) the next block-structure mutation re-dispatches the rebuild, or (b) the persistent retry-queue sweeper picks the dropped task up. The `bg_dropped` (total) / `bg_dropped_global` (subset attributable to global rebuilds) counters surface class-(a) drop-then-persist events on `StatusInfo`; `fg_apply_dropped` / `fg_apply_dropped_persisted` do the same for class (b). `BatchApplyOps` itself is not directly persisted — a batch failure fans out into one `ApplyOp` row per record. Truly non-retryable tasks (`Barrier`, `RebuildFtsIndex`, `FtsOptimize`, `CleanupOrphanedAttachments`, `RemoveFtsBlock`, `ReindexFtsReferences`) are intentionally not persisted.
- **Tag inheritance:** Materialized `block_tag_inherited` table, maintained transactionally by command handlers + background rebuild task. Replaces recursive CTEs for `include_inherited=true` queries.
- **Commands:** Tauri command handlers in `src-tauri/src/commands/`, split by domain — the `blocks/` and `pages/` subdirectories plus one module per domain (tags, properties, agenda, attachments, journal, queries, sync, spaces, …); `ls src-tauri/src/commands/` is the current list. Every command pairs a thin `#[tauri::command]` wrapper with a `*_inner` function taking `&SqlitePool` for testability. Patterns and the end-to-end "add a command" recipe: [`src-tauri/src/commands/AGENTS.md`](src-tauri/src/commands/AGENTS.md).
- **Sync daemon:** `sync_daemon/` — background task with mDNS discovery, a QUIC server accepting connections from the iroh endpoint, initiator-side sync via `SyncOrchestrator`. Per-peer backoff via `SyncScheduler`. Supports file (attachment) transfer alongside op sync.
- **Sync transport:** `transport/` — QUIC over iroh (#78, plan #3464), which replaced the hand-rolled WebSocket-over-mTLS stack (`sync_net`, `sync_cert`, `sync_daemon::wire`) deleted in #3544. `endpoint::lan_only` pins the LAN-only posture — iroh's defaults publish device addresses to n0's relay and DNS services, and the `presets::N0DisableRelay` preset does *not* turn all of that off, so the guard tests in `endpoint` exist to keep a `cargo update` from silently re-enabling it.
- **Transport identity:** `transport/identity.rs` — the device's long-lived iroh secret key, generated once and reloaded thereafter. It must be persistent: `peer_refs.endpoint_id` (which replaced the retired `cert_hash`) is the pinned-identity column the responder's S-1 gate resolves inbound peers against, so a key regenerated per boot would unrecognise every paired peer after restart.

## TypeScript Bindings (specta)

`src/lib/bindings.ts` is auto-generated from the Rust command surface by tauri-specta. **It is the primary IPC surface — new code MUST import from `@/lib/bindings`.**

The hand-written wrapper layer (`src/lib/tauri.ts` plus the `src/lib/tauri/` modules) is legacy and being retired (#2927). Most of the frontend already calls `bindings.ts` directly; the remaining `@/lib/tauri` importers are frozen in `scripts/tauri-import-baseline.json` and the `tauri-import-baseline` prek hook **fails on any NEW `@/lib/tauri` importer** (and on a stale baseline entry, so the list can only shrink). When you touch a file that still imports the wrapper, migrating it off is the preferred fix.

Regenerate the bindings after any change to a command signature, an arg/return struct, or the command list — the `ts_bindings_up_to_date` test compares the committed file against a fresh export and CI fails on drift:

```bash
cd src-tauri && cargo test -- specta_tests --ignored
```

## Pre-commit & CI

- **Pre-commit:** `prek.toml` is the hook list — read it rather than trusting any summary here. Broadly it covers builtin file checks; secret + workflow security (gitleaks, zizmor, actionlint); frontend lint/format/typecheck/test (oxlint, oxfmt, tsc, vitest); Rust (cargo fmt/clippy/test/deny/machete); SQL + schema (sqruff, migrations-immutable, migrations-strict-tables); cross-cutting text checks (typos, shellcheck, taplo, markdownlint, lychee); supply chain (npm-audit, license-checker, knip); and a large set of repo-specific guards that mechanically enforce the invariants in this file. Hook-tool config lives in `_typos.toml`, `.taplo.toml`, and `.github/zizmor.yml`. The `migrations-immutable` hook enforces invariant #1 from the [invariants list](#key-architectural-invariants) at commit time.
- **Pre-push:** `verify-ci-equivalent` (`scripts/verify-ci-equivalent.sh`) is a fast-feedback subset of CI, **not** a full CI mirror (the hook ID is kept for stability). It runs sequentially: a **`dev.db` migration preflight** (#4266/#4330/#4334) ahead of Phase A whenever the push touches Rust or `src-tauri/migrations/*.sql` — it compares the migrations applied in your local `dev.db` against `src-tauri/migrations/` by version AND by sqlx's per-migration checksum, and blocks with the exact `sqlx migrate run` remedy rather than letting Phase D fail later with a confusing `no such table`. **This means adding a migration requires you to have applied it locally first**, even when nothing else in the diff queries the new table; a migration you EDITED after applying, or one applied in `dev.db` with no file on disk (what switching off a branch leaves behind), is reported too — re-provision with `scripts/setup-dev-db.sh` in that case. Then **Phase A** = every pre-commit hook against the whole tree; **Phases B–D** = vitest + cargo nextest scoped to the pushed commit range (`@{upstream}..HEAD`); **Phase D2** = `cargo test --doc --workspace` when any `.rs` changed (nextest skips doc-tests); **Phase E** = `cargo sqlx prepare --check` against all four `.sqlx/` lanes (root + `agaric-store`/`agaric-engine`/`agaric-sync`) when any `.rs` changed in range; **Phase F** = `agaric-mcp` release build + MCP UDS smoke, only when MCP paths change; **Phase G** = warn-only `cargo audit` + `npm audit signatures`. Deliberately **not** run locally (CI only): Playwright e2e, the full `vitest run` / `cargo nextest run --profile ci` suites, the coverage-ratchet and bundle-budget gates, and the desktop bundle / cross-OS / SLSA build. A green pre-push is therefore **not** CI-equivalent — if you touched interaction-heavy code, run `npx playwright test` manually before pushing. **Push with [`scripts/push.sh`](scripts/push.sh) (or `just push`), not raw `git push`, for anything that changes `.rs`.** A raw `git push` opens and *holds* the SSH connection for ref negotiation **before** the multi-minute pre-push verify runs; GitHub closes the now-idle connection during the verify, so the pack upload then fails with `Connection to github.com closed by remote host` / `failed to push some refs` — even though the local gate passed in full. `scripts/push.sh` runs the verification **first** (no connection open), then pushes with the hook short-circuited so the fresh connection uploads immediately. It forwards all `git push` args (`-u origin <branch>`, `--force-with-lease`, …). Light pushes (docs/lockfile → fast prek-only hook) survive a raw push; anything triggering the full nextest gate needs the wrapper. `SKIP_CI_VERIFY='<reason>' git push` is the escape hatch for docs-only fixes — the value must be a real reason (≥8 chars); a bare truthy flag (`SKIP_CI_VERIFY=1`) is hard-rejected. Use e.g. `SKIP_CI_VERIFY='docs typo, no source change' git push`. Release pre-flight bundle build is opt-in via `scripts/verify-release-build.sh` (not in pre-push — too slow for daily cadence).
- **Serialize the HEAVY gate; parallelize only the work in front of it.** A push whose diff triggers the nextest/clippy lanes is the one step that must never run concurrently with itself: two or more at once are silently killed by an OOM reaper (`earlyoom` on the current dev box — host-specific, but assume some equivalent), the branches never reach the remote, and nothing reports a failure. Light pushes (docs, lockfile → the fast prek-only hook noted above) do not contend and need no serializing. Fan out builders and reviewers as wide as the work allows. Three traps around the heavy gate, each of which reads as something other than what it is — and in all three the branch keeps its commits, so nothing is lost but the run:
  - A heavy gate outlives the agent harness's 10-minute foreground command limit (a property of the harness, not of this repo's tooling), so it must be backgrounded — and then **left alone**.
  - **Never remove or move a worktree while its gate is running.** The run dies with a bare `error spawning child process … No such file or directory`, which looks like a broken toolchain.
  - A gate can pass on the commit you are pushing and the push still be rejected, when the remote ref needs `--force-with-lease` (e.g. you rebased *before* running the gate, so the remote holds a superseded SHA). That — the gate having already passed **on this exact SHA**, with only the ref update failing — is the one legitimate `SKIP_CI_VERIFY` case beyond docs, and the reason string must say so. It is **not** a licence to skip after a rebase in general: a rebase rewrites SHAs, so if the gate ran on the pre-rebase commits it has not run on what you are pushing.

  When a run is interrupted, confirm with `git ls-remote origin <branch>` rather than an exit code — but note that is about **backgrounded** runs, where the outer shell masks a SIGKILL. `scripts/push.sh`'s own exit code is trustworthy by construction: its `verify_landed` step re-reads the remote ref and the #3883 contract defines exit 0 as verified, pushed, *and* confirmed landed.
- **CI:** `.github/workflows/_validate.yml` is the reusable validation workflow — a `detect-changes` job gates focused downstream jobs (`lint`, `docs-lint`, `vitest`, `playwright` (sharded), `cargo-tests`, `cargo-coverage`, `mcp-tests`) behind a `validate-all` aggregate. `ci.yml` consumes it and adds a Linux desktop bundle build plus an Android job. `release.yml` runs the cross-OS bundle matrix (`ubuntu-24.04`, `windows-2025-vs2026`, `macos-15`), SLSA attestation, and release upload on tag pushes. `scheduled-deep-checks.yml` carries the bench lanes. See the workflow files for the current job graph and shard counts.

### Guards earn their keep

The hook list in `prek.toml` is **capped**, and the cap is enforced (`scripts/check-hook-budget.mjs`). Adding a guard is a trade, not an addition.

**A guard may be added only when all five hold:**

1. **The defect has occurred.** Cite the PR, issue, or session log where this exact class shipped or nearly shipped. "Could happen" is not evidence.
2. **Nothing already catches it** — not `rustc`, `tsc`, `oxlint`, `clippy`, `sqruff`, `typos`, `knip`, the test suite, or another guard. Say which you checked.
3. **It runs in under 500 ms**, or it is CI-only (`stages = ["manual"]`).
4. **It fails loudly:** the message names the file, the line, and the fix.
5. **It fails closed:** an unrecognised input shape is a violation, never a skipped line. A guard that cannot see a construct does not report a gap — it inflates its own clean result (#4482, #4484, #4486, #4490; [session 1418](docs/session-log/session-1418-the-spelling-the-guard-could-not-see.md)).

**Adding a guard requires deleting or explicitly justifying every guard it overlaps.** Name them in the PR body. "It's a different angle on the same invariant" is a reason to merge, not to add.

**Every hook carries a `# WHY:` line** immediately above it, in the form
`# WHY: <defect class> — <#issue or session log where it occurred>`.
A hook without one does not merge — `check-hook-budget.mjs` checks that the line is *present*, never what it says.

**Self-tests.** A guard gets a self-test **only if it parses source text with its own parser** — only those can fail open silently. Guards that glob filenames, compare exit codes, diff a baseline, or grep a fixed string do not qualify; a defect in those surfaces as a false positive, which is self-announcing. **Today the surviving self-tests are still `pre-commit`-staged.** The target is CI-only (`stages = ["manual"]`, run by a `--hook-stage manual` step in `_validate.yml`), and the restaging plus that step are Phase 2 of #4556 — not yet landed, so do not describe the repo as if they were. A NEW self-test should be added `manual`-staged regardless, so Phase 2 has less to move. A script that is not itself a guard hook does not get a self-test hook — if it needs tests it gets a vitest file, like `scripts/check-bundle-budget.test.mjs`.

**Three corollaries, in order of how often they bite:**

- A guard whose failure mode is a confusing error is **worse than no guard**.
- A guard that has never fired on a real defect is a **liability**, not insurance. Delete it.
- A guard that needs its own guard is a **smell**. Two levels of meta is the limit; three means the design is wrong. `check-hook-budget.mjs` is held to this first: it counts a fixed string, has no fixtures, and has no self-test on purpose.

**Deleting a guard needs no justification beyond this section.** The burden is on adding.

## Releases

Cut a release with one command from a clean `main`:

```bash
scripts/release.sh <new-version>        # e.g. scripts/release.sh 0.2.1
```

`scripts/release.sh` is the single canonical entry point (full guide: [`docs/BUILD.md` § Releasing](docs/BUILD.md#releasing)). It runs a preflight (clean tree, `HEAD` on `main`, local `main` in sync with origin, tag not already taken locally or on origin), then a local release-build check (`scripts/verify-release-build.sh`), then delegates to `scripts/bump-version.sh <version> --commit --tag --push`. The Release workflow (`.github/workflows/release.yml`) fires on the resulting tag push: `verify-version` (the first job — **fails fast** if the tag and the manifests disagree) → `validate` → cross-OS build matrix → Android APK → provenance/SBOMs → a draft GitHub Release, which the final `publish-release` job flips to published only if **every** terminal job succeeded.

**Cutting a release is the maintainer's call — never run `scripts/release.sh` or push a release tag on their behalf.** Publication is automatic once the tag lands, so pushing a tag *is* publishing.

**Always use the automation; never hand-edit manifests for a release.** `scripts/bump-version.sh` is the source of truth for the lockstep bump: it updates every version manifest (`package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/fuzz/Cargo.lock`, `src-tauri/tauri.conf.json` — the script's own `Files updated:` header is the authoritative list; **`src-tauri/fuzz/Cargo.lock` is easy to forget** because it lives in the fuzz crate's own workspace, outside every parent-workspace cargo command, and every release from 0.7.1 to 0.9.8 shipped it stale), GPG-signs the commit + annotated tag, and pushes `main` + the tag. The `package-lock.json` bump is a two-field `jq` edit (pinned-dependencies-safe; restore `npm install --package-lock-only --ignore-scripts` only if a future bump needs a dependency-graph change). It refuses to run on a dirty tree, off `main`, or over an existing tag. Use its flags to stop short of a full push (`--commit`, `--tag`, `--push` are cumulative), or `scripts/release.sh --dry-run` to bump + tag locally without pushing.

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
- **Rust doc-tests (`/// # Examples`):** Reach for these only on **pure, self-contained helpers** where one canonical input→output example is the best possible documentation — e.g. `OpType::as_str`/`FromStr`, `BlockId::from_string`/`from_trusted`, `TagExpr::depth`/`validate_depth` (#2555). The example must be a runnable ```` ``` ```` block (executed by `cargo test --doc`, wired into CI + pre-push — `cargo nextest` does **not** run doc-tests) and the item must be reachable through a public path (`pub` in a `pub mod`; a `pub` fn behind a private/`pub(crate)` module is **not** collected as a doc-test, so don't put one there — it would silently rot). **Do NOT** doc-test anything needing a sqlx pool, Tauri state, or async fixtures — doc-tests can't reach the shared `tests/` fixtures and each compiles as its own binary (real CI cost at scale). The happy-path + error-path `#[cfg(test)] mod tests` rail stays primary; doc-tests are documentation that happens to be verified, not a second suite. `compile_fail` doc-tests are a niche tool for pinning API-misuse invariants (asserting something must *not* typecheck) — use rarely, only where a normal test cannot express the invariant.
- **Frameworks:** vitest-axe, fast-check (property tests), insta (Rust snapshots)
- **Benchmarks:** Criterion. Bench files live in `src-tauri/benches/`, parameterized at multiple scales (100/1K/10K/100K where relevant). **CI runs every bench, but only weekly** — `.github/workflows/scheduled-deep-checks.yml` carries `bench-smoke` (sharded `cargo bench --no-run` per slice, then a `--test` smoke run that fails on a drifted seed/fixture) and `bench-slo` (the warm `interactive_slo` mean-budget gate), both on the Monday cron plus manual `workflow_dispatch`. `ci.yml` and `_validate.yml` contain **no** bench job, so benches are not a per-PR merge gate and a perf or fixture regression can land green and stay latent for up to a week — run `cd src-tauri && cargo bench` (or the local smoke loop) yourself on perf-sensitive changes. `cargo check --bench` is *not* verification. See [`src-tauri/benches/AGENTS.md`](src-tauri/benches/AGENTS.md).
- **Tarpaulin:** Expensive (~60s). Only run when working on coverage gaps.
- **Exact count assertions:** Prefer `assert_eq!(count, 5)` over `assert!(count >= 1)`. Inequality assertions hide duplicate results and missing filters.
- **Silent catch blocks forbidden:** Never use `.catch(() => {})`. Use `logger.warn` or `logger.error` for all catch blocks — silent error swallowing masks real bugs.
- **React 19 test timing:** state updates originating from non-React event sources — worker `dispatchEvent`, `window.setTimeout` / `setInterval` callbacks, IPC promise resolutions chained off external events — no longer flush within a bare `await new Promise(r => setTimeout(r, 0))` tick. Wrap such waits in `act(async () => { ... })`, switch sync `getByText` to async `findByText`, or `waitFor` on the observable end state. Do not add arbitrary sleeps.
- **Detailed conventions:** `src-tauri/tests/AGENTS.md` (Rust), `src/__tests__/AGENTS.md` (frontend)

### Acceptance is falsification, not assertion

"Add a test" is satisfiable by a test that cannot fail. State the acceptance criterion as **the failure you expect to see**, then produce it: break the production code the test covers, run it, read the RED output, restore. A test whose failure you cannot demonstrate has not been shown to cover anything.

Where mutation testing reaches the code, "the mutant dies" is the strongest form of this and cannot be satisfied vacuously:

```bash
node scripts/run-mutation.mjs <module>      # frontend; <module> validated against stryker.modules.mjs
cd src-tauri && cargo mutants --workspace   # Rust; --workspace is MANDATORY, not a tuning flag
```

**`--workspace` is load-bearing.** `src-tauri/`'s root manifest is itself the `agaric` package with no `default-members`, so a bare `cargo mutants` generates mutants only in `agaric`: three of the four `examine_globs` in `src-tauri/.cargo/mutants.toml` match nothing and the surface collapses to `src/reverse/**` — a small fraction of the mutants the config asks for (the measured before/after counts live with the measurement, in `.github/workflows/scheduled-deep-checks.yml`; don't copy them here, they drift). Without it you run the strongest form of acceptance verification over a fraction of the intended surface, see no survivors, and conclude the mutants died — shape 1 below, committed by the tool meant to prevent it. Nothing catches this locally: `scripts/check-mutants-scope.mjs` reads only the CI lane's invocation, so a bare local run just quietly gives you the smaller surface. An explicit `-p` per package works too; what the guard rejects is leaving the scope inherited from cargo's default-member rules. The config is keyed to the workspace root by its *path*, so any cwd inside `src-tauri/` finds it (#3386).

Three failure modes recur, are cheap to spot, and each has a recorded instance. Issue numbers get closed and re-scoped, so where a session log records the run, it is cited alongside — that log is append-only:

1. **The vacuous assertion** — restates a precondition the test itself established. Ask: *what production change would redden this?* If the answer is "none", it is decoration. #3454 *proposed* a test for the `exact_match_nocase` gap ("insert `Urgent`, query prefix `urgent`, assert the exact match is returned and hoisted") that passes with the function stubbed to `Ok(None)`, because the code then falls through to `exact_match_normalized`, which matches the same ASCII case-variant — caught by reading the issue, before the test was ever written ([session 1269](docs/session-log/session-1269-tag-query-mutants.md)).
2. **The unreachable condition** — a guard whose branch cannot be taken reads as coverage and supplies none. This is not a test gap; deleting the code is the only thing that clears its mutants (#3809, [session 1292](docs/session-log/session-1292-locale-independent-folding.md)).
3. **The half-covered pair** — one arm of a symmetric property pinned and the other left open: a snapshot's column set checked while the restore projection is not (PR #3425, [session 1263](docs/session-log/session-1263-spaces-rebuild-guard.md)), a guard body tested while its invocation is not (#3435, `src-tauri/src/commands/attachments.rs`). Ask of every guard: *is the call site covered as well as the body?*

Shape 1 is the general case of "Assert durable, re-queried effect — never call-shape" in [Testing invariants (anti-drift)](#testing-invariants-anti-drift): a call-shape assertion is a vacuous assertion whose precondition is "the frontend asked".

**The same defect appears in prose, where it is easier to miss.** A comment, ledger entry, or issue body asserting that something has been checked reads as already-verified and so gets re-read rather than re-run. Treat the assertion as the hypothesis and the run as the evidence — re-reading reasoning reproduces the reasoning, including its mistake. Concretely:

- A citation must resolve: "filed separately" with no issue number is a dead end wearing the costume of diligence. Cite the number, and put the explanation in the code comment rather than the PR body — the comment is what a future reader hits first.
- A comment must not describe code that no longer exists. When deleting code, grep the whole file (not just the diff) for text quoting it; equivalence ledgers must be **edited down**, never left describing deleted fragments.
- Prefer naming the *condition* over a `line:col`, which drifts silently.
- When something genuinely cannot be tested, write that into the module docs with the reason — a residual-coverage note that lives with the code, not an assertion left to be read as a result.

### The instrument must discriminate before its reading counts

A diagnosis rests on measurements the way a test rests on assertions, and it fails the same way: **a probe that returns the same reading whether the system is healthy or broken has measured nothing** — but its output still reads like a result, and gets quoted downstream as one. The four checks below are the diagnostic counterpart of the shapes above.

- **Record a control reading first, in a state whose answer you already know.** #3852 diagnosed an Android pairing deadlock from `adb shell ss -u -a -n` returning no sockets for the app's pid. But `ss` runs as uid `shell` and cannot attribute sockets to another app's pid, so empty is the *expected* output of an unprivileged query, not evidence of zero sockets — and that single unsound reading was the only thing distinguishing the issue's theory from its alternative. The replacement probe is trustworthy only because its control was recorded first: `adb shell dumpsys wifi | grep -ci agaric-mdns` → `0` while the daemon had provably just logged `starting in dormant mode`, so a later non-zero count is positive evidence that `daemon_loop` ran (the lock is tagged `agaric-mdns` in `android_multicast.rs` and is acquired only inside `daemon_loop`). Without the control, both `0` and non-zero would have been unfalsifiable.
- **A diagnostic recipe is a guard — lex it like one.** In a multi-alternate `grep -E`, an alternate that cannot match reports "clean" for that condition forever. #3852's suggested command greps `post-dormant exited`; the emitted line is `SyncDaemon (post-dormant) exited with error`, where the two words are separated by `) ` rather than a single space, so that substring never occurs and absence of the line was guaranteed regardless of whether the branch fired. (Plain textual mismatch, not an escaping bug — which is why reading the pattern is not enough to catch it.) Paste each alternate against the real string before trusting a silent grep. The corollary for the other direction: **changing a log string can break someone's diagnostic** — grep issues and docs for a message before rewording it.
- **Verify a stated blocker before inheriting it.** #3852 recorded that a release build does not emit to logcat, and therefore that a debuggable build was needed to make progress; it blocked the diagnosis for days. It is false (see [Android](#android)). A blocker written in an issue is a claim, not a fact, and costs the most precisely when it is the reason nobody looked.
- **Absence of output is not evidence of absence.** A long command piped into `tail` buffers until close, so an empty stream mid-run means nothing; reading that silence as failure cost a redundant re-run of an already-successful push. Confirm the durable effect — remote SHA, `HEAD` moved, file mtime, exit status — never the stream.

### Testing invariants (anti-drift)

The browser/e2e Tauri mock (`src/lib/tauri-mock/`) is a hand-maintained **second implementation** of the Rust backend that silently drifts from it (create_block page_id, purge_block cascade, reserved-key property routing, the tag-space bug all shipped past a mock that looked fine). Three invariants keep the two implementations honest:

1. **Assert durable, re-queried effect — never call-shape.** A mutation test that only asserts `expect(invoke).toHaveBeenCalledWith(…)` (or that a mock fn was called) is insufficient: it proves the frontend *asked* for a change, not that the change *persisted correctly*. Persist, re-query, and assert the observable resulting state. The tag-space bug shipped precisely because a test asserted `setProperty(key: 'space')` was called and never re-queried — the mock modeled a retired schema and the tag vanished in production. Details per layer: [`src/__tests__/AGENTS.md`](src/__tests__/AGENTS.md), [`src/stores/__tests__/AGENTS.md`](src/stores/__tests__/AGENTS.md), [`src/components/__tests__/AGENTS.md`](src/components/__tests__/AGENTS.md).
2. **The mock is a contract, pinned by conformance fixtures.** Every state-mutating handler must be driven by a `conformance/fixtures/*.json` fixture whose `expected` is authored by the backend (`CONFORMANCE_UPDATE=1 cargo nextest run -E 'test(conformance_fixtures_match_backend)'`), asserted by BOTH the real backend (`src-tauri/src/command_integration_tests/conformance.rs`) and the mock (`src/lib/tauri-mock/__tests__/conformance.test.ts`). [`conformance-coverage.test.ts`](src/lib/tauri-mock/__tests__/conformance-coverage.test.ts) (#3083) ratchets this: a new mutating command fails the suite without a fixture or a justified allowlist waiver. **Read commands are pinned the same way** (#3347): a fixture may carry a `queries` array of post-op read steps whose projected responses the backend authors into `expected_queries` through the same `CONFORMANCE_UPDATE=1` flow, and the ratchet fails a new read command that has neither a query step nor a reasoned `READ_NO_QUERY_ALLOWLIST` waiver. "Read command" is decided by `isReadOnly` in that file — a list of query-verb prefixes (`get_`, `list_`, `query_`, `search_`, `count_`, `read_`, `find_`, `compute_`, `resolve_`, `load_`, `is_`, `collect_`, `export_`) plus a `READ_ONLY_EXACT` set for names that carry no such prefix (`run_advanced_query`, `filtered_blocks_query`, …); treat that code as the source of truth rather than this sentence — wiring a new read command means one arm in `conformance_query.rs` plus one entry in the `WIRE` table of `conformance-query.ts`. Workflow + real-backend smoke status: [`e2e/AGENTS.md`](e2e/AGENTS.md).
3. **A schema migration updates the mock in the same PR.** When a migration changes a table/column the mock references, update the mock and its fixture together — the mock does not follow the schema on its own (#3084): [`src-tauri/migrations/AGENTS.md`](src-tauri/migrations/AGENTS.md).

A fixture only guards real behavior if the backend authors its `expected` from the **production path**, not a test-only fallback — see the #891 lesson (the runner drives ops through the foreground engine pipeline, `append_local_op` + `dispatch_op` + `settle`, and asserts the *settled* reprojected state; a test that silently exercised the SQL-only fallback produced false drift).

### Running tests efficiently

During development, run only the relevant check:

- Editing Rust? → `cd src-tauri && cargo nextest run --workspace -E 'test(specific_test_name)'`. `--workspace` matters even for a targeted filter: the bare form is package-scoped to `agaric` only, so if the test you're targeting lives in `agaric-core`/`agaric-store`/`agaric-engine`/`agaric-sync`/`agaric-observability`/`diagnostics` instead, nextest matches 0 tests (#3212). Use `cargo nextest`, NOT plain `cargo test`, for anything under `command_integration_tests::` — and read that requirement as a **shape, not a file list**. Any test that reads a **process-global counter**, does its work, reads the counter again and asserts on the **difference** is unsafe under plain `cargo test`, which runs a crate's tests as threads in ONE process: a sibling test's event lands on the same counter between the two reads, and the delta stops being a statement about the code under test. The counter here is `sql_only_fallback::count()` (re-exported as `crate::materializer::sql_only_fallback_count()`), a monotonic process-global `AtomicU64`, and the assertion is nearly always `delta == 0` — proof that *this* test's op took the engine path rather than the SQL-only fallback (#891). `command_integration_tests::conformance` is the reader that makes that module nextest-only today, but the counter is reachable from anywhere, so a NEW test of that shape — in any module — inherits the same constraint; nextest's process-per-test isolation is what makes the delta honest. **Not** the older reason: `conformance` / `undo_integration` do **not** share a process-global Loro engine registry any more — #2249 replaced the `OnceLock` global with an explicit `&LoroState` threaded down the apply path (each test's engine state is its own `Materializer`'s), and both files' module docs record the #1079 constraint as resolved. Don't reinstate the registry rationale. For the authoritative list of counter readers (a grep, deliberately not an enumeration) and the second process-global class (the `tracing` subscriber / `log::max_level()`), see [`src-tauri/tests/AGENTS.md`](src-tauri/tests/AGENTS.md) § "Process-global state".
- Editing TS? → `npx vitest run`
- Never run clippy/fmt/oxlint/oxfmt manually — prek hooks handle it at commit time
- Frontend checks are irrelevant when only Rust changed (and vice versa)

### Verifying UI behavior at runtime (Playwright + mock backend)

For UI work where unit tests can't fully prove behavior — toolbar buttons, pickers, overflow, popovers, editor round-trips — **drive the real app** instead of deferring. The Playwright e2e harness runs the actual frontend against the in-memory **tauri mock backend**, no native build required:

- `playwright.config.ts` auto-builds and serves a **static production bundle** (`webServer: npm run build:e2e && npm run preview:e2e`) — #1458 replaced the old `npm run dev` server, which stalled under sharded CI load and failed every test on the shard. The tauri mock survives the production build because `main.tsx` gates it on `(!import.meta.env.PROD || import.meta.env.VITE_E2E) && !window.__TAURI_INTERNALS__`, and `build:e2e` sets `VITE_E2E=1`. See [e2e/AGENTS.md](e2e/AGENTS.md).
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
7. **No side effects inside `debug_assert!`:** the release profile compiles `debug_assert*!` bodies out entirely (`debug-assertions` off, `panic = "abort"`, `strip`), so any mutation or effect in the asserted expression silently vanishes in production while passing every debug/test build. Assert only on pure reads (`.is_empty()`, `.len()`, `.contains()`, comparisons, a value already bound in a `let`). If an invariant must hold in release too, promote it to a release-active `return Err(...)` / `assert!` on the production path — see the `debug_assert!` + release-build `InvalidOperation` pairing in `materializer/handlers/apply.rs` and `dag::insert_remote_op`.

## Search & FTS

Architectural contract for the search surface. Detail and rationale live in [`docs/architecture/search.md`](docs/architecture/search.md); the invariants below are the load-bearing rules — a contributor must follow them to avoid breaking the codebase.

1. **`SearchFilter` is the canonical extension struct for `search_blocks`.** New filter dimensions land as additional fields on `SearchFilter` in `src-tauri/agaric-store/src/search_types.rs` (re-exported from `src-tauri/src/commands/queries.rs`) — never as new positional arguments on the Tauri command. Every new field MUST carry `#[serde(default)]` so older frontend bindings stay backward-compatible across the regen cycle. Mirrors the `ExtraQueryFilters` precedent in `src-tauri/src/commands/mod.rs`.
2. **`SearchBlockRow.snippet` carries literal `<mark>` boundaries from FTS5.** The boundaries are opaque marker strings, not HTML. The frontend never feeds this field to `dangerouslySetInnerHTML`. Renderers split the string on the literal marker pairs and emit alternating React text nodes and `<mark>` elements; React escapes stray `<`, `&`, or HTML-shaped content as text. No DOMPurify dep, no XSS surface. **New rendering paths consuming `snippet` must follow the same pattern.**
3. **Filter primitives — the parser is the single source of truth.** The inline filter syntax (`tag:#name`, `path:GLOB`, `state:`, `priority:`, `due:`, `prop:` …) lives at `src/lib/search-query/`. The query string is the canonical state; chips and IPC fields are derived by `parse()` + `astToFilterProjection()`. Surfaces consuming the AST MUST NOT fork the parser — register new token prefixes through `registerTokenPrefix` and declare their `ALLOWED_KEYS` statically rather than re-parsing the query string. The round-trip invariant `parse(serialize(parse(s))) === parse(s)` is enforced by `fast-check` property tests.
4. **`MatchOffset` carries UTF-16 code-unit offsets, NOT bytes.** Rust `regex` matches return byte offsets into UTF-8 buffers; JavaScript indexes UTF-16. The conversion happens in Rust before serialising (`fts::toggle_filter::byte_to_utf16_offsets`) so the frontend can slice `row.content.substring(start, end)` directly. `日`/`本`/`語` are 3 bytes / 1 UTF-16 code unit each; `🌟` is 4 bytes / 2 UTF-16 code units. Frontend renderers must NOT re-convert.

## Pages view

Architectural contract for the Pages browser. Detail and rationale live in [`docs/architecture/pages-view.md`](docs/architecture/pages-view.md); the invariants below are the load-bearing rules — a contributor must follow them to avoid breaking the codebase.

1. **PageBrowser cursor schema is v2 over the existing `Cursor` struct.** `list_pages_with_metadata` (`src-tauri/src/commands/pages/metadata.rs`) rejects mismatched / stale cursors with `AppError::validation_coded(ValidationCode::RequiresRefresh, …)`; the frontend recognises the structured `RequiresRefresh` code (#2251 — `validationCode(err) === ValidationCode.RequiresRefresh`, no longer a message prefix) as a recovery signal (drop cursor, refetch page 1, optionally toast). `CURRENT_CURSOR_VERSION` itself stays at `1`; the v2 designation refers to the semantic schema layered over the existing `Cursor` slots. The new sort modes encode their primary-sort key into existing slots (`Cursor.deleted_at` for ISO timestamps / strings, `Cursor.seq` for i64 counts, `Cursor.position` for the sort-mode discriminator, `Cursor.id` as tiebreaker). **Any new paginator using a non-id sort key must reuse the existing typed slots in the same compound-overload pattern, not add a new field to the `Cursor` struct.**
2. **Density preference lives under the `page-browser-density` localStorage key.** Default `regular`. The mode is the bare string (`compact` / `regular` / `expanded`), not JSON-wrapped. Row heights are defined once in `DENSITY_ROW_HEIGHT` (`src/hooks/usePageBrowserDensity.ts`); no other component hardcodes 32/44/68. Every row carries `data-density={mode}` — that attribute is the contract integration tests assert against.
3. **`DensityRow` is Pages-specific.** Lives at `src/components/PageBrowser/DensityRow.tsx`. **Do not import it from outside `PageBrowser/`.** If a second consumer (TrashView, HistoryView, …) needs this shape, propose an extraction PR first — premature extraction couples three views to a single primitive that has to grow optional props for each one's metadata.
4. **Sort comparators must not allocate per-comparison.** Any expensive lookup (the `getRecentPages()` `Map`, the metadata accessor) is materialised once before `Array.sort`; the comparator body reads scalars off rows and returns an integer. No `.map`, no `new Date()`, no closure-over-row inside the comparator. Adding a sort mode to `usePageBrowserSort` follows this pattern.

## Filters

Cross-surface filter contract. Detail and rationale live in [`docs/architecture/filters.md`](docs/architecture/filters.md); the invariant below is the load-bearing rule.

1. **The `FilterPrimitive` / `Projection` engine is the cross-surface filter contract, wired into BOTH surfaces.** A `FilterPrimitive` (`src-tauri/agaric-store/src/filters/primitive.rs`) is a *value*; a `Projection` impl is *how it compiles to SQL* for a surface. Per-surface behaviour lives **only** in two places: the `PAGES_ALLOWED_KEYS` / `SEARCH_ALLOWED_KEYS` static sets (which keys a surface admits) and that surface's `Projection` `compile_*` impl (how it compiles). Adding a primitive to a surface is a **deliberate diff in both** `ALLOWED_KEYS` and the `Projection` impl — never a silent two-codepath drift. Pages-only `compile_*` reads materialised `pages_cache` columns and requires the caller to `LEFT JOIN pages_cache pc ON pc.page_id = b.id`; compiled fragments are cost-ordered (`cost_hint`) and have their `?` placeholders renumbered to explicit `?N` positions before splicing. **Current reality (post-#1320 / #1280 B2):** `PagesProjection` backs the Pages metadata-filter IPC, and `SearchProjection` is production-wired through the FTS filter builder (`src-tauri/agaric-store/src/fts/filter_builder.rs` / `metadata_filter.rs` / `toggle_filter.rs`) — space, last-edited, state, priority, block-type, has-property, ALL-tags, and page-glob search filters all compile through it, with several `compile_*` arms delegating to the canonical `PagesProjection` SQL so the two surfaces cannot drift. What has NOT moved: query *parsing* — the inline-query parser at `src/lib/search-query/` (see *Search & FTS* invariant 3) still owns Search's syntax and a few legacy fragments noted in `filter_builder.rs` remain deliberately non-byte-identical. So route any NEW search filter dimension through `SearchProjection` (do not extend the legacy fragments), and do not assume the parser layer is projection-backed.

## Android

- **Status:** Both debug and release APKs build, install, and launch successfully.
- **Release APK:** ProGuard/R8 minification is on and shrinks the release build by roughly an order of magnitude vs debug — keep the keep-rules verified when adding reflection-based deps.
- **On-device diagnosis starts with `adb logcat | grep RustStdoutStderr`** — this works on a **release** build and needs no debuggable one. Only `run-as` (reading app-private storage) genuinely requires a debuggable build.
- **Why that works, since it is easy to assume otherwise:** `init_logging` (`src-tauri/src/lib.rs`) attaches a stderr `fmt` layer with no `cfg(debug_assertions)` gate, and `tao`'s `ndk_glue::create()` unconditionally `dup2`s `STDOUT_FILENO`/`STDERR_FILENO` into a pipe forwarded to `__android_log_write` under the tag `RustStdoutStderr` — gated on neither `isDebuggable` nor the Cargo profile, and no crate enables `tracing/release_max_level_*`. Verified both by reading `tao` and by observing a shipped 0.9.6 release APK emit its full `tracing` stream. Do not confuse it with the `shouldLog() = BuildConfig.DEBUG` gate in `src-tauri/gen/android/app/src/main/java/com/agaric/app/generated/Logger.kt` (generated, gitignored): that is Tauri's Kotlin-side WebView logger, a different pipe that does not carry these lines. #3852 stalled for days on the opposite belief.
- **That `tao` module path is version-sensitive.** `tao` is a transitive crates.io dependency, not vendored, so it is unverifiable from a fresh checkout and can move across upgrades — see `src-tauri/Cargo.lock` for the pin in force, and re-check the claim when the Tauri stack moves ([Coupled Dependency Updates](#coupled-dependency-updates)).
- **Generated project:** `src-tauri/gen/android/`
- **Min SDK:** 30 (Android 11), **Target/Compile SDK:** 36, **NDK:** 27, **Java/Kotlin target:** 17
- **Architectures:** 64-bit only — `aarch64` (release, physical devices) and `x86_64` (emulator smoke tests). 32-bit `armv7-linux-androideabi` and `i686-linux-android` Rust targets are **not** supported; do not re-add them to docs/BUILD.md, CI, or `scripts/patch-android-build.sh`.
- **Emulator AVD:** `spike_test` (x86_64, API 34) — start with `emulator -avd spike_test -gpu host &`
- **DB path:** `/data/data/com.agaric.app/notes.db` (via `app.path().app_data_dir()`)
- **Known issues:** See open GitHub issues (deferred by design).
- **Headless testing:** See [docs/BUILD.md](docs/BUILD.md#installing-on-emulator) for ADB recipes and emulator setup.

## State Files

| File | Purpose | When to update |
|------|---------|---------------|
| `docs/session-log/session-NNN-<slug>.md` | Per-session activity log (one file per session; see `docs/session-log/README.md`) | A new file at the next session number for each session |
| [GitHub Issues](https://github.com/jfolcini/agaric/issues) | Deferred items, tech debt, future features | File with `gh issue create` only when the item names who is hurt and how — a user-visible failure you are deferring, something that blocks planned work, or a design decision. Mechanical cleanups get fixed in the PR; deliberate trades get a code comment. See `.claude/skills/batch-issues/SKILL.md` §4 "Disposing of a review finding" |
| `docs/FEATURE-MAP.md` | Complete feature inventory for discovery/review | When features are added/changed (keep in sync with SESSION-LOG updates) |
| `AGENTS.md` | This file | Only with explicit user approval |

For orchestrator workflow details, see [the `batch-issues` skill § 2. BUILD](.claude/skills/batch-issues/SKILL.md).

<!-- code navigation -->
## Code Navigation

**Prefer symbol-aware navigation over text scanning when your agent has it.** Symbol tools
resolve definitions and references instead of matching strings, so they are both cheaper and
correct across renames, re-exports and same-named symbols.

Two servers are relevant, and they differ in where they are configured:

- **`code-review-graph`** is the one this repo declares, in [`.mcp.json`](.mcp.json). It is
  **optional** — see [CONTRIBUTING.md](CONTRIBUTING.md#optional-code-review-graph-mcp) for
  how to enable it. It is not started unless `uvx` is present, and a client may disable it,
  so **do not assume it is available**: probe, and fall back rather than stalling.
- **[Serena](https://github.com/oraios/serena)** is configured *client-side* (in the agent's
  own MCP config, not in this repo), so whether it is present depends on who is driving. When
  it is, its symbol tools are the primary read/edit path:

| Task | Tool |
| ---- | ---- |
| A file's structure | `get_symbols_overview` |
| A specific symbol's body | `find_symbol` (`include_body=true`) |
| Callers / references | `find_referencing_symbols` |
| Declarations / implementations | `find_declaration` / `find_implementations` |
| Edit a symbol in place | `replace_symbol_body` |
| Insert near a symbol | `insert_before_symbol` / `insert_after_symbol` |
| Rename a symbol | `rename_symbol` |
| Delete a symbol safely | `safe_delete_symbol` |

Use Grep/Glob/Read when no symbol server is available, when the tool fails on the target,
when the file is not parseable as code, when you need a regex sweep the symbolic tools cannot
express (fine as a *discovery* step — follow up symbolically for the reads and edits), or
when a handful of lines is genuinely all you need. **Neither server is a prerequisite for
building, testing or contributing.**

**A symbol server's root is the MAIN checkout.** A subagent working in a git worktree that
uses *editing* tools writes into the main checkout, not the worktree. Reads are safe; edits
from a worktree must go through Read/Write/Edit with absolute paths.

> **History.** This section previously told agents to **always** use the `code-review-graph`
> tools before Grep/Glob/Read, and stated that the graph "auto-updates on file changes (via
> hooks)". The hook claim is not backed by anything in the tree — the only entry in
> [`.claude/settings.json`](.claude/settings.json) is `SessionStart` — and the unconditional
> instruction is wrong for an optional server that is frequently absent or disabled, which
> made the file's most emphatic rule its least reliable one.
