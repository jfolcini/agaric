# Session 2456 — npm 12 is required everywhere

The maintainer decided on 2026-10-17: only npm 12 or higher, because of
npm 12's security changes. npm 12.0.0 blocks dependency lifecycle scripts
unless the root `allowScripts` policy allows them, and sets `allow-git` and
`allow-remote` to `none` by default
(https://github.com/npm/cli/releases/tag/v12.0.0). No Node release bundles
npm 12 yet, so every installer installs it.

**Changed:**
- **`package.json`** has `engines.npm` `>=12.0.0` and `packageManager`
  `npm@12.2.0`. `.npmrc` already sets `engine-strict`, so npm 11 refuses
  `npm ci` and `npm install`. `package-lock.json` gained the same `engines`
  line on its root package and nothing else.
- **`scripts/require-npm.sh`** is the one check. It reads the floor and the
  pin from `package.json`; `--install` runs `npm install -g npm@<pin>`.
  `npm run` is not engine-gated, so the callers that never reach `npm ci`
  call it too: `just` recipes that run npm (private `_require-npm`),
  `verify-ci-equivalent.sh`, `release.sh` and `bump-version.sh`, each before
  its first write.
- **`scripts/setup.sh`** upgrades npm after `ensure_node` and before `npm ci`.
- **`.github/actions/setup-node`** wraps `actions/setup-node` (same pinned
  SHA) and runs `require-npm.sh --install`. Every job that runs `npm ci` uses
  it, directly or through `toolchain` and `playwright-setup`. Jobs that only
  run `node scripts/…` keep plain `actions/setup-node` with
  `package-manager-cache: false`: setup-node v7 turns its npm cache on by
  default once `packageManager` names npm.
- `ci.yml`'s `setup-node` step now lives in a composite, where zizmor's
  `cache-poisoning` audit does not fire, so its inline suppression and one
  count in `check-cache-poisoning-suppressions.mjs` are gone.

**Checked:** under npm 12.2.0 `npm ci` leaves the lockfile alone, `npm audit
signatures` and `better-npm-audit` work, and a bootstrap that starts on npm
11 through `npm run` upgrades npm and then runs `npm ci` on 12.
