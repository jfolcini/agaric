# Session 2258 — Lessons from 2173–2252 into the AGENTS files; 2101–2200 archived

Two maintainer-requested chores in one PR.

**Lessons.** Two readers mined the session logs since session 2180's pass
(2178–2252, minus 2180 itself). The orchestrator added three from its own
afternoon of `/batch-issues` work. An editor checked each proposal against the
tree and landed it in the nested file where the work happens. Root `AGENTS.md`
needed no change. The lessons:

- **Real-backend lane** (`e2e-tauri/AGENTS.md`):
  - Removing or moving a control breaks the lane as silently as renaming it,
    and most specs inline their own selectors, so grep the lane rather than
    trusting `helpers.ts`'s header (2218 lost a CI round to a removed field).
  - Never type a repeated character through one raw `browser.keys` call
    (2230).
  - WebdriverIO's `*=` takes a single selector (#5365's picker spec lost a CI
    round to `[a][b]*=…`).
  - Show a spec red on the local recipe, not on a scratch branch: 2246's two
    scratch branches each ran the full CI.
- **Engine commands** (`src-tauri/src/commands/AGENTS.md`):
  - A raw `UPDATE blocks` used to be healed by boot replay. Since the snapshot
    pass advances the apply cursor it is not, which is how 2214's backfill
    regressed.
  - A write to the engine after COMMIT joins `op_log_head`'s list (2214, 2222).
- **Frontend tests:**
  - A dialog opened without a trigger needs `onCloseAutoFocus` (2210).
  - A fast-check property red once is a real counterexample (2232).
  - Modules reachable from test setup import subpaths (2250).
  - A name-change subscriber that caches answers compares a ref, not only a
    `reloadKey` (2226).
- **Playwright** (`e2e/AGENTS.md`): wait for focus before placing a caret, and
  read animated state only at rest (2236, 2238).
- **Rust tests** (`src-tauri/tests/AGENTS.md`):
  - An arm pinned at exactly a clock window's edge flakes by a tick (2240).
  - Both nextest profiles retry, so a green job can hide a `FLAKY` test
    (2240).
- **Batch skill:** Explore and Plan agents cannot write files. This session
  briefed a Plan agent to write a plan file, and it returned the plan in its
  final message instead.

Two proposals stayed out because the batched follow-up PR
(`claude/review-notes-5622-5633`) already carries them: the Wayland-safe local
recipe, and `replaceEditorText` over `locator.fill`.

One rule was softened before landing. The editor flagged that
`block-edit-persist.e2e.ts` types `-edited` in one `browser.keys` call, which
repeats two letters, and that spec passed on the latest real-lane run
(38945754131). So the rule now says the driver *can* drop a repeated key, as
2230 observed for `[[` and for spaces, rather than that it always does. The
spec is left alone: it is green, and the rule's helpers are what new specs use.

**Archive.** Sessions 2101–2200 (62 logs; the gaps were never used) moved into
`sessions-2101-2200.md`, headings demoted, newest first. Every log
round-tripped byte for byte after re-promoting its headings. Every archive's
"Sessions above" line and the README's archive list moved to 2200 together.
No file outside the folded range linked to any of them. The fold commit skips
`session-log-immutable`, as the README prescribes.

Docs only: prek over the changed files passed; no test suite applies.
