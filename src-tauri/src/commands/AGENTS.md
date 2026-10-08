# `src-tauri/src/commands/` — Tauri command handlers

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

The IPC codegen silently truncates a command past 10 params. `State<'_, T>` params are absent from `bindings.ts` but still count, and the `check-command-arity` hook fails any command over 10.

Fix by collapsing, never by `#[allow(clippy::too_many_arguments)]`:

- Write commands take one `ctx: State<'_, WriteCtx>` (`src-tauri/src/db/pool.rs`) instead of `pool` + `device_id` + `materializer`; `ctx.pool()` / `ctx.device_id()` / `ctx.materializer()` return exactly what an `*_inner` expects. Read-only commands take `pool: State<'_, ReadPool>` and pass `&pool.0`.
- Still too many: bundle user args into a request struct with `#[serde(default)]` on every optional field so new fields stay wire-compatible. Precedents: `SearchFilter`, `ListBlocksRequest`, `QueryByPropertyRequest`, `ListPagesWithMetadataFilter`.

## `CommandTx` for multi-row writes

Any write touching more than one row goes through `CommandTx` (`src-tauri/src/db/command_tx.rs`), never a bare `pool.acquire()`:

```rust
let mut tx = CommandTx::begin_immediate(pool, "command_label").await?;
// all writes ride the tx
tx.commit_and_dispatch(&materializer).await?;
```

- `BEGIN IMMEDIATE` takes the writer lock up front, so a tx cannot deadlock escalating from a read; `commit_and_dispatch` commits once, then hands pending `BatchApplyOps` to the materializer.
- A dropped future (Tauri cancels IPC futures) rolls the tx back.
- A read that decides a write (exists? which ops to revert?) runs inside the tx; with two writers, a probe before `BEGIN IMMEDIATE` can be stale by commit.
- File I/O (attachment bytes, export files) happens before BEGIN or after commit, never while holding the writer lock.

### `_in_tx` variants

A command needed both standalone and inside a larger tx (e.g. a `bootstrap_*` path) gets `do_thing_in_tx(tx, …)` (no commit, returns its effects) and `do_thing_inner(pool, …)` wrapping it in its own `CommandTx`. Do not duplicate the logic. An `_in_tx` helper that applies to the engine assumes its caller called `CommandTx::arm_engine_rollback` right after BEGIN; unarmed, a rollback leaves the engine ahead of SQLite (#2604).

`create_block_in_tx` (`src-tauri/agaric-engine/src/block_ops.rs`) takes `client_id: Option<BlockId>`. `Some(id)` (optimistic create via `create_block_inner_with_id`) is used verbatim or refused with `AppError::Ulid` / `AppError::Conflict`; never fall back to a generated id, because the frontend already spliced the block in under the client id.

An append (no `index`) under a parent records its slot, the live-child count, in `CreateBlockPayload.index`; a create with no slot makes the block's first move non-reversible (#5155). A new create path that bypasses `create_block_in_tx` must do the same, with an undo test.

## `*_by_ids` bulk commands and `MAX_BATCH_BLOCK_IDS`

Every bulk command over a list of block ids (`restore_blocks_by_ids_inner`, `set_todo_state_batch_inner`, …):

1. Empty input by kind: bulk **writes** reject with `AppError::validation(...)` (mutating nothing is a caller bug); bulk **reads** return the empty collection (an empty page or agenda window is a legitimate state).
2. `crate::commands::ensure_batch_within_cap(subject, len)?` enforces `MAX_BATCH_BLOCK_IDS` with the canonical message.
3. Normalise ids to uppercase (`BlockId::from_trusted` or the appropriate parser).
4. Resolve in one query via `json_each(?1)`, never an N+1 loop.
5. Exactly one `CommandTx::begin_immediate` per logical bulk op. Never chunk: one user action = one tx = one op-log seq range = one activity-feed entry.
6. A fix to the single-item path is a fix to its bulk twin, and the reverse: they re-implement each other's SQL and drift. Keep the pair's entry in `scripts/bulk-equivalence-baseline.json` (the `bulk-equivalence` hook) and its scenario in `src-tauri/src/bulk_equivalence/`.

## `OpRef` chains via `LAST_APPEND`

`RmcpAdapter::call_tool` (`src-tauri/src/mcp/rmcp_adapter.rs`) drains the `LAST_APPEND` task-local after a command returns and builds one entry: first `OpRef` primary, the rest as `additionalOpRefs`. Only `append_local_op_in_tx(...)` populates the task-local, so emit every op through it inside the one `CommandTx`. A bare `INSERT INTO op_log` produces no activity entry.

## `AppError` and `ValidationCode`

`code` is present only on coded `Validation` errors, never `null`. `AppError::Validation` is a struct variant, so `AppError::Validation(msg)` does not compile; use the ctors:

```rust
AppError::validation(msg)                                    // uncoded
AppError::validation_coded(ValidationCode::InvalidRegex, reason) // frontend must discriminate
assert_eq!(err.validation_code(), Some(ValidationCode::InvalidGlob)); // tests
```

`message` carries only the human-readable reason; never format a code into it. **Adding a variant:** add it in Rust, regenerate bindings, add the mirror entry in `src/lib/search-query/validation-codes.ts` (pinned by `satisfies`, so a miss fails `tsc`), and document it in `docs/architecture/search.md` if search-facing.

## One op, several interpreters

- An op is interpreted by the local command, the apply kernel (`src-tauri/agaric-engine/src/apply/`), the recovery projection (`src-tauri/src/db/recovery.rs`) and the Loro engine (`src-tauri/agaric-engine/src/loro/engine/apply.rs`). Change them in lockstep, with a test per interpreter. Inbound sync (`loro_sync::apply_remote`) skips the command's validation, so a guard in the command does not cover it.
- Merged op-log rows order by `(created_at, seq, device_id)`. `seq` is per device, so ordering by it ranks a busy device's old ops above another device's new ones.
- Created and last-edited times come from `ulid_created_ms_sql` / `last_edited_ms_sql` (`src-tauri/agaric-store/src/filters/primitive.rs`), never `MIN`/`MAX` over `op_log` alone: compaction deletes old ops.
- An "empty" or "equal" predicate evaluated in both TS and SQL must agree. JS `.trim()` strips all Unicode whitespace; SQLite `TRIM(x)` strips only U+0020. Test a newline and an NBSP.
- Emit events and channel sends through `crate::main_thread` (`emit`, `UiChannel`). An emit off the main thread deadlocks against an in-flight IPC; `clippy.toml` bans the direct calls, so never `#[expect]` that lint outside `main_thread.rs`.
- Derived-row changes owe the checklist in [`src-tauri/agaric-engine/src/materializer/AGENTS.md`](../../agaric-engine/src/materializer/AGENTS.md).

## Boot-time repairs and sweeps

Precedents: `src-tauri/src/repair.rs` (driving `src-tauri/agaric-engine/src/repair/`) and `sweep_leaked_empty_blocks`.

- Each gets its own `CommandTx` with the engine rollback armed. A failure logs and rolls back that repair only; a boot-fatal transaction such as `bootstrap_spaces` is never shared.
- Ops are appended under `Actor::Housekeeping`. Positional undo admits only `user` / `agent:%` origins, so the user's first Ctrl+Z after boot cannot revert a repair.
- Every change is an op applied through `apply_op_projected`. A raw `UPDATE blocks` is undone by the next replay and diverges from peers.
- A second run is a no-op, with a test: the selection is empty the second time, a marker gates a closed population (`repair_misfiled_tag_spaces`), or a cursor walks an open one (`sweep_leaked_empty_blocks`).

## Markdown export and import

`src-tauri/src/commands/pages/markdown.rs` renders; `src-tauri/agaric-engine/src/import.rs` parses.

- Every export transformation gets a round-trip test: export, re-import, compare.
- Every serializer escape has a parser unescape, matched on the trimmed line.
- Importer state (code fence, front matter) resets at each block boundary.

## Testing

Every `_inner` gets tests in `src-tauri/tests/commands/` (fixtures: [`src-tauri/tests/AGENTS.md`](../../tests/AGENTS.md)) covering, where they apply:

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

3. Register it in the `agaric_commands!` macro in `src-tauri/src/lib.rs`, the only registration point (both `run()` and the specta export expand it).
4. Regenerate `src/lib/bindings.ts` (`just gen-bindings`).
5. Call it via `@/lib/bindings` (`commands.myCommand(...)` returns `{ status: 'ok' | 'error' }`; unwrap at the call site). Only logic the generated binding cannot express goes in `src/lib/ipc-helpers.ts`.
6. After a `query!`-family change, `just gen-sqlx` needs `DATABASE_URL` pointing at a migrated DB (`src-tauri/.env.example`).
