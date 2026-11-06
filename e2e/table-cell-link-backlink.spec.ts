/**
 * A labelled link typed in a table cell is stored as `[[ULID\|label]]`: the
 * table writer escapes every pipe in a cell so the row keeps its columns. Every
 * reader of stored link tokens reads that escaped separator as the bare one,
 * so the link is a backlink of its page like any other. Mock lane: the mock's
 * own link scan (`link-scan.ts`) serves the linked-references panel, and the
 * backend's `block_links` side is pinned by `conformance/fixtures/table_cell_link.json`.
 */

import {
  expect,
  focusBlockById,
  openPage,
  reopenPage,
  saveBlock,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

// `SEED_IDS.BLOCK_GS_1` in src/lib/tauri-mock/seed.ts, the first block of "Getting Started".
const GS_1 = '0000000000000000000BLOCK01'

test.describe('A link in a table cell @editor @pages', () => {
  test('a labelled link typed in a cell lists its block in the target page references', async ({
    page,
  }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await focusBlockById(page, GS_1)
    const list = await typeSlashCommand(page, 'table')
    await expect(list.locator('#suggestion-table')).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('grid', { name: 'Insert table' })).toBeFocused()
    await page.keyboard.press('Enter')

    // The caret sits in the first header cell of the new table.
    await page.keyboard.type('[[Meetings|the meetings]]', { delay: 30 })
    await expect(
      page.locator(
        '[data-testid="block-editor"] th [data-testid="block-link-chip"][data-label="the meetings"]',
      ),
    ).toHaveText('the meetings')
    await saveBlock(page, 'Escape')

    // Away and back: the table is re-read from the stored text, chip and all.
    await reopenPage(page, 'Getting Started')
    const chip = page
      .getByTestId('rich-table')
      .locator('th [data-testid="block-link-chip"]', { hasText: 'the meetings' })
    await expect(chip).toHaveAttribute('title', 'Meetings')

    await openPage(page, 'Meetings')
    const references = page.getByTestId('linked-references')
    await expect(references.getByRole('button', { name: /^Collapse \d+ References?$/ })).toHaveText(
      '1 Reference',
    )
    await expect(references.locator('[data-backlink-item]')).toHaveCount(1)
    await expect(references.locator('[data-backlink-item]')).toContainText('the meetings')
  })
})
