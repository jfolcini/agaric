# Session 2614 — the real-backend lane refuses a binary cargo relinked, and `just e2e-real`

#5849's last local items.

- **The hazard is real.** After the embedded build, `strings` found the
  bundle's `/assets/index-*` names in `target/debug/agaric`; after a
  `cargo nextest run --workspace --no-run` the binary was rebuilt (cargo
  builds a package's bins with its integration tests) and carried none.
  With `WDIO_SKIP_TAURI_BUILD=1` a spec then failed after 60 s on a missing
  sidebar. `onPrepare` now refuses a binary without the marker, in about
  0.2 s, naming the fix. CI's specs run the binary its build job made with
  the same command, so they pass the check.
- **`onPrepare` failures stop the run.** WebdriverIO logs an error thrown
  from `onPrepare` and runs the specs anyway, so a failed local build never
  stopped one either; `failPrepare` prints the message and exits, as
  `beforeSession` already does.
- **One compile locally:** `onPrepare` runs CI's command (`-- -p agaric -p
  agaric-diagnostics`) instead of three builds; `Compiling agaric` once.
- **`just e2e-real SPEC`** (`scripts/e2e-tauri-local.sh`): checks for
  tauri-driver, WebKitWebDriver, xvfb-run, openbox and dbus-run-session,
  then runs one spec under Xvfb with Wayland stripped. It leaves the build
  to `onPrepare`, so the command lives in one place.

Ran: the marker before and after nextest; the refusal against the relinked
binary; `just e2e-real e2e-tauri/draft-blur-persist.e2e.ts` (passed, 1m17s
with the rebuild); shellcheck, typecheck, `vitest run e2e-tauri` (46), prek.
