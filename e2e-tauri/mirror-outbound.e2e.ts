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
// one folder, in order: an edit reaches the file, a restart writes an edit
// the old process could not (its folder had lost its marker), and a file
// changed outside Agaric is read
// back into its page, and the app's own edit made meanwhile is kept. Then, in
// the same folder, the switch in Settings › Data turns on copying attachments
// (#5363 slice 4, setting 3): the image a page links is copied into
// `<space>/assets/<id>/<name>` and the page's file links the copy. A copy
// deleted while the app is down is written again by the next start's pass, and
// the switch is still on.
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
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  invoke,
  openDataTab,
  openNewPage,
  reopenPageHolding,
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
  copy_files: boolean
}

const TITLE = runScopedMarker('wdio-mirror-page')
const MARKER = runScopedMarker('wdio-mirror-block')
const SECOND = runScopedMarker('wdio-mirror-app-edit')
const RESTARTED = `${MARKER} ${runScopedMarker('wdio-mirror-restarted')}`
const EXTERNAL = runScopedMarker('wdio-mirror-external-line')
const COPY_TITLE = runScopedMarker('wdio-copy-page')
const COPY_MARKER = runScopedMarker('wdio-copy-block')
const FILENAME = 'pixel.png'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

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

const status = () => invoke<MirrorStatus>('get_mirror_status')

/** Every file below the folder named `name`, as absolute paths. */
function filesNamed(name: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => path.join(entry.parentPath, entry.name))
}

/** The switch labelled `label` in Settings › Data. */
async function settingSwitch(label: string) {
  const labelled = $(`//label[normalize-space(.)="${label}"]`)
  await labelled.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  const toggle = $(`[id="${(await labelled.getAttribute('for')) ?? ''}"]`)
  await toggle.waitForClickable({ timeout: ACTION_TIMEOUT })
  return toggle
}

/** Wait for the image's copy and a page file linking it; returns the copy. */
async function waitForCopyLinked(attachment: string, when: string): Promise<string> {
  const link = `assets/${attachment}/${FILENAME})`
  let copy = ''
  await browser.waitUntil(
    () => {
      copy = filesNamed(FILENAME).find((file) => file.includes(attachment)) ?? ''
      const page = filesNamed(`${COPY_TITLE}.md`)[0]
      return Promise.resolve(
        copy !== '' &&
          readFileSync(copy).equals(PNG) &&
          page !== undefined &&
          readFileSync(page, 'utf8').includes(link),
      )
    },
    {
      timeout: NAV_TIMEOUT,
      timeoutMsg: `no copy of ${FILENAME} linked from ${COPY_TITLE}.md ${when}`,
    },
  )
  return copy
}

async function waitForFileHolding(relative: string, text: string, when: string): Promise<void> {
  const file = path.join(folder, relative)
  await browser.waitUntil(
    () => Promise.resolve(existsSync(file) && readFileSync(file, 'utf8').includes(text)),
    { timeout: ACTION_TIMEOUT, timeoutMsg: `${relative} never held ${text} ${when}` },
  )
}

describe('Agaric real-backend outbound Markdown mirror (#5363) @markdown @boot @settings @attachments', () => {
  after(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('writes an edited page, rewrites it after a restart, and reads a file edited outside back in', async () => {
    await waitForAppReady()

    // 1. Turn the mirror on and let its first full pass finish before the page
    //    exists, so the page's file can only come from the pass an edit asks for.
    const set = await invoke<MirrorStatus>('set_mirror_folder', { path: folder, readBack: true })
    expect(set.folder).toBe(folder)
    await browser.waitUntil(async () => (await status()).last_pass_ms !== null, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the mirror never finished a pass in the new folder',
    })
    expect(existsSync(path.join(folder, '.agaric-mirror'))).toBe(true)

    await openNewPage(TITLE)
    await typeMarkerVerified(MARKER)
    await browser.keys(['Escape'])
    const block = blockStaticByMarker(MARKER)
    await block.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const blockId = await block.getAttribute('data-block-id')

    const relative = await waitForPageFile()
    await waitForFileHolding(relative, MARKER, 'after the edit')

    // 2. An edit the old process cannot write: without its marker the mirror
    //    is paused. The marker comes back only once that process is gone, so
    //    only the new process's startup pass can write the edit.
    const marker = path.join(folder, '.agaric-mirror')
    const device = readFileSync(marker, 'utf8')
    unlinkSync(marker)
    await browser.waitUntil(async () => (await status()).paused !== null, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the mirror never paused without its marker',
    })
    await invoke('edit_block', { blockId, toText: RESTARTED })
    await restartApp('kill', () => {
      writeFileSync(marker, device)
    })
    await waitForFileHolding(relative, RESTARTED, 'after the restart')

    const settled = await status()
    expect(settled.folder).toBe(folder)
    expect(settled.diverged).toEqual([])
    expect(settled.failed).toEqual([])

    // 3. A line added outside Agaric, then an edit of the same page in the app.
    //    The mirror reads the file back into the page, keeping the app's edit
    //    made meanwhile, and writes that edit into the file.
    appendFileSync(path.join(folder, relative), `\n${EXTERNAL}\n`)
    await invoke('edit_block', { blockId, toText: `${MARKER} ${SECOND}` })
    await browser.waitUntil(
      () => {
        const onDisk = readFileSync(path.join(folder, relative), 'utf8')
        return Promise.resolve(onDisk.includes(`${MARKER} ${SECOND}`) && onDisk.includes(EXTERNAL))
      },
      {
        timeout: NAV_TIMEOUT,
        timeoutMsg: `${relative} never held both the app's edit and the outside line`,
      },
    )

    await reopenPageHolding(TITLE, EXTERNAL)

    const final = await status()
    expect(final.diverged).toEqual([])
    expect(final.failed).toEqual([])
  })

  it('copies a linked image beside the pages, links it, and copies it again after a restart', async () => {
    // The folder the test above set and left with a finished pass.
    await openNewPage(COPY_TITLE)
    await typeMarkerVerified(COPY_MARKER)
    await browser.keys(['Escape'])
    const block = blockStaticByMarker(COPY_MARKER)
    await block.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const blockId = (await block.getAttribute('data-block-id')) ?? ''
    expect(blockId).not.toBe('')
    const { id: attachment } = await invoke<{ id: string }>('add_attachment_with_bytes', {
      blockId,
      filename: FILENAME,
      mimeType: 'image/png',
      bytes: PNG.toString('base64'),
    })
    await invoke('edit_block', {
      blockId,
      toText: `${COPY_MARKER} ![a pixel](attachment:${attachment})`,
    })
    await browser.waitUntil(
      () => {
        const page = filesNamed(`${COPY_TITLE}.md`)[0]
        return Promise.resolve(
          page !== undefined && readFileSync(page, 'utf8').includes(`attachment:${attachment}`),
        )
      },
      { timeout: NAV_TIMEOUT, timeoutMsg: `${COPY_TITLE}.md never linked the attachment` },
    )
    expect(filesNamed(FILENAME)).toEqual([])

    // The switch, as a user turns it on.
    await openDataTab()
    const copying = await settingSwitch('Copy attachments into the folder')
    expect(await copying.getAttribute('aria-checked')).toBe('false')
    await copying.click()
    const copy = await waitForCopyLinked(attachment, 'once copying was turned on')
    expect((await status()).copy_files).toBe(true)

    // Deleted while the app is down: only the next start's pass can copy it.
    unlinkSync(copy)
    await restartApp('kill')
    expect(await waitForCopyLinked(attachment, 'after the restart')).toBe(copy)
    expect(existsSync(copy)).toBe(true)

    await openDataTab()
    expect(
      await (await settingSwitch('Copy attachments into the folder')).getAttribute('aria-checked'),
    ).toBe('true')
    const settled = await status()
    expect(settled.diverged).toEqual([])
    expect(settled.failed).toEqual([])
  })
})
