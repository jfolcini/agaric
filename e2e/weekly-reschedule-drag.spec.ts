import { expect, getInvokeCalls, installIpcRecorder, test, waitForBoot } from './helpers'

/**
 * E2E: the REAL reschedule-by-drag gesture in WeeklyView (#2770, Option (a)).
 *
 * journal-panels.spec.ts's "Reschedule drop zone" describe block already
 * covers the DROP side of `RescheduleDropZone` (#2708) by fabricating a
 * `DataTransfer` straight at the drop zone — its own comment explains that
 * the source and the target never co-rendered on any single screen at the
 * time (the only rows that SET the `application/x-block-reschedule` payload
 * lived in daily/agenda-only panels; the drop zone only mounts in weekly
 * view), so there was no gesture to drive start-to-finish.
 *
 * #2770 fixes exactly that gap: WeeklyView now wraps its per-day content in
 * `RescheduleDragSourceProvider`, so every day's block rows (rendered via
 * `DaySection` → `BlockTree` → `SortableBlock`) become native HTML5 drag
 * sources — see `useRescheduleDragSource.tsx` and `SortableBlock.tsx`'s
 * `onDragStart`. Source and target now co-render in weekly view, so this
 * spec drives the FULL gesture: dragstart on a real row → dragover/drop on
 * another day's `RescheduleDropZone` → asserts the block's due date actually
 * moved (IPC call + resulting UI state), not just that the drop handler
 * tolerates a synthetic payload.
 *
 * Native HTML5 DnD does not simulate reliably through Playwright's
 * pointer-based `dragTo()` (it relies on OS-level drag emulation that
 * Chromium headless doesn't consistently deliver for custom `dragstart`
 * handlers on plain `<div>`s). Mirroring journal-panels.spec.ts's existing
 * native-DnD test, this dispatches real `DragEvent`s with a SHARED
 * `DataTransfer` directly at the DOM: `dragstart` on the source row (so
 * SortableBlock's actual `onDragStart` handler under test runs and
 * populates the transfer via `dataTransfer.setData`), then
 * `dragover`/`drop` on the target zone — exercising the exact same
 * `handleDrop` -> `useBlockReschedule` -> `setDueDate` IPC path a real
 * mouse drag would.
 */

/** Local YYYY-MM-DD, matching `date-utils.formatDate` / the seed's `todayDate()`. */
function localDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Seed id — see src/lib/tauri-mock/seed.ts SEED_IDS.BLOCK_DAILY_3
// ("Buy groceries", child of PAGE_DAILY == today's journal page, TODO,
// due_date = today). Today's daily page is the one weekly-view day whose
// BlockTree is guaranteed to have a task row to drag, since the seed only
// gives today's page task blocks with `due_date`.
const BLOCK_DAILY_3 = '0000000000000000000BLOCK10'

test.describe('WeeklyView — reschedule by drag (real gesture)', () => {
  test.beforeEach(async ({ page }) => {
    // DaySection lazy-mounts each day's BlockTree behind an
    // IntersectionObserver (WeeklyView passes `lazyMount`), UNLESS
    // `prefers-reduced-motion: reduce` is set, in which case it mounts
    // eagerly (DaySection.tsx: `shouldLazyMount = lazyMount &&
    // !prefersReducedMotion`). Forcing reduced-motion here makes every day's
    // rows present in the DOM immediately after switching to weekly view,
    // instead of this test having to scroll each day section into view and
    // race the observer to get the source row (today, mid-week) to mount.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
  })

  test('dragging a task row from one day onto another day updates its due date', async ({
    page,
  }) => {
    await installIpcRecorder(page)

    await page.getByRole('tab', { name: 'Weekly view' }).click()

    const todayStr = localDateStr(new Date())
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = localDateStr(tomorrow)

    const sourceSelector = `[data-testid="sortable-block"][data-block-id="${BLOCK_DAILY_3}"]`
    const dropZoneTestId = `reschedule-drop-zone-${tomorrowStr}`

    // #2467/#1268 — SortableBlockWrapper renders an ARIA-hidden placeholder
    // `<li>` (no `data-testid="sortable-block"`) for any row `useBlockMountLimit`
    // /`useViewportObserver` currently consider off-screen, independent of
    // DaySection's own lazy-mount observer above. Today's day (mid-week) sits
    // below the fold on load, so scroll its section into view FIRST to flip
    // its rows from placeholders to the real, draggable row before looking
    // for it.
    await page.locator(`#journal-${todayStr}`).scrollIntoViewIfNeeded()
    const sourceRow = page.locator(sourceSelector)
    await expect(sourceRow).toBeVisible({ timeout: 5000 })
    await sourceRow.scrollIntoViewIfNeeded()

    const dropZone = page.getByTestId(dropZoneTestId)
    await dropZone.scrollIntoViewIfNeeded()
    await expect(dropZone).toBeVisible()

    // Snapshot the row's own due-date chip (`BlockInlineControls.tsx`'s
    // `DateChip`, `chipClass="due-date-chip"`) BEFORE the drag, so the
    // resulting-state check below can confirm it actually changed.
    const dueDateChip = sourceRow.locator('.due-date-chip').first()
    const dueDateChipBefore = await dueDateChip.textContent()

    await page.evaluate(
      ({ sourceSelector: srcSel, dropTestId }) => {
        const source = document.querySelector(srcSel)
        if (!source) throw new Error(`source row ${srcSel} not found`)
        const target = document.querySelector(`[data-testid="${dropTestId}"]`)
        if (!target) throw new Error(`drop zone ${dropTestId} not found`)

        const dt = new DataTransfer()
        // `dragstart` on the SOURCE row runs SortableBlock's real
        // `onDragStart` handler (the code under test), which populates `dt`
        // via `dataTransfer.setData('application/x-block-reschedule', blockId)` —
        // this is NOT fabricated by the test.
        source.dispatchEvent(
          new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }),
        )
        target.dispatchEvent(
          new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }),
        )
        target.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
        )
      },
      { sourceSelector, dropTestId: dropZoneTestId },
    )

    // journal.rescheduled toast. Scoped to the Sonner toast container: the
    // same string is ALSO mirrored into the `#sr-announcer` aria-live region
    // (`announce()` in RescheduleDropZone.tsx), so an unscoped `getByText`
    // hits both and trips Playwright's strict-mode duplicate-match check.
    await expect(
      page.locator('[data-sonner-toast]').getByText(`Task rescheduled to ${tomorrowStr}`),
    ).toBeVisible({ timeout: 5000 })

    // The real IPC call: BLOCK_DAILY_3 has due_date set and no
    // scheduled_date, so useBlockReschedule picks setDueDate (set_due_date).
    const calls = await getInvokeCalls(page, 'set_due_date')
    expect(calls).toContainEqual(
      expect.objectContaining({ blockId: BLOCK_DAILY_3, date: tomorrowStr }),
    )

    // Resulting-state verification (not just the IPC call): rescheduling
    // writes `due_date` metadata, it does NOT move the block to a different
    // page — WeeklyView's per-day BlockTree shows each day's OWN journal
    // page content (parent/page-ownership-driven), whereas "due today" is a
    // separate, date-driven query (DuePanel, daily-mode only). So the block
    // stays under today's page — same row, same day — but its own due-date
    // chip must now reflect the new date instead of the old one (mirrors
    // journal-panels.spec.ts's resulting-state check, which asserts via the
    // date-driven Due panel since ITS drop target and source never
    // co-render; here both ends of the drag ARE on screen, so asserting on
    // the dragged row's own chip is the more direct signal).
    //
    // The mock `set_due_date` handler (tauri-mock/handlers.ts) mutates its
    // in-memory block store directly — it does not emit the
    // `block:properties-changed` Tauri event the real backend does — so the
    // ALREADY-MOUNTED page-blocks store for today's page has no live signal
    // to refetch. Switch away and back to weekly view (unmount/remount,
    // NOT a page reload — a reload would reseed the mock's in-memory store
    // and lose this very write) so `BlockTree`'s `load()` effect re-fetches
    // fresh state.
    await page.getByRole('tab', { name: 'Daily view' }).click()
    await page.getByRole('tab', { name: 'Weekly view' }).click()
    await page.locator(`#journal-${todayStr}`).scrollIntoViewIfNeeded()
    const sourceRowAfterRefresh = page.locator(sourceSelector)
    await expect(sourceRowAfterRefresh).toBeVisible({ timeout: 5000 })
    await expect(sourceRowAfterRefresh.locator('.due-date-chip').first()).not.toHaveText(
      dueDateChipBefore ?? '',
      { timeout: 5000 },
    )
  })

  test('dropping a task on the SAME day it already belongs to is a harmless no-op', async ({
    page,
  }) => {
    await installIpcRecorder(page)

    await page.getByRole('tab', { name: 'Weekly view' }).click()

    const todayStr = localDateStr(new Date())
    const sourceSelector = `[data-testid="sortable-block"][data-block-id="${BLOCK_DAILY_3}"]`
    const dropZoneTestId = `reschedule-drop-zone-${todayStr}`

    // See the sibling test above for why this scroll is required before the
    // row (as opposed to its viewport-culled placeholder) exists in the DOM.
    await page.locator(`#journal-${todayStr}`).scrollIntoViewIfNeeded()
    const sourceRow = page.locator(sourceSelector)
    await expect(sourceRow).toBeVisible({ timeout: 5000 })

    await page.evaluate(
      ({ sourceSelector: srcSel, dropTestId }) => {
        const source = document.querySelector(srcSel)
        if (!source) throw new Error(`source row ${srcSel} not found`)
        const target = document.querySelector(`[data-testid="${dropTestId}"]`)
        if (!target) throw new Error(`drop zone ${dropTestId} not found`)

        const dt = new DataTransfer()
        source.dispatchEvent(
          new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }),
        )
        target.dispatchEvent(
          new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }),
        )
        target.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
        )
      },
      { sourceSelector, dropTestId: dropZoneTestId },
    )

    // The existing handler doesn't special-case a same-day drop — it just
    // re-writes the identical due_date, which is a harmless idempotent
    // write. Confirm it still succeeds (toast fires) and the task stays
    // exactly where it was.
    await expect(
      page.locator('[data-sonner-toast]').getByText(`Task rescheduled to ${todayStr}`),
    ).toBeVisible({ timeout: 5000 })

    const calls = await getInvokeCalls(page, 'set_due_date')
    expect(calls).toContainEqual(
      expect.objectContaining({ blockId: BLOCK_DAILY_3, date: todayStr }),
    )

    const todaySection = page.locator(`#journal-${todayStr}`)
    await expect(todaySection.getByText('Buy groceries')).toBeVisible()
  })
})
