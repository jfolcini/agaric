# Session 1866 — braces advisory has no fixed version

`npm audit` began failing `validate / lint` on every PR (#5232, #5233) with
GHSA-vfj7-8cjw-p6xm. The advisory is a braces stack-exhaustion DoS on deeply
nested patterns, rated high, published 2026-09-18. Its range is `<=3.0.3` and
3.0.3 is the newest braces, so neither an upgrade nor an override fixes it.

braces is dev-only. It comes in through markdownlint-cli2 → micromatch and
@wdio/mocha-framework → mocha → chokidar, and `npm ls braces --omit=dev` is
empty. It only ever expands the repo's own lint and test globs. Per the
`.nsprc` rule (exceptions only for advisories with no fixed version), it gets
a time-boxed entry with the same 2026-11-12 expiry as the two extract-zip
entries, so all three are re-evaluated together.

## Verified

`npx better-npm-audit audit` exits 0 with the entry and 1 with main's
`.nsprc` restored over it.
