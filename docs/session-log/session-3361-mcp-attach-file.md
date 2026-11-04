# Session 3361 — MCP attaches a local file to a block

Slice S2 of #5410's build plan: the write half of the MCP attachment surface.
`attach_file { space_id, block_id, path, filename? }` copies a regular file at
an absolute path onto a block through `add_attachment_with_bytes_inner`, so the
cap, the allowed types, dedup by hash, undo, sync and the activity feed are the
app's. The type comes from the stored name's extension (`mime_for_extension`,
a table checked against `ALLOWED_MIME_PATTERNS`); the refusal message of
`validate_new_attachment` now lists the patterns from that constant, so it
names `audio/*` again.

Metadata is checked before any byte is read: a relative or missing path, a
symlink, a directory, a socket or a file over the cap is refused. A pipe or
device would block or read without end, which is why non-regular files are
refused; the inner still re-checks the size of the bytes read. A cross-space
block is refused inside the guarded transaction, after the bytes are written,
and the inner's cleanup removes them (a test shows the store empty after).

The description and the primer state the transcript format, one paragraph per
segment `[hh:mm:ss] **Speaker:** text`, since #6290's player only seeks from
that shape.

Trap: WebKitGTK on the CI runner has no AAC decoder (no `gstreamer1.0-libav`),
so the real-backend spec attaches an M4A and checks its row and bytes, but
plays only the Opus and MP3 fixtures.

Not merged into one table: `agaric_engine::import::guess_attachment_mime`
still maps extensions for folder import with a fallback to octet-stream.

Ran: whole-workspace nextest in two partitions, clippy, typecheck (incl.
`typecheck:e2e-tauri`), lint, the manual hooks. Falsified the symlink check,
the pre-read size check, the space guard, the post-write cleanup, the page
notification and the name trim. The e2e-tauri spec runs in CI only.
