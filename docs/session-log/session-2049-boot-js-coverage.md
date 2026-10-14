# Session 2049 — Boot: measure the JS that runs, before and after #5475

Set out to finish #5441's acceptance: the share of boot JS that executes, and the eager bytes, before and after #5475 lazy-loaded the interaction-only dialogs.

What shipped: an opt-in journey in `e2e/perf.spec.ts`, `perf: boot JS executed share (#5441)` (`AGARIC_PERF=1`). It loads the app cold under V8 precise coverage and reports the JS files, raw bytes and executed bytes for two windows: up to the first block, and the issue's first block + 2 s. Executed bytes paint coverage ranges outermost first so the innermost range wins, weighted to UTF-8 bytes.

Measured (n=3 per tree; file sets and bytes identical across runs, executed within 0.5 KB): to the first block, before #5475 91 files, 2076 KB, 40.4% executed; at #5475 83 files, 1807 KB, 44.9%; main 79 files, 1810 KB, 44.9%. At first block + 2 s main reads 30.9%, against 38.6% at #5475: the whole difference is #5525's idle view preload (33 chunks, 876 KB, 75 KB executed, landing after the first block), which is intended. Without it main matches #5475.

Traps: the issue's 70 files and 1.91 MB did not reproduce under this definition (91 files, 2.08 MB before #5475); its 42% sits inside the before tree's two windows. The commits before and at #5475 do not pass `tsc -b` against today's shared `node_modules`, so they were built with `vite build` directly. The harness's own `coveredBytes` check is opt-in with it, since nothing else depends on it.

Ran: the journey and the `coveredBytes` check with `AGARIC_PERF=1` (the check shown red by reversing the sort order), `npm run typecheck:e2e`, oxlint, oxfmt.
