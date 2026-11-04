# Session 3401 — main health check after the no-overlap merges

Checked `main` at `50d607502` (#6315), 22 commits past the last green CI run at `3171f1ce2`, here rather than in the CI queue. `npm run typecheck`, `lint`, `typecheck:e2e-tauri`, vitest (24,503 tests), clippy, `SQLX_OFFLINE` check, nextest (7,428 tests), doc-tests, the four `sqlx prepare --check` lanes, the bindings drift test, and both prek stages all passed. No two merged PRs clashed.

The `e2e/` lane on the mock had one flake: `page-mode-toolbar.spec.ts`'s Bold step looked up `getByRole('toolbar', { name: 'Format' })`, which also matches the selection bubble menu ("Selection formatting") once it has appeared, a strict-mode violation. It failed 2 of 16 runs under `--repeat-each` at both `3171f1ce2` and `50d607502`, so it predates these merges. `exact: true` makes it pass 32 of 32.

`diagram-legibility.spec.ts`'s wide-flowchart pair measured 10.99994 px against its 11 px floor at both commits too. The container's Chromium is build 1243 where Playwright 1.64.1 expects 1248, so this is left for CI's browser to judge.
