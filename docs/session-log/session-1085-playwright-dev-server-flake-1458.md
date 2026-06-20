# Session 1085 — /batch-issues loop: Playwright e2e on a stable preview server, batch 34 (2026-06-20)

## What happened

CI-reliability fix from the overnight `/loop /batch-issues` run, built in worktree
`wt-1458` and adversarially reviewed (with full release + e2e builds). Eliminates the
root cause of the intermittent Playwright shard-timeout cascade that reddened unrelated
PRs.

## Shipped

PR `fix/playwright-dev-server-flake-1458`:

- **#1458** (CI reliability) — a RANDOM Playwright shard intermittently ran to the job
  timeout. Root cause: `playwright.config.ts` served e2e from `npm run dev` (vite dev +
  HMR); under sharded-CI load the dev server stalls on on-the-fly transform/HMR, so
  every test on that shard fails navigation, `retries: 2` triples the waste, and with no
  per-test/global/server timeout the shard cascades to the job cap *before* the report
  uploads (self-obscuring). The varying failing shard is the dev-server/infra-flake
  signature, not a fixed bad spec.
  - **Root-cause fix:** run e2e against a static **production preview build** instead of
    the HMR dev server. New `build:e2e` (`VITE_E2E=1 tsc -b && vite build`) +
    `preview:e2e` (`VITE_E2E=1 vite preview --port 5173 --strictPort`); `webServer.command`
    → `build:e2e && preview:e2e`; `reuseExistingServer: !CI`.
  - **Mock gating:** the tauri IPC mock was `!import.meta.env.PROD` (stripped from prod
    builds). Added an OR on a build-time `VITE_E2E` flag so the e2e build keeps the mock
    while **releases still tree-shake it out** (verified: normal `dist/` has zero mock
    string literals; the e2e build has the `tauri-mock-*` chunk).
  - **pdfjs dev-path spec:** `pdfjs-v6-smoke.spec.ts` imports pdfjs from the dev-only URL
    `/node_modules/pdfjs-dist/build/pdf.min.mjs` (not served by `vite preview`). Added a
    `configurePreviewServer` middleware wired ONLY under `VITE_E2E=1` mapping that exact
    URL to the real node_modules file (no path traversal — request value used only in an
    exact-match check). Releases / normal `vite preview` untouched; the spec is unchanged.
  - **Fail-fast bounds:** per-test `timeout: 60_000`, `navigationTimeout: 30_000`,
    `actionTimeout: 15_000`, `webServer.timeout: 180_000`, `globalTimeout: CI ? 25m : 0`
    (below the 30m / 3-shard job cap → Playwright self-aborts and uploads the per-shard
    report instead of being killed), `retries: CI ? 1 : 2` (the preview switch removes
    the stall source, so 1 CI retry still absorbs a one-off overlay flake without
    re-multiplying a bad shard).

## Review pass

Reviewer (PASS): the CRITICAL check — a normal `npm run build` has **zero** mock string
literals anywhere in `dist/` (grepped distinctive, minification-proof markers), while
the `VITE_E2E=1` build includes the mock chunk; the gate `(!PROD || VITE_E2E)` folds
correctly (prod OUT, e2e IN, dev IN) with `VITE_E2E` statically eliminable. The pdfjs
middleware is `e2e`-only, `apply:'serve'` (never in a build), no path traversal, correct
content-type. Ran the e2e suite against preview (Playwright's own `webServer` did
`build:e2e && preview:e2e`): 11 specs incl. pdfjs/math-katex/image-node all pass (proves
the middleware serves the asset, no lazy-chunk 404s, mock loaded). Confirmed the CI
playwright job is `timeout-minutes: 30`, 3-way sharded, so `globalTimeout` 25m leaves the
report-upload margin. Local loop intact (`reuseExistingServer: !CI`). No over-reach (5
infra files), tsc clean.

## Notes

- Final flake ELIMINATION needs many CI runs to confirm statistically (the cascade was
  intermittent/infra-driven); this fix is proven CORRECT and provably can't leak the mock
  into release or break e2e.
- Files: `playwright.config.ts`, `vite.config.ts`, `package.json`, `src/main.tsx`,
  `src/vite-env.d.ts`. No spec assertions / backend changed.
- Branch base is current `origin/main`.
