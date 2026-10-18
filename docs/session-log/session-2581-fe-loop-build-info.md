# Session 2581 — per-checkout tsc build info, and what the vitest knobs measure

**Gap:** #5848's two remaining local items: give each worktree its own
`tsBuildInfoFile`, and measure `incremental` and vitest `pool: 'threads'` /
`fsModuleCache` before adopting any. Refs the issue without closing it (the
Playwright shard count and the `vitest --changed` documentation are other
people's).

**Premise check on the false green.** On `typescript@7.0.2` it does not fire
today: with `noEmit` and no `incremental`, `tsc -b` reports `output file
'src/App.js' does not exist` and rechecks every project on every run, so a
shared buildinfo is never trusted. It fires the moment `incremental` is on.
Reproduced in a scratch copy of the repo with two checkouts sharing a
symlinked `node_modules`: B carried a type error, A ran a clean `tsc -b`, then
B's `tsc -b --verbose` printed `up to date because newest input 'src/App.tsx'
is older than output 'node_modules/.tmp/tsconfig.app.tsbuildinfo'` and exited
0 (`--force` found the error). So the move had to land with `incremental`, not
before it.

**What changed:**
- All five tsconfigs: `tsBuildInfoFile` is `./.tsbuildinfo/<project>.tsbuildinfo`
  (gitignored), and `tsconfig.app.json` / `tsconfig.node.json` /
  `tsconfig.e2e.json` / `tsconfig.wdio.json` set `incremental: true`
  (`tsconfig.scripts.json` inherits it from `tsconfig.node.json`).
- Same scratch pair after the change: A and B each write their own five files,
  nothing is written under `node_modules/.tmp`, B reports the error before and
  after A's runs (`buildinfo ... indicates that program needs to report
  errors`).
- Comments in `scripts/seed-worktree.sh` and `scripts/pr-merge-result-check.sh`
  said the real-directory `node_modules` shape exists because of
  `node_modules/.tmp`; reworded, shape unchanged.

**Incremental, measured** (`tsc -b --noEmit`, scratch copies, machine loaded,
load average 19-27; 3 alternating runs per cell, seconds):

| edit | before | after |
|---|---|---|
| leaf test file, comment | 14.4 / 16.1 / 16.2 | 2.1 / 2.2 / 3.0 |
| `src/lib/utils.ts`, new export (hub) | 8.7 / 8.8 / 12.4 | 5.8 / 6.9 / 9.8 |
| no edit | 8.5 / 17.5 | 0.2 / 0.2 |

Cold run 12.2 s before, 14.4 s after (one sample). Falsified for false greens
(incremental copy): an injected error in a changed file is reported, and again
on an unchanged rerun; renaming `cn` reports the errors in its importers; a
`noUnusedLocals` flip rechecks. Residual: `tsc -b` still decides "up to date"
by mtime, so a file restored with an old mtime (`cp -p`, `tar`, `rsync -t`)
over a newer buildinfo is skipped; `git checkout` and editors write a new
mtime. `npm run typecheck -- --force` is the escape hatch.

**Vitest, measured, config unchanged.** `src/stores` + `src/editor` (129
files, 4271 tests), `--maxWorkers=4`, load average 17-42, 5 alternating runs
each, wall seconds, median and range:

| config | median | range | note |
|---|---|---|---|
| `forks` (current) | 67.5 | 62.2-167.3 | |
| `pool: 'threads'` | 72.0 | 54.6-175.8 | one run failed 1 test |
| `fsModuleCache`, warm | 67.7 | 56.8-87.2 | cache dir outside `node_modules` |
| `pool: 'vmForks'` | 19.7 / 28.8 (2 runs) | | 2 files fail |

`npx vitest doctor src/stores` agreed: threads -3%, `fsModuleCache` +26%,
`vmForks` -57%. The CPU seconds (`user+sys`) of the last two rounds, which the
load moves less than wall time: forks 293 / 270, threads 232 / 254, warm
`fsModuleCache` 264 / 280. Threads and `fsModuleCache` sit inside the noise.
`vmForks` is a real gain but fails `emoji-data.test.ts` and
`emoji-picker.test.ts` (`instanceof Error` across the VM realm), the
cross-realm class of divergence the isolation rule exists to avoid, so it is
not adopted. If `fsModuleCache` is ever adopted, set `fsModuleCachePath` to a
per-checkout path: the default `node_modules/.vitest-cache` is shared through
the worktree symlink. The shared `node_modules/.vite/vitest/results.json` holds
only durations and failed flags for ordering, not a false-green path.

**Verified:** `npm run typecheck` (cold 6.5 s, then 0.2 s no-op), `npm run
lint` exit 0, `vitest run src/__tests__/classify-changes.test.ts
src/stores/__tests__/resolve.test.ts` 130 passed.
