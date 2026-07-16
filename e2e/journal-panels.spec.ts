import { expect, getInvokeCalls, installIpcRecorder, test, waitForBoot } from './helpers'

/**
 * E2E tests for journal daily-view panels that agenda-advanced.spec.ts never
 * exercised (#2708): the Done panel, the UnfinishedTasks rollover section, the
 * RescheduleDropZone (native HTML5 drag target in weekly view), and projected
 * repeat occurrences.
 *
 * Seed data (tauri-mock.ts / seed.ts) relevant here:
 *   PAGE_PROJECTS ("Projects") — BLOCK_PROJ_3 "Update dependencies", DONE,
 *     `completed_at` = today. NOT excluded from today's Done panel (its
 *     parent is PAGE_PROJECTS, not today's own daily page), so it is the
 *     one seeded item the Done panel is expected to show without any setup.
 *   PAGE_PROJECTS also owns BLOCK_OVERDUE_1 "Submit report" — TODO, P1,
 *     due_date = yesterday. `list_unfinished_tasks` (handlers.ts) matches
 *     TODO/DOING blocks whose due/scheduled date is before today, so this is
 *     the one seeded item UnfinishedTasks is expected to roll over into
 *     today's "Yesterday" group, and the block this file drags onto the
 *     RescheduleDropZone.
 *
 * Both panels only render in daily mode (DaySection.tsx: `mode === 'daily'`),
 * and the JournalPage mounts exactly one mode's view at a time (daily /
 * weekly / monthly / stream / agenda are mutually exclusive tabpanels). The
 * app therefore defaults to today's daily view on boot, which is where these
 * two panels are asserted below.
 */

/** Local YYYY-MM-DD, matching `date-utils.formatDate` / the seed's `todayDate()`. */
function localDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Seed id — see src/lib/tauri-mock/seed.ts SEED_IDS.BLOCK_OVERDUE_1
// ("Submit report", child of PAGE_PROJECTS, TODO, due_date = yesterday).
const BLOCK_OVERDUE_1 = '0000000000000000000BLOCK19'
const RESCHEDULE_DRAG_TYPE = 'application/x-block-reschedule'

// ===========================================================================
// 1. Done panel
// ===========================================================================

test.describe('Done panel', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a task completed today appears in the Done panel grouped by its source page', async ({
    page,
  }) => {
    // Journal defaults to today's daily view, where DaySection mounts the
    // DonePanel (`#journal-done-panel`).
    const donePanel = page.locator('.done-panel')
    await expect(donePanel).toBeVisible({ timeout: 5000 })

    // Grouped by source page — BLOCK_PROJ_3's parent is "Projects".
    await expect(donePanel.locator('.done-panel-group-header-row')).toContainText('Projects')
    await expect(donePanel.getByText('Update dependencies')).toBeVisible()

    // The completed-icon marker (`showCompletedIcon` / `completedIconClassName`
    // on BlockListItem) renders on every Done-panel row.
    await expect(donePanel.locator('.done-panel-check').first()).toBeVisible()
  })
})

// ===========================================================================
// 2. Unfinished-task rollover
// ===========================================================================

test.describe('Unfinished tasks rollover', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test("yesterday's unfinished TODO appears in today's Unfinished Tasks section", async ({
    page,
  }) => {
    const section = page.getByTestId('unfinished-tasks')
    await expect(section).toBeVisible({ timeout: 5000 })

    // The section defaults to COLLAPSED (`readLegacyCollapsedDefault` returns
    // `true` when no prior preference is stored), so the group content below
    // is not in the accessibility tree until the header is toggled open.
    const header = section.getByRole('button').first()
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'true')

    // Grouped under "Yesterday" (classifyAge in UnfinishedTasks.tsx).
    const yesterdayGroup = page.getByTestId('unfinished-group-yesterday')
    await expect(yesterdayGroup).toBeVisible()
    await expect(yesterdayGroup.getByText('Submit report')).toBeVisible()
  })
})

// ===========================================================================
// 3. Reschedule drop zone
// ===========================================================================
//
// RescheduleDropZone (journal/RescheduleDropZone.tsx) is a NATIVE HTML5 drag
// target (`onDragOver`/`onDrop` reading `e.dataTransfer`), not a dnd-kit
// pointer-drag surface — the existing `dragBlock`/`dragBlockWithOffset`
// helpers (block-dnd-*.spec.ts) drive dnd-kit's synthetic-pointer protocol and
// do not apply here.
//
// It also only mounts in WEEKLY mode (WeeklyView.tsx wraps every day's
// DaySection in one), while the only draggable rows that set the
// `application/x-block-reschedule` MIME type (BlockListItem.tsx `onDragStart`)
// live in DuePanel / DonePanel / UnfinishedTasks / AgendaResults — all of
// which are DAILY- or AGENDA-mode-only (DaySection.tsx gates them on
// `mode === 'daily'`; JournalPage.tsx mounts exactly one mode's view at a
// time). There is therefore no single screen where a real drag GESTURE could
// run start-to-finish through the DOM today — the source and the target never
// co-render. This test instead dispatches a real `DataTransfer`-carrying
// native `dragover`/`drop` DOM event straight at the drop zone (Chromium
// supports constructing `DataTransfer` directly), exercising the exact same
// `handleDrop` -> `useBlockReschedule` -> `setDueDate` IPC path a real drag
// would, without fabricating the result.
test.describe('Reschedule drop zone', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test("dropping a task on a day's RescheduleDropZone updates its due date", async ({ page }) => {
    await installIpcRecorder(page)

    await page.getByRole('tab', { name: 'Weekly view' }).click()
    const todayStr = localDateStr(new Date())
    const dropZoneTestId = `reschedule-drop-zone-${todayStr}`
    const dropZone = page.getByTestId(dropZoneTestId)
    await expect(dropZone).toBeVisible()

    await page.evaluate(
      ({ testId, blockId, mime }) => {
        const el = document.querySelector(`[data-testid="${testId}"]`)
        if (!el) throw new Error(`drop zone ${testId} not found`)
        const dt = new DataTransfer()
        dt.setData(mime, blockId)
        el.dispatchEvent(
          new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }),
        )
        el.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
        )
      },
      { testId: dropZoneTestId, blockId: BLOCK_OVERDUE_1, mime: RESCHEDULE_DRAG_TYPE },
    )

    // journal.rescheduled toast. Scoped to the Sonner toast container: the
    // same string is ALSO mirrored into the `#sr-announcer` aria-live region
    // (`announce()` in RescheduleDropZone.tsx), so an unscoped `getByText`
    // hits both and trips Playwright's strict-mode duplicate-match check.
    await expect(
      page.locator('[data-sonner-toast]').getByText(`Task rescheduled to ${todayStr}`),
    ).toBeVisible({ timeout: 5000 })

    // The real IPC call: BLOCK_OVERDUE_1 has due_date set and no
    // scheduled_date, so useBlockReschedule picks setDueDate (set_due_date).
    const calls = await getInvokeCalls(page, 'set_due_date')
    expect(calls).toContainEqual(
      expect.objectContaining({ blockId: BLOCK_OVERDUE_1, date: todayStr }),
    )

    // Resulting-state verification (not just the IPC call): switch to
    // today's daily view and confirm the task actually moved — it drops out
    // of UnfinishedTasks' "before today" rollover (the only seeded rollover
    // item, so the whole section unmounts) and shows up in the Due panel as
    // due today instead.
    await page.getByRole('tab', { name: 'Daily view' }).click()
    await expect(page.getByTestId('unfinished-tasks')).toHaveCount(0)
    await expect(page.getByTestId('due-panel').getByText('Submit report')).toBeVisible({
      timeout: 5000,
    })
  })
})

// ===========================================================================
// 4. Projected repeat occurrences — MOCK-BLOCKED (documented, not faked)
// ===========================================================================
//
// DuePanel (agenda/DuePanel.tsx) renders dashed "Projected" entries
// (`data-testid="projected-entry"`) for future occurrences of repeating tasks,
// fetched via `listProjectedAgenda` -> the `list_projected_agenda` IPC
// (useDuePanelData.ts). The mock's handler for that command
// (src/lib/tauri-mock/handlers.ts, `list_projected_agenda: returnEmptyPage`)
// is an unconditional empty-page stub — it does not run the repeat-property
// projection math the real backend does
// (src-tauri/src/commands/agenda.rs `list_projected_agenda_inner`), so no
// seeded or created repeating task can ever produce a projected entry under
// this mock. Reimplementing that projection (three end-conditions + a dedup
// cache) inside the mock would risk exactly the "faked" coverage this task is
// meant to avoid — it would diverge from the real Rust logic and give false
// confidence, per #2708's own adversarial-verification note that a mock-backed
// e2e "could not catch a #2196-style Rust cache regression anyway". This test
// documents the current, real behavior (the FE does call the IPC; the mock
// returns nothing) rather than fabricating a projected entry.
test.describe('Projected repeat occurrences', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('DuePanel requests list_projected_agenda but the mock stub renders no projected entries', async ({
    page,
  }) => {
    // `installIpcRecorder` must run post-boot, which means the Due panel's
    // OWN initial (today's) fetch already fired uncaptured. useDuePanelData
    // also keeps a module-level 30s-TTL cache keyed on `<spaceId>|<date>`
    // (`projectedCache`), so simply remounting the SAME date would still
    // serve the (already-empty) cached response without a real IPC call.
    // Navigating to a DIFFERENT date changes the cache key, forcing a
    // genuine, captured `list_projected_agenda` call for that day.
    await installIpcRecorder(page)
    await page.getByRole('button', { name: 'Next day' }).click()
    await expect(page.getByTestId('due-panel')).toBeVisible({ timeout: 5000 })

    const calls = await getInvokeCalls(page, 'list_projected_agenda')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    await expect(page.getByTestId('projected-entry')).toHaveCount(0)
  })
})
