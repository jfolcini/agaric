# Session 1650 — the override was holding the fix back

`npm audit` went red on `main`, so every open PR's `validate / lint` lane went
red with it: GHSA-7w5x-hrqm-74c2, a high-severity DoS in `smol-toml` through
malformed TOML documents, affecting `<= 1.7.0`.

The interesting part is why the repo was on a vulnerable version at all.
`smol-toml` reaches the tree twice, through `knip` and `markdownlint-cli2`, and
`knip` already asks for `^1.8.0` — the patched line. What pinned the tree to
1.6.1 was our own `overrides` entry, `"smol-toml": "^1.6.1"`, deduping both
consumers down onto it. The override was not protecting anything; it was
holding the fix back.

Bumped to `^1.8.0`. `markdownlint-cli2` declares an exact `1.7.0`, which the
override deliberately crosses — that is what an override is for, and both
consumers were exercised afterwards.

`npx better-npm-audit audit` now exits 0 with the report down to the two
`extract-zip` advisories, which are the existing time-boxed exceptions and
unchanged by this.
