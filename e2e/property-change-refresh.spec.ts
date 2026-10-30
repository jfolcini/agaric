import { blockRow, runSlashCommand, startEditing } from './domain'
import { expect, saveBlock, test, waitForBoot } from './helpers'

/**
 * #6054 — a property write shows on the open page without a reopen. The
 * backend emits `block:properties-changed` once the write commits, and the
 * page's property batch refetches on it; the mock emits the same (pinned by the
 * conformance fixtures). The list-style specs assert after a reopen, which
 * passes without the event, so this one asserts before any navigation.
 */

const PAGE = 'Getting Started'
// SEED_IDS.BLOCK_GS_1 in src/lib/tauri-mock/seed.ts: a plain "Getting Started" block.
const GS1 = '0000000000000000000BLOCK01'

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
  await startEditing(page, PAGE, GS1)
})

test('/numbered-list draws its marker on the open page, with no reopen @editor', async ({
  page,
}) => {
  await runSlashCommand(page, 'numbered', 'NUMBERED LIST — Insert ordered list')
  await saveBlock(page, 'Escape')

  await expect(blockRow(page, GS1).getByTestId('list-marker')).toHaveText('1.')
})
