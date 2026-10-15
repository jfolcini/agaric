# Session 2080 — The e2e-tauri lane reaps an app that outlives its session

The real-backend WDIO lane sometimes wedged partway through: every spec after
one point timed out in `POST /session`. The cause is an orphaned app, not a spec.
`afterSession` SIGTERMs `tauri-driver`, which SIGKILLs `WebKitWebDriver` and
exits; if that driver had not yet closed the app, the app survives. It still
holds the `tauri-plugin-single-instance` name on the run's one shared D-Bus
session bus, so every later launch hands off to it and exits during plugin
setup, and `WebKitWebDriver` waits forever. Two wedged runs show it: after
spec 32 (run 38665925103) the passed spec's app keeps logging under its old
worker prefix 52 s after its worker exited, and each later app prints only the
AT-SPI warning, never the boot log that runs after plugin setup; run 38658790656
wedges the same way after spec 1. The two runs share no spec, so it is a race
between `deleteSession` and killing the driver.

`reapSessionApp` in `wdio.conf.ts` runs from `afterSession` before the sandbox
is removed: it finds this session's app in `/proc` by executable and its
`AGARIC_DATA_DIR`, gives it 2 s to exit, SIGKILLs any survivor with a warning
(`outlived the session`), and throws if it still has not gone. The connection
retry budget drops from 3 × 120 s to 1 × 30 s, so a wedged session fails in
about a minute instead of eight; every real request in the logs answers in
about a second.

Not run locally: the lane itself (no tauri-driver or WebKit driver here). The
`/proc` matcher was exercised in a scratch script against an orphaned
grandchild (found, prefix- and suffix-differing vaults not matched, gone after
the kill). Ran `tsc -p tsconfig.wdio.json`, oxlint, oxfmt, the vault-isolation
and driver-gate checks, and `npx vitest run e2e-tauri`. The PR's lane run is
the evidence; a wedge caught by the fix shows the `outlived the session` line
followed by the next spec booting normally.
