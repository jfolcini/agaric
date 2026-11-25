# Session 4421 — the sync peer holds its session lock while it writes

**Ask.** Fix every flake. `e2e-tauri/sync-two-device.e2e.ts` failed "lists the peer's property definition, and reads the value the app held as a date (#5841)" on PR #7038, whose diff could not reach it: the peer refused `create_property_def` because it already held the app's value as text.

**The race.** The app's `set_property` asks for a round after the 2 s `LOCAL_EDIT_DEBOUNCE`. That round is the app dialling the peer; the peer serves it, sees the app ahead, and dials back to pull the value. When the pull-back landed before the test's `createPropertyDef`, the peer refused `date` over the stored text, as it should. "converges concurrent edits to one block on both devices" has the same shape: the peer must write before it pulls the app's edit. Its comment said the peer dials unprompted only on an mDNS sighting, which has been false since #6551.

**The fix.** The test peer gains `hold_sync` / `release_sync`: it takes the daemon's own per-peer session lock for the app (`try_lock_peer(peer_lock_key_from_stored(..))`, the key both roles lock on) and keeps it until released. While held, the app's dial is refused as busy (the app books a backoff and reports nothing) and the peer skips its own dial; `hold_sync` answers only once a running session has ended. Both tests hold the peer before the app writes, after waiting for the sidebar's Sync to be idle (a pressed sync refused as busy would toast), and release it in a `finally` before pressing Sync. No app code and no assertion changed.

**Red, then green.** With a 10 s pause before the peer's write in both tests, main's ordering failed both, the #5841 one with CI's error verbatim; the held ordering passed both under the same pause. The whole file passed three runs in a row on binaries built from the final sources.

**Ran:** `just e2e-real e2e-tauri/sync-two-device.e2e.ts` (×3, after the recipe's own build), the widened red/green pair, `cargo clippy -p agaric-diagnostics --all-targets --features bridge -- -D warnings`, `cargo fmt --check`, `npm run typecheck:e2e-tauri`, oxlint and oxfmt on the changed TS, `npx vitest run e2e-tauri`.
