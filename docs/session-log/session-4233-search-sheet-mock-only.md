# Session 4233 — the search-sheet latency test is mock-only

The nightly real-backend Playwright step failed on `a tap on the search-view button lands while the palette results arrive`, which #6852 added to `search-sheet-mobile.spec.ts`. That spec is on the `real-backend` list, and the test calls `window.__setMockLatency`, which only the mock defines. It now carries the `@mock-only` tag, which the `real-backend` project's `grepInvert` drops.

## What ran

- `npx playwright test --list` with `AGARIC_E2E_BRIDGE` set lists the spec's other five tests and not this one. Without it, the mock run still lists it.
- `npx playwright test e2e/search-sheet-mobile.spec.ts` on the mock: 6 passed.
