// ---------------------------------------------------------------------------
// Real-backend Trash: a header bulk action that changes nothing says so.
//
// `list_trash` returns each id as stored, while `purge_blocks_by_ids` and
// `restore_blocks_by_ids` canonicalise the ids they receive (uppercase) and
// match them byte for byte. A trashed row whose stored id is not canonical is
// therefore listed but never matched: "Empty trash" and "Restore all" resolved
// with a count of 0, the dialog closed, and no toast followed, so the list
// looked stuck. This spec stores two trashed pages under lowercase ids, then
// asserts each action reports its failure and the rows are still listed after
// a view change.
//
// The pages are created and trashed through the real IPC; the ids are rewritten
// in `notes.db` directly, the only way to reach that shape.
// ---------------------------------------------------------------------------

import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  appVaultDir,
  confirmDialog,
  invoke,
  navigateTo,
  runScopedMarker,
  waitForAppReady,
  waitForToast,
} from './helpers'

const TITLES = ['one', 'two'].map((n) => runScopedMarker(`wdio-trash-noncanon-${n}`))

/** Create the pages titled `TITLES`, trash them, and store their ids lowercase. */
async function trashUnderLowercaseIds(): Promise<void> {
  const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
  const personal = spaces.find((space) => space.name === 'Personal')?.id
  if (personal === undefined) throw new Error('no Personal space')
  const ids: string[] = []
  for (const title of TITLES) {
    const id = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: title,
      spaceId: personal,
    })
    await invoke('delete_block', { blockId: id })
    ids.push(id)
  }
  const db = new DatabaseSync(path.join(appVaultDir(), 'notes.db'), {
    // Rows elsewhere still name the canonical id; leaving them dangling is the point.
    enableForeignKeyConstraints: false,
  })
  try {
    for (const id of ids) {
      const { changes } = db
        .prepare('UPDATE blocks SET id = lower(id), page_id = lower(page_id) WHERE id = ?')
        .run(id)
      if (changes !== 1) throw new Error(`could not rewrite the id of trashed page ${id}`)
    }
  } finally {
    db.close()
  }
}

/** Open Trash from the Pages header and wait until it lists every page in `TITLES`. */
async function openTrashListingAll(): Promise<void> {
  await navigateTo('Journal')
  await navigateTo('Pages')
  // Named "Trash, N items" while the trash holds something.
  const button = $('//button[@aria-label="Trash" or starts-with(@aria-label, "Trash, ")]')
  await button.waitForClickable({ timeout: NAV_TIMEOUT })
  await button.click()
  let seen: string[] = []
  await browser
    .waitUntil(
      async () => {
        seen = await browser.execute(() =>
          [...document.querySelectorAll('[data-testid="trash-item"]')].map(
            (row) => row.textContent ?? '',
          ),
        )
        return TITLES.every((title) => seen.some((text) => text.includes(title)))
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(
        `Trash does not list ${JSON.stringify(TITLES)}; it shows ${JSON.stringify(seen)}`,
      )
    })
}

/** Click a Trash header action and confirm its dialog. */
async function runHeaderAction(testid: string, confirm: string): Promise<void> {
  const button = $(`[data-testid="${testid}"]`)
  await button.waitForClickable({ timeout: ACTION_TIMEOUT })
  await button.click()
  await confirmDialog(confirm)
}

describe('Agaric real-backend Trash: a bulk action that matches nothing says so @pages', () => {
  before(async () => {
    await waitForAppReady()
    await trashUnderLowercaseIds()
  })

  it('Empty trash reports its failure and the rows stay listed', async () => {
    await openTrashListingAll()
    await runHeaderAction('trash-empty-trash-btn', 'Yes, delete')
    await waitForToast('Failed to empty trash')
    await openTrashListingAll()
  })

  it('Restore all reports its failure and the rows stay listed', async () => {
    await openTrashListingAll()
    await runHeaderAction('trash-restore-all-btn', 'Restore')
    await waitForToast('Failed to restore all items')
    await openTrashListingAll()
  })
})
