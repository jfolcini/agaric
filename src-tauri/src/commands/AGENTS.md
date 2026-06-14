# `src-tauri/src/commands/` — Tauri command handlers

> Rules for writing Tauri IPC handlers. Root [`AGENTS.md`](../../../AGENTS.md) covers cross-cutting invariants (error shape, IPC arg ceiling, materializer); this file covers patterns load-bearing in `commands/`.

## The `_inner` / Tauri-wrapper split

Every command has TWO functions:

1. **`*_inner`** — the load-bearing logic. Takes `&SqlitePool` (NOT `tauri::State<'_, SqlitePool>`). Returns `Result<T, AppError>`. **No `#[tauri::command]` decorator.** Testable from `src-tauri/src/commands/tests/`.
2. **`*` (the Tauri command)** — thin wrapper. `#[tauri::command] #[specta::specta]`. Resolves the `State` argument and delegates to `*_inner`. Does not contain business logic.

```rust
pub async fn delete_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: BlockId,
) -> Result<(), AppError> { /* logic */ }

#[tauri::command]
#[specta::specta]
pub async fn delete_block(
    pool: tauri::State<'_, SqlitePool>,
    device_id: tauri::State<'_, DeviceId>,
    materializer: tauri::State<'_, Materializer>,
    block_id: String,
) -> Result<(), AppError> {
    delete_block_inner(&pool, &device_id.0, &materializer, BlockId::from_trusted(&block_id)).await
}
```

Tests call `*_inner` directly with a `test_pool() + TempDir` fixture. The wrapper is exercised only by the Tauri runtime; we don't need to test it.

## `tauri-specta` 10-argument ceiling

The IPC bridge codegen has a hard 10-argument limit per Tauri command. `pool` + `device_id` + `materializer` already burn 3 slots; you have 7 for user args.

When you need more, bundle args into a request struct with `#[serde(default)]` on every optional field:

```rust
#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ListBlocksFilter {
    pub parent_id: Option<String>,
    pub tag_ids: Vec<String>,
    pub space_id: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
    // future fields here — `#[serde(default)]` keeps wire compat
}
```

Precedents: `SearchFilter`, `ExtraQueryFilters`, `AgendaQuery`, `ListPagesWithMetadataFilter`. See `src-tauri/src/commands/mod.rs` for the established naming.

## `CommandTx` for atomic multi-row writes

When a command needs to write multiple rows atomically (the user pressed one button, but the database needs to mutate N rows + emit N op log entries):

```rust
let mut tx = CommandTx::begin_immediate(pool, "command_label").await?;
// All writes ride the tx
// tx.enqueue_background(op_record) — for materializer dispatch after commit
tx.commit_and_dispatch(&materializer).await?;
```

- `BEGIN IMMEDIATE` (not `BEGIN DEFERRED`) — acquires the writer lock immediately, eliminating the "begin a tx, do read work, fail to escalate" deadlock surface.
- The label is used in tracing spans + lock-wait diagnostics.
- `commit_and_dispatch` does one `COMMIT` then enqueues pending `BatchApplyOps` for the materializer in one shot.
- **Cancellation safety**: once `begin_immediate` returns, the body up to `commit` is one cancellation-safe unit. If the future is dropped mid-execution (Tauri's IPC cancellation, panic, etc.), the tx rolls back. **No partial writes observable to other readers.**

## `*_by_ids` bulk commands: the `MAX_BATCH_BLOCK_IDS = 1000` cap

Bulk commands operating on a list of block IDs (`restore_blocks_by_ids_inner`, `set_todo_state_batch_inner`, etc.) MUST:

1. Reject empty `Vec` with `AppError::Validation`.
2. Reject `len() > MAX_BATCH_BLOCK_IDS` (`MAX_BATCH_BLOCK_IDS = 1000`; defined in `commands/properties.rs`).
3. Normalise ULIDs to uppercase via `BlockId::from_trusted` or the appropriate parser.
4. Resolve in **one query** via `json_each(?1)` — never N+1 loops.
5. Open exactly **one** `CommandTx::begin_immediate` per logical bulk op. Never chunk; one logical user action = one tx = one op-log seq range = one activity-feed entry.

```rust
pub async fn restore_blocks_by_ids_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<String>,
) -> Result<BulkRestoreResponse, AppError> {
    if block_ids.is_empty() {
        return Err(AppError::Validation("block_ids must not be empty".into()));
    }
    if block_ids.len() > MAX_BATCH_BLOCK_IDS {
        return Err(AppError::Validation(format!(
            "block_ids must contain at most {MAX_BATCH_BLOCK_IDS} ids",
        )));
    }
    let normalized: Vec<String> = block_ids.iter().map(|id| id.to_uppercase()).collect();
    let id_json = serde_json::to_string(&normalized)?;
    // one tx, one json_each resolve, one commit
    let mut tx = CommandTx::begin_immediate(pool, "restore_blocks_by_ids").await?;
    // …writes…
    tx.commit_and_dispatch(materializer).await?;
    Ok(response)
}
```

## `OpRef` chains via `LAST_APPEND` task-local

Multi-op commands (bulk delete, bulk tag, etc.) need the activity feed (`src-tauri/src/mcp/activity.rs`) to see ONE entry with N `additionalOpRefs`, not N entries. This is automatic if you:

1. Open one `CommandTx`.
2. Emit each op via `append_local_op_in_tx(...)` (the helper that pokes every fresh `OpRef` into the `LAST_APPEND` task-local).
3. Commit.

The dispatcher in `mcp/activity.rs` drains `LAST_APPEND` after the command returns and assembles the activity entry with the first op as the primary `OpRef` + the rest as `additionalOpRefs`. **Do not emit ops outside the tx; the task-local is only populated by `append_local_op_in_tx`.**

## `AppError` and typed-error prefixes

`AppError` serialises as `{ kind: string, message: string }` (manual `Serialize` at `src-tauri/src/error.rs`). The variants are open; the wire shape isn't a tagged union.

For **typed validation errors** that the frontend needs to discriminate (invalid glob, invalid regex, invalid filter, etc.), encode the sub-kind as a leading `"<Code>: …"` token in the `message`. The wire shape stays `{ kind: "validation", message }` (no `code` field) — the prefix lives inside `message`.

**#1061 — never hand-spell the prefix.** The sub-kind codes are defined once per language and referenced everywhere else, so a rename can't silently desync the ~triplicated holders (Rust emit / TS re-emit / TS parse):

- Rust source of truth: [`error::validation_code`](../error.rs) — `INVALID_GLOB`, `INVALID_REGEX`, `INVALID_DATE_FILTER` consts + the `prefixed(code, reason)` helper. Emit with:
  ```rust
  use crate::error::validation_code::{INVALID_REGEX, prefixed};
  return Err(AppError::Validation(prefixed(INVALID_REGEX, &reason)));
  ```
- TS source of truth: [`src/lib/search-query/validation-codes.ts`](../../../src/lib/search-query/validation-codes.ts) — `ValidationCode` consts + `prefixed` / `prefixToken` / `parseValidationReason`. The re-emitters (`glob-validate.ts`, `register.ts`) build messages via `prefixed(...)`; the parser (`useSearchResults.ts`) reads them via `parseValidationReason(...)`.

The two lists are pinned to identical strings by tests on each side (`glob_filter.rs::*_1061`, `validation-codes.test.ts`) — that pair IS the cross-language contract check; keep them in lockstep.

**Adding a new sub-kind:** add the const in BOTH source-of-truth files (identical string), reference it at the emit/parse sites, extend the pinning tests, and document it in [`docs/architecture/search.md`](../../../docs/architecture/search.md) and the relevant plan file. This keeps the wire shape stable while preserving the cross-language enforcement.

## Cancellation safety inside async commands

Tauri command futures can be dropped by the runtime (the user closes the app, navigates away). Anywhere you have a `.await` between a write and a commit, the drop point is a potential partial-write hazard. `CommandTx::begin_immediate` solves this by holding the lock + rolling back on drop. **Do not write directly to `pool.acquire()` without a tx for multi-row writes.**

## `_in_tx` variants

Some commands need to be callable both standalone AND as part of a larger transaction (e.g. inside a `bootstrap_*` path). The convention:

- `do_thing_inner(pool, …)` — standalone.
- `do_thing_in_tx(tx, …)` — takes an existing tx; doesn't commit. Returns the operation's effects so the caller can decide.

The inner-pool version usually wraps the in-tx version with its own `CommandTx::begin_immediate` + commit. Don't duplicate logic.

## `_local` / `record_append` helpers

When a command emits ops that need to participate in the activity-feed entry (`LAST_APPEND` task-local), use the `append_local_op_in_tx` helper. It writes to `op_log` AND records the `OpRef` in the task-local. The bare `INSERT INTO op_log` path skips the task-local; activity-feed entries are NOT emitted.

## Testing

Every `_inner` function gets a unit test in `src-tauri/src/commands/tests/`:

- Happy path
- Empty-list rejection (for bulk commands)
- Oversize-list rejection (for bulk commands)
- Atomic rollback on tx failure
- Op-log seq range contiguity (for bulk commands — the materializer's `BatchApplyOps` consumes ranges)
- Activity-feed contract (the OpRef chain has the right shape)
- Cross-space rejection (when the command takes a `space_id`)
- Missing-id tolerance (silent skip vs explicit error — match the command's documented behaviour)

See [`src-tauri/tests/AGENTS.md`](../../tests/AGENTS.md) for the test fixture patterns (`test_pool()`, `TempDir`, materializer setup).

## How to add a new Tauri command (end-to-end)

The sequence below is the full path from "I wrote some Rust" to "the frontend can call it". Steps 4–6 are the ones that bite — the Rust compiles green while the bindings / `.sqlx` cache silently drift, and CI fails instead.

1. **Write `*_inner(...)` in the handler module.** This is the testable core (see [§The `_inner` / Tauri-wrapper split](#the-_inner--tauri-wrapper-split)). It takes `&SqlitePool` (not `State`), returns `Result<T, AppError>`, carries no `#[tauri::command]` decorator, and is what the unit tests in `src-tauri/src/commands/tests/` exercise. Pick the module by domain — e.g. block CRUD lives in `src-tauri/src/commands/blocks/crud.rs`, properties in `src-tauri/src/commands/properties.rs`.

2. **Write the thin Tauri wrapper** in the same module. Decorate with `#[tauri::command]` + `#[specta::specta]`, resolve the `State` args, and delegate to `*_inner`. For write commands the wrapper takes `pool: State<'_, WritePool>` and passes `&pool.0`; it ends with `.map_err(sanitize_internal_error)`. Any multi-row write inside `*_inner` opens `CommandTx::begin_immediate(pool, "label")` (see [§`CommandTx` for atomic multi-row writes](#commandtx-for-atomic-multi-row-writes)) — verify the helper name against an existing command rather than guessing.

   ```rust
   #[cfg(not(tarpaulin_include))]
   #[tauri::command]
   #[specta::specta]
   pub async fn my_command(
       pool: State<'_, WritePool>,
       device_id: State<'_, DeviceId>,
       materializer: State<'_, Materializer>,
       block_ids: Vec<BlockId>,
   ) -> Result<i64, AppError> {
       my_command_inner(&pool.0, device_id.as_str(), &materializer, block_ids)
           .await
           .map_err(sanitize_internal_error)
   }
   ```

3. **Register the command** in the `agaric_commands!` macro in `src-tauri/src/lib.rs` (the single source of truth for the command list — both `run()` and the specta export expand it). Add a `$crate::commands::<module>::<path>::my_command,` line. **Editing the macro is the only place a command is registered**; forgetting it means the IPC handler never sees the command at runtime.

4. **Regenerate the specta TypeScript bindings** → `src/lib/bindings.ts`. **This is the step most often missed.** The bindings are checked in, and the `ts_bindings_up_to_date` test (in `src-tauri/src/lib.rs`, mod `specta_tests`) compares the committed file against a fresh export — CI fails the moment they drift. Regenerate with:

   ```bash
   cd src-tauri && cargo test -- specta_tests --ignored
   ```

   This runs the `#[ignore]`'d `regenerate_ts_bindings` test, which writes `src/lib/bindings.ts` (with the `// @ts-nocheck` header). Re-run it after any change to a command signature, an arg/return struct, or the command list — not just new commands.

   > **Note:** the test's own assert message suggests `cargo test -p agaric-lib …`, but `agaric-lib` is not a valid package name (the package is `agaric`; `agaric_lib` is only the lib *target*), so `-p agaric-lib` fails. Drop the `-p` flag as shown. Tracked in #569.

5. **Add the typed wrapper** in `src/lib/tauri.ts`. The generated `commands.myCommand(...)` is raw (positional args, `{ status: 'ok' | 'error' }` result). Wrap it with a named export that takes a readable param object and calls `unwrap(await commands.myCommand(...))` so it throws on error like the rest of the frontend expects. Marshal any `spaceId: string | null` through `toSpaceScope(...)`; race against an `AbortSignal` via `withAbort(...)` if the call is cancellable.

6. **If the command adds or changes a `query!` / `query_as!` / `query_scalar!` macro**, regenerate the offline `.sqlx` cache (compile-time-checked queries need it; runtime `sqlx::query(...)` strings do not):

   ```bash
   cd src-tauri && cargo sqlx prepare -- --tests
   ```

   CI runs `cargo sqlx prepare --check -- --tests` and fails on drift. `cargo sqlx prepare` needs `DATABASE_URL` pointing at a migrated SQLite DB (no `.env` is checked in — see `src-tauri/.env.example` and [`src-tauri/migrations/AGENTS.md`](../../migrations/AGENTS.md)). Commit `src/lib/bindings.ts` and any new files under `src-tauri/.sqlx/` in the **same PR** as the Rust change.

## Cross-references

- Root [`AGENTS.md`](../../../AGENTS.md) §Backend Architecture — top-level command surface map.
- [`src-tauri/migrations/AGENTS.md`](../../migrations/AGENTS.md) — when a command needs a schema change.
- [`src-tauri/src/mcp/AGENTS.md`](../mcp/AGENTS.md) — when a command also surfaces as an MCP tool.
- [`docs/architecture/search.md`](../../../docs/architecture/search.md) — `SearchFilter` as the canonical extension struct.
