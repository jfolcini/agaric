// ---------------------------------------------------------------------------
// Real-backend restore from a daily snapshot (#6744).
//
// Settings › Data's *Restore…* names a snapshot in a marker beside the
// database and restarts the app; the swap is boot's, before it opens the
// database. The dialog, the marker, the files boot moves and the vault the
// next launch opens are parts only this lane runs together.
//
// The app restarts itself, and the driver's session ends with the process it
// started. The spec waits on the vault's folder for the new launch to finish
// the swap, then ends that launch and opens a session on another.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  appVaultDir,
  clickUncovered,
  dailySnapshots,
  expectAbsent,
  navigateTo,
  openDataTab,
  openNewPage,
  pageEntryTitled,
  reopenPageHolding,
  restartApp,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const KEPT_PAGE = runScopedMarker('wdio-restore-kept-page')
const KEPT = runScopedMarker('wdio-restore-kept-block')
const LOST_PAGE = runScopedMarker('wdio-restore-lost-page')
const LOST = runScopedMarker('wdio-restore-lost-block')

/** How long the app gets to restart itself and swap the vault. */
const SELF_RESTART_TIMEOUT = 30_000

/** The vaults a restore kept in `dir`, each without the `-wal` and `-shm` beside it. */
function keptVaults(dir: string): string[] {
  return readdirSync(dir).filter((name) => /^notes\.db\.pre-restore-\d+$/.test(name))
}

/** What `read` returns from the database file at `file`, opened read-only. */
function inDatabase<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    // A running app holds its vault; wait out its writer rather than fail.
    db.exec('PRAGMA busy_timeout = 10000')
    return read(db)
  } finally {
    db.close()
  }
}

/** How many blocks of the database file at `file` hold `marker` in their text. */
function blocksHolding(file: string, marker: string): number {
  return inDatabase(file, (db) => {
    const held = db.prepare('SELECT count(*) AS n FROM blocks WHERE content LIKE ?')
    return (held.get(`%${marker}%`) as { n: number }).n
  })
}

async function writePage(title: string, marker: string): Promise<void> {
  await openNewPage(title)
  await typeMarkerVerified(marker)
  await navigateTo('Journal')
  await reopenPageHolding(title, marker)
}

describe('Agaric real-backend restore from a daily snapshot (#6744) @boot @settings', () => {
  it('opens the snapshot in place of the vault after the restart, and keeps the vault it replaced', async () => {
    await waitForAppReady()
    const vault = appVaultDir()
    const notes = path.join(vault, 'notes.db')
    await writePage(KEPT_PAGE, KEPT)

    // Today's snapshot, taken shortly after boot, may predate the page: with
    // it removed, the next launch takes one that holds the page.
    await restartApp('close', () => {
      for (const name of dailySnapshots(vault)) rmSync(path.join(vault, name))
    })
    await browser.waitUntil(() => Promise.resolve(dailySnapshots(vault).length === 1), {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'no daily snapshot appeared beside the database',
    })
    const [snapshot] = dailySnapshots(vault)
    expect(blocksHolding(path.join(vault, snapshot as string), KEPT)).toBe(1)
    await writePage(LOST_PAGE, LOST)

    await openDataTab()
    await clickUncovered($('button=Restore…'), 'the Restore… button')
    const dialog = $('[role="alertdialog"]')
    await dialog.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const confirm = dialog.$('button=Restore and restart')
    await confirm.waitForClickable({ timeout: ACTION_TIMEOUT })
    await confirm.click()

    const marker = path.join(vault, 'notes.db.restore-pending')
    await browser.waitUntil(
      () => Promise.resolve(!existsSync(marker) && keptVaults(vault).length > 0),
      {
        timeout: SELF_RESTART_TIMEOUT,
        timeoutMsg: 'the app did not restart itself and restore the snapshot',
      },
    )
    await restartApp('kill')

    expect(existsSync(marker)).toBe(false)
    const kept = keptVaults(vault)
    expect(kept).toHaveLength(1)
    expect(blocksHolding(path.join(vault, kept[0] as string), LOST)).toBe(1)
    expect(blocksHolding(notes, LOST)).toBe(0)
    const epoch = inDatabase(notes, (db) =>
      db.prepare("SELECT value FROM app_settings WHERE key = 'loro.peer_id_epoch'").get(),
    ) as { value: string } | undefined
    expect(epoch).toBeDefined()
    expect(epoch?.value).not.toBe('0')

    await reopenPageHolding(KEPT_PAGE, KEPT)
    await navigateTo('Pages')
    await pageEntryTitled(KEPT_PAGE).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(`span[title="${LOST_PAGE}"]`, 'the page written after the snapshot')
  })
})
