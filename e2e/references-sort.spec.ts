/**
 * The References panel's sort: a field picker joined to a direction toggle.
 *
 * Rows re-sort by the picked field in both directions, the default order
 * reverses without picking a field first, and the picker never offers the
 * app's bookkeeping keys (`is_space` on space blocks, the retired
 * `personal_to_work_migration_v1` marker old installs still carry) nor a
 * property whose type has no order. The mock's member sort is pinned to the
 * backend by `conformance/fixtures/query_backlinks_grouped_sort.json`.
 */

import type { Page } from '@playwright/test'

import { expect, openPage, seedSearchBlocks, test, waitForBoot } from './helpers'

const GETTING_STARTED = '00000000000000000000PAGE01'

/** Three notes on Projects linking to Getting Started: created A, B, C; due B, A; C has none. */
async function seedNotes(page: Page): Promise<void> {
  await seedSearchBlocks(page, [
    { content: `Sort note A on [[${GETTING_STARTED}]]`, due: '2026-03-01' },
    { content: `Sort note B on [[${GETTING_STARTED}]]`, due: '2026-01-01' },
    { content: `Sort note C on [[${GETTING_STARTED}]]` },
  ])
}

async function openReferences(page: Page) {
  await openPage(page, 'Getting Started')
  const references = page.getByTestId('linked-references')
  await expect(references).toBeVisible()
  return references
}

test.describe('References sort', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await seedNotes(page)
  })

  test('sorts by a picked field in both directions', async ({ page }) => {
    const references = await openReferences(page)
    const notes = references.getByText(/Sort note [ABC]/)
    await expect(notes).toHaveText([/note A/, /note B/, /note C/])

    await references.getByRole('combobox', { name: 'Sort by' }).click()
    await page.getByRole('option', { name: 'Due date' }).click()
    // Earliest due first; C has no due date and stays last in both directions.
    await expect(notes).toHaveText([/note B/, /note A/, /note C/])

    const toggle = references.getByRole('button', { name: 'Sorted ascending, click to reverse' })
    await toggle.click()
    await expect(notes).toHaveText([/note A/, /note B/, /note C/])
    await expect(
      references.getByRole('button', { name: 'Sorted descending, click to reverse' }),
    ).toBeFocused()
  })

  test('reverses the default order from the keyboard', async ({ page }) => {
    const references = await openReferences(page)
    const notes = references.getByText(/Sort note [ABC]/)
    await expect(notes).toHaveText([/note A/, /note B/, /note C/])

    await references.getByRole('button', { name: 'Sorted ascending, click to reverse' }).focus()
    await page.keyboard.press('Enter')
    await expect(notes).toHaveText([/note C/, /note B/, /note A/])
    // The re-query keeps focus on the toggle, so a second press reverses it back.
    await expect(
      references.getByRole('button', { name: 'Sorted descending, click to reverse' }),
    ).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(notes).toHaveText([/note A/, /note B/, /note C/])
  })

  test('never offers bookkeeping keys or unordered property types', async ({ page }) => {
    await page.evaluate(async () => {
      const { invoke } = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__
      await invoke('set_property', {
        blockId: 'SPACE_PERSONAL',
        key: 'personal_to_work_migration_v1',
        value: { value_text: 'true' },
      })
    })
    const references = await openReferences(page)

    await references.getByRole('combobox', { name: 'Sort by' }).click()
    const listbox = page.getByRole('listbox')
    // `effort` is a seeded select definition: the property group has loaded.
    await expect(listbox.getByRole('option', { name: 'effort' })).toBeVisible()
    await expect(listbox.getByRole('option', { name: 'Due date' })).toBeVisible()
    for (const key of [
      'is_space',
      'personal_to_work_migration_v1',
      'accent_color',
      'listStyle',
      'completed_at',
      // A seeded `text` definition: byte order is not a useful order.
      'assignee',
    ]) {
      await expect(listbox.getByRole('option', { name: key, exact: true })).toHaveCount(0)
    }
  })
})
