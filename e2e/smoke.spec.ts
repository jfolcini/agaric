import { expect, test } from './helpers'

test.describe('Smoke tests', () => {
  test('app loads and shows Agaric branding', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Agaric', { exact: true })).toBeVisible()
  })

  test('sidebar has all expected nav items', async ({ page }) => {
    await page.goto('/')

    // Wait for the app to boot (BootGate resolves) — use sidebar nav button
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()

    // Nav labels that are always exactly their own text (no count badge).
    const exactNavLabels = ['Journal', 'Pages', 'Tags', 'Status']
    for (const label of exactNavLabels) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible()
    }
    // Conflicts / Trash have optional count badges that become part of the
    // accessible name when non-zero — match on prefix instead of exact.
    await expect(page.getByRole('button', { name: /^Conflicts/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Trash/ })).toBeVisible()
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
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()

    // Filter out known benign errors (e.g., favicon 404)
    const realErrors = errors.filter(
      (e) => !e.includes('favicon') && !e.includes('Failed to load resource'),
    )
    expect(realErrors).toEqual([])
  })
})
