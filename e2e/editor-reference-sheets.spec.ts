/**
 * Page mode's footer hint opens two references against the mock backend:
 * "Supports Markdown" the Markdown the editor reads, "Type / for commands"
 * every slash command. Each closes back to the editor, and both still open
 * after navigating away and back.
 */

import type { Page } from '@playwright/test'

import { expect, ipc, test, waitForBoot } from './helpers'

const EDITOR = '[data-testid="page-mode-editor"]'

async function openInPageMode(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Control+k')
  const input = page.locator('[cmdk-input]').first()
  await input.fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: 'Page' })
    .click()
  await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(1)
}

async function expectBothReferencesOpen(page: Page): Promise<void> {
  await page.locator(EDITOR).click()

  await page.getByRole('button', { name: 'Supports Markdown' }).click()
  const markdown = page.getByRole('dialog', { name: 'Markdown' })
  await expect(markdown.getByText('**bold**', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(markdown).toBeHidden()
  await expect(page.locator(EDITOR)).toBeFocused()

  await page.getByRole('button', { name: 'Type / for commands' }).click()
  const commands = page.getByRole('dialog', { name: 'Slash commands' })
  await expect(
    commands.getByRole('region', { name: 'Formatting' }).getByText('BOLD', { exact: true }),
  ).toBeVisible()
  await commands.getByRole('textbox', { name: 'Filter commands' }).fill('zzzz')
  await expect(commands.getByText('Nothing matches “zzzz”')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(commands).toBeHidden()
  await expect(page.locator(EDITOR)).toBeFocused()
}

test.describe('page mode hint references @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the hint opens the Markdown and slash-command references, before and after navigating away', async ({
    page,
  }) => {
    for (const title of ['Reference one', 'Reference two']) {
      const pageId = await ipc<string>(page, 'create_page_in_space', {
        parentId: null,
        content: title,
        spaceId: 'SPACE_PERSONAL',
      })
      await ipc(page, 'create_block', {
        blockType: 'content',
        content: 'Some text',
        parentId: pageId,
        index: null,
        scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
      })
    }
    await openInPageMode(page, 'Reference one')
    await expectBothReferencesOpen(page)

    // Leave the text: Ctrl+K in it edits a link.
    await page.keyboard.press('Escape')
    await openInPageMode(page, 'Reference two')
    await openInPageMode(page, 'Reference one')
    await expectBothReferencesOpen(page)
  })
})
