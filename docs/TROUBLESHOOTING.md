# Troubleshooting

Six local-dev failure modes you are likely to hit on this codebase, each with
the symptom, the cause, and the exact fix. For full setup and build details see
[`BUILD.md`](./BUILD.md).

## Table of contents

- [1. Mold linker not found](#1-mold-linker-not-found)
- [2. sqlx offline cache stale](#2-sqlx-offline-cache-stale)
- [3. Specta bindings out of sync](#3-specta-bindings-out-of-sync)
- [4. Materializer test deadlock](#4-materializer-test-deadlock)
- [5. `dev.db` does not exist](#5-devdb-does-not-exist)
- [6. Large file blocked by pre-commit](#6-large-file-blocked-by-pre-commit)

## 1. Mold linker not found

### Symptom

Every `cargo build` / `cargo check` fails right at the link step with:

```text
error: linking with `cc` failed: exit status: 1
  = note: collect2: fatal error: cannot find 'ld'
          fuse-ld: cannot find mold
```

This appears only after you have copied the optional linker config into place
(`cp .cargo/config.toml.example .cargo/config.toml`).

### Cause

`.cargo/config.toml` sets `rustflags = ["-C", "link-arg=-fuse-ld=mold"]`, which
tells the compiler to link with `mold`. If `mold` is not installed, the linker
invocation cannot find it and the build aborts. The config is shipped only as
`.cargo/config.toml.example` precisely so a fresh clone never trips this.

### Fix

Install `mold`:

```bash
sudo apt install mold
```

Or remove the active config to fall back to the default linker (safe at any
time — it only affects the linker pick on Linux):

```bash
rm .cargo/config.toml
```

## 2. sqlx offline cache stale

### Symptom

After adding or changing a `sqlx::query!` / `sqlx::query_scalar!` /
`sqlx::query_as!` macro, compilation fails:

```text
error: `.sqlx` is missing one or more queries
```

The `sqlx-prepare-check` prek hook (and CI) fails for the same reason.

### Cause

sqlx verifies queries at compile time against an offline cache under
`src-tauri/.sqlx/` (one JSON per query). A new or changed query macro has no
matching cache entry, so the offline check fails. Regenerating the cache needs a
live `DATABASE_URL`; the `.env` in `src-tauri/` points it at `sqlite:dev.db`.

### Fix

From `src-tauri/` with `.env` present (`DATABASE_URL=sqlite:dev.db`):

```bash
cd src-tauri && cargo sqlx prepare -- --tests
```

Commit the regenerated `src-tauri/.sqlx/` cache alongside the Rust change.

If `dev.db` does not exist (see [section 5](#5-devdb-does-not-exist)), point
sqlx at a throwaway database and migrate it first:

```bash
export DATABASE_URL="sqlite:///tmp/agaric-prepare-$$.db"
rm -f "${DATABASE_URL#sqlite://}"
sqlx database create
sqlx migrate run --source src-tauri/migrations
cd src-tauri && cargo sqlx prepare -- --tests   # keep DATABASE_URL in env
```

Then stage `src-tauri/.sqlx/` and remove the temp DB.

## 3. Specta bindings out of sync

### Symptom

The `specta_tests::ts_bindings_up_to_date` test fails:

```text
TypeScript bindings are stale — regenerate with: cd src-tauri && cargo test -p agaric-lib -- specta_tests --ignored
```

CI fails on the same drift via the `tauri-bindings-parity` prek hook.

### Cause

`src/lib/bindings.ts` is generated from the Rust types and `#[tauri::command]`
signatures. Any command signature change — or even a doc-comment change that
specta exports — makes the committed file diverge from what the generator
produces, and the parity test rejects the diff.

### Fix

Regenerate the bindings, then commit `src/lib/bindings.ts`:

```bash
cd src-tauri && cargo test -- specta_tests --ignored
```

> **Note:** the assertion message printed by the test suggests
> `cargo test -p agaric-lib …`, but `agaric-lib` is not a valid package name
> (the package is `agaric`; `agaric_lib` is only the lib *target*). Drop the
> `-p` flag and run the command from `src-tauri/` as shown above.

## 4. Materializer test deadlock

### Symptom

A test that triggers the materializer (edit / delete / restore / purge / create
page / create tag) hangs forever and never completes.

### Cause

The default `#[tokio::test]` runs on a single-threaded executor. Materializer
work runs as a background task that cannot make progress on a single thread, so
the test deadlocks. Back-to-back writes can also contend on the SQLite write
lock with the materializer's background consumer.

### Fix

Use the multi-thread runtime, and `settle()` between materializer-triggering
ops (per [`src-tauri/tests/AGENTS.md`](../src-tauri/tests/AGENTS.md)):

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn my_materializer_test() {
    // ... op that triggers the materializer ...
    settle().await; // 50ms sleep before the next write
    // ... next write ...
}

async fn settle() {
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
}
```

## 5. `dev.db` does not exist

### Symptom

On a fresh clone, the first `cargo tauri dev` (or any sqlx operation that needs
the database) fails because `dev.db` (under `src-tauri/`) is absent and no migrations have
run.

### Cause

`dev.db` is gitignored and created on demand. The app opens its pool with
`create_if_missing(true)` and runs `sqlx::migrate!("./migrations")` on startup,
so the database is materialized the first time the app runs — but it does not
exist before then.

### Fix

Run the app once; it creates `dev.db` and applies all migrations automatically:

```bash
cargo tauri dev
```

To create and migrate the database without launching the app (e.g. for the sqlx
cache in [section 2](#2-sqlx-offline-cache-stale)):

```bash
cd src-tauri
DATABASE_URL=sqlite:dev.db sqlx database create
DATABASE_URL=sqlite:dev.db sqlx migrate run --source migrations
```

## 6. Large file blocked by pre-commit

### Symptom

`git commit` is rejected by the `check-added-large-files` prek hook:

```text
Check for added large files.................................................Failed
- hook id: check-added-large-files
- exit code: 1
<file> (NNN KB) exceeds 500 KB.
```

### Cause

`prek.toml` runs the builtin `check-added-large-files` hook with
`--maxkb=500`, blocking any newly added file larger than 500 KB. Only
`docs/session-log/` is excluded. This is a guard against accidentally
committing build artifacts, binaries, or large fixtures — not a hard storage
limit, but a deliberate review checkpoint.

### Fix

Prefer not to commit the large file. If it genuinely belongs in the repo, add
its path to the hook's `exclude` pattern in `prek.toml`:

```toml
{ id = "check-added-large-files", args = [
    "--maxkb=500",
], exclude = "^docs/session-log/|^path/to/your/large-file$" },
```

Keep the exclusion as narrow as possible (a specific path, not a broad glob) so
the guard still catches accidental large additions elsewhere.
