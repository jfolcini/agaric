// ---------------------------------------------------------------------------
// Real-backend Markdown mirror: a new file becomes a page (#5363 slice 3a,
// #6277 H3).
//
// The mirror's task (src-tauri/src/mirror/mod.rs) reads a new `.md` file in a
// space's folder, once two of its ticks read the same bytes, onto a new page
// of that space titled by the file's name; the mock has no such task, so only
// this lane can show it. The file is written from Node, as another editor
// would create it: the page appears in the Pages list with its blocks, and
// the file keeps its bytes.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

const ANCHOR_PAGE = runScopedMarker('wdio-newfile-anchor')
const ANCHOR_BLOCK = runScopedMarker('wdio-newfile-anchor-block')
const TITLE = runScopedMarker('wdio-newfile-page')
const FIRST = runScopedMarker('wdio-newfile-first')
const SECOND = runScopedMarker('wdio-newfile-second')

const folder = mkdtempSync(path.join(os.tmpdir(), 'wdio-mirror-new-'))

/** The folder below the mirror's that holds `file`, the space's. */
function spaceFolderOf(file: string): string | undefined {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === file)
    .map((entry) => entry.parentPath)[0]
}

describe('Agaric real-backend Markdown mirror, a new file (#5363) @markdown @pages', () => {
  after(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('reads a new file in a space folder onto a new page and keeps the file', async () => {
    await waitForAppReady()
    await invoke('set_mirror_folder', { path: folder })
    await browser.waitUntil(
      async () => (await invoke<MirrorStatus>('get_mirror_status')).last_pass_ms !== null,
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the mirror never finished a pass in the new folder' },
    )

    // A page of the current space, so its folder shows which folder is the
    // space's.
    await openNewPage(ANCHOR_PAGE)
    await typeMarkerVerified(ANCHOR_BLOCK)
    await browser.keys(['Escape'])
    await blockStaticByMarker(ANCHOR_BLOCK).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    let space: string | undefined
    await browser.waitUntil(
      () => {
        space = spaceFolderOf(`${ANCHOR_PAGE}.md`)
        return Promise.resolve(space !== undefined)
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: `${ANCHOR_PAGE}.md never reached the mirror` },
    )

    // Another editor creates a note in that space's folder.
    const file = path.join(space as string, `${TITLE}.md`)
    const written = `* ${FIRST}\n\n${SECOND}\n`
    writeFileSync(file, written)

    // Each look navigates to the Pages list afresh, so it re-queries.
    const rows = `.//span[contains(@class, "page-browser-item-title")][normalize-space(.)="${TITLE}"]`
    await browser.waitUntil(
      async () => {
        await navigateTo('Journal')
        await navigateTo('Pages')
        return (await $$(rows).length) === 1
      },
      { timeout: NAV_TIMEOUT, interval: 2000, timeoutMsg: `no page titled ${TITLE} appeared` },
    )
    expect(await pagesTitled(TITLE)).toBe(1)
    await reopenPageHolding(TITLE, FIRST)
    await blockStaticByMarker(SECOND).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    expect(readFileSync(file, 'utf8')).toBe(written)
    expect((await invoke<MirrorStatus>('get_mirror_status')).failed).toEqual([])
  })
})
