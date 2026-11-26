import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  focusBlockById,
  getInvokeCalls,
  installIpcRecorder,
  ipc,
  navigateToView,
  replaceEditorText,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E tests for journal daily-view panels that agenda-advanced.spec.ts never
 * exercised (#2708): the Done panel, the Due panel's tabs on today's page
 * (#7155), the RescheduleDropZone (native HTML5 drag target in weekly view), and
 * projected repeat occurrences.
 *
 * Seed data (`src/lib/tauri-mock/seed.ts`) relevant here:
 *   PAGE_PROJECTS ("Projects") — BLOCK_PROJ_3 "Update dependencies", DONE,
 *     `completed_at` = today. NOT excluded from today's Done panel (its
 *     parent is PAGE_PROJECTS, not today's own daily page), so it is the
 *     one seeded item the Done panel is expected to show without any setup.
 *   PAGE_PROJECTS also owns BLOCK_OVERDUE_1 "Submit report" — TODO, P1,
 *     due_date = yesterday: the one seeded item under today's Overdue, and the
 *     block this file drags onto the RescheduleDropZone.
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
const BLOCK_OVERDUE_1 = '0000000000000000000B10CK19'
const RESCHEDULE_DRAG_TYPE = 'application/x-block-reschedule'

// ===========================================================================
// 1. Done panel
// ===========================================================================

test.describe('Done panel @journal', () => {
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
// 2. Today's tabs
// ===========================================================================

test.describe('Today’s tabs @journal', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  // #7155 R7 — today's tabs put each open task under the tab its earlier date
  // names, each tab counting what it lists. The rows come from the agenda and
  // the open tasks the backend reads.
  test('today’s tabs place each open task by its date, and count what they list', async ({
    page,
  }) => {
    const scope = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }
    const day = (offset: number): string => {
      const d = new Date()
      d.setDate(d.getDate() + offset)
      return localDateStr(d)
    }
    const task = async (content: string): Promise<string> => {
      const row = await ipc<{ id: string }>(page, 'create_block', {
        blockType: 'content',
        content,
        parentId: SEED_IDS.PAGE_PROJECTS,
        index: null,
        scope,
      })
      await ipc(page, 'set_todo_state', { blockId: row.id, state: 'TODO' })
      return row.id
    }
    const scheduled = await task('Plan the offsite')
    await ipc(page, 'set_scheduled_date', { blockId: scheduled, date: day(-1) })
    const later = await task('Book the venue')
    await ipc(page, 'set_due_date', { blockId: later, date: day(10) })
    await task('Someday read the manual')
    await navigateToView(page, 'Pages')
    await navigateToView(page, 'Journal')

    const panel = page.getByTestId('due-panel')
    const tab = (name: string) => panel.getByRole('tab', { name: new RegExp(`^${name} \\d+$`) })
    const rows = panel.getByTestId('due-panel-item')
    const listed = async (name: string, texts: string[]): Promise<void> => {
      await tab(name).click()
      for (const text of texts) await expect(rows.filter({ hasText: text })).toHaveCount(1)
      const count = Number((await tab(name).textContent())?.replace(/\D+/g, ''))
      await expect(rows).toHaveCount(count)
    }

    await listed('Overdue', ['Plan the offsite', 'Submit report'])
    await expect(rows.filter({ hasText: 'Book the venue' })).toHaveCount(0)
    await listed('Later', ['Book the venue'])
    await listed('No date', ['Someday read the manual'])
    await expect(page.getByText('Hide future scheduled')).toHaveCount(0)
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
// live in DuePanel / DonePanel / AgendaResults — all of
// which are DAILY- or AGENDA-mode-only (DaySection.tsx gates them on
// `mode === 'daily'`; JournalPage.tsx mounts exactly one mode's view at a
// time). There is therefore no single screen where a real drag GESTURE could
// run start-to-finish through the DOM today — the source and the target never
// co-render. This test instead dispatches a real `DataTransfer`-carrying
// native `dragover`/`drop` DOM event straight at the drop zone (Chromium
// supports constructing `DataTransfer` directly), exercising the exact same
// `handleDrop` -> `useBlockReschedule` -> `setDueDate` IPC path a real drag
// would, without fabricating the result.
test.describe('Reschedule drop zone @journal', () => {
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
    // of Overdue (the only seeded overdue item, so the section unmounts) and
    // shows up in the Due panel as due today instead.
    await page.getByRole('tab', { name: 'Daily view' }).click()
    await expect(
      page.getByTestId('due-panel').getByRole('heading', { name: 'Overdue', exact: true }),
    ).toHaveCount(0)
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
test.describe('Projected repeat occurrences @journal', () => {
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

// ===========================================================================
// 5. Due panel header below an edited block (#5807)
// ===========================================================================

// Seed id — BLOCK_DAILY_1 "Morning standup notes", the first block of today.
const BLOCK_DAILY_1 = '0000000000000000000B10CK06'

test('one click on the Due panel header lands while a block above is edited @journal', async ({
  page,
}) => {
  await waitForBoot(page)
  const header = page.getByTestId('due-panel-header')
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await focusBlockById(page, BLOCK_DAILY_1)
  await replaceEditorText(page, 'saved on the press')
  await expect(page.getByTestId('formatting-toolbar')).toBeVisible()

  await header.click()

  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('[data-testid="block-editor"]')).toHaveCount(0)
  await navigateToView(page, 'Pages')
  await navigateToView(page, 'Journal')
  await expect(
    page.locator(`[data-testid="block-static"][data-block-id="${BLOCK_DAILY_1}"]`),
  ).toHaveText('saved on the press')
})
