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
// Then the boot replay's quarantine of a sync delta (#6057). No command
// creates a quarantined delta, so each case writes into the closed app's
// `notes.db` as a replay would leave it, with bytes that are not a Loro blob:
// - a quarantined row: *Retry* moves it back to the replay's inbox with one
//   boot of budget, and the next start fails it once and quarantines it again;
// - an inbox slot one failed start short of `QUARANTINE_AFTER_BOOTS`: the next
//   start quarantines it, warns once, and the warning's *Review* lands on it.
// The mock always reports zero, so only the real boot replay can show these.
// The retry case runs first: it counts one row, and it seeds `inbox_id` 1,
// which the slot the second case seeds would otherwise take. The second case
// empties the quarantine as it seeds, so its row is the only one.
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
  invoke,
  navigateTo,
  openDataTab,
  openSettingsTab,
  openNewPage,
  pageEntryTitled,
  reopenPageHolding,
  restartApp,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const KEPT_PAGE = runScopedMarker('wdio-restore-kept-page')
const KEPT = runScopedMarker('wdio-restore-kept-block')
const LOST_PAGE = runScopedMarker('wdio-restore-lost-page')
const LOST = runScopedMarker('wdio-restore-lost-block')

const SEEDED_REASON = 'seeded by snapshot-restore.e2e.ts'
const QUARANTINE_CARD = '[data-testid="quarantined-sync-card"]'
const QUARANTINE_ROW = '[data-testid="quarantined-sync-row"]'
const HOUR = 60 * 60 * 1000
/** `QUARANTINE_AFTER_BOOTS - 1` in `loro_sync_quarantine.rs`: one more failed start quarantines it. */
const ONE_BOOT_SHORT = 4
const QUARANTINE_TOAST = '1 change from another device could not be applied'

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

/** Insert one quarantined delta into the database of the app that is not running. */
function seedQuarantinedDelta(vault: string, spaceId: string): void {
  const db = new DatabaseSync(path.join(vault, 'notes.db'))
  try {
    const now = Date.now()
    db.prepare(
      `INSERT INTO loro_sync_quarantine
         (inbox_id, space_id, bytes, purged_ids, declared_end_vv, last_reason,
          unresolved_boots, first_seen_at_ms, quarantined_at_ms)
       VALUES (1, ?, ?, NULL, '[]', ?, 5, ?, ?)`,
    ).run(spaceId, Buffer.from('agaric e2e: not a loro blob'), SEEDED_REASON, now - 3 * HOUR, now)
  } finally {
    db.close()
  }
}

/**
 * Insert one inbox slot into the database of the app that is not running, with
 * the quarantine emptied first, so the row Review lands on can only be this one.
 */
function seedInboxSlotOneBootShort(vault: string, spaceId: string): void {
  const db = new DatabaseSync(path.join(vault, 'notes.db'))
  try {
    db.exec('DELETE FROM loro_sync_quarantine')
    db.prepare(
      `INSERT INTO loro_sync_inbox (space_id, bytes, created_at, purged_ids, unresolved_boots)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(spaceId, Buffer.from('agaric e2e: not a loro blob'), Date.now(), ONE_BOOT_SHORT)
  } finally {
    db.close()
  }
}

/** The id of the Personal space. */
async function personalSpaceId(): Promise<string> {
  const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
  const personal = spaces.find((space) => space.name === 'Personal')
  if (!personal) throw new Error(`no Personal space in ${JSON.stringify(spaces)}`)
  return personal.id
}

/** The text of every quarantined row, read in one pass. */
function quarantinedRows(): Promise<string[]> {
  return browser.execute(
    (row: string) => [...document.querySelectorAll(row)].map((el) => el.textContent ?? ''),
    QUARANTINE_ROW,
  )
}

async function waitForOneRow(when: string): Promise<string> {
  let rows: string[] = []
  await browser.waitUntil(
    async () => {
      rows = await quarantinedRows()
      return rows.length === 1
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: `${when}, Sync & devices never listed one delta` },
  )
  return rows[0] ?? ''
}

async function quarantinedTotal(): Promise<number> {
  return (await invoke<{ total: number }>('list_quarantined_sync_slots', { limit: 100 })).total
}

describe('Agaric real-backend restore from a daily snapshot (#6744) @boot @settings @sync', () => {
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

  it('a quarantined delta leaves the list on Retry, and is back after a start that still cannot apply it (#6057)', async () => {
    const spaceId = await personalSpaceId()
    const vault = appVaultDir()

    await restartApp('close', () => seedQuarantinedDelta(vault, spaceId))
    await openSettingsTab('sync')
    expect(await waitForOneRow('after seeding')).toContain(SEEDED_REASON)

    const retry = $('button[aria-label="Retry the sync change for Personal"]')
    await retry.waitForClickable({ timeout: ACTION_TIMEOUT })
    await retry.click()
    await browser.action('pointer').move({ x: 2, y: 2, origin: 'viewport' }).perform()
    await waitForToast('Will try again the next time Agaric starts')
    await expectAbsent(QUARANTINE_CARD, 'the retried delta')

    await navigateTo('Journal')
    await openSettingsTab('sync')
    expect(await quarantinedTotal()).toBe(0)
    await expectAbsent(QUARANTINE_CARD, 'the retried delta')

    // The boot replay fails the bytes once and, with one boot of budget, moves
    // them straight back, keeping when they were first seen.
    await restartApp()
    await openSettingsTab('sync')
    const row = await waitForOneRow('after the start that retried it')
    expect(row).toContain('Personal')
    expect(row).toContain('First seen 3h ago')
    expect(row).toContain('replay failed')
    expect(row).not.toContain(SEEDED_REASON)
  })

  it('warns on the start that quarantined a delta, and Review opens the list holding it (#6057)', async () => {
    const spaceId = await personalSpaceId()
    const vault = appVaultDir()

    await restartApp('close', () => seedInboxSlotOneBootShort(vault, spaceId))
    await waitForToast(QUARANTINE_TOAST)

    const review = $('[data-sonner-toast]').$('button=Review')
    await review.waitForClickable({ timeout: ACTION_TIMEOUT })
    await review.click()
    const row = $(QUARANTINE_ROW)
    await row.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const text = await row.getText()
    expect(text).toContain('Personal')
    expect(text).toContain('replay failed')
  })
})
