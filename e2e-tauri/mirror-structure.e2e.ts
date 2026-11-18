// ---------------------------------------------------------------------------
// Real-backend Markdown mirror: a file renamed or moved outside Agaric (#5363
// slice 3).
//
// The mirror's task (src-tauri/src/mirror/mod.rs) holds a page whose file
// vanished for two ticks, and takes a new file that holds the bytes it last
// wrote as that file renamed: the page takes the title the new path names, or
// moves to the space whose folder holds it. A file moved out of every space's
// folder is no page's place: its page is held as it was, never trashed
// (#6887). A page renamed or trashed from the folder is said in a toast, whose
// button opens the Trash for a trashed one (#6887 E). The mock has no such
// task, so only this lane can show it. Files are renamed from Node, as a file
// manager would.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  dismissToasts,
  invoke,
  navigateTo,
  openNewPage,
  openTrash,
  pagesTitled,
  reopenPageHolding,
  restoreFromTrash,
  runScopedMarker,
  trashRow,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

interface MirrorStatus {
  last_pass_ms: number | null
  paused: string | null
  failed: { page_id: string; path: string; message: string }[]
}

interface PageHeading {
  id: string
  content: string | null
}

const RENAMED_FROM = runScopedMarker('wdio-structure-before')
const RENAMED_TO = runScopedMarker('wdio-structure-after')
const RENAMED_BLOCK = runScopedMarker('wdio-structure-renamed-block')
const MOVED = runScopedMarker('wdio-structure-moved')
const MOVED_BLOCK = runScopedMarker('wdio-structure-moved-block')
const OTHER_SPACE = runScopedMarker('wdio-structure-space')
const DELETED = runScopedMarker('wdio-structure-deleted')
const DELETED_BLOCK = runScopedMarker('wdio-structure-deleted-block')
const STRAYED = runScopedMarker('wdio-structure-strayed')
const STRAYED_BLOCK = runScopedMarker('wdio-structure-strayed-block')
const KEPT = runScopedMarker('wdio-structure-kept')
const KEPT_BLOCK = runScopedMarker('wdio-structure-kept-block')

const folder = mkdtempSync(path.join(os.tmpdir(), 'wdio-mirror-structure-'))

/** The path of `file` below the mirror's folder, once a pass wrote it. */
async function writtenFile(file: string): Promise<string> {
  let found: string | undefined
  await browser.waitUntil(
    () => {
      found = readdirSync(folder, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name === file)
        .map((entry) => path.join(entry.parentPath, entry.name))[0]
      return Promise.resolve(found !== undefined)
    },
    { timeout: ACTION_TIMEOUT, timeoutMsg: `${file} never reached the mirror` },
  )
  return found as string
}

/** A page of the current space titled `title`, holding `block`, and its file. */
async function mirroredPage(title: string, block: string): Promise<string> {
  await openNewPage(title)
  await typeMarkerVerified(block)
  await browser.keys(['Escape'])
  await blockStaticByMarker(block).waitForDisplayed({ timeout: ACTION_TIMEOUT })
  return writtenFile(`${title}.md`)
}

describe('Agaric real-backend Markdown mirror, renamed and moved files (#5363) @markdown @pages', () => {
  before(async () => {
    await waitForAppReady()
    await invoke('set_mirror_folder', { path: folder, readBack: true })
    await browser.waitUntil(
      async () => (await invoke<MirrorStatus>('get_mirror_status')).last_pass_ms !== null,
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the mirror never finished a pass in the new folder' },
    )
  })

  after(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('renames the page of a file renamed outside Agaric, keeping one page', async () => {
    const before = await mirroredPage(RENAMED_FROM, RENAMED_BLOCK)
    const after = path.join(path.dirname(before), `${RENAMED_TO}.md`)
    // A toast still up would count this page with its own instead of naming it.
    await dismissToasts()
    renameSync(before, after)
    await waitForToast(`${RENAMED_TO}.md was renamed or moved in the mirror folder`)

    // Each look navigates to the Pages list afresh, so it re-queries.
    const titled = (title: string) =>
      `.//span[contains(@class, "page-browser-item-title")][normalize-space(.)="${title}"]`
    await browser.waitUntil(
      async () => {
        await navigateTo('Journal')
        await navigateTo('Pages')
        return (await $$(titled(RENAMED_TO)).length) === 1
      },
      { timeout: NAV_TIMEOUT, interval: 2000, timeoutMsg: `no page titled ${RENAMED_TO}` },
    )
    expect(await $$(titled(RENAMED_FROM)).length).toBe(0)
    expect(await pagesTitled(RENAMED_TO)).toBe(1)
    await reopenPageHolding(RENAMED_TO, RENAMED_BLOCK)

    expect(existsSync(before)).toBe(false)
    expect(existsSync(after)).toBe(true)
    expect((await invoke<MirrorStatus>('get_mirror_status')).failed).toEqual([])
  })

  it("moves the page of a file moved into another space's folder", async () => {
    const before = await mirroredPage(MOVED, MOVED_BLOCK)
    const other = await invoke<string>('create_space', { name: OTHER_SPACE, accentColor: null })
    const otherFolder = path.join(folder, OTHER_SPACE)
    mkdirSync(otherFolder)
    const after = path.join(otherFolder, `${MOVED}.md`)
    renameSync(before, after)

    const pagesOf = async (spaceId: string) =>
      (
        await invoke<PageHeading[]>('list_all_pages_in_space', {
          scope: { kind: 'active', space_id: spaceId },
          tagIds: null,
        })
      ).map((page) => page.content)
    await browser.waitUntil(async () => (await pagesOf(other)).includes(MOVED), {
      timeout: NAV_TIMEOUT,
      interval: 2000,
      timeoutMsg: `${MOVED} never moved to ${OTHER_SPACE}`,
    })

    // One page in the whole vault, in the space it moved to.
    const spaces = await invoke<{ id: string }[]>('list_spaces')
    const holding: string[] = []
    for (const space of spaces) {
      for (const title of await pagesOf(space.id)) {
        if (title === MOVED) holding.push(space.id)
      }
    }
    expect(holding).toEqual([other])
    expect(existsSync(before)).toBe(false)
    expect(existsSync(after)).toBe(true)
    expect((await invoke<MirrorStatus>('get_mirror_status')).failed).toEqual([])
  })

  it('trashes the page of a file deleted outside Agaric, says so, and Restore brings both back', async () => {
    const file = await mirroredPage(DELETED, DELETED_BLOCK)
    await dismissToasts()
    unlinkSync(file)

    // The toast names the file, and its button opens the Trash holding the page.
    await waitForToast(`${DELETED}.md was deleted from the mirror folder`)
    const open = $('[data-sonner-toast]').$('button=Open Trash')
    await open.waitForClickable({ timeout: ACTION_TIMEOUT })
    await open.click()
    await $(trashRow(DELETED)).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    // Away and back, the Trash still lists it.
    await navigateTo('Journal')
    await openTrash()
    expect(await $$(trashRow(DELETED)).length).toBe(1)
    await restoreFromTrash(DELETED)

    await reopenPageHolding(DELETED, DELETED_BLOCK)
    await browser.waitUntil(() => Promise.resolve(existsSync(file)), {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the restored page was never written again',
    })
  })

  it('holds the page of a file moved out of every space folder, trashing nothing', async () => {
    const before = await mirroredPage(STRAYED, STRAYED_BLOCK)
    const outside = `${STRAYED}.md`
    renameSync(before, path.join(folder, outside))

    const status = () => invoke<MirrorStatus>('get_mirror_status')
    await browser.waitUntil(
      async () =>
        (await status()).failed.some(
          (file) => file.path === outside && file.message.includes('outside the space folders'),
        ),
      { timeout: NAV_TIMEOUT, timeoutMsg: `${outside} was never listed as moved outside` },
    )
    // Past the passes a vanished file is held for before its page is trashed:
    // one runs every two seconds while a page's file is missing.
    const listedAt = (await status()).last_pass_ms ?? 0
    await browser.waitUntil(async () => ((await status()).last_pass_ms ?? 0) >= listedAt + 10_000, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the mirror stopped passing over the held page, as if it were gone',
    })

    await openTrash()
    expect(await $$(trashRow(STRAYED)).length).toBe(0)
    await reopenPageHolding(STRAYED, STRAYED_BLOCK)
    expect(existsSync(before)).toBe(false)

    // Moved back, the file is the page's again and nothing stays listed.
    renameSync(path.join(folder, outside), before)
    await browser.waitUntil(async () => (await status()).failed.length === 0, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: `${outside} stayed listed after it was moved back`,
    })
    expect(await pagesTitled(STRAYED)).toBe(1)
  })

  it('pauses, trashing nothing, while the folder is unmounted', async () => {
    const file = await mirroredPage(KEPT, KEPT_BLOCK)
    const away = `${folder}-away`
    renameSync(folder, away)
    try {
      await browser.waitUntil(
        async () => (await invoke<MirrorStatus>('get_mirror_status')).paused !== null,
        { timeout: NAV_TIMEOUT, timeoutMsg: 'the mirror never paused on its missing folder' },
      )
      expect(await pagesTitled(KEPT)).toBe(1)
      expect(existsSync(folder)).toBe(false)
    } finally {
      renameSync(away, folder)
    }

    const back = (await invoke<MirrorStatus>('get_mirror_status')).last_pass_ms ?? 0
    await browser.waitUntil(
      async () => {
        const status = await invoke<MirrorStatus>('get_mirror_status')
        return status.paused === null && (status.last_pass_ms ?? 0) > back
      },
      { timeout: NAV_TIMEOUT, timeoutMsg: 'the mirror never resumed in its folder' },
    )
    expect(await pagesTitled(KEPT)).toBe(1)
    expect(existsSync(file)).toBe(true)
  })
})
