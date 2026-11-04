import type { Page } from '@playwright/test'

import { activeSuggestionList, expect, focusBlock, openPage, test, waitForBoot } from './helpers'

/**
 * A typing-triggered picker opens once and stays still while the query grows:
 * the same popup node, the same anchored edge, the previous results kept until
 * new ones arrive, and never over the line being typed. Sampled every
 * animation frame, so a one-frame jump or flash counts.
 */

interface Sample {
  connected: boolean
  left: number
  top: number
  bottom: number
  empty: boolean
  /** The caret's line, or null when the selection has no rect. */
  lineTop: number | null
  lineBottom: number | null
}

/** Start sampling the open popup every frame until `stopSampling`. */
async function startSampling(page: Page): Promise<void> {
  await page.evaluate(() => {
    const popup = document.querySelector('[data-testid="suggestion-popup"]')
    if (!popup) throw new Error('no suggestion popup to sample')
    const samples: Sample[] = []
    const w = window as unknown as { __popupSamples: Sample[]; __popupSampling: boolean }
    w.__popupSamples = samples
    w.__popupSampling = true
    const tick = () => {
      if (!w.__popupSampling) return
      const box = popup.getBoundingClientRect()
      const sel = window.getSelection()
      const caret = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null
      const hasCaret = caret !== null && caret.height > 0
      samples.push({
        connected: popup.isConnected,
        left: box.left,
        top: box.top,
        bottom: box.bottom,
        empty: popup.querySelector('.suggestion-empty') !== null,
        lineTop: hasCaret ? caret.top : null,
        lineBottom: hasCaret ? caret.bottom : null,
      })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopSampling(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __popupSamples: Sample[]; __popupSampling: boolean }
    w.__popupSampling = false
    return w.__popupSamples
  })
}

/**
 * Type `trigger`, wait for its list, then type `query` one key at a time and
 * return every frame's sample once `lastItem` shows.
 */
async function typeAndSample(
  page: Page,
  trigger: string,
  query: string,
  lastItem: string,
): Promise<Sample[]> {
  await page.keyboard.press('End')
  await page.keyboard.type(` ${trigger}`, { delay: 30 })
  await expect(activeSuggestionList(page)).toBeVisible()
  await startSampling(page)
  await page.keyboard.type(query, { delay: 80 })
  await expect(
    activeSuggestionList(page).locator('[data-testid="suggestion-item"]', { hasText: lastItem }),
  ).toBeVisible()
  return stopSampling(page)
}

/** Delay every IPC call by `ms`, as a busy real backend would, so a fetch spans frames. */
async function slowIpc(page: Page, ms: number): Promise<void> {
  await page.evaluate((delay) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> })
      .__TAURI_INTERNALS__
    const original = internals['invoke'] as (...args: unknown[]) => Promise<unknown>
    internals['invoke'] = (...args: unknown[]) =>
      new Promise((resolve) => setTimeout(resolve, delay)).then(() => original(...args))
  }, ms)
}

function expectStill(samples: Sample[], edge: 'top' | 'bottom'): void {
  // Enough frames to have seen every keystroke land.
  expect(samples.length).toBeGreaterThan(20)
  const [first] = samples
  if (!first) throw new Error('no samples')
  const drift = (pick: (s: Sample) => number) =>
    Math.max(...samples.map((s) => Math.abs(pick(s) - pick(first))))
  const overlapsLine = (s: Sample) =>
    s.lineTop !== null && s.lineBottom !== null && s.top < s.lineBottom && s.bottom > s.lineTop
  // One object, so a failure prints the whole measurement.
  const measured = {
    disconnectedFrames: samples.filter((s) => !s.connected).length,
    emptyFrames: samples.filter((s) => s.empty).length,
    overLineFrames: samples.filter(overlapsLine).length,
    leftDriftOver: drift((s) => s.left) > 0.5,
    edgeDriftOver: drift((s) => s[edge]) > 0.5,
  }
  expect(
    measured,
    `left drift ${drift((s) => s.left)}px, ${edge} drift ${drift((s) => s[edge])}px`,
  ).toEqual({
    disconnectedFrames: 0,
    emptyFrames: 0,
    overLineFrames: 0,
    leftDriftOver: false,
    edgeDriftOver: false,
  })
  expect(samples.some((s) => s.lineTop !== null)).toBe(true)
}

test.describe('Suggestion popups stay still while typing @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('[[ link picker keeps its node and position', async ({ page }) => {
    await focusBlock(page)
    expectStill(await typeAndSample(page, '[[', 'Gettin', 'Getting Started'), 'top')
  })

  test('[[ keeps its results on screen while a slow backend fetches the next', async ({ page }) => {
    await focusBlock(page)
    await slowIpc(page, 100)
    expectStill(await typeAndSample(page, '[[', 'Gettin', 'Getting Started'), 'top')
  })

  test('/ slash menu keeps its node and position', async ({ page }) => {
    await focusBlock(page)
    expectStill(await typeAndSample(page, '/', 'headin', 'Heading 1'), 'top')
  })

  test('# tag picker keeps its node and position', async ({ page }) => {
    await focusBlock(page)
    expectStill(await typeAndSample(page, '#p', 'erson', 'personal'), 'top')
  })

  test('near the bottom of the viewport it opens above the line and stays there', async ({
    page,
  }) => {
    const last = page.locator('[data-testid="block-static"]').last()
    const box = await last.boundingBox()
    if (!box) throw new Error('no last block')
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('no viewport')
    // Leave less room below the block than the popup needs.
    await page.setViewportSize({
      width: viewport.width,
      height: Math.round(box.y + box.height + 60),
    })
    await focusBlock(page, 4)
    const samples = await typeAndSample(page, '[[', 'Gettin', 'Getting Started')
    const [first] = samples
    if (!first?.lineTop) throw new Error('no line rect')
    expect(first.bottom).toBeLessThanOrEqual(first.lineTop)
    expectStill(samples, 'bottom')
  })
})
