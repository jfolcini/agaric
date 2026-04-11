import { expect, test } from '@playwright/test'

test.describe('Smoke tests', () => {
  test('app loads and shows Agaric branding', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Agaric', { exact: true })).toBeVisible()
  })

  test('sidebar has all expected nav items', async ({ page }) => {
    await page.goto('/')

    // Wait for the app to boot (BootGate resolves) — use sidebar nav button
    await expect(page.getByRole('button', { name: 'Journal' })).toBeVisible()

    const navLabels = ['Journal', 'Pages', 'Tags', 'Trash', 'Status', 'Conflicts']
    for (const label of navLabels) {
      await expect(page.getByRole('button', { name: label })).toBeVisible()
    }
  })

  test('no console errors on load', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text())
      }
    })

    await page.goto('/')
    // Wait for the app to fully boot — use sidebar nav button
    await expect(page.getByRole('button', { name: 'Journal' })).toBeVisible()

    // Filter out known benign errors (e.g., favicon 404)
    const realErrors = errors.filter(
      (e) => !e.includes('favicon') && !e.includes('Failed to load resource'),
    )
    expect(realErrors).toEqual([])
  })
})
