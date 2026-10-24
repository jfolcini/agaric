# Session 2901 — undici, happy-dom, fast-uri and serialize-javascript advisories

New npm advisories turned the `npm-audit` hook red on every PR (first seen on #6100):
- undici before 7.30.1 and 8.12.2: denial of service and a Subresource Integrity bypass (two high);
- happy-dom up to 21.0.3 (high);
- fast-uri up to 3.1.8: URI scheme spoofing, host confusion and two lows;
- serialize-javascript before 7.1.3 (low).

All four are dev-only, and none is in `npm ls --omit=dev`:
- happy-dom is vitest's DOM.
- undici comes through webdriverio (cheerio and webdriver) and jsdom.
- fast-uri comes through Stryker's `ajv`.
- serialize-javascript is an existing override.

`npm update fast-uri undici happy-dom serialize-javascript` moves only those packages in the lockfile: undici 7.30.1 and 8.12.3, happy-dom 21.0.4, fast-uri 3.1.9, serialize-javascript 7.1.3. Every declared range already allowed them, so `package.json` does not change.

Three fixes are younger than `.npmrc`'s seven-day `min-release-age`. `.npmrc` names `--min-release-age` as the way to take a fix early. It ran at one day rather than zero, which takes serialize-javascript 7.1.3 rather than the half-day-old 7.1.4.

`scripts/npm-audit-retry.sh` passes. vitest over `src/lib`, `src/hooks`, `src/stores` and `src/components` passes on the new happy-dom.
