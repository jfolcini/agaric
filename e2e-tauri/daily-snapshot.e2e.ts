// ---------------------------------------------------------------------------
// Real-backend daily snapshot (#6554).
//
// A little after boot the maintenance daemon writes today's snapshot beside the
// database, and Settings › Data says when: the file on disk, the command that
// reads its time and the row are three parts only this lane runs together. The
// snapshot is opened as a database and holds the spaces boot created, so it is
// a copy of the vault and not an empty file under the name.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { readdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { NAV_TIMEOUT, appVaultDir, invoke, openDataTab, waitForAppReady } from './helpers'

const SNAPSHOT_NAME = /^notes\.db\.daily-\d{4}-\d{2}-\d{2}$/

function snapshots(): string[] {
  return readdirSync(appVaultDir()).filter((name) => SNAPSHOT_NAME.test(name))
}

/** How many of `ids` the database file at `file` holds as blocks. */
function blocksHeld(file: string, ids: string[]): number {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const held = db.prepare('SELECT count(*) AS n FROM blocks WHERE id = ?')
    return ids.filter((id) => (held.get(id) as { n: number }).n === 1).length
  } finally {
    db.close()
  }
}

describe('Agaric real-backend daily snapshot (#6554) @boot @settings', () => {
  it('writes one snapshot of the vault after boot and Settings › Data says when', async () => {
    await waitForAppReady()
    const spaces = await invoke<{ id: string }[]>('list_spaces')
    expect(spaces.length).toBeGreaterThan(0)

    await browser.waitUntil(() => snapshots().length > 0, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'no daily snapshot appeared beside the database',
    })
    const taken = snapshots()
    expect(taken).toHaveLength(1)
    const held = blocksHeld(
      path.join(appVaultDir(), taken[0] as string),
      spaces.map((space) => space.id),
    )
    expect(held).toBe(spaces.length)

    await openDataTab()
    const status = $('[data-testid="snapshot-status"]')
    await status.waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await status.getText()).toContain('Last snapshot:')
  })
})
