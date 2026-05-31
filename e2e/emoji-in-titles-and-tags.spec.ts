/**
 * Regression guard (#130): emoji must work in page titles and tag names.
 *
 * We deliberately did NOT build dedicated page/tag emoji-icon fields
 * (parked: #283, #284) on the basis that a user can already put an emoji
 * directly in the page *title* text and in a *tag name*. These tests lock
 * that justification in — emoji are plain Unicode, so the title
 * contentEditable and the tag-create path must carry them intact.
 */
import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

const PARTY = '\u{1F389}' // 🎉
const ROCKET = '\u{1F680}' // 🚀

test.describe('Emoji in titles & tags (#130)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('a page title accepts and keeps an emoji', async ({ page }) => {
    const title = page.locator('[aria-label="Page title"]')
    await title.click()
    // Append an emoji to the existing title (avoids renaming the page away
    // from the title other tests/navigation rely on).
    await page.keyboard.press('End')
    await page.keyboard.type(` ${PARTY}`)
    // Blur to the editor body so the title commits.
    await focusBlock(page)

    await expect(title).toContainText(PARTY)
    await expect(title).toContainText('Getting Started')
  })

  test('a tag can be created with an emoji in its name', async ({ page }) => {
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await editor.type(`ship it @${ROCKET}rocket`, { delay: 30 })

    const list = page.locator('[data-testid="suggestion-list"]')
    await expect(list).toBeVisible({ timeout: 5000 })
    const createItem = list.locator('[data-testid="suggestion-item"]', { hasText: /[Cc]reate/ })
    await expect(createItem).toBeVisible({ timeout: 5000 })
    await createItem.click()

    const chip = editor.locator('[data-testid="tag-ref-chip"]')
    await expect(chip).toBeVisible({ timeout: 5000 })
    await expect(chip).toContainText(ROCKET)
  })
})
