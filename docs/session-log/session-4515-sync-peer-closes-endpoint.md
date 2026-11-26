# Session 4515 — The e2e sync peer closes its endpoint before it exits

**Ask.** The last open item from #7129's log review: `ERROR iroh::socket: Endpoint dropped without calling Endpoint::close` at the end of `e2e-tauri/sync-two-device.e2e.ts`.

**Found.**
- The line came from the `e2e_sync_peer` sidecar, not the app. Its stderr is plain text (`with_ansi(false)`) where the app's carries colour codes, and it lands where the spec's `after` hook ends the peer's stdin.
- `Peer::close` called `SyncDaemon::shutdown`, which only notifies the daemon, and returned. `main` then returned and dropped the runtime with the daemon task still alive, so the daemon's own `service.close().await` never ran or was cut short. iroh logs the line from `Drop` whenever `close` has not finished.
- The app has the same shape but never calls `shutdown`: its daemon lives until the process exits, where no `Drop` runs.

**Done.**
- `Peer::close` awaits the daemon's join handle after `shutdown`, the pattern the daemon tests already use, so the endpoint is closed before `main` returns.
- `SyncDaemon.handle`'s doc said only tests read it; it now names the sidecar too.
- Trade: a sync round in flight when the spec stops the peer now delays the peer's exit until the round ends, bounded by the session timeouts and well under the 300 s hook timeout. In the specs the app is alive and answering at that point.

**Ran.**
- `closing_the_peer_closes_its_endpoint_before_the_runtime_drops` (new) and the `sync_daemon` shutdown and dormant tests: 8 pass.
- Shown red: without the await, the new test fails on its assertion with iroh's `Endpoint dropped without calling Endpoint::close` line in the capture.
- `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all --check`: clean.
- The WebdriverIO spec itself was not run locally; the PR's `e2e-tauri-gate` run is the check.
