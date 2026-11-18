# Session 4269 — mirror-inbound reads the mirror status after the ingesting pass

Part of a flake sweep over two days of CI and e2e-tauri runs. One real-backend failure was not its PR's fault: `e2e-tauri/mirror-inbound.e2e.ts:91` in run 44231948303 (shard 4). There, `get_mirror_status().diverged` listed the test's own page right after the block had taken the outside edit, and the next two runs of the same branch passed.

**Cause.** A race in the spec, not the mirror. In `Mirror::read_edit` (`src-tauri/src/mirror/mod.rs`) the settling tick lists the page as diverged. The next tick's `ingest::ingest` commits the block's new text mid-pass, and the page leaves `diverged` only when `write_page` returns, after the file re-read and `store.save`. The spec polled the block, saw the edit, and read the status inside that window.

**Fix.** After the block shows the edit, the spec waits for `last_pass_ms` to move past the value read at that moment, then asserts the same exact status as before. It reads the status of a pass that ended after the ingest committed. The ingest's own ops, past the mirror's watermark, guarantee the next tick runs a pass. No timeout was raised and no retry or sleep was added.

**Verified.** The fixed spec passes alone on the real backend locally (`WDIO_SKIP_TAURI_BUILD=1` after CI's own `tauri build`; WDIO's in-process build fails here because its loader leaks into the child `vite build`). Falsified by widening the window: with a 3s sleep after the ingest's notify in `read_edit`, main's spec fails at `:91` with the page's file in `diverged`, the CI symptom, and the fixed spec passes. The sleep was reverted by the same command.
