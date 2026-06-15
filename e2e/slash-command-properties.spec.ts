import { expect, focusBlock, openPage, reopenPage, test, waitForBoot } from './helpers'

/**
 * E2E for the slash-command PROPERTY pickers (#1169 — remaining e2e category).
 *
 * The unit suites (`useSlashCommandProperty.test.ts`, `useSlashCommandDate.test.ts`,
 * `slash-commands.test.ts`) already cover every preset id and the dispatch tables.
 * This spec proves the *picker → persist* path per category through the real
 * editor + Tauri-mock harness: type the command, the picker (date-picker dialog
 * OR the progressive-disclosure suggestion list of presets) becomes visible,
 * choose a value, then assert the rendered chip/indicator — and that it SURVIVES
 * a navigate-away-and-back (`reopenPage`) which forces `BlockTree` to re-fetch
 * the block + its `block_properties` from the mock backend.
 *
 * Two picker shapes are exercised:
 *   - `/due` opens the floating `date-picker-popup` Dialog (a real calendar +
 *     natural-language text input). Selecting a date sets `due_date` (optimistic
 *     + persisted) and renders the `.due-date-chip` button.
 *   - `/effort`, `/assignee`, `/location`, `/repeat` surface their preset values
 *     INLINE in the slash suggestion list (the "picker" here is the
 *     progressive-disclosure list — there is no separate dialog). Selecting a
 *     preset writes `block_properties` and the chip renders after the re-fetch:
 *       · effort/assignee/location → generic `PropertyChip` (`property-chip`)
 *       · repeat → the dedicated `.repeat-indicator` status chip
 *
 * Why presets (not the bare `/assignee` / `/location` exact commands): the exact
 * commands intentionally set an EMPTY value and route to the property editor,
 * and `useBlockPropertiesBatch` drops empty-valued props — so no chip renders.
 * The preset path (`assignee-me`, `location-office`, `effort-1h`, `repeat-daily`)
 * writes a real value, which is what makes the persisted chip observable.
 *
 * `/date` (insert inline date link) is intentionally DROPPED here — see the note
 * at the end of the file for why its persisted UI isn't reliably observable in
 * this harness.
 */

// Type ` /` to open the slash list, then the query, WITHOUT relying on the
// auto-exec timer: a multi-item query keeps the popup open so we can click the
// exact preset. (The shared `typeSlashCommand` helper asserts the list opens on
// the empty `/`; here we additionally type a query that matches several items so
// the single-match auto-exec never fires before our explicit click.)
async function openSlashList(page: import('@playwright/test').Page, query: string) {
  await page.keyboard.press('End')
  await page.keyboard.type(' /', { delay: 30 })
  const list = page.locator('[data-testid="suggestion-list"]')
  await expect(list).toBeVisible()
  await page.keyboard.type(query, { delay: 30 })
  return list
}

test.describe('Slash-command property pickers (#1169)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  // -------------------------------------------------------------------------
  // /due — date-picker DIALOG → due-date chip
  // -------------------------------------------------------------------------
  test('/due opens the date picker; picking a date sets a due-date chip that persists', async ({
    page,
  }) => {
    await focusBlock(page)
    await openSlashList(page, 'due')

    // Anchor on the picker item id (case-insensitive hasText "due" is ambiguous
    // vs "Schedule" labels containing "date").
    const dueItem = page.locator('#suggestion-due')
    await expect(dueItem).toBeVisible()
    await dueItem.click()

    // The picker DIALOG becomes visible.
    const picker = page.locator('[data-testid="date-picker-popup"]')
    await expect(picker).toBeVisible()

    // Pick "today" via the natural-language input + Enter (most deterministic).
    const input = picker.getByRole('textbox')
    await input.fill('today')
    await page.keyboard.press('Enter')
    await expect(picker).not.toBeVisible()

    // Due-date chip renders (optimistic) — it only mounts when due_date is set.
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await expect(firstBlock.locator('.due-date-chip')).toBeVisible()

    // …and survives a re-fetch.
    await reopenPage(page, 'Getting Started')
    await expect(
      page.locator('[data-testid="sortable-block"]').first().locator('.due-date-chip'),
    ).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // /effort — preset list → effort property chip
  // -------------------------------------------------------------------------
  test('/effort 1h sets an effort property chip that persists', async ({ page }) => {
    await focusBlock(page)
    const list = await openSlashList(page, 'effort')

    // The picker (suggestion list) discloses the effort presets.
    const effort1h = list.locator('[data-testid="suggestion-item"]', { hasText: 'EFFORT 1h' })
    await expect(effort1h).toBeVisible()
    await effort1h.click()

    // No optimistic chip for property presets — it renders after the re-fetch.
    await reopenPage(page, 'Getting Started')
    const chip = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="property-chip"]')
      .filter({ hasText: '1h' })
    await expect(chip).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // /assignee — preset list → assignee property chip
  // -------------------------------------------------------------------------
  test('/assignee Me sets an assignee property chip that persists', async ({ page }) => {
    await focusBlock(page)
    const list = await openSlashList(page, 'assignee')

    const assigneeMe = list.locator('[data-testid="suggestion-item"]', { hasText: 'ASSIGNEE Me' })
    await expect(assigneeMe).toBeVisible()
    await assigneeMe.click()

    await reopenPage(page, 'Getting Started')
    const chip = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="property-chip"]')
      .filter({ hasText: 'Me' })
    await expect(chip).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // /location — preset list → location property chip
  // -------------------------------------------------------------------------
  test('/location Office sets a location property chip that persists', async ({ page }) => {
    await focusBlock(page)
    const list = await openSlashList(page, 'location')

    const locOffice = list.locator('[data-testid="suggestion-item"]', {
      hasText: 'LOCATION Office',
    })
    await expect(locOffice).toBeVisible()
    await locOffice.click()

    await reopenPage(page, 'Getting Started')
    const chip = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="property-chip"]')
      .filter({ hasText: 'Office' })
    await expect(chip).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // /repeat — cadence list → repeat indicator
  // -------------------------------------------------------------------------
  test('/repeat daily sets a repeat indicator that persists', async ({ page }) => {
    await focusBlock(page)
    // Query just "repeat" (not "repeat daily"): the cadence + anchoring presets
    // all match, so the multi-item list stays open for an explicit click instead
    // of the single-match auto-exec firing. "REPEAT DAILY" matches both the
    // plain-cadence and the "(from completion)/(catch-up)" anchoring variants —
    // `.first()` pins the plain `repeat-daily` cadence item.
    const list = await openSlashList(page, 'repeat')

    const repeatDaily = list.locator('[data-testid="suggestion-item"]', {
      hasText: 'REPEAT DAILY — Every day',
    })
    await expect(repeatDaily).toBeVisible()
    await repeatDaily.click()

    await reopenPage(page, 'Getting Started')
    await expect(
      page.locator('[data-testid="sortable-block"]').first().locator('.repeat-indicator'),
    ).toBeVisible()
  })
})

/**
 * DROPPED: `/date` (insert inline date link).
 *
 * Unlike the property commands above, `/date` does NOT set a block property — it
 * finds/creates a dedicated "date page" and inserts a `[[<page-id>]]` block LINK
 * into the editor's inline content (`handleDateMode` → `insertBlockLink`). The
 * link only persists if the block is then committed (blur/save), and what renders
 * afterward is an inline reference span inside the block body, not a stable
 * property chip/attribute. The date-page creation + inline-ref render round-trip
 * has no harness-stable testid for the inserted link distinct from the seeded
 * `[[…]]` links already present on the "Getting Started" page, so a persistence
 * assertion here would be ambiguous rather than load-bearing. The picker-OPEN
 * half of `/date` is already covered by `slash-commands.spec.ts`
 * ("/date opens the date picker"); the per-category picker→persist proof for the
 * remaining commands is what this file adds.
 */
