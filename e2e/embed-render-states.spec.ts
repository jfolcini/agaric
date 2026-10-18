import type { Page } from '@playwright/test'

import {
  deleteBlockViaContextMenu,
  expect,
  navigateToView,
  openPage,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * `{{embed …}}` render states (#4550, #5736 item 10): a block embed's
 * re-based subtree and header strip, a page embed, collapse, Open source, the
 * Source-deleted shell and its Restore route, and the cycle and depth stubs.
 *
 * In `e2e/` because the mock models everything the embed reads
 * (`batch_resolve`, `get_block`, `load_page_subtree`, the trash). Inserting an
 * embed through `/embed` is covered by `embed-edit-in-place.spec.ts`, so the
 * tokens here are written straight through the mock, as sync would.
 *
 * Seed (src/lib/tauri-mock/seed.ts, `SEED_IDS`): Getting Started holds GS_1,
 * GS_3 and GS_5; Quick Notes holds QN_2, the host row used below; Meetings
 * holds MTG_1 and MTG_2.
 */

const PAGE_MEETINGS = '00000000000000000000PAGE05'
const BLOCK_GS_1 = '0000000000000000000BLOCK01'
const BLOCK_GS_3 = '0000000000000000000BLOCK03'
const BLOCK_GS_5 = '0000000000000000000BLOCK05'
const BLOCK_QN_2 = '0000000000000000000BLOCK09'
const BLOCK_MTG_1 = '0000000000000000000BLOCK17'
const BLOCK_MTG_2 = '0000000000000000000BLOCK18'
const GS_1_TEXT = 'Welcome to Agaric! This is your personal knowledge base.'
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }

function ipc<T>(page: Page, cmd: string, args: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    ({ c, a }) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke(c, a),
    { c: cmd, a: args },
  ) as Promise<T>
}

async function setContent(page: Page, blockId: string, toText: string): Promise<void> {
  await ipc(page, 'edit_block', { blockId, toText })
}

async function addChild(page: Page, parentId: string, content: string): Promise<string> {
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

/** `openPage`, scoped to the Pages view's rows: once visited, a page is in the recents strip too. */
async function openFromPageList(page: Page, title: string): Promise<void> {
  await navigateToView(page, 'Pages')
  await page.locator('[data-page-item]').getByText(title, { exact: true }).click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

const embedOf = (id: string) => `{{embed ((${id}))}}`

test.describe('embed render states', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a block embed renders its subtree from depth 0 under a strip, collapses durably and opens its source', async ({
    page,
  }) => {
    // Embed a NESTED block, so the re-base is visible: its source depth is 1.
    const middle = await addChild(page, BLOCK_GS_1, 'Embedded middle row')
    const leaf = await addChild(page, middle, 'Embedded leaf row')
    await setContent(page, BLOCK_QN_2, embedOf(middle))

    await openPage(page, 'Quick Notes')
    const embed = page.getByTestId('embed-container')
    const strip = embed.getByRole('navigation', { name: 'Embed source' })
    // The strip names the source page; the crumb is the target's ancestor (GS_1).
    await expect(strip).toHaveText(`Embedded from Getting Started › ${GS_1_TEXT}`)

    const rows = embed.locator('[data-embed-block-id]')
    await expect(rows).toHaveCount(2)
    // The host row is level 1, the container level 2: the target re-bases to
    // the container's first level and its child sits one below.
    await expect(rows.nth(0)).toHaveAttribute('data-embed-block-id', middle)
    await expect(rows.nth(0)).toHaveAttribute('aria-level', '2')
    await expect(rows.nth(0)).toHaveText('Embedded middle row')
    await expect(rows.nth(1)).toHaveAttribute('data-embed-block-id', leaf)
    await expect(rows.nth(1)).toHaveAttribute('aria-level', '3')
    await expect(rows.nth(1)).toHaveText('Embedded leaf row')

    await embed.getByRole('button', { name: 'Collapse embed' }).click()
    await expect(embed).toHaveAttribute('aria-expanded', 'false')
    await expect(rows).toHaveCount(0)

    // Collapse is saved per host block, so it survives leaving the page.
    await reopenPage(page, 'Quick Notes')
    await expect(embed).toHaveAttribute('aria-expanded', 'false')
    await expect(rows).toHaveCount(0)
    await embed.getByRole('button', { name: 'Expand embed' }).click()
    await expect(rows).toHaveCount(2)

    await embed.getByRole('button', { name: 'Open source' }).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
  })

  test('a page embed renders the page’s top-level blocks under the page title alone', async ({
    page,
  }) => {
    await setContent(page, BLOCK_QN_2, `{{embed [[${PAGE_MEETINGS}]]}}`)

    await openPage(page, 'Quick Notes')
    const embed = page.getByTestId('embed-container')
    const strip = embed.getByRole('navigation', { name: 'Embed source' })
    await expect(strip).toHaveText('Embedded from Meetings')
    // The rail's side is square (docs/UX.md § Design tokens, Radius).
    await expect(embed).toHaveCSS('border-top-left-radius', '0px')
    await expect(embed).toHaveCSS('border-bottom-left-radius', '0px')
    await expect(embed.locator('[data-embed-block-id]')).toHaveText([
      'Weekly standup notes',
      'Design review feedback',
    ])
  })

  test('a trashed source shows Source deleted, and Restore leads to the trash that brings it back', async ({
    page,
  }) => {
    await setContent(page, BLOCK_QN_2, embedOf(BLOCK_GS_1))
    await openPage(page, 'Quick Notes')
    await expect(page.getByTestId('embed-container')).toContainText(GS_1_TEXT)

    await openFromPageList(page, 'Getting Started')
    await deleteBlockViaContextMenu(
      page,
      page.locator('[data-testid="sortable-block"]').filter({ hasText: GS_1_TEXT }),
    )
    await expect(page.getByText(GS_1_TEXT)).toHaveCount(0)

    await openFromPageList(page, 'Quick Notes')
    const deleted = page.getByTestId('embed-deleted')
    await expect(deleted.locator('.embed-strip')).toHaveText('Source deleted')
    await expect(deleted).toHaveAttribute('aria-label', `Embedded block deleted: ${GS_1_TEXT}`)
    await expect(page.getByTestId('embed-container')).toHaveCount(0)

    await deleted.getByRole('button', { name: 'Restore from Trash' }).click()
    await expect(page.getByTestId('header-label')).toHaveText('Trash')
    const item = page.getByTestId('trash-item').filter({ hasText: GS_1_TEXT })
    await item.getByTestId('trash-restore-btn').click()
    await expect(item).toHaveCount(0)

    // The embed resolves the restored source again, and the source page has it.
    await openFromPageList(page, 'Quick Notes')
    await expect(page.getByTestId('embed-container')).toContainText(GS_1_TEXT)
    await expect(page.getByTestId('embed-deleted')).toHaveCount(0)
    await openFromPageList(page, 'Getting Started')
    await expect(
      page.locator(`[data-testid="block-static"][data-block-id="${BLOCK_GS_1}"]`),
    ).toHaveText(GS_1_TEXT)
  })

  test('A embedding B embedding A shows Already shown above where the loop closes', async ({
    page,
  }) => {
    await setContent(page, BLOCK_QN_2, embedOf(BLOCK_MTG_1))
    await setContent(page, BLOCK_MTG_1, embedOf(BLOCK_QN_2))

    await openPage(page, 'Quick Notes')
    // QN_2 → MTG_1 → QN_2, and the next MTG_1 is the repeat: the stub sits in
    // the second embed, where the loop closes.
    const embeds = page.getByTestId('embed-container')
    await expect(embeds).toHaveCount(2)
    const stub = embeds.nth(1).getByTestId('embed-stub')
    await expect(page.getByTestId('embed-stub')).toHaveCount(1)
    await expect(stub).toHaveAttribute('data-embed-stub', 'cycle')
    await expect(stub).toContainText('Already shown above')

    await stub.getByRole('button', { name: 'Open source' }).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Meetings')
  })

  test('an unrepeated chain stops at the depth cap with Nested too deep', async ({ page }) => {
    await setContent(page, BLOCK_QN_2, embedOf(BLOCK_MTG_1))
    await setContent(page, BLOCK_MTG_1, embedOf(BLOCK_MTG_2))
    await setContent(page, BLOCK_MTG_2, embedOf(BLOCK_GS_3))
    await setContent(page, BLOCK_GS_3, embedOf(BLOCK_GS_5))

    await openPage(page, 'Quick Notes')
    // MAX_EMBED_DEPTH (src/lib/embed-token.ts) embeds render, nested in one
    // another; the next link in the chain is the stub, inside the innermost.
    const embeds = page.getByTestId('embed-container')
    await expect(embeds).toHaveCount(3)
    const stub = embeds.nth(2).getByTestId('embed-stub')
    await expect(page.getByTestId('embed-stub')).toHaveCount(1)
    await expect(stub).toHaveAttribute('data-embed-stub', 'depth')
    await expect(stub).toContainText('Nested too deep')

    await stub.getByRole('button', { name: 'Open source' }).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
  })
})
