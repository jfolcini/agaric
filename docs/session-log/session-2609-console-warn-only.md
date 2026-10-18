# Session 2609 — the real-backend harness's console carries only warnings and errors

The maintainer's rule: on CI, only warn and error messages reach the
console; info and debug detail lives in files uploaded as artifacts. #5871
put WebdriverIO at `warn`; the lane still printed about 6,300 `INFO` lines a
run from the app (its stderr, inherited through tauri-driver) and the sync
peer (its stderr).

- **The app:** `AGARIC_STDERR_LOG` sets the stderr layer's filter apart
  from the log file's (`stderr_log_filter` in `lib.rs`). Unset, the console
  uses the file's filter, as before; an invalid value falls back to it with
  one warning. The file keeps `info`, and `rescueAppLogs` already copies it
  into the diagnostics artifact.
- **The sync peer:** stderr follows `AGARIC_STDERR_LOG` (default `info`),
  and a second layer writes `info` to `<vault>/logs/e2e_sync_peer.log`,
  which `sync-peer.ts` copies into `e2e-tauri/artifacts/peer-logs/` before
  it deletes the vault.
- **The harness** sets `AGARIC_STDERR_LOG=warn` for both, locally too (the
  logs are rescued either way); `AGARIC_STDERR_LOG=info` brings the stream
  back. The spec reporter prints only failing spec files
  (`onlyFailures`).

Ran: three unit tests on the filter helper, each red with the helper
broken; the peer by hand with `warn` (stderr empty, file 12 `INFO`), unset
and invalid; `sync-raw-loro-bytes.e2e.ts` on the real backend locally (a
60-line console, no `INFO`, 4 `WARN` and 1 `ERROR`; 62 and 326 `INFO` in
the rescued app and peer logs); clippy, fmt, typecheck, `vitest run
e2e-tauri`.
