# Session 4179 — SQLite's busy code reaches the frontend as `pool_busy`

The second of two maintainer decisions left open by #6766 (#6567). The first, a fair queue for the writer, is session 4178 and its own PR.

## What was wrong

`docs/architecture/operations.md` said a command that cannot get the write lock within the 5 s `busy_timeout` fails as `pool_busy` and is retried by `retryOnPoolBusy`. That was true of sqlx's pool timeout only. SQLite's own `SQLITE_BUSY` came through `From<sqlx::Error>` as `AppError::Database`, which `sanitize_internal_error` collapses to `internal`, so the frontend showed a failure and retried nothing.

## What shipped

`From<sqlx::Error>` routes a database error whose primary result code is `SQLITE_BUSY` to `AppError::PoolTimedOut`. The primary code is `extended & 0xFF`, so `SQLITE_BUSY_SNAPSHOT` and the other extended busy codes go the same way. `SQLITE_LOCKED` stays a `Database` error. The parse of the primary code, written twice before, is one function, `sqlite_primary_code`.

## What the kind change touches, as checked

- **Rust.** `AppError::is_write_contention` already answered yes for both shapes, so the materializer consumer and `maintenance.rs` behave as before. `sync_protocol/operations.rs` treats `Database` and `PoolTimedOut` alike as transient. `sanitize_internal_error` passes `PoolTimedOut` through, which is the point. No Rust code matches on the busy message text.
- **Frontend.** `retryOnPoolBusy` is the one consumer that changes behaviour: it now re-invokes a command refused at the lock. `categorize-history-error.ts` files `pool_busy` and `internal` in the same bucket, and `useDraftAutosave` reads the kind only to label a log line.
- **Mock and conformance fixtures.** Neither produces `pool_busy`, `database` or `internal`; nothing to change.

## Is the retry safe

A re-invoke is safe when the failed attempt wrote nothing. Every command behind `retryOnPoolBusy` was read from begin to return: each commits as its last fallible step, and `CommandTx::commit_and_dispatch` cannot fail after SQLite committed. One exception, which predates this change: `create_block` for a page (and for a tag that already exists) reads the row back from the write pool after the commit, and a pool timeout there already surfaced as `pool_busy`. The retry finds the page the first attempt created and returns it, so there is no duplicate, but it appends no op and the creation never reaches the undo stack. A plain read in WAL mode does not normally see `SQLITE_BUSY`, so this change does not make that window wider in practice. Left as found.

## Edited assertion

`purge_blocks_by_ids_inner_surfaces_unwrapped_contention_at_the_boundary_4018` (`src/maintenance.rs`) drove a real `SQLITE_BUSY` through a command and asserted `AppError::Database(sqlx::Error::Database(_))`. That was the behaviour this decision changes; it now asserts `AppError::PoolTimedOut`. Its second assertion, that `is_write_contention` accepts the error, is unchanged.

## Suites run

`cargo nextest run --workspace` in two halves, `cargo test --doc --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `npm run typecheck` and the vitest file of `app-error.ts`. The edited assertion was shown red by mutating the new match arm out: it failed with `Database(Database(SqliteError { code: 5, .. }))` where it expects `PoolTimedOut`.
