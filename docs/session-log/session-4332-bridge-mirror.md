# Session 4332: a mirror daemon per bridge vault

Stage 0, gap G5 of #6926 (#6529).

**Gap:** the bridge's vaults managed `MirrorState` (G2, #6929) but ran no mirror task. A spec could choose a folder, and no file ever appeared there. The WebdriverIO mirror specs (`mirror-inbound`, `mirror-new-file`, `mirror-read-back`, `mirror-spaces`, `mirror-structure`, and the first half of `mirror-copy-files`) need one to move onto the bridge.

**Fix:**
- `HeadlessApp::boot` starts the mirror as the app's boot does: `mirror::spawn` over the managed `MirrorState`, with `Ingest::for_app`.
- The app aborts the task when it is dropped, beside the change feed. So a `reset` stops the old copy's mirror before its pools close.
- `mirror::spawn` now returns the task's handle; the app's boot drops it, so its mirror still runs for the app's life.
- A spec chooses a folder of its own with `set_mirror_folder`. With no folder chosen, the task reads the settings every two seconds and does nothing else.

**Test:** `the_mirror_writes_a_page_into_the_chosen_folder` creates a page on a bridge, chooses a temp folder, and waits for the page's `.md` file. Before the fix, after 30 s the folder held only the mirror's marker file.

**Ran:**
- The `headless_bridge`, `conformance_ipc` and mirror nextest groups: 203 passed. The reset budget test still passes.
- `cargo clippy --workspace --all-targets` is clean.
- On a rebuilt bridge: `graph-view`, `header-search-button`, `history-revert` and `advanced-query-saved-views` at three workers.
  - One test failed once: graph-view's "Fit to view returns there", at its 20 s timeout. It takes about 13 s alone.
  - It then passed 6 of 6 alone, all of graph-view passed, and the same loaded set passed twice more (31 of 31 each).
  - The mirror with no folder is idle, so it does not explain the timeout. It is that test's margin under load, and I am reporting it, not changing it here.
