// ---------------------------------------------------------------------------
// Real-backend two-device sync (#5365).
//
// The app pairs with a second device through its own pairing dialog, and one
// edit crosses in each direction, then a property and a move, then two
// concurrent edits to one block, then an image each way, then a meeting with
// its files (#5364), then the open page's undo and redo across a pull (#6541),
// then a sync cancelled while the peer does not answer. Then the peer's writes
// reach the views the app holds open (Due, Done and Unfinished panels, the
// Pages list, an open page's title, a search, the week, Last edited), a
// property definition it declares, a page open in page mode, and the Markdown
// mirror; and last a restart and an unpair.
// The second device is `e2e_sync_peer`, a headless vault on the app's sync daemon
// (sync-peer.ts). It reads the dialog's QR as a phone's camera would; the QR
// carries the address that mDNS, which a CI runner cannot be relied on for,
// would otherwise have to find.
//
// A session is a pull by the device that dials (#610), so the app has to dial
// the peer too. Paired by the peer's dial, the app holds no address for it
// until one is typed into the device list, as a user without mDNS would.
//
// The tests share one vault: each after the second works on the pairing and
// the page the second leaves. Unpair ends the pairing, so it runs last.
//
// The views-follow-a-pull tests start each pull from the sidebar's Sync
// button: "Sync now" lives in Settings, and leaving the view to press it would
// remount the view and re-query it, which is the very refresh under test. No
// local surface announces a peer's ops, so each view holds only if
// `reloadChangedPageStores` (useSyncEvents.ts) refreshes it, on `sync:complete`
// and again on the `blocks:changed` that follows the post-sync cache rebuild
// (`SpacePlacementSink`). The mock-lane twin, `e2e/sync-refresh.spec.ts`, cannot
// show this: its out-of-band write also answers with `blocks:changed`.
//
// An image's row and block arrive in a session's op phase, and its bytes in the
// file phase after it, so neither side's sync wait covers the bytes: each image
// test waits on the receiving side's `read_attachment` instead.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  caretToEnd,
  chooseSelectOption,
  enterBlankSibling,
  expectAbsent,
  expectImageRendered,
  invoke,
  navigateTo,
  openNewPage,
  openSettingsTab,
  pasteFileIntoFocusedBlock,
  reopenPageByTitle,
  restartApp,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'
import {
  PAGE_MODE,
  chooseEditMode,
  pageModeBlocks,
  pageModeCaret,
  typeInPageMode,
} from './page-mode'
import {
  type SyncPeer,
  openPairing,
  openSyncSettings,
  peerRow,
  readPairingQr,
  setPeerAddress,
  startSyncPeer,
} from './sync-peer'

const APP_EDIT = runScopedMarker('wdio-sync-app-edit')
const PEER_EDIT = runScopedMarker('wdio-sync-remote-edit')
// A key no definition spells or folds to is a custom text property.
const KEY = 'wdiosync'
const APP_VALUE = runScopedMarker('wdio-sync-app-prop')
const PEER_VALUE = runScopedMarker('wdio-sync-remote-prop')
const APP_TAIL = runScopedMarker('wdio-sync-app-tail')
const PEER_HEAD = runScopedMarker('wdio-sync-remote-head')
const PEER_FRONT = runScopedMarker('wdio-sync-remote-front')
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const SYNC_BUTTON = '[data-slot="sidebar"] button[aria-label="Sync"]'
const BEFORE_PAUSE = runScopedMarker('wdio-sync-before-pause')
const AFTER_CANCEL = runScopedMarker('wdio-sync-after-cancel')
const UNPRESSED_PAGE = runScopedMarker('wdio-sync-unpressed-page')
const UNPRESSED_EDIT = runScopedMarker('wdio-sync-unpressed-edit')
const APP_IMAGE = runScopedMarker('wdio-sync-app-image')
const PEER_IMAGE = runScopedMarker('wdio-sync-remote-image')
const FILENAME = 'wdio-sync-image.png'
const MEETING = runScopedMarker('wdio-sync-meeting')
// A meeting's files, as the dialog sends them: audio is checked by its name.
const MEETING_FILES = {
  audio: { name: 'call.ogg', stored: 'call.ogg', bytes: Buffer.from('OggS meeting audio') },
  transcript: {
    name: 'call.md',
    stored: 'call.transcript.md',
    bytes: Buffer.from('[00:00:04] **Alice:** Hi.\n'),
  },
  summary: { name: 'recap.md', stored: 'recap.summary.md', bytes: Buffer.from('Shipped.\n') },
}
// A 1x1 transparent PNG, and a 2x1 red and blue one. The peer's image must not
// be the app's: the peer would store bytes it already holds at the path of the
// copy it pulled, which the app holds too, and nothing would cross.
const APP_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const PEER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR42mP4z8AAQv8BD/kD/Zh51wAAAAAASUVORK5CYII=',
  'base64',
)

// The views-follow-a-pull tests. Titles are matched whole and not run-scoped:
// every spec file boots its own vault. The tag is typed, so it doubles no letter.
const TODAY_TASK = runScopedMarker('wdio-peer-today-task')
const LATE_TASK = runScopedMarker('wdio-peer-late-task')
const TAGGED = runScopedMarker('wdio-peer-tagged')
const DAY_ENTRY = runScopedMarker('wdio-peer-day-entry')
const LATE_BLOCK = runScopedMarker('wdio-peer-late-block')
const TASKS_PAGE = 'peer tasks'
const LATE_PAGE = 'peer late tasks'
const TAGGED_PAGE = 'peer tagged notes'
const LISTED = 'peer listed page'
const CREATED = 'peer created page'
const RENAMED = 'peer renamed page'
const OPEN_TITLE = 'peer open page'
const RETITLED = 'peer retitled page'
const EDITED_PAGE = 'peer edited page'
const NEWER_PAGE = 'peer newer page'
const TAG = 'marigold'
const DUE_PANEL = '[data-testid="due-panel"]'
const DONE_PANEL = '.done-panel'
const OVERDUE_TAB = '[data-testid="due-panel-tab-overdue"]'
const TITLE = '[aria-label="Page title"]'
const TAB_LIST = '[role="tablist"][aria-label="Editor tabs"]'
const SEARCH_INPUT = '[aria-label="Search blocks"]'
const SEARCH_STATUS = '[data-testid="search-results-count"]'
// The property definition the peer declares a `date`, held by the app as text first.
const SYNCED_KEY = runScopedMarker('wdio-due')
const DEFS_PAGE = runScopedMarker('wdio-defs-page')
const DEFS_HOLDER = runScopedMarker('wdio-defs-holder')
// Page mode while the peer edits.
const PM_TITLE = 'peer page mode'
const PM_FIRST = runScopedMarker('wdio-pm-first')
const PM_SECOND = runScopedMarker('wdio-pm-second')
const PM_THIRD = runScopedMarker('wdio-pm-third')
const PM_FROM_PEER = runScopedMarker('wdio-pm-from-peer')
const PM_FOURTH = runScopedMarker('wdio-pm-fourth')
// The Markdown mirror's folder and the page the peer writes into it.
const MIRROR_TITLE = runScopedMarker('wdio-mirror-peer-page')
const MIRROR_FIRST = runScopedMarker('wdio-mirror-peer-block')
const MIRROR_EDITED = runScopedMarker('wdio-mirror-peer-edit')
const mirrorFolder = mkdtempSync(path.join(os.tmpdir(), 'wdio-mirror-sync-'))

/** `MirrorStatus` (src-tauri/src/mirror/mod.rs) as the command serializes it. */
interface MirrorStatus {
  folder: string | null
  diverged: { page_id: string; path: string }[]
  failed: { page_id: string; path: string; message: string }[]
  last_pass_ms: number | null
}

/** Close the open pairing dialog through its "Cancel pairing?" guard. */
async function cancelPairing(): Promise<void> {
  // A passphrase on screen makes a close ask first (`handleAttemptClose`).
  await browser.keys(['Escape'])
  const cancel = $('[role="alertdialog"]').$('button=Cancel pairing')
  await cancel.waitForClickable({ timeout: ACTION_TIMEOUT })
  await cancel.click()
  await $('[data-testid="pairing-qr-code"]').waitForExist({
    reverse: true,
    timeout: ACTION_TIMEOUT,
  })
}

/** Press the open device list's "Sync now" for `deviceId`. */
async function clickSyncNow(deviceId: string): Promise<void> {
  const syncNow = peerRow(deviceId).$('button[aria-label^="Sync now with device"]')
  await syncNow.waitForClickable({ timeout: ACTION_TIMEOUT })
  await syncNow.click()
}

/**
 * Freeze the peer and press "Sync now" until the app dials it; resolves to the
 * dial's Cancel. A session already running with the peer (one the daemon
 * started on its own, or one the peer dialled) refuses the press with "Sync
 * already in progress for this peer" and shows no Cancel. Frozen, the peer
 * would hold that session until a transport timeout, so it thaws between
 * presses; the app shows no end for that session, so the thaw is timed.
 */
async function freezeAndDial(device: SyncPeer, deviceId: string) {
  const cancel = peerRow(deviceId).$('button[aria-label^="Cancel sync:"]')
  await browser.waitUntil(
    async () => {
      device.pause()
      await clickSyncNow(deviceId)
      const dialling = await cancel.waitForClickable({ timeout: 5_000 }).then(
        () => true,
        () => false,
      )
      if (!dialling) {
        device.resume()
        await browser.pause(5_000)
      }
      return dialling
    },
    {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'every "Sync now" to the frozen peer was refused or showed no Cancel',
    },
  )
  return cancel
}

/**
 * The device row of `deviceId` as one read: whether it shows a running session
 * (its progress or its Cancel), and the sync state card's label.
 */
function readSyncSurface(deviceId: string) {
  return browser.execute(
    (idPrefix: string) => {
      const row = [...document.querySelectorAll('.device-peer-item')].find((item) =>
        (item.textContent ?? '').includes(idPrefix),
      )
      return {
        rowFound: row !== undefined,
        sessionShown: row?.querySelector('.device-peer-progress, .device-cancel-sync-btn') != null,
        state: document.querySelector('.sync-state-label')?.textContent ?? '',
      }
    },
    deviceId.slice(0, 12),
  )
}

/** Leave the shared page and come back, so the rows are the backend's. */
async function reopenSharedPage(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
}

/** Put the editor in block `id` by clicking its static row. */
async function editBlock(id: string): Promise<void> {
  const row = $(`[data-testid="block-static"][data-block-id="${id}"]`)
  await row.waitForClickable({ timeout: ACTION_TIMEOUT })
  await row.click()
  await browser.waitUntil(
    () =>
      browser.execute(
        (blockId: string) =>
          document.activeElement
            ?.closest('[data-testid="block-editor"]')
            ?.getAttribute('data-block-id') === blockId,
        id,
      ),
    { timeout: ACTION_TIMEOUT, timeoutMsg: `the editor never opened in block ${id}` },
  )
}

/**
 * Wait until the rows of `expected`'s blocks show in that order and at those
 * levels. A row's level is the `aria-level` of its `<li>`
 * (SortableBlockWrapper, depth + 1); rows of other blocks are ignored.
 */
async function waitForOutline(expected: [string, number][], what: string): Promise<void> {
  const ids = expected.map(([id]) => id)
  const want = JSON.stringify(expected.map(([id, level]) => `${id}@${level}`))
  let seen: string[] = []
  await browser
    .waitUntil(
      async () => {
        seen = await browser.execute(
          (wanted: string[]) =>
            [...document.querySelectorAll('[data-testid="sortable-block"]')]
              .map((row) => ({
                id: row.getAttribute('data-block-id') ?? '',
                level: row.closest('li[aria-level]')?.getAttribute('aria-level') ?? null,
              }))
              .filter((row) => wanted.includes(row.id))
              .map((row) => `${row.id}@${row.level}`),
          ids,
        )
        return JSON.stringify(seen) === want
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${what}: expected ${want}, saw ${JSON.stringify(seen)}`)
    })
}

/**
 * Wait until block `id`'s static row reads exactly `text`. Read in one
 * `execute`: a row resolved by one command can be re-rendered away by a sync
 * before the next reads it.
 */
async function waitForStaticText(id: string, text: string, what: string): Promise<void> {
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        seen = await browser.execute(
          (blockId: string) =>
            document
              .querySelector(`[data-testid="block-static"][data-block-id="${blockId}"]`)
              ?.textContent?.trim() ?? '(no row)',
          id,
        )
        return seen === text
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${what}: expected ${JSON.stringify(text)}, saw ${JSON.stringify(seen)}`)
    })
}

/**
 * Pull with the sidebar's Sync, which leaves the open view mounted, until block
 * `id`'s static row reads exactly `text`. A pull already running can end
 * without the peer's write, so Sync is pressed again whenever it is idle.
 */
async function pullUntilRowReads(id: string, text: string, what: string): Promise<void> {
  const sync = $('[data-slot="sidebar"] button[aria-label="Sync"]')
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        seen = await browser.execute(
          (blockId: string) =>
            document
              .querySelector(`[data-testid="block-static"][data-block-id="${blockId}"]`)
              ?.textContent?.trim() ?? '(no row)',
          id,
        )
        if (seen === text) return true
        if ((await sync.getAttribute('aria-disabled')) === 'false') await sync.click()
        return false
      },
      { timeout: NAV_TIMEOUT, interval: 1_000 },
    )
    .catch(() => {
      throw new Error(`${what}: expected ${JSON.stringify(text)}, saw ${JSON.stringify(seen)}`)
    })
}

/** Wait until the peer's copy of block `id` reads exactly `text`. */
async function waitForPeerText(device: SyncPeer, id: string, text: string): Promise<void> {
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        seen = (await device.getBlock(id)).content
        return seen === text
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(
        `the peer did not converge: expected ${JSON.stringify(text)}, saw ${JSON.stringify(seen)}`,
      )
    })
}

/** Wait until the peer's file for attachment `id` holds exactly `bytes`. */
async function waitForPeerBytes(device: SyncPeer, id: string, bytes: Buffer): Promise<void> {
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        try {
          const held = await device.readAttachment(id)
          seen = held.toString('base64')
          return held.equals(bytes)
        } catch (error) {
          seen = String(error)
          return false
        }
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`the peer does not hold the image's bytes: ${seen}`)
    })
}

/** Wait until the app's `read_attachment` serves attachment `id` as exactly `bytes`. */
async function waitForAppBytes(id: string, bytes: Buffer): Promise<void> {
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        seen = await browser.execute(async (attachmentId: string) => {
          const internals = (
            window as unknown as {
              __TAURI_INTERNALS__: {
                invoke: (cmd: string, args: unknown) => Promise<ArrayBuffer>
              }
            }
          ).__TAURI_INTERNALS__
          try {
            const held = new Uint8Array(await internals.invoke('read_attachment', { attachmentId }))
            return btoa(String.fromCharCode(...held))
          } catch (error) {
            return JSON.stringify(error)
          }
        }, id)
        return seen === bytes.toString('base64')
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`the app does not hold the image's bytes: ${seen}`)
    })
}

/** Block `id`'s property chip holding `value`; chips render in its row, outside its text. */
function chipIn(id: string, value: string) {
  return $(`[data-testid="sortable-block"][data-block-id="${id}"]`).$(
    `[data-testid="property-chip"]*=${value}`,
  )
}

/** Whether the sidebar's Sync button takes a click: it is `aria-disabled` while a sync runs. */
async function syncIdle(): Promise<boolean> {
  return (await $(SYNC_BUTTON).getAttribute('aria-disabled')) === 'false'
}

async function waitSyncIdle(): Promise<void> {
  await browser.waitUntil(syncIdle, {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'the app never finished the sync it was running',
  })
}

/** Press the sidebar's Sync, which leaves the open view mounted, and wait for the app's pull. */
async function pullFromPeer(device: SyncPeer): Promise<void> {
  await waitSyncIdle()
  await $(SYNC_BUTTON).click()
  await device.waitPulled()
}

/** Write on the peer, then pull from it. */
async function pullPeerWrites<T>(device: SyncPeer, writes: () => Promise<T>): Promise<T> {
  const written = await writes()
  await pullFromPeer(device)
  return written
}

/**
 * Keep the peer out of every session until its `releaseSync`, for a peer write
 * that must not have seen the app's (`SyncPeer.holdSync`). A sidebar sync still
 * running would be refused as busy and toast its failure, so it ends first.
 */
async function holdPeer(device: SyncPeer): Promise<void> {
  await waitSyncIdle()
  await device.holdSync()
}

/**
 * Wait until the open view shows `holds`, pressing Sync again between reads. A
 * pull of the daemon's already running at the first press can end after the
 * peer's writes without carrying them, and answer `waitPulled` early; a later
 * pull carries them. A pull never remounts the view, so with the refresh gone
 * none of them makes `holds` true.
 */
async function waitInOpenView(holds: () => Promise<boolean>, what: () => string): Promise<void> {
  await browser
    .waitUntil(
      async () => {
        if (await holds()) return true
        if (await syncIdle()) await $(SYNC_BUTTON).click()
        return false
      },
      { timeout: NAV_TIMEOUT, interval: 1_000 },
    )
    .catch(() => {
      throw new Error(what())
    })
}

/**
 * Wait until `holds`, pressing Sync and re-opening the view with `open` between
 * reads. For a seed only: a remount re-queries, so it would hide a refresh
 * under test.
 */
async function waitInFreshView(
  open: () => Promise<void>,
  holds: () => Promise<boolean>,
  what: string,
): Promise<void> {
  await open()
  await browser.waitUntil(
    async () => {
      if (await holds()) return true
      if (await syncIdle()) await $(SYNC_BUTTON).click()
      await navigateTo('Tags')
      await open()
      return false
    },
    { timeout: NAV_TIMEOUT, interval: 1_000, timeoutMsg: what },
  )
}

/** The DOM text of `selector`, or '' when it is not rendered; read whether or not it is visible. */
function textOf(selector: string): Promise<string> {
  return browser.execute((sel: string) => document.querySelector(sel)?.textContent ?? '', selector)
}

/** The local date `offsetDays` from today, as the app's views compute it. */
function localDate(offsetDays: number): Promise<string> {
  return browser.execute((offset: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }, offsetDays)
}

/** Switch the journal to `mode` (`JournalControls`, `journalTabId(mode)`). */
async function openJournalMode(mode: 'daily' | 'weekly'): Promise<void> {
  await navigateTo('Journal')
  const tab = $(`#journal-tab-${mode}`)
  await tab.waitForClickable({ timeout: NAV_TIMEOUT })
  await tab.click()
  await browser.waitUntil(async () => (await tab.getAttribute('aria-selected')) === 'true', {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `the ${mode} journal tab never became selected`,
  })
}

/**
 * The id of a week day other than `except` that still shows its no-page empty
 * state. Its "No blocks for" sentence is for screen readers only, which
 * `getText()` leaves out, so this reads the text content.
 */
async function emptyWeekDay(except: string): Promise<string> {
  let found: string | undefined
  await browser.waitUntil(
    async () => {
      for (const day of await $$('section[id^="journal-"]').getElements()) {
        const date = ((await day.getAttribute('id')) ?? '').replace('journal-', '')
        const text = await browser.execute((el: HTMLElement) => el.textContent ?? '', day)
        if (date !== except && text.includes('No blocks for')) {
          found = date
          return true
        }
      }
      return false
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: `the week view shows no day but ${except} without a page` },
  )
  if (found === undefined) throw new Error('no empty week day found')
  return found
}

/** A Pages list row's title span (PageBrowser/PageRow.tsx), by exact title. */
function pageRow(title: string): string {
  return `//span[contains(@class, "page-browser-item-title")][normalize-space(.)="${title}"]`
}

/** Whether the Pages list shows `upper` above `lower`, in its order (PageRow.tsx's `data-index`). */
async function listsAbove(upper: string, lower: string): Promise<boolean> {
  const titles = await browser.execute(() => {
    const rows = [...document.querySelectorAll('[data-page-item]')]
    rows.sort((a, b) => Number(a.getAttribute('data-index')) - Number(b.getAttribute('data-index')))
    return rows.map(
      (row) => row.querySelector('.page-browser-item-title')?.getAttribute('data-page-title') ?? '',
    )
  })
  const at = titles.indexOf(upper)
  return at !== -1 && titles.includes(lower) && at < titles.indexOf(lower)
}

/** `key`'s row button in Settings › Properties, which opens its sheet. */
const propertyRowButton = (key: string) => `button[aria-label="Edit property ${key}"]`

/** The value type badge of `key`'s row in Settings › Properties, or null when it is not listed. */
function listedType(key: string): Promise<string | null> {
  return browser.execute((selector: string) => {
    const row = document.querySelector(selector)?.closest('[data-slot="list-item"]')
    return row?.querySelector('[data-slot="badge"]')?.textContent ?? null
  }, propertyRowButton(key))
}

/** Settings › Properties, opened from another view so it lists afresh. */
async function reopenProperties(): Promise<void> {
  await navigateTo('Pages')
  await openSettingsTab('properties')
}

/** Wait until the peer, pulling from the app, holds `content` in block `id`. */
async function waitPeerHolds(device: SyncPeer, id: string, content: string): Promise<void> {
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        await device.sync()
        seen = (await device.getBlock(id)).content
        return seen === content
      },
      { timeout: NAV_TIMEOUT, interval: 1_000 },
    )
    .catch(() => {
      throw new Error(
        `the peer holds ${JSON.stringify(seen)} in ${id}, not ${JSON.stringify(content)}`,
      )
    })
}

/** The text of the mirrored peer page's file, under whatever space folder holds it; '' while there is none. */
function mirroredPageFile(): string {
  const file = readdirSync(mirrorFolder, { recursive: true, withFileTypes: true }).find(
    (entry) => entry.isFile() && entry.name === `${MIRROR_TITLE}.md`,
  )
  if (file === undefined) return ''
  return readFileSync(path.join(file.parentPath, file.name), 'utf8')
}

/**
 * Wait until the mirrored page's file holds `text`, pressing the sidebar's Sync
 * between reads: a pull already running at the first press can end without the
 * peer's write, and a later one carries it.
 */
async function syncUntilFileHolds(text: string, absent?: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const onDisk = mirroredPageFile()
      if (onDisk.includes(text) && (absent === undefined || !onDisk.includes(absent))) return true
      if (await syncIdle()) await $(SYNC_BUTTON).click()
      return false
    },
    {
      timeout: NAV_TIMEOUT,
      interval: 1_000,
      timeoutMsg: `${MIRROR_TITLE}.md never held ${text}; it holds ${JSON.stringify(mirroredPageFile())}`,
    },
  )
}

/** What the pairing test leaves for the tests after it. */
interface Paired {
  deviceId: string
  appDeviceId: string
  pageId: string
  appBlockId: string
  peerBlockId: string
}

describe('Agaric real-backend two-device sync (#5365) @sync @editor @pages @settings @markdown', () => {
  let peer: SyncPeer | undefined
  let paired: Paired | undefined

  before(async () => {
    peer = await startSyncPeer()
  })

  after(async () => {
    await peer?.stop()
    rmSync(mirrorFolder, { recursive: true, force: true })
  })

  it('cancelling a pairing and reopening it mints a new passphrase', async () => {
    await waitForAppReady()
    await openSyncSettings()
    const first = await openPairing()
    await cancelPairing()

    const second = await openPairing()
    expect(second).not.toBe(first)
    // What the dialog shows is the new session's, the one its QR carries.
    expect((await readPairingQr()).passphrase).toBe(second)
    await cancelPairing()
  })

  it('pairs with a second device and syncs one edit each way', async () => {
    if (peer === undefined) throw new Error('the sync peer never started')
    await waitForAppReady()

    // This device shows the code; the peer scans it.
    await openSyncSettings()
    const passphrase = await openPairing()
    const qr = await readPairingQr()
    expect(passphrase).toBe(qr.passphrase)
    const remote = await peer.pair(qr)
    await waitForToast('Device paired successfully')
    await $('[data-testid="pairing-qr-code"]').waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
    })

    // App → peer: a block written here is in the peer's vault after its pull.
    await openNewPage()
    await typeMarkerVerified(APP_EDIT)
    await reopenSharedPage()
    const appBlock = blockStaticByMarker(APP_EDIT)
    await appBlock.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const appBlockId = await appBlock.getAttribute('data-block-id')
    if (appBlockId === null) throw new Error('the app block row carries no data-block-id')
    await peer.sync()
    const copy = await peer.getBlock(appBlockId)
    expect(copy.content).toBe(APP_EDIT)
    if (copy.parentId === null) throw new Error(`the peer holds ${copy.id} with no page`)

    // Peer → app: the peer writes on the same page, then the app dials it.
    const peerBlockId = await peer.createBlock(copy.parentId, PEER_EDIT)
    await setPeerAddress(remote.deviceId, remote.address)

    // The pairing and the address are the backend's, read back after a round trip.
    await navigateTo('Journal')
    await openSyncSettings()
    await peerRow(remote.deviceId)
      .$(`span=${remote.address}`)
      .waitForDisplayed({ timeout: NAV_TIMEOUT })
    await clickSyncNow(remote.deviceId)
    await peer.waitPulled()

    await reopenSharedPage()
    await blockStaticByMarker(PEER_EDIT).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await blockStaticByMarker(APP_EDIT).waitForDisplayed({ timeout: NAV_TIMEOUT })
    paired = {
      deviceId: remote.deviceId,
      appDeviceId: qr.device_id,
      pageId: copy.parentId,
      appBlockId,
      peerBlockId,
    }
  })

  // The tests below build on the pairing the one above makes. Without it they
  // stop here, as one failure, instead of each failing for the same reason.
  describe('on the pairing', () => {
    before(() => {
      if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
    })

    it('syncs a property and a move each way', async () => {
      if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
      const { deviceId, pageId, appBlockId, peerBlockId } = paired
      await reopenSharedPage()
      await waitForOutline(
        [
          [appBlockId, 1],
          [peerBlockId, 1],
        ],
        'the shared page does not open as the pairing test left it',
      )

      // App → peer: Tab nests the peer's block under the app's, and a new block
      // below it whose only text is a property line stores it as the property.
      await editBlock(peerBlockId)
      await browser.keys(['Tab'])
      await waitForOutline(
        [
          [appBlockId, 1],
          [peerBlockId, 2],
        ],
        'Tab did not nest the block',
      )
      const propBlockId = await enterBlankSibling()
      await typeMarkerVerified(`${KEY}:: ${APP_VALUE}`)
      await browser.keys(['Escape'])
      await chipIn(propBlockId, APP_VALUE).waitForDisplayed({ timeout: ACTION_TIMEOUT })

      await reopenSharedPage()
      await waitForOutline(
        [
          [appBlockId, 1],
          [peerBlockId, 2],
          [propBlockId, 2],
        ],
        'the re-opened page lost the indent or the new block',
      )
      await chipIn(propBlockId, APP_VALUE).waitForDisplayed({ timeout: NAV_TIMEOUT })
      await peer.sync()
      expect((await peer.getBlock(peerBlockId)).parentId).toBe(appBlockId)
      expect(await peer.getProperty(propBlockId, KEY)).toBe(APP_VALUE)

      // Peer → app: the peer sets a property on the app's block and moves its
      // own block back out, to the top of the page.
      await peer.setProperty(appBlockId, KEY, PEER_VALUE)
      await peer.moveBlock(peerBlockId, pageId, 0)
      await openSyncSettings()
      await clickSyncNow(deviceId)
      await peer.waitPulled()

      await reopenSharedPage()
      await waitForOutline(
        [
          [peerBlockId, 1],
          [appBlockId, 1],
          [propBlockId, 2],
        ],
        "the app does not show the peer's move",
      )
      await chipIn(appBlockId, PEER_VALUE).waitForDisplayed({ timeout: NAV_TIMEOUT })
    })

    it('converges concurrent edits to one block on both devices', async () => {
      if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
      const { deviceId, peerBlockId } = paired
      const appText = `${PEER_EDIT} ${APP_TAIL}`
      const merged = `${PEER_HEAD} ${appText}`

      // The app appends first and closes its editor, so its edit is an op of
      // its own before the peer writes and the two meet in the merge. An edit
      // still in the editor when the pull lands is the next test's.
      await reopenSharedPage()
      await holdPeer(peer)
      try {
        await editBlock(peerBlockId)
        await caretToEnd()
        // One key per call: WebKit coalesces identical adjacent keys sent together.
        for (const ch of ` ${APP_TAIL}`) {
          await browser.keys([ch])
          await browser.pause(40)
        }
        await browser.waitUntil(async () => (await $(EDITOR).getText()) === appText, {
          timeout: ACTION_TIMEOUT,
          timeoutMsg: `the appended text never landed intact in the editor; expected ${appText}`,
        })
        await browser.keys(['Escape'])

        // The peer prepends to the copy it holds, which must still lack the
        // app's edit: neither edit has seen the other. Held, it has pulled none.
        const held = (await peer.getBlock(peerBlockId)).content
        if (held !== PEER_EDIT) {
          throw new Error(
            `the peer pulled the app's edit before writing its own, so the edits were not concurrent: it holds ${JSON.stringify(held)}`,
          )
        }
        await peer.editBlock(peerBlockId, `${PEER_HEAD} ${PEER_EDIT}`)
      } finally {
        await peer.releaseSync()
      }

      // Each pulls the other's edit, and the two splices merge into one text.
      await peer.sync()
      await waitForPeerText(peer, peerBlockId, merged)
      await openSyncSettings()
      await clickSyncNow(deviceId)
      await peer.waitPulled()
      await reopenSharedPage()
      await waitForStaticText(peerBlockId, merged, 'the app did not converge')
    })

    // #6533 — the editor never shows the peer's edit, so its save sends text
    // without it; `edit_block` replays the typed change on the pulled text.
    it("a peer's edit pulled under an editor being typed in survives the editor's save", async () => {
      if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
      const { peerBlockId } = paired
      const stored = async () =>
        (await invoke<{ content: string }>('get_block', { blockId: peerBlockId })).content
      const before = `${PEER_HEAD} ${PEER_EDIT} ${APP_TAIL}`
      const peerText = `${PEER_FRONT} ${before}`

      await reopenSharedPage()
      await waitForStaticText(peerBlockId, before, 'the block is not as the last test left it')
      await editBlock(peerBlockId)
      await caretToEnd()
      await peer.editBlock(peerBlockId, peerText)
      if ((await stored()) !== before) {
        throw new Error("the app pulled the peer's edit before a key was typed")
      }

      // Keys closer together than the idle commit's debounce keep the editor
      // unsaved until the pull has landed. The pull is the sidebar button's,
      // pressed from script: a pointer press would blur the editor and save it
      // first. A pull already running can end without the peer's edit, so the
      // button is pressed again whenever it is idle.
      let typed = ''
      let pulled = ''
      for (let i = 0; i < 240 && pulled === ''; i++) {
        const key = 'abcdefghij'.charAt(i % 10)
        await browser.keys([key])
        typed += key
        if (i % 3 === 0) {
          await browser.execute((selector: string) => {
            const button = document.querySelector<HTMLElement>(selector)
            if (button?.getAttribute('aria-disabled') === 'false') button.click()
          }, SYNC_BUTTON)
          const held = await stored()
          if (held.startsWith(PEER_FRONT)) pulled = held
          else if (held !== before) {
            throw new Error(`the editor saved before the pull landed: ${JSON.stringify(held)}`)
          }
        }
        await browser.pause(60)
      }
      if (pulled !== peerText) {
        throw new Error(
          `the peer's edit did not land alone under the open editor: ${JSON.stringify(pulled)}`,
        )
      }
      // The editor keeps its own text: it was not given the peer's.
      await browser.waitUntil(async () => (await $(EDITOR).getText()) === `${before}${typed}`, {
        timeout: ACTION_TIMEOUT,
        timeoutMsg: `the editor does not hold what was typed; expected ${before}${typed}`,
      })

      // The idle commit saves what was typed onto the peer's text.
      const both = `${peerText}${typed}`
      let saved = ''
      await browser
        .waitUntil(
          async () => {
            saved = await stored()
            return saved === both
          },
          { timeout: ACTION_TIMEOUT },
        )
        .catch(() => {
          throw new Error(
            `the editor's save did not keep both edits: expected ${JSON.stringify(both)}, stored ${JSON.stringify(saved)}`,
          )
        })
      await browser.keys(['Escape'])

      await peer.sync()
      await waitForPeerText(peer, peerBlockId, both)
      await reopenSharedPage()
      await waitForStaticText(peerBlockId, both, 'the app does not show both edits')
    })

    it('an image pasted in the app reaches the peer, bytes included', async () => {
      if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
      await reopenSharedPage()
      await editBlock(paired.peerBlockId)
      await enterBlankSibling()
      await typeMarkerVerified(APP_IMAGE)
      await pasteFileIntoFocusedBlock(APP_PNG.toString('base64'), FILENAME, 'image/png')
      await waitForToast(`Attached "${FILENAME}"`)
      await reopenSharedPage()
      const imageBlock = blockStaticByMarker(APP_IMAGE)
      await imageBlock.waitForDisplayed({ timeout: NAV_TIMEOUT })
      const imageBlockId = await imageBlock.getAttribute('data-block-id')
      if (imageBlockId === null) throw new Error('the image block row carries no data-block-id')

      await peer.sync()
      const attachments = await peer.listAttachments(imageBlockId)
      expect(attachments).toEqual([
        {
          id: expect.any(String),
          filename: FILENAME,
          mime_type: 'image/png',
          size_bytes: APP_PNG.length,
        },
      ])
      const [attachment] = attachments
      if (attachment === undefined) throw new Error('the peer holds no attachment row')
      expect((await peer.getBlock(imageBlockId)).content).toContain(
        `](attachment:${attachment.id})`,
      )
      await waitForPeerBytes(peer, attachment.id, APP_PNG)
    })

    it('an image the peer attaches renders in the app from its bytes', async () => {
      if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
      const { deviceId, pageId } = paired
      // What a paste there writes: the attachment, then its ref in the block's text.
      const imageBlockId = await peer.createBlock(pageId, PEER_IMAGE)
      const attachmentId = await peer.addAttachment(imageBlockId, FILENAME, 'image/png', PEER_PNG)
      await peer.editBlock(imageBlockId, `${PEER_IMAGE}![${FILENAME}](attachment:${attachmentId})`)

      await openSyncSettings()
      await clickSyncNow(deviceId)
      await peer.waitPulled()
      await waitForAppBytes(attachmentId, PEER_PNG)
      await reopenSharedPage()
      await blockStaticByMarker(PEER_IMAGE).waitForDisplayed({ timeout: NAV_TIMEOUT })
      await expectImageRendered(imageBlockId, "after the app's pull")
    })

    it('a meeting made in the app reaches the peer with its files on the recording block', async () => {
      if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
      const spaces = await invoke<{ id: string; name: string }[]>('list_spaces')
      const spaceId = (spaces.find((space) => space.name === 'Personal') ?? spaces[0])?.id
      const file = ({ name, bytes }: { name: string; bytes: Buffer }) => ({
        filename: name,
        bytes: bytes.toString('base64'),
      })
      // The dialog's call, linked from the block both devices share.
      const made = await invoke<{ page_id: string; recording_block_id: string }>('add_meeting', {
        input: {
          space_id: spaceId,
          title: MEETING,
          date: '2031-03-14',
          link_block_id: paired.appBlockId,
          audio: file(MEETING_FILES.audio),
          transcript: file(MEETING_FILES.transcript),
          summary_file: file(MEETING_FILES.summary),
        },
      })

      await peer.sync()
      const held = await peer.listAttachments(made.recording_block_id)
      expect(held.map((row) => row.filename).toSorted()).toEqual(
        Object.values(MEETING_FILES)
          .map((one) => one.stored)
          .toSorted(),
      )
      for (const one of Object.values(MEETING_FILES)) {
        const row = held.find((candidate) => candidate.filename === one.stored)
        if (row === undefined) throw new Error(`the peer holds no ${one.stored}`)
        await waitForPeerBytes(peer, row.id, one.bytes)
      }
      expect((await peer.getBlock(made.recording_block_id)).parentId).toBe(made.page_id)
      expect((await peer.getBlock(paired.appBlockId)).content).toContain(`[[${made.page_id}]]`)
    })

    // #6541 — a pull brings the peer's ops as replicated rows, which the page's
    // positional undo does not number, so the open page keeps its undo and redo
    // through the reload the pull brings. Leaving the page would drop them.
    it("the open page's undo and redo survive a pull of the peer's edits", async () => {
      if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
      const { pageId, peerBlockId } = paired
      // A block of plain text: a click on the app's own block, which links the
      // meeting page by now, can land on the link instead of opening the editor.
      const before = runScopedMarker('wdio-sync-undo-before')
      const appBlockId = await peer.createBlock(pageId, before)
      await reopenSharedPage()
      await pullUntilRowReads(appBlockId, before, 'the app never showed the new block')
      const appEdit = runScopedMarker('wdio-sync-undo-app')
      const peerText = `${(await peer.getBlock(peerBlockId)).content} ${runScopedMarker('wdio-sync-undo-peer')}`
      const peerOver = runScopedMarker('wdio-sync-undo-over')
      const stored = async (id: string) =>
        (await invoke<{ content: string }>('get_block', { blockId: id })).content
      const waitStored = async (id: string, text: string, what: string) => {
        let seen = ''
        await browser
          .waitUntil(
            async () => {
              seen = await stored(id)
              return seen === text
            },
            { timeout: ACTION_TIMEOUT },
          )
          .catch(() => {
            throw new Error(
              `${what}: expected ${JSON.stringify(text)}, stored ${JSON.stringify(seen)}`,
            )
          })
      }

      await editBlock(appBlockId)
      await typeMarkerVerified(appEdit)
      await browser.keys(['Escape'])
      await waitStored(appBlockId, appEdit, 'the edit was not saved')
      await browser.keys(['Control', 'z'])
      await waitStored(appBlockId, before, 'Ctrl+Z did not undo the edit')

      // The peer edits another block of the page; the app pulls with it open.
      await peer.editBlock(peerBlockId, peerText)
      await pullUntilRowReads(peerBlockId, peerText, "the open page never showed the peer's edit")
      await browser.keys(['Control', 'y'])
      await waitStored(appBlockId, appEdit, 'Ctrl+Y after the pull did not redo the edit')

      // The peer writes over the redone edit. Ctrl+Z still reverts it: the
      // reverse is an edit back to the text before it, which replaces the
      // peer's text in that block, as the page-level undo always has.
      await peer.sync()
      await waitForPeerText(peer, appBlockId, appEdit)
      await peer.editBlock(appBlockId, peerOver)
      await pullUntilRowReads(appBlockId, peerOver, "the open page never showed the peer's edit")
      await browser.keys(['Control', 'z'])
      await waitStored(appBlockId, before, 'Ctrl+Z did not revert the edit the peer wrote over')
      await peer.sync()
      await waitForPeerText(peer, appBlockId, before)
    })

    it('the Settings state card shows Idle, a last-sync time and one peer after the syncs', async () => {
      await openSyncSettings()
      // Read in one `execute`: the card re-renders as the sync store refreshes.
      const readCard = () =>
        browser.execute(() => {
          const text = (selector: string) => document.querySelector(selector)?.textContent ?? ''
          return {
            state: text('.sync-state-label'),
            peers: text('.sync-peer-count'),
            lastSynced: text('.sync-last-synced'),
          }
        })
      let seen = await readCard()
      await browser
        .waitUntil(
          async () => {
            seen = await readCard()
            return (
              seen.state === 'Idle' && seen.peers === '1' && /^just now$|ago$/.test(seen.lastSynced)
            )
          },
          { timeout: NAV_TIMEOUT },
        )
        .catch(() => {
          throw new Error(
            `the state card did not settle on Idle, 1 peer and a time: ${JSON.stringify(seen)}`,
          )
        })
    })

    // #6526 — what the other device's manual address field takes. The mock has no
    // endpoint, so only this lane can show the row.
    it("Settings shows this device's sync address", async () => {
      await openSyncSettings()
      const address = await $('[data-testid="local-sync-address"]')
      await address.waitForDisplayed({ timeout: NAV_TIMEOUT })
      expect(await address.getText()).toMatch(/^\d+\.\d+\.\d+\.\d+:[1-9]\d*$/)
    })

    // #5739 — the peer freezes, so the app's dial gets no answer. Cancel must end
    // it at once and as idle: without the cancel the dial runs out its budget into
    // an uncoded failure, which sets the state card to Error and raises a "Sync
    // failed" toast in the same moment it clears the row.
    it('a sync cancelled while the peer does not answer ends idle, and the pair syncs after', async () => {
      if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
      const { deviceId, pageId } = paired

      // A pull first, so the daemon's own resync leaves this peer alone for a
      // minute. A resync already due can still take the pull, or outlast it;
      // `freezeAndDial` waits that session out.
      await peer.createBlock(pageId, BEFORE_PAUSE)
      await openSyncSettings()
      await clickSyncNow(deviceId)
      await peer.waitPulled()

      try {
        const cancel = await freezeAndDial(peer, deviceId)
        await cancel.click()

        let seen = await readSyncSurface(deviceId)
        await browser
          .waitUntil(
            async () => {
              seen = await readSyncSurface(deviceId)
              return seen.rowFound && !seen.sessionShown
            },
            { timeout: ACTION_TIMEOUT },
          )
          .catch(() => {
            throw new Error(`the row never left the cancelled sync: ${JSON.stringify(seen)}`)
          })
        seen = await readSyncSurface(deviceId)
        expect(seen.state).toBe('Idle')
      } finally {
        peer.resume()
      }

      // The pair still works: the peer's next write reaches the app.
      await peer.createBlock(pageId, AFTER_CANCEL)
      await clickSyncNow(deviceId)
      await peer.waitPulled()
      await reopenSharedPage()
      await blockStaticByMarker(AFTER_CANCEL).waitForDisplayed({ timeout: NAV_TIMEOUT })
    })

    it('an edit here reaches the other device with no Sync press (#6551)', async () => {
      if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
      const device = peer
      await openNewPage(UNPRESSED_PAGE)
      await typeMarkerVerified(UNPRESSED_EDIT)
      await browser.keys(['Escape'])
      const row = blockStaticByMarker(UNPRESSED_EDIT)
      await row.waitForDisplayed({ timeout: ACTION_TIMEOUT })
      const blockId = await row.getAttribute('data-block-id')
      if (blockId === null) throw new Error('the block row carries no data-block-id')

      // Neither `peer.sync()` nor a press: the commit asks this device's daemon
      // for a round, the peer serves it, sees this device is ahead, and pulls.
      let held = 'the peer does not hold the block'
      await browser
        .waitUntil(
          async () => {
            held = await device.getBlock(blockId).then(
              (block) => block.content,
              (error: unknown) => String(error),
            )
            return held === UNPRESSED_EDIT
          },
          { timeout: NAV_TIMEOUT, interval: 500 },
        )
        .catch(() => {
          throw new Error(`the edit never reached the peer: ${held}`)
        })
    })

    it('a task the peer marks DONE leaves the Due panel and joins the Done panel (#5256)', async () => {
      if (peer === undefined) throw new Error('the pairing test failed')
      const device = peer
      const today = await localDate(0)
      // The panels leave out the open day's own blocks, so the task has a page of its own.
      const taskId = await pullPeerWrites(device, async () => {
        const page = await device.createInSpace('page', TASKS_PAGE)
        const id = await device.createBlock(page, TODAY_TASK)
        await device.setTodoState(id, 'TODO')
        await device.setDueDate(id, today)
        return id
      })
      await waitInFreshView(
        // Today's daily journal, where the Due, Done and Unfinished panels mount.
        () => openJournalMode('daily'),
        async () => (await textOf(DUE_PANEL)).includes(TODAY_TASK),
        "today's Due panel never listed the peer's task",
      )
      expect(await textOf(DONE_PANEL)).not.toContain(TODAY_TASK)

      await pullPeerWrites(device, () => device.setTodoState(taskId, 'DONE'))
      await waitInOpenView(
        async () =>
          (await textOf(DONE_PANEL)).includes(TODAY_TASK) &&
          !(await textOf(DUE_PANEL)).includes(TODAY_TASK),
        () => 'the open journal did not move the task from the Due panel to the Done panel',
      )
    })

    it('an overdue task the peer marks DONE leaves Overdue (#5256)', async () => {
      if (peer === undefined) throw new Error('the pairing test failed')
      const device = peer
      const yesterday = await localDate(-1)
      const taskId = await pullPeerWrites(device, async () => {
        const page = await device.createInSpace('page', LATE_PAGE)
        const id = await device.createBlock(page, LATE_TASK)
        await device.setTodoState(id, 'TODO')
        await device.setDueDate(id, yesterday)
        return id
      })
      // The Due panel lists the Overdue tab's tasks while that tab is selected.
      const showOverdue = async (): Promise<void> => {
        await openJournalMode('daily')
        // Absent while the panel lists nothing; the wait reopens the view.
        if (await $(OVERDUE_TAB).isExisting()) await $(OVERDUE_TAB).click()
      }
      const overdueListed = async (): Promise<string> =>
        (await $(OVERDUE_TAB).getAttribute('aria-selected')) === 'true' ? textOf(DUE_PANEL) : ''
      await waitInFreshView(
        showOverdue,
        async () => (await overdueListed()).includes(LATE_TASK),
        "Overdue never listed the peer's overdue task",
      )

      await pullPeerWrites(device, () => device.setTodoState(taskId, 'DONE'))
      // The Done panel listing it shows the pull has reached the open journal.
      await waitInOpenView(
        async () =>
          (await textOf(DONE_PANEL)).includes(LATE_TASK) &&
          (await $(OVERDUE_TAB).getAttribute('aria-selected')) === 'true' &&
          !(await textOf(DUE_PANEL)).includes(LATE_TASK),
        () => 'the open journal still lists the done task under Overdue',
      )
    })

    it('the Pages list shows a page the peer created and one it renamed (#5258)', async () => {
      if (peer === undefined) throw new Error('the pairing test failed')
      const device = peer
      const listedId = await pullPeerWrites(device, () => device.createInSpace('page', LISTED))
      await waitInFreshView(
        () => navigateTo('Pages'),
        () => $(pageRow(LISTED)).isDisplayed(),
        "the Pages list never showed the peer's page",
      )

      await pullPeerWrites(device, async () => {
        await device.createInSpace('page', CREATED)
        await device.editBlock(listedId, RENAMED)
      })
      const titles = () =>
        browser.execute(() =>
          [...document.querySelectorAll('.page-browser-item-title')].map(
            (t) => t.textContent ?? '',
          ),
        )
      let seen: string[] = []
      await waitInOpenView(
        async () => {
          seen = await titles()
          return seen.includes(CREATED) && seen.includes(RENAMED) && !seen.includes(LISTED)
        },
        () => `the open Pages list did not follow the peer: it lists ${JSON.stringify(seen)}`,
      )
    })

    it("the open page's title and tabs show the peer's new title (#5242)", async () => {
      if (peer === undefined) throw new Error('the pairing test failed')
      const device = peer
      const pageId = await pullPeerWrites(device, async () => {
        const id = await device.createInSpace('page', OPEN_TITLE)
        // A block of its own, so opening the page creates no first block here.
        await device.createBlock(id, runScopedMarker('wdio-peer-open-page-body'))
        return id
      })
      await waitInFreshView(
        () => navigateTo('Pages'),
        () => $(pageRow(OPEN_TITLE)).isDisplayed(),
        "the Pages list never showed the peer's page",
      )
      await reopenPageByTitle(OPEN_TITLE)
      await browser.waitUntil(async () => (await $(TITLE).getText()) === OPEN_TITLE, {
        timeout: ACTION_TIMEOUT,
        timeoutMsg: "the peer's page never opened under its title",
      })
      // A second tab on the same page makes the (otherwise hidden) tab bar render.
      await browser.keys(['Control', 't'])
      await browser.waitUntil(
        async () => (await $$(`${TAB_LIST} [role="tab"]`).getElements()).length === 2,
        { timeout: ACTION_TIMEOUT, timeoutMsg: 'Ctrl+T did not open a second tab' },
      )
      expect(await textOf(TAB_LIST)).toContain(OPEN_TITLE)

      await pullPeerWrites(device, () => device.editBlock(pageId, RETITLED))
      let seen = { title: '', tabs: '' }
      await waitInOpenView(
        async () => {
          seen = { title: await $(TITLE).getText(), tabs: await textOf(TAB_LIST) }
          return (
            seen.title === RETITLED &&
            seen.tabs.includes(RETITLED) &&
            !seen.tabs.includes(OPEN_TITLE)
          )
        },
        () => `the open page kept its old title: ${JSON.stringify(seen)}`,
      )
    })

    it('tag:# finds the block once the peer creates and applies the tag (#5255)', async () => {
      if (peer === undefined) throw new Error('the pairing test failed')
      const device = peer
      await navigateTo('Search')
      await typeInputVerified(SEARCH_INPUT, `tag:#${TAG}`)
      await browser.keys(['Enter'])
      // Settled: the search is held until the tag name resolves, here to none.
      await browser.waitUntil(async () => (await textOf(SEARCH_STATUS)) === 'No results', {
        timeout: ACTION_TIMEOUT,
        timeoutMsg: `the search for an unknown tag never settled on no results`,
      })

      const blockId = await pullPeerWrites(device, async () => {
        const page = await device.createInSpace('page', TAGGED_PAGE)
        const id = await device.createBlock(page, TAGGED)
        const tag = await device.createInSpace('tag', TAG)
        await device.addTag(id, tag)
        return id
      })
      await waitInOpenView(
        () => $(`[data-testid="search-result-row-${blockId}"]`).isDisplayed(),
        () => `the open search for tag:#${TAG} never listed the block the peer tagged`,
      )
    })

    it('a journal day the peer wrote stops offering an empty day (#5258)', async () => {
      if (peer === undefined) throw new Error('the pairing test failed')
      const device = peer
      await openJournalMode('weekly')
      // Not today: the app makes today's page itself, and two pages would share the date.
      const date = await emptyWeekDay(await localDate(0))
      const day = `section[id="journal-${date}"]`

      await pullPeerWrites(device, async () => {
        const page = await device.createInSpace('page', date)
        await device.createBlock(page, DAY_ENTRY)
      })
      let seen = ''
      await waitInOpenView(
        async () => {
          seen = await textOf(day)
          const hasPage = await $(day).$('button[aria-label="Delete page"]').isExisting()
          return hasPage && !seen.includes('No blocks for')
        },
        () => `the open week still shows ${date} without its page: ${seen}`,
      )
    })

    // Last edited is the order the backend stores, so this reads it the way a
    // persistence check does: from a remounted list, not the one left open.
    it('a block the peer adds lifts its page above a newer one in Last edited (#6048)', async () => {
      if (peer === undefined) throw new Error('the pairing test failed')
      const device = peer
      const editedId = await pullPeerWrites(device, () => device.createInSpace('page', EDITED_PAGE))
      // A pull of its own, so the two pages never share a millisecond.
      await pullPeerWrites(device, () => device.createInSpace('page', NEWER_PAGE))
      await navigateTo('Pages')
      // The page count mounts left of the sort trigger once the list loads and
      // shifts it right, so a click aimed before the shift lands on the count.
      await $('[data-testid="page-browser-count"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
      await chooseSelectOption('[aria-label="Sort order"]', 'Last edited')
      await waitInFreshView(
        () => navigateTo('Pages'),
        () => listsAbove(NEWER_PAGE, EDITED_PAGE),
        "Last edited never listed the peer's newer page above the older one",
      )

      await pullPeerWrites(device, () => device.createBlock(editedId, LATE_BLOCK))
      await waitInFreshView(
        () => navigateTo('Pages'),
        () => listsAbove(EDITED_PAGE, NEWER_PAGE),
        'Last edited kept the page the peer added a block to below the newer page',
      )
    })

    // #5841 — the app holds a value under a key no definition declares, so it is
    // stored as text: today's date, on a page of its own (the Due panel leaves
    // out the day's own blocks). The peer then declares the key a `date` in the
    // Personal space, which both vaults share. It would refuse to with the
    // app's text value in its vault, so it is held from before the app writes
    // the value until it has declared. The setup is not under test, so it goes
    // through the real IPC.
    it("lists the peer's property definition, and reads the value the app held as a date (#5841)", async () => {
      if (peer === undefined) throw new Error('the pairing test failed')
      const device = peer
      const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
      const personal = spaces.find((space) => space.name === 'Personal')?.id
      if (personal === undefined) throw new Error('no Personal space')
      const page = await invoke<string>('create_page_in_space', {
        parentId: null,
        content: DEFS_PAGE,
        spaceId: personal,
      })
      const holder = await invoke<{ id: string }>('create_block', {
        blockType: 'content',
        content: DEFS_HOLDER,
        parentId: page,
        index: null,
        scope: { kind: 'active', space_id: personal },
        blockId: null,
      })
      await holdPeer(device)
      try {
        await invoke('set_property', {
          blockId: holder.id,
          key: SYNCED_KEY,
          value: { value_text: await localDate(0) },
        })

        await reopenProperties()
        await expectAbsent(
          propertyRowButton(SYNCED_KEY),
          'a definition before the peer declared one',
        )
        await device.createPropertyDef(SYNCED_KEY, 'date')
      } finally {
        await device.releaseSync()
      }
      await pullFromPeer(device)

      let seen: string | null = null
      await browser
        .waitUntil(
          async () => {
            await reopenProperties()
            seen = await listedType(SYNCED_KEY)
            return seen === 'date'
          },
          { timeout: NAV_TIMEOUT, interval: 2_000 },
        )
        .catch(() => {
          throw new Error(`Settings › Properties lists ${SYNCED_KEY} as ${String(seen)}, not date`)
        })
      await browser.waitUntil(
        async () => {
          await navigateTo('Pages')
          await openJournalMode('daily')
          return (await textOf(DUE_PANEL)).includes(DEFS_HOLDER)
        },
        {
          timeout: NAV_TIMEOUT,
          interval: 2_000,
          timeoutMsg: "today's Due panel never listed the block holding the now-date value",
        },
      )
    })

    // #5691 — page mode must show the peer's edit in place without remounting,
    // keep the app's own text, and never write the peer's block back with the
    // old text when it next saves: a save that compares against anything but
    // each block's own last-saved state reverts a peer's edit. The app writes
    // and closes its editor before the peer writes.
    it('page mode shows a peer’s edit in place, keeps its own, and never writes the peer’s block back (#5691)', async () => {
      if (peer === undefined) throw new Error('the pairing test failed')
      const device = peer
      const [pageId, firstId, secondId, thirdId] = await pullPeerWrites(device, async () => {
        const page = await device.createInSpace('page', PM_TITLE)
        return [
          page,
          await device.createBlock(page, PM_FIRST),
          await device.createBlock(page, PM_SECOND),
          await device.createBlock(page, PM_THIRD),
        ] as const
      })
      // The page's arrival is not under test: re-open it until it shows.
      await browser.waitUntil(
        async () => {
          await navigateTo('Pages')
          if (!(await $(`.//span[normalize-space(.)="${PM_TITLE}"]`).isExisting())) {
            if (await syncIdle()) await $(SYNC_BUTTON).click()
            return false
          }
          await reopenPageByTitle(PM_TITLE)
          return await $(`[data-testid="sortable-block"]*=${PM_THIRD}`).isExisting()
        },
        { timeout: NAV_TIMEOUT, interval: 1_000, timeoutMsg: "the peer's page never arrived" },
      )
      await chooseEditMode('Page')
      expect((await pageModeBlocks()).map((block) => block.id)).toEqual([
        firstId,
        secondId,
        thirdId,
      ])
      // Marks this page-mode editor, so a remount, which would re-read the page, shows.
      await browser.execute((selector: string) => {
        document.querySelector(selector)?.setAttribute('data-wdio-mounted', 'once')
      }, PAGE_MODE)

      // The app's edit, saved and closed before the peer writes.
      await pageModeCaret(0, 'end')
      await typeInPageMode(' app', 0, `${PM_FIRST} app`)
      await $(TITLE).click()
      await waitPeerHolds(device, firstId, `${PM_FIRST} app`)

      await pullPeerWrites(device, () => device.editBlock(thirdId, PM_FROM_PEER))
      let seen: string[] = []
      await waitInOpenView(
        async () => {
          seen = (await pageModeBlocks()).map((block) => block.text)
          return seen[2] === PM_FROM_PEER
        },
        () => `page mode never showed the peer's edit: ${JSON.stringify(seen)}`,
      )
      expect(seen[0]).toBe(`${PM_FIRST} app`)
      expect(await $(`${PAGE_MODE}[data-wdio-mounted="once"]`).isExisting()).toBe(true)

      // The app saves again; the peer's block must come through it unchanged.
      await pageModeCaret(0, 'end')
      await typeInPageMode(' more', 0, `${PM_FIRST} app more`)
      await $(TITLE).click()
      await waitPeerHolds(device, firstId, `${PM_FIRST} app more`)
      expect((await device.getBlock(thirdId)).content).toBe(PM_FROM_PEER)

      // The peer creates a block (last) and moves the third to the top.
      const fourthId = await pullPeerWrites(device, async () => {
        const id = await device.createBlock(pageId, PM_FOURTH)
        await device.moveBlock(thirdId, pageId, 0)
        return id
      })
      let ids: string[] = []
      await waitInOpenView(
        async () => {
          ids = (await pageModeBlocks()).map((block) => block.id)
          return ids.length === 4 && ids[0] === thirdId
        },
        () => `page mode never showed the peer's new and moved blocks: ${JSON.stringify(ids)}`,
      )
      expect(ids).toEqual([thirdId, firstId, secondId, fourthId])
      expect(await $(`${PAGE_MODE}[data-wdio-mounted="once"]`).isExisting()).toBe(true)

      // The app saves again: the peer's block stays where the peer put it.
      await pageModeCaret(1, 'end')
      await typeInPageMode(' last', 1, `${PM_FIRST} app more last`)
      await $(TITLE).click()
      await waitPeerHolds(device, firstId, `${PM_FIRST} app more last`)
      expect((await device.getBlock(fourthId)).content).toBe(PM_FOURTH)
      expect((await pageModeBlocks()).map((block) => block.id)).toEqual(ids)
    })

    // #5363 — the mirror writes the pages this device's own ops touched, and
    // those a sync names in `SyncEvent::Complete.changed_page_ids`
    // (`MirrorState::note_sync`, fed by `mirror::on_sync_event`); its full pass
    // otherwise runs only hourly. So the peer's page reaches the folder within
    // the wait only through a real pull's event. A snapshot catch-up, the sync
    // that names no pages, cannot be produced from here; `note_sync` turning it
    // into a full pass is pinned by the Rust test
    // `a_sync_rewrites_the_pages_it_names_and_one_naming_none_rescans`.
    it("the Markdown mirror writes the page a peer creates, then rewrites it with the peer's edit (#5363)", async () => {
      if (peer === undefined) throw new Error('the pairing test failed')
      const device = peer
      const set = await invoke<MirrorStatus>('set_mirror_folder', {
        path: mirrorFolder,
        readBack: true,
      })
      expect(set.folder).toBe(mirrorFolder)
      await browser.waitUntil(
        async () => (await invoke<MirrorStatus>('get_mirror_status')).last_pass_ms !== null,
        {
          timeout: ACTION_TIMEOUT,
          timeoutMsg: 'the mirror never finished a pass in the new folder',
        },
      )

      const page = await device.createInSpace('page', MIRROR_TITLE)
      const block = await device.createBlock(page, MIRROR_FIRST)
      await syncUntilFileHolds(MIRROR_FIRST)

      await device.editBlock(block, MIRROR_EDITED)
      await syncUntilFileHolds(MIRROR_EDITED, MIRROR_FIRST)

      const status = await invoke<MirrorStatus>('get_mirror_status')
      expect(status.diverged).toEqual([])
      expect(status.failed).toEqual([])
    })

    // #6523 — the peer is frozen across the restart, so no session of the new
    // launch can end: the time shown is the one the pairing's row stored.
    it('after a restart the state card shows the last sync before any new one', async () => {
      if (peer === undefined) throw new Error('the pairing test failed')
      peer.pause()
      try {
        await restartApp()
        await openSyncSettings()
        const lastSynced = () =>
          browser.execute(() => document.querySelector('.sync-last-synced')?.textContent ?? '')
        let seen = await lastSynced()
        await browser
          .waitUntil(
            async () => {
              seen = await lastSynced()
              return /^just now$|ago$/.test(seen)
            },
            { timeout: NAV_TIMEOUT },
          )
          .catch(() => {
            throw new Error(`the state card shows no last sync after the restart: "${seen}"`)
          })
      } finally {
        peer.resume()
      }
    })

    it("unpairing refuses the peer's next sync and drops only this device's row", async () => {
      if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
      const { deviceId, appDeviceId } = paired
      await openSyncSettings()
      const unpair = peerRow(deviceId).$('button[aria-label^="Unpair device"]')
      await unpair.waitForClickable({ timeout: ACTION_TIMEOUT })
      await unpair.click()
      const confirm = $('[role="alertdialog"]').$('button=Yes, unpair')
      await confirm.waitForClickable({ timeout: ACTION_TIMEOUT })
      await confirm.click()
      await $('[data-testid="device-no-peers"]').waitForDisplayed({ timeout: ACTION_TIMEOUT })

      // The row is gone from the backend, read back after a round trip.
      await navigateTo('Journal')
      await openSyncSettings()
      await $('[data-testid="device-no-peers"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
      await expectAbsent('.device-peer-item', 'the unpaired device')

      // Unpairing sends nothing (`delete_peer_ref`), so the peer still holds the
      // pairing; the app's unpaired-device gate turns its next dial away.
      expect(await peer.syncRefused()).toBe('peer not paired with this device')
      expect(await peer.listPeers()).toEqual([appDeviceId])
    })
  })
})
