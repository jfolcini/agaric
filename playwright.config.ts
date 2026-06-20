import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  // Retry locally too (not just in CI). The local pre-push umbrella
  // (`scripts/verify-ci-equivalent.sh`) is the real gate before a push, and
  // a handful of overlay-timing tests (Radix popover / TipTap suggestion
  // mounts) can flake under load. Retries keep the gate from rejecting a
  // green tree on a one-off scheduling hiccup.
  //
  // #1458: CI drops to ONE retry. The old `retries: 2` was a cascade
  // *amplifier* — when the server stalled on a shard, every test failed
  // navigation and was retried ×2, tripling the wasted wall-clock until the
  // shard ran to the job cap. Moving e2e off the HMR dev server onto a static
  // `vite preview` build (see `webServer` below) removes the stall source, so
  // a single retry is enough to absorb a genuine one-off overlay flake without
  // re-multiplying a bad run. Locally (no sharding, no job cap) keep 2.
  retries: process.env['CI'] ? 1 : 2,
  // #1458: hard per-test ceiling. Healthy shards finish ~1/3 of the suite in
  // ~7.5 min, so any single test taking a full minute is already pathological;
  // 60s fails such a test fast instead of letting it (and its retry) drift
  // toward the job cap. Generous enough for the heaviest legitimate spec.
  timeout: 60_000,
  // #1458: global ceiling BELOW the 30-min CI job cap (`_validate.yml`
  // playwright `timeout-minutes: 30`). At ~25 min Playwright aborts itself and
  // still runs the reporter, so the per-shard report uploads BEFORE the runner
  // kills the job — making any future cascade diagnosable instead of
  // self-obscuring. Budget accounts for the per-shard prod build (~30-60s) +
  // browser install that share the 30-min cell. Effectively unbounded locally
  // for a full unsharded run, so only the CI path is constrained.
  globalTimeout: process.env['CI'] ? 25 * 60_000 : 0,
  // File-level parallelism via `fullyParallel: true`, with
  // per-suite `test.describe.configure({ mode: 'serial' })` annotations on
  // the specs whose tests share global state (op-log, pairing mock, kebab
  // popover chains). The workers cap below is per-shard — the CI sharding
  // lives in `.github/workflows/_validate.yml`'s playwright job, so the
  // effective parallelism in CI is `shards × workers` (3 × 2 today).
  //
  // Locally there is no sharding, so `'50%'` on a 16-core box spawned 8
  // browser contexts against ONE server, and the contention made
  // popover/suggestion mounts miss their visibility deadline (~50% flake on
  // the heaviest specs). Cap local parallelism at 4 to keep the server
  // responsive; the suite stays comfortably parallel without thrashing.
  // (#1458: the server is now a static `vite preview` build, not dev+HMR.)
  workers: process.env['CI'] ? 2 : 4,
  reporter: 'list',
  expect: {
    // Overlay mounts (popover/dialog/suggestion portals) can take a beat to
    // appear under parallel-context load; 8s occasionally clipped them. 15s
    // absorbs the jitter without hiding real hangs, and stays under the 60s
    // per-test ceiling so a genuinely stuck `expect` still fails fast (#1458).
    timeout: 15000,
  },
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    // #1458: fail-fast navigation/action bounds. Against the static `vite
    // preview` build (no on-the-fly HMR transform), a `page.goto` resolves in
    // well under a second, so a 30s navigation bound only ever fires on a
    // genuinely wedged server — turning the old silent multi-minute hang into a
    // fast, attributable failure. 15s on individual actions mirrors the overlay
    // `expect.timeout` so a stuck click/fill surfaces quickly rather than
    // burning the whole per-test budget.
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
    // Dismiss welcome modal by marking onboarding as done before app loads
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://localhost:5173',
          localStorage: [
            { name: 'agaric-onboarding-done', value: 'true' },
            // #1422: pre-dismiss the first-run mobile gesture coach-mark so its
            // overlay doesn't intercept taps in the mobile-viewport e2e specs.
            { name: 'agaric-gesture-coachmark-seen', value: 'true' },
          ],
        },
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // #1458 ROOT-CAUSE FIX: serve a static *production* build via `vite
    // preview` instead of `npm run dev` (vite dev + HMR). The dev server
    // compiled/transformed modules on demand and ran HMR; under the load of a
    // sharded CI run it stalled (transform-under-load or an outright crash),
    // every test on that shard failed navigation, and `retries: 2` tripled the
    // damage until the shard ran to the job cap — with the failing shard
    // VARYING run-to-run (the signature of infra/dev-server flake, not a bad
    // spec). A pre-built static bundle has no on-the-fly compilation, so there
    // is nothing to stall.
    //
    // `build:e2e` builds with `VITE_E2E=1`, which keeps the tauri IPC mock in
    // the bundle (main.tsx gates the mock on `import.meta.env.VITE_E2E`); the
    // suite depends on that mock, and a plain prod build would tree-shake it
    // out. `preview:e2e` serves `dist/` on :5173 with `--strictPort` so the
    // baseURL/storageState origin stay unchanged.
    command: 'npm run build:e2e && npm run preview:e2e',
    url: 'http://localhost:5173',
    // #1458: bound server readiness. The build (~30-60s) + preview boot must
    // finish well within this; 180s absorbs a cold CI build + a slow mirror
    // without letting a wedged build hang the run indefinitely. Locally,
    // `reuseExistingServer` skips the rebuild when a preview is already up.
    timeout: 180_000,
    // Local: reuse an already-running server (dev OR preview) for a fast
    // edit/run loop. CI: always start fresh (and thus always builds).
    reuseExistingServer: !process.env['CI'],
  },
})
