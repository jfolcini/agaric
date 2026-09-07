# Real-backend e2e (WebdriverIO + tauri-driver)

> The only frontend lane with no second implementation in the loop: the real debug binary in a WebKitGTK WebView over real Tauri IPC. Config: [`wdio.conf.ts`](../wdio.conf.ts). Playwright conventions (portal helpers, testid policy) are in [`e2e/AGENTS.md`](../e2e/AGENTS.md); they apply here only where a helper in `helpers.ts` says so.

## Running

```sh
gh workflow run e2e-tauri-weekly.yml --ref <branch>     # CI (the usual way; ~17 min; cron Mondays 02:43 UTC)
gh run list --workflow e2e-tauri-weekly.yml --branch <branch> --limit 3
```

Locally you need Linux with `webkit2gtk-driver`, `xvfb`, `dbus-daemon`, `cargo install tauri-driver --locked`, and a built binary (`npm run tauri -- build --debug --no-bundle`). Then `WDIO_SKIP_TAURI_BUILD=1 xvfb-run -a dbus-run-session -- npm run test:e2e-tauri`. A dev box without those runs nothing; `npm run typecheck:e2e-tauri` and `npx vitest run e2e-tauri` are the local checks.

`gh run view --log` prints nothing for this repo; read a failed job with `gh api /repos/jfolcini/agaric/actions/jobs/<job_id>/logs` and `gh run download <run_id>` for the `e2e-tauri-diagnostics` artifact (screenshots, app log, the visibility verdict).

## Rules

- **One file, one vault.** WDIO forks a worker per spec file, and each worker boots the app on a fresh `AGARIC_DATA_DIR` (`mkdtemp`). A spec never sees another file's data; a second `it` in the same file does see the first one's.
- **Order-independent.** Nothing may depend on which file ran first or on a leftover row: scope every typed name through `runScopedMarker` (it also collapses doubled characters, which WebKit drops), and never `browser.refresh()`.
- **Persistence is a nav round-trip.** Create through the UI, leave the view through the sidebar (`navigateTo`), come back, and assert the re-queried DOM: `blockStaticByMarker`, `reopenPageByTitle`, `expectAbsent`. `browser.refresh()` can drop the IPC bridge (see `block-persist-reload.e2e.ts`). A `toHaveBeenCalledWith` has no equivalent here on purpose.
- **Every production bug lands a spec here** — root [AGENTS.md § Testing invariants, rule 4](../AGENTS.md#testing-invariants-anti-drift). Until the lane is a required context, pair it with a per-PR test.
- Waits are generous (`NAV_TIMEOUT` / `ACTION_TIMEOUT` = 60 s) because the runner is shared; never `browser.pause` to wait for state, `waitUntil` on the DOM instead. Typed text goes through `typeMarkerVerified` / `typeInputVerified`, which read back and retype dropped keystrokes.
