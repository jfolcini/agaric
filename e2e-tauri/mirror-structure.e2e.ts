// ---------------------------------------------------------------------------
// Real-backend Markdown mirror: a file renamed or moved outside Agaric (#5363
// slice 3).
//
// The mirror's task (src-tauri/src/mirror/mod.rs) holds a page whose file
// vanished for two ticks, and takes a new file that holds the bytes it last
// wrote as that file renamed: the page takes the title the new path names, or
// moves to the space whose folder holds it. The mock has no such task, so only
// this lane can show it. Files are renamed from Node, as a file manager would.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  invoke,
  navigateTo,
  openNewPage,
  pagesTitled,
  reopenPageHolding,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

interface MirrorStatus {
  last_pass_ms: number | null
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
    await invoke('set_mirror_folder', { path: folder })
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
    renameSync(before, after)

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
})
