/**
 * #5082 — under `prefers-contrast: more`, a keyboard-focused reference chip
 * read LIGHTER than an unfocused one.
 *
 * `.block-link-chip:focus-visible` (0,2,0) out-specifies the accessibility
 * block's `:focus-visible { outline: 3px solid currentColor }` (0,1,0) — a
 * media query adds no specificity — so `outline-hidden` won and focus was left
 * with nothing but a half-alpha ring, while the `.ref-chip-anchor` sitting in
 * the linked-references panel beside it wore a permanent opaque 2px outline.
 *
 * Seed (`src/lib/tauri-mock/seed.ts`): "Getting Started" carries a
 * `[[Quick Notes]]` chip in its body, and its linked-references panel renders
 * the `[[Getting Started]]` anchor chip — both on one screen, which is exactly
 * the comparison the bug is about.
 */

import { expect, openPage, test, waitForBoot } from './helpers'

const REFERENCES = '[data-testid="linked-references"]'

/**
 * The `[[Quick Notes]]` chip in the page BODY. Scoped to the block tree: the
 * references panel names its source row "Quick Notes" too.
 */
function bodyChip(page: import('@playwright/test').Page): import('@playwright/test').Locator {
  return page.getByTestId('block-tree').getByRole('link', { name: 'Quick Notes' })
}

/** The `ring-[3px]` layer of a `box-shadow`, whose spread names it. */
const RING_LAYER = /([a-z]+\([^()]*\))\s+0px 0px 0px 3px/

interface Paint {
  focusVisible: boolean
  outlineStyle: string
  outlineWidth: string
  ring: string | null
}

async function paintOf(target: import('@playwright/test').Locator): Promise<Paint> {
  return target.evaluate((el, ring) => {
    const s = getComputedStyle(el)
    const m = ring.exec(s.boxShadow)
    return {
      focusVisible: el.matches(':focus-visible'),
      outlineStyle: s.outlineStyle,
      outlineWidth: s.outlineWidth,
      ring: m?.[1] ?? null,
    }
  }, RING_LAYER)
}

/**
 * `var(--ring)` at full opacity, serialized the way `getComputedStyle` will
 * serialize it — resolved live, so the assertion pins the ring's ALPHA rather
 * than whatever colour the token happens to hold under this media query.
 */
async function opaqueRing(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--ring)'
    document.body.append(probe)
    const c = getComputedStyle(probe).color
    probe.remove()
    return c
  })
}

/** Genuine keyboard focus: `:focus-visible` is a modality, not a state. */
async function tabTo(
  page: import('@playwright/test').Page,
  target: import('@playwright/test').Locator,
): Promise<void> {
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab')
    if (await target.evaluate((el) => el === document.activeElement)) return
  }
  throw new Error('Tab never reached the chip')
}

test.describe('High-contrast focus on reference chips', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a focused chip outweighs the unfocused anchor chip beside it', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const anchor = page.locator(REFERENCES).getByTestId('block-link-chip')
    await expect(anchor).toBeVisible()
    const chip = bodyChip(page)
    await expect(chip).toBeVisible()

    await page.locator('body').click({ position: { x: 2, y: 2 } })
    await tabTo(page, chip)

    await page.emulateMedia({ contrast: 'more' })
    const focused = await paintOf(chip)
    const permanent = await paintOf(anchor)

    expect(focused.focusVisible).toBe(true)
    // The second, colour-independent cue: a box-shadow is dropped entirely
    // under `forced-colors`, so the ring alone would leave these users nothing.
    expect(focused.outlineStyle).toBe('solid')
    // Strictly heavier than the anchor chip's permanent outline, not lighter.
    expect(focused.outlineWidth).toBe('3px')
    expect(permanent.outlineWidth).toBe('2px')
    expect(permanent.ring).toBeNull()
    // …and in the ring's own hue at full strength, so focus on the ANCHOR chip
    // is more than 1px of its own `currentColor` away from no focus at all.
    expect(focused.ring).toBe(await opaqueRing(page))
  })

  test('the default-mode focus ring is untouched', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const chip = bodyChip(page)
    await expect(chip).toBeVisible()
    await page.locator('body').click({ position: { x: 2, y: 2 } })
    await tabTo(page, chip)

    const focused = await paintOf(chip)
    expect(focused.focusVisible).toBe(true)
    expect(focused.outlineStyle).toBe('none')
    // Present AND half-alpha: `not.toBe(opaque)` alone would also pass if the
    // ring had disappeared, which is the other way to lose focus here.
    expect(focused.ring).not.toBeNull()
    expect(focused.ring).not.toBe(await opaqueRing(page))
  })
})
