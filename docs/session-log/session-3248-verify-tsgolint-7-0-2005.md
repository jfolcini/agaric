# Session 3248 — verify oxlint-tsgolint 7.0.2005

Dependabot's npm group (#6257) went red in `validate / lint`: `check-tsgolint-version-pin` refuses `typescript@7.0.2 + oxlint-tsgolint@7.0.2005`, a pair nobody had run. This runs it the way the earlier rows did and adds the row, so #6257 can land as Dependabot cut it.

- `npx oxlint --type-aware` over the whole tree, with `OXLINT_TSGOLINT_PATH` at the 7.0.2005 binary and at the installed 7.0.2004: the sorted output is byte-identical (64 problems).
- A throwaway canary with one violation each of `await-thenable`, `no-floating-promises`, `only-throw-error` and `require-await` is flagged by all four rules under both versions.

**Suites:** `node scripts/check-tsgolint-version-pin.mjs --self-test` and the check itself.
