/**
 * E2E coverage for the path-style `<Breadcrumb>` primitive (FEAT-13).
 *
 * Two consumer surfaces use the primitive — both must keep working through
 * the FEAT-13 visual redesign (text-link styling, `aria-current="page"` on
 * the final crumb):
 *
 * 1. **`BlockZoomBar`** — the zoom trail (`Home › Ancestor › … › Current`)
 *    that appears above the editor when a block is zoomed via the context
 *    menu's "Zoom in" action. We build a 3-deep nested block hierarchy out
 *    of the seeded "Getting Started" page (using the documented
 *    `Ctrl+Shift+ArrowRight` indent shortcut), zoom into the leaf, and
 *    assert: (a) the breadcrumb `<nav>` renders with Home + 3 ancestor
 *    crumbs (4 visible crumbs total — Home is the leading icon), (b) the
 *    final crumb carries `aria-current="page"` per FEAT-13, (c) clicking
 *    an intermediate `[data-zoom-crumb]` element navigates the zoom level
 *    to that ancestor (the new active crumb's id matches the clicked
 *    ancestor's block id).
 *
 * 2. **`PageHeader` namespace breadcrumb** — appears below the page title
 *    when the title contains `/` (e.g. `Work/Project/Page A`). We create
 *    such a page through the Pages-view "New page" input, open it, assert
 *    the breadcrumb has the expected segments, and click an intermediate
 *    segment to verify the namespace-navigation handler fires (the page
 *    view returns to the Pages list, since the click hooks
 *    `useNavigationStore.setView('pages')`).
 *
 * Selectors:
 *   - `[data-zoom-crumb]`        — every crumb in the BlockZoomBar trail
 *                                   (preserved from UX-215 by the primitive)
 *   - `[data-breadcrumb-crumb]`  — every crumb across both surfaces
 *   - `[aria-current="page"]`    — final crumb, FEAT-13 ARIA value
 *
 * Pre-FEAT-13 the breadcrumb had no e2e coverage at all
 * (`grep -ri "breadcrumb\|zoom-crumb\|data-breadcrumb" e2e/` returned empty);
 * this spec is the first.
 */

import { expect, focusBlockById, openPage, test, waitForBoot } from './helpers'

test.describe('Breadcrumb navigation — BlockZoomBar zoom trail (FEAT-13)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('zoom into a deeply-nested block renders Home + ancestor crumbs', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // The seeded "Getting Started" page has 5 sibling content blocks
    // (GS_1…GS_5), all at depth 1. Build a 3-deep hierarchy by indenting
    // GS_3 under GS_2, then GS_4 twice so it lands as a grandchild.
    //
    // Ctrl+Shift+ArrowRight is the documented indent shortcut
    // (`src/editor/use-block-keyboard.ts:152`). Each press makes the
    // focused block a child of its preceding sibling.

    const blocks = page.locator('[data-testid="sortable-block"]')

    // Capture every block's id up-front. `[data-testid="sortable-block"]`
    // wrappers always render regardless of focus state (the inner
    // EditableBlock toggles between StaticBlock and the roving editor),
    // so this list is stable through the indent sequence below — unlike
    // `[data-testid="block-static"]`-by-nth, which shifts when one
    // block is in editor mode.
    const blockIds = await blocks.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-block-id') ?? ''),
    )
    expect(blockIds).toHaveLength(5)
    const [, , gs3Id, gs4Id] = blockIds

    // Step 1: indent GS_3 once → child of GS_2.
    //
    // `focusBlock(page, 2)` would also work for the first focus call
    // (no other block is focused yet), but we use the explicit
    // block-id selector throughout the test so the second focus
    // (`focusBlock(page, …)` after another block is focused) doesn't
    // hit the static-block index-shift case.
    await focusBlockById(page, gs3Id ?? '')
    await page.keyboard.press('Control+Shift+ArrowRight')
    // Wait for indentation to apply (paddingLeft increases on the indented
    // block). Use the same polling style as keyboard-shortcuts.spec.ts.
    await expect
      .poll(async () =>
        Number.parseInt(
          await blocks.nth(2).evaluate((el) => window.getComputedStyle(el).paddingLeft),
          10,
        ),
      )
      .toBeGreaterThan(0)

    // Step 2: indent GS_4 twice → first to depth 2 (under GS_2 alongside
    // GS_3), then to depth 3 (under GS_3, the leaf). Switching focus
    // from GS_3 to GS_4 has to go via Escape first: clicking a
    // block-static while another block holds the roving editor fires
    // the previous editor's blur AND the new block's focus in the same
    // pointer-down/click pair, and the order in which `setFocused(null)`
    // (from blur) vs. `mount(newId)` (from focus) settle is not
    // race-stable — Escape lets us drain the blur path deterministically
    // before clicking the new target.
    await page.keyboard.press('Escape')
    await focusBlockById(page, gs4Id ?? '')
    await page.keyboard.press('Control+Shift+ArrowRight')
    await page.keyboard.press('Control+Shift+ArrowRight')

    // Confirm GS_4 is now strictly more indented than GS_3 (the depth-2
    // sibling). Both have non-zero paddingLeft; GS_4's must exceed GS_3's.
    await expect
      .poll(async () => {
        const gs3 = Number.parseInt(
          await blocks.nth(2).evaluate((el) => window.getComputedStyle(el).paddingLeft),
          10,
        )
        const gs4 = Number.parseInt(
          await blocks.nth(3).evaluate((el) => window.getComputedStyle(el).paddingLeft),
          10,
        )
        return gs4 - gs3
      })
      .toBeGreaterThan(0)

    // Capture GS_3's block id — the deepest non-leaf in our hierarchy,
    // which is what we zoom into. We deliberately zoom into GS_3 rather
    // than GS_4 (the actual leaf) because `SortableBlockWrapper`
    // suppresses the "Zoom in" context-menu entry on blocks with no
    // children (`onZoomIn={hasChildren ? onZoomIn : undefined}`); zoom
    // is a children-scoping operation, so leaves are not zoomable. The
    // breadcrumb-trail behaviour the test exercises (Home + every
    // ancestor + the zoomed block as the active crumb) is identical
    // whether the leaf or its parent is the zoom target.
    const leafBlock = blocks.nth(2)
    const leafId = await leafBlock.getAttribute('data-block-id')
    expect(leafId).toBe(gs3Id)

    // Blur the editor before right-clicking so the BlockContextMenu's
    // own contextmenu handler wins over any in-editor context handler
    // — without this the right-click can land on the still-focused
    // ProseMirror surface, which suppresses the BlockContextMenu and
    // leaves our `[role="menu"]` lookup to time out.
    await page.keyboard.press('Escape')

    // Right-click the zoom target and choose "Zoom in" from the
    // context menu.
    await leafBlock.click({ button: 'right' })
    const menu = page.locator('[role="menu"]')
    await expect(menu).toBeVisible()
    await menu.locator('[role="menuitem"]', { hasText: 'Zoom in' }).click()

    // BlockZoomBar should now be visible with the breadcrumb trail.
    const breadcrumbNav = page.getByRole('navigation', { name: /zoom breadcrumbs/i })
    await expect(breadcrumbNav).toBeVisible()

    // Trail walks GS_3 → GS_2 (GS_2's parent is the page itself, which
    // is not in the per-page block list, so the loop stops there).
    // BlockZoomBar prepends the Home icon, so the visible trail has
    // 3 `[data-zoom-crumb]` elements: Home + 2 ancestor crumbs.
    const crumbs = breadcrumbNav.locator('[data-zoom-crumb]')
    await expect(crumbs).toHaveCount(3)

    // The final crumb is the active one — it must be a span with
    // aria-current="page" (FEAT-13 visual smoke check).
    const activeCrumb = breadcrumbNav.locator('[aria-current="page"]')
    await expect(activeCrumb).toBeVisible()
    await expect(activeCrumb).toHaveAttribute('data-zoom-crumb', leafId ?? '')

    // The active crumb is rendered as a <span>, not a <button>.
    const activeTag = await activeCrumb.evaluate((el) => el.tagName.toLowerCase())
    expect(activeTag).toBe('span')

    // Click an intermediate ancestor (one level up from the zoom target —
    // the crumb at index 1 in the visible trail: Home, [GS_2], [GS_3 active]).
    const ancestorCrumb = crumbs.nth(1) // GS_2
    const ancestorId = await ancestorCrumb.getAttribute('data-zoom-crumb')
    expect(ancestorId).toBeTruthy()
    await ancestorCrumb.click()

    // After click, the zoom level moves to the ancestor — its crumb is
    // now the active one (`aria-current="page"`).
    await expect(breadcrumbNav.locator('[aria-current="page"]')).toHaveAttribute(
      'data-zoom-crumb',
      ancestorId ?? '',
    )
  })
})

test.describe('Breadcrumb navigation — PageHeader namespace path (FEAT-13)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('namespaced page renders crumbs and clicking one navigates to Pages', async ({ page }) => {
    // Create a page with a `/`-separated title via the Pages-view "New page"
    // input (the same flow used by editor-lifecycle.spec.ts).
    await page.getByRole('button', { name: 'Pages', exact: true }).click()
    await expect(page.locator('header').getByText('Pages')).toBeVisible()

    const newPageInput = page.getByPlaceholder('New page name...')
    await newPageInput.fill('Work/Project/Page A')
    await newPageInput.press('Enter')

    // Open the new page from the list.
    await page.getByText('Work/Project/Page A', { exact: true }).click()
    await expect(page.locator('[aria-label="Page title"]')).toBeVisible()

    // PageHeader namespace breadcrumb: title has 3 `/`-separated segments,
    // so the trail has 3 crumbs (no Home — `PageHeader` does not render one).
    const breadcrumbNav = page.getByRole('navigation', { name: /page breadcrumb/i })
    await expect(breadcrumbNav).toBeVisible()

    const crumbs = breadcrumbNav.locator('[data-breadcrumb-crumb]')
    await expect(crumbs).toHaveCount(3)

    // Final crumb is `Page A`, active with aria-current="page".
    const activeCrumb = breadcrumbNav.locator('[aria-current="page"]')
    await expect(activeCrumb).toBeVisible()
    await expect(activeCrumb).toHaveText('Page A')
    const activeTag = await activeCrumb.evaluate((el) => el.tagName.toLowerCase())
    expect(activeTag).toBe('span')

    // Click the leading "Work" crumb. The PageHeader's namespace handler
    // calls `useNavigationStore.setView('pages')`, which switches the app
    // view back to the Pages list — assert that the Pages header is back.
    await breadcrumbNav.getByRole('button', { name: 'Work' }).click()
    await expect(page.locator('header').getByText('Pages')).toBeVisible()
  })
})
