# Session 2450 — Review notes from #5744 to #5750

The non-blocking review notes on #5744, #5749, #5721, #5750 and the #5712
review, and four flaky specs, each checked against the code first.

## Sync (#5712, #5744)

- **`sweep_deferred_purges` doc, fixed.** Nothing at boot calls it; the doc
  and `inbound_syncs_in_flight`'s now say tests and benches.
- **`sweep_deferred_purges_if_last`, fixed.** A session read the table, found
  it empty and dropped its claim, so a session that recorded ids and left in
  between was swept by nobody until the next pull. It now leaves first, then
  reads, and under the writer lock sweeps only while nobody is in flight. The
  claim-less pre-check is kept, so a pull that deferred nothing still takes no
  lock. `a_deferral_recorded_while_another_session_ends_is_swept_5712` holds
  a read A makes before it leaves open with a SQLite progress handler; on the
  old body B's deferral survives. On the new body A leaves first and never
  reads, so the test accepts a handler dropped unused. Removing the under-lock
  check reddens
  `a_session_starting_while_a_sweep_waits_for_the_lock_is_not_swept_5712`.
- **Empty-offer catch-up, no change.** It merges nothing. The session got
  there because a doc fell back (`SnapshotFallbackRequested`), so the docs from
  that one onwards never landed, and a block the earlier docs deferred may be a
  page moved into one of them: a sweep would take its drafts, links and tags
  before its doc arrives. The claim leaves with the catch-up and the next
  completed pull sweeps. `an_empty_catchup_leaves_what_its_session_deferred_5712`.
- **`SyncComplete` exits, no change.** `on_sync_complete` runs for the
  streamer or the empty-registry initiator, and neither imported, so neither
  holds a claim. Sweeping there without a claim would purge a failed pull's
  rows (a moved page's) before its new doc lands.
- **Every-boot `Repair::Attachments` / `Repair::PageAliases`, no change.** A
  restart inside a deferral window can write an attachment or alias map for a
  block the old doc no longer holds. Every reader walks tree nodes
  (projection, recovery, the oracle's `read_engine_space`), and the delete
  fallback `find_attachment_block` runs only once the row is gone, so the
  entry is never read. Inert, as the reviewer said.
- **Oracle and deferred rows, no change.** The owner text calls them expected.
  The report drops that text, so the count shows in App health, but only
  between an interrupted pull that carried a purge or a cross-space move and
  the next completed pull.

## Attachments (#5749)

- **Integrity check false positive, fixed.** `reconcile_all` takes the
  attachments directory and leaves out a hash with no blob whose referrers'
  files are all absent: a peer's bytes that have not landed. A hash whose file
  is on disk with no blob still reports.
  `a_peer_attachment_whose_bytes_have_not_landed_is_not_a_divergence_5728`
  pins both halves.
- **`skipped_hash_mismatch`, deleted.** Nothing incremented or read it; a
  refused offer ends the file phase with an error.
- **Hash sources and two identical images, no change.** The only sender fills
  `content_hash` and `blake3_hash` with the same value; a second request for
  the same bytes links to the first's blob and costs a transfer, nothing else.

## Page mode (#5721)

- **`commandsApi`'s `spaceId() ?? ''`, no change.** `createBlock` passes the id
  through `requireActiveScope`, which throws before any IPC, so there is no
  backend error. The save-failed toast has a fixed id and replaces itself. The
  space id is null only when no space exists, and then no page is open.
- **`page-save.ts` header, fixed.** It now says a block the document does not
  show goes when page mode deletes its parent.
- **`holdsContent`, no change.** Every block line Edit as Markdown writes
  starts with `- ` (`push_block_bullet`), which is text. A first pasted line
  with no content is a block line whose marker and text the user deleted, then
  cut and pasted.

## Reveal (#5750)

- **`revealed-markers.ts`, fixed.** `isRevealed` is no longer exported, its doc
  names `isBareLink`, and `runsAtSelection` calls `revealedRunsAt` for `$from`
  and `$to`.

## Docs

- **FEATURE-MAP, fixed.** "(the dialog says so)" is gone from the `/voice`
  line.

## Flakes

- **`page-alias-add.spec.ts` "by keyboard", fixed.** Two focus moves land a
  frame late: App focuses `#main-content` after a view change, and the menu
  focuses its first item after it opens. A `focus()` before the second was
  taken back (the "inactive" read); one before the first closes the menu. The
  spec waits for both. With every animation frame delayed 150 ms the old flow
  failed 2 of 20 and the new passed 20 of 20.
- **`keyboard-shortcuts.spec.ts` "?", fixed.** The `?` listener lives in
  `useAppDialogs` from boot, so the first press opens the sheet; the wait is
  for its lazy chunk. The `toPass` retried after 1 s, and its header click then
  waited on the opening sheet. Under 8x CPU throttling the old flow failed 6
  of 10 and the new passed 10 of 10.
- Both specs passed `--repeat-each=20 --workers=4` (40 of 40).
- **`e2e-tauri/sync-two-device.e2e.ts`, fixed.** `waitForToast` resolved the
  toasts, then read each one's text; a toast re-rendered in between failed the
  wait with "Node with identifier … was not found" (CI on #5751, from
  `setPeerAddress`). It now reads every toast in one `browser.execute`, and the
  spec's `waitForStaticText` reads its row the same way. `navigateTo`'s wait
  reads a held nav button, which its doc calls stable; left as it is.
