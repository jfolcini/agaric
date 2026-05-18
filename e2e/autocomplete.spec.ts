/**
 * PEND-60 Phase 3 — Playwright e2e for caret-anchored autocomplete.
 *
 * The unit + component layers (caret-anchor.test.ts /
 * AutocompletePopover.test.tsx) and the SearchPanel-integration vitest
 * layer (SearchPanel.autocomplete.test.tsx) cover the wire-up in
 * jsdom; this spec covers the happy path against the real Vite dev
 * server + Chromium so we catch any Radix-portal / cmdk-id issues
 * that don't surface in happy-dom.
 */

import { expect, test } from '@playwright/test'
import { waitForBoot } from './helpers'

test.describe('Autocomplete (PEND-60)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Search', exact: true })
      .click()
    await expect(page.locator('[data-testid="header-label"]', { hasText: 'Search' })).toBeVisible()
  })

  test('opens the popover with state values when typing `state:`', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks (3+ chars)...')
    await input.click()
    await input.fill('state:')

    const popover = page.getByTestId('autocomplete-popover')
    await expect(popover).toBeVisible()

    for (const value of ['TODO', 'DOING', 'DONE', 'WAITING', 'CANCELLED', 'none']) {
      await expect(page.getByTestId(`autocomplete-item-${value}`)).toBeVisible()
    }
  })

  test('clicking a value inserts it with a trailing space', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks (3+ chars)...')
    await input.click()
    await input.fill('state:')

    const popover = page.getByTestId('autocomplete-popover')
    await expect(popover).toBeVisible()

    await page.getByTestId('autocomplete-item-TODO').click()

    await expect(input).toHaveValue('state:TODO ')
  })

  test('keyboard ArrowDown + Enter applies the second value', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks (3+ chars)...')
    await input.click()
    await input.fill('state:')

    const popover = page.getByTestId('autocomplete-popover')
    await expect(popover).toBeVisible()
    // Ensure the first item is highlighted before driving ArrowDown so the
    // step lands deterministically on the second item (DOING).
    await expect(page.getByTestId('autocomplete-item-TODO')).toHaveAttribute(
      'aria-selected',
      'true',
    )

    await input.press('ArrowDown')
    await input.press('Enter')

    await expect(input).toHaveValue('state:DOING ')
  })

  test('Escape closes the popover and keeps focus on the input', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks (3+ chars)...')
    await input.click()
    await input.fill('state:')

    const popover = page.getByTestId('autocomplete-popover')
    await expect(popover).toBeVisible()

    await input.press('Escape')

    await expect(popover).not.toBeVisible()
    await expect(input).toBeFocused()
  })

  test('wires ARIA combobox attrs to the live cmdk listbox / option ids', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks (3+ chars)...')
    await input.click()

    // Pre-open ARIA snapshot. The combobox role + supporting attrs are
    // stable; aria-expanded is false until the popover reports live ids.
    await expect(input).toHaveAttribute('role', 'combobox')
    await expect(input).toHaveAttribute('aria-autocomplete', 'list')
    await expect(input).toHaveAttribute('aria-haspopup', 'listbox')
    await expect(input).toHaveAttribute('aria-expanded', 'false')

    await input.fill('state:')

    const popover = page.getByTestId('autocomplete-popover')
    await expect(popover).toBeVisible()
    // aria-expanded flips true once the popover has reported the live
    // cmdk-generated listbox id (one effect tick after `autocompleteOpen`).
    await expect(input).toHaveAttribute('aria-expanded', 'true')

    const listboxId = await input.getAttribute('aria-controls')
    expect(listboxId).toBeTruthy()
    await expect(page.locator(`[role="listbox"]#${listboxId}`)).toHaveCount(1)

    const activeDescendantId = await input.getAttribute('aria-activedescendant')
    expect(activeDescendantId).toBeTruthy()
    const activeOption = page.locator(`[role="option"]#${activeDescendantId}`)
    await expect(activeOption).toHaveCount(1)
    await expect(activeOption).toHaveAttribute('aria-selected', 'true')
  })
})
