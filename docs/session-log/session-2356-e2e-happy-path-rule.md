# Session 2356 — AGENTS.md: every feature keeps an end-to-end spec of its happy path

The maintainer asked, on 2026-10-17, that the e2e estate keep growing on
#5365's criteria, with at least the happy path of every feature covered. They
approved the AGENTS.md change in the same message.

Testing invariant 5 states it:
- every user-facing feature lands with an end-to-end spec of at least its
  happy path, in the lane that can show its failure;
- a scenario goes to `e2e-tauri/` only when the mock cannot show it failing:
  several IPC calls, a materialized view, bytes on disk, or an unmodelled
  path;
- persistence is checked by navigating away and back, never by
  `browser.refresh()`;
- the spec is shown red once.

The lead-in no longer counts the rules, so adding one can't make it stale.
Existing citations of rules 1 and 4 keep their numbers.

An audit of which features in `docs/FEATURE-MAP.md` lack a happy-path spec is
tracked in #5726.
