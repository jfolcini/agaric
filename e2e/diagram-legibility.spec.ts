/**
 * #5638 — Mermaid and KaTeX stay readable: wide display math scrolls instead of
 * being clipped, diagrams meet the contrast targets in every shipped theme and
 * keep their labels legible inline, and both open in a zoomable full-screen
 * viewer without entering edit mode.
 */
import { devices, type Locator, type Page } from '@playwright/test'

import {
  expect,
  focusBlockById,
  openPage,
  openPageMobile,
  readClipboard,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

const iPhone13 = devices['iPhone 13']

const WIDE_MATH =
  '$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2} \\qquad \\sum_{n=1}^\\infty \\frac{1}{n^2} = \\frac{\\pi^2}{6} \\qquad \\prod_{p\\ \\text{prime}} \\frac{1}{1-p^{-s}} = \\zeta(s)$$'

const FLOWCHART =
  '```mermaid\ngraph TD\n  A[Capture idea] --> B{Worth doing?}\n  B -->|yes| C[Plan it]\n  B -->|no| D[Archive]\n```'
const SEQUENCE =
  '```mermaid\nsequenceDiagram\n  Phone->>Laptop: hello over mDNS\n  Laptop-->>Phone: pairing proof\n```'

const WIDE_FLOWCHART =
  '```mermaid\ngraph LR\n  Inbox --> Triage --> Today --> Doing --> Review --> Done\n  Triage --> Someday[Someday / maybe]\n  Doing --> Blocked[Blocked on someone]\n  Blocked --> Doing\n  Review --> Weekly[Weekly retrospective]\n  Done --> Archived[Archived for later reference] --> Reopened[Reopened next quarter]\n```'
const TALL_FLOWCHART = `\`\`\`mermaid\ngraph TD\n${Array.from({ length: 14 }, (_, i) => `  S${i}[Step ${i}] --> S${i + 1}[Step ${i + 1}]`).join('\n')}\n\`\`\``

const THEMES = ['light', 'dark', 'solarized-light', 'solarized-dark', 'dracula', 'one-dark-pro']

const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 900 },
} as const

async function openSeeded(page: Page, width: keyof typeof VIEWPORTS, seeds: string[]) {
  await page.setViewportSize(VIEWPORTS[width])
  await waitForBoot(page)
  await seedSearchBlocks(
    page,
    seeds.map((content) => ({ content })),
  )
  await (width === 'phone' ? openPageMobile : openPage)(page, 'Projects')
}

test.describe('display math overflow (#5638)', () => {
  test('a wide equation at 390 px scrolls far enough to reach its last glyph', async ({ page }) => {
    await openSeeded(page, 'phone', [WIDE_MATH])
    const block = page.getByTestId('katex-block')
    await expect(block.locator('.katex')).toBeVisible()

    const reach = await block.evaluate((el) => {
      // Only a user-scrollable ancestor counts: script can scroll an
      // `overflow: hidden` box that a person cannot.
      const userScrollable = (n: HTMLElement) =>
        n.scrollWidth > n.clientWidth && /auto|scroll/.test(getComputedStyle(n).overflowX)
      let scroller: HTMLElement | null = el.parentElement
      while (scroller && !userScrollable(scroller)) scroller = scroller.parentElement
      // The equation scrolls on its own, not by dragging the whole page sideways.
      if (!scroller || !el.closest('[data-testid="block-static"]')?.contains(scroller)) {
        return { scroller: scroller ? scroller.className : null, overflow: 0, lastReachable: false }
      }
      scroller.scrollLeft = scroller.scrollWidth
      // The rightmost visible glyph bounds the rendered equation.
      const glyphs = [...el.querySelectorAll('.katex-html span')].filter(
        (s) => s.childElementCount === 0 && s.textContent?.trim(),
      )
      const last = glyphs.reduce((a, b) =>
        b.getBoundingClientRect().right > a.getBoundingClientRect().right ? b : a,
      )
      const lastRight = last.getBoundingClientRect().right
      return {
        scroller: 'own',
        overflow: scroller.scrollWidth - scroller.clientWidth,
        lastReachable:
          lastRight <= scroller.getBoundingClientRect().right + 1 && lastRight <= window.innerWidth,
      }
    })

    expect(reach.scroller, 'the equation has no scroller of its own').toBe('own')
    expect(reach.overflow).toBeGreaterThan(0)
    expect(reach.lastReachable, 'the last glyph is on screen once scrolled to the end').toBe(true)
  })
})

/** Smallest rendered label size, and whether a too-wide diagram has its own scroller. */
function measureLegibility(page: Page) {
  return page.getByTestId('mermaid-diagram').evaluate((el) => {
    const svg = el.querySelector('svg')
    if (!svg) throw new Error('no rendered svg')
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width
    const smallestLabelPx = Math.min(
      ...[...svg.querySelectorAll('text, foreignObject *')]
        .filter((n) => n.textContent?.trim())
        .map((n) => Number.parseFloat(getComputedStyle(n).fontSize) * scale),
    )
    const scroller = el.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
    return {
      smallestLabelPx,
      overflows: scroller ? scroller.scrollWidth > scroller.clientWidth : false,
      scrollable: scroller ? /auto|scroll/.test(getComputedStyle(scroller).overflowX) : false,
      fitsColumn: svg.getBoundingClientRect().width <= (scroller?.clientWidth ?? 0),
    }
  })
}

for (const width of ['phone', 'desktop'] as const) {
  test(`a wide flowchart keeps every label legible at ${width} width, scrolling instead of shrinking`, async ({
    page,
  }) => {
    await openSeeded(page, width, [WIDE_FLOWCHART])
    await expect(page.locator('[data-testid="mermaid-diagram"] svg')).toBeVisible()

    const m = await measureLegibility(page)
    expect(m.smallestLabelPx).toBeGreaterThanOrEqual(11)
    // Too wide for the column at a legible size, so it scrolls on its own.
    expect(m.fitsColumn).toBe(false)
    expect(m.overflows && m.scrollable).toBe(true)
  })
}

test('a tall diagram is capped inline and shows the fade', async ({ page }) => {
  await openSeeded(page, 'desktop', [TALL_FLOWCHART])
  await expect(page.locator('[data-testid="mermaid-diagram"] svg')).toBeVisible()
  const box = await page
    .locator('[data-slot="scroll-area"]:has([data-testid="mermaid-diagram"])')
    .boundingBox()
  expect(box?.height).toBeLessThanOrEqual(VIEWPORTS.desktop.height * 0.7 + 1)
  await expect(page.getByTestId('mermaid-fade')).toBeVisible()
})

/**
 * WCAG contrast of the colour pairs a reader depends on, measured on the
 * rendered SVG. Colours go through a canvas pixel so `oklch()` computed
 * values compare in sRGB like everything else.
 */
function measureContrast(page: Page) {
  return page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('no 2D canvas')
    const rgb = (css: string) => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
    }
    const token = (name: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name)
    const same = (a: string, b: string) => rgb(a).join() === rgb(b).join()
    const luminance = (css: string) => {
      const [r = 0, g = 0, b = 0] = rgb(css).map((v) => {
        const c = v / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (a: string, b: string) => {
      const [la, lb] = [luminance(a), luminance(b)]
      return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100
    }
    const style = (
      el: Element | null | undefined,
      prop: 'fill' | 'stroke' | 'color' | 'backgroundColor',
    ) => {
      if (!el) throw new Error(`missing element for ${prop}`)
      return getComputedStyle(el)[prop]
    }
    const [flow, seq] = [...document.querySelectorAll('[data-testid="mermaid-diagram"]')]
    if (!flow || !seq) throw new Error('expected a flowchart and a sequence diagram')
    const background = style(flow.closest('[data-slot="scroll-area"]'), 'backgroundColor')
    const nodeShape = flow.querySelector('.node rect, .node polygon')
    const actor = seq.querySelector('rect.actor')
    const nodeTextColor = style(flow.querySelector('.nodeLabel'), 'color')
    return {
      // The diagram is painted from the theme's own tokens, edge labels included.
      followsTokens:
        same(nodeTextColor, token('--foreground')) &&
        same(style(flow.querySelector('.flowchart-link'), 'stroke'), token('--muted-foreground')) &&
        same(style(flow.querySelector('span.edgeLabel'), 'backgroundColor'), background),
      nodeText: ratio(style(flow.querySelector('.nodeLabel'), 'color'), style(nodeShape, 'fill')),
      nodeStroke: ratio(style(nodeShape, 'stroke'), background),
      edge: ratio(style(flow.querySelector('.flowchart-link'), 'stroke'), background),
      actorText: ratio(
        style(seq.querySelector('text.actor > tspan'), 'fill'),
        style(actor, 'fill'),
      ),
      actorStroke: ratio(style(actor, 'stroke'), background),
      message: ratio(style(seq.querySelector('.messageLine0'), 'stroke'), background),
    }
  })
}

for (const theme of THEMES) {
  test(`mermaid follows the tokens and meets the contrast targets in the ${theme} theme`, async ({
    page,
  }) => {
    await page.addInitScript((t) => localStorage.setItem('theme-preference', t), theme)
    await openSeeded(page, 'desktop', [FLOWCHART, SEQUENCE])
    await expect(page.locator('[data-testid="mermaid-diagram"] svg')).toHaveCount(2)

    const c = await measureContrast(page)
    expect(c.followsTokens, 'text, edges and edge labels use the theme tokens').toBe(true)
    expect(c.nodeText, 'node text on node fill').toBeGreaterThanOrEqual(4.5)
    expect(c.actorText, 'actor text on actor fill').toBeGreaterThanOrEqual(4.5)
    expect(c.nodeStroke, 'node stroke on background').toBeGreaterThanOrEqual(3)
    expect(c.actorStroke, 'actor stroke on background').toBeGreaterThanOrEqual(3)
    expect(c.edge, 'edge on background').toBeGreaterThanOrEqual(3)
    expect(c.message, 'message line on background').toBeGreaterThanOrEqual(3)
  })
}

/** The surface's current `translate(x, y) scale(z)`, as numbers. */
async function surfaceTransform(surface: Locator) {
  const transform = await surface.evaluate((el) => (el as HTMLElement).style.transform)
  const [x, y, z] = (transform.match(/-?[\d.]+/g) ?? []).map(Number)
  return { x: x ?? Number.NaN, y: y ?? Number.NaN, z: z ?? Number.NaN }
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element has no box')
  return { ...box, cx: box.x + box.width / 2, cy: box.y + box.height / 2 }
}

async function expectStaticOnly(page: Page) {
  await expect(page.locator('[data-testid="block-editor"]')).toHaveCount(0)
}

/** Open the viewer from a static render, check it opened without editing, and return it. */
async function openViewer(page: Page, host: Locator, touch: boolean) {
  const expand = host.getByRole('button', { name: 'Expand', exact: true })
  if (touch) {
    // Always shown on touch, with no hover to reveal it.
    await expect(expand).toHaveCSS('opacity', '1')
    await expand.tap()
  } else {
    // Hidden until the diagram is hovered (the page-open click leaves the mouse over it).
    await page.mouse.move(0, 0)
    await expect(expand).toHaveCSS('opacity', '0')
    await host.hover()
    await expect(expand).toHaveCSS('opacity', '1')
    await expand.click()
  }
  const viewer = page.getByRole('dialog')
  await expect(viewer).toBeVisible()
  await expectStaticOnly(page)
  return { viewer, expand }
}

for (const [label, touch] of [
  ['desktop', false],
  ['phone', true],
] as const) {
  test.describe(`diagram viewer (${label})`, () => {
    test.use(
      touch
        ? {
            viewport: iPhone13.viewport,
            hasTouch: true,
            isMobile: true,
            deviceScaleFactor: iPhone13.deviceScaleFactor,
            userAgent: iPhone13.userAgent,
          }
        : { viewport: VIEWPORTS.desktop },
    )

    test.beforeEach(async ({ page }) => {
      await waitForBoot(page)
      await seedSearchBlocks(page, [
        { content: 'Inline $E = mc^2$ math.' },
        { content: WIDE_FLOWCHART },
        { content: WIDE_MATH },
      ])
      await (touch ? openPageMobile : openPage)(page, 'Projects')
      await expect(page.locator('[data-testid="mermaid-diagram"] svg')).toBeVisible()
    })

    test('a static diagram opens fitted; zoom, 100%, Fit, pan, copy, download and Escape work', async ({
      page,
    }) => {
      const host = page.locator('.group\\/diagram:has([data-testid="mermaid-diagram"])')
      const { viewer, expand } = await openViewer(page, host, touch)

      // On the app's own surface, not a black overlay.
      const [bg, token] = await viewer.evaluate((el) => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--background)'
        document.body.append(probe)
        const resolved = getComputedStyle(probe).color
        probe.remove()
        return [getComputedStyle(el).backgroundColor, resolved]
      })
      expect(bg).toBe(token)

      // Opens fitted: the wide diagram is scaled down to fit the screen.
      const surface = page.getByTestId('diagram-viewer-surface')
      expect((await boxOf(surface)).width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0)
      const fitted = await surfaceTransform(surface)
      expect(fitted.z).toBeLessThan(1)
      const zoomLabel = page.getByTestId('diagram-viewer-zoom')
      await expect(zoomLabel).toHaveText(`${Math.round(fitted.z * 100)}%`)

      // 100% shows the natural size; Fit returns to the fitted view.
      await viewer.getByRole('button', { name: 'Actual size (100%)' }).click()
      await expect(zoomLabel).toHaveText('100%')
      await viewer.getByRole('button', { name: /^Fit to screen/ }).click()
      await expect(zoomLabel).toHaveText(`${Math.round(fitted.z * 100)}%`)

      // Zoom in by button and by key.
      await viewer.getByRole('button', { name: /^Zoom in/ }).click()
      await page.keyboard.press('+')
      expect((await surfaceTransform(surface)).z).toBeCloseTo(fitted.z + 0.5, 2)

      // Pan by arrow key, by drag and by scroll.
      const before = await surfaceTransform(surface)
      await page.keyboard.press('ArrowLeft')
      const afterKey = await surfaceTransform(surface)
      expect(afterKey.x).toBeGreaterThan(before.x)
      const { cx, cy } = await boxOf(surface)
      await page.mouse.move(cx, cy)
      await page.mouse.down()
      await page.mouse.move(cx - 40, cy, { steps: 4 })
      await page.mouse.up()
      const afterDrag = await surfaceTransform(surface)
      expect(afterDrag.x).toBeLessThan(afterKey.x)
      if (!touch) {
        await page.mouse.wheel(0, 40)
        await expect.poll(async () => (await surfaceTransform(surface)).y).toBeLessThan(afterDrag.y)
      }

      // Copy source puts the Mermaid source on the clipboard.
      await viewer.getByRole('button', { name: 'Copy source' }).click()
      await expect.poll(() => readClipboard(page)).toContain('graph LR')

      // Download SVG saves the sanitised SVG at its natural size.
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        viewer.getByRole('button', { name: 'Download SVG' }).click(),
      ])
      expect(download.suggestedFilename()).toBe('diagram.svg')
      const file = await download.createReadStream().then(async (stream) => {
        let text = ''
        for await (const chunk of stream) text += chunk
        return text
      })
      const root = file.slice(0, file.indexOf('>'))
      expect(root).toMatch(/^<svg[^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/)
      expect(root).toMatch(/ width="\d/)
      expect(root).not.toContain('max-width')

      // Escape closes it and focus goes back to Expand, still without editing.
      await page.keyboard.press('Escape')
      await expect(viewer).toBeHidden()
      await expect(expand).toBeFocused()
      await expectStaticOnly(page)
    })

    test('display math opens in the viewer with Copy LaTeX; inline math has none', async ({
      page,
    }) => {
      await expect(page.getByTestId('katex-inline')).toBeVisible()
      // The diagram and the display equation have one each; inline math has none.
      await expect(page.getByTestId('diagram-expand')).toHaveCount(2)
      const host = page.locator('.group\\/diagram:has([data-testid="katex-block"])')
      const { viewer } = await openViewer(page, host, touch)
      await expect(viewer.locator('.katex')).toBeVisible()
      await viewer.getByRole('button', { name: 'Copy LaTeX' }).click()
      await expect.poll(() => readClipboard(page)).toContain('\\zeta(s)')
      await expect(viewer.getByRole('button', { name: 'Download SVG' })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(viewer).toBeHidden()
      await expectStaticOnly(page)
    })
  })
}

// The fitted diagram can be a thin strip, so gestures belong to the whole
// viewer, not to the diagram's own box.
test.describe('diagram viewer gestures outside the diagram (phone)', () => {
  test.use({ viewport: iPhone13.viewport, hasTouch: true, isMobile: true })

  test('two fingers that start above and below the fitted strip zoom in', async ({ page }) => {
    await waitForBoot(page)
    await seedSearchBlocks(page, [{ content: WIDE_FLOWCHART }])
    await openPageMobile(page, 'Projects')
    await page.getByRole('button', { name: 'Expand', exact: true }).tap()
    const surface = page.getByTestId('diagram-viewer-surface')
    await expect(surface).toBeVisible()
    const before = await surfaceTransform(surface)
    const { cx, cy, height } = await boxOf(surface)
    // Both fingers start outside the strip.
    expect(height).toBeLessThan(120)
    const cdp = await page.context().newCDPSession(page)
    const touches = (spread: number) => [
      { x: cx, y: cy - spread, id: 1 },
      { x: cx, y: cy + spread, id: 2 },
    ]
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touches(60) })
    for (const spread of [80, 100, 120]) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: touches(spread),
      })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
    expect((await surfaceTransform(surface)).z).toBeCloseTo(before.z * 2, 1)
  })
})

test.describe('diagram viewer gestures outside the diagram (desktop)', () => {
  test.use({ viewport: VIEWPORTS.desktop })

  test('Ctrl + wheel zooms and a drag pans from outside the diagram box', async ({ page }) => {
    await waitForBoot(page)
    await seedSearchBlocks(page, [{ content: WIDE_FLOWCHART }])
    await openPage(page, 'Projects')
    const host = page.locator('.group\\/diagram:has([data-testid="mermaid-diagram"])')
    await host.hover()
    await host.getByRole('button', { name: 'Expand', exact: true }).click()
    const surface = page.getByTestId('diagram-viewer-surface')
    await expect(surface).toBeVisible()
    const fitted = await surfaceTransform(surface)
    // Bottom-right of the screen, well below the fitted diagram.
    const outside = { x: VIEWPORTS.desktop.width - 100, y: VIEWPORTS.desktop.height - 60 }
    const { y, height } = await boxOf(surface)
    expect(outside.y).toBeGreaterThan(y + height * 2)

    await page.mouse.move(outside.x, outside.y)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -100)
    await page.keyboard.up('Control')
    await expect
      .poll(async () => (await surfaceTransform(surface)).z)
      .toBeCloseTo(fitted.z + 0.25, 2)

    await page.mouse.down()
    await page.mouse.move(outside.x - 40, outside.y, { steps: 4 })
    await page.mouse.up()
    expect((await surfaceTransform(surface)).x).toBeLessThan(0)
  })
})

test('the viewer opened from the editor keeps the block in edit mode', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop)
  await waitForBoot(page)
  const [id] = await seedSearchBlocks(page, [{ content: FLOWCHART }])
  await openPage(page, 'Projects')
  await focusBlockById(page, id ?? '')
  const nodeView = page.getByTestId('mermaid-node-view')
  // The caret entering the block flips it to source; show the diagram again.
  await nodeView.getByTestId('mermaid-toggle-source').click()
  await expect(nodeView.locator('[data-testid="mermaid-diagram"] svg')).toBeVisible()

  await nodeView.hover()
  await nodeView.getByRole('button', { name: 'Expand', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('[data-testid="block-editor"]')).toHaveCount(1)

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.locator('[data-testid="block-editor"]')).toHaveCount(1)
})
