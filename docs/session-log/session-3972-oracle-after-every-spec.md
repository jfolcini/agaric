# Session 3972 — the reconciliation oracle runs after every real-backend spec file

`Refs #6567` (the first item; the stale-cache experiment, the per-PR differential fuzz and the
upgrade-path test stay open).

`wdio.conf.ts` calls `compute_reconciliation_report` when a spec file ends and fails the file on
any divergence, printing the diverged artefacts and samples. Until now only `app-health.e2e.ts`
called it, so a spec could pass while the sequence it drove left a derived view wrong.

Decisions and traps:

- The issue prescribed WDIO's `after` hook. A WDIO config hook cannot fail a file:
  `executeHooksWithArgs` logs what it throws and resolves. The check is a mocha root hook passed
  through `mochaOpts.rootHooks`. By the same reading, the `before` sandbox guard in this config
  (#3334) probably logs and lets the specs run; read in the code, not tested, not touched.
- The issue asked for a report-only week before failing. Built failing from the start: the PR's
  whole-lane run is the first observation, and a hook that only logs cannot be shown red.
- `trash-bulk-noncanonical-ids.e2e.ts` is the one skip-list entry. It rewrites block ids in
  `notes.db` behind the engine, and the oracle reports exactly that planted damage.
- The command settles the materializer itself, so the hook waits for nothing.

Shown red by dropping the owning page from the create arm's `pages_cache` count update:
`tag-roundtrip.e2e.ts` passed its own test and the hook failed the file on
`pages_cache.child_block_count`.

Ran: sixteen real-backend spec files across areas locally, typecheck, the `e2e-tauri` vitest
suite. The whole lane is CI's run on this PR.
