// ---------------------------------------------------------------------------
// Opt-in measurement: what one page-mode save costs on the real backend, at
// page mode's cap (#5691), next to block mode's write for the same edit.
//
//   AGARIC_PERF=1 just e2e-real e2e-tauri/page-mode-save-cost.e2e.ts
//
// Without `AGARIC_PERF` the suite is skipped, as `e2e/perf.spec.ts` gates its
// journeys: it is a measurement, not a check, and has no budget to fail. That
// is an opt-in, not the environment precondition e2e-tauri/AGENTS.md forbids
// skipping on.
// `AGARIC_PERF_REPEATS` sets how many times each edit is timed (`REPEATS`).
//
// It seeds a page of `PAGE_MODE_BLOCK_CAP` blocks in one `create_blocks_batch`
// call and opens it in page mode, the cap not lifted. Per repeat, in page mode,
// on a block of its own: typing, a blur with nothing to save, Enter then a key
// (a new block), and Tab (an indent). Each edit's time is the `page-mode-save`
// User Timing measure (`SAVE_MEASURE` in PageModeEditor.tsx), from the start
// of the save to its last write, summed over every save the edit ran; a
// PerformanceObserver collects them, since the app keeps only the latest.
// Its writes are the op log's growth (`get_compaction_status`). Block mode's
// figure is the one round trip block mode sends for that edit (`edit_block`,
// `create_block`, `move_block`), timed in the webview on the same page; a blur
// with nothing to save sends none. Each edit starts with the materializer idle
// (`materializerIdle`), the seed's catch-up included.
//
// The page grows by one block per repeat's Enter, which then moves under the
// block it was made from: page mode checks the cap as a page opens, and a save
// does not reread the page, so it stays open.
//
// The table is printed and written to `e2e-tauri/artifacts/`, with the load
// average it ran under. This is a debug build under Xvfb: compare page mode
// with block mode in the same run, not with another machine. WebKit reports
// these timings in whole milliseconds.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  invoke,
  openPageTitled,
  runScopedMarker,
  waitForAppReady,
} from './helpers'
import {
  PAGE_MODE,
  chooseEditMode,
  pageModeBlocks,
  pageModeCaret,
  pageModeIndexOf,
  typeInPageMode,
} from './page-mode'

/** `PAGE_MODE_BLOCK_CAP` in src/editor/page-mode/page-mode-fit.ts. */
const CAP = 1000
const REPEATS = Number(process.env['AGARIC_PERF_REPEATS'] ?? 5)
/** Longer than the save's debounce: no save after this long means the edit's saves are done. */
const QUIET_MS = 1500
/** Long enough for the retry sweeper to take up what the seed shed, twice over. */
const SEED_SETTLE_MS = 300_000
const TYPED = ' quiz'
const TITLE = runScopedMarker('wdio-pm-save-cost')
const KINDS = ['typing', 'blur, nothing to save', 'Enter, then a key', 'Tab'] as const
type Kind = (typeof KINDS)[number]

interface PageSample {
  kind: Kind
  /** Every save the edit ran, in ms. */
  saves: number[]
  writes: number
}

interface BlockSample {
  kind: Kind
  ms: number | null
  writes: number
}

const seedLabel = (n: number) => `Seed ${String(n).padStart(4, '0')}`
let pageId = ''
let spaceId = ''
let seeded: Array<{ id: string; content: string }> = []
const pageSamples: PageSample[] = []
const blockSamples: BlockSample[] = []

const opCount = async () => (await invoke<{ total_ops: number }>('get_compaction_status')).total_ops

/**
 * Wait until the materializer has nothing queued, retries included, so its
 * catch-up runs beside no timed edit. A batch of `CAP` blocks sheds tasks to
 * the retry queue, which its sweeper takes up a minute or more later.
 */
async function materializerIdle(timeout: number): Promise<void> {
  await browser.waitUntil(
    async () => {
      const status = await invoke<{
        foreground_queue_depth: number
        background_queue_depth: number
        retry_queue_pending: number | null
      }>('get_status')
      return (
        status.foreground_queue_depth === 0 &&
        status.background_queue_depth === 0 &&
        (status.retry_queue_pending ?? 0) === 0
      )
    },
    { timeout, interval: 500, timeoutMsg: 'the materializer never went idle' },
  )
}

/** How many page-mode saves the observer has seen. */
const savesSeen = () =>
  browser.execute(() => (window as unknown as { __pmSaves: number[] }).__pmSaves.length)

/** The saves after the first `from`, once none has come for `QUIET_MS`. */
async function settledSaves(from: number, what: string): Promise<number[]> {
  let seen = -1
  let still = Date.now()
  await browser.waitUntil(
    async () => {
      const count = await savesSeen()
      if (count !== seen) {
        seen = count
        still = Date.now()
      }
      return count > from && Date.now() - still >= QUIET_MS
    },
    { timeout: NAV_TIMEOUT, interval: 100, timeoutMsg: `${what} ran no page-mode save` },
  )
  return browser.execute(
    (start: number) => (window as unknown as { __pmSaves: number[] }).__pmSaves.slice(start),
    from,
  )
}

/** Run `act` in page mode and record the saves it ran and the ops they wrote. */
async function pageEdit(kind: Kind, act: () => Promise<void>): Promise<void> {
  await materializerIdle(ACTION_TIMEOUT)
  const ops = await opCount()
  const from = await savesSeen()
  await act()
  const saves = await settledSaves(from, kind)
  pageSamples.push({ kind, saves, writes: (await opCount()) - ops })
}

/** One IPC round trip, timed in the webview. */
async function timed<T>(
  cmd: string,
  args: Record<string, unknown>,
): Promise<{ ms: number; reply: T }> {
  return browser.execute(
    async (c: string, a: Record<string, unknown>) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__
      const start = performance.now()
      const reply = await internals.invoke(c, a)
      return { ms: performance.now() - start, reply }
    },
    cmd,
    args,
  ) as Promise<{ ms: number; reply: T }>
}

async function blockEdit<T>(kind: Kind, cmd: string, args: Record<string, unknown>): Promise<T> {
  await materializerIdle(ACTION_TIMEOUT)
  const ops = await opCount()
  const { ms, reply } = await timed<T>(cmd, args)
  blockSamples.push({ kind, ms, writes: (await opCount()) - ops })
  return reply
}

/** Median, and the band every repeat fell in. */
function band(values: readonly number[]): string {
  if (values.length === 0) return '–'
  const sorted = values.toSorted((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0)
  const round = (v: number) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10)
  return `${round(median)} [${round(sorted[0] ?? 0)}–${round(sorted.at(-1) ?? 0)}]`
}

describe('Agaric real-backend page mode save cost at the cap (#5691) @editor @pages', () => {
  before(function (this: Mocha.Context) {
    if (!process.env['AGARIC_PERF']) this.skip()
  })

  it('opens a page of PAGE_MODE_BLOCK_CAP blocks in page mode', async function (this: Mocha.Context) {
    this.timeout(SEED_SETTLE_MS + 300_000)
    await waitForAppReady()
    const spaces = await invoke<{ id: string; name: string }[]>('list_spaces')
    spaceId = (spaces.find((s) => s.name === 'Personal') ?? spaces[0])?.id ?? ''
    pageId = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: TITLE,
      spaceId,
    })
    const specs = Array.from({ length: CAP }, (_, n) => ({
      blockType: 'content',
      content: `${seedLabel(n)} holds a line of ordinary text`,
      parentId: pageId,
      position: null,
    }))
    const { blocks } = await invoke<{ blocks: Array<{ id: string; content: string }> }>(
      'create_blocks_batch',
      { specs },
    )
    seeded = blocks
    expect(seeded).toHaveLength(CAP)

    await openPageTitled(TITLE)
    await chooseEditMode('Page')
    await browser.waitUntil(async () => (await pageModeBlocks()).length === CAP, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: `page mode never showed the page's ${CAP} blocks`,
    })
    await browser.execute(() => {
      const saves: number[] = []
      Object.assign(window, { __pmSaves: saves })
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'page-mode-save') saves.push(entry.duration)
        }
      }).observe({ type: 'measure' })
    })
    await materializerIdle(SEED_SETTLE_MS)
  })

  it('times page mode’s saves', async function (this: Mocha.Context) {
    this.timeout(120_000 + REPEATS * 60_000)
    for (let repeat = 0; repeat < REPEATS; repeat++) {
      const label = seedLabel(20 + repeat * 10)
      const at = await pageModeIndexOf(label)
      const text = (await pageModeBlocks())[at]?.text ?? ''
      await pageModeCaret(at, 'end')
      await pageEdit('typing', () => typeInPageMode(TYPED, at, `${text}${TYPED}`))

      await pageEdit('blur, nothing to save', async () => {
        await $('[aria-label="Page title"]').click()
        await browser.waitUntil(
          () =>
            browser.execute(
              (selector: string) => document.activeElement !== document.querySelector(selector),
              PAGE_MODE,
            ),
          { timeout: ACTION_TIMEOUT, timeoutMsg: 'the page-mode editor kept the focus' },
        )
      })

      await pageModeCaret(at, 'end')
      await pageEdit('Enter, then a key', async () => {
        await browser.keys(['Enter'])
        await browser.keys(['x'])
        await browser.waitUntil(async () => (await pageModeBlocks())[at + 1]?.text === 'x', {
          timeout: ACTION_TIMEOUT,
          timeoutMsg: `Enter after ${label} made no block reading x`,
        })
      })

      const depth = (await pageModeBlocks())[at]?.depth ?? 0
      await pageEdit('Tab', async () => {
        await browser.keys(['Tab'])
        await browser.waitUntil(async () => (await pageModeBlocks())[at + 1]?.depth === depth + 1, {
          timeout: ACTION_TIMEOUT,
          timeoutMsg: `Tab never indented the block after ${label}`,
        })
      })
    }
  })

  it('times block mode’s round trips and writes the table', async () => {
    await chooseEditMode('Blocks')
    const scope = { kind: 'active', space_id: spaceId }
    for (let repeat = 0; repeat < REPEATS; repeat++) {
      // Blocks page mode left alone, each a top-level child at its seeded index.
      const index = CAP / 2 + repeat * 10
      const block = seeded[index]
      if (block === undefined) throw new Error(`no seeded block ${index}`)
      await blockEdit('typing', 'edit_block', {
        blockId: block.id,
        toText: `${block.content}${TYPED}`,
      })
      blockSamples.push({ kind: 'blur, nothing to save', ms: null, writes: 0 })
      const created = await blockEdit<{ id: string }>('Enter, then a key', 'create_block', {
        blockType: 'content',
        content: 'x',
        parentId: pageId,
        index: index + 1,
        scope,
        blockId: null,
      })
      await blockEdit('Tab', 'move_block', {
        blockId: created.id,
        newParentId: block.id,
        newIndex: 0,
      })
    }

    const rows = KINDS.map((kind) => {
      const page = pageSamples.filter((s) => s.kind === kind)
      const blocks = blockSamples.filter((s) => s.kind === kind)
      const ms = blocks.flatMap((s) => (s.ms === null ? [] : [s.ms]))
      return {
        edit: kind,
        'page mode save, ms': band(page.map((s) => s.saves.reduce((a, b) => a + b, 0))),
        'page mode saves': band(page.map((s) => s.saves.length)),
        'page mode writes': band(page.map((s) => s.writes)),
        'block mode IPC, ms': ms.length === 0 ? 'no IPC' : band(ms),
        'block mode writes': band(blocks.map((s) => s.writes)),
      }
    })
    const load = os.loadavg().map((v) => v.toFixed(2))
    const heading = `page-mode save against block mode at ${CAP} blocks, real backend (${REPEATS} repeats: median [min–max]; load ${load.join(' ')})`
    const columns = Object.keys(rows[0] ?? {})
    const widths = columns.map((c) =>
      Math.max(c.length, ...rows.map((r) => String(r[c as keyof typeof r]).length)),
    )
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')
    const table = [
      heading,
      line(columns),
      ...rows.map((r) => line(columns.map((c) => String(r[c as keyof typeof r])))),
    ].join('\n')
    // oxlint-disable-next-line no-console -- the measurement's output
    console.log(`\n${table}\n`)
    const dir = path.resolve(import.meta.dirname, 'artifacts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'page-mode-save-cost.json'),
      JSON.stringify({ table, load, repeats: REPEATS, rows, pageSamples, blockSamples }, null, 2),
    )
    expect(pageSamples).toHaveLength(REPEATS * KINDS.length)
    expect(blockSamples).toHaveLength(REPEATS * KINDS.length)
  })
})
