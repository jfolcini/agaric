import type { Page } from '@playwright/test'

import { expect, test } from './helpers'

// #6488 — the integrity report in plain words. The mock keeps no derived
// tables, so it can never diverge; this stubs the two report IPCs with the
// state a vault indexed before 0.23.0's strip change holds: search rows the
// old rule wrote, which a rebuild rewrites. That the backend rebuild clears
// them is the Rust test `rebuild_rewrites_every_stale_cache_6488`.

const STALE_TEXT = 'Planning notes for the spring trip'

const STALE_SEARCH_INDEX = {
  blocks_scanned: 2441,
  today: '2026-11-11',
  total_divergences: 27,
  artefacts: [
    {
      artefact: 'fts_blocks.stripped',
      count: 27,
      sample_keys: ['01KNHVPXFE9T6SFZMNJXAYAPMJ', '01KQSG9KE56Q3NX40Y7SYZTPV1'],
    },
  ],
  samples: [
    {
      artefact: 'fts_blocks.stripped',
      key: '01KNHVPXFE9T6SFZMNJXAYAPMJ',
      expected: STALE_TEXT,
      actual: '**Planning** notes for the [[01KQSG9KE56Q3NX40Y7SYZTPV1|spring trip]]',
    },
  ],
}

/** Answer the check with `report` and the rebuild with a clean report. */
async function stubIntegrity(page: Page, report: Record<string, unknown>): Promise<void> {
  await page.evaluate((stale) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__
    const invoke = internals.invoke.bind(internals)
    internals.invoke = (c, a) => {
      if (c === 'compute_reconciliation_report') return Promise.resolve(stale)
      if (c === 'rebuild_derived_state') {
        return Promise.resolve({ ...stale, total_divergences: 0, artefacts: [], samples: [] })
      }
      return invoke(c, a)
    }
  }, report)
}

test.describe('Integrity report in plain words @settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await stubIntegrity(page, STALE_SEARCH_INDEX)
    await page.getByRole('tab', { name: 'App health' }).click()
  })

  test('says the search index is out of date, shows the stale text, and rebuilds it', async ({
    page,
  }) => {
    const panel = page.locator('[data-testid="settings-panel-status"]')
    await panel.getByRole('button', { name: 'Run check' }).click()

    await expect(panel.getByTestId('integrity-summary')).toHaveText(
      '27 rows in the search index are out of date (rebuildable). 2441 blocks checked on 2026-11-11.',
    )
    const group = panel.getByTestId('integrity-group-rebuildable')
    await expect(
      group.getByRole('heading', { name: 'Out-of-date caches (rebuildable)' }),
    ).toBeVisible()
    await expect(group.getByText('Search index: text indexed with an older rule')).toBeVisible()
    await expect(group.getByTestId('integrity-sample')).toContainText(`Rebuilt: ${STALE_TEXT}`)

    await panel.getByRole('button', { name: 'Rebuild caches' }).click()

    await expect(panel.getByText('Everything matches')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Rebuild caches' })).toHaveCount(0)
  })

  test('a bug report carries the group and the keys, never the stale text', async ({ page }) => {
    const panel = page.locator('[data-testid="settings-panel-status"]')
    await panel.getByRole('button', { name: 'Run check' }).click()
    await expect(panel.getByTestId('integrity-summary')).toBeVisible()

    await panel.getByRole('button', { name: 'Report a bug' }).click()

    const preview = page.getByTestId('bug-report-preview')
    await expect(preview).toContainText('### Out-of-date caches (rebuildable)')
    await expect(preview).toContainText(
      '`fts_blocks.stripped` — 27 rows: 01KNHVPXFE9T6SFZMNJXAYAPMJ, 01KQSG9KE56Q3NX40Y7SYZTPV1',
    )
    await expect(preview).not.toContainText(STALE_TEXT)
  })
})
