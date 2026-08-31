/**
 * E2E for the structural transforms in the "Turn into" menu (#253, #1960).
 *
 * The standalone Ordered list / Divider / Callout toolbar buttons were
 * REPLACED by the Turn into (Pilcrow) menu (#1960). These tests open that menu
 * and click the entries — which dispatch `TURN_INTO_BLOCK` / `INSERT_DIVIDER`
 * to the same content-edit path the matching slash commands use — and assert
 * the focused block's content actually changes.
 *
 * The two list entries are the exception since #4552 slice 2: they no longer
 * write a `1. ` / `- ` prefix into the content (nor produce an in-block
 * <ol>/<ul>). They set the block-level `listStyle` property, and the marker is
 * drawn from it by the read pipeline — so those two assert the rendered marker
 * and a bare text, not a list node.
 */

import { expect, test } from '@playwright/test'

import { focusBlock, openPage, reopenPage, saveBlock, waitForBoot } from './helpers'

/** Open the Turn into popover from the focused block's toolbar. */
async function openTurnInto(page: import('@playwright/test').Page) {
  await page
    .locator('[data-testid="block-editor"]')
    .getByRole('button', { name: 'Turn into', exact: true })
    .click()
}

test.describe('Structural transforms via Turn into (#253, #1960)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Divider entry turns the focused block into a horizontal rule', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await editor.pressSequentially('divider test')

    await openTurnInto(page)
    await page.getByRole('menuitem', { name: 'Divider' }).click()
    await saveBlock(page)

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await expect(firstBlock.locator('[data-testid="horizontal-rule"]')).toBeVisible()
  })

  test('Ordered list entry sets listStyle=ordered and renders a "1." marker', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await editor.pressSequentially('first item')

    await openTurnInto(page)
    await page.getByRole('menuitemradio', { name: 'Ordered list' }).click()

    // #4552 slice 2 — the entry writes the `listStyle` block property; the
    // content edit it still performs strips markers rather than adding one,
    // so the block's text stays bare (no `1. ` prefix, no in-block <ol>).
    await expect(editor).toHaveText('first item')
    await expect(editor.locator('ol, ul, li')).toHaveCount(0)

    await saveBlock(page, 'Escape')
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await expect(firstBlock).toContainText('first item')
    await expect(firstBlock.locator('ol, ul, li')).toHaveCount(0)

    // The `1.` is drawn by the read pipeline from the property. It is asserted
    // after a reopen because the JS tauri mock emits no
    // `block:properties-changed` event, so the property batch this marker
    // reads only refetches on the next mount (a mock↔backend gap, not a
    // product one) — and the reopen additionally proves the style persisted.
    await reopenPage(page, 'Getting Started')
    await expect(firstBlock.getByTestId('list-marker')).toHaveText('1.')
    await expect(firstBlock).toContainText('first item')
    await expect(firstBlock).not.toContainText('1. first item')
  })

  test('Bullet list entry sets listStyle=bullet and renders a "•" marker (#1959)', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await editor.pressSequentially('a bullet')

    await openTurnInto(page)
    await page.getByRole('menuitemradio', { name: 'Bullet list' }).click()

    // #4552 slice 2 — as above: the property carries list-ness, the text
    // keeps no `- ` prefix and the block grows no in-block <ul>.
    await expect(editor).toHaveText('a bullet')
    await expect(editor.locator('ol, ul, li')).toHaveCount(0)

    await saveBlock(page, 'Escape')
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await expect(firstBlock).toContainText('a bullet')
    await expect(firstBlock.locator('ol, ul, li')).toHaveCount(0)

    await reopenPage(page, 'Getting Started')
    await expect(firstBlock.getByTestId('list-marker')).toHaveText('•')
    await expect(firstBlock).toContainText('a bullet')
    await expect(firstBlock).not.toContainText('- a bullet')
  })

  test('Callout entry converts the focused block to a callout', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await editor.pressSequentially('heads up')

    // #3001 — Turn into → Callout is a single-step disclosure: opening it
    // expands the variant picker in place; pick a variant (info) to convert the
    // block to a callout in one interaction.
    await openTurnInto(page)
    await page.getByRole('menuitem', { name: 'Callout', exact: true }).click()
    await page.getByTestId('callout-type-info').click()

    const quote = editor.locator('blockquote')
    await expect(quote).toBeVisible()
    await expect(quote).toContainText('heads up')
  })
})
