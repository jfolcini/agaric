# Session 2899 — zod 4.6.7 for GHSA-mrhx-c7xc-m3w5

GHSA-mrhx-c7xc-m3w5 (high) reports that zod before 4.6.6 can exhaust memory while validating oversized constrained collections. Published after main's last green lint, it turned the `npm-audit` hook red on every PR.

zod is a dev-only transitive dependency, reached through `knip` and through `@stryker-mutator/core` via `mutation-server-protocol`; nothing in the shipped app imports it. `npm update zod` moves the lockfile from 4.6.5 to 4.6.7, the newest release past `.npmrc`'s `min-release-age`. Nothing else in the lockfile moved.

`scripts/npm-audit-retry.sh` passes and `knip` runs clean on the new version.

The audit also prints that the `.nsprc` exclusion for braces (1240992) matched nothing: braces is still 3.0.3 in the tree, so the advisory itself changed. The entry stays until that is understood; it does not fail the hook.
