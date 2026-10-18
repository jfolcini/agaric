/**
 * A diagram or display equation that fits its column shows no scrollbar, on
 * hover or at rest; one wider than the column still scrolls. The app turns the
 * native bars back on (index.css), so the browser's must stay visible here.
 */
import type { Locator, Page } from '@playwright/test'

import { expect, openPage, openPageMobile, seedSearchBlocks, test, waitForBoot } from './helpers'

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

const SMALL_FLOW = '```mermaid\ngraph TD\n  A[Capture idea] --> B{Worth doing?}\n```'
const WIDE_FLOW =
  '```mermaid\ngraph LR\n  Inbox --> Triage --> Today --> Doing --> Review --> Done\n  Done --> Archived[Archived for later reference] --> Reopened[Reopened next quarter]\n```'
const NARROW_MATH = '$$E = mc^2$$'
const WIDE_MATH =
  '$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2} \\qquad \\sum_{n=1}^\\infty \\frac{1}{n^2} = \\frac{\\pi^2}{6} \\qquad \\prod_{p\\ \\text{prime}} \\frac{1}{1-p^{-s}} = \\zeta(s) \\qquad \\Gamma(z) = \\int_0^\\infty t^{z-1} e^{-t}\\,dt \\qquad e^{i\\pi} + 1 = 0 \\qquad \\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}$$'

const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 900 },
} as const

/** The `nth` rendered diagram (`mermaid`) or display equation (`katex`). */
function rendered(page: Page, kind: 'mermaid' | 'katex', nth: number): Locator {
  return page.getByTestId(kind === 'mermaid' ? 'mermaid-diagram' : 'katex-block').nth(nth)
}

/** Its own scroll viewport's scrollbar box and overflow. */
function bars(content: Locator) {
  return content.evaluate((el) => {
    const viewport = el.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (!viewport) throw new Error('no scroll viewport')
    return {
      // The height of a horizontal scrollbar's box, overflowing or not.
      barHeight: viewport.offsetHeight - viewport.clientHeight,
      overflowX: viewport.scrollWidth - viewport.clientWidth,
      overflowY: viewport.scrollHeight - viewport.clientHeight,
      scrollLeft: viewport.scrollLeft,
    }
  })
}

for (const width of ['desktop', 'phone'] as const) {
  test(`at ${width} width, diagrams and equations that fit show no scrollbar; wide ones scroll @editor`, async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS[width])
    await waitForBoot(page)
    await seedSearchBlocks(
      page,
      [SMALL_FLOW, WIDE_FLOW, NARROW_MATH, WIDE_MATH].map((content) => ({ content })),
    )
    await (width === 'phone' ? openPageMobile : openPage)(page, 'Projects')
    await expect(page.locator('[data-testid="mermaid-diagram"] svg')).toHaveCount(2)
    await expect(page.locator('[data-testid="katex-block"] .katex')).toHaveCount(2)

    for (const fits of [rendered(page, 'mermaid', 0), rendered(page, 'katex', 0)]) {
      await fits.scrollIntoViewIfNeeded()
      await fits.hover()
      expect(await bars(fits)).toEqual({ barHeight: 0, overflowX: 0, overflowY: 0, scrollLeft: 0 })
    }

    for (const wide of [rendered(page, 'mermaid', 1), rendered(page, 'katex', 1)]) {
      await wide.scrollIntoViewIfNeeded()
      await wide.hover()
      const m = await bars(wide)
      expect(m.overflowX, 'wider than the column').toBeGreaterThan(0)
      expect(m.barHeight, 'a bar to drag').toBeGreaterThan(0)
      await page.mouse.wheel(200, 0)
      await expect.poll(async () => (await bars(wide)).scrollLeft).toBeGreaterThan(0)
    }
  })
}
