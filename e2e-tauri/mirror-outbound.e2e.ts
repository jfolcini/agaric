// ---------------------------------------------------------------------------
// Real-backend outbound Markdown mirror (#5363 slice 1).
//
// The mirror is a backend task (src-tauri/src/mirror/mod.rs) that writes every
// live page to `<folder>/<space>/<title>.md`; the mock has no such task, so
// only this lane can show the files. Every assertion reads the folder from
// disk or re-queries `get_mirror_status`.
//
// The folder is set through `set_mirror_folder` (the Settings button opens a
// native folder dialog WebDriver cannot drive). The steps share one vault and
// one folder, in order: an edit reaches the file, a restart rewrites a file
// deleted while the app was down, and a file changed outside Agaric is left
// alone and reported as diverged.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  invoke,
  openNewPage,
  restartApp,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

/** `MirrorStatus` (src-tauri/src/mirror/mod.rs) as the command serializes it. */
interface MirrorStatus {
  folder: string | null
  paused: string | null
  diverged: { page_id: string; path: string }[]
  failed: { page_id: string; path: string; message: string }[]
  last_pass_ms: number | null
}

const TITLE = runScopedMarker('wdio-mirror-page')
const MARKER = runScopedMarker('wdio-mirror-block')
const SECOND = runScopedMarker('wdio-mirror-app-edit')
const EXTERNAL = runScopedMarker('wdio-mirror-external-line')

const folder = mkdtempSync(path.join(os.tmpdir(), 'wdio-mirror-'))

/** Every `.md` below `dir`, as paths relative to it, `/`-separated. */
function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .map((relative) => relative.split(path.sep).join('/'))
}

/** The page's file, found by its name under whatever space folder holds it. */
async function waitForPageFile(): Promise<string> {
  let found: string[] = []
  await browser.waitUntil(
    () => {
      found = markdownFiles(folder).filter((file) => file.endsWith(`/${TITLE}.md`))
      return Promise.resolve(found.length === 1)
    },
    {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `no single ${TITLE}.md in the mirror; it holds ${JSON.stringify(markdownFiles(folder))}`,
    },
  )
  return found[0] as string
}

async function waitForFileHolding(relative: string, text: string, when: string): Promise<void> {
  const file = path.join(folder, relative)
  await browser.waitUntil(
    () => Promise.resolve(existsSync(file) && readFileSync(file, 'utf8').includes(text)),
    { timeout: ACTION_TIMEOUT, timeoutMsg: `${relative} never held ${text} ${when}` },
  )
}

describe('Agaric real-backend outbound Markdown mirror (#5363) @markdown @boot', () => {
  after(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('writes an edited page, rewrites it after a restart, and leaves a file edited outside alone', async () => {
    await waitForAppReady()

    // 1. Turn the mirror on and let its first full pass finish before the page
    //    exists, so the page's file can only come from the pass an edit asks for.
    const set = await invoke<MirrorStatus>('set_mirror_folder', { path: folder })
    expect(set.folder).toBe(folder)
    await browser.waitUntil(
      async () => (await invoke<MirrorStatus>('get_mirror_status')).last_pass_ms !== null,
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the mirror never finished a pass in the new folder' },
    )
    expect(existsSync(path.join(folder, '.agaric-mirror'))).toBe(true)

    await openNewPage(TITLE)
    await typeMarkerVerified(MARKER)
    await browser.keys(['Escape'])
    const block = blockStaticByMarker(MARKER)
    await block.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const blockId = await block.getAttribute('data-block-id')

    const relative = await waitForPageFile()
    await waitForFileHolding(relative, MARKER, 'after the edit')

    // 2. Delete the file and kill the app at once, so no tick of the old
    //    process can rewrite it: only the new process's startup pass can.
    unlinkSync(path.join(folder, relative))
    await restartApp('kill')
    await waitForFileHolding(relative, MARKER, 'after the restart')

    const settled = await invoke<MirrorStatus>('get_mirror_status')
    expect(settled.folder).toBe(folder)
    expect(settled.diverged).toEqual([])
    expect(settled.failed).toEqual([])

    // 3. A line added outside Agaric, then an edit of the same page in the app.
    //    The page is dirty only through that edit, so the pass that reports the
    //    file as diverged is the one that weighed the edited render, and it
    //    must have left the file as the outside edit left it.
    appendFileSync(path.join(folder, relative), `\n${EXTERNAL}\n`)
    await invoke('edit_block', { blockId, toText: `${MARKER} ${SECOND}` })
    await browser.waitUntil(
      async () =>
        (await invoke<MirrorStatus>('get_mirror_status')).diverged.some(
          (file) => file.path === relative,
        ),
      { timeout: NAV_TIMEOUT, timeoutMsg: `the mirror never reported ${relative} as diverged` },
    )

    const status = await invoke<MirrorStatus>('get_mirror_status')
    expect(status.diverged.map((file) => file.path)).toEqual([relative])
    expect(status.failed).toEqual([])
    const onDisk = readFileSync(path.join(folder, relative), 'utf8')
    expect(onDisk).toContain(EXTERNAL)
    expect(onDisk).toContain(MARKER)
    expect(onDisk).not.toContain(SECOND)
  })
})
