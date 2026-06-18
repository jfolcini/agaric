import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  // Retry locally too (not just in CI). The local pre-push umbrella
  // (`scripts/verify-ci-equivalent.sh`) is the real gate before a push, and
  // a handful of overlay-timing tests (Radix popover / TipTap suggestion
  // mounts) flake under load on a single shared Vite dev server. CI already
  // retries; mirroring that here keeps the gate from rejecting a green tree
  // on a one-off scheduling hiccup while the robustness fixes below cut the
  // base flake rate.
  retries: 2,
  // PEND-41 R14: file-level parallelism via `fullyParallel: true`, with
  // per-suite `test.describe.configure({ mode: 'serial' })` annotations on
  // the specs whose tests share global state (op-log, pairing mock, kebab
  // popover chains). The workers cap below is per-shard — the CI sharding
  // lives in `.github/workflows/_validate.yml`'s playwright job, so the
  // effective parallelism in CI is `shards × workers` (2 × 2 today).
  //
  // Locally there is no sharding, so `'50%'` on a 16-core box spawned 8
  // browser contexts against ONE Vite dev server, and the contention made
  // popover/suggestion mounts miss their visibility deadline (~50% flake on
  // the heaviest specs). Cap local parallelism at 4 to keep the dev server
  // responsive; the suite stays comfortably parallel without thrashing.
  workers: process.env['CI'] ? 2 : 4,
  reporter: 'list',
  expect: {
    // Overlay mounts (popover/dialog/suggestion portals) can take a beat to
    // appear when the dev server is busy; 8s occasionally clipped them under
    // the pre-push load. 15s absorbs the jitter without hiding real hangs.
    timeout: 15000,
  },
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
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
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env['CI'],
  },
})
