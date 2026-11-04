/**
 * A DOING task checkbox's dot is centred in its box and as wide as it is
 * tall, in device pixels, at the ratios Windows and Linux run at (1, 1.25,
 * 1.5, 2), in the light and dark themes, at every font-size setting.
 *
 * Read from a screenshot: the box's ring and the dot are one colour on a paler
 * fill, so a pixel's coverage is how far it is from the fill towards that
 * colour. The ring's edges on the centre row and column give the box's centre;
 * the dot is the coverage inside the ring.
 */

import type { Page } from '@playwright/test'

import { expect, ipc, test, waitForBoot } from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }

interface Dot {
  dx: number
  dy: number
  width: number
  height: number
}

/** The dot of `state`'s checkbox, measured in device px from a screenshot. */
async function measure(page: Page, state: string): Promise<Dot> {
  const box = page.locator(`[data-testid="task-checkbox-${state}"]`)
  await expect(box).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
  // Its button, whose padding leaves the page's colour round the box.
  const png = (
    await page.locator('[data-testid="task-marker"]', { has: box }).screenshot()
  ).toString('base64')
  const border = await box.evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth))
  return page.evaluate(
    async ({ data, borderPx }) => {
      const image = new Image()
      image.src = `data:image/png;base64,${data}`
      await image.decode()
      const { width, height } = image
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (ctx === null) throw new Error('no canvas')
      ctx.drawImage(image, 0, 0)
      const px = ctx.getImageData(0, 0, width, height).data
      const at = (x: number, y: number): number[] => {
        const i = (y * width + x) * 4
        return [px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0]
      }
      const distance = (a: number[], b: number[]): number =>
        Math.hypot(...a.map((v, k) => v - (b[k] ?? 0)))
      const cx = Math.floor(width / 2)
      const cy = Math.floor(height / 2)
      // The dot's colour at its centre, the page's at the corner.
      const ink = at(cx, cy)
      const background = at(0, 0)
      // A box not yet painted reads as the page: say so, not "off centre".
      if (distance(background, ink) === 0) throw new Error('no checkbox painted')
      const cover = (x: number, y: number, from: number[]): number =>
        Math.min(1, Math.max(0, 1 - distance(at(x, y), ink) / distance(from, ink)))
      // The ring's outer edges along the centre row and column, to a sub-pixel.
      const edges = (n: number, pixel: (i: number) => [number, number]) => {
        let first = -1
        let last = -1
        for (let i = 0; i < n; i += 1) {
          if (cover(...pixel(i), background) > 0.05) {
            if (first === -1) first = i
            last = i
          }
        }
        const start = first + 1 - cover(...pixel(first), background)
        const end = last + cover(...pixel(last), background)
        return { start, end }
      }
      const row = edges(width, (i) => [i, cy])
      const column = edges(height, (i) => [cx, i])
      const ring = Math.ceil(borderPx * window.devicePixelRatio) + 1
      // The fill inside the ring, just past it on the centre row.
      const fill = at(Math.ceil(row.start) + ring, cy)
      let mass = 0
      let sx = 0
      let sy = 0
      const rows = new Map<number, number>()
      const columns = new Map<number, number>()
      for (let y = Math.ceil(column.start) + ring; y < Math.floor(column.end) - ring; y += 1) {
        for (let x = Math.ceil(row.start) + ring; x < Math.floor(row.end) - ring; x += 1) {
          const c = cover(x, y, fill)
          mass += c
          sx += c * (x + 0.5)
          sy += c * (y + 0.5)
          rows.set(y, (rows.get(y) ?? 0) + c)
          columns.set(x, (columns.get(x) ?? 0) + c)
        }
      }
      if (mass === 0) throw new Error('no dot inside the ring')
      const dotWidth = Math.max(...rows.values())
      const dotHeight = Math.max(...columns.values())
      return {
        dx: sx / mass - (row.start + row.end) / 2,
        dy: sy / mass - (column.start + column.end) / 2,
        width: dotWidth,
        height: dotHeight,
      }
    },
    { data: png, borderPx: border },
  )
}

for (const ratio of [1, 1.25, 1.5, 2]) {
  for (const theme of ['light', 'dark']) {
    test.describe(`the task checkbox's dot at ${ratio}x, ${theme} @editor`, () => {
      test.use({ deviceScaleFactor: ratio })

      for (const size of ['small', 'medium', 'large']) {
        test(`is round and centred, ${size} text`, async ({ page }) => {
          await page.addInitScript(
            ([t, s]) => {
              localStorage.setItem('theme-preference', t)
              localStorage.setItem('agaric-font-size', s)
            },
            [theme, size] as const,
          )
          // The row fades in; a screenshot mid-fade reads a half-painted box.
          await page.emulateMedia({ reducedMotion: 'reduce' })
          await waitForBoot(page)
          const pageId = await ipc<string>(page, 'create_page_in_space', {
            parentId: null,
            content: 'Dots',
            spaceId: SCOPE.space_id,
          })
          const { id } = await ipc<{ id: string }>(page, 'create_block', {
            blockType: 'content',
            content: 'Doing task',
            parentId: pageId,
            index: null,
            scope: SCOPE,
          })
          await ipc(page, 'set_todo_state', { blockId: id, state: 'DOING' })
          await page.keyboard.press('Control+k')
          await page.locator('[cmdk-input]').first().fill('Dots')
          await page.locator('[cmdk-item]').filter({ hasText: 'Dots' }).first().waitFor()
          await page.keyboard.press('Enter')
          await expect(page.locator('[aria-label="Page title"]')).toHaveText('Dots')
          await page.mouse.move(0, 0)
          // Retried while the box has not been painted; an off-centre dot never becomes centred.
          await expect(async () => {
            const dot = await measure(page, 'doing')
            const what = JSON.stringify(dot)
            expect(Math.abs(dot.dx), what).toBeLessThanOrEqual(0.5)
            expect(Math.abs(dot.dy), what).toBeLessThanOrEqual(0.5)
            expect(Math.abs(dot.width - dot.height), what).toBeLessThanOrEqual(1)
          }).toPass({ timeout: 10_000 })
        })
      }
    })
  }
}
