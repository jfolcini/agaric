import { expect, test } from './helpers'

const TITLE = 'Outline long page'

/**
 * #5329 — rows past a tree's initial render window are placeholders of
 * estimated height until they scroll into view. An outline click that
 * smooth-scrolled to the center of an unvisited heading hydrated every row on
 * the way, each grew past its estimate, and the heading ended screens below.
 */
test('the outline brings a heading far down a long page into view', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-testid="block-static"]').first().waitFor()
  await page.evaluate(async (title) => {
    const internals = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] as {
      invoke: (cmd: string, args: unknown) => Promise<unknown>
    }
    const parentId = await internals.invoke('create_page_in_space', {
      parentId: null,
      content: title,
      spaceId: 'SPACE_PERSONAL',
    })
    await internals.invoke('create_blocks_batch', {
      specs: Array.from({ length: 500 }, (_, i) => ({
        blockType: 'content',
        // Wrapped paragraphs, so a row's real height is well past the estimate.
        content: i % 25 === 0 ? `# Heading ${i}` : `row ${i} ${'lorem ipsum '.repeat(20)}`,
        parentId,
        position: null,
      })),
    })
  }, TITLE)

  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(TITLE)
  await page.locator('[cmdk-item]').filter({ hasText: TITLE }).first().click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(TITLE)
  await page.locator('[data-testid="block-static"]').nth(10).waitFor()

  await page.getByRole('button', { name: 'Open outline' }).click()
  await page.getByRole('button', { name: 'Heading 450', exact: true }).click()

  await expect(
    page.locator('[data-testid="block-static"]').filter({ hasText: 'Heading 450' }),
  ).toBeInViewport()
})
