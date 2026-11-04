# Session 3425 — re-key the minimatch audit waiver

`main`'s `validate / lint` went red on the npm audit step: npm served GHSA-g3hv-75wg-m249 (minimatch globparts DoS) under advisory id 1244623, so the `.nsprc` waiver keyed on 1244012 stopped matching. The id flaps: main's run 41886516335 passed with only 1244012 a few minutes after run 41885311769 failed on 1244623.

- The minimatch waiver now sits under both ids with the same notes, plus a clause saying why both stay. An unmatched exclusion only prints "can be removed"; it does not fail the audit. No consumer can take 11.0.1 yet: `@stryker-mutator/core` 10.1.1, `mocha` 12.0.3 and `readdir-glob` 3.0.0 are each the latest release and declare `~10.2.4` or `^10.2.2`. The advisory's range is now `>=7.0.0 <11.0.1`, so license-checker's minimatch 3 is out of it; the note drops that path.
- The braces entry (1240992) stays unchanged until its 2026-11-12 expiry. GitHub has withdrawn GHSA-vfj7-8cjw-p6xm as not practically exploitable and npm does not report it today, but with npm's ids flapping, "not reported right now" is too weak to delete on.
- `osv-scanner.toml` is regenerated with `node scripts/sync-audit-from-deny.mjs`; it now lists the minimatch GHSA once per npm id.

Ran: `bash scripts/npm-audit-retry.sh` (the lint job's `npm-audit` hook), red with the 1244623 report before, "All good!" after; `node scripts/sync-audit-from-deny.mjs --check` (the `audit-toml-in-sync` manual hook), green.
