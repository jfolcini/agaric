# Session 2488 — "N ago" labels count up

The #5739 sweep found that the sidebar Sync tooltip read "Last synced just
now" until the next successful sync, however long ago the last one was.
- **The cause:** `formatRelativeTime` read `Date.now()` inside the call, and
  the React Compiler caches each label on its inputs, the timestamp and
  `t`. So a re-render never recomputed it. The builder compiled the files
  with the repo's compiler plugin and read the built bundle to confirm.
- **Who it hurt:** a user whose device had stopped syncing, which is
  exactly when that line matters.

**Changed:**
- **`useMinuteClock()`** returns a `now` that it re-reads each minute, and
  clears its timer on unmount. `formatRelativeTime` takes `now` as an
  argument, defaulting to `Date.now()` for other callers. The compiled
  labels now re-run as time passes.
- **Fixed with it:**
  - the sidebar tooltip and the Settings sync card;
  - the Agent access activity feed. Its 60-second tick re-rendered the tab,
    but the compiled tab reused the cached feed, so a row read "just now"
    until the next agent call.
  - the per-device "Last: …" lines in Settings and in the pairing dialog.
    They refreshed only by accident, through an uncompiled parent's tick
    and a fresh inline prop.
- **Deleted:** the two tick counters, in `useMcpActivityFeed` and
  `DeviceManagement`.
- **`docs/features/sync.md`:** the sync dot colours now match the tokens,
  idle green and syncing amber.

**Specs:**
- **`e2e/sync-last-synced.spec.ts`:** the sidebar tooltip and the Settings
  card move from "just now" to "5m ago" after five minutes on a paused
  clock.
- **`e2e/mcp-activity-events.spec.ts`:** a new test ages an activity row the
  same way.

Fake-clock vitests cover the hook, the formatter and each label. The mock
writes no per-peer sync time, so the peer rows rely on their vitests.

**Shown red:**
- **The e2e specs:** against the unfixed sidebar, card and feed. The case
  that keeps the tick but drops its value stays green in vitest, where the
  compiler is off, and fails in the compiled e2e bundle.
- **Each label's vitest:** with the minute clock not driving a re-render.
- **The hook test:** with its timer cleanup removed.

**Ran:**
- the new specs with `--repeat-each=3`;
- the sync, agent-access and MCP specs;
- vitest over every touched file, the Settings and App tests and the
  pairing dialog;
- `npm run typecheck`, type-aware oxlint and oxfmt.
