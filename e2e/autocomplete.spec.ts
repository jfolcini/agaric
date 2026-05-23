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
    const input = page.getByPlaceholder('Search blocks...')
    await input.click()
    await input.fill('state:')

    const popover = page.getByTestId('autocomplete-popover')
    await expect(popover).toBeVisible()

    for (const value of ['TODO', 'DOING', 'DONE', 'WAITING', 'CANCELLED', 'none']) {
      await expect(page.getByTestId(`autocomplete-item-${value}`)).toBeVisible()
    }
  })

  test('clicking a value inserts it with a trailing space', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks...')
    await input.click()
    await input.fill('state:')

    const popover = page.getByTestId('autocomplete-popover')
    await expect(popover).toBeVisible()

    await page.getByTestId('autocomplete-item-TODO').click()

    await expect(input).toHaveValue('state:TODO ')
  })

  test('keyboard ArrowDown + Enter applies the second value', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks...')
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
    const input = page.getByPlaceholder('Search blocks...')
    await input.click()
    await input.fill('state:')

    const popover = page.getByTestId('autocomplete-popover')
    await expect(popover).toBeVisible()

    await input.press('Escape')

    await expect(popover).not.toBeVisible()
    await expect(input).toBeFocused()
  })

  // ── PEND-58f E2E-10 — dynamic autocomplete sources ──────────────────
  //
  // The `state:` happy path above covers the static source. These cover the
  // three *dynamic* sources the audit flagged as untested e2e: tag names via
  // the `list_tags_by_prefix` IPC, the `path:` MRU history, and property keys
  // via `list_property_keys`.

  test('tag: anchor lists seed tag names from the list_tags_by_prefix IPC', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks...')
    await input.click()
    // Bare `tag:` (no leading hash) is a valid anchor; the value drives the
    // server-side prefix filter.
    await input.fill('tag:')

    const popover = page.getByTestId('autocomplete-popover')
    await expect(popover).toBeVisible()
    // Seed tags: work / personal / idea.
    for (const name of ['work', 'personal', 'idea']) {
      await expect(page.getByTestId(`autocomplete-item-${name}`)).toBeVisible()
    }
  })

  test('tag: anchor narrows to the typed prefix', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks...')
    await input.click()
    await input.fill('tag:#wo')

    const popover = page.getByTestId('autocomplete-popover')
    await expect(popover).toBeVisible()
    await expect(page.getByTestId('autocomplete-item-work')).toBeVisible()
    await expect(page.getByTestId('autocomplete-item-personal')).toHaveCount(0)
  })

  test('prop: anchor lists property keys from list_property_keys', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks...')
    await input.click()
    await input.fill('prop:')

    const popover = page.getByTestId('autocomplete-popover')
    await expect(popover).toBeVisible()
    // Seed property keys include `context` and `project`.
    await expect(page.getByTestId('autocomplete-item-context')).toBeVisible()
    await expect(page.getByTestId('autocomplete-item-project')).toBeVisible()
  })

  test('path: anchor surfaces the per-space MRU after a submit records it', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks...')
    await input.click()
    // Submit a query carrying a path: token — `recordPathHistory` writes the
    // glob to the per-space MRU on submit.
    await input.fill('hello path:Journal/2026-*')
    await input.press('Enter')

    // Now re-anchor on `path:` with a matching prefix; the MRU entry surfaces.
    await input.fill('path:J')
    const popover = page.getByTestId('autocomplete-popover')
    await expect(popover).toBeVisible()
    await expect(page.getByTestId('autocomplete-item-Journal/2026-*')).toBeVisible()
  })

  test('wires ARIA combobox attrs to the live cmdk listbox / option ids', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks...')
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
