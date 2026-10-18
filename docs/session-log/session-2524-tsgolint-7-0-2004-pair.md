# Session 2524 — the typescript 7.0.2 + oxlint-tsgolint 7.0.2004 pair (#4408)

**Found:** `main` went red on lint after #5786 bumped `oxlint-tsgolint` to
7.0.2004. The `tsgolint-version-pin` guard fails on a pair nobody has
verified. Every open PR inherited the red, starting with #5824.

**Verified** with the guard's own recipe:
- I installed 7.0.2004 into an isolated scratch directory, leaving the
  shared `node_modules` alone.
- `npx oxlint --type-aware` over the whole tree, with
  `OXLINT_TSGOLINT_PATH` at 7.0.2004 and then at 7.0.2003, gave the same 68
  findings.
- A canary file tripped `await-thenable`, `no-floating-promises`,
  `only-throw-error` and `require-await` under both binaries.
- A bogus `OXLINT_TSGOLINT_PATH` failed loudly, so the runs used the binary
  they named.

**Fix:** one `VERIFIED_PAIRS` row with that evidence.

**Ran:** the guard and its `--self-test`, both green, and oxfmt.
