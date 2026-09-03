# `src-tauri/src/commands/` — Tauri command handlers

Root [`AGENTS.md`](../../../AGENTS.md) covers cross-cutting invariants (error shape, materializer). This file covers what `commands/` code and guards depend on.

## The `_inner` / Tauri-wrapper split

Every command is two functions:

1. **`*_inner`** — the logic. Takes `&SqlitePool` (not `State`), returns `Result<T, AppError>`, no `#[tauri::command]`. Tested from `src-tauri/tests/commands/`.
2. **`*`** — thin wrapper with `#[tauri::command] #[specta::specta]`. Resolves `State`, delegates, ends with `.map_err(sanitize_internal_error)`. No business logic.

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
    ctx: tauri::State<'_, WriteCtx>,
    block_id: String,
) -> Result<(), AppError> {
    delete_block_inner(ctx.pool(), ctx.device_id(), ctx.materializer(), BlockId::from_trusted(&block_id))
        .await
        .map_err(sanitize_internal_error)
}
```

## `tauri-specta` 10-argument ceiling

The IPC bridge codegen silently truncates a command past 10 params. `State<'_, T>` params do not appear in `bindings.ts` but still occupy a Rust signature slot, and `scripts/check-command-arity.py` (prek hook `check-command-arity`) counts them: any `#[tauri::command]` under `src-tauri/src/commands/` with more than 10 params fails the hook.

Fix by collapsing, never by `#[allow(clippy::too_many_arguments)]`:

- Write commands take one `ctx: State<'_, WriteCtx>` (`src-tauri/src/db/pool.rs`) instead of `pool` + `device_id` + `materializer`; `ctx.pool()` / `ctx.device_id()` / `ctx.materializer()` return exactly what an `*_inner` expects. Read-only commands take `pool: State<'_, ReadPool>` and pass `&pool.0`.
- Still too many: bundle user args into a request struct with `#[serde(default)]` on every optional field so new fields stay wire-compatible. Precedents: `SearchFilter`, `ListBlocksRequest`, `QueryByPropertyRequest`, `ListPagesWithMetadataFilter` in `src-tauri/src/commands/mod.rs`.

```rust
#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ListBlocksFilter {
    pub parent_id: Option<String>,
    pub tag_ids: Vec<String>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}
```

## `CommandTx` for multi-row writes

Any write touching more than one row goes through `CommandTx` (`src-tauri/src/db/command_tx.rs`), never a bare `pool.acquire()`:

```rust
let mut tx = CommandTx::begin_immediate(pool, "command_label").await?;
// all writes ride the tx
tx.commit_and_dispatch(&materializer).await?;
```

- `BEGIN IMMEDIATE` takes the writer lock up front, so a tx cannot deadlock escalating from a read.
- The label appears in tracing spans and lock-wait diagnostics.
- `commit_and_dispatch` commits once, then hands pending `BatchApplyOps` to the materializer.
- A dropped future (Tauri cancels IPC futures) rolls the tx back — no partial writes are observable.

### `_in_tx` variants

A command needed both standalone and inside a larger tx (e.g. a `bootstrap_*` path) gets `do_thing_in_tx(tx, …)` (no commit, returns its effects) and `do_thing_inner(pool, …)` wrapping it in its own `CommandTx`. Do not duplicate the logic.

`create_block_in_tx` (`src-tauri/agaric-engine/src/block_ops.rs`) takes a trailing `client_id: Option<BlockId>`: `None` mints a server ULID; `Some(id)` (optimistic create via `create_block_inner_with_id`) is used verbatim if it is a valid ULID and collides with no live or tombstoned row, else `AppError::Ulid` / `AppError::Conflict`. Never fall back to a generated id — the frontend already spliced the block in under the client id.

## `*_by_ids` bulk commands and `MAX_BATCH_BLOCK_IDS`

Every bulk command over a list of block ids (`restore_blocks_by_ids_inner`, `set_todo_state_batch_inner`, …):

1. Empty input by kind: bulk **writes** reject with `AppError::validation(...)` (mutating nothing is a caller bug); bulk **reads** return the empty collection (an empty page or agenda window is a legitimate state).
2. `crate::commands::ensure_batch_within_cap(subject, len)?` — the cap `MAX_BATCH_BLOCK_IDS = 1000` and the helper live in `src-tauri/agaric-store/src/pagination/mod.rs`; use the helper so the message stays canonical.
3. Normalise ids to uppercase (`BlockId::from_trusted` or the appropriate parser).
4. Resolve in one query via `json_each(?1)`, never an N+1 loop.
5. Exactly one `CommandTx::begin_immediate` per logical bulk op. Never chunk: one user action = one tx = one op-log seq range = one activity-feed entry.

```rust
pub async fn restore_blocks_by_ids_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<String>,
) -> Result<BulkRestoreResponse, AppError> {
    if block_ids.is_empty() {
        return Err(AppError::validation("block_ids list cannot be empty".into()));
    }
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;
    let normalized: Vec<String> = block_ids.iter().map(|id| id.to_uppercase()).collect();
    let id_json = serde_json::to_string(&normalized)?;
    let mut tx = CommandTx::begin_immediate(pool, "restore_blocks_by_ids").await?;
    // one json_each resolve, writes, one commit
    tx.commit_and_dispatch(materializer).await?;
    Ok(response)
}
```

## `OpRef` chains via `LAST_APPEND`

The activity feed (`src-tauri/src/mcp/activity.rs`) drains the `LAST_APPEND` task-local after a command returns and builds one entry: first `OpRef` primary, the rest as `additionalOpRefs`. Only `append_local_op_in_tx(...)` populates the task-local, so emit every op through it inside the one `CommandTx`. A bare `INSERT INTO op_log` produces no activity entry.

## `AppError` and `ValidationCode`

`AppError` serialises as `{ kind, message, code? }` (manual `Serialize` in `src-tauri/agaric-core/src/error.rs`); `code` is present only on coded `Validation` errors, never `null`.

`AppError::Validation` is a struct variant, so `AppError::Validation(msg)` does not compile. Use the ctors:

```rust
AppError::validation(msg)                                    // uncoded
AppError::validation_coded(ValidationCode::InvalidRegex, reason) // frontend must discriminate
assert_eq!(err.validation_code(), Some(ValidationCode::InvalidGlob)); // tests
```

`message` carries only the human-readable reason; never format a code into it. The Rust `ValidationCode` enum is the source of truth: specta projects it into `bindings.ts`, and `src/lib/search-query/validation-codes.ts` mirrors it pinned by `satisfies`, so a Rust-side rename fails `tsc` after bindings regeneration. Frontend reads it with `validationCode(err)` from `@/lib/app-error`.

**Adding a variant:** add it in Rust, regenerate bindings, add the mirror entry in `validation-codes.ts`, document it in `docs/architecture/search.md` if search-facing.

## Testing

Every `_inner` gets a test in `src-tauri/tests/commands/` using `test_pool()` + `TempDir` (see [`src-tauri/tests/AGENTS.md`](../../tests/AGENTS.md)):

- Happy path
- Bulk commands: empty-list rejection, oversize-list rejection, op-log seq range contiguity
- Atomic rollback on tx failure
- Activity-feed contract (OpRef chain shape)
- Cross-space rejection when the command takes a `space_id`
- Missing-id behaviour (skip vs error, per the command's docs)

The Tauri wrapper is not unit-tested.

## Add a new command

1. Write `*_inner(...)` in the domain module (block CRUD: `src-tauri/src/commands/blocks/crud.rs`; properties: `src-tauri/src/commands/properties.rs`).
2. Write the wrapper in the same module:

   ```rust
   #[tauri::command]
   #[specta::specta]
   pub async fn my_command(
       ctx: State<'_, WriteCtx>,
       block_ids: Vec<BlockId>,
   ) -> Result<i64, AppError> {
       my_command_inner(ctx.pool(), ctx.device_id(), ctx.materializer(), block_ids)
           .await
           .map_err(sanitize_internal_error)
   }
   ```

3. Register it in the `agaric_commands!` macro in `src-tauri/src/lib.rs` (`$crate::commands::<module>::my_command,`). This is the only registration point; both `run()` and the specta export expand it.
4. Regenerate `src/lib/bindings.ts` — the `ts_bindings_up_to_date` test fails CI on drift. Rerun after any change to a command signature, arg/return struct, or the command list:

   ```bash
   cd src-tauri && cargo test -- specta_tests --ignored
   ```

   (The test's own hint suggests `-p agaric-lib`; that package name does not exist, drop the flag. #569.)

5. Call it from the frontend via `@/lib/bindings` (`commands.myCommand(...)` returns `{ status: 'ok' | 'error' }`; unwrap at the call site). No new wrappers in `src/lib/tauri.ts` or `src/lib/tauri/` — the `tauri-import-baseline` hook rejects new importers.
6. If you added or changed a `query!` / `query_as!` / `query_scalar!` macro, run `just gen-sqlx` (bare `cargo sqlx prepare` drops leaf-crate queries from the four `.sqlx/` caches). It needs `DATABASE_URL` pointing at a migrated SQLite DB — see `src-tauri/.env.example`. Commit `src/lib/bindings.ts` and every `.sqlx/` file in the same PR.

## Cross-references

- [`src-tauri/migrations/AGENTS.md`](../../migrations/AGENTS.md) — schema changes.
- [`src-tauri/src/mcp/AGENTS.md`](../mcp/AGENTS.md) — commands that also surface as MCP tools.
- [`docs/architecture/search.md`](../../../docs/architecture/search.md) — `SearchFilter` as the canonical extension struct.
