# Session 1231 — Peer attachment filename sanitization (#3029)

**Issue:** #3029

## What

The #2989 origination guard (`validate_attachment_filename`, reject-based, app
crate) never covered filenames arriving from peers. New shared validator in the
lowest crate both paths reach:

- `agaric_core::attachment_filename::sanitize_attachment_filename(&str) -> String`
  + `MAX_ATTACHMENT_FILENAME_BYTES = 255`. Same policy as #2989 but neutralizing
  instead of erroring: `/`, `\`, control chars → `_`; surrounding whitespace +
  trailing dots/spaces trimmed (closes the Windows `". ."` → `..` edge, which
  origination itself still accepts); empty/all-dots → `"attachment"`; 255-byte
  cap on a char boundary with post-truncation re-clean. Platform-independent so
  a cross-platform-synced DB converges.

All **five** peer write-paths to `attachments.filename` sanitize + warn, never
reject (a reject would wedge apply / abort a legitimate restore = DoS):

1–2. `agaric-engine` apply add/rename (`apply_add_attachment_tx`,
`apply_rename_attachment_tx`)
3–4. app recovery replay add/rename (`db/recovery.rs`)
5. `agaric-sync` snapshot restore (`AttachmentSnapshot.filename`) — **found by
the reviewer**: `fs_path` was already shape-checked but the display filename
(the actual export/ZIP fs-join primitive) was bound raw.

## Review (adversarial, independent agent): SHIP-WITH-FIXES

- Fix made: the snapshot-restore gap above (runtime `sqlx::query`, zero `.sqlx`
  impact).
- Policy divergence audit vs the #2989 validator char-class by char-class:
  sanitizer stricter-or-equal on every dangerous class; no traversal primitive
  survives unchanged. `..\u{200B}` passes both but is not a parent-dir component
  on any FS.
- Truncation edge: char-boundary backoff (no panic), re-clean can only shrink or
  fall back — never re-introduces trailing dot/space.
- fs-join consumer audit: backend joins only shape-checked `fs_path`, never
  `filename`; frontend export ZIP self-sanitizes (#2988) — defense-in-depth
  layers enumerated.
- Non-tautology: all three integration assertions verified failing against
  pre-fix code via diff pre-image.
- sqlx offline priority-1: query text byte-identical (only Rust binds changed);
  `SQLX_OFFLINE=true cargo check --workspace --all-targets` clean.

## Verification

Post-rebase over the #2897 merge (two pre-#2897 paths in the new test fixed:
`agaric_store::op`, `agaric_core::ulid`): offline workspace check clean;
targeted nextest (attachment/filename/sync_files/snapshot) 334/334; clippy
clean; 10 core unit tests + 2 integration tests.
