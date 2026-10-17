# Session 2358 — A pasted image's bytes reach the other device, both ways

#5365's last box, "A pasted image on A renders on B: the bytes arrive, not
just the row", was blocked on #5608 until #5713 put attachment metadata in
the Loro engine. Two cases joined `e2e-tauri/sync-two-device.e2e.ts` before
its unpair case. #5365 keeps an area's real scenarios in one file, and this
reuses the file's pairing and shared page with no extra app boot.

- **App to peer.** The app pastes a PNG and leaves the page. After the
  peer's sync:
  - the peer lists one attachment row with the right name, MIME type and
    size;
  - its copy of the block holds the `attachment:` ref;
  - its `read_attachment` returns the pasted bytes exactly. The test polls,
    because bytes arrive in the file phase after `sync` returns.
- **Peer to app.** The peer attaches a different PNG through the real
  `add_attachment_with_bytes_inner` and writes the ref. After "Sync now":
  - the app's `read_attachment` returns those bytes;
  - after a reopen, the block renders from a `blob:` src with
    `naturalWidth > 0`.

**The trap the first run fell into.** Using the same PNG both ways passed
without moving any bytes. The peer already held them, so its add pointed at a
blob the app also had. That is correct deduplication, so the second image now
differs.

**Red.** `send_file_request` was broken so the request names no attachments.
Built into the peer only, direction 1 failed at "the peer does not hold the
image's bytes". Built into the app only, direction 2 failed at "the app does
not hold the image's bytes".

`e2e_sync_peer` gained `add_attachment`, `list_attachments` and
`read_attachment`, which call the real command functions.
`expectImageRendered` moved to `helpers.ts`, now that it has two users. Two
comments that gave the fixture PNG a wrong byte count now give none.

**Found.** A row a peer receives has a NULL `content_hash`, because #5713
shipped #5608's design steps 1–5 but not 6–8. Those steps are tracked in
#5728.

Gates:
- the real lane: `sync-two-device` 7 of 7 (three green runs),
  `sync-refresh` 7 of 7, `attachment-image-render` 1 of 1;
- e2e-tauri typecheck and vitest (46);
- clippy and fmt;
- `agaric-diagnostics` nextest (44).

The image cases add 5–10 s and no app boot.
