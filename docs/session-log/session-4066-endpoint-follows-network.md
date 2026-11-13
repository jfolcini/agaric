# Session 4066 — the sync endpoint follows the network and keeps its port (#6526)

The issue said the endpoint binds once and a laptop that changes network keeps a socket on the old subnet. It had not been run. Running it changed the design.

## What a lost address does to an iroh endpoint

A throwaway test bound an endpoint on an address alias (`10.77.1.2/24` on `eth0`, added and removed by `ioctl` from a root shell), then took the alias away. With iroh 1.4.1, within three seconds and with no traffic:

- `accept` returns `None`, so the daemon's accept loop ends;
- every dial fails at once with "endpoint stopping", inbound dials time out, and a connection that was open is lost with `INTERNAL_ERROR`;
- `is_closed()` stays `false` and `addr()` still names the old address;
- the same address coming back revives nothing.

So an interface that drops and comes back on one network kills sync until restart, which is wider than the issue's case, and comparing addresses on the resync tick, the issue's whole design, misses it: the address is the same. `close()` on such an endpoint returns in under a millisecond, the old socket is free afterwards, and a new endpoint with the same key and port binds and syncs.

## What shipped (PR for #6526, items 1 and 2)

`daemon_loop` is an outer loop around `run_daemon`, one bound endpoint. It binds again when the accept loop ends (Branch F, at once, after a one-second pause that also keeps endpoints that stop as they are bound from spinning the loop), when the resync tick finds the bind policy picking another LAN address and no session active, and when a bring-up failed (doubling from `MIN_BACKOFF` to `MAX_BACKOFF`). A rebind clears every peer's backoff. `select_bind_target` no longer logs, since the tick calls it; `BindDecision::log` logs the decision that gets bound.

The bound port is stored under `sync.endpoint_port` in `app_settings` and asked for at each bind, with a fallback to an OS port that is then stored. `get_local_sync_address` reads the bound socket for a row in Settings › Sync & devices, which says "no local network" on the loopback fallback.

Decisions that differ from the issue:

- **No new `SyncEvent` for the loopback bind.** The address row carries the fact, and #6687 and #6688 were both rewriting the event enum, the sink and `useSyncEvents`.
- **A decision with no LAN moves nothing.** An interface that reads as down for a moment would otherwise take a working endpoint to loopback; an endpoint whose address is really gone stops by itself. From the review.
- **The tick's check runs while backgrounded.** A minimized desktop app has to follow the network too. From the review.
- **Item 3 (release the Android multicast lock while suspended) is not built.** The daemon learns of backgrounding only by polling on its tick, and Android freezes a suspended process before a 30 s tick fires, so the release has to live in the app's `WindowEvent::Suspended` handler with the lock in state shared with the daemon. None of that JNI path compiles on the host, and a missed re-acquire costs the phone its discovery until restart. Only the false sentence in `docs/features/sync.md` was corrected.

## Tests, and what they cannot show

`sync_daemon/tests/endpoint_follows_network.rs`, Linux only: each `/24` of the loopback `/8` is one network. `BindPolicy` is the seam; its test-only `bound` hook hands the test each endpoint, and closing one ends the accept loop as a lost address does. Every production branch was mutated and seen red on its own assertion. A lost address itself cannot be staged without `CAP_NET_ADMIN`, so that trigger rests on the hand run above.

Left open, said on the issue: the `InternetFacingBind` banner and the `MdnsDisabled` status only ever latch, so after a rebind they can describe the previous endpoint; and nothing was tried on two real devices.

## Traps

- **`E0275` at `tokio::spawn(daemon_loop(..))`.** The `Send` proof of the daemon future runs through Loro's types and is sensitive to the future's shape: removing `service.close().await`, or replacing one `select!` with `break`, failed to compile with "overflow evaluating the requirement", though the shipped code compiles with a recursion limit near 100. A mutation that does not compile is not a kill; pick another, or raise `recursion_limit` for the run.
- **A resync interval under `RESYNC_TICK` trips `peer_pulled_from_us_recently`'s `debug_assert`** in a worker thread, and the test then times out somewhere else. Make a peer due by nulling `peer_refs.synced_at` instead.
- **A falsification script that `cd`s must hold its backup by absolute path.** One restore failed on a relative path and left two mutations in an untracked file; it was restored by hand and re-run.
- **Deleting an address with `SIOCSIFFLAGS` deletes the subnet's secondaries with it.** Add the address that must survive first.

## What ran

The whole of `cargo nextest run --workspace` in two halves (8034 tests), `SQLX_OFFLINE=true cargo check --workspace --all-targets`, clippy over the workspace with `-D warnings` (non-incremental), the bindings and `.sqlx` regeneration with no diff, the `agaric-sync` and `agaric-store` doc-tests, the full vitest suite, `npm run typecheck`, `npm run lint` and the manual-stage hooks. `just e2e-related` answered "the whole lane" for both e2e lanes, so CI is their check; of Playwright, `sync-ui`, `sync-pairing-flows` and `sync-happy-paths` ran here. The real-backend lane did not (no `WebKitWebDriver` or `tauri-driver` in the container), so the new `it` in `e2e-tauri/sync-two-device.e2e.ts` was first run by CI and was not shown red.
