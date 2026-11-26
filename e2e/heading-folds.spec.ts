import { devices, type Locator, type Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  expect44,
  focusBlockById,
  ipc,
  openPage,
  openPageMobile,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * #7040 S5b — a heading's fold hides its children, then the blocks after it at
 * its depth, up to the next heading of the same or a higher level; a nested
 * heading's stops at the end of its parent. Folds keep block folds' state: a
 * folded H1's unfold shows each fold inside it as it was.
 */

const PAGE = 'Heading Folds'
const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }

type Ids = Record<
  | 'alpha'
  | 'intro'
  | 'beta'
  | 'betaOne'
  | 'betaChild'
  | 'gamma'
  | 'gammaOne'
  | 'lone'
  | 'delta'
  | 'outer'
  | 'nested'
  | 'nestedOne'
  | 'tail',
  string
>

async function add(page: Page, parentId: string, content: string): Promise<string> {
  const row = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'content',
    content,
    parentId,
    index: null,
    scope: SCOPE,
    blockId: null,
  })
  return row.id
}

/**
 * The page:
 *
 *     # Alpha
 *     intro
 *     ## Beta
 *     beta one
 *       beta child zulu
 *     ## Gamma
 *     gamma one
 *     ### Lone
 *     # Delta
 *     outer
 *       ## Nested
 *       nested one
 *     tail
 */
async function seed(page: Page): Promise<Ids> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: PAGE,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  const alpha = await add(page, pageId, '# Alpha')
  const intro = await add(page, pageId, 'intro')
  const beta = await add(page, pageId, '## Beta')
  const betaOne = await add(page, pageId, 'beta one')
  const betaChild = await add(page, betaOne, 'beta child zulu')
  const gamma = await add(page, pageId, '## Gamma')
  const gammaOne = await add(page, pageId, 'gamma one')
  const lone = await add(page, pageId, '### Lone')
  const delta = await add(page, pageId, '# Delta')
  const outer = await add(page, pageId, 'outer')
  const nested = await add(page, outer, '## Nested')
  const nestedOne = await add(page, outer, 'nested one')
  const tail = await add(page, pageId, 'tail')
  return {
    alpha,
    intro,
    beta,
    betaOne,
    betaChild,
    gamma,
    gammaOne,
    lone,
    delta,
    outer,
    nested,
    nestedOne,
    tail,
  }
}

const row = (page: Page, id: string): Locator => page.locator(`li[data-block-id="${id}"]`)

/** The ids of the rows shown, in order. */
function shown(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-block"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-block-id') ?? ''))
}

/** Fold or unfold block `id` by its chevron. */
async function toggle(page: Page, id: string): Promise<void> {
  const target = row(page, id)
  await target.hover()
  await target.getByTestId('collapse-toggle').click()
}

test.describe('Heading folds @editor', () => {
  let ids: Ids
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    ids = await seed(page)
    await openPage(page, PAGE)
    await expect(row(page, ids.tail)).toBeVisible()
  })

  test('folding an H2 hides its section up to the next H2 and stops there', async ({ page }) => {
    await toggle(page, ids.beta)
    await expect(row(page, ids.beta).getByTestId('collapse-toggle')).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await expect
      .poll(() => shown(page))
      .toEqual([
        ids.alpha,
        ids.intro,
        ids.beta,
        ids.gamma,
        ids.gammaOne,
        ids.lone,
        ids.delta,
        ids.outer,
        ids.nested,
        ids.nestedOne,
        ids.tail,
      ])
  })

  test('a heading with nothing to fold has no chevron', async ({ page }) => {
    await row(page, ids.lone).hover()
    await expect(row(page, ids.gamma).getByTestId('collapse-toggle')).toHaveCount(1)
    await expect(row(page, ids.lone).getByTestId('collapse-toggle')).toHaveCount(0)
  })

  test("a folded H1 hides its H2 sections, and its unfold restores the H2's and an inner fold", async ({
    page,
  }) => {
    await toggle(page, ids.betaOne)
    await toggle(page, ids.gamma)
    await toggle(page, ids.alpha)
    await expect
      .poll(() => shown(page))
      .toEqual([ids.alpha, ids.delta, ids.outer, ids.nested, ids.nestedOne, ids.tail])

    await toggle(page, ids.alpha)
    await expect
      .poll(() => shown(page))
      .toEqual([
        ids.alpha,
        ids.intro,
        ids.beta,
        ids.betaOne,
        ids.gamma,
        ids.delta,
        ids.outer,
        ids.nested,
        ids.nestedOne,
        ids.tail,
      ])
  })

  test("a nested heading's fold stays within its parent", async ({ page }) => {
    await toggle(page, ids.nested)
    await expect
      .poll(() => shown(page))
      .toEqual([
        ids.alpha,
        ids.intro,
        ids.beta,
        ids.betaOne,
        ids.betaChild,
        ids.gamma,
        ids.gammaOne,
        ids.lone,
        ids.delta,
        ids.outer,
        ids.nested,
        ids.tail,
      ])
  })

  test('folding a heading while editing a block in its section hides that block', async ({
    page,
  }) => {
    await focusBlockById(page, ids.gammaOne)
    await toggle(page, ids.gamma)
    await expect(row(page, ids.gammaOne)).toHaveCount(0)
    await expect(row(page, ids.delta)).toBeVisible()
  })

  test('the collapse shortcut folds the heading being edited', async ({ page }) => {
    await focusBlockById(page, ids.gamma)
    await page.keyboard.press('Control+.')
    await expect(row(page, ids.gammaOne)).toHaveCount(0)
    await expect(row(page, ids.lone)).toHaveCount(0)
    await expect(row(page, ids.delta)).toBeVisible()
  })

  test('Enter at the end of a folded heading unfolds it and starts its section with a new block', async ({
    page,
  }) => {
    await toggle(page, ids.beta)
    await expect(row(page, ids.betaOne)).toHaveCount(0)

    await focusBlockById(page, ids.beta)
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')

    const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
    await expect(editor).toHaveText('')
    await expect(editor).toBeFocused()
    const created = await editor.evaluate(
      (el) => el.closest('[data-block-id]')?.getAttribute('data-block-id') ?? '',
    )
    await expect(row(page, ids.betaOne)).toBeVisible()
    const order = await shown(page)
    expect(order.slice(order.indexOf(ids.beta), order.indexOf(ids.beta) + 3)).toEqual([
      ids.beta,
      created,
      ids.betaOne,
    ])

    // Unfolded for good, not only shown while the caret is in the section.
    await focusBlockById(page, ids.tail)
    await expect(row(page, ids.betaOne)).toBeVisible()
    await expect(row(page, ids.beta).getByTestId('collapse-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  test('find reveals a match inside a folded section', async ({ page }) => {
    await toggle(page, ids.beta)
    await expect(page.getByText('beta child zulu')).toHaveCount(0)

    await page.keyboard.down('Control')
    await page.keyboard.press('f')
    await page.keyboard.up('Control')
    await page.getByTestId('in-page-find-input').fill('zulu')
    await expect(page.getByTestId('in-page-find-counter')).toHaveText('1 of 1')
    await expect(page.getByText('beta child zulu')).toBeInViewport()
  })

  test('the fold survives navigating away and back', async ({ page }) => {
    await toggle(page, ids.beta)
    await expect(row(page, ids.betaOne)).toHaveCount(0)

    await reopenPage(page, PAGE)
    await expect(row(page, ids.tail)).toBeVisible()
    await expect(row(page, ids.betaOne)).toHaveCount(0)
    await expect(row(page, ids.gamma)).toBeVisible()
    await expect(row(page, ids.beta).getByTestId('collapse-toggle')).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })
})

const iPhone13 = devices['iPhone 13']

test.describe('Heading folds on a phone @editor @mobile', () => {
  test.use({
    viewport: iPhone13.viewport,
    userAgent: iPhone13.userAgent,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    isMobile: iPhone13.isMobile,
    hasTouch: iPhone13.hasTouch,
  })

  test("a top-level heading's chevron folds its section from a 44 px target", async ({ page }) => {
    await waitForBoot(page)
    const ids = await seed(page)
    await openPageMobile(page, PAGE)
    const chevron = row(page, ids.beta).getByTestId('collapse-toggle')
    await expect(chevron).toBeVisible()
    await expect44(chevron, 'heading chevron')

    await chevron.tap()
    await expect(row(page, ids.betaOne)).toHaveCount(0)
    await expect(row(page, ids.gamma)).toBeVisible()
  })
})
