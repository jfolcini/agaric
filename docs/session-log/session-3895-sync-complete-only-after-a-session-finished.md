# Session 3895 — "Sync complete" only after a session finished

Issue #6551, its first item. The second (a local edit triggers a sync, and a served pull makes the responder pull back) is untouched.

- **Premise, confirmed.** `start_sync_inner` only calls `scheduler.notify_change()` and returned `state: "complete"`. `syncAll({ userInitiated: true })` raised "Sync complete" as soon as that resolved, which it does with the peer switched off. The scheduled tick wrote `syncing` then `idle` the same way.
- **Backend.** `start_sync_inner` returns `state: "queued"`. No type changed (the field is a `String`), so bindings and the `start_sync` conformance waiver are unchanged. The mock's `start_sync` said `syncing`; it now says `queued` too.
- **Frontend (`useSyncTrigger`).** A press waits, under the existing `SYNC_TIMEOUT_MS`, for the terminal `kind: 'sync'` update on the channel its `start_sync` opened (`ChannelEventSink` turns `SyncEvent::Complete` / `Error` into `complete` / `error` there). `complete` is the only success. An `error` while the store still says `syncing` is a failure no `sync:error` reported, and gets the per-peer failure toast. An `error` after `sync:error` already set `error` (a reported failure) or `idle` (a cancel) stays quiet, as that event answered it. A timeout gets the per-peer failure toast, and the press's own `syncing` returns to `idle`.
- **Scheduled tick.** It does not wait for its session and no longer writes `syncing` / `idle`. The session's own channel updates and `sync:complete` / `sync:error` drive the store. It only drops an `offline` the network's return made untrue, which its old `syncing` write used to do.
- **Trap (e2e).** Sonner renders a toast on a `setTimeout(0)`. Under `page.clock.pauseAt`, a toast never appears until the clock runs. A `toHaveCount(0)` on a toast is vacuous unless the clock was run first (`page.clock.runFor`).
- **e2e.** The mock lane can show this: its `start_sync` resolves at once and reports nothing, as the backend does with the peer off. That is why the spec is in `e2e/sync-happy-paths.spec.ts` and not `e2e-tauri/`. `keepSyncChannels` / `streamSyncProgress` moved from `sync-peer-progress.spec.ts` to `e2e/helpers.ts`, and `finishSyncSession` (`e2e/domain.ts`) plays both halves of the backend's session end. The two specs that pressed Sync and emitted only `sync:complete` now also end the session on its channel, because a press now waits for that.
- **Checks that ran.**
  - vitest red first: 4 new `useSyncTrigger` tests failed against the old hook. Six mutations of the new code were each killed.
  - nextest red first: the three `start_sync` state assertions failed on `"complete"`.
  - The Playwright spec reds against the old hook on its `Sync complete` count assertion.
