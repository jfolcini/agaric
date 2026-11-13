# Session 4113 — a bridge serves the real commands to Playwright (#6529 stage 1b)

Stage 1b of #6529, after stage 1a (session 4092) landed `HeadlessApp`. One PR. It meets the stage's "done when"; three items of the stage's "Change" list are not in it, and the issue has the reasons and the options.

## Shipped

- **`headless::bridge`** (`src-tauri/src/headless/bridge.rs`, `test-util`): one `HeadlessApp` behind a WebSocket for one Playwright worker. Requests are `invoke`, `listen`, `emit` and `reset`; an app event the page listens to is pushed to it. `reset` drops the open vault and boots a copy of a template booted once at start.
- **`HeadlessApp::boot` and `shutdown`**, which stage 1a left on the spike branch.
- **The `bridge` bin** in `agaric-diagnostics`: a `main` over `bridge::serve`. It prints `{"port":N}` and exits when its stdin closes.
- **`src/lib/tauri-mock/bridge.ts`**: with `window.__AGARIC_BRIDGE__` set, `setupMock` installs it instead of the mock. App commands go to the bridge; `plugin:*` commands stay on the mock's handlers.
- **`e2e/bridge.ts`** and two fixtures in `e2e/helpers.ts`: with `AGARIC_E2E_BRIDGE` naming the binary, one bridge per worker, a `reset` before each test, and the URL injected into every page of the context.

## Decisions

- **The server lives in the app crate, the bin is a `main`.** A bin in `agaric-diagnostics` needs the app's `test-util`, and that package is built beside the app in the real-backend lane, so the bin sits behind a `bridge` feature with `required-features`. `clippy --workspace --all-targets` skips such a bin. Everything that can be wrong is therefore in `headless::bridge`, which every `--all-targets` build compiles and the tests drive; the bin is linted by `cargo clippy -p agaric-diagnostics --features bridge --bin bridge`, which no CI lane runs.
- **`tokio-tungstenite`** is the one new dependency (two crates in the lock), optional and reached only through `test-util`. Nothing in the tree spoke WebSocket.
- **The app's thread takes requests in order and only starts an `invoke` there.** `App<MockRuntime>` is not `Send` and a boot blocks on the runtime, so one thread owns the app; `Webview::on_message` returns at once, so commands still run concurrently.
- **Events before replies.** The client task's `select!` is `biased` with events first. Unbiased, the reply to a command could overtake the event its wrapper emitted before returning; the WebSocket test caught that as a flake on its first run.
- **Which events to forward is the page's call.** The mocks' own event bus answers `plugin:event|listen` in the browser, so the client wraps `invoke` and sends the bridge a `listen` for each. No list of event names to keep in step.
- **Managed state: only what the first spec's commands read.** `boot` registers the recovery status, which the app asks for as it boots; without it the spec still passes but `get_recovery_status` is refused as unmanaged. The mirror, mDNS and bind-exposure states the spike registered are left out: the spec passes without them and nothing warns. The next spec that needs one adds it; a registration shared with `crate::boot` waits until that happens twice.
- **The template is a first boot's vault.** No seed: see below.

## Not built, and why

- **The mock's seed with its literal `SEED_IDS`.** The real commands cannot take those ids: `create_block` mints its own id for a page (`create_page_in_space_inner` passes no client id), and rejects `0000000000000000000BLOCK01` as an invalid ULID (`L` and `O` are not Crockford). So the seed has to go in below the command layer, or the ids or the page command have to change. That is a design choice; the options are on the issue.
- **`Channel` messages.** tauri sends them by evaluating script in the webview, and `MockRuntime` keeps only the last script it was given. A command that takes a `Channel` still runs; its progress goes nowhere.
- **`@mock-only` tags.** Nothing reads them until stage 1c's project, and without the seed most specs cannot run on the bridge for a reason the tag does not name.

## Traps

- **`@tauri-apps/api/core` is stubbed suite-wide in vitest.** A test of the seam calls `window.__TAURI_INTERNALS__.invoke`, as the real `invoke` does.
- **Debug info fills the session's disk.** These builds ran with `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0`; the bridge bin is a second feature set of the whole app.
- **A page gets a minted id even with a `blockId`.** A tag takes it. Found by probing the bridge, not by reading.

## Shown red

- The spec on the bridge: `search_blocks` given a fixed nonsense query in its wrapper, the bin rebuilt, `search-nested-result.spec.ts` times out on its result row.
- `headless_bridge.rs`: a `reset` that does nothing, a `listen` that registers twice, a `reset` that keeps the listening set, and a 320 ms sleep in the swap, each killed by the assertion it was aimed at.
- `bridge.test.ts`: plugin commands sent to the bridge, no `listen` request, an error resolved instead of rejected, `emitMockEvent` emitting in the page, no rejection on close, `setupMock` ignoring the URL. Six mutations, six reds.

## What ran

`search-nested-result.spec.ts` on the bridge, three times in one worker, on the final code; four spec files on the mock with the variable unset. Both halves of `cargo nextest run --workspace` (4041 and 4034 passed; the `command_integration` binary again after the managed-state change), `SQLX_OFFLINE=true cargo check --workspace --all-targets`, clippy on the workspace and on the bin, `just gen-bindings` and `just gen-sqlx` with no diff, the full vitest suite, `npm run typecheck`, `npm run lint`, `prek run --all-files` and the manual stage.

A reset: 49 ms at the median over 15 runs, 44 to 63 ms, debug build, 4 vCPU. `a_reset_stays_within_its_budget` asserts the median stays at or under 300 ms wherever the Rust tests run.

The whole Playwright lane did not run locally; `e2e/helpers.ts` changed, so CI runs it.
