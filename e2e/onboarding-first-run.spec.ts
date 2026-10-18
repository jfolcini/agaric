/**
 * E2E — first-run Welcome modal (#5741): shown on a fresh vault, dismissed with
 * "Get Started", and not shown on the next launch.
 *
 * In `e2e/` because the whole contract is frontend: the onboarding flag lives in
 * localStorage (`@/lib/onboarding`) and the App shell's `useWelcomeGate` reads it
 * once per launch. "Show tour again" from Settings › Help is covered by
 * `settings-help.spec.ts`.
 *
 * Runs on an iPhone 13 profile because there the gate's "no welcome" decision
 * renders something: the gesture coach-mark mounts only when `!showWelcome`
 * (App.tsx). Waiting for it proves the next launch has decided, so the modal's
 * absence is not a read taken before its lazy chunk arrived.
 */

import { devices } from '@playwright/test'

import { expect, test, waitForBoot } from './helpers'

const iPhone13 = devices['iPhone 13']

test.use({
  viewport: iPhone13.viewport,
  hasTouch: iPhone13.hasTouch,
  isMobile: iPhone13.isMobile,
  deviceScaleFactor: iPhone13.deviceScaleFactor,
  userAgent: iPhone13.userAgent,
  // A fresh vault: neither the onboarding nor the coach-mark flag the config seeds.
  storageState: { cookies: [], origins: [] },
})

test('Welcome modal shows on first run, dismisses, and stays dismissed on the next launch @boot @mobile', async ({
  page,
}) => {
  await waitForBoot(page)

  const welcome = page.getByRole('dialog', { name: 'Welcome to Agaric' })
  await expect(welcome).toBeVisible()
  await welcome.getByRole('button', { name: 'Get Started' }).click()
  await expect(welcome).toHaveCount(0)

  // Next launch: a fresh boot sharing this browser's storage.
  const nextLaunch = await page.context().newPage()
  await waitForBoot(nextLaunch)
  await expect(nextLaunch.getByRole('dialog', { name: 'Touch gestures' })).toBeVisible()
  await expect(nextLaunch.getByRole('dialog', { name: 'Welcome to Agaric' })).toHaveCount(0)
})
