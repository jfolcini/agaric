# Session 1198 — Reject path-traversal attachment filenames at origination

**Date:** 2026-07-23
**Branch:** `fix/attachment-filename-traversal`
**Closes:** #2989

## Summary

`rename_attachment_inner` (and `add_attachment_inner`) validated only that the new
filename was non-empty — no character/path-traversal check — so an attachment could be
renamed to `../../evil.sh`. In this local-first app renames propagate as synced ops and
the stored `attachments.filename` is later joined to build filesystem/ZIP paths (#2988
hardened only the export ZIP writer against Zip-Slip; the root cause — a traversal-shaped
name being stored at all — remained). This closes the **origination** vector: this device
can no longer emit a traversal-shaped filename op into the op-log.

## The fix (`src-tauri/src/commands/attachments.rs`)

New private `validate_attachment_filename` (+ `MAX_ATTACHMENT_FILENAME_BYTES = 255`),
wired into `add_attachment_inner` (before payload build / INSERT) and
`rename_attachment_inner` (before payload build / UPDATE); `add_attachment_with_bytes_inner`
delegates to `add_attachment_inner`, so all origination paths are covered. It **rejects**
(`AppError::Validation`, on the trimmed string): empty-after-trim, `> 255` bytes, any `/`
or `\`, any control char (NUL/newline/DEL/C0/C1), and all-dots (`.`/`..`/`...`). It trims
leading/trailing whitespace (unicode-aware) and returns the trimmed name to store.
Interior spaces, interior dots (`my.file.tar.gz`), and unicode letters (`résumé.pdf`) pass
unchanged.

**Reject vs sanitize:** reject is right for these LOCAL, user-initiated commands — a clear
error beats a silent rewrite, and it stops this device originating a bad op. The
hostile-**peer** surface is the APPLY/replay path
(`agaric-engine/src/apply/attachments.rs`, `db/recovery.rs` rename replay), which writes a
peer's filename with no validation; that must **sanitize** (not reject — a reject would
wedge the whole replay pipeline on one hostile op, a DoS) and is tracked as a
defense-in-depth follow-up (filed separately), documented in the helper's doc comment.

## Tests

`block_cmd_tests.rs` — `add_attachment_rejects_traversal_filename`,
`rename_attachment_rejects_traversal_filenames` (also assert a rejected rename leaves the
stored name unchanged, a rejected add inserts no row, legit names persist verbatim, and
`"  spaced name.pdf  "` normalizes to `"spaced name.pdf"`), plus the existing
`rename_attachment_updates_filename`. Non-tautological: reverting to the `is_empty()`
check fails the rejection tests. 215 targeted tests pass; clippy clean; `.sqlx` unchanged.
