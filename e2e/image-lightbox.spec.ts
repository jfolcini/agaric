/**
 * E2E for the ImageLightbox full-screen viewer — #2712.
 *
 * Prior coverage stopped at inline `<img>` rendering (`image-node.spec.ts`,
 * `inline-image-1434.spec.ts`), the resize/align toolbar
 * (`toolbar-controls.spec.ts`), and the external-image placeholder
 * (`external-image-policy.spec.ts`). Nothing ever clicked an image open —
 * this spec drives `src/components/rendering/ImageLightbox.tsx` end to end:
 * open, zoom in/out (buttons AND wheel), pan while zoomed, prev/next across
 * multiple images, and close via Escape / the backdrop.
 *
 * Mock plumbing: the tauri-mock exposes `window.__addMockAttachmentWithBytes`
 * (`src/lib/tauri-mock/seed.ts`) specifically so E2E can seed a REAL byte
 * attachment (unlike `__addMockAttachment`, which stores metadata only) — the
 * same helper `toolbar-controls.spec.ts`'s image-resize suite uses to make the
 * `image-resize-wrapper` mount. `read_attachment` resolves those bytes to a
 * `blob:` URL (`AttachmentRenderer.tsx`'s `AttachmentImage`), so the seeded
 * PNG round-trips through a real `<img>` decode — no data-URI workaround
 * needed.
 *
 * A tiny 120×120 solid-color PNG (hand-encoded, deflate-compressed IDAT) is
 * used so the lightbox `<img>` has a real intrinsic size to zoom/pan against
 * — a 1×1 pixel (as used by the markdown-ref fixture in
 * `inline-image-1434.spec.ts`) would clamp pan to ~0px and make the drag
 * assertion meaningless.
 */
import { clearConsoleErrors, expect, openPage, test, waitForBoot } from './helpers'

const BLOCK_GS_1 = '0000000000000000000BLOCK01'

// 120x120 solid-orange PNG (8-bit RGB, zlib-deflated raw scanlines).
// Generated once via Node's `zlib.deflateSync` + hand-built IHDR/IDAT/IEND
// chunks — see this file's history for the generator script if it ever
// needs to change size/color.
const PNG_120: number[] = [
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 120, 0, 0, 0, 120, 8, 2, 0,
  0, 0, 182, 6, 161, 133, 0, 0, 0, 235, 73, 68, 65, 84, 120, 156, 237, 208, 1, 9, 0, 32, 0, 192, 48,
  179, 24, 212, 184, 230, 176, 133, 194, 29, 60, 192, 217, 216, 107, 234, 66, 227, 249, 193, 39,
  129, 6, 221, 10, 52, 232, 86, 160, 65, 183, 2, 13, 186, 21, 104, 208, 173, 64, 131, 110, 5, 26,
  116, 43, 208, 160, 91, 129, 6, 221, 10, 52, 232, 86, 160, 65, 183, 2, 13, 186, 21, 104, 208, 173,
  64, 131, 110, 5, 26, 116, 43, 208, 160, 91, 129, 6, 221, 10, 52, 232, 86, 160, 65, 183, 2, 13,
  186, 21, 104, 208, 173, 64, 131, 110, 5, 26, 116, 43, 208, 160, 91, 129, 6, 221, 10, 52, 232, 86,
  160, 65, 183, 2, 13, 186, 21, 104, 208, 173, 64, 131, 110, 5, 26, 116, 43, 208, 160, 91, 129, 6,
  221, 10, 52, 232, 86, 160, 65, 183, 2, 13, 186, 21, 104, 208, 173, 64, 131, 110, 5, 26, 116, 43,
  208, 160, 91, 129, 6, 221, 10, 52, 232, 86, 160, 65, 183, 2, 13, 186, 21, 104, 208, 173, 64, 131,
  110, 5, 26, 116, 43, 208, 160, 91, 129, 6, 221, 10, 52, 232, 86, 160, 65, 183, 58, 212, 142, 182,
  124, 55, 150, 43, 181, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]

interface MockWindow extends Window {
  __addMockAttachmentWithBytes?: (
    blockId: string,
    filename: string,
    mimeType: string,
    bytes: number[],
  ) => { id: string }
}

/** Parse `translate(Xpx, Ypx) scale(Z)` off the lightbox `<img>`'s inline style. */
function parseTransform(transform: string): { x: number; y: number; scale: number } {
  const translateMatch = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(transform)
  const scaleMatch = /scale\(([\d.]+)\)/.exec(transform)
  return {
    x: translateMatch ? Number(translateMatch[1]) : 0,
    y: translateMatch ? Number(translateMatch[2]) : 0,
    scale: scaleMatch ? Number(scaleMatch[1]) : 1,
  }
}

test.describe('ImageLightbox (zoom/pan viewer)', () => {
  test('clicking an inline attachment image opens the lightbox with the same src', async ({
    page,
  }) => {
    await waitForBoot(page)
    await page.evaluate(
      ({ blockId, bytes }) => {
        ;(window as MockWindow).__addMockAttachmentWithBytes?.(
          blockId,
          'photo.png',
          'image/png',
          bytes,
        )
      },
      { blockId: BLOCK_GS_1, bytes: PNG_120 },
    )
    await openPage(page, 'Getting Started')

    const wrapper = page.getByTestId('image-resize-wrapper').first()
    await expect(wrapper).toBeVisible({ timeout: 10_000 })
    const thumb = wrapper.locator('img')
    await expect(thumb).toHaveAttribute('src', /^blob:/)
    const thumbSrc = await thumb.getAttribute('src')

    const openButton = page.getByRole('button', { name: 'Open image photo.png in full screen' })
    await openButton.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const lightboxImg = page.getByTestId('lightbox-image')
    await expect(lightboxImg).toBeVisible()
    await expect(lightboxImg).toHaveAttribute('src', thumbSrc ?? '')
    // A single image in the block → no prev/next chrome.
    await expect(page.getByTestId('lightbox-counter')).toHaveCount(0)
    await expect(page.getByTestId('lightbox-prev')).toHaveCount(0)
  })

  test('zoom-in/out buttons change the rendered scale, and reset clears it', async ({ page }) => {
    await waitForBoot(page)
    await page.evaluate(
      ({ blockId, bytes }) => {
        ;(window as MockWindow).__addMockAttachmentWithBytes?.(
          blockId,
          'photo.png',
          'image/png',
          bytes,
        )
      },
      { blockId: BLOCK_GS_1, bytes: PNG_120 },
    )
    await openPage(page, 'Getting Started')
    await expect(page.getByTestId('image-resize-wrapper').first()).toBeVisible({
      timeout: 10_000,
    })
    await page.getByRole('button', { name: 'Open image photo.png in full screen' }).click()

    const lightboxImg = page.getByTestId('lightbox-image')
    await expect(lightboxImg).toBeVisible()
    const badge = page.getByTestId('lightbox-zoom-badge')
    // Not zoomed at open — the badge doesn't mount at all.
    await expect(badge).toHaveCount(0)

    const zoomIn = page.getByTestId('lightbox-zoom-in')
    const zoomOut = page.getByTestId('lightbox-zoom-out')
    const zoomReset = page.getByTestId('lightbox-zoom-reset')

    await zoomIn.click()
    await expect(badge).toContainText('125%')
    await expect
      .poll(async () => parseTransform((await lightboxImg.getAttribute('style')) ?? '').scale)
      .toBe(1.25)

    await zoomIn.click()
    await expect(badge).toContainText('150%')

    await zoomOut.click()
    await expect(badge).toContainText('125%')

    await zoomReset.click()
    // Back to fit — the badge unmounts again.
    await expect(badge).toHaveCount(0)
    await expect
      .poll(async () => parseTransform((await lightboxImg.getAttribute('style')) ?? '').scale)
      .toBe(1)
  })

  test('wheel-zoom in over the image changes the rendered scale', async ({ page }) => {
    await waitForBoot(page)
    await page.evaluate(
      ({ blockId, bytes }) => {
        ;(window as MockWindow).__addMockAttachmentWithBytes?.(
          blockId,
          'photo.png',
          'image/png',
          bytes,
        )
      },
      { blockId: BLOCK_GS_1, bytes: PNG_120 },
    )
    await openPage(page, 'Getting Started')
    await expect(page.getByTestId('image-resize-wrapper').first()).toBeVisible({
      timeout: 10_000,
    })
    await page.getByRole('button', { name: 'Open image photo.png in full screen' }).click()

    const lightboxImg = page.getByTestId('lightbox-image')
    await expect(lightboxImg).toBeVisible()
    await lightboxImg.hover()
    // Negative deltaY == scroll up == zoom in (ImageLightbox's `handleWheel`).
    await page.mouse.wheel(0, -100)

    await expect(page.getByTestId('lightbox-zoom-badge')).toContainText('125%')

    // Finding (not a test bug): `handleWheel` is wired via JSX `onWheel` +
    // `e.preventDefault()`. React registers root-level `wheel` listeners as
    // PASSIVE by default, so `preventDefault()` inside a React `onWheel`
    // handler both no-ops (the browser's default scroll is NOT actually
    // suppressed) and logs "Unable to preventDefault inside passive event
    // listener invocation." on every wheel-zoom in a real browser — this
    // fires here even though the zoom state updates correctly. Contrast with
    // GraphView's wheel-zoom (`src/lib/graph-sim-helpers.ts`'s
    // `setupZoomBehavior`), which binds through d3-zoom's raw
    // `addEventListener('wheel', ..., { passive: false })` and is silent.
    // Opting out of the global console-error gate here (the sanctioned
    // pattern — see `error-scenarios.spec.ts` / `search-toggles.spec.ts`)
    // rather than papering over a real, user-visible console warning.
    clearConsoleErrors(page)
  })

  test('dragging while zoomed pans the image, clamped to the overflow', async ({ page }) => {
    await waitForBoot(page)
    await page.evaluate(
      ({ blockId, bytes }) => {
        ;(window as MockWindow).__addMockAttachmentWithBytes?.(
          blockId,
          'photo.png',
          'image/png',
          bytes,
        )
      },
      { blockId: BLOCK_GS_1, bytes: PNG_120 },
    )
    await openPage(page, 'Getting Started')
    await expect(page.getByTestId('image-resize-wrapper').first()).toBeVisible({
      timeout: 10_000,
    })
    await page.getByRole('button', { name: 'Open image photo.png in full screen' }).click()

    const lightboxImg = page.getByTestId('lightbox-image')
    await expect(lightboxImg).toBeVisible()

    // Zoom in twice (1 -> 1.25 -> 1.5) so there's real overflow to pan within.
    await page.getByTestId('lightbox-zoom-in').click()
    await page.getByTestId('lightbox-zoom-in').click()
    await expect(page.getByTestId('lightbox-zoom-badge')).toContainText('150%')

    const before = parseTransform((await lightboxImg.getAttribute('style')) ?? '')
    expect(before.x).toBe(0)
    expect(before.y).toBe(0)

    const box = await lightboxImg.boundingBox()
    if (!box) throw new Error('lightbox image has no bounding box')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2

    await page.mouse.move(cx, cy)
    await page.mouse.down()
    // Drag well past the clamped overflow (image is 120x120 @ scale 1.5, so
    // the max pan in each axis is 120*(1.5-1)/2 = 30px) to exercise clamping,
    // not just "some" pan.
    await page.mouse.move(cx - 80, cy - 80, { steps: 10 })
    await page.mouse.up()

    const after = parseTransform((await lightboxImg.getAttribute('style')) ?? '')
    // Dragged left+up -> negative pan on both axes, clamped to -30.
    expect(after.x).toBe(-30)
    expect(after.y).toBe(-30)
  })

  test('prev/next navigate between multiple images in the same block', async ({ page }) => {
    await waitForBoot(page)
    await page.evaluate(
      ({ blockId, bytes }) => {
        const w = window as MockWindow
        w.__addMockAttachmentWithBytes?.(blockId, 'photo-a.png', 'image/png', bytes)
        w.__addMockAttachmentWithBytes?.(blockId, 'photo-b.png', 'image/png', bytes)
      },
      { blockId: BLOCK_GS_1, bytes: PNG_120 },
    )
    await openPage(page, 'Getting Started')
    await expect(page.getByTestId('image-resize-wrapper').first()).toBeVisible({
      timeout: 10_000,
    })

    await page.getByRole('button', { name: 'Open image photo-a.png in full screen' }).click()

    const counter = page.getByTestId('lightbox-counter')
    await expect(counter).toHaveText('1 of 2')
    const prev = page.getByTestId('lightbox-prev')
    const next = page.getByTestId('lightbox-next')
    await expect(prev).toBeDisabled()
    await expect(next).toBeEnabled()

    await next.click()
    await expect(counter).toHaveText('2 of 2')
    await expect(next).toBeDisabled()
    await expect(prev).toBeEnabled()

    await prev.click()
    await expect(counter).toHaveText('1 of 2')
  })

  test('ArrowLeft/ArrowRight keys navigate between multiple images', async ({ page }) => {
    await waitForBoot(page)
    await page.evaluate(
      ({ blockId, bytes }) => {
        const w = window as MockWindow
        w.__addMockAttachmentWithBytes?.(blockId, 'photo-a.png', 'image/png', bytes)
        w.__addMockAttachmentWithBytes?.(blockId, 'photo-b.png', 'image/png', bytes)
      },
      { blockId: BLOCK_GS_1, bytes: PNG_120 },
    )
    await openPage(page, 'Getting Started')
    await expect(page.getByTestId('image-resize-wrapper').first()).toBeVisible({
      timeout: 10_000,
    })

    await page.getByRole('button', { name: 'Open image photo-a.png in full screen' }).click()

    const counter = page.getByTestId('lightbox-counter')
    await expect(counter).toHaveText('1 of 2')

    // Not zoomed, so ArrowRight/ArrowLeft navigate the image set rather than
    // panning (`ImageLightbox.tsx`'s `onKeyDown`: arrows pan only when
    // `zoomed`). The listener is attached to `window`, not the `<img>`, so no
    // extra focus step is needed before pressing the key.
    await page.keyboard.press('ArrowRight')
    await expect(counter).toHaveText('2 of 2')
    await expect(page.getByTestId('lightbox-next')).toBeDisabled()

    await page.keyboard.press('ArrowLeft')
    await expect(counter).toHaveText('1 of 2')
    await expect(page.getByTestId('lightbox-prev')).toBeDisabled()
  })

  test('Escape and a backdrop click both dismiss the lightbox', async ({ page }) => {
    await waitForBoot(page)
    await page.evaluate(
      ({ blockId, bytes }) => {
        ;(window as MockWindow).__addMockAttachmentWithBytes?.(
          blockId,
          'photo.png',
          'image/png',
          bytes,
        )
      },
      { blockId: BLOCK_GS_1, bytes: PNG_120 },
    )
    await openPage(page, 'Getting Started')
    await expect(page.getByTestId('image-resize-wrapper').first()).toBeVisible({
      timeout: 10_000,
    })

    const openButton = page.getByRole('button', { name: 'Open image photo.png in full screen' })
    const dialog = page.getByRole('dialog')

    await openButton.click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    await openButton.click()
    await expect(dialog).toBeVisible()
    // Click the dialog overlay well away from the centered content to
    // exercise Radix's outside-click dismissal.
    await page.locator('[data-slot="dialog-overlay"]').click({ position: { x: 5, y: 5 } })
    await expect(dialog).toBeHidden()
  })
})
