import { expect, type Page } from '@playwright/test'

/** Wait for the app to fully boot (BootGate resolved, sidebar visible). */
export async function waitForBoot(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Journal' })).toBeVisible()
}

/** Navigate to the page editor for a given page title. */
export async function openPage(page: Page, title: string) {
  await page.getByRole('button', { name: 'Pages' }).click()
  await page.getByText(title, { exact: true }).click()
  await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
}

/** Click a block to enter edit mode and wait for the TipTap editor. */
export async function focusBlock(page: Page, index = 0) {
  await page.locator('.block-static').nth(index).click()
  const editor = page.locator('.block-editor [contenteditable="true"]')
  await expect(editor).toBeVisible({ timeout: 3000 })
  await editor.focus()
  return editor
}

/** Save the current block by pressing Enter (flush content → close editor → static render). */
export async function saveBlock(page: Page) {
  await page.keyboard.press('Enter')
  // Wait for the editor to disappear and static block to re-render
  await expect(page.locator('.block-editor [contenteditable="true"]')).not.toBeVisible({
    timeout: 3000,
  })
}
