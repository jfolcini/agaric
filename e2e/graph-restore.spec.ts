import type { Page } from '@playwright/test'

import { expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * Coming back to the graph restores it (#5434): Graph → page → Back shows
 * every node where it was and the view zoomed and panned as it was left, on
 * the worker path and on the main-thread fallback.
 */

type Positions = Record<string, [number, number]>

const NODES = '[data-testid="graph-view"] svg g.node'
/** A kept layout comes back within this many graph units of where it was. */
const TOLERANCE = 2

function nodePositions(page: Page): Promise<Positions> {
  return page.locator(NODES).evaluateAll((groups) => {
    const out: Record<string, [number, number]> = {}
    for (const g of groups) {
      const m = /translate\(([-\d.e]+),([-\d.e]+)\)/.exec(g.getAttribute('transform') ?? '')
      if (m) out[g.getAttribute('aria-label') ?? ''] = [Number(m[1]), Number(m[2])]
    }
    return out
  })
}

function maxDistance(a: Positions, b: Positions): number {
  const labels = Object.keys(a)
  if (labels.length === 0 || labels.length !== Object.keys(b).length)
    return Number.POSITIVE_INFINITY
  return Math.max(
    ...labels.map((label) => {
      const [ax, ay] = a[label] ?? [Number.NaN, Number.NaN]
      const [bx, by] = b[label] ?? [Number.NaN, Number.NaN]
      return Math.hypot(ax - bx, ay - by)
    }),
  )
}

/**
 * Waits for the simulation to stop: no node moves at all between two reads a
 * second apart. A layout still creeping toward `alphaMin` moves every tick.
 */
async function settledPositions(page: Page): Promise<Positions> {
  let last: Positions = {}
  await expect
    .poll(
      async () => {
        const now = await nodePositions(page)
        const still = maxDistance(last, now) === 0
        last = now
        return still
      },
      { intervals: [1000], timeout: 30_000 },
    )
    .toBe(true)
  return last
}

function scale(transform: string | null): number {
  return Number(/scale\(([\d.e-]+)\)/.exec(transform ?? '')?.[1])
}

async function graphToPageAndBack(page: Page): Promise<void> {
  await navigateToView(page, 'Graph')
  await expect(page.locator(NODES).first()).toBeVisible()
  const before = await settledPositions(page)

  // Zoom in, then pan, so the kept transform is not the one the first settle fitted (#5432).
  const svg = page.getByTestId('graph-svg')
  const g = page.locator('[data-testid="graph-svg"] > g').first()
  const fittedScale = scale(await g.getAttribute('transform'))
  await page.getByRole('button', { name: /^Zoom in/ }).click()
  await expect
    .poll(async () => scale(await g.getAttribute('transform')))
    .toBeCloseTo(fittedScale * 1.3, 3)
  const box = await svg.boundingBox()
  if (!box) throw new Error('graph svg has no bounding box')
  const start = { x: box.x + 20, y: box.y + box.height - 20 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) await page.mouse.move(start.x + 6 * i, start.y - 4 * i)
  await page.mouse.up()
  await expect.poll(() => g.getAttribute('transform')).not.toMatch(/^translate\(0,0\)/)
  const transform = await g.getAttribute('transform')

  await page
    .locator(NODES)
    .filter({ hasText: 'Getting Started' })
    .locator('circle.hit-area')
    // A human-length press: d3-drag reheats the simulation on mousedown.
    .click({ delay: 120 })
  await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
  await page.locator('header').first().getByRole('button', { name: 'Back', exact: true }).click()

  // The first paint after Back is the kept layout, not d3's initial spiral.
  await expect(page.locator(NODES).first()).toBeVisible()
  await expect(g).toHaveAttribute('transform', transform ?? '')
  expect(maxDistance(before, await nodePositions(page))).toBeLessThan(TOLERANCE)

  // And it stays there: a settled layout with nothing new starts at rest.
  expect(maxDistance(before, await settledPositions(page))).toBeLessThan(TOLERANCE)
  await expect(g).toHaveAttribute('transform', transform ?? '')
}

test.describe('Graph → page → Back restores the graph (#5434)', () => {
  test.slow()

  test('on the worker path', async ({ page }) => {
    await waitForBoot(page)
    await graphToPageAndBack(page)
    expect(page.workers()).toHaveLength(1)
  })

  test('on the main-thread fallback', async ({ page }) => {
    await page.addInitScript(() => {
      // `useGraphSimulation` takes the main-thread path when there is no Worker.
      Reflect.deleteProperty(window, 'Worker')
    })
    await waitForBoot(page)
    await graphToPageAndBack(page)
    expect(page.workers()).toHaveLength(0)
  })
})
