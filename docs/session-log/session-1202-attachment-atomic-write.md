# Session 1202 — Make local attachment byte writes atomic and durable

**Date:** 2026-07-23
**Branch:** `fix/attachment-atomic-write`
**Closes:** #2918

## Summary

The local add-attachment path persisted user bytes with a plain `std::fs::write` (no
temp+rename, no `sync_all`), so a crash or power loss after the `attachments` DB row commits
could leave the committed row pointing at a truncated/empty file — silent corruption, since no
read path re-verifies the stored `content_hash`. This makes `write_attachment_file` durable
and atomic, mirroring the pattern the codebase already uses for device-id creation.

## The fix (`agaric-sync/src/sync_files.rs`, `write_attachment_file`)

Rewritten to follow `device.rs`'s `get_or_create_device_id` reference pattern:

1. `create_dir_all(parent)` (preserved) — parent dirs created before the temp write.
2. Sibling temp path `<final>.tmp-<ulid-hex>` via `with_file_name` (same directory → the later
   rename is guaranteed same-filesystem/atomic). ULID via the existing `ulid` dep — the same
   scheme the sync-receiver's `write_attachment_streaming` already uses; no new crate.
3. `OpenOptions::create_new(true)` → `write_all(data)` → `f.sync_all()`, inside a scope so the
   handle is dropped (file closed) **before** the rename.
4. `fs::rename(temp, full_path)` — atomic publish, only after the fsync succeeds.
5. Best-effort parent-dir fsync (`File::open(parent).sync_all()`), logged-not-propagated on
   failure (matches device.rs; Windows doesn't support dir fsync).

On **either** failure branch (write/fsync or rename), the temp file is best-effort removed
before the original `AppError::Io` returns — no `.tmp-*` orphan litter.

Public signature, `AppError` return type, and success semantics (create dirs, overwrite in
place) are unchanged. `create_new` (not plain `create`) means a leftover temp can't be
silently truncated-into.

## Scope

- Sole production caller `add_attachment_with_bytes_inner` (`commands/attachments.rs`) runs in
  `spawn_blocking` before the row-insert/commit; ordering vs the DB commit is unchanged, now
  durable. It re-hashes the in-memory buffer (not a disk read-back), so it relies on no old
  behavior.
- `write_attachment_streaming` (the sync-receiver path) is a **separate** function with its own
  temp/rename/commit flow — **untouched**.
- **Deferred (documented follow-up):** read-path `content_hash` verification returning a
  distinct "attachment corrupted" error needs a new `AppError` variant in `agaric-core`
  (outside this fix's scope); a `#2918 scope note` doc comment on `read_attachment_file`
  records the deferral rather than dropping it silently.

## Tests (`src/sync_files/tests.rs`)

- `write_file_leaves_no_tmp_sibling_on_success` — final bytes exist AND no `.tmp-*` sibling
  remains (guards the atomic-rename cleanup).
- `write_file_cleans_up_temp_on_rename_failure` — a real directory pre-created at the
  destination makes `rename(2)` fail with `EISDIR`; asserts the call errors, the blocking dir
  is untouched, and no temp orphan remains (the write/fsync-failure branch's cleanup is
  identical/symmetric).
- Pre-existing exact-bytes / overwrite-in-place / empty-file / roundtrip tests pass unmodified
  against the new implementation.

Durability itself isn't directly unit-testable without a real crash, so the tests target the
observable atomic-rename / no-litter behavior — all vacuous against the old `std::fs::write`.

## Verification

`cargo nextest run -E 'test(attachment) or test(write_attachment) or test(sync_file)'` = **167
passed, 0 failed**. `cargo clippy -p agaric-sync -p agaric --lib -- -D warnings` clean. `.sqlx`
unchanged (no new `query!` macros). Adversarial review confirmed the `sync_all`-before-rename
ordering, temp cleanup on both error paths, same-filesystem atomicity, and caller safety.
