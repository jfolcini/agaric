import { devices, type Locator, type Page } from '@playwright/test'

import {
  activeDialog,
  activeSheet,
  clearConsoleErrors,
  expect,
  getConsoleErrors,
  navigateToView,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5386 — the pairing QR scanner crashed the Settings panel the moment the
 * camera started, because React rendered a child inside the node html5-qrcode
 * empties on `start()`. Then, on Android, the live image did not fit its square
 * viewfinder. The vitest DOM has no camera, so this is the only lane that drives
 * a real `getUserMedia` stream: Chromium's fake camera device, a 4:3 stream,
 * with the permission pre-granted.
 */
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
  permissions: ['camera'],
})

const { defaultBrowserType: _, ...pixel7 } = devices['Pixel 7']

async function startScanner(page: Page): Promise<Locator> {
  await waitForBoot(page)
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Sync & devices')
  await page.getByRole('button', { name: /pair new device/i }).click()
  // A bottom sheet on phones, a dialog elsewhere.
  const dialog = activeDialog(page).or(activeSheet(page))
  await dialog.getByRole('button', { name: /have a code from the other device/i }).click()
  // One press: choosing to scan starts the camera.
  await dialog.getByRole('button', { name: /^Scan QR code\s*Recommended$/ }).click()
  return dialog.getByRole('region', { name: 'QR code scanner viewport' })
}

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * The viewfinder, the video, the part of the video the viewfinder shows, and
 * the scan region: html5-qrcode's shading element covers the video and its
 * borders shade everything outside the region it decodes.
 */
function measure(viewfinder: Locator) {
  return viewfinder.evaluate((el) => {
    const box = (e: Element) => {
      const r = e.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    }
    const video = el.querySelector('video')
    const shade = el.querySelector('#qr-shaded-region')
    // The video's box is final once html5-qrcode has set its scanning UI up.
    if (!video || !el.querySelector('#qr-canvas')) return null
    const s = shade && getComputedStyle(shade)
    const outer = shade && box(shade)
    const frame = s &&
      outer && {
        left: outer.left + Number.parseFloat(s.borderLeftWidth),
        top: outer.top + Number.parseFloat(s.borderTopWidth),
        right: outer.right - Number.parseFloat(s.borderRightWidth),
        bottom: outer.bottom - Number.parseFloat(s.borderBottomWidth),
      }
    const v = box(video)
    const f = box(el)
    const clips = getComputedStyle(el).overflow !== 'visible'
    const visible = clips
      ? {
          left: Math.max(v.left, f.left),
          top: Math.max(v.top, f.top),
          right: Math.min(v.right, f.right),
          bottom: Math.min(v.bottom, f.bottom),
        }
      : v
    return { viewfinder: f, video: v, visible, frame }
  })
}

function expectInside(inner: Box | null, outer: Box) {
  // html5-qrcode draws no frame when the scan region does not fit the video.
  if (!inner) throw new Error('no scan frame drawn')
  expect(inner.left).toBeGreaterThanOrEqual(outer.left)
  expect(inner.top).toBeGreaterThanOrEqual(outer.top)
  expect(inner.right).toBeLessThanOrEqual(outer.right)
  expect(inner.bottom).toBeLessThanOrEqual(outer.bottom)
  // A frame of zero size is "inside" anything.
  expect(inner.right - inner.left).toBeGreaterThan(50)
}

async function expectFillsViewfinder(page: Page) {
  const viewfinder = await startScanner(page)
  // A crash takes the video down with the panel, and the console gate fails on its error.
  await expect(viewfinder.locator('video')).toBeVisible()
  await expect.poll(() => measure(viewfinder), { message: 'scanner UI set up' }).not.toBeNull()
  const m = await measure(viewfinder)
  if (!m) throw new Error('scanner unmounted')
  for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
    expect(Math.abs(m.video[edge] - m.viewfinder[edge]), `video ${edge} edge`).toBeLessThanOrEqual(
      1,
    )
  }
  expectInside(m.frame, m.video)
}

test('the camera image fills the square viewfinder at desktop width', async ({ page }) => {
  await expectFillsViewfinder(page)
})

test('closing the dialog while the camera is still starting leaves no camera on', async ({
  page,
}) => {
  // Hold getUserMedia open until the dialog is gone, so start() is still pending at the close.
  await page.addInitScript(() => {
    const w = window as unknown as {
      cameraRequests: number
      cameraTracks: MediaStreamTrack[]
      grantCamera: () => void
    }
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    const granted = new Promise<void>((resolve) => {
      w.grantCamera = resolve
    })
    w.cameraRequests = 0
    w.cameraTracks = []
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      w.cameraRequests += 1
      await granted
      const stream = await getUserMedia(constraints)
      w.cameraTracks.push(...stream.getTracks())
      return stream
    }
  })
  const viewfinder = await startScanner(page)
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { cameraRequests: number }).cameraRequests),
    )
    .toBe(1)
  await activeDialog(page).getByRole('button', { name: 'Close', exact: true }).click()
  await expect(viewfinder).toHaveCount(0)

  await page.evaluate(() => (window as unknown as { grantCamera: () => void }).grantCamera())
  const trackStates = () =>
    page.evaluate(() =>
      (window as unknown as { cameraTracks: MediaStreamTrack[] }).cameraTracks.map(
        (t) => t.readyState,
      ),
    )
  await expect.poll(trackStates).toEqual(['ended'])
  // The Settings panel survived the close: no error boundary took it over.
  await expect(page.getByTestId('settings-panel-sync')).toBeVisible()
  // html5-qrcode calls video.play() without a catch; stopping the late camera
  // removes that video and rejects the play. Nothing else may be logged.
  expect(
    getConsoleErrors(page).every((e) => e.includes('The play() request was interrupted')),
  ).toBe(true)
  clearConsoleErrors(page)
})

test.describe('at phone width', () => {
  test.use(pixel7)

  test('the camera image fills the square viewfinder', async ({ page }) => {
    await expectFillsViewfinder(page)
  })

  // A denied camera keeps the user on the scanner; the form's own toggle is the way out.
  test('a denied camera stays on the scanner, focuses Retry, and Type passphrase leaves it', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
    })
    const viewfinder = await startScanner(page)
    await expect(viewfinder).toContainText('Camera permission denied')
    const dialog = activeDialog(page).or(activeSheet(page))
    const retry = dialog.getByRole('button', { name: 'Retry camera', exact: true })
    await expect(retry).toBeFocused()
    const typePassphrase = dialog.getByRole('button', { name: 'Type passphrase', exact: true })
    for (const button of [retry, typePassphrase]) {
      await expect(button).toBeInViewport()
      expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    }

    await typePassphrase.tap()
    await expect(dialog.getByRole('textbox')).toHaveCount(4)
    await expect(viewfinder).toHaveCount(0)
  })

  // A camera that ignores the square aspect request keeps its own shape.
  for (const [shape, width, height] of [
    ['portrait', 480, 640],
    ['landscape', 640, 480],
  ] as const) {
    test(`a ${shape} camera that ignores the aspect request stays centred, frame on the image`, async ({
      page,
    }) => {
      await page.addInitScript(
        ([w, h]) => {
          const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
          navigator.mediaDevices.getUserMedia = () =>
            getUserMedia({ video: { width: { exact: w }, height: { exact: h } } })
          MediaStreamTrack.prototype.applyConstraints = () => Promise.resolve()
        },
        [width, height] as const,
      )
      const viewfinder = await startScanner(page)
      await expect.poll(() => measure(viewfinder), { message: 'scanner UI set up' }).not.toBeNull()
      const m = await measure(viewfinder)
      if (!m) throw new Error('scanner unmounted')
      const videoAspect = (m.video.right - m.video.left) / (m.video.bottom - m.video.top)
      expect(videoAspect).toBeCloseTo(width / height, 1)
      const side = m.viewfinder.right - m.viewfinder.left
      expect(
        Math.abs(m.viewfinder.bottom - m.viewfinder.top - side),
        'viewfinder square',
      ).toBeLessThanOrEqual(1)
      const mid = (b: Box) => [(b.left + b.right) / 2, (b.top + b.bottom) / 2]
      const [vx = 0, vy = 0] = mid(m.video)
      const [fx = 0, fy = 0] = mid(m.viewfinder)
      expect(Math.abs(vx - fx), 'video centred horizontally').toBeLessThanOrEqual(1)
      expect(Math.abs(vy - fy), 'video centred vertically').toBeLessThanOrEqual(1)
      expectInside(m.visible, m.viewfinder)
      expectInside(m.frame, m.visible)
    })
  }
})
