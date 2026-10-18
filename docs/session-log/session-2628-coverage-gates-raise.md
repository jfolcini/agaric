# Session 2628 — the coverage gates move up to just under what main measures

The gates had fallen 4–6 points below measured coverage, so a PR could drop that much and stay green.

Measured on the merged reports of main's last eight successful CI runs:

| Suite | Lines | Statements | Functions | Branches | Spread across runs |
|---|---|---|---|---|---|
| vitest | 96.04 | 94.34 | 94.25–94.26 | 88.28–88.30 | within 0.02 points |
| rust (workspace) | 94.48–94.51 | — | — | — | — |

- **`vitest.config.ts` thresholds** go from 91 / 89 / 90 / 82 to 95 / 93 / 93 / 87 (lines, statements, functions, branches). That keeps about a point of margin under each measurement, so one lightly tested file of moderate size can't flip the gate.
- **`scripts/coverage-baseline.json`** is regenerated with `coverage-ratchet.mjs --update` from run 39162057429's vitest report and run 39160324224's lcov:
  - vitest goes from 91.58 to 96.04 (advisory);
  - rust goes from 93.3 to 94.48, which is gated with 0.5 points of tolerance.

This PR's own `cargo-coverage` and `vitest-coverage` runs check the new numbers against a fresh measurement.
