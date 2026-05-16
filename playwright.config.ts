import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  // PEND-41 R14: file-level parallelism via `fullyParallel: true`, with
  // per-suite `test.describe.configure({ mode: 'serial' })` annotations on
  // the specs whose tests share global state (op-log, pairing mock, kebab
  // popover chains). The workers cap below is per-shard — the CI sharding
  // lives in `.github/workflows/_validate.yml`'s playwright job, so the
  // effective parallelism in CI is `shards × workers` (2 × 2 today).
  workers: process.env['CI'] ? 2 : '50%',
  reporter: 'list',
  expect: {
    timeout: 8000,
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
          localStorage: [{ name: 'agaric-onboarding-done', value: 'true' }],
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
