# Session 3425 — re-key the minimatch audit waiver

`main`'s `validate / lint` went red on the npm audit step: npm re-published GHSA-g3hv-75wg-m249 (minimatch globparts DoS) under advisory id 1244623, so the `.nsprc` waiver keyed on 1244012 stopped matching.

- The minimatch entry is re-keyed to 1244623 with its notes kept. No consumer can take 11.0.1 yet: `@stryker-mutator/core` 10.1.1, `mocha` 12.0.3 and `readdir-glob` 3.0.0 are each the latest release and declare `~10.2.4` or `^10.2.2`. The advisory's range is now `>=7.0.0 <11.0.1`, so license-checker's minimatch 3 is no longer in it; the note drops that path.
- The braces entry (1240992, GHSA-vfj7-8cjw-p6xm) is deleted. The registry's bulk advisory endpoint returns nothing for braces 3.0.3, the version installed and still the latest, because GitHub withdrew the advisory as not practically exploitable. `osv-scanner.toml`, generated from `.nsprc` by `scripts/sync-audit-from-deny.mjs`, drops its GHSA with it.

Ran: `bash scripts/npm-audit-retry.sh` (the lint job's `npm-audit` hook), red with the advisory 1244623 report before, "All good!" after; `node scripts/sync-audit-from-deny.mjs --check`, red in CI on the first push, green after regenerating.
