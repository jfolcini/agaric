# Session 2526 — the editor's durability on the real backend (#5733)

Real-lane specs for #5733 items 12, 14 and 15, in
`e2e-tauri/editor-durability.e2e.ts`, sharing one boot.

**Specs:**
- **Item 12, audio attachments play inline:**
  - The spec builds a 0.1 s WAV and pastes it into a block.
  - After a reopen, the block has one `<audio>` with a `blob:` source that
    decodes to 0.1 s.
  - The app's CSP blocks `fetch(blob:)`, so the decoded length stands in for
    the bytes.
- **Item 15, the idle commit:**
  - Typing into a block and pausing writes an `edit_block` with the text.
  - `get_block_history` shows it while the editor keeps focus.
- **Item 14, draft restore after a kill:**
  - The block holds `<marker> #<tag>`.
  - The idle commit leaves a `#name` written as text to blur, so the draft
    is the text's only copy. The spec checks both: the draft holds the
    text, and no `edit_block` does.
  - Then the app is SIGKILLed and relaunched, and the text is back.

**Corrections to the issue:**
- **Item 14:** plain text is committed by the 700 ms idle commit before the
  2 s draft, so "type, kill, relaunch" passes even with draft restore
  broken. Only text the idle commit leaves to blur shows it.
- **Item 16 (the boot sweep of leaked blank blocks):** this can't be shown
  in the real lane. `select_candidates` only sweeps a block older than
  `SWEEP_MIN_AGE` (7 days) with no op inside that window, so nothing a run
  creates qualifies. The Rust tests in `agaric-engine/src/empty_blocks.rs`
  and `src/soft_delete/empty_block_sweep.rs` cover it. It is ticked on that
  coverage, as op log compaction was on #5737.
- **`/voice` (item 13)** was moved out of the issue: no lane can record
  until #5730 lands.

**Shared helper:** `restartApp('close' | 'kill')` moved to
`e2e-tauri/helpers.ts`. `page-mode-restart.e2e.ts` uses it.

**CI:** the lane's apt list gains `gstreamer1.0-plugins-good`, WebKitGTK's
WAV demuxer. The cache key moved to `-v4` so the new package is cached.

**Shown red:**
- **Item 12:** `read_attachment` dropping the first byte.
- **Item 15:** the idle commit's focus check inverted.
- **Item 14:** `recover_drafts` treating every draft as orphaned. Breaking
  only the frontend's `flush_all_drafts` stays green, because the backend
  restores drafts first.

Each mutation turns only its own test red.

**Ran:**
- the file three times green on clean binaries;
- `page-mode-restart.e2e.ts` once;
- `npm run typecheck:e2e-tauri`, `npx vitest run e2e-tauri`, oxlint, oxfmt;
- `prek run` on the workflow.
