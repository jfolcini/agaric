// ---------------------------------------------------------------------------
// Real-backend retry of a quarantined sync delta (#6057).
//
// No command creates a quarantined delta: only the boot replay does, after
// `QUARANTINE_AFTER_BOOTS` failed starts. So the spec writes one into the
// closed app's `notes.db` as the replay would leave it, with bytes that are not
// a Loro blob. *Retry* moves it back to the replay's inbox with one boot of
// budget, and the next start fails it once and quarantines it again. Only the
// real boot replay can show that, which is why this lane carries it.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  appVaultDir,
  expectAbsent,
  invoke,
  navigateTo,
  openSettingsTab,
  restartApp,
  waitForAppReady,
  waitForToast,
} from './helpers'

const SEEDED_REASON = 'seeded by sync-quarantine.e2e.ts'
const CARD = '[data-testid="quarantined-sync-card"]'
const ROW = '[data-testid="quarantined-sync-row"]'
const HOUR = 60 * 60 * 1000

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

/** The text of every quarantined row, read in one pass. */
function quarantinedRows(): Promise<string[]> {
  return browser.execute(
    (row: string) => [...document.querySelectorAll(row)].map((el) => el.textContent ?? ''),
    ROW,
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

describe('Agaric real-backend retry of a quarantined sync delta (#6057) @sync @settings @boot', () => {
  it('leaves the list on Retry, and is back after a start that still cannot apply it', async () => {
    await waitForAppReady()
    const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
    const personal = spaces.find((space) => space.name === 'Personal')
    if (!personal) throw new Error(`no Personal space in ${JSON.stringify(spaces)}`)
    const vault = appVaultDir()

    await restartApp('close', () => seedQuarantinedDelta(vault, personal.id))
    await openSettingsTab('sync')
    expect(await waitForOneRow('after seeding')).toContain(SEEDED_REASON)

    const retry = $('button[aria-label="Retry the sync change for Personal"]')
    await retry.waitForClickable({ timeout: ACTION_TIMEOUT })
    await retry.click()
    await browser.action('pointer').move({ x: 2, y: 2, origin: 'viewport' }).perform()
    await waitForToast('Will try again the next time Agaric starts')
    await expectAbsent(CARD, 'the retried delta')

    await navigateTo('Journal')
    await openSettingsTab('sync')
    expect(await quarantinedTotal()).toBe(0)
    await expectAbsent(CARD, 'the retried delta')

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
})
