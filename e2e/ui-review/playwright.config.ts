import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { chromium, defineConfig } from '@playwright/test'

/**
 * The UI review tour (`ui-review.tour.ts`): every view and state, shot on a
 * phone and a desktop in light and dark. `scripts/ui-review.mjs` (`just
 * ui-review`) builds and serves the app, points `UI_REVIEW_URL` at it and names
 * the shot folder in `UI_REVIEW_OUT`. It asserts nothing, and the e2e suite and
 * CI do not run it: its `*.tour.ts` name matches no `testMatch` of theirs.
 */

const CLOUD_CHROMIUM = '/opt/pw-browsers/chromium'
const useCloudChromium = !existsSync(chromium.executablePath()) && existsSync(CLOUD_CHROMIUM)
const out = resolve(process.env['UI_REVIEW_OUT'] ?? 'ui-review-out/shots/current')

export default defineConfig({
  testDir: '.',
  testMatch: /\.tour\.ts$/,
  tsconfig: '../../tsconfig.e2e.json',
  outputDir: resolve(out, '.playwright'),
  fullyParallel: true,
  retries: 0,
  timeout: 300_000,
  reporter: 'list',
  use: {
    baseURL: process.env['UI_REVIEW_URL'] ?? 'http://localhost:5173',
    // A selector the app outgrew fails its one shot quickly, not the run.
    actionTimeout: 8_000,
    navigationTimeout: 20_000,
    timezoneId: 'UTC',
    locale: 'en-US',
    trace: 'off',
    ...(useCloudChromium ? { launchOptions: { executablePath: CLOUD_CHROMIUM } } : {}),
  },
})
