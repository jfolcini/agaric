/**
 * E2E — FormattingToolbar on a mobile / touch viewport (#976 f20).
 *
 * The UX audit found the FormattingToolbar had ZERO mobile e2e coverage:
 * `toolbar-and-blocks.spec.ts` is desktop-only, and the existing mobile specs
 * (`touch-gestures`, `mobile-editor`) cover block-level gestures and gutter
 * controls but never the toolbar itself. On touch the toolbar takes a distinct
 * code path — it pins to the bottom of the layout viewport (`data-pinned`,
 * `position: fixed`) and lifts above the soft keyboard via `visualViewport`
 * listeners (`FormattingToolbar.tsx` `computeKeyboardInset`). None of that, nor
 * the 44 px touch floor on its buttons, was verified end-to-end.
 *
 * This spec drives an iPhone-13 viewport with touch enabled and asserts:
 *   1. the toolbar appears (pinned) when a block is focused;
 *   2. every visible toolbar button meets the 44 px coarse-pointer hit floor;
 *   3. the overflow ("More") menu opens/closes on tap and its items also meet
 *      the touch floor;
 *   4. the pinned toolbar's bottom inset tracks the soft-keyboard height when
 *      `visualViewport` reports the viewport shrinking (keyboard shown) and
 *      resets when it grows back (keyboard hidden);
 *   5. a popover opened from that bar with the keyboard up is fully on screen
 *      AND still tall enough to use (#4313).
 */

import { devices } from '@playwright/test'

import { expect, focusBlock, test, waitForBoot } from './helpers'

const iPhone13 = devices['iPhone 13']

// The product enforces a 44 px minimum touch target on coarse pointers
// (`[@media(pointer:coarse)]:size-11` / `min-h-11` in button.tsx + the toolbar
// shared primitives). Allow a 1 px slack for sub-pixel layout rounding.
const TOUCH_FLOOR = 44
const SLACK = 1

test.describe('FormattingToolbar (iPhone 13 viewport)', () => {
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test.beforeEach(async ({ page }) => {
    // Drive the default boot (Journal) view, whose seeded day already has
    // editable blocks — same reliable mobile entry point as
    // `mobile-editor.spec.ts`. (The cross-page `openPageMobile` palette flow is
    // avoided here: it adds a flaky multi-step navigation that this spec, which
    // only needs *a* focused block, does not require.)
    await waitForBoot(page)
    await expect(page.locator('[data-testid="block-static"]').first()).toBeVisible()
  })

  test('toolbar appears pinned to the bottom when a block is focused', async ({ page }) => {
    await focusBlock(page, 0)

    const toolbar = page.getByTestId('formatting-toolbar')
    await expect(toolbar).toBeVisible()
    // The touch code path pins the bar; desktop does not set this attribute.
    await expect(toolbar).toHaveAttribute('data-pinned', 'true')
  })

  test('every visible toolbar button meets the 44px touch floor', async ({ page }) => {
    await focusBlock(page, 0)

    const toolbar = page.getByTestId('formatting-toolbar')
    await expect(toolbar).toBeVisible()

    // Real (accessible) buttons only — the off-screen measurement sentinel is
    // `aria-hidden`, so role-based queries already exclude its duplicates.
    const buttons = toolbar.getByRole('button')
    await expect(buttons.first()).toBeVisible()

    // The mobile toolbar runs a ResizeObserver-driven overflow pass on mount
    // that briefly reflows button sizes (and moves low-priority buttons into the
    // "More" popover), so a measurement caught mid-reflow can observe a transient
    // sub-floor button or a changing button count. Retry the whole single-pass
    // measurement until it settles (no arbitrary sleep) so the floor assertion is
    // deterministic. Single DOM pass per attempt (see overflow test) — avoids
    // per-locator actionability waits that can hang on a disabled (Undo/Redo)
    // button.
    await expect(async () => {
      const boxes = await buttons.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect()
          return { w: r.width, h: r.height }
        }),
      )
      expect(boxes.length).toBeGreaterThan(0)
      boxes.forEach((b, i) => {
        expect(b.h, `toolbar button ${i} height`).toBeGreaterThanOrEqual(TOUCH_FLOOR - SLACK)
        expect(b.w, `toolbar button ${i} width`).toBeGreaterThanOrEqual(TOUCH_FLOOR - SLACK)
      })
    }).toPass({ timeout: 5000 })
  })

  test('overflow menu opens/closes on tap and its items meet the touch floor', async ({ page }) => {
    await focusBlock(page, 0)

    const toolbar = page.getByTestId('formatting-toolbar')
    await expect(toolbar).toBeVisible()

    // The narrow iPhone width collapses lower-priority buttons into the
    // `MoreHorizontal` overflow popover.
    const more = toolbar.getByRole('button', { name: 'More' })
    await expect(more).toBeVisible()
    await expect(more).toHaveAttribute('aria-expanded', 'false')

    await more.tap()
    await expect(more).toHaveAttribute('aria-expanded', 'true')

    const menu = page.getByTestId('toolbar-overflow-menu')
    await expect(menu).toBeVisible()

    const items = menu.getByRole('button')
    const itemCount = await items.count()
    expect(itemCount).toBeGreaterThan(0)
    // Poll the SMALLEST item height until it settles at/above the floor — the
    // Radix popover plays a brief open animation, so an immediate read can
    // catch a frame mid-scale. `getBoundingClientRect` (one DOM pass) avoids
    // the per-locator actionability wait that can hang on a disabled item.
    await expect
      .poll(async () =>
        items.evaluateAll((els) => Math.min(...els.map((el) => el.getBoundingClientRect().height))),
      )
      .toBeGreaterThanOrEqual(TOUCH_FLOOR - SLACK)

    // Dismiss via Escape (Radix popover). Re-tapping the trigger is unreliable
    // on the pinned mobile bar — the open popover content overlays the trigger
    // and intercepts the pointer event.
    await page.keyboard.press('Escape')
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await expect(menu).toHaveCount(0)
  })

  test('pinned toolbar bottom inset tracks the soft-keyboard height via visualViewport', async ({
    page,
  }) => {
    await focusBlock(page, 0)

    const toolbar = page.getByTestId('formatting-toolbar')
    await expect(toolbar).toBeVisible()
    await expect(toolbar).toHaveAttribute('data-pinned', 'true')

    // With no keyboard up the bar rests at the viewport bottom (inset 0).
    await expect.poll(async () => toolbar.evaluate((el) => el.style.bottom)).toBe('0px')

    // Playwright does not emulate the on-screen keyboard, so simulate it:
    // shrink `window.visualViewport.height` (which excludes the keyboard) and
    // fire the `resize` event the toolbar listens for. The effect recomputes
    // `innerHeight - (vv.height + vv.offsetTop)` and pushes the bar up by that
    // keyboard height.
    const KEYBOARD = 300
    await page.evaluate((kbd) => {
      const vv = window.visualViewport
      if (!vv) throw new Error('visualViewport unavailable in test env')
      Object.defineProperty(vv, 'height', {
        configurable: true,
        get: () => window.innerHeight - kbd,
      })
      Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 })
      vv.dispatchEvent(new Event('resize'))
    }, KEYBOARD)

    await expect
      .poll(async () => toolbar.evaluate((el) => Number.parseInt(el.style.bottom || '0', 10)))
      .toBe(KEYBOARD)

    // Hiding the keyboard (viewport grows back) resets the inset to 0.
    await page.evaluate(() => {
      const vv = window.visualViewport
      if (!vv) return
      Object.defineProperty(vv, 'height', { configurable: true, get: () => window.innerHeight })
      vv.dispatchEvent(new Event('resize'))
    })

    await expect.poll(async () => toolbar.evaluate((el) => el.style.bottom)).toBe('0px')
  })

  /**
   * Regression (#4313) — a toolbar popover opened with the IME up must be both
   * fully visible AND usable.
   *
   * The Turn-into menu anchors to the pinned toolbar, which sits at the top edge
   * of the keyboard, and its Code-block disclosure expands ~19 more rows in
   * place. The old cap was `max-h-[calc(100dvh-4rem)]`, and `dvh` does NOT
   * shrink for the IME on Android (edge-to-edge / targetSdk 36 leaves the LAYOUT
   * viewport at full height), so the menu was capped against a screen a third of
   * which was keyboard. Measured on a Pixel 8: it grew past the top of the
   * screen and its upper third was clipped away, unreachable — scrolling could
   * not recover those rows because the container itself was off-screen.
   *
   * The cap is now `--radix-popover-content-available-height`, which floating-ui
   * derives from `window.visualViewport` (its default `rootBoundary: 'viewport'`
   * → `getViewportRect`), i.e. from a boundary that ALREADY excludes the
   * keyboard.
   *
   * Two failure modes, two assertions:
   *   - too tall  → the popover runs off the top / under the keyboard (the
   *     original bug);
   *   - too short → the keyboard subtracted twice (once by the boundary, once
   *     as bottom `collisionPadding`) collapses the cap to ~one row, which is
   *     just as unusable. Hence the MIN_USABLE_POPOVER_HEIGHT floor.
   *
   * The keyboard is raised BEFORE the popover opens — that is the real sequence
   * (the user is typing, the IME is up, then they tap the toolbar) and it makes
   * the assertion independent of whether anything re-runs the popper on a
   * `visualViewport` resize.
   */
  const KEYBOARD = 300
  // A menu capped to a single row is as broken as one drawn under the keyboard.
  // Two coarse-pointer rows (44 px each, see TOUCH_FLOOR) plus the content's
  // `p-4` (16 px top + bottom) is the smallest thing worth calling a menu.
  // Measured on this viewport: 311 px as it stands; 56 px when the keyboard was
  // also passed as bottom `collisionPadding` (664 − 300 clipping band, minus
  // 4 px top and 4 + 300 px bottom padding). The floor sits between the two.
  const MIN_USABLE_POPOVER_HEIGHT = 2 * TOUCH_FLOOR + 32

  test('a toolbar popover opened with the keyboard up is fully visible and usable', async ({
    page,
  }) => {
    await focusBlock(page, 0)

    const toolbar = page.getByTestId('formatting-toolbar')
    await expect(toolbar).toBeVisible()

    // Playwright cannot raise a real IME, so simulate it exactly as the test
    // above does: shrink the visual viewport (the layout viewport, and hence
    // `innerHeight`/`dvh`, deliberately stay at full height — that asymmetry IS
    // the bug) and fire the `resize` the app listens for.
    await page.evaluate((kbd) => {
      const vv = window.visualViewport
      if (!vv) throw new Error('visualViewport unavailable in test env')
      Object.defineProperty(vv, 'height', {
        configurable: true,
        get: () => window.innerHeight - kbd,
      })
      Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 })
      vv.dispatchEvent(new Event('resize'))
    }, KEYBOARD)

    // The bar has lifted above the "keyboard": the popover's anchor is now at
    // the very top edge of it, which is the geometry that produced the bug.
    await expect
      .poll(async () => toolbar.evaluate((el) => Number.parseInt(el.style.bottom || '0', 10)))
      .toBe(KEYBOARD)

    await page.getByRole('button', { name: 'Turn into', exact: true }).first().click()
    // Expand the tallest disclosure — the language list is what overflowed.
    await page.getByRole('menuitem', { name: 'Code block', exact: true }).click()

    const popover = page.locator('[data-slot="popover-content"]').first()
    await expect(popover).toBeVisible()

    // Single DOM pass per attempt, retried until the open animation settles.
    await expect(async () => {
      const geometry = await popover.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, height: r.height, innerHeight: window.innerHeight }
      })
      // Not clipped off the top of the screen.
      expect(geometry.top, 'popover top').toBeGreaterThanOrEqual(-SLACK)
      // Not drawn under the keyboard.
      expect(geometry.bottom, 'popover bottom').toBeLessThanOrEqual(
        geometry.innerHeight - KEYBOARD + SLACK,
      )
      // Not collapsed to an unusable sliver by double-counting the keyboard.
      expect(geometry.height, 'popover height').toBeGreaterThanOrEqual(MIN_USABLE_POPOVER_HEIGHT)
    }).toPass({ timeout: 5000 })
  })
})
