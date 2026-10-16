# Session 2148 — boot main-thread profile: the last two #5440 items dropped

#5474 landed most of #5440. Two items were still open: the tailwind-merge config build and the mount-time forced layout reads. Both are dropped with their numbers, and no product code changes.

**Harness.** `perf: boot main-thread profile (#5440)` in `e2e/perf.spec.ts`, opt-in with `AGARIC_PERF=1`:
- It runs `AGARIC_PERF_BOOTS` cold boots (default 7) at `AGARIC_PERF_CPU` throttle.
- Each boot records a CDP CPU profile and a devtools trace, mapped through the build's `.map` files.
- It prints median and range for:
  - FCP and first block;
  - script time;
  - style+layout time, and forced style+layout by the source of the frame that read it;
  - self time per source;
  - tailwind-merge's first call.
- Source rows need a sourcemapped build: `VITE_E2E=1 npx vite build --sourcemap && npm run preview:e2e`.

**Method.** All runs were in one session:
- 4× CPU throttle on a production e2e build;
- three builds interleaved twice (A B C A B C), 7 boots each:
  - before;
  - an upper bound with all three layout reads removed;
  - an upper bound with `cn()` reduced to `clsx`, so tailwind-merge costs nothing.

**tailwind-merge: no change.**
- `cn()` is a plain `twMerge(clsx(…))`. Its first call already runs at module load, because several files call `cn()` at top level. That is before the BootGate spinner paints, and the spinner itself renders through `cn()`.
- The config build costs 31–32 ms.
- Removing tailwind-merge entirely moved first block 1921→1933 ms and 1750→1826 ms, and FCP 708→648 and 644→568. Every pair lies inside overlapping ranges.

**Layout reads: no change.**
- Removing `resolveIndentWidth`'s read, the `scrollParentY` walk and the mount-time `scrollToIndex` left style+layout at 138.6→143.3 and 131.2→144.7 ms. Forced time went 70.1→66.7 and 64.9→72.5 ms.
- virtual-core's own `getRect` then pays the same first recalc: 32–37 ms → 58–66 ms. The reads only move the shell's first style/layout earlier; they add no pass.
- The "empty DuePanel/DonePanel virtualizer" case no longer exists. An empty panel renders `null`, or a skeleton while loading.

**Not in scope:** `date-utils.ts` still shows 55–58 ms of self time per boot at 4×.

Falsified: renaming the trace's layout-event filter or the `script` metric turns the harness red on its `> 0` assertion for that metric.
The same `> 0` assertion on first contentful paint was added in review and has not been run red.

Ran:
- the harness, 13 times;
- the six non-opt-in tests in `perf.spec.ts`, against the same build;
- `npm run typecheck`, `oxlint`, `oxfmt --check` and `typos`.
