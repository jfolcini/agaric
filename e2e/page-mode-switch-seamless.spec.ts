/**
 * A switch between block mode and page mode (#5691) draws no frame without the page: block mode's
 * tree stays on screen while page mode reads the page and builds its editor (`ModeSwap`), and the
 * block at the top of the screen holds still as page mode opens (`page-mode-switch.ts`). Every
 * animation frame of each switch is sampled: the page is on screen in all of them, nothing shifts
 * layout, and on the way to page mode that block moves by less than a pixel.
 */

import type { Page } from '@playwright/test'

import { expect, ipc, test, waitForBoot } from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const TITLE = 'Seamless switch'

/** Mixed shapes, long enough to scroll: headings, tasks, nested rows, a long paragraph. */
function rows(): [depth: number, text: string][] {
  const out: [number, string][] = []
  for (let i = 0; i < 36; i++) {
    const shape = i % 6
    if (shape === 0) out.push([0, `## Heading ${i}`])
    else if (shape === 1) out.push([0, `TODO task ${i}`])
    else if (shape === 2) out.push([1, `nested child ${i}`])
    else if (shape === 3) out.push([0, `Long paragraph ${i} `.repeat(14).trim()])
    else out.push([0, `plain ${i}`])
  }
  return out
}

async function seedPage(page: Page): Promise<string[]> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: TITLE,
    spaceId: SCOPE.space_id,
  })
  const ids: string[] = []
  const atDepth: string[] = [pageId]
  for (const [depth, content] of rows()) {
    const row = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: atDepth[depth],
      index: null,
      scope: SCOPE,
    })
    atDepth[depth + 1] = row.id
    ids.push(row.id)
  }
  return ids
}

interface Frame {
  /** Where block `id`'s row starts in the viewport, as drawn on screen; null when not drawn. */
  top: number | null
  /** Rows of the page drawn on screen. */
  drawn: number
  /** Whether block mode's tree is held on screen over page mode as it opens. */
  held: boolean
  /** Where what follows the page's blocks starts. */
  below: number | null
}

/** Sample every animation frame until `stopSampling`, and sum the layout shifts meanwhile. */
async function startSampling(page: Page, id: string): Promise<void> {
  await page.evaluate((blockId) => {
    const w = window as unknown as { __frames: Frame[]; __shift: number; __stop: boolean }
    w.__frames = []
    w.__shift = 0
    w.__stop = false
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number
        hadRecentInput: boolean
      })[])
        if (!entry.hadRecentInput) w.__shift += entry.value
    })
    observer.observe({ type: 'layout-shift' })
    const shown = (el: Element): boolean => {
      const box = el.getBoundingClientRect()
      return (
        box.height > 0 &&
        box.bottom > 0 &&
        box.top < innerHeight &&
        getComputedStyle(el).visibility === 'visible' &&
        el.closest('[data-testid="mode-swap-incoming"]') === null
      )
    }
    const sample = (): void => {
      const all = [...document.querySelectorAll('[data-page-block-id], li[data-block-id]')]
      const drawn = all.filter(shown)
      const mine = drawn.find(
        (row) =>
          (row.getAttribute('data-page-block-id') ?? row.getAttribute('data-block-id')) === blockId,
      )
      const swap = document.querySelector('[data-testid="mode-swap"]')
      w.__frames.push({
        top: mine?.getBoundingClientRect().top ?? null,
        drawn: drawn.length,
        held: document.querySelector('[data-testid="mode-swap-outgoing"]') !== null,
        below: swap?.nextElementSibling?.getBoundingClientRect().top ?? null,
      })
      if (w.__stop) observer.disconnect()
      else requestAnimationFrame(sample)
    }
    // The first sample at once: the page as it was before the switch.
    sample()
  }, id)
}

async function stopSampling(page: Page): Promise<{ frames: Frame[]; shift: number }> {
  return page.evaluate(async () => {
    const w = window as unknown as { __frames: Frame[]; __shift: number; __stop: boolean }
    w.__stop = true
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    return { frames: w.__frames, shift: w.__shift }
  })
}

/** Through the switch the page stays drawn and, if `still`, the block at the top where it was. */
function expectSeamless(
  { frames, shift }: { frames: Frame[]; shift: number },
  still: boolean,
): void {
  expect(frames.length).toBeGreaterThan(1)
  expect(frames.filter((f) => f.drawn === 0)).toEqual([])
  expect(shift).toBe(0)
  // While the tree is held, what follows it stays put: page mode opening under it does not move it.
  const held = frames.filter((f) => f.held)
  expect(held.filter((f) => f.below === null || f.below !== held[0]?.below)).toEqual([])
  if (!still) return
  const top = frames[0]?.top ?? null
  expect(top).not.toBeNull()
  const drift = Math.max(
    ...frames.map((f) => (f.top === null ? Infinity : Math.abs(f.top - (top as number)))),
  )
  expect(drift).toBeLessThan(1)
}

test.describe('switching modes is seamless (#5691) @editor @pages', () => {
  test('a switch both ways keeps the page drawn, and page mode opens with the block at the top still', async ({
    page,
  }) => {
    await waitForBoot(page)
    const ids = await seedPage(page)
    await page.keyboard.press('Control+k')
    await page.locator('[cmdk-input]').first().fill(TITLE)
    await page.locator('[cmdk-item]').filter({ hasText: TITLE }).first().waitFor()
    await page.keyboard.press('Enter')
    await expect(page.locator('[aria-label="Page title"]')).toHaveText(TITLE)

    // Scrolled partway down, editing a block in the middle of the screen.
    const id = ids[16] as string
    const row = page.locator(`li[data-block-id="${id}"]`)
    await row.scrollIntoViewIfNeeded()
    await page.evaluate(() => {
      const scroller = document.getElementById('main-content') as HTMLElement
      scroller.scrollTop += 120
    })
    await row.click()
    await expect(row.locator('.ProseMirror')).toBeFocused()
    // The block at the top of the screen.
    const topId = await page.evaluate(() => {
      const at = (document.getElementById('main-content') as HTMLElement).getBoundingClientRect()
        .top
      const first = [...document.querySelectorAll('li[data-block-id]')].find(
        (el) => el.getBoundingClientRect().bottom > at,
      )
      return first?.getAttribute('data-block-id') as string
    })

    await startSampling(page, topId)
    await page.keyboard.press('Control+e')
    const editor = page.getByTestId('page-mode-editor')
    await expect(editor).toBeFocused()
    await expect(page.getByTestId('mode-swap-outgoing')).toHaveCount(0)
    expectSeamless(await stopSampling(page), true)

    await startSampling(page, topId)
    await page.keyboard.press('Control+e')
    await expect(row.locator('.ProseMirror')).toBeFocused()
    // Block mode's tree puts the place back once it has read the page and measured its rows, a
    // few frames on (`page-mode.spec.ts` pins where): drawn all the way, not still all the way.
    expectSeamless(await stopSampling(page), false)
  })
})
