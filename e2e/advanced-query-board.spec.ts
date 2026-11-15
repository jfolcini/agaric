/**
 * The Advanced Query board (#6542): a State grouping laid out as one column
 * per task state. Each column runs the mock's flat `run_advanced_query` path
 * with its own `State` leaf, so a column that selects the wrong blocks, or a
 * board that keeps the list's single query, shows up here as cards in the
 * wrong column.
 */
import { devices, type Locator, type Page } from '@playwright/test'

import {
  carryOver,
  centerOf,
  chooseSelectOption,
  dndClickGuardLifted,
  expect,
  expectNoHorizontalOverflow,
  navigateToView,
  renderedFrame,
  seedSearchBlocks,
  test,
  waitForBoot,
  withTouch,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

const column = (page: Page, name: string): Locator =>
  page.getByRole('region', { name, exact: true })
const cards = (page: Page, name: string): Locator =>
  column(page, name).getByTestId('query-board-card')
const card = (page: Page, name: string, text: string): Locator =>
  cards(page, name).filter({ hasText: text })

/** Pick `to` in the *Move to…* menu of the card with `text` in column `from`. */
async function moveCard(page: Page, from: string, text: string, to: string): Promise<void> {
  await column(page, from)
    .getByRole('listitem')
    .filter({ hasText: text })
    .getByRole('button', { name: 'Move to…' })
    .click()
  await page
    .getByRole('dialog', { name: 'Move to…' })
    .getByRole('button', { name: to, exact: true })
    .click()
}

/** dnd-kit's live region, while it says something about the card with `text`. */
const announced = (page: Page, text: string): Locator =>
  page.locator('[id^="DndLiveRegion-"]').filter({ hasText: text })

/** Leave Advanced Query and come back, so every column is queried afresh. */
async function reopenBoard(page: Page): Promise<void> {
  await navigateToView(page, 'Pages')
  await navigateToView(page, 'Advanced Query')
  await expect(page.getByTestId('query-board')).toBeVisible()
}

async function openStateBoard(page: Page): Promise<void> {
  await navigateToView(page, 'Advanced Query')
  await expect(page.getByRole('radio', { name: 'Board' })).toBeDisabled()
  await chooseSelectOption(page, 'Group by', 'State')
  await page.getByRole('radio', { name: 'Board' }).click()
}

test('a State grouping shows as a board whose cards open their page @search', async ({ page }) => {
  await seedSearchBlocks(page, [
    { content: 'Board spec waiting', todo: 'TODO' },
    { content: 'Board spec shipped', todo: 'DONE' },
  ])
  await openStateBoard(page)

  await expect(page.getByTestId('query-board-column').getByRole('heading')).toHaveText([
    'TODO',
    'DOING',
    'DONE',
    'CANCELLED',
    'No value',
  ])
  await expect(cards(page, 'TODO').filter({ hasText: 'Board spec waiting' })).toHaveCount(1)
  await expect(cards(page, 'DONE').filter({ hasText: 'Board spec shipped' })).toHaveCount(1)
  await expect(cards(page, 'TODO').filter({ hasText: 'Board spec shipped' })).toHaveCount(0)
  // No seeded block is cancelled: the value keeps its column, empty.
  await expect(column(page, 'CANCELLED').getByText('No blocks in “CANCELLED”')).toBeVisible()
  await expect(cards(page, 'CANCELLED')).toHaveCount(0)

  // The keyboard reaches a column's cursor card, the newest TODO, seeded above
  // on the Projects page; Tab goes on to its move button, and Enter on the
  // card opens its page.
  await cards(page, 'TODO').first().focus()
  await expect(cards(page, 'TODO').first()).toContainText('Board spec waiting')
  await page.keyboard.press('Tab')
  await expect(column(page, 'TODO').getByRole('button', { name: 'Move to…' }).first()).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('ArrowDown')
  await expect(cards(page, 'TODO').nth(1)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveText('Projects')
})

test('a card moves to another column from its menu, and the toast takes it back @search', async ({
  page,
}) => {
  await seedSearchBlocks(page, [{ content: 'Board spec mover', todo: 'TODO' }])
  await openStateBoard(page)
  await expect(card(page, 'TODO', 'Board spec mover')).toHaveCount(1)

  await moveCard(page, 'TODO', 'Board spec mover', 'DOING')
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Moved to DOING' }),
  ).toBeVisible()
  await expect(card(page, 'DOING', 'Board spec mover')).toHaveCount(1)
  await expect(card(page, 'TODO', 'Board spec mover')).toHaveCount(0)
  // The card's buttons are gone from under the focus; its old column has it.
  await expect(column(page, 'TODO')).toBeFocused()

  await reopenBoard(page)
  await expect(card(page, 'DOING', 'Board spec mover')).toHaveCount(1)
  await expect(card(page, 'TODO', 'Board spec mover')).toHaveCount(0)

  await moveCard(page, 'DOING', 'Board spec mover', 'No value')
  await expect(card(page, 'No value', 'Board spec mover')).toHaveCount(1)
  await page
    .locator('[data-sonner-toast]')
    .filter({ hasText: 'Moved to No value' })
    .getByRole('button', { name: 'Undo', exact: true })
    .click()
  await expect(card(page, 'DOING', 'Board spec mover')).toHaveCount(1)

  await reopenBoard(page)
  await expect(card(page, 'DOING', 'Board spec mover')).toHaveCount(1)
  await expect(card(page, 'No value', 'Board spec mover')).toHaveCount(0)
})

test('undo on the card’s page takes a board move back @search @editor', async ({ page }) => {
  await seedSearchBlocks(page, [{ content: 'Board spec undone', todo: 'TODO' }])
  await openStateBoard(page)
  await moveCard(page, 'TODO', 'Board spec undone', 'DONE')
  await expect(card(page, 'DONE', 'Board spec undone')).toHaveCount(1)

  await card(page, 'DONE', 'Board spec undone').click()
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveText('Projects')
  await page.keyboard.press('Control+z')
  await expect(page.getByRole('status').filter({ hasText: 'Undone' })).toBeVisible()

  await navigateToView(page, 'Advanced Query')
  await expect(card(page, 'TODO', 'Board spec undone')).toHaveCount(1)
  await expect(card(page, 'DONE', 'Board spec undone')).toHaveCount(0)
})

test('the board scrolls sideways inside a phone-width view @search @mobile', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await openStateBoard(page)

  await expect(cards(page, 'TODO').first()).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await column(page, 'No value').scrollIntoViewIfNeeded()
  await expect(column(page, 'No value')).toBeInViewport()
})

test('a card dragged onto another column moves there, and the toast takes it back @search', async ({
  page,
}) => {
  await seedSearchBlocks(page, [{ content: 'Board spec dragged', todo: 'TODO' }])
  await openStateBoard(page)
  await column(page, 'DOING').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  const from = await centerOf(card(page, 'TODO', 'Board spec dragged'), 'card')

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await carryOver(from, column(page, 'DOING'), (x, y) => page.mouse.move(x, y))
  await expect(page.getByTestId('query-board-drag-overlay')).toHaveText('Board spec dragged')
  await renderedFrame(page)
  await page.mouse.up()
  await dndClickGuardLifted(page)

  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Moved to DOING' })
  await expect(toast).toBeVisible()
  await expect(card(page, 'DOING', 'Board spec dragged')).toHaveCount(1)
  await expect(card(page, 'TODO', 'Board spec dragged')).toHaveCount(0)
  await expect(announced(page, 'Board spec dragged')).toHaveText(
    'Board spec dragged dropped over DOING.',
  )
  // The drop opened nothing: the board is still on screen.
  await expect(page.getByTestId('query-board')).toBeVisible()

  await reopenBoard(page)
  await expect(card(page, 'DOING', 'Board spec dragged')).toHaveCount(1)

  await moveCard(page, 'DOING', 'Board spec dragged', 'TODO')
  await expect(card(page, 'TODO', 'Board spec dragged')).toHaveCount(1)
})

test.describe('The board on a touch tablet @search @mobile', () => {
  const tablet = devices['iPad Pro 11 landscape']
  test.use({ viewport: tablet.viewport, hasTouch: true, isMobile: tablet.isMobile })

  test('a long press picks a card up and a drop moves it; a swipe scrolls the board', async ({
    page,
  }) => {
    await seedSearchBlocks(page, [{ content: 'Board spec touched', todo: 'TODO' }])
    await openStateBoard(page)
    const viewport = page
      .getByTestId('query-board')
      .locator('[data-slot="scroll-area-viewport"]')
      .first()
    // Mid-screen, clear of the edges where dnd-kit scrolls under a held card.
    await column(page, 'TODO').evaluate((el) => el.scrollIntoView({ block: 'center' }))

    // A quick swipe across the card scrolls the board sideways and lifts nothing.
    // It flings: the board scrolls on after the finger lifts, and setting
    // `scrollLeft` does not stop it, so the card is measured only after the
    // fling's `scrollend`.
    const swipeEnd = await viewport.evaluateHandle((el) => ({
      scrollLeft: new Promise<number>((resolve) => {
        el.addEventListener('scrollend', () => resolve(el.scrollLeft), { once: true })
      }),
    }))
    const swipe = await centerOf(card(page, 'TODO', 'Board spec touched'), 'card')
    await withTouch(page, async (touch) => {
      await touch.start(swipe.x, swipe.y)
      for (let i = 1; i <= 10; i++) await touch.move(swipe.x - i * 30, swipe.y)
      await touch.end()
    })
    expect(await swipeEnd.evaluate((end) => end.scrollLeft)).toBeGreaterThan(0)
    // Nothing was picked up: the drop below shows the region would say so.
    await expect(announced(page, 'Board spec touched')).toHaveCount(0)
    await viewport.evaluate((el) => {
      el.scrollLeft = 0
    })
    await dndClickGuardLifted(page)
    await expect(card(page, 'TODO', 'Board spec touched')).toHaveCount(1)

    const from = await centerOf(card(page, 'TODO', 'Board spec touched'), 'card')
    await withTouch(page, async (touch) => {
      await touch.start(from.x, from.y)
      // The card lifts once the long-press hold has passed.
      await expect(page.getByTestId('query-board-drag-overlay')).toHaveText('Board spec touched')
      await carryOver(from, column(page, 'DOING'), touch.move)
      await renderedFrame(page)
      // A drag between columns mid-board leaves the board where it was.
      expect(await viewport.evaluate((el) => el.scrollLeft)).toBe(0)
      await touch.end()
    })
    await dndClickGuardLifted(page)

    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'Moved to DOING' }),
    ).toBeVisible()
    await expect(card(page, 'DOING', 'Board spec touched')).toHaveCount(1)
    await expect(announced(page, 'Board spec touched')).toHaveText(
      'Board spec touched dropped over DOING.',
    )
    await reopenBoard(page)
    await expect(card(page, 'DOING', 'Board spec touched')).toHaveCount(1)
    await expect(card(page, 'TODO', 'Board spec touched')).toHaveCount(0)
  })

  test('a card held at the board’s edge scrolls it to a column off screen', async ({ page }) => {
    await seedSearchBlocks(page, [{ content: 'Board spec edge', todo: 'TODO' }])
    await openStateBoard(page)
    const viewport = page
      .getByTestId('query-board')
      .locator('[data-slot="scroll-area-viewport"]')
      .first()
    await column(page, 'TODO').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await expect(column(page, 'No value')).not.toBeInViewport()

    const from = await centerOf(card(page, 'TODO', 'Board spec edge'), 'card')
    const right = await viewport.evaluate((el) => el.getBoundingClientRect().right)
    await withTouch(page, async (touch) => {
      await touch.start(from.x, from.y)
      await expect(page.getByTestId('query-board-drag-overlay')).toHaveText('Board spec edge')
      for (let i = 1; i <= 10; i++) {
        await touch.move(from.x + ((right - 10 - from.x) * i) / 10, from.y)
      }
      // Held at the edge, the board scrolls to its end.
      await expect
        .poll(() => viewport.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft))
        .toBeLessThan(1)
      // The board has scrolled since the press: aim at the column where it is now.
      await carryOver({ x: right - 10, y: from.y }, column(page, 'No value'), touch.move, 1)
      await renderedFrame(page)
      await touch.end()
    })
    await dndClickGuardLifted(page)

    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'Moved to No value' }),
    ).toBeVisible()
    await reopenBoard(page)
    await expect(card(page, 'No value', 'Board spec edge')).toHaveCount(1)
    await expect(card(page, 'TODO', 'Board spec edge')).toHaveCount(0)
  })
})
