import { blockRow, expectPersisted, pickDate, runSlashCommand, startEditing } from './domain'
import {
  expect,
  focusBlockById,
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
const BULLET_LIST = 'BULLET LIST — Insert unordered list'

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: PINNED_NOW })
  await waitForBoot(page)
  await startEditing(page, PAGE, GS1)
})

test('/cancelled marks the block CANCELLED and it persists @editor', async ({ page }) => {
  await runSlashCommand(page, 'cancelled', 'CANCELLED — Mark as cancelled')

  const marker = blockRow(page, GS1).getByRole('button', {
    name: 'Task: CANCELLED. Click to cycle.',
  })
  await expect(marker).toBeVisible()
  await expectPersisted(page, PAGE, marker)
})

test('/schedule: the picked day becomes a scheduled chip that persists @editor', async ({
  page,
}) => {
  await runSlashCommand(page, 'schedule', 'SCHEDULED — Set scheduled date on block')
  await pickDate(page, '2026-03-20')

  const chip = blockRow(page, GS1).getByRole('button', { name: 'Scheduled Mar 20', exact: true })
  await expect(chip).toBeVisible()
  await expectPersisted(page, PAGE, chip)
})

test('/bullet-list gives the block a bullet marker that persists @editor', async ({ page }) => {
  await runSlashCommand(page, 'bullet', BULLET_LIST)

  // The marker is drawn from the `listStyle` property, which the mock only
  // hands back on the next mount (it emits no `block:properties-changed`).
  await expectPersisted(page, PAGE, blockRow(page, GS1).getByTestId('list-marker'), '•')
})

test('/h2 on a bulleted block makes it a heading and takes its bullet off @editor', async ({
  page,
}) => {
  await runSlashCommand(page, 'bullet', BULLET_LIST)
  await expectPersisted(page, PAGE, blockRow(page, GS1).getByTestId('list-marker'), '•')

  await focusBlockById(page, GS1)
  await runSlashCommand(page, 'h2', 'Heading 2 — Medium heading')

  await expectPersisted(page, PAGE, blockRow(page, GS1).locator('[data-testid="block-static"] h2'))
  await expect(blockRow(page, GS1).getByTestId('list-marker')).toHaveCount(0)
})

test('/code turns the block into a code block that persists @editor', async ({ page }) => {
  await replaceEditorText(page, 'let answer = 42')
  await runSlashCommand(page, 'code', 'CODE — Insert code block')
  await expect(
    page.locator('[data-testid="block-editor"] [contenteditable="true"] pre code'),
  ).toContainText('let answer = 42')

  // Enter inside a code block is a newline; Escape saves and leaves editing.
  await saveBlock(page, 'Escape')
  await expectPersisted(
    page,
    PAGE,
    blockRow(page, GS1).locator('[data-testid="block-static"] pre code'),
    'let answer = 42',
  )
})

test('/duplicate adds a second block with the just-typed text @editor', async ({ page }) => {
  await replaceEditorText(page, 'copy this line')
  await runSlashCommand(page, 'duplicate', 'DUPLICATE — Copy this block and its subtree')
  await saveBlock(page, 'Escape')

  // `duplicateBlock` reloads the page from the backend, so both rows are read back.
  await expect(
    page.locator('[data-testid="block-static"]').filter({ hasText: 'copy this line' }),
  ).toHaveCount(2)
})

test('a used command leads the empty-query menu in a Recent group @editor', async ({ page }) => {
  await runSlashCommand(page, 'quote', 'QUOTE — Insert blockquote')

  const list = await typeSlashCommand(page, '')
  const recent = list.getByRole('group').first()
  await expect(recent).toHaveAccessibleName('Recent')
  await expect(recent.getByRole('option')).toHaveText(['QUOTE — Insert blockquote'])
})
