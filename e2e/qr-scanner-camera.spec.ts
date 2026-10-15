import { activeDialog, expect, test, waitForBoot } from './helpers'

/**
 * #5386 — the pairing QR scanner crashed the Settings panel the moment the
 * camera started, because React rendered a child inside the node html5-qrcode
 * empties on `start()`. The vitest DOM has no camera, so this is the only lane
 * that drives a real `getUserMedia` stream: Chromium's fake camera device, with
 * the permission pre-granted.
 */
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
  permissions: ['camera'],
})

test('starting the pairing QR scanner renders a sized camera video', async ({ page }) => {
  await waitForBoot(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: /Sync.*Devices/i }).click()
  await page.getByRole('button', { name: /pair new device/i }).click()
  const dialog = activeDialog(page)
  await dialog.getByRole('button', { name: /have a code from the other device/i }).click()
  // The entry-mode toggle carries the "Recommended" badge; the scanner's own start button does not.
  await dialog.getByRole('button', { name: /^Scan QR code\s*Recommended$/ }).click()
  await dialog.getByRole('button', { name: 'Scan QR code', exact: true }).click()

  const video = dialog.locator('video')
  // Visible means a non-empty box, not merely present: html5-qrcode sizes the
  // video from its container's width, so a collapsed container leaves it at `width: 0px`.
  // A crash takes the video down with the panel, and the console gate fails on its error.
  await expect(video).toBeVisible()
})
