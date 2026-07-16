import { expect, test } from './helpers'

/**
 * E2E tests for the GraphView component (F-33).
 *
 * The tauri-mock seeds several pages with [[link]] references between them,
 * so the graph should render nodes (pages) and edges (links).
 *
 * Key selectors:
 * SVG container: `[data-testid="graph-svg"]` (role="img" was deliberately removed from the SVG; aria-label provides the accessible name without forcing AT to treat the interactive node graph as one opaque graphic)
 * - Nodes: `svg g.node` groups, each containing two `<circle>` elements
 *   (a transparent hit-area and a visible node circle)
 * - Edges: `svg line` elements
 * - Page title after navigation: `[aria-label="Page title"]`
 */

test.describe('Graph view', () => {
  // GraphView initial render legitimately goes through a d3 worker
  // Startup path that can exceed the 3s global `expect` timeout on
  // cold tests. Use `test.slow()` at the suite level instead of sprinkling
  // `{ timeout: 10_000 }` overrides on every SVG-visibility assertion.
  test.slow()

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
  })

  test('graph view renders SVG with nodes', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Graph', exact: true })
      .click()

    // Wait for the SVG to appear (loading skeleton resolves)
    await expect(page.locator('[data-testid="graph-svg"]')).toBeVisible()

    // Each node group contains circles — verify at least one node exists
    const nodes = page.locator('[data-testid="graph-view"] svg circle')
    await expect(nodes.first()).toBeVisible()
    const count = await nodes.count()
    expect(count).toBeGreaterThan(0)
  })

  test('graph view renders edges between linked pages', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Graph', exact: true })
      .click()
    await expect(page.locator('[data-testid="graph-svg"]')).toBeVisible()

    // Seed data has [[link]] references between pages (e.g. Getting Started ↔ Quick Notes),
    // so there should be <line> elements for edges.
    const edges = page.locator('[data-testid="graph-view"] svg line')
    await expect(edges.first()).toBeVisible()
    const edgeCount = await edges.count()
    expect(edgeCount).toBeGreaterThan(0)
  })

  test('clicking a node navigates to that page', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Graph', exact: true })
      .click()
    await expect(page.locator('[data-testid="graph-svg"]')).toBeVisible()

    // Target a non-date-titled page. `tabsStore.navigateToPage` routes
    // YYYY-MM-DD page titles into the Journal view, which has no
    // `aria-label="Page title"` element. The seeded daily page uses
    // today's date as its title, so `.first()` is non-deterministic in
    // that regard — pick "Getting Started" explicitly.
    const nodeGroup = page
      .locator('[data-testid="graph-view"] svg g.node')
      .filter({ hasText: 'Getting Started' })
    await expect(nodeGroup).toBeVisible()

    // Click the hit-area circle (44px target, `pointer-events: all`) rather than
    // the `<g class="node">` group. The group's bounding-box center falls on the
    // label text (drawn at `dx=10, dy=4` with `pointer-events: none`), so a
    // default-centered click there passes through to the `<svg>`. The hit-area
    // circle is centered at the node origin, so its bbox center is hittable.
    const hitArea = nodeGroup.locator('circle.hit-area')
    await hitArea.click()

    // After clicking, the app navigates to the page editor — page title should be visible
    await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
  })

  test('graph view shows the graph container with data-testid', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Graph', exact: true })
      .click()

    // The graph-view wrapper should appear once loading completes
    await expect(page.locator('[data-testid="graph-view"]')).toBeVisible()

    // SVG inside the container should have the accessible role
    const svg = page.locator('[data-testid="graph-svg"]')
    await expect(svg).toBeVisible()
  })

  test('graph view eventually renders after loading', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Graph', exact: true })
      .click()

    // The graph should eventually render — SVG becomes visible
    await expect(page.locator('[data-testid="graph-svg"]')).toBeVisible()

    // And it should contain node groups (seed data has pages)
    const nodeGroups = page.locator('[data-testid="graph-view"] svg g.node')
    await expect(nodeGroups.first()).toBeVisible()
    const count = await nodeGroups.count()
    expect(count).toBeGreaterThanOrEqual(2) // At least 2 seed pages visible as nodes
  })

  // ---------------------------------------------------------------------
  // Filter bar (#2713) — `GraphFilterBar` narrows the rendered node set.
  //
  // No "content match" filter test: there is no content/full-text dimension
  // in `GraphFilter` (`src/lib/graph-filters.ts` lines ~44-52 — only `tag` /
  // `status` / `priority` / `hasDueDate` / `hasScheduledDate` /
  // `hasBacklinks` / `excludeTemplates`) or in `GraphFilterBar.tsx` to drive.
  // docs/features/views.md previously advertised a "by content match" filter
  // that never existed; that drift was corrected (#2761) to describe the
  // real filter surface, so there is nothing left for this spec to cover.
  //
  // Seed data (`src/lib/tauri-mock/seed.ts`) has exactly one templated page,
  // "Meeting Notes Template" (`PAGE_TMPL_MEETING`, flagged via the
  // `template` block property), among the 6 canonical seed pages. It's the
  // only dimension in `src/lib/graph-filters.ts` that's satisfiable against
  // the DEFAULT seed with no `__mockFacetFixture` / `tagIds` plumbing: the
  // `tag` dimension only matches PAGE-level tags (`blockTags.get(pageId)`),
  // and the canonical seed's `work`/`personal` tags live on child blocks,
  // not the page blocks themselves — so `excludeTemplates` is the
  // deterministic, zero-extra-seed choice for exercising "the filter
  // narrows the node set" end to end.
  // ---------------------------------------------------------------------
  test('the "Exclude templates" filter removes the template page node', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Graph', exact: true })
      .click()
    await expect(page.locator('[data-testid="graph-svg"]')).toBeVisible()

    const nodeGroups = page.locator('[data-testid="graph-view"] svg g.node')
    await expect(nodeGroups.first()).toBeVisible()
    const before = await nodeGroups.count()

    const templateNode = nodeGroups.filter({ hasText: 'Meeting Notes Template' })
    await expect(templateNode).toHaveCount(1)

    await page.getByRole('button', { name: 'Add filter' }).click()
    await page.getByRole('combobox', { name: 'Select a dimension' }).click()
    await page.getByRole('option', { name: 'Exclude templates' }).click()
    await page.getByRole('button', { name: 'Apply' }).click()

    // The template page's node disappears and the total node count drops by
    // exactly one — a broken filter would either change nothing (matcher
    // bug) or over-remove (wrong predicate wiring).
    await expect(templateNode).toHaveCount(0)
    await expect.poll(() => nodeGroups.count()).toBe(before - 1)
    await expect(page.getByTestId('graph-filter-count')).toHaveText(
      `Showing ${before - 1} of ${before} pages`,
    )

    // Clearing the filter restores the template node.
    await page.getByRole('button', { name: 'Clear all' }).click()
    await expect(templateNode).toHaveCount(1)
    await expect.poll(() => nodeGroups.count()).toBe(before)
  })

  // ---------------------------------------------------------------------
  // Zoom / pan (#2713) — `useGraphZoom` (`src/lib/graph-sim-helpers.ts`)
  // wires a d3-zoom behavior to the `<svg>`; the transform it computes is
  // applied to the FIRST `<g>` child (`g.attr('transform', event.transform)`
  // in `setupZoomBehavior`). That `<g transform="...">` attribute is the
  // observable surface for both the on-screen zoom buttons and native
  // wheel/drag input.
  // ---------------------------------------------------------------------
  function parseScale(transform: string | null): number | null {
    const m = transform ? /scale\(([\d.]+)\)/.exec(transform) : null
    return m?.[1] ? Number(m[1]) : null
  }

  test('the zoom in/out/reset buttons change the graph transform scale', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Graph', exact: true })
      .click()
    await expect(page.locator('[data-testid="graph-svg"]')).toBeVisible()
    await expect(page.locator('[data-testid="graph-view"] svg g.node').first()).toBeVisible()

    const g = page.locator('[data-testid="graph-svg"] > g').first()

    await page.getByRole('button', { name: /^Zoom in/ }).click()
    // ZOOM_STEP is 1.3 (`src/lib/graph-sim-helpers.ts`); the button
    // transition takes 200ms, so poll until it settles.
    await expect.poll(async () => parseScale(await g.getAttribute('transform'))).toBe(1.3)

    await page.getByRole('button', { name: /^Zoom out/ }).click()
    await expect
      .poll(async () => {
        const scale = parseScale(await g.getAttribute('transform'))
        return scale !== null && scale < 1.3
      })
      .toBe(true)

    await page.getByRole('button', { name: /^Fit to view/ }).click()
    await expect.poll(async () => parseScale(await g.getAttribute('transform'))).toBe(1)
  })

  test('wheel-zoom over the canvas changes the graph transform scale', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Graph', exact: true })
      .click()
    const svg = page.locator('[data-testid="graph-svg"]')
    await expect(svg).toBeVisible()
    await expect(page.locator('[data-testid="graph-view"] svg g.node').first()).toBeVisible()

    const g = page.locator('[data-testid="graph-svg"] > g').first()
    await expect(g).toHaveCount(1)
    const before = await g.getAttribute('transform')

    await svg.hover()
    // Negative deltaY == scroll up == zoom in (d3-zoom's default wheel
    // handler; `setupZoomBehavior` applies no custom filter/wheelDelta).
    await page.mouse.wheel(0, -100)

    await expect.poll(() => g.getAttribute('transform')).not.toBe(before)
    const after = parseScale(await g.getAttribute('transform'))
    expect(after).not.toBeNull()
    expect(after as number).toBeGreaterThan(1)
  })

  test('dragging empty canvas pans the graph transform', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Graph', exact: true })
      .click()
    const svg = page.locator('[data-testid="graph-svg"]')
    await expect(svg).toBeVisible()
    await expect(page.locator('[data-testid="graph-view"] svg g.node').first()).toBeVisible()

    const g = page.locator('[data-testid="graph-svg"] > g').first()
    const before = await g.getAttribute('transform')

    const svgBox = await svg.boundingBox()
    if (!svgBox) throw new Error('graph svg has no bounding box')
    // Bottom-left corner: clear of the top filter bar (`absolute top-2
    // left-2 right-2`), the bottom-right zoom cluster (`absolute bottom-3
    // right-3`), and — for this small seed graph — the force-simulated
    // nodes, which settle away from the edges.
    const startX = svgBox.x + 20
    const startY = svgBox.y + svgBox.height - 20

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(startX + 6 * i, startY - 4 * i)
    }
    await page.mouse.up()

    await expect.poll(() => g.getAttribute('transform')).not.toBe(before)
    const after = await g.getAttribute('transform')
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(after ?? '')
    expect(m).not.toBeNull()
    // Dragged right+up -> positive x translate, negative y translate.
    expect(Number(m?.[1])).toBeGreaterThan(0)
    expect(Number(m?.[2])).toBeLessThan(0)
  })
})
