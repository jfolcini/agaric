import { expect, test } from './helpers'

/**
 * E2E tests for the GraphView component (F-33).
 *
 * The tauri-mock seeds several pages with [[link]] references between them,
 * so the graph should render nodes (pages) and edges (links).
 *
 * Key selectors:
 * - SVG container: `svg[role="img"]` inside `[data-testid="graph-view"]`
 * - Nodes: `svg g.node` groups, each containing two `<circle>` elements
 *   (a transparent hit-area and a visible node circle)
 * - Edges: `svg line` elements
 * - Page title after navigation: `[aria-label="Page title"]`
 */

test.describe('Graph view', () => {
  // TEST-33: GraphView initial render legitimately goes through a d3 worker
  // startup path (PERF-9b) that can exceed the 3s global `expect` timeout on
  // cold tests. Use `test.slow()` at the suite level instead of sprinkling
  // `{ timeout: 10_000 }` overrides on every SVG-visibility assertion.
  test.slow()

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
  })

  test('graph view renders SVG with nodes', async ({ page }) => {
    await page.getByRole('button', { name: 'Graph', exact: true }).click()

    // Wait for the SVG to appear (loading skeleton resolves)
    await expect(page.locator('svg')).toBeVisible()

    // Each node group contains circles — verify at least one node exists
    const nodes = page.locator('svg circle')
    await expect(nodes.first()).toBeVisible()
    const count = await nodes.count()
    expect(count).toBeGreaterThan(0)
  })

  test('graph view renders edges between linked pages', async ({ page }) => {
    await page.getByRole('button', { name: 'Graph', exact: true }).click()
    await expect(page.locator('svg')).toBeVisible()

    // Seed data has [[link]] references between pages (e.g. Getting Started ↔ Quick Notes),
    // so there should be <line> elements for edges.
    const edges = page.locator('svg line')
    await expect(edges.first()).toBeVisible()
    const edgeCount = await edges.count()
    expect(edgeCount).toBeGreaterThan(0)
  })

  test('clicking a node navigates to that page', async ({ page }) => {
    await page.getByRole('button', { name: 'Graph', exact: true }).click()
    await expect(page.locator('svg')).toBeVisible()

    // Wait for nodes to render
    const nodeGroup = page.locator('svg g.node').first()
    await expect(nodeGroup).toBeVisible()

    // Click the node group (the hit-area circle handles the pointer event)
    await nodeGroup.click()

    // After clicking, the app navigates to the page editor — page title should be visible
    await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
  })

  test('graph view shows the graph container with data-testid', async ({ page }) => {
    await page.getByRole('button', { name: 'Graph', exact: true }).click()

    // The graph-view wrapper should appear once loading completes
    await expect(page.locator('[data-testid="graph-view"]')).toBeVisible()

    // SVG inside the container should have the accessible role
    const svg = page.locator('[data-testid="graph-view"] svg[role="img"]')
    await expect(svg).toBeVisible()
  })

  test('graph view eventually renders after loading', async ({ page }) => {
    await page.getByRole('button', { name: 'Graph', exact: true }).click()

    // The graph should eventually render — SVG becomes visible
    await expect(page.locator('svg')).toBeVisible()

    // And it should contain node groups (seed data has pages)
    const nodeGroups = page.locator('svg g.node')
    await expect(nodeGroups.first()).toBeVisible()
    const count = await nodeGroups.count()
    expect(count).toBeGreaterThanOrEqual(2) // At least 2 seed pages visible as nodes
  })
})
