/**
 * E2E — FormattingToolbar on a mobile / touch viewport (#976 f20).
 *
 * The UX audit found the FormattingToolbar had ZERO mobile e2e coverage:
 * `toolbar-and-blocks.spec.ts` is desktop-only, and the existing mobile specs
 * (`touch-gestures`, `mobile-editor`) cover block-level gestures and gutter
 * controls but never the toolbar itself. On touch the toolbar takes a distinct
 * code path — it pins to the bottom of the layout viewport (`data-pinned`,
 * `position: fixed`), which on Android ends at the soft keyboard's top
 * (`MainActivity.kt`, #6790). None of that, nor the 44 px touch floor on its
 * buttons, was verified end-to-end.
 *
 * This spec drives an iPhone-13 viewport with touch enabled and asserts:
 *   1. the toolbar appears (pinned) when a block is focused;
 *   2. every visible toolbar button meets the 44 px coarse-pointer hit floor;
 *   3. the overflow ("More") menu opens/closes on tap and its items also meet
 *      the touch floor;
 *   4. the pinned toolbar rests on the soft keyboard when the viewport shrinks
 *      for it (keyboard shown) and on the screen's foot when it grows back;
 *   5. a popover opened from that bar with the keyboard up is fully on screen
 *      AND usable (#4313): on a phone, a bottom sheet resting on the keyboard.
 */

import { devices } from '@playwright/test'

import { activeSheet, expect, focusBlock, test, waitForBoot } from './helpers'

const iPhone13 = devices['iPhone 13']

// The product enforces a 44 px minimum touch target on coarse pointers
// (`coarse:size-(--touch-target)` in button.tsx + the toolbar
// shared primitives). Allow a 1 px slack for sub-pixel layout rounding.
const TOUCH_FLOOR = 44
const SLACK = 1
// The soft keyboard the viewport shrinks by.
const KEYBOARD = 300

test.describe('FormattingToolbar (iPhone 13 viewport) @editor @mobile', () => {
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
    // `MoreHorizontal` overflow menu, a bottom sheet whose overlay hides the bar
    // from the accessibility tree while it is open.
    const more = toolbar.getByRole('button', { name: 'More', includeHidden: true })
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

  test('pinned toolbar rests on the soft keyboard as the viewport shrinks for it', async ({
    page,
  }) => {
    await focusBlock(page, 0)

    const toolbar = page.getByTestId('formatting-toolbar')
    await expect(toolbar).toBeVisible()
    await expect(toolbar).toHaveAttribute('data-pinned', 'true')
    const barBottom = async () => {
      const b = await toolbar.boundingBox()
      return b === null ? null : Math.round(b.y + b.height)
    }
    const { width, height } = iPhone13.viewport

    // Playwright has no on-screen keyboard: on Android the webview ends at its
    // top, so the keyboard showing is the viewport shrinking by its height.
    await expect.poll(barBottom).toBe(height)
    await page.setViewportSize({ width, height: height - KEYBOARD })
    await expect.poll(barBottom).toBe(height - KEYBOARD)
    await page.setViewportSize({ width, height })
    await expect.poll(barBottom).toBe(height)
  })

  /**
   * Regression (#4313) — a toolbar popover opened with the IME up must be both
   * fully visible AND usable.
   *
   * Turn into's Code-block disclosure expands the language list in place. Anchored
   * to the pinned toolbar, which sits at the top edge of the keyboard, the menu
   * once grew past the top of the screen with its upper third clipped away. On
   * a phone it is a bottom sheet (#7040): it rests on the keyboard, stays on
   * screen, and scrolls to its last row. The anchored cap is pinned on desktop
   * by `toolbar-and-blocks.spec.ts`.
   *
   * The keyboard is raised BEFORE the menu opens — that is the real sequence
   * (the user is typing, the IME is up, then they tap the toolbar).
   */
  test('a toolbar popover opened with the keyboard up is fully visible and usable', async ({
    page,
  }) => {
    await focusBlock(page, 0)

    const toolbar = page.getByTestId('formatting-toolbar')
    await expect(toolbar).toBeVisible()

    // Playwright cannot raise a real IME, so simulate it as the test above
    // does: the viewport shrinks by the keyboard's height.
    const { width, height } = iPhone13.viewport
    await page.setViewportSize({ width, height: height - KEYBOARD })
    await expect
      .poll(async () => {
        const b = await toolbar.boundingBox()
        return b === null ? null : Math.round(b.y + b.height)
      })
      .toBe(height - KEYBOARD)

    await page.getByRole('button', { name: 'Turn into', exact: true }).first().click()
    // Expand the tallest disclosure — the language list is what overflowed.
    await page.getByRole('menuitem', { name: 'Code block', exact: true }).click()

    const sheet = activeSheet(page)
    await expect(sheet).toBeVisible()
    await expect(async () => {
      const r = await sheet.evaluate((el) => {
        const b = el.getBoundingClientRect()
        return { top: b.top, bottom: b.bottom, innerHeight: window.innerHeight }
      })
      expect(r.top, 'sheet top').toBeGreaterThanOrEqual(-SLACK)
      // On the keyboard, not under it.
      expect(Math.abs(r.bottom - r.innerHeight), 'sheet bottom').toBeLessThanOrEqual(SLACK)
    }).toPass({ timeout: 5000 })

    const lastRow = sheet.getByRole('button', { name: 'Plain text', exact: true })
    await lastRow.scrollIntoViewIfNeeded()
    await expect(lastRow).toBeInViewport({ ratio: 1 })
  })
})
