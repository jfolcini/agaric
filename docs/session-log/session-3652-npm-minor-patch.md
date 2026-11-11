# Session 3652 — npm minor-and-patch group, without d3-selection 3.0.1

Takes Dependabot's #6450 (16 npm minor and patch updates) onto a branch off `main`. It holds one package back and re-vendors the pdf.js worker.

## d3-selection stays on 3.0.0

#6450's `vitest (2)` failed with `select(...).transition is not a function` in the graph tests that drive real d3. There is only one copy in `node_modules` (`npm ls d3-selection`), so this is not a dedupe problem.

- d3-selection 3.0.1 ships a prebuilt `dist/d3-selection.mjs`, where 3.0.0 shipped `src/index.js`.
- vitest's client optimizer is on (for mermaid, in `vitest.config.ts`). With the prebuilt file, our source loads it with the optimizer's `?v=` query and d3-transition loads it without. That makes two module instances, and d3-transition patches `transition` onto the one our code does not use.
- Confirmed by logging each load of the file (two URLs, one with `?v=`). Turning the optimizer off made the tests pass.
- Config fixes were tried and dropped:
  - `server.deps.inline` for the d3 family breaks the tests that `vi.mock('d3-selection')` and `importOriginal` d3-zoom.
  - Pre-bundling the family breaks the restore tests.
- d3-zoom and d3-drag 3.0.1 accept d3-selection 3. So `package.json` keeps `^3.0.0`, the lock keeps 3.0.0, and `.github/dependabot.yml` ignores exactly 3.0.1 so the next group run does not bring it back. Bumping d3-transition to 3.0.2 (also prebuilt) does not help.

## pdf.js 6.5.438

`public/pdf.worker.min.mjs` was re-vendored per the recipe in `e2e/pdfjs-v6-smoke.spec.ts`. The worker matches `node_modules` byte for byte, apart from the trailing newline. The spec's pinned `result.version` moves to `6.5.438`, the one existing-test edit the coordinator approved.

## Babel and the React Compiler

`@rolldown/plugin-babel` 0.3.0 declares `@babel/core ^7.29 || ^8.0.0-rc.1` and `vite ^8`, and both are satisfied. `vite build` succeeds, and the React Compiler's output (`react.memo_cache_sentinel`) is in the built chunks.
