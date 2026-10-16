# Session 2284 — The boot harness times what the user waits for, in isolation

#5419 is gated on re-measuring boot after #5418 step 2. Its decision turns on
the part of boot before the window is usable, and the harness could not see
that part: `main` logged no frontend milestone.

**Milestone.** Each call to `useBootStore.boot`, retries included, sends one
`boot resolved` line with its outcome (`ready` or `error`). Production drops
`logger.info`, so the line goes to the backend sink, which `main.tsx` sets to
`logFrontend`. Calling `logFrontend` directly broke twenty tests in suites
that never stub `log_frontend`; the sink is the existing seam. In the JSON
log it lands as `target: "frontend"`. That is #5419's third acceptance item.
Dropping the error-path line, logging the ready line twice, and dropping the
warn on a rejected write each reddened the new tests.

**Harness.** `scripts/measure-boot.mjs` now reports:
- process start to the first log line;
- log start to engines rehydrated, replay done, sync started and `boot
  resolved`;
- the frontend part on its own;
- the time between consecutive backend milestones, so a dominant step stands
  out.

A rewind of 0 leaves the apply cursor alone, for a quiet boot.

**Isolation the old harness lacked:**
- The app inherited `WAYLAND_DISPLAY`, so its window could open on the
  desktop.
- The webview wrote its storage into the real
  `~/.local/share/com.agaric.app`, because WebKit follows the OS app
  directory and not `AGARIC_DATA_DIR`. Each run now gets its own `XDG_*`
  directories. On the maintainer's machine that store was last written at
  their own app's exit, so tonight's runs left nothing there.
- GTK asked the private bus for the desktop portal, which never answered, so
  every boot stalled 25 s before its first log line. Timing from the log
  start had hidden it. The bus now starts no services.

The run sits under `unshare -rn xvfb-run -a dbus-run-session`, with openbox
waited for and Wayland checked inside the wrapper. strace showed X traffic
only to Xvfb and the one network connect blocked.

Phase 2, the release build and the measurement on a vault copy and a very
large synthetic vault, follows in its own change.

Gates: the boot store vitest files (60), `npm run typecheck`, oxlint, oxfmt,
`node --check`, and `check-vault-isolation`.
