# Session 2682 — the weekly frontend mutation lane runs as four groups, so it fits its timeout again

#5915. With all 36 modules enrolled, the one `mutants-frontend` job of dispatch
run 39183149461 started at 01:03 and was cancelled by its 60-minute timeout at
02:03, partway through `page-rendered`; every report was lost with it.

- **Groups:** `node scripts/run-mutation.mjs --group k/n` runs the modules
  whose index in `MODULE_NAMES` is k-1 modulo n. Each matrix leg passes
  `${{ matrix.group }}/${{ strategy.job-total }}`, so every module lands in
  exactly one group and a new module joins one without a matrix edit. Four
  groups: from the cancelled run's per-module times, scaled to the slow
  34-minute runner of 2026-10-12, three would put one group near 39 minutes.
- **Merge:** `mutants-frontend-merge` downloads every group's
  `mutation-frontend-report-<group>-of-<legs>` artifact, reads the expected
  count from the `-of-<legs>` suffix, names any missing group and fails, runs
  `check-mutation-reports.mjs` and the summary over the union, and uploads
  the merged `mutation-frontend-report` under its old name.
- **Short merge:** like the Rust lane, the merge reports how many groups it
  merged, and the survivor filer runs with `--dry-run` when one is missing,
  so a dead group's survivors are not marked resolved and refiled next week.
- The timeout is unchanged.

Shown red: a module dropped from the partition (the union test and the merge
guard both name it), a group that never uploads (the merge fails naming it),
and the merge's missing-group check disabled (the merge passed; restored, it
fails). A local simulation ran the merge and filer steps' shell verbatim for a
full and a short set.

Ran: `src/__tests__/run-mutation.test.ts` and the other mutation-script tests,
actionlint and zizmor through prek, the manual-stage hooks, `npm run
typecheck`, `npx knip`. The split lane's first real run is the dispatch on
this branch.
