# Real-backend e2e (WebdriverIO + tauri-driver)

> The only frontend lane with no second implementation in the loop: the real debug binary in a WebKitGTK WebView over real Tauri IPC. Config: [`wdio.conf.ts`](../wdio.conf.ts). Playwright conventions (portal helpers, testid policy) are in [`e2e/AGENTS.md`](../e2e/AGENTS.md); they apply here only where a helper in `helpers.ts` says so.

## Running

```sh
gh workflow run e2e-tauri-weekly.yml --ref <branch>     # on demand
gh run list --workflow e2e-tauri-weekly.yml --branch <branch> --limit 3
```

It also runs weekly and on every PR to `main`, where it is skipped unless the diff touches something the lane builds or runs (the `real_backend` output of `scripts/classify-changes.sh`; when the diff's only lane paths are specs, it runs just those, `real_backend_specs`); the `e2e-tauri-gate` job reports either way. It is not a required check (#4671), so read its result on the PR before merging; a new spec has shown nothing until its control case has run there.

Locally you need Linux with `webkit2gtk-driver`, `xvfb`, `dbus-daemon`, `openbox`, `xdotool`, and `cargo install tauri-driver --locked`. Build as the workflow does, then run under a window manager (without one `document.hasFocus()` stays false and `waitForAppReady` fails, #5457):

```sh
npm run tauri -- build --debug --no-bundle --config '{"build":{"beforeBuildCommand":"npm run build"}}'
(cd src-tauri && cargo build -p agaric-diagnostics --bin e2e_sync_peer && cargo build -p agaric --bin agaric-mcp)
env -u WAYLAND_DISPLAY GDK_BACKEND=x11 WDIO_SKIP_TAURI_BUILD=1 xvfb-run -a dbus-run-session -- bash -c 'openbox & npm run test:e2e-tauri'
```

On a Wayland desktop, `xvfb-run` sets only `DISPLAY`, so without the `env` prefix GTK opens the app on the desktop session instead of Xvfb, and the focus check fails.

The `--config` skips `prepare-external-bins.mjs`'s release build of the `agaric-mcp` sidecar, which `--no-bundle` ships nowhere (the debug `agaric-mcp` built above is the bridge `mcp-agent-token.e2e.ts` spawns); `wdio.conf.ts`'s own build, when `WDIO_SKIP_TAURI_BUILD` is unset, does not pass it and pays that cost. A dev box without those runs nothing; `npm run typecheck:e2e-tauri` and `npx vitest run e2e-tauri` are the local checks.

A failed job's log: [`.github/AGENTS.md`](../.github/AGENTS.md) § Reading a run. `gh run download <run_id>` fetches the `e2e-tauri-diagnostics` artifact (screenshots, app log, the visibility verdict).

Show a spec red here, not on a scratch branch: apply the break, rebuild, and run that spec alone (`npm run test:e2e-tauri -- --spec e2e-tauri/<file>.e2e.ts`). A branch pushed only to show red costs a full CI run and leaves a remote branch behind.

## Rules

- **One file, one vault.** WDIO forks a worker per spec file, and each worker boots the app on a fresh `AGARIC_DATA_DIR` (`mkdtemp`). A spec never sees another file's data; a second `it` in the same file does see the first one's.
- **Order-independent.** Nothing may depend on which file ran first or on a leftover row: scope every typed name through `runScopedMarker` (it also collapses doubled characters, which WebKit drops).
- **Persistence is a nav round-trip.** Create through the UI, leave the view through the sidebar (`navigateTo`), come back, and assert the re-queried DOM: `blockStaticByMarker`, `reopenPageByTitle`, `expectAbsent`. Never `browser.refresh()`: it can drop the IPC bridge (see `block-persist-reload.e2e.ts`).
- **A UI rename, move or removal breaks this lane silently.** Changing a control's label, placeholder or testid, or removing the flow it sits in, means grepping `e2e-tauri/` for the old one in the same PR: `helpers.ts`'s header lists the shared selectors, but most specs also inline their own, and no required check catches it.
- Waits are generous (`NAV_TIMEOUT` / `ACTION_TIMEOUT` = 60 s) because the runner is shared; never `browser.pause` to wait for state, `waitUntil` on the DOM instead. Typed text goes through `typeMarkerVerified` / `typeInputVerified` / `typeVerified`, which send it in `distinctKeyChunks` and read back and retype dropped keystrokes. Never type text with a repeated character through one raw `browser.keys` call: it holds every key down before releasing any, and WebKitGTK's driver can drop a key pressed again while held (`[[` arrived as `[`, and every space after the first was dropped).
- **WebdriverIO's `*=` / `=` text match takes a single tag or attribute selector** (`[data-testid="block-static"]*=…`); with two (`[a][b]*=…`) it is rejected as an invalid selector. Select by the attributes and compare `getText()`.
- **Never self-skip on an environment precondition** (focus, driver): fail, as `waitForAppReady` does, so the lane reds instead of passing vacuously.
- **Click only to focus, and never an element whose layout is still settling** (an image resolving, a badge mounting): WebDriver clicks a centre computed before the shift (`focusForTyping`).
- **After Enter, wait for `enterBlankSibling`.** The create is a round-trip, and until it answers the source block's emptied editor also reads blank.
- **The week view mounts a day lazily and renders off-screen rows as placeholders**; see `e2e/AGENTS.md` § Flakes.
- **Two-device specs** (`sync-peer.ts`): a session is a pull by the device that dials, so a peer write reaches the app when the app syncs: press the sidebar Sync button, not Settings' "Sync now", whose navigation remounts the view under test. For a concurrent edit, the app writes and closes its editor before the peer writes. `sync-two-device.e2e.ts` and `sync-refresh.e2e.ts` carry the details.
- **A wedged run where every later `POST /session` times out** is an orphaned app holding the single-instance D-Bus name; `reapSessionApp` in `wdio.conf.ts` exists for it.
