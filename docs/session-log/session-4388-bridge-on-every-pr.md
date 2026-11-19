# Session 4388 — the bridge specs run on every PR that reaches them

#6529 moved the specs `REAL_BACKEND_SPECS` lists onto the real commands, but only the nightly `full-suite` lane ran them there. Every PR ran them on the mock, with its hooks withheld. The maintainer's decision on #6529: once the bridge runs on every PR, the mock lane skips those specs.

**CI (`_validate.yml`):**
- `bridge-build` compiles the `bridge` bin once, under its own `rust-bridge` cache key, and strips it. `bridge-specs` runs the listed specs from that artifact on three shards, or only the changed specs on one leg when they are the whole diff.
- Both run on the mock lane's trigger (`playwright`), and on `rust_tests` too, because the specs call the real commands. `validate-all` requires them under the same rule, and each has a `stop-after-*` job.
- The mock lane's changed-specs leg passes with no tests, since a listed spec may hold no `@mock-only` test. So does `scripts/e2e-related.sh --run`, the pre-push pick: without it, a push whose picks are all listed specs failed with `No tests found`. The reviewer caught this; `e2e-related.test.mjs` pins it and goes red without the flag.
- The shards install `libwebkit2gtk-4.1-0` (cached `.deb`s): the bin links the Tauri crates' WebKitGTK, GTK and libsoup, which the Playwright runner lacks. The first CI run showed it: every bridge exited 127 before listening. The nightly ran the bin on a runner that had just built it.
- The nightly run stays as a backstop.

**Playwright (`playwright.config.ts`):**
- Without the bridge, the `chromium` project ignores the listed specs, and a `mock-only` project runs their `@mock-only` tests (14 tests in 10 files).
- The fixture that withheld the mock's hooks from a listed test is gone, with the flag the mock read. No mock run reaches a listed test that is not `@mock-only` any more, and the bridge itself fails a hook call.

**Shards:** `scripts/playwright-shard.mjs` counts a listed spec as zero seconds. By `e2e/spec-durations.json`, the three mock shards go from 1317/1200/1042 test-seconds to 1183/1193/1183. Two shards would carry about 1780 each. A bridge shard is about 1300, estimated from the local bridge run of the whole list (909 tests in 16.2 minutes at three workers). So two mock shards would outlast the bridge, and the lane keeps three.

**Docs:**
- `AGENTS.md` testing invariants 4 and 5 now point at the bridge first, and the CI line names `bridge-specs`.
- `e2e/AGENTS.md` has the "belongs on `REAL_BACKEND_SPECS`" paragraph and says where the specs run.
- `docs/architecture/ci-and-tooling.md` has the new job and cache key.
- Not yet changed: the `e2e-tauri/AGENTS.md` intro and the narrowing of `e2e-tauri-gate`.

**Ran:**
- `playwright test --list`: mock 1324 tests (`mock-only` 14); bridge 912.
- The `mock-only` project: 14 passed.
- Listed specs on the bridge: `smoke` and `search-toggles`, 8 passed.
- The same specs on the mock with `--pass-with-no-tests`: their 2 `@mock-only` tests passed.
- Mock shard 3 of 3 in full: 463 passed and 8 skipped. Three tests failed because they launch their own `chrome-headless-shell`, which this container does not have.
- prek on the touched files; `npm run typecheck`; `node --test scripts/merge-ready.test.mjs`.
