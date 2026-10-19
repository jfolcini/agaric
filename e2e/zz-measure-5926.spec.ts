// TEMPORARY measurement dump for #5926 — deleted before hand-off.
import { devices } from '@playwright/test'

import { expect, focusBlock, navigateToView, test, waitForBoot } from './helpers'

const iPhone13 = devices['iPhone 13']
const SHOTS = process.env['SHOTS_DIR'] ?? ''
const TAG = process.env['SHOTS_TAG'] ?? 'x'

for (const vp of [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
]) {
  test.describe(`measure ${vp.width} @mobile`, () => {
    test.use({
      viewport: vp,
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: iPhone13.deviceScaleFactor,
      userAgent: iPhone13.userAgent,
    })
    for (const view of ['Journal', 'Pages', 'Settings', 'Search', 'History', 'Advanced Query']) {
      test(`${view}`, async ({ page }) => {
        await waitForBoot(page)
        if (view !== 'Journal') await navigateToView(page, view)
        await page.waitForTimeout(400)
        const header = page.locator('header').first()
        const data = await header.evaluate((h) => {
          const hr = h.getBoundingClientRect()
          const controls = [...h.querySelectorAll('button, a[href], input, [role="button"]')]
            .filter((el) => {
              const r = el.getBoundingClientRect()
              return r.width > 0 && r.height > 0 && !el.closest('[aria-hidden="true"]')
            })
            .map((el) => {
              const r = el.getBoundingClientRect()
              const svg = el.querySelector('svg')?.getBoundingClientRect()
              return {
                name: el.getAttribute('aria-label') ?? el.textContent?.trim(),
                x: Math.round(r.left * 10) / 10,
                w: Math.round(r.width * 10) / 10,
                top: Math.round((r.top - hr.top) * 10) / 10,
                bottom: Math.round((hr.bottom - r.bottom) * 10) / 10,
                svgX: svg ? Math.round(svg.left * 10) / 10 : null,
              }
            })
            .sort((a, b) => a.x - b.x)
          const gaps = controls.slice(1).map((c, i) => {
            const p = controls[i]!
            return Math.round((c.x - (p.x + p.w)) * 10) / 10
          })
          return { h: hr.height, controls, gaps }
        })
        console.log(`${vp.width} ${view} ${JSON.stringify(data)}`)
        if (view === 'Search') {
          await page.locator('[data-sonner-toast] [data-close-button]').first().click()
          await page.waitForTimeout(600)
        }
        if (SHOTS && vp.width === 390) {
          await header.screenshot({
            path: `${SHOTS}/${TAG}-header-${view.replace(' ', '-').toLowerCase()}.png`,
          })
        }
        expect(data.controls.length).toBeGreaterThan(0)
      })
    }
    test('toolbar', async ({ page }) => {
      await waitForBoot(page)
      await focusBlock(page, 0)
      const tb = page.getByTestId('formatting-toolbar')
      await expect(tb).toBeVisible()
      await page.waitForTimeout(300)
      const data = await tb.evaluate((h) => {
        const hr = h.getBoundingClientRect()
        const controls = [...h.querySelectorAll('button')]
          .filter((el) => {
            const r = el.getBoundingClientRect()
            return r.width > 0 && !el.closest('[aria-hidden="true"]')
          })
          .map((el) => {
            const r = el.getBoundingClientRect()
            return { x: r.left, w: r.width, top: r.top - hr.top, bottom: hr.bottom - r.bottom }
          })
          .sort((a, b) => a.x - b.x)
        const gaps = controls.slice(1).map((c, i) => Math.round((c.x - (controls[i]!.x + controls[i]!.w)) * 10) / 10)
        return { h: hr.height, w: hr.width, sw: h.scrollWidth, n: controls.length, first: controls[0], last: controls.at(-1), gaps }
      })
      console.log(`${vp.width} toolbar ${JSON.stringify(data)}`)
      if (SHOTS && vp.width === 390) await tb.screenshot({ path: `${SHOTS}/${TAG}-toolbar.png` })
    })
  })
}
for (const width of [360, 390]) {
  test.describe(`chip ${width} @mobile`, () => {
    test.use({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true, userAgent: iPhone13.userAgent })
    test('week chip', async ({ page }) => {
      await waitForBoot(page)
      const header = page.locator('header').first()
      for (const mode of ['Week', 'Month']) {
        await header.getByRole('button', { name: /^Journal view mode/ }).click()
        await page.getByRole('button', { name: mode, exact: true }).click()
        const chip = header.getByRole('button', { name: /open calendar picker/i })
        const span = chip.locator('span.sm\\:hidden')
        const d = await span.evaluate((s) => ({ text: s.textContent, client: s.clientWidth, scroll: s.scrollWidth }))
        console.log(`${width} ${mode} ${JSON.stringify(d)}`)
        if (SHOTS && mode === 'Week') await header.screenshot({ path: `${SHOTS}/${TAG}-${width}-week.png` })
      }
    })
  })
}
