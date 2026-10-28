# Session 2912 — qs 6.16.1 for GHSA-6pq8-jhm2-2vcw

A new moderate advisory on `qs` (`qs.stringify` with `arrayFormat: 'comma'` throws on an array element whose own `toString` is not callable; affects `>=6.7.0 <=6.16.0`) failed the pre-push audit and the lint job on every branch. `qs` comes in only through `@stryker-mutator/core` → `typed-rest-client`, a dev dependency.

`npm update qs --package-lock-only` moves it to 6.16.1. The newer 6.16.2 and 6.17.0 are inside the seven-day `min-release-age`, and 6.16.1 is past it. The lock diff is the one `qs` entry, and `better-npm-audit` is clean again.
