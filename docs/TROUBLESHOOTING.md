# Troubleshooting

The failure modes you are most likely to hit, each with the symptom, the cause,
and the exact fix: local development on this codebase, and a vault that will not
open ([§8](#8-agaric-failed-to-start-the-vault-will-not-open)). For full setup
and build details see [`BUILD.md`](./BUILD.md).

## Table of contents

- [1. Mold linker not found](#1-mold-linker-not-found)
- [2. sqlx offline cache stale](#2-sqlx-offline-cache-stale)
- [3. Specta bindings out of sync](#3-specta-bindings-out-of-sync)
- [4. Materializer test deadlock](#4-materializer-test-deadlock)
- [5. `dev.db` does not exist](#5-devdb-does-not-exist)
- [6. `sqlx prepare --check` fails with a stale-schema error, not a missing `dev.db`](#6-sqlx-prepare---check-fails-with-a-stale-schema-error-not-a-missing-devdb)
- [7. Large file blocked by pre-commit](#7-large-file-blocked-by-pre-commit)
- [8. Agaric failed to start: the vault will not open](#8-agaric-failed-to-start-the-vault-will-not-open)

## 1. Mold linker not found

### Symptom

Every `cargo build` / `cargo check` fails right at the link step with:

```text
error: linking with `cc` failed: exit status: 1
  = note: collect2: fatal error: cannot find 'ld'
          fuse-ld: cannot find mold
```

This appears only once an active `.cargo/config.toml` exists — either written
for you by `scripts/setup.sh` on a Linux host, or copied by hand from
`.cargo/config.toml.example`.

### Cause

`.cargo/config.toml` sets `rustflags = ["-C", "link-arg=-fuse-ld=mold"]`, which
tells the compiler to link with `mold`. If `mold` is not installed, the linker
invocation cannot find it and the build aborts. The file is gitignored and only
the `.example` is tracked, precisely so a fresh clone never trips this.

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

Pre-push Phase E and CI's sqlx cache check (`scripts/clippy-sqlx-check.sh` in `lint`) fail for the same reason.

### Cause

sqlx verifies queries at compile time against an offline cache (one JSON per
query) in `src-tauri/.sqlx/`, which every workspace crate resolves from. A new or
changed query macro has no matching cache entry, so the offline check fails.
Regenerating needs a live `DATABASE_URL`; the `.env` in `src-tauri/` points it
at `sqlite:dev.db`.

### Fix

Regenerate the cache:

```bash
just gen-sqlx
```

Commit the regenerated `src-tauri/.sqlx/` alongside the Rust change. If
`dev.db` does not exist (see [section 5](#5-devdb-does-not-exist)), create it
with the canonical script first:

```bash
scripts/setup-dev-db.sh   # creates src-tauri/dev.db + runs migrations
just gen-sqlx
```

## 3. Specta bindings out of sync

### Symptom

The `specta_tests::ts_bindings_up_to_date` test fails:

```text
TypeScript bindings are stale — regenerate with: cd src-tauri && cargo test --lib -- specta_tests --ignored
```

CI fails on the same drift via the `ts_bindings_up_to_date` Rust test itself, run as part of the `cargo nextest run` suite (not a standalone prek hook).

### Cause

`src/lib/bindings.ts` is generated from the Rust types and `#[tauri::command]`
signatures. Any command signature change — or even a doc-comment change that
specta exports — makes the committed file diverge from what the generator
produces, and the parity test rejects the diff.

### Fix

Regenerate the bindings, then commit `src/lib/bindings.ts`:

```bash
cd src-tauri && cargo test --lib -- specta_tests --ignored
```

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

Run the canonical provisioning script — it creates `dev.db` (under `src-tauri/`) and applies
every migration, exactly as `scripts/setup.sh` and CI do (and what the pre-push
verifier connects to via `DATABASE_URL=sqlite:dev.db`):

```bash
scripts/setup-dev-db.sh
```

It is idempotent — re-run it after pulling new migrations to refresh the schema.

Alternatively, just launch the app once; it opens its pool with
`create_if_missing(true)` and runs migrations on startup, materializing `dev.db`:

```bash
cargo tauri dev
```

## 6. `sqlx prepare --check` fails with a stale-schema error, not a missing `dev.db`

### Symptom

`dev.db` already exists (distinct from [section 5](#5-devdb-does-not-exist),
where it's absent), but it's behind the migrations directory — e.g. you
pulled a branch that added new migrations. `cargo sqlx prepare --check`
(pre-push Phase E of `scripts/verify-ci-equivalent.sh`, and the equivalent
`scripts/clippy-sqlx-check.sh` step in CI) fails with a schema-mismatch error rather
than a missing-file error, for example:

```text
error: error returned from database: (code: 1) no such column: <new-column>
```

### Cause

`cargo sqlx prepare --check` compiles every `sqlx::query!`/`query_as!` macro
against the live schema at `DATABASE_URL` (`sqlite:dev.db`). A persistent
`dev.db` that predates a newly pulled migration is missing the column/table
the new query macros expect, so the offline-cache check fails even though
`.sqlx/` itself is up to date.

### Fix

Apply the pending migrations to the existing `dev.db` — either re-run the
canonical provisioning script (idempotent):

```bash
scripts/setup-dev-db.sh
```

or apply just the migrations directly from `src-tauri/`:

```bash
cd src-tauri && cargo sqlx migrate run
```

## 7. Large file blocked by pre-commit

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

## 8. Agaric failed to start: the vault will not open

### Symptom

On desktop, a dialog titled *Agaric failed to start* says Agaric could not open
your vault, shows the error, and links this section. Agaric quits when you close
it. *Open data folder* opens the folder that holds the vault; *Copy details*
copies the version, the platform, the error and this section's address. Paste
them before you close the dialog: on Linux the copy can go when Agaric quits.

On Android nothing shows: Agaric closes as it starts. The error follows
`fatal error during application setup` in `adb logcat | grep RustStdoutStderr`,
which works on a release build.

### Cause

Opening, upgrading or reading the vault failed. The error says which:

- `migration <N> was previously applied but is missing in the resolved migrations`,
  or *This vault was last opened by a newer version of Agaric*: this version is
  older than the one that last opened the vault.
- `while executing migration <N>`: this version's upgrade of the database failed.
- `file is not a database`, `database disk image is malformed`, or *The saved
  state of space … cannot be read*: the vault is damaged.

### Fix

The data folder holds the vault (`notes.db`, with `notes.db-wal` and
`notes.db-shm` beside it), its backups, and the log (`logs/agaric.log`):

| Platform | Data folder |
|---|---|
| Linux | `~/.local/share/com.agaric.app/` (under `$XDG_DATA_HOME` when that is set) |
| macOS | `~/Library/Application Support/com.agaric.app/` |
| Windows | `%APPDATA%\com.agaric.app\` |
| Android | `/data/data/com.agaric.app/`, private to the app |

**Before anything else, quit Agaric and copy the whole data folder somewhere
else.** A start that fails can save the vault as a new backup and delete the
oldest one, and the steps below change the folder.

The backups: before each update that changes the database, Agaric copies it to
`notes.db.pre-migration-<time>` beside it, and keeps the newest three. Once a
day it also copies it to `notes.db.daily-<date>`, keeping the newest few
([Daily snapshot](features/import-export.md#daily-snapshot-settings--data)).
Each of either kind is a complete database file; its modified time is when it
was taken. To open one:

1. Move `notes.db`, `notes.db-wal` and `notes.db-shm` out of the data folder. A
   `-wal` left behind belongs to the file you moved, not to the backup.
2. Copy the backup to `notes.db` in the data folder.
3. Start Agaric. A backup taken before an update is upgraded again.

What was written after the backup was taken is not in it. Then, by cause:

- **An older version:** install the version that last opened the vault, or a
  newer one. The vault was not changed; there is nothing to restore.
- **A failed upgrade:** to go back to the version you ran before, restore the
  oldest backup taken since the update, then install that version: an upgrade
  can stop part way, and the older version cannot open a vault left half
  upgraded. Report the error with *Copy details*.
- **A damaged vault on a paired device:** set the device up fresh. Move the
  whole data folder out of place, start Agaric and pair it again (Settings ›
  Sync & devices): the first sync brings back everything the other devices
  hold, which is all this device had synced. It comes back as a new device, so
  unpair its old entry on the other devices.
- **A damaged vault on a device that was never paired:** restore the newest
  backup taken before the failures started.

**Do not keep using a restored backup on a device that has synced since the
backup was taken.** Its other devices hold later history for it than the backup
has, and once the restored copy records a change, every sync with them fails for
good (the restored-copy pitfall in [Sync](features/sync.md#pitfalls-to-know)).
Use it only to export what the other devices lack (Settings › Data › *Export all
spaces*), then set the device up fresh as above and import that export. Import
only what is missing: a page whose title the space already holds is updated in
place to the file's text.

On Android only a debug build reaches the data folder
(`adb shell run-as com.agaric.app`). On a release build, clear Agaric's storage
in the system's app settings, or reinstall it, and pair it again: its notes come
back from its other devices, and a phone that was never paired cannot reach its
backups.
