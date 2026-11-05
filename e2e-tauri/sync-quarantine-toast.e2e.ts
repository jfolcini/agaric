// ---------------------------------------------------------------------------
// Real-backend startup warning for a quarantined sync delta (#6057).
//
// The warning shows only on the start whose boot replay moved a delta into
// quarantine. The spec seeds an inbox slot one failed start short of
// `QUARANTINE_AFTER_BOOTS`, with bytes that are not a Loro blob, so the next
// boot replay fails it and quarantines it. The mock always reports zero, so
// only the real boot can show the toast, and its *Review* landing on the row.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  appVaultDir,
  invoke,
  restartApp,
  waitForAppReady,
  waitForToast,
} from './helpers'

/** `QUARANTINE_AFTER_BOOTS - 1` in `loro_sync_quarantine.rs`: one more failed start quarantines it. */
const ONE_BOOT_SHORT = 4
const TOAST = '1 change from another device could not be applied'
const ROW = '[data-testid="quarantined-sync-row"]'

/** Insert one inbox slot into the database of the app that is not running. */
function seedInboxSlotOneBootShort(vault: string, spaceId: string): void {
  const db = new DatabaseSync(path.join(vault, 'notes.db'))
  try {
    db.prepare(
      `INSERT INTO loro_sync_inbox (space_id, bytes, created_at, purged_ids, unresolved_boots)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(spaceId, Buffer.from('agaric e2e: not a loro blob'), Date.now(), ONE_BOOT_SHORT)
  } finally {
    db.close()
  }
}

describe('Agaric real-backend startup warning for a quarantined sync delta (#6057) @sync @settings @boot', () => {
  it('warns on the start that quarantined a delta, and Review opens the list holding it', async () => {
    await waitForAppReady()
    const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
    const personal = spaces.find((space) => space.name === 'Personal')
    if (!personal) throw new Error(`no Personal space in ${JSON.stringify(spaces)}`)
    const vault = appVaultDir()

    await restartApp('close', () => seedInboxSlotOneBootShort(vault, personal.id))
    await waitForToast(TOAST)

    const review = $('[data-sonner-toast]').$('button=Review')
    await review.waitForClickable({ timeout: ACTION_TIMEOUT })
    await review.click()
    const row = $(ROW)
    await row.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const text = await row.getText()
    expect(text).toContain('Personal')
    expect(text).toContain('replay failed')
  })
})
