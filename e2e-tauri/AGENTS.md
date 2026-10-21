# Real-backend e2e (WebdriverIO + tauri-driver)

> The only frontend lane with no second implementation in the loop: the real debug binary in a WebKitGTK WebView over real Tauri IPC. Config: [`wdio.conf.ts`](../wdio.conf.ts). Playwright conventions (portal helpers, testid policy) are in [`e2e/AGENTS.md`](../e2e/AGENTS.md); they apply here only where a helper in `helpers.ts` says so.

## Running

```sh
gh workflow run e2e-tauri-weekly.yml --ref <branch>     # on demand
gh run list --workflow e2e-tauri-weekly.yml --branch <branch> --limit 3
```

It also runs weekly, on every release tag (where `publish-release` requires it), and on every PR to `main`, where it is skipped unless the diff touches something the lane builds or runs (the `real_backend` output of `scripts/classify-changes.sh`; when the diff's only lane paths are specs, it runs just those, `real_backend_specs`); the `e2e-tauri-gate` job reports either way. `e2e-tauri-gate` is a required check (#4671); a new spec has shown nothing until its control case has run there.

Locally you need Linux with `webkit2gtk-driver`, `xvfb`, `dbus-daemon`, `openbox`, `xdotool`, and `cargo install tauri-driver --locked`. Run one spec with:

```sh
just e2e-real e2e-tauri/<file>.e2e.ts
```

`scripts/e2e-tauri-local.sh` checks those tools but `xdotool`, which only the OS-chord specs call, then runs WDIO under Xvfb with openbox (without a window manager `document.hasFocus()` stays false and `waitForAppReady` fails, #5457) and with `WAYLAND_DISPLAY` unset (`xvfb-run` sets only `DISPLAY`, so GTK would open the app on the desktop session). `wdio.conf.ts`'s `onPrepare` builds as the workflow does, in one compile: the CLI builds every bin of `agaric` and `agaric-diagnostics`, so it also emits the `agaric-mcp` bridge `mcp-agent-token.e2e.ts` spawns and the `e2e_sync_peer` sync peer, and its `--config` skips `prepare-external-bins.mjs`'s release build of the `agaric-mcp` sidecar, which `--no-bundle` ships nowhere. `WDIO_SKIP_TAURI_BUILD=1` skips that build, as CI does with the binaries its `build` job uploads. Either way `onPrepare` refuses a missing `agaric` or one that embeds no `dist/`: plain cargo relinks that path as a `devUrl` build, and `cargo nextest run --workspace` does so too, because it builds the package's bins with its integration tests. A dev box without those tools runs nothing; `npm run typecheck:e2e-tauri` and `npx vitest run e2e-tauri` are the local checks.

A failed job's log: [`.github/AGENTS.md`](../.github/AGENTS.md) § Reading a run. `gh run download <run_id> -p 'e2e-tauri-diagnostics-*'` fetches each shard's diagnostics (screenshots, app log, sync peer logs, the visibility verdict). The harness sets `AGARIC_STDERR_LOG=warn` for the app and the sync peer, so the console carries only their warnings and errors and the full `info` log is in that artifact; `AGARIC_STDERR_LOG=info` brings the stream back.

`just e2e-related` prints the `--spec` list for the specs your change can affect, picked by the area tags each top-level `describe` title ends with (`… @editor @pages`).

Show a spec red here, not on a scratch branch: apply the break and run that spec alone with `just e2e-real`, which rebuilds. A branch pushed only to show red costs a full CI run and leaves a remote branch behind.

## Rules

- **One file, one vault.** WDIO forks a worker per spec file, and each worker boots the app on a fresh `AGARIC_DATA_DIR` (`mkdtemp`). A spec never sees another file's data; a second `it` in the same file does see the first one's.
- **Order-independent.** Nothing may depend on which file ran first or on a leftover row: scope every typed name through `runScopedMarker` (it also collapses doubled characters, which WebKit drops).
- **Persistence is a nav round-trip.** Create through the UI, leave the view through the sidebar (`navigateTo`), come back, and assert the re-queried DOM: `blockStaticByMarker`, `reopenPageByTitle`, `expectAbsent`. Never `browser.refresh()`: it can drop the IPC bridge (see `block-persist-reload.e2e.ts`).
- **A UI rename, move or removal breaks this lane silently.** Changing a control's label, placeholder or testid, or removing the flow it sits in, means grepping `e2e-tauri/` for the old one in the same PR: `helpers.ts`'s header lists the shared selectors, but most specs also inline their own, and no required check catches it.
- Waits are generous (`NAV_TIMEOUT` / `ACTION_TIMEOUT` = 60 s) because the runner is shared; never `browser.pause` to wait for state, `waitUntil` on the DOM instead. Typed text goes through `typeMarkerVerified` / `typeInputVerified` / `typeVerified`, which send it in `distinctKeyChunks` and read back and retype dropped keystrokes. Never type text with a repeated character through one raw `browser.keys` call: it holds every key down before releasing any, and WebKitGTK's driver can drop a key pressed again while held (`[[` arrived as `[`, and every space after the first was dropped).
- **WebdriverIO's `*=` / `=` text match takes a single tag or attribute selector** (`[data-testid="block-static"]*=…`); with two (`[a][b]*=…`) it is rejected as an invalid selector. Select by the attributes and compare `getText()`.
- **Never self-skip on an environment precondition** (focus, driver): fail, as `waitForAppReady` does, so the lane reds instead of passing vacuously.
- **Click only to focus, and never an element whose layout is still settling** (an image resolving, a badge mounting, a sheet sliding in): WebDriver clicks a centre computed before the shift (`focusForTyping`), and `waitForDisplayed` returns mid-slide, so wait for `getAnimations()` to empty (`openPropertyDrawer`). After a click that raises a toast, move the pointer off (`clickPageSourceButton`): WebKit counts a toast sliding under it as a hover, and sonner then holds the stack open over later clicks.
- **WebKitGTK's driver:** it ignores keystrokes in `type=date` / `time` inputs (set the value through `HTMLInputElement.prototype`'s setter, then dispatch `input` and `change`); its right-click releases as a left click (`openContextMenu`); and an element resolved in one command can be gone by the next, so poll fresh finds inside `browser.waitUntil` (`expectAbsent`) and read a set of elements' text in one `browser.execute` (`waitForToast`).
- **A frontend call to a Tauri core or plugin API needs its permission in `src-tauri/capabilities/*.json`.** A denial shows only as "not allowed" in the app log, and no mock-backed lane can see it, so the call gets a spec here.
- **Grep `helpers.ts` before writing a spec-local helper** (an `invoke` wrapper, a date formatter, opening a drawer); a second copy moves there.
- **After Enter, wait for `enterBlankSibling`.** The create is a round-trip, and until it answers the source block's emptied editor also reads blank.
- **The week view mounts a day lazily and renders off-screen rows as placeholders**; see `e2e/AGENTS.md` § Flakes. Scroll to what you will click with the platform's `scrollIntoView` through `browser.execute`: WebdriverIO's aligns to the window's top, under the view header, where WebKit will not click (`week-cross-day-clipboard.e2e.ts`).
- **Two-device specs** (`sync-peer.ts`): a session is a pull by the device that dials, so a peer write reaches the app when the app syncs: press the sidebar Sync button, not Settings' "Sync now", whose navigation remounts the view under test. For a concurrent edit, the app writes and closes its editor before the peer writes. A byte-transfer test sends different bytes each way: identical bytes dedup to the blob the receiver already holds, so it passes with nothing moved. `sync-two-device.e2e.ts` and `sync-refresh.e2e.ts` carry the details.
- **A wedged run where every later `POST /session` times out** is an orphaned app holding the single-instance D-Bus name; `reapSessionApp` in `wdio.conf.ts` exists for it. A local run that fails at once with "can not listen to address" meets an interrupted run's `tauri-driver` still on port 4444: kill that PID.
