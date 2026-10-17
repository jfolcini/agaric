import type { Page } from '@playwright/test'

import {
  chooseSelectOption,
  expect,
  navigateToView,
  openAddFilter,
  openPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * Graph view happy paths (#5738): the filter pills, the local graph, and the
 * keyboard model. Every assertion reads the graph's own DOM (the `g.node`
 * options and their `aria-label`, the live region, the page that opens), so
 * the in-memory mock can show each one failing.
 */

const NODES = '[data-testid="graph-view"] svg g.node'

/** The seed's non-journal pages (`src/lib/tauri-mock/seed.ts`): the graph's default node set. */
const SEED_PAGES = [
  'Getting Started',
  'Meeting Notes Template',
  'Meetings',
  'Projects',
  'Quick Notes',
]

/** `SEED_IDS` in `src/lib/tauri-mock/seed.ts`. */
const PAGE_GETTING_STARTED = '00000000000000000000PAGE01'
const PAGE_QUICK_NOTES = '00000000000000000000PAGE02'
const PAGE_PROJECTS = '00000000000000000000PAGE04'
const PAGE_MEETINGS = '00000000000000000000PAGE05'
const TAG_IDEA = '000000000000000000000TAG03'

function nodeLabels(page: Page): Promise<string[]> {
  return page
    .locator(NODES)
    .evaluateAll((groups) => groups.map((g) => g.getAttribute('aria-label') ?? '').toSorted())
}

function node(page: Page, label: string) {
  return page.getByRole('option', { name: label, exact: true })
}

async function openGraph(page: Page): Promise<void> {
  await navigateToView(page, 'Graph')
  await expect(page.locator(NODES).first()).toBeVisible()
}

function invoke(page: Page, cmd: string, args: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(
    ([c, a]) => {
      const internals = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] as {
        invoke: (cmd: string, args: unknown) => Promise<unknown>
      }
      return internals.invoke(c, a)
    },
    [cmd, args] as const,
  )
}

/** A page in the Personal space whose one block links to `linkTo`. */
async function seedLinkingPage(page: Page, title: string, linkTo: string): Promise<string> {
  const id = (await invoke(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: 'SPACE_PERSONAL',
  })) as string
  await invoke(page, 'create_blocks_batch', {
    specs: [{ blockType: 'content', content: `see [[${linkTo}]]`, parentId: id, position: null }],
  })
  return id
}

async function addFilter(page: Page, dimension: string, value?: string): Promise<void> {
  const popover = await openAddFilter(page)
  await chooseSelectOption(page, 'Select a dimension', dimension)
  if (value !== undefined) await chooseSelectOption(page, dimension, value)
  await popover.getByRole('button', { name: 'Apply' }).click()
}

/** The canvas transform once the first settle's fit has landed and holds still. */
async function settledTransform(page: Page): Promise<string> {
  const g = page.locator('[data-testid="graph-svg"] > g').first()
  let last: string | null = null
  await expect
    .poll(
      async () => {
        const now = await g.getAttribute('transform')
        const still = now !== null && now === last
        last = now
        return still
      },
      { intervals: [100] },
    )
    .toBe(true)
  return last ?? ''
}

/** The nodes drawn to the right of `label` on screen: where ArrowRight may go from it. */
function labelsRightOf(page: Page, label: string): Promise<string[]> {
  return page.getByTestId('graph-svg').evaluate((svg, from) => {
    const centreX = (g: Element) => {
      const box = g.querySelector('circle:not(.hit-area)')?.getBoundingClientRect()
      return box ? box.x + box.width / 2 : Number.NaN
    }
    const groups = Array.from(svg.querySelectorAll('g.node'))
    const start = groups.find((g) => g.getAttribute('aria-label') === from)
    const x = start ? centreX(start) : Number.NaN
    return groups.filter((g) => centreX(g) > x).map((g) => g.getAttribute('aria-label') ?? '')
  }, label)
}

function focusedLabel(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null)
}

test.describe('Graph view happy paths', () => {
  // The first render goes through the d3 worker (see graph-view.spec.ts).
  test.slow()

  test('the Tag filter narrows the graph to the pages carrying the tag', async ({ page }) => {
    await waitForBoot(page)
    // The seed tags only child blocks; the graph's tag filter matches page tags.
    await invoke(page, 'add_tag', { blockId: PAGE_PROJECTS, tagId: TAG_IDEA })
    await openGraph(page)
    await expect.poll(() => nodeLabels(page)).toEqual(SEED_PAGES)

    const popover = await openAddFilter(page)
    await chooseSelectOption(page, 'Select a dimension', 'Tag')
    await popover.getByRole('checkbox', { name: 'idea', exact: true }).check()
    await popover.getByRole('button', { name: 'Apply' }).click()

    await expect.poll(() => nodeLabels(page)).toEqual(['Projects'])
    await page.getByRole('button', { name: 'Remove Tag: 1 filter' }).click()
    await expect.poll(() => nodeLabels(page)).toEqual(SEED_PAGES)
  })

  test('the Has backlinks filter narrows the graph to the linked pages', async ({ page }) => {
    await waitForBoot(page)
    await openGraph(page)
    await expect.poll(() => nodeLabels(page)).toEqual(SEED_PAGES)

    // The seed links Getting Started <-> Quick Notes and nothing else.
    await addFilter(page, 'Has backlinks')

    await expect.poll(() => nodeLabels(page)).toEqual(['Getting Started', 'Quick Notes'])
    await page.getByRole('button', { name: 'Remove Has backlinks: Yes filter' }).click()
    await expect.poll(() => nodeLabels(page)).toEqual(SEED_PAGES)
  })

  test('the Status, Priority, Has due date and Has scheduled date filters each keep their page', async ({
    page,
  }) => {
    await waitForBoot(page)
    // One task field per page, so each filter keeps exactly one page.
    await invoke(page, 'set_todo_state', { blockId: PAGE_PROJECTS, state: 'TODO' })
    await invoke(page, 'set_priority', { blockId: PAGE_MEETINGS, level: '1' })
    await invoke(page, 'set_due_date', { blockId: PAGE_QUICK_NOTES, date: '2026-07-01' })
    await invoke(page, 'set_scheduled_date', { blockId: PAGE_GETTING_STARTED, date: '2026-06-30' })
    await openGraph(page)
    await expect.poll(() => nodeLabels(page)).toEqual(SEED_PAGES)

    for (const { dimension, checkbox, pill, kept } of [
      { dimension: 'Status', checkbox: 'TODO', pill: 'Status: TODO', kept: 'Projects' },
      { dimension: 'Priority', checkbox: 'High (1)', pill: 'Priority: 1', kept: 'Meetings' },
      { dimension: 'Has due date', pill: 'Has due date: Yes', kept: 'Quick Notes' },
      { dimension: 'Has scheduled date', pill: 'Has scheduled date: Yes', kept: 'Getting Started' },
    ]) {
      const popover = await openAddFilter(page)
      await chooseSelectOption(page, 'Select a dimension', dimension)
      if (checkbox !== undefined) {
        await popover.getByRole('checkbox', { name: checkbox, exact: true }).check()
      }
      await popover.getByRole('button', { name: 'Apply' }).click()

      await expect.poll(() => nodeLabels(page), { message: pill }).toEqual([kept])
      await page.getByRole('button', { name: `Remove ${pill} filter` }).click()
      await expect.poll(() => nodeLabels(page), { message: `${pill} removed` }).toEqual(SEED_PAGES)
    }
  })

  test('the local graph widens with its depth, re-centres on a neighbour and goes back', async ({
    page,
  }) => {
    // At rest at once, so the neighbour's dot holds still for the click.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
    // A chain off the seed's Getting Started <-> Quick Notes link, one ring per hop.
    const secondRing = await seedLinkingPage(page, 'Second Ring', PAGE_QUICK_NOTES)
    await seedLinkingPage(page, 'Third Ring', secondRing)
    await openPage(page, 'Getting Started')
    await openGraph(page)

    const seedLabel = page.getByTestId('local-graph-seed-label')
    const oneHop = page.getByRole('radio', { name: '1 hop', exact: true })
    await page.getByRole('button', { name: 'Focus on this page' }).click()
    await expect(seedLabel).toHaveText('Showing neighbors of "Getting Started"')

    await oneHop.click()
    await expect.poll(() => nodeLabels(page)).toEqual(['Getting Started', 'Quick Notes'])
    await page.getByRole('radio', { name: '2 hops', exact: true }).click()
    await expect
      .poll(() => nodeLabels(page))
      .toEqual(['Getting Started', 'Quick Notes', 'Second Ring'])

    await node(page, 'Quick Notes').locator('circle:not(.hit-area)').click()
    await expect(seedLabel).toHaveText('Showing neighbors of "Quick Notes"')
    await expect
      .poll(() => nodeLabels(page))
      .toEqual(['Getting Started', 'Quick Notes', 'Second Ring', 'Third Ring'])

    const back = page.getByRole('button', { name: 'Back to "Getting Started"' })
    await back.click()
    await expect(seedLabel).toHaveText('Showing neighbors of "Getting Started"')
    await expect
      .poll(() => nodeLabels(page))
      .toEqual(['Getting Started', 'Quick Notes', 'Second Ring'])
    await expect(back).toHaveCount(0)

    // The mode and depth are kept: leaving the graph and coming back finds both.
    await oneHop.click()
    await expect.poll(() => nodeLabels(page)).toEqual(['Getting Started', 'Quick Notes'])
    await navigateToView(page, 'Pages')
    await openGraph(page)
    await expect(page.getByRole('button', { name: 'Exit focus' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(oneHop).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => nodeLabels(page)).toEqual(['Getting Started', 'Quick Notes'])
  })

  test('the local graph says when the filters hide its page', async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await openGraph(page)
    await page.getByRole('button', { name: 'Focus on this page' }).click()
    await expect.poll(() => nodeLabels(page)).toEqual(['Getting Started', 'Quick Notes'])

    await addFilter(page, 'Has backlinks', 'No')

    await expect(page.getByTestId('graph-no-matches')).toHaveText(
      '"Getting Started" is hidden by the active filters',
    )
    await expect(page.locator(NODES)).toHaveCount(0)
  })

  test('the keyboard moves through the nodes, selects one, fits the view and opens it', async ({
    page,
  }) => {
    // At rest at once, so the fit and the arrow's geometry do not move under the keys.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
    await openGraph(page)
    const g = page.locator('[data-testid="graph-svg"] > g').first()
    const fitted = await settledTransform(page)

    // The canvas is one tab stop and its first node the next.
    await page.getByTestId('graph-svg').focus()
    await page.keyboard.press('Tab')
    await expect(node(page, 'Getting Started')).toBeFocused()

    const rightOfStart = await labelsRightOf(page, 'Getting Started')
    expect(rightOfStart.length).toBeGreaterThan(0)
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => focusedLabel(page)).not.toBe('Getting Started')
    expect(rightOfStart).toContain(await focusedLabel(page))

    // Type-ahead: the one node starting with the letter.
    await page.keyboard.press('q')
    await expect(node(page, 'Quick Notes')).toBeFocused()

    await page.keyboard.press(' ')
    await expect(node(page, 'Quick Notes')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#sr-announcer')).toHaveText('Selected "Quick Notes"')

    await page.keyboard.press('=')
    await expect.poll(() => g.getAttribute('transform')).not.toBe(fitted)
    await page.keyboard.press('0')
    await expect(g).toHaveAttribute('transform', fitted)

    await page.keyboard.press('Enter')
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Quick Notes')
  })
})
