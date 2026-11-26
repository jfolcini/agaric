# Session 4473 — the Node floor moves to 24, and `npm ci` stops printing deprecations

The nightly deep checks printed eight `npm warn deprecated` lines in every job. Seven came from `license-checker` 25, which is unmaintained: `read-installed`, `read-package-json`, `readdir-scoped-modules`, `debuglog`, `osenv`, `inflight` and `glob` 7. The eighth, `whatwg-encoding`, came through `webdriverio` → `cheerio` → `encoding-sniffer` 0.2. The maintained fork, `license-checker-rseidelsohn`, needs Node 24 from 5.0 on. Its 4.x line still pulls `read-package-json` 6 and `glob` 10. The maintainer chose to raise the Node floor.

**Changes.**
- `engines.node` is `^24.22.1 || >=26.12.1`. It is still the intersection of the dependency tree: `@wdio/*` set each line's floor, and the fork's `>=24` drops the 22 and 23 lines.
- `license-checker-rseidelsohn` 5 replaces `license-checker` in the hook, `package.json` and `knip.json`, with the same flags and allowlist.
- An override takes `encoding-sniffer` to 1.0, which has the same exports and uses `@exodus/bytes`. `cheerio` 1.2 still declares `^0.2.1`.
- The nightly floor lane (`full-suite-frontend`) installs 24.22.1.
- The four `--no-warnings` flags in `verify-ci-equivalent.sh` and `devdb-migration-gap.mjs` existed for Node 22's `node:sqlite` warning, which Node 24 does not print. They are removed, along with the pitfall that said to run guards on Node 22.
- The range's copies in `.npmrc`, `CONTRIBUTING.md`, `docs/BUILD.md`, `prek.toml`, `setup.sh` and `check-main-module-detection.mjs` now give the new range. `.npmrc` had named jsdom as the binding constraint; it is `@wdio`.
- `.nsprc`'s minimatch waiver names the new 10.x consumers. The fork pins `@npmcli/arborist` 9.6.0, whose `@npmcli/map-workspaces`, `ignore-walk` and `@tufjs/models` chains declare `^10`. `npm audit` reports no advisory beyond that waiver.

**Ran, on Node 24.22.3 unless stated.**
- `npm ci` printed no deprecation on 24.22.3 or 24.22.1 (the floor). On Node 22 it stops with `EBADENGINE`.
- `npm ls --all` is clean.
- `cheerio` decodes a windows-1252 page through `encoding-sniffer` 1.0 from its ESM and CommonJS builds, on 24.22.1 and 24.22.3.
- The old and new license checkers give the same per-license summary for the production tree. Both exit 1 when MIT is dropped from the allowlist, and the fork also exits 1 without OFL-1.1.
- Node 24.22.1 and 24.22.3 load `node:sqlite` without a warning; Node 22 prints one.
- `prek run` over the changed files at the pre-commit and manual stages, including the license check and the `verify-ci-equivalent.sh` self-test.
- `scripts/setup.sh`'s Node steps in a sandboxed `HOME`, starting from this VM's Node 22 with no nvm. It fetched nvm.sh against its `pins.txt` sha256, installed `.nvmrc`'s Node (checksum matched), shimmed `node`, `npm` and `npx`, and moved npm to the `packageManager` pin. `npm ci` then installed with no deprecation.
- `pins.txt` pins no Node version: `.nvmrc` is the file pin, and the floor lane's `24.22.1` is the `engines` floor, as its `22.23.4` was.
