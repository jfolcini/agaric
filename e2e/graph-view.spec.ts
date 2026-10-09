import { expect, navigateToView, openPage, test } from './helpers'

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

/** Local YYYY-MM-DD, matching the seed's `todayDate()` journal page title. */
function localDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

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
    await navigateToView(page, 'Graph')

    // Wait for the SVG to appear (loading skeleton resolves)
    await expect(page.locator('[data-testid="graph-svg"]')).toBeVisible()

    // Each node group contains circles — verify at least one node exists
    const nodes = page.locator('[data-testid="graph-view"] svg circle')
    await expect(nodes.first()).toBeVisible()
    const count = await nodes.count()
    expect(count).toBeGreaterThan(0)
  })

  test('graph view renders edges between linked pages', async ({ page }) => {
    await navigateToView(page, 'Graph')
    await expect(page.locator('[data-testid="graph-svg"]')).toBeVisible()

    // Seed data has [[link]] references between pages (e.g. Getting Started ↔ Quick Notes),
    // so there should be <line> elements for edges.
    const edges = page.locator('[data-testid="graph-view"] svg line')
    await expect(edges.first()).toBeVisible()
    const edgeCount = await edges.count()
    expect(edgeCount).toBeGreaterThan(0)
  })

  test('clicking a node navigates to that page', async ({ page }) => {
    await navigateToView(page, 'Graph')
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
    // label text (drawn right of the node, with `pointer-events: none`), so a
    // default-centered click there passes through to the `<svg>`. The hit-area
    // circle is centered at the node origin, so its bbox center is hittable.
    const hitArea = nodeGroup.locator('circle.hit-area')
    await hitArea.click()

    // After clicking, the app navigates to the page editor — page title should be visible
    await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
  })

  // #5433 — one action from a page lands on its local graph. The seed links
  // Getting Started <-> Quick Notes and nothing else, so its neighbourhood is
  // exactly those two of the graph's pages.
  test('Show in graph on a page opens the graph on that page', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Show in graph/ }).click()

    await expect(page.locator('[data-testid="graph-svg"]')).toBeVisible()
    await expect(page.getByTestId('local-graph-toggle')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('local-graph-seed-label')).toHaveText(
      'Showing neighbors of "Getting Started"',
    )
    const nodeGroups = page.locator('[data-testid="graph-view"] svg g.node')
    await expect(nodeGroups.filter({ hasText: 'Getting Started' })).toHaveCount(1)
    await expect(nodeGroups.filter({ hasText: 'Quick Notes' })).toHaveCount(1)
    await expect(nodeGroups).toHaveCount(2)
  })

  test('graph view shows the graph container with data-testid', async ({ page }) => {
    await navigateToView(page, 'Graph')

    // The graph-view wrapper should appear once loading completes
    await expect(page.locator('[data-testid="graph-view"]')).toBeVisible()

    // SVG inside the container should have the accessible role
    const svg = page.locator('[data-testid="graph-svg"]')
    await expect(svg).toBeVisible()
  })

  test('graph view eventually renders after loading', async ({ page }) => {
    await navigateToView(page, 'Graph')

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
  // in `GraphFilter` (`src/lib/graph-filters.ts` — only `tag` /
  // `status` / `priority` / `hasDueDate` / `hasScheduledDate` /
  // `hasBacklinks` / `excludeTemplates` / `excludeJournal`) or in
  // `GraphFilterBar.tsx` to drive.
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
    await navigateToView(page, 'Graph')
    await expect(page.locator('[data-testid="graph-svg"]')).toBeVisible()

    const nodeGroups = page.locator('[data-testid="graph-view"] svg g.node')
    await expect(nodeGroups.first()).toBeVisible()
    // Drop the default journal filter (#5370) so the counts are about templates alone.
    await page.getByRole('button', { name: 'Clear all' }).click()
    await expect(nodeGroups.filter({ hasText: localDateStr(new Date()) })).toHaveCount(1)
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

  test('journal pages are filtered out by default; removing the pill persists (#5370)', async ({
    page,
  }) => {
    await navigateToView(page, 'Graph')
    await expect(page.locator('[data-testid="graph-svg"]')).toBeVisible()

    const nodeGroups = page.locator('[data-testid="graph-view"] svg g.node')
    const journalNode = nodeGroups.filter({ hasText: localDateStr(new Date()) })
    const pill = page.getByRole('group', { name: 'Exclude journal pages' })
    await expect(nodeGroups.filter({ hasText: 'Getting Started' })).toHaveCount(1)
    await expect(pill).toBeVisible()
    await expect(journalNode).toHaveCount(0)

    await page.getByRole('button', { name: 'Remove Exclude journal pages filter' }).click()
    await expect(pill).toHaveCount(0)
    await expect(journalNode).toHaveCount(1)

    await page.reload()
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
    await navigateToView(page, 'Graph')
    await expect(nodeGroups.filter({ hasText: 'Getting Started' })).toHaveCount(1)
    await expect(journalNode).toHaveCount(1)
    await expect(pill).toHaveCount(0)
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
    await navigateToView(page, 'Graph')
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
    await navigateToView(page, 'Graph')
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
    await navigateToView(page, 'Graph')
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

  // ---------------------------------------------------------------------
  // Visual encoding (#5428, #5429): edges are faint hairlines at every zoom,
  // a node's size follows its link count, and the page open in the active
  // tab carries the one accent.
  // ---------------------------------------------------------------------
  test('edges stay a 1 px hairline on screen as the view zooms in (#5428)', async ({ page }) => {
    await navigateToView(page, 'Graph')
    const edges = page.locator('[data-testid="graph-view"] svg line')
    await expect(edges.first()).toBeVisible()
    const g = page.locator('[data-testid="graph-svg"] > g').first()

    // A non-scaling stroke keeps its width on screen; any other stroke is
    // scaled by the zoom transform on its way there.
    const onScreen = () =>
      edges.evaluateAll((lines) =>
        lines.map((line) => {
          const style = getComputedStyle(line)
          const ctm = (line as SVGGraphicsElement).getScreenCTM()
          const scale = ctm ? Math.hypot(ctm.a, ctm.b) : Number.NaN
          const width = Number.parseFloat(style.strokeWidth)
          const nonScaling = style.getPropertyValue('vector-effect') === 'non-scaling-stroke'
          return { scale, width: nonScaling ? width : width * scale }
        }),
      )

    const before = await onScreen()
    for (const scale of [1.3, 1.69, 2.197]) {
      await page.getByRole('button', { name: /^Zoom in/ }).click()
      await expect
        .poll(async () => parseScale(await g.getAttribute('transform')))
        .toBeCloseTo(scale, 3)
    }
    const after = await onScreen()

    expect(before.length).toBeGreaterThan(0)
    expect(after).toHaveLength(before.length)
    expect((after[0]?.scale ?? 0) / (before[0]?.scale ?? 1)).toBeCloseTo(2.197, 2)
    expect([...before, ...after].map((edge) => edge.width)).toEqual(
      [...before, ...after].map(() => 1),
    )
  })

  test('a linked page draws a larger node than an unlinked one (#5429)', async ({ page }) => {
    await navigateToView(page, 'Graph')
    const nodeGroups = page.locator('[data-testid="graph-view"] svg g.node')
    const radius = async (title: string) =>
      Number(
        await nodeGroups
          .filter({ hasText: title })
          .locator('circle:not(.hit-area)')
          .getAttribute('r'),
      )

    // Getting Started and Quick Notes link to each other; Projects links nowhere.
    await expect(nodeGroups.filter({ hasText: 'Getting Started' })).toHaveCount(1)
    await expect(nodeGroups.filter({ hasText: 'Projects' })).toHaveCount(1)
    expect(await radius('Getting Started')).toBeGreaterThan(await radius('Projects'))
  })

  test('the page open in the active tab carries the accent (#5429)', async ({ page }) => {
    const current = page.locator('[data-testid="graph-view"] svg g.node[aria-current="page"]')

    /** Each node's painted fill, and the two graph tokens as the browser resolves them. */
    const fills = () =>
      page.getByTestId('graph-svg').evaluate((svg) => {
        const resolve = (token: string) => {
          const probe = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
          probe.setAttribute('fill', `var(${token})`)
          svg.append(probe)
          const fill = getComputedStyle(probe).fill
          probe.remove()
          return fill
        }
        const nodes = Array.from(svg.querySelectorAll('g.node')).map((g) => {
          const dot = g.querySelector('circle:not(.hit-area)')
          return [g.getAttribute('aria-label'), dot ? getComputedStyle(dot).fill : 'missing']
        })
        return {
          accent: resolve('--graph-accent'),
          neutral: resolve('--graph-node'),
          nodes: Object.fromEntries(nodes) as Record<string, string>,
        }
      })

    for (const [open, other] of [
      ['Quick Notes', 'Getting Started'],
      ['Getting Started', 'Quick Notes'],
    ] as const) {
      await openPage(page, open)
      await navigateToView(page, 'Graph')
      await expect(current).toHaveCount(1)
      await expect(current).toHaveAttribute('aria-label', open)

      const { accent, neutral, nodes } = await fills()
      expect(accent).not.toBe(neutral)
      expect(nodes[open]).toBe(accent)
      expect(nodes[other]).toBe(neutral)
      expect(Object.values(nodes).filter((fill) => fill === accent)).toHaveLength(1)
    }
  })
})
