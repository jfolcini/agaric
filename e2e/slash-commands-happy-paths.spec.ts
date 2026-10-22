import type { Page } from '@playwright/test'

import {
  activeDialog,
  expect,
  focusBlockById,
  openPage,
  reopenPage,
  replaceEditorText,
  saveBlock,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

/**
 * Happy paths for slash commands no other spec drives end to end (#5734):
 * `/cancelled`, `/schedule`, `/bullet-list`, `/code`, `/h2` on a list block,
 * `/duplicate`, and the menu's Recent group. Each test runs the command from the `/` menu and reads
 * its effect back from the mock, which shows a failure of each, so it lives
 * in `e2e/`.
 *
 * The clock is pinned so the day picked for `/schedule` has a fixed label.
 */

const PINNED_NOW = new Date('2026-03-11T12:00:00')
const PAGE = 'Getting Started'
// SEED_IDS.BLOCK_GS_1 in src/lib/tauri-mock/seed.ts: a plain "Getting Started" block.
const GS1 = '0000000000000000000BLOCK01'

const row = (page: Page, id: string) =>
  page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`)

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: PINNED_NOW })
  await waitForBoot(page)
  await openPage(page, PAGE)
  await focusBlockById(page, GS1)
})

test('/cancelled marks the block CANCELLED and it persists @editor', async ({ page }) => {
  await typeSlashCommand(page, 'cancelled')
  await page.keyboard.press('Enter')

  const marker = row(page, GS1).getByRole('button', { name: 'Task: CANCELLED. Click to cycle.' })
  await expect(marker).toBeVisible()

  await reopenPage(page, PAGE)
  await expect(marker).toBeVisible()
})

test('/schedule: the picked day becomes a scheduled chip that persists @editor', async ({
  page,
}) => {
  const list = await typeSlashCommand(page, 'schedule')
  await list.getByRole('option', { name: 'SCHEDULED — Set scheduled date on block' }).click()

  const picker = activeDialog(page)
  await expect(picker).toHaveAttribute('data-testid', 'date-picker-popup')
  await picker.locator('[role="gridcell"][data-day="2026-03-20"]').getByRole('button').click()

  const chip = row(page, GS1).getByRole('button', { name: 'Scheduled Mar 20', exact: true })
  await expect(chip).toBeVisible()

  await reopenPage(page, PAGE)
  await expect(chip).toBeVisible()
})

test('/bullet-list gives the block a bullet marker that persists @editor', async ({ page }) => {
  const list = await typeSlashCommand(page, 'bullet')
  await list.getByRole('option', { name: 'BULLET LIST — Insert unordered list' }).click()

  // The marker is drawn from the `listStyle` property, which the mock only
  // hands back on the next mount (it emits no `block:properties-changed`).
  await reopenPage(page, PAGE)
  await expect(row(page, GS1).getByTestId('list-marker')).toHaveText('•')
})

test('/h2 on a bulleted block makes it a heading and takes its bullet off @editor', async ({
  page,
}) => {
  const bullet = await typeSlashCommand(page, 'bullet')
  await bullet.getByRole('option', { name: 'BULLET LIST — Insert unordered list' }).click()
  await reopenPage(page, PAGE)
  await expect(row(page, GS1).getByTestId('list-marker')).toHaveText('•')

  await focusBlockById(page, GS1)
  const list = await typeSlashCommand(page, 'h2')
  await list.getByRole('option', { name: 'Heading 2 — Medium heading' }).click()

  await reopenPage(page, PAGE)
  await expect(row(page, GS1).locator('[data-testid="block-static"] h2')).toBeVisible()
  await expect(row(page, GS1).getByTestId('list-marker')).toHaveCount(0)
})

test('/code turns the block into a code block that persists @editor', async ({ page }) => {
  await replaceEditorText(page, 'let answer = 42')
  const list = await typeSlashCommand(page, 'code')
  await list.getByRole('option', { name: 'CODE — Insert code block' }).click()
  await expect(
    page.locator('[data-testid="block-editor"] [contenteditable="true"] pre code'),
  ).toContainText('let answer = 42')

  // Enter inside a code block is a newline; Escape saves and leaves editing.
  await saveBlock(page, 'Escape')
  await reopenPage(page, PAGE)
  await expect(row(page, GS1).locator('[data-testid="block-static"] pre code')).toContainText(
    'let answer = 42',
  )
})

test('/duplicate adds a second block with the just-typed text @editor', async ({ page }) => {
  await replaceEditorText(page, 'copy this line')
  const list = await typeSlashCommand(page, 'duplicate')
  await list.getByRole('option', { name: 'DUPLICATE — Copy this block and its subtree' }).click()
  await saveBlock(page, 'Escape')

  // `duplicateBlock` reloads the page from the backend, so both rows are read back.
  await expect(
    page.locator('[data-testid="block-static"]').filter({ hasText: 'copy this line' }),
  ).toHaveCount(2)
})

test('a used command leads the empty-query menu in a Recent group @editor', async ({ page }) => {
  const list = await typeSlashCommand(page, 'quote')
  await list.getByRole('option', { name: 'QUOTE — Insert blockquote' }).click()

  await typeSlashCommand(page, '')
  const recent = list.getByRole('group').first()
  await expect(recent).toHaveAccessibleName('Recent')
  await expect(recent.getByRole('option')).toHaveText(['QUOTE — Insert blockquote'])
})
