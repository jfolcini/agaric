import { expect, test, waitForBoot } from './helpers'

/**
 * E2E — keyboard shortcut customization (#2709).
 *
 * `e2e/settings.spec.ts:78-88` only asserts the Keyboard tab renders and
 * shows one `<kbd>` element; `e2e/keyboard-shortcuts.spec.ts` and
 * `e2e/keyboard-collisions.spec.ts` exercise only the DEFAULT bindings. No
 * spec ever recorded a new binding, triggered the conflict UI, reset a
 * shortcut, or proved a rebound key actually fires (and the old one stops).
 *
 * Nothing here is mock-blocked: keyboard customization is pure
 * `localStorage` (`src/lib/keyboard-config/storage.ts`, key
 * `agaric-keyboard-shortcuts`) + real DOM keydown events — no Tauri IPC is
 * involved, so every flow the docs promise is drivable end-to-end.
 *
 * The Settings → Keyboard editor is a typed `<Input>` behind a Pencil
 * button (`aria-label="Edit shortcut for {action}"`), NOT a keystroke-
 * capture control — `KeyboardTab.tsx:141-165` confirms `onChange` on a
 * plain text field, saved via Enter or the Save button.
 */

async function openKeyboardSettings(page: import('@playwright/test').Page) {
  await waitForBoot(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Keyboard' }).click()
  await expect(page.locator('[data-testid="settings-panel-keyboard"]')).toBeVisible()
  await expect(page.locator('[data-testid="keyboard-settings-tab"]')).toBeVisible()
}

/**
 * Locate a shortcut's row by its (translated) description text.
 *
 * `KeyboardTab.tsx:132-137` renders one row `<div>` per catalog entry whose
 * DIRECT children are the keys/description/actions columns — only the row
 * div itself has `[data-testid="kbd-keys-column"]` as a direct child (every
 * ancestor — ScrollArea/Card/CardContent/etc — only contains it as a deep
 * descendant), so `:has(> ...)` pins to exactly the repeated row elements,
 * and `.filter({ hasText })` narrows to the one matching shortcut.
 */
function shortcutRow(page: import('@playwright/test').Page, description: string) {
  return page.locator('div:has(> [data-testid="kbd-keys-column"])').filter({ hasText: description })
}

test.describe('Keyboard shortcut customization', () => {
  test('recording a new binding updates the display, and the new binding fires while the old default no longer does', async ({
    page,
  }) => {
    await openKeyboardSettings(page)
    const row = shortcutRow(page, 'Toggle sidebar')

    await row.getByRole('button', { name: 'Edit shortcut for Toggle sidebar' }).click()
    const input = row.getByPlaceholder('Type new key binding...')
    await expect(input).toBeVisible()
    await input.fill('Ctrl + Alt + B')
    await row.getByRole('button', { name: 'Save', exact: true }).click()

    // Display updated: the new modifier shows, and the "Customized" badge
    // appears (KeyboardTab.tsx:198-205).
    await expect(row.getByTestId('kbd-keys-column')).toContainText('Alt')
    await expect(row.getByText('Customized')).toBeVisible()

    const sidebar = page.locator('[data-slot="sidebar"]')
    const initialState = await sidebar.getAttribute('data-state')

    // Old default (Ctrl+B) no longer toggles the sidebar — it now requires Alt too.
    await page.keyboard.down('Control')
    await page.keyboard.press('b')
    await page.keyboard.up('Control')
    await expect(sidebar).toHaveAttribute('data-state', initialState ?? '')

    // New binding (Ctrl+Alt+B) does fire the action.
    await page.keyboard.down('Control')
    await page.keyboard.down('Alt')
    await page.keyboard.press('b')
    await page.keyboard.up('Alt')
    await page.keyboard.up('Control')
    await expect(sidebar).not.toHaveAttribute('data-state', initialState ?? '')
  })

  test('recording a binding already in use shows the inline conflict', async ({ page }) => {
    await openKeyboardSettings(page)
    // "Create new page" (default Ctrl+N) and "Find in current page" (Ctrl+F)
    // are both wildcard, same-category bindings (catalog.ts:487-491,541-545)
    // — rebinding one onto the other's chord trips findConflicts' exact
    // same-triple pass with no `condition` complexity to account for.
    const createRow = shortcutRow(page, 'Create new page')

    await createRow.getByRole('button', { name: 'Edit shortcut for Create new page' }).click()
    await createRow.getByPlaceholder('Type new key binding...').fill('Ctrl + F')
    await createRow.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(createRow.getByText('Conflicts with: Find in current page')).toBeVisible()

    // The conflict is symmetric — the other row surfaces it too.
    const findRow = shortcutRow(page, 'Find in current page')
    await expect(findRow.getByText('Conflicts with: Create new page')).toBeVisible()
  })

  test('reset restores the default binding and it works again', async ({ page }) => {
    await openKeyboardSettings(page)
    const row = shortcutRow(page, 'Toggle sidebar')

    await row.getByRole('button', { name: 'Edit shortcut for Toggle sidebar' }).click()
    await row.getByPlaceholder('Type new key binding...').fill('Ctrl + Alt + B')
    await row.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(row.getByText('Customized')).toBeVisible()

    await row.getByRole('button', { name: 'Reset Toggle sidebar to default' }).click()

    await expect(row.getByText('Customized')).toHaveCount(0)
    await expect(row.getByTestId('kbd-keys-column')).not.toContainText('Alt')

    // The default Ctrl+B works again.
    const sidebar = page.locator('[data-slot="sidebar"]')
    const initialState = await sidebar.getAttribute('data-state')
    await page.keyboard.down('Control')
    await page.keyboard.press('b')
    await page.keyboard.up('Control')
    await expect(sidebar).not.toHaveAttribute('data-state', initialState ?? '')
  })

  test('customization persists across reload via localStorage', async ({ page }) => {
    await openKeyboardSettings(page)
    const row = shortcutRow(page, 'Toggle sidebar')

    await row.getByRole('button', { name: 'Edit shortcut for Toggle sidebar' }).click()
    await row.getByPlaceholder('Type new key binding...').fill('Ctrl + Alt + B')
    await row.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(row.getByTestId('kbd-keys-column')).toContainText('Alt')

    const stored = await page.evaluate(() => localStorage.getItem('agaric-keyboard-shortcuts'))
    expect(JSON.parse(stored ?? '{}')).toMatchObject({ toggleSidebar: 'Ctrl + Alt + B' })

    // Reload the SPA (localStorage survives; the in-memory Tauri mock
    // re-seeds fresh from its own bundle re-execution — irrelevant here
    // since keyboard config never touches the mock).
    await page.reload()
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Keyboard' }).click()
    await expect(page.locator('[data-testid="keyboard-settings-tab"]')).toBeVisible()

    const rowAfterReload = shortcutRow(page, 'Toggle sidebar')
    await expect(rowAfterReload.getByTestId('kbd-keys-column')).toContainText('Alt')
    await expect(rowAfterReload.getByText('Customized')).toBeVisible()

    // Still functionally live post-reload.
    const sidebar = page.locator('[data-slot="sidebar"]')
    const initialState = await sidebar.getAttribute('data-state')
    await page.keyboard.down('Control')
    await page.keyboard.down('Alt')
    await page.keyboard.press('b')
    await page.keyboard.up('Alt')
    await page.keyboard.up('Control')
    await expect(sidebar).not.toHaveAttribute('data-state', initialState ?? '')
  })
})
