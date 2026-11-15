// ---------------------------------------------------------------------------
// Opt-in measurement (#6559): how long Enter and a merge wait on the real
// backend, idle and while a peer's edits sync in, and how long a 300-line
// paste takes page mode to save.
//
//   AGARIC_PERF=1 just e2e-real e2e-tauri/enter-merge-latency.e2e.ts
//
// Opt-in because it is a measurement with no budget to fail, not an
// environment precondition (e2e-tauri/AGENTS.md). It fails only when what it
// times did not happen: a refused write, a key that logged nothing twice, an
// undo that took back less than the paste. A key that logs nothing once is
// counted (`lost_keys`) and pressed again. Debug build under Xvfb: compare
// runs on one machine. The `enter-merge-latency:` lines are printed and
// written to `e2e-tauri/artifacts/`; docs/architecture/operations.md records
// runs.
//
// Vault: the issue's page of PAGE_BLOCKS blocks beside FILLER_PAGES pages of
// BATCH blocks, written by the app with `create_blocks_batch`. Not the 100K
// blocks the backend's probe times (`bench_enter_split_and_merge`): in a debug
// build such a vault takes about 50 minutes to write and index, and the sync
// half cannot use one, because the peer's pairing is a pull of the app's vault
// that `e2e_sync_peer` waits 60 s for, and a peer paired before the seed slows
// every batch of it past WebDriver's timeout (#6811).
//
// The Enter is a split in the middle of block TARGET's text (`split_block`), a
// block inside the rows the page mounts at first (`INITIAL_MOUNT_LIMIT`).
// Backspace at the start of the block it split off merges it back
// (`merge_blocks`) and leaves the caret at the join, so the next Enter splits
// the same text again: SAMPLES of each, each answered before the next key.
//
// The times are the app's own (`logLatencySample`, read from the app's log
// with debug mode on): from the key's handler to the block taking focus, and
// to the backend's answer. A phone logs the same line (#6513).
//
// Under sync, `e2e_sync_peer`, paired after the paste, rewrites the blocks of a
// page of its own while the samples run, and the app pulls them.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  appVaultDir,
  invoke,
  materializerIdle,
  navigateTo,
  openNewPage,
  placeCaret,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'
import { PAGE_MODE, chooseEditMode, pageModeBlocks, pageModeCaret } from './page-mode'
import {
  type SyncPeer,
  openPairing,
  openSyncSettings,
  readPairingQr,
  setPeerAddress,
  startSyncPeer,
} from './sync-peer'

const FILLER_PAGES = 1
const PAGE_BLOCKS = 2_000
/** `MAX_BATCH_BLOCK_IDS`: the most blocks one `create_blocks_batch` takes. */
const BATCH = 1_000
const TARGET = 250
const SAMPLES = 100
const PASTE_LINES = 300
const PASTES = 5
const PEER_BLOCKS = 20
const SETTLE_MS = 300_000

// `a` sorts the measured page before the filler pages in the Pages list.
const TITLE = runScopedMarker('wdio-latency-a')
const FILLER = runScopedMarker('wdio-latency-filler')
const PEER_PAGE = runScopedMarker('wdio-latency-peer')
const PASTED = runScopedMarker('wdio-latency-paste')
const SYNC_BUTTON = '[data-slot="sidebar"] button[aria-label="Sync"]'
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const rowText = (n: number) => `${TITLE} block ${n} lorem ipsum`
/** Enter splits `ipsum` after its `ip`. */
const SPLIT_AT = rowText(TARGET).indexOf('ipsum') + 2

type Action = 'enter-split' | 'merge'

interface Sample {
  action: string
  focus: number
  answered: number
  ok: boolean
}

let peer: SyncPeer | undefined
let spaceId = ''
const peerBlocks: string[] = []
let targetId = ''
const lines: string[] = []

/** The app's log, every file of it. */
function appLog(): string {
  const dir = path.join(appVaultDir(), 'logs')
  return readdirSync(dir)
    .filter((name) => name.startsWith('agaric.log'))
    .toSorted()
    .map((name) => readFileSync(path.join(dir, name), 'utf8'))
    .join('\n')
}

/** How many pulls from a peer the app has finished. */
const pullsFinished = () => appLog().split('"message":"sync complete"').length - 1

/** The `logLatencySample` lines in the app's log, oldest first. */
function loggedSamples(): Sample[] {
  const text = appLog()
  return [
    ...text.matchAll(
      /(enter-split|enter-create|merge) focus_ms=([\d.]+) answered_ms=([\d.]+) ok=(\w+)/g,
    ),
  ].map(([, action = '', focus, answered, ok]) => ({
    action,
    focus: Number(focus),
    answered: Number(answered),
    ok: ok === 'true',
  }))
}

/** Keys that reached no handler, each with where the focus was. */
const lostKeys: string[] = []
/** Many times the slowest answer seen: a key with no sample by then reached nothing. */
const LOST_KEY_MS = 5_000

/**
 * Press `key` and return the sample it logged, once the backend has answered.
 * A key that logs nothing is counted lost and pressed again with the editor
 * focused, so one lost key does not end the run.
 */
async function sampleOf(key: string, action: Action, logged: number): Promise<Sample> {
  let samples: Sample[] = []
  const answered = () =>
    browser
      .waitUntil(
        () => {
          samples = loggedSamples()
          return Promise.resolve(samples.length > logged)
        },
        { timeout: LOST_KEY_MS, interval: 50 },
      )
      .then(
        () => true,
        () => false,
      )
  await browser.keys([key])
  if (!(await answered())) {
    const focus = await browser.execute((selector: string) => {
      const editor = document.querySelector<
        HTMLElement & { editor?: { commands: { focus: () => boolean } } }
      >(selector)
      const active = document.activeElement
      const where =
        active === editor
          ? 'editor'
          : `${active?.tagName.toLowerCase() ?? 'none'}${active?.getAttribute('data-testid') ? `[${active.getAttribute('data-testid')}]` : ''}`
      editor?.editor?.commands.focus()
      return where
    }, EDITOR)
    lostKeys.push(`${key}@${focus}`)
    await browser.keys([key])
    if (!(await answered())) throw new Error(`${key} logged no latency sample, pressed twice`)
  }
  const sample = samples[logged] as Sample
  if (sample.action !== action || !sample.ok || samples.length !== logged + 1) {
    throw new Error(`${key} logged ${JSON.stringify(samples.slice(logged))}, not one ${action}`)
  }
  return sample
}

/** The text of block `id` as the backend holds it. */
async function backendText(id: string): Promise<string> {
  return (await invoke<{ content: string }>('get_block', { blockId: id })).content
}

/** Nearest-rank percentile `p` of `values`, to 0.1 ms. */
function percentile(values: readonly number[], p: number): string {
  const sorted = values.toSorted((a, b) => a - b)
  const value = sorted[Math.max(Math.ceil((p / 100) * sorted.length) - 1, 0)] ?? Number.NaN
  return value.toFixed(1)
}

function spread(values: readonly number[]): string {
  return `p50=${percentile(values, 50)} p95=${percentile(values, 95)} max=${percentile(values, 100)}`
}

function record(line: string): void {
  lines.push(`enter-merge-latency: ${line}`)
}

/** Write `blocks` blocks reading `<title> block <n> lorem ipsum` under a new page `title`; resolves to their ids in order. */
async function seedPage(title: string, blocks: number): Promise<string[]> {
  const pageId = await invoke<string>('create_page_in_space', {
    parentId: null,
    content: title,
    spaceId,
  })
  const ids: string[] = []
  for (let from = 0; from < blocks; from += BATCH) {
    // Built in the webview: a thousand specs per WebDriver command is a large payload.
    const created = await browser.execute(
      async (parentId: string, start: number, count: number, prefix: string) => {
        const specs = Array.from({ length: count }, (_, i) => ({
          blockType: 'content',
          content: `${prefix} block ${start + i + 1} lorem ipsum`,
          parentId,
          position: null,
        }))
        const internals = (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
          }
        ).__TAURI_INTERNALS__
        const reply = (await internals.invoke('create_blocks_batch', { specs })) as {
          blocks: { id: string }[]
        }
        return reply.blocks.map((block) => block.id)
      },
      pageId,
      from,
      Math.min(BATCH, blocks - from),
      title,
    )
    ids.push(...created)
  }
  return ids
}

/** Open the measured page with the caret between `before` and `after` in block TARGET. */
async function caretInTarget(): Promise<void> {
  await reopenPageByTitle(TITLE)
  const row = $(`[data-testid="block-static"][data-block-id="${targetId}"]`)
  // An off-screen row renders as a placeholder: scroll it in until its text is there.
  await browser.waitUntil(
    async () => {
      await browser.execute((id: string) => {
        document.querySelector(`li[data-block-id="${id}"]`)?.scrollIntoView({ block: 'center' })
      }, targetId)
      return row.isExisting()
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: `block ${TARGET} never rendered on the measured page` },
  )
  await row.waitForClickable({ timeout: ACTION_TIMEOUT })
  await row.click()
  await $(
    `[data-testid="block-editor"][data-block-id="${targetId}"] [contenteditable="true"]`,
  ).waitForDisplayed({ timeout: ACTION_TIMEOUT })
  await placeCaret(SPLIT_AT)
}

/** SAMPLES Enter-then-Backspace pairs on block TARGET; records their spread under `label`. */
async function sampleEnterAndMerge(label: string): Promise<void> {
  await caretInTarget()
  const enter: Sample[] = []
  const merge: Sample[] = []
  let logged = loggedSamples().length
  const lostBefore = lostKeys.length
  for (let n = 0; n < SAMPLES; n++) {
    enter.push(await sampleOf('Enter', 'enter-split', logged++))
    // The split-off block opens with the caret at its end, not at the split (#6810).
    await placeCaret(0)
    merge.push(await sampleOf('Backspace', 'merge', logged++))
  }
  for (const [action, samples] of [
    ['enter-split', enter],
    ['merge', merge],
  ] as const) {
    record(`${label} ${action} focus_ms ${spread(samples.map((s) => s.focus))}`)
    record(`${label} ${action} answered_ms ${spread(samples.map((s) => s.answered))}`)
  }
  const lost = lostKeys.slice(lostBefore)
  record(`${label} lost_keys=${lost.length}${lost.length > 0 ? ` ${lost.join(' ')}` : ''}`)
  // Every split was merged back: the block holds its text again and its editor is still in it.
  await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
  await browser.waitUntil(async () => (await backendText(targetId)) === rowText(TARGET), {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `block ${TARGET} does not read ${rowText(TARGET)} after the merges`,
  })
}

/** Paste `text` as plain text at the page-mode cursor, as ProseMirror takes a paste. */
async function pasteInPageMode(text: string): Promise<number> {
  return browser.execute(
    (selector: string, value: string) => {
      const dom = document.querySelector<
        HTMLElement & { editor?: { view: { pasteText: (text: string) => boolean } } }
      >(selector)
      if (dom?.editor === undefined) throw new Error('pasteInPageMode: no page-mode editor')
      const at = performance.now()
      dom.editor.view.pasteText(value)
      return at
    },
    PAGE_MODE,
    text,
  )
}

/** `get_block`'s answer for block `id`, which it serves only live: `live`, or its error kind. */
function getBlockAnswer(id: string): Promise<string> {
  return browser.execute(async (blockId: string) => {
    try {
      await (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke('get_block', { blockId })
      return 'live'
    } catch (error) {
      return (error as { kind?: string }).kind ?? String(error)
    }
  }, id)
}

describe('Agaric real-backend Enter and merge latency, and a 300-line paste (#6559) @editor @sync @pages', () => {
  before(function (this: Mocha.Context) {
    if (!process.env['AGARIC_PERF']) this.skip()
  })

  after(async () => {
    await peer?.stop()
    if (lines.length === 0) return
    const output = [
      `enter-merge-latency: load ${os
        .loadavg()
        .map((v) => v.toFixed(2))
        .join(' ')}`,
      ...lines,
    ].join('\n')
    // oxlint-disable-next-line no-console -- the measurement's output
    console.log(`\n${output}\n`)
    const dir = path.resolve(import.meta.dirname, 'artifacts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'enter-merge-latency.txt'), `${output}\n`)
  })

  it('seeds the page and turns debug mode on', async function (this: Mocha.Context) {
    this.timeout(2 * SETTLE_MS)
    await waitForAppReady()
    const spaces = await invoke<{ id: string; name: string }[]>('list_spaces')
    spaceId = (spaces.find((s) => s.name === 'Personal') ?? spaces[0])?.id ?? ''
    const seedStart = Date.now()
    for (let page = 0; page < FILLER_PAGES; page++) await seedPage(`${FILLER} ${page}`, BATCH)
    targetId = (await seedPage(TITLE, PAGE_BLOCKS))[TARGET - 1] ?? ''
    expect(await backendText(targetId)).toBe(rowText(TARGET))
    const written = Date.now()
    await materializerIdle(SETTLE_MS)
    const seconds = (from: number, to: number) => Math.round((to - from) / 1000)
    record(
      `vault_blocks=${FILLER_PAGES * (BATCH + 1) + PAGE_BLOCKS + 1} page_blocks=${PAGE_BLOCKS}` +
        ` target=${TARGET} samples=${SAMPLES} seed_s=${seconds(seedStart, written)}` +
        ` settle_s=${seconds(written, Date.now())}`,
    )
    // `PREFERENCES.debugMode`, as Settings › Debug mode stores it.
    await browser.execute(() => {
      localStorage.setItem(
        'agaric:debug',
        JSON.stringify({ state: { debugMode: true }, version: 1 }),
      )
    })
  })

  it('times Enter and merge on an idle backend', async function (this: Mocha.Context) {
    this.timeout(600_000)
    await sampleEnterAndMerge('idle')
  })

  it('times a 300-line paste in page mode, and one Ctrl+Z takes it back', async function (this: Mocha.Context) {
    this.timeout(600_000)
    await openNewPage()
    await typeMarkerVerified(PASTED)
    await chooseEditMode('Page')
    await browser.waitUntil(async () => (await pageModeBlocks()).length === 1, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'page mode never showed the one block',
    })
    const firstId = (await pageModeBlocks())[0]?.id as string
    await browser.execute(() => {
      const saves: { start: number; end: number }[] = []
      Object.assign(window, { __pmSaves: saves })
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'page-mode-save') {
            saves.push({ start: entry.startTime, end: entry.startTime + entry.duration })
          }
        }
      }).observe({ type: 'measure' })
    })
    const text = Array.from({ length: PASTE_LINES }, (_, i) => `pasted line ${i}`).join('\n')
    const saveMs: number[] = []
    const wallMs: number[] = []
    let undone = 0
    for (let n = 0; n < PASTES; n++) {
      await materializerIdle(ACTION_TIMEOUT)
      await pageModeCaret(0, 'end')
      const pastedAt = await pasteInPageMode(text)
      await browser.waitUntil(async () => (await pageModeBlocks()).length === PASTE_LINES, {
        timeout: NAV_TIMEOUT,
        timeoutMsg: `page mode never showed the ${PASTE_LINES} blocks pasted`,
      })
      const lastId = (await pageModeBlocks()).at(-1)?.id as string
      await browser.waitUntil(async () => (await getBlockAnswer(lastId)) === 'live', {
        timeout: NAV_TIMEOUT,
        timeoutMsg: 'the last pasted block never reached the backend',
      })
      // The save that wrote the paste: the first to start after it. An observer
      // hears of a measure a task later, so this waits for it.
      const readSave = () =>
        browser.execute(
          (at: number) =>
            (window as unknown as { __pmSaves: { start: number; end: number }[] }).__pmSaves.find(
              (s) => s.start >= at,
            ) ?? null,
          pastedAt,
        )
      await browser.waitUntil(async () => (await readSave()) !== null, {
        timeout: ACTION_TIMEOUT,
        timeoutMsg: 'no page-mode save measure followed the paste',
      })
      const save = (await readSave()) as { start: number; end: number }
      saveMs.push(save.end - save.start)
      wallMs.push(save.end - pastedAt)

      await browser.keys(['Control', 'z'])
      await browser.waitUntil(async () => (await pageModeBlocks()).length === 1, {
        timeout: NAV_TIMEOUT,
        timeoutMsg: 'one Ctrl+Z did not take back the whole paste',
      })
      await browser.waitUntil(async () => (await getBlockAnswer(lastId)) === 'not_found', {
        timeout: NAV_TIMEOUT,
        timeoutMsg: 'the undo never deleted the pasted blocks in the backend',
      })
      await browser.waitUntil(async () => (await backendText(firstId)) === PASTED, {
        timeout: NAV_TIMEOUT,
        timeoutMsg: 'the undo never gave the first block its text back in the backend',
      })
      undone++
    }
    record(`paste lines=${PASTE_LINES} runs=${PASTES} save_ms ${spread(saveMs)}`)
    record(`paste lines=${PASTE_LINES} runs=${PASTES} paste_to_saved_ms ${spread(wallMs)}`)
    record(`paste one_ctrl_z_undoes=${undone}/${PASTES}`)
  })
  it('times Enter and merge while a peer’s edits sync in', async function (this: Mocha.Context) {
    this.timeout(900_000)
    const syncPeer = await startSyncPeer()
    peer = syncPeer
    const peerPage = await syncPeer.createInSpace('page', PEER_PAGE)
    for (let n = 0; n < PEER_BLOCKS; n++) {
      peerBlocks.push(await syncPeer.createBlock(peerPage, `${PEER_PAGE} ${n} v0`))
    }
    await openSyncSettings()
    await openPairing()
    const remote = await syncPeer.pair(await readPairingQr())
    await waitForToast('Device paired successfully')
    await $('[data-testid="pairing-qr-code"]').waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
    })
    await setPeerAddress(remote.deviceId, remote.address)
    await navigateTo('Pages')
    const sync = $(SYNC_BUTTON)
    await browser.waitUntil(async () => (await sync.getAttribute('aria-disabled')) === 'false', {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the app never finished the sync it was running',
    })
    await sync.click()
    await syncPeer.waitPulled()
    await materializerIdle(SETTLE_MS)

    // The peer rewrites its blocks round the clock until the samples are done,
    // and the app pulls them as often as the sidebar's Sync button lets it. A
    // local write's own pull waits for a pause in writing (`LOCAL_EDIT_DEBOUNCE`),
    // which keys pressed one after another never leave. `click()` from the page
    // moves no focus, so the editor keeps it.
    await browser.execute((selector: string) => {
      const timer = setInterval(() => {
        const button = document.querySelector<HTMLElement>(selector)
        if (button?.getAttribute('aria-disabled') === 'false') button.click()
      }, 250)
      Object.assign(window, { __latencyPulls: timer })
    }, SYNC_BUTTON)
    const pullsBefore = pullsFinished()
    let writing = true
    let edits = 0
    const writer = (async () => {
      while (writing) {
        edits++
        await syncPeer.editBlock(
          peerBlocks[edits % PEER_BLOCKS] as string,
          `${PEER_PAGE} v${edits}`,
        )
      }
    })()
    try {
      await sampleEnterAndMerge('sync')
    } finally {
      writing = false
      await writer
      await browser.execute(() => {
        clearInterval((window as unknown as { __latencyPulls: number }).__latencyPulls)
      })
      // The pull in flight applies before the peer goes, so the vault the
      // reconciliation oracle reads is not mid-pull.
      await browser.waitUntil(
        async () => (await $(SYNC_BUTTON).getAttribute('aria-disabled')) === 'false',
        { timeout: NAV_TIMEOUT, timeoutMsg: 'the pull in flight never finished' },
      )
      await syncPeer.stop()
    }
    const pulls = pullsFinished() - pullsBefore
    // The pulls during the samples applied the peer's writes.
    const held = await Promise.all(peerBlocks.map((id) => backendText(id)))
    const applied = Math.max(...held.map((text) => Number(/ v(\d+)$/.exec(text)?.[1] ?? 0)))
    record(`sync peer_edits=${edits} pulls=${pulls} newest_applied=v${applied}`)
    expect(applied).toBeGreaterThan(0)
    await materializerIdle(SETTLE_MS)
  })
})
