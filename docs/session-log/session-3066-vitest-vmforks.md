# Session 3066 — vitest runs in `vmForks` and halves the suite

A CI-log survey found vitest spending about 35% of its time on imports and 12% on setup. Re-measured before building: a full run on main was 36–40% import, 31–35% tests, 13–16% environment and 11–13% setup. Vitest's own hint was "2091 modules evaluated 49645 times". Under `forks` with isolation, every one of the 982 files started a fresh process and re-imported node_modules.

**Changed (`vitest.config.ts` only):**
- **The suite runs in two projects.** `vm` uses `pool: 'vmForks'`: each file still gets a fresh module graph and a fresh happy-dom window, in a new `vm` context inside a reused worker. `forks` holds six files that fail only under `vm`, each listed in `VM_INCOMPATIBLE` with its reason:
  - three JSZip blob files, because happy-dom's host-realm `Blob` rejects a vm-realm `ArrayBuffer`;
  - two files that assert `instanceof Error` on a vitest-made error;
  - `viewTransition`, whose after-test logs trip a closed rpc under `--silent=passed-only`;
  - `SearchSheet`, which is flaky in any pool (below).
- **The root `include` moved into `TEST_FILES`.** Under `extends: true` the arrays concatenate, so leaving it at the root would have made the `forks` project run everything.
- **`vmMemoryLimit: '1GB'`.** The default sits above V8's heap limit on a 4-core, 16 GB box, and workers died out of memory. It works only at the root.
- **`mermaid` is pre-bundled** through `deps.optimizer.client`. The vm loader mis-resolves one of khroma's relative imports.

- **`useIsMobile.test.ts`'s two "matchMedia unavailable" tests set `matchMedia` to `undefined` instead of deleting it.** Under `vm` the function lives on happy-dom's `Window` prototype, so `delete` did nothing and the guard went untested: with the guard removed, the tests stayed green under `vm` and failed under `forks`. With the fix, they fail under both pools when the guard is removed.

**Measured** on the same 4-core box, configs swapped and interleaved A, B, A, B:

| Command | Before | After |
| --- | --- | --- |
| `npx vitest run` | 524.5 s, 526.3 s | 229.3 s, 226.3 s (−57%) |
| `--shard=1/3` | median 174.6 s | about 77 s (−56%) |

After, the breakdown is 64–70% tests and 12–15% import. The exact CI path (three blob shards with coverage, then `--mergeReports`) passes the coverage thresholds.

**Tried and dropped:**
- Trimming `src/test-setup.ts` would save about 250 ms per pure-logic file, roughly 6 s of wall time.
- `pool: 'threads'` was within noise of `forks`.

**Risks left:**
- A new test that hits a realm quirk fails loudly and goes on the list.
- A raw `new Blob([arrayBuffer])` silently gets the wrong content under `vm`; typed arrays are fine.
- `SearchSheet.test.tsx`'s async `vi.mock` factory can run twice, the second time for the lazily imported palette. It failed once under plain forks and about 40% of the time under `vm`, so it stays in `forks` until the test is fixed.

**Suites:**
- the full vitest suite, three times (982/982);
- the CI coverage path;
- typecheck, lint and oxfmt.
