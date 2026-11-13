// ---------------------------------------------------------------------------
// Real-backend op-log compaction across a restart (#6518).
//
// Compaction is the one exception to the append-only op log: it deletes every
// op past the retention window. This spec writes a page, ages its ops past the
// window, compacts through History's "Remove old history" card, restarts, and
// reads the page back. The purge also has to clamp the apply cursor down to the
// surviving log (#3310): a cursor left above an emptied log is the state boot
// reports as corruption, so the cursor is read from `notes.db` before the
// restart, whose boot would heal it.
//
// Nothing ages an op but the clock, so the spec moves `op_log.created_at` back
// in `notes.db` directly (`created_at` is not in the op hash). The op log's
// update trigger lets that through only while the `_op_log_mutation_allowed`
// sentinel is present, as compaction itself does.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  appVaultDir,
  confirmDialog,
  expectAbsent,
  navigateTo,
  openEditHistory,
  openNewPage,
  reopenPageHolding,
  restartApp,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const PAGE = runScopedMarker('wdio-compaction-page')
const MARKER = runScopedMarker('wdio-compaction-block')
const LATER_PAGE = runScopedMarker('wdio-compaction-later-page')
const LATER = runScopedMarker('wdio-compaction-later-block')

/** Past `DEFAULT_RETENTION_DAYS` (90). */
const AGE_MS = 200 * 24 * 60 * 60 * 1000

const CARD = '.compaction-card'

/** The History rows whose preview holds `marker`. */
function historyRows(marker: string): string {
  return (
    '//*[@data-history-item]' +
    `[.//*[contains(@class, "history-item-preview")][contains(normalize-space(.), "${marker}")]]`
  )
}

function openVault(readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(path.join(appVaultDir(), 'notes.db'), { readOnly })
  // The running app holds the database; wait out its writer rather than fail.
  db.exec('PRAGMA busy_timeout = 10000')
  return db
}

/** Move every op past the retention window, so compaction removes them all. */
function ageEveryOp(): void {
  const db = openVault(false)
  try {
    db.exec('BEGIN IMMEDIATE')
    db.exec('INSERT INTO _op_log_mutation_allowed (token) VALUES (1)')
    db.prepare('UPDATE op_log SET created_at = created_at - ?').run(AGE_MS)
    db.exec('DELETE FROM _op_log_mutation_allowed')
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

/** The apply cursor and the newest locally-authored op it may not pass. */
function cursorAndFrontier(): { cursor: number; frontier: number } {
  const db = openVault(true)
  try {
    const row = db
      .prepare(
        'SELECT (SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1) AS cursor, ' +
          '(SELECT COALESCE(MAX(seq), 0) FROM op_log WHERE is_replicated = 0) AS frontier',
      )
      .get() as { cursor: number; frontier: number }
    return { cursor: Number(row.cursor), frontier: Number(row.frontier) }
  } finally {
    db.close()
  }
}

async function cardNumber(testid: string): Promise<number> {
  const cell = $(`${CARD} [data-testid="${testid}"]`)
  await cell.waitForDisplayed({ timeout: NAV_TIMEOUT })
  return Number(await cell.getText())
}

describe('Agaric real-backend op-log compaction across a restart (#6518) @pages @boot', () => {
  it('keeps the page, removes its history and leaves the apply cursor on the log', async () => {
    await waitForAppReady()
    await openNewPage(PAGE)
    await typeMarkerVerified(MARKER)
    await navigateTo('Journal')
    await reopenPageHolding(PAGE, MARKER)

    ageEveryOp()

    await openEditHistory()
    await $(historyRows(MARKER)).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'History never listed the op that wrote the marker',
    })

    const expand = $(`${CARD} button[aria-expanded="false"]`)
    await expand.waitForClickable({ timeout: ACTION_TIMEOUT })
    await expand.click()
    const total = await cardNumber('compaction-total-ops')
    const eligible = await cardNumber('compaction-eligible-ops')
    expect(total).toBeGreaterThan(0)
    // Every op is aged, so the purge takes the newest one too: the case the
    // cursor clamp exists for.
    expect(eligible).toBe(total)

    const compact = $(CARD).$('button=Compact Now')
    await compact.waitForClickable({ timeout: ACTION_TIMEOUT })
    await compact.click()
    await confirmDialog('Compact')
    await waitForToast(`Compacted ${eligible} operation`)

    // The log is empty, so the cursor must be too.
    expect(cursorAndFrontier()).toEqual({ cursor: 0, frontier: 0 })

    await restartApp()
    await reopenPageHolding(PAGE, MARKER)

    // A write after the purge is the History row the absence check waits behind.
    await openNewPage(LATER_PAGE)
    await typeMarkerVerified(LATER)
    await navigateTo('Journal')
    await reopenPageHolding(LATER_PAGE, LATER)
    await openEditHistory()
    await $(historyRows(LATER)).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'History never listed the op written after the compaction',
    })
    await expectAbsent(historyRows(MARKER), 'the compacted op that wrote the marker')
  })
})
