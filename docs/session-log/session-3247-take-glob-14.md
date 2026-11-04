# Session 3247 — take glob 14 under the WDIO lane

The `.nsprc` waiver for GHSA-3g3m-2fjr-6pw4 (glob AbortSignal cancellation bypass) expires on 2026-11-07. Its fix, `glob` 14.0.2, is now past `.npmrc`'s `min-release-age=7`, so this does what the waiver said to do at expiry:

- `package.json` overrides `glob@13` to `^14.0.2`. Both copies under `@wdio/config` and `mocha` resolve to 14.0.2 and bring `minimatch` 11.0.2 and `path-scurry` 3.
- The `glob` 7 under `license-checker` is outside the advisory's range and stays.
- The waiver goes from `.nsprc`, and `osv-scanner.toml` is regenerated from it.

`glob` 14 still exports `sync`, `glob` and `hasMagic`, the three names `@wdio/config` and `mocha` use. Only the e2e-tauri WDIO lane loads them, so CI's run of that lane is the check.

**Left as is:**
- The `minimatch` waiver (GHSA-g3hv-75wg-m249, expires 2026-11-12). `@stryker-mutator/core`, `mocha` and `readdir-glob` still declare `minimatch` ^10.
- The `braces` waiver (GHSA-vfj7-8cjw-p6xm, expires 2026-11-12). `npm audit` no longer reports it, while `braces` 3.0.3 is still the latest release. OSV may still list it for `osv-scanner`, so it is re-checked at its expiry rather than dropped on `npm audit`'s word alone.

**Suites:** `scripts/npm-audit-retry.sh` and `node scripts/sync-audit-from-deny.mjs --check`.
