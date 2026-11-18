# Session 4252 — a listed real-backend spec meets the bridge's hook surface on every PR

Part of #6529, after stages 1a–1c. Every spec on `REAL_BACKEND_SPECS` also runs nightly on the real backend, but per-PR CI runs it only on the mock, so a test that calls a mock hook (`window.__setMockLatency`, `__addMock*`, …) passed its PR and failed the next night (#6852, fixed by #6855's `@mock-only` tag).

The check costs no CI minutes: those tests already run in the per-PR mock lane. The `realBackend` fixture in `e2e/helpers.ts` now sets `__AGARIC_NO_MOCK_HOOKS__` for a test whose file is on the list and which is not tagged `@mock-only`, and `setupMock` then installs none of its `window.__*` hooks, as the bridge installs none. The list reaches the fixture as the project's `metadata.realBackendSpecs` in `playwright.config.ts`, so it stays in one place. The issue comment proposed only listing the tests for a reviewer to read; failing the run is stronger and no dearer.

Shown red: with the `@mock-only` tag removed from the `search-sheet-mobile.spec.ts` latency test, the mock run fails with the nightly's `TypeError: window.__setMockLatency is not a function`; with the mock's new early return also removed, the same test passes. The 13 listed spec files pass on the mock (48 passed, 1 skipped). `npm run typecheck`, oxlint and the `src/lib/tauri-mock` vitest files pass.

Not done: `e2e/AGENTS.md` § "The real backend, through the bridge" does not mention the per-PR check (an `AGENTS.md` edit wants the maintainer).

Second round: the bridge defines `__emitMockEvent` too (`src/lib/tauri-mock/bridge.ts`), so the first version withheld one hook too many. `setupMock` now installs it before the early return. Shown red: a listed test that fires `emitMockEvent` fails with `__emitMockEvent is not a function` on the first version and passes on this one.
