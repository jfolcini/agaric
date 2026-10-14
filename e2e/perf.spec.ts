/**
 * Opt-in performance run: `AGARIC_PERF=1 npx playwright test e2e/perf.spec.ts`.
 *
 * Seeds a vault through the mock's own IPC (default 500 pages × 20 blocks, each
 * page with one dated TODO and one tagged block, plus one 500-block page),
 * drives the core journeys, and prints one row per journey. On a view journey
 * (Pages, Search, Agenda, Tags) `wallMs` is the click to the first data row.
 *
 *  - `inp`: worst Event Timing interaction (the web-vitals INP definition).
 *  - `appLongFrames` / `worstFrame`: Long Animation Frames, minus mock time.
 *  - `peakBlocks` / `peakNodes`: most fully rendered blocks / DOM nodes seen in
 *    any frame, which exposes render-everything-then-discard patterns.
 *  - `commits`: React commits (counted through the devtools hook).
 *  - `cpu`: main-thread self time by bundle chunk (`react-vendor`, `editor`,
 *    `ui-radix`, `index` = app code, `tauri-mock` = not in production).
 *
 * Every mock handler runs in its own task and is timed apart (`mockMs`). Real
 * IPC is async and out-of-process; without the deferral the in-page mock's cost
 * lands inside the interaction that called it and inflates INP.
 *
 * Knobs: `AGARIC_PERF_CPU=4` throttles the CPU (a mid-range laptop or phone),
 * `AGARIC_PERF_PAGES` / `AGARIC_PERF_BLOCKS` set the vault size, and
 * `AGARIC_PERF_TRACE=1` saves a Chrome trace per journey (open it in the
 * DevTools Performance panel or ui.perfetto.dev; tracing adds overhead, so
 * compare numbers only between runs with the same knobs). `perf-report.json`
 * and the traces land in `test-results/perf-*`.
 *
 * Caveats: this is Chromium against the JS mock. It measures frontend cost
 * only, says nothing about backend query time (use `AGARIC_OTEL=1` on the real
 * app, or the `interactive_slo` bench), and nothing about WebKitGTK or the
 * Android WebView. Headless Chromium rasterizes in software, so a long frame
 * with no script in it is mostly paint and is not evidence of a real problem.
 * The run fails only when a journey cannot complete; it has no budgets.
 *
 * `perf: boot JS executed share (#5441)` is opt-in too: it loads the app cold and prints how
 * many JS files and bytes load by the first block and by first block + 2 s, and what share of
 * them V8 ran.
 *
 * The other tests are NOT opt-in: rendered-row and IPC counts are
 * deterministic, unlike the timings, so they pin the big page's initial render
 * window (#5329) and what opening each list view (#5366) or a page (#5445)
 * costs on every PR.
 */

import { writeFileSync } from 'node:fs'

import type { CDPSession, Page } from '@playwright/test'

import { expect, navigateToView, test } from './helpers'

const CPU = Number(process.env['AGARIC_PERF_CPU'] ?? 1)
const PAGES = Number(process.env['AGARIC_PERF_PAGES'] ?? 500)
const BIG_BLOCKS = Number(process.env['AGARIC_PERF_BLOCKS'] ?? 500)
const TRACE = process.env['AGARIC_PERF_TRACE'] === '1'
const TAGS = 50
const BIG_TITLE = 'Perf big page'

interface PerfProbe {
  loaf: Array<{ start: number; duration: number; scripts: number }>
  events: Array<{ id: number; duration: number }>
  mock: Array<{ start: number; dur: number }>
  /** Every IPC command name, in call order. */
  ipc: string[]
  commits: number
  peakBlocks: number
  peakNodes: number
  /** What `peakRows` counts; the #5366 tests set it. */
  rowSelector: string | null
  peakRows: number
}

declare global {
  interface Window {
    __perf__?: PerfProbe
  }
}

/** Runs before any app script. Installs observers and the mock IPC deferral. */
function installProbes(): void {
  const probe: PerfProbe = {
    loaf: [],
    events: [],
    mock: [],
    ipc: [],
    commits: 0,
    peakBlocks: 0,
    peakNodes: 0,
    rowSelector: null,
    peakRows: 0,
  }
  window.__perf__ = probe
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as Array<PerformanceEntry & { scripts?: unknown[] }>) {
      probe.loaf.push({ start: e.startTime, duration: e.duration, scripts: e.scripts?.length ?? 0 })
    }
  }).observe({ type: 'long-animation-frame', buffered: true })
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as Array<PerformanceEntry & { interactionId?: number }>) {
      if (e.interactionId) probe.events.push({ id: e.interactionId, duration: e.duration })
    }
  }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit)

  const sample = (): void => {
    probe.peakBlocks = Math.max(
      probe.peakBlocks,
      document.querySelectorAll('[data-testid="block-static"]').length,
    )
    probe.peakNodes = Math.max(probe.peakNodes, document.getElementsByTagName('*').length)
    if (probe.rowSelector) {
      probe.peakRows = Math.max(probe.peakRows, document.querySelectorAll(probe.rowSelector).length)
    }
  }
  new MutationObserver(sample).observe(document, { childList: true, subtree: true })

  // Production React reports every commit to a devtools hook when one exists.
  Object.assign(window, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => {},
      onScheduleFiberRoot: () => {},
      onCommitFiberRoot: () => {
        probe.commits += 1
      },
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
    },
  })

  type Invoke = (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>
  const defer =
    (inner: Invoke): Invoke =>
    (cmd, args, opts) =>
      new Promise((resolve, reject) => {
        probe.ipc.push(cmd)
        setTimeout(() => {
          const t0 = performance.now()
          try {
            inner(cmd, args, opts).then(resolve, reject)
          } catch (err) {
            reject(err)
          }
          probe.mock.push({ start: t0, dur: performance.now() - t0 })
        }, 0)
      })
  // The mock assigns `window.__TAURI_INTERNALS__.invoke` at boot; wrap it as it
  // lands. The getter stays `undefined` until then, so the mock still activates.
  let internals: Record<string, unknown> | undefined
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    get: () => internals,
    set(value: Record<string, unknown>) {
      internals = value
      let wrapped: Invoke | undefined
      Object.defineProperty(value, 'invoke', {
        configurable: true,
        get: () => wrapped,
        set: (fn: Invoke) => {
          wrapped = defer(fn)
        },
      })
    },
  })
}

interface Row {
  journey: string
  wallMs: number
  inp: number | null
  appLongFrames: number
  appLongFrameMs: number
  worstFrame: number
  peakBlocks: number
  peakNodes: number
  commits: number
  ipc: number
  mockMs: number
  scriptMs: number
  styleLayoutMs: number
  heapMb: number
  cpu: string
}

/** Write a file into the test's output dir (kept after the run) and attach it. */
async function saveOutput(name: string, body: string | Buffer): Promise<void> {
  const path = test.info().outputPath(name.replaceAll(/[^\w.-]+/g, '-'))
  writeFileSync(path, body)
  await test.info().attach(name, { path, contentType: 'application/json' })
}

/** Main-thread self time per bundle chunk, from a CDP CPU profile. */
function cpuByChunk(profile: {
  nodes: Array<{ id: number; callFrame: { url: string; functionName: string } }>
  samples?: number[]
  timeDeltas?: number[]
}): string {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n.callFrame]))
  const totals = new Map<string, number>()
  const deltas = profile.timeDeltas ?? []
  ;(profile.samples ?? []).forEach((id, i) => {
    const frame = nodes.get(id)
    if (!frame || frame.functionName === '(idle)' || frame.functionName === '(program)') return
    const file = frame.url ? (frame.url.split('/').pop() ?? '') : frame.functionName
    const chunk = file.replace(/-[\w-]{8}\.js$/, '') || '(native)'
    totals.set(chunk, (totals.get(chunk) ?? 0) + (deltas[i + 1] ?? 0) / 1000)
  })
  return [...totals]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([chunk, ms]) => `${chunk} ${Math.round(ms)}`)
    .join(', ')
}

function makeMeasure(page: Page, cdp: CDPSession, rows: Row[]) {
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
    )
  const browser = page.context().browser()
  const snapshot = () =>
    page.evaluate(() => {
      const p = window.__perf__
      if (!p) return null
      const mark = {
        t: performance.now(),
        loaf: p.loaf.length,
        events: p.events.length,
        mock: p.mock.length,
        ipc: p.ipc.length,
        commits: p.commits,
      }
      p.peakBlocks = 0
      p.peakNodes = 0
      return mark
    })

  return async (journey: string, action: () => Promise<void>): Promise<void> => {
    const mark = (await snapshot().catch(() => null)) ?? {
      t: 0,
      loaf: 0,
      events: 0,
      mock: 0,
      ipc: 0,
      commits: 0,
    }
    const before = await metrics()
    if (TRACE && browser) await browser.startTracing(page, { screenshots: false })
    await cdp.send('Profiler.start')
    const t0 = Date.now()
    await test.step(journey, action)
    const wallMs = Date.now() - t0
    // Let trailing frames reach the observers.
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    )
    const { profile } = await cdp.send('Profiler.stop')
    if (TRACE && browser) await saveOutput(`trace-${journey}.json`, await browser.stopTracing())
    const after = await metrics()
    const probe = await page.evaluate((m) => {
      const p = window.__perf__ as PerfProbe
      const mock = p.mock.slice(m.mock)
      const frames = p.loaf.slice(m.loaf).map((f) => {
        const inside = mock.filter((t) => t.start >= f.start && t.start < f.start + f.duration)
        return f.duration - inside.reduce((a, t) => a + t.dur, 0)
      })
      const perInteraction = new Map<number, number>()
      for (const e of p.events.slice(m.events)) {
        perInteraction.set(e.id, Math.max(perInteraction.get(e.id) ?? 0, e.duration))
      }
      return {
        appFrames: frames.filter((ms) => ms >= 50),
        inp: perInteraction.size > 0 ? Math.max(...perInteraction.values()) : null,
        mockMs: mock.reduce((a, t) => a + t.dur, 0),
        ipc: p.ipc.length - m.ipc,
        commits: p.commits - m.commits,
        peakBlocks: p.peakBlocks,
        peakNodes: p.peakNodes,
      }
    }, mark)
    const delta = (k: string) => ((after[k] ?? 0) - (before[k] ?? 0)) * 1000
    rows.push({
      journey,
      wallMs,
      inp: probe.inp,
      appLongFrames: probe.appFrames.length,
      appLongFrameMs: Math.round(probe.appFrames.reduce((a, b) => a + b, 0)),
      worstFrame: Math.round(Math.max(0, ...probe.appFrames)),
      peakBlocks: probe.peakBlocks,
      peakNodes: probe.peakNodes,
      commits: probe.commits,
      ipc: probe.ipc,
      mockMs: Math.round(probe.mockMs),
      scriptMs: Math.round(delta('ScriptDuration')),
      styleLayoutMs: Math.round(delta('RecalcStyleDuration') + delta('LayoutDuration')),
      heapMb: Math.round((after['JSHeapUsedSize'] ?? 0) / 1048576),
      cpu: cpuByChunk(profile),
    })
  }
}

/**
 * Seed the vault through the mock's IPC. Page `i`'s blocks link to page `i - 1`;
 * its first block is a TODO due within a month either side of today, and its
 * second carries one of `tags` tags.
 */
async function seedVault(page: Page): Promise<void> {
  const pageIds = await page.evaluate(
    async ({ pages, tags }) => {
      const internals = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] as {
        invoke: (cmd: string, args: unknown) => Promise<unknown>
      }
      const invoke = (cmd: string, args: Record<string, unknown>) => internals.invoke(cmd, args)
      const words = 'lorem ipsum dolor sit amet project meeting idea review draft notes'.split(' ')
      const sentence = (n: number) =>
        Array.from({ length: 8 + (n % 10) }, (_, k) => words[(n + k * 7) % words.length]).join(' ')
      const isoDate = (offset: number) => {
        const d = new Date()
        d.setDate(d.getDate() + offset)
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      }
      const tagIds: string[] = []
      for (let t = 0; t < tags; t++) {
        const tag = (await invoke('create_block', {
          blockType: 'tag',
          content: `perf-tag-${String(t).padStart(2, '0')}`,
          parentId: null,
          index: null,
          scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
          blockId: null,
        })) as { id: string }
        tagIds.push(tag.id)
      }
      const ids: string[] = []
      for (let p = 0; p < pages; p++) {
        const title = `Perf page ${String(p).padStart(4, '0')}`
        const id = (await invoke('create_page_in_space', {
          parentId: null,
          content: title,
          spaceId: 'SPACE_PERSONAL',
        })) as string
        const link = ids.length > 0 ? ` [[${ids.at(-1)}]]` : ''
        ids.push(id)
        const { blocks } = (await invoke('create_blocks_batch', {
          specs: Array.from({ length: 20 }, (_, i) => ({
            blockType: 'content',
            content: `${sentence(p + i)}${i % 5 === 0 ? link : ''}`,
            parentId: id,
            position: null,
          })),
        })) as { blocks: Array<{ id: string }> }
        const [task, tagged] = blocks
        if (task) {
          await invoke('set_todo_state', { blockId: task.id, state: 'TODO' })
          await invoke('set_due_date', { blockId: task.id, date: isoDate((p % 61) - 30) })
        }
        const tagId = tagIds[p % tags]
        if (tagged && tagId) await invoke('add_tag', { blockId: tagged.id, tagId })
      }
      return ids
    },
    { pages: PAGES, tags: TAGS },
  )
  await seedBigPage(page, pageIds)
}

/** Seed the `BIG_BLOCKS`-block page; its blocks link round-robin to `linkTargets`. */
async function seedBigPage(page: Page, linkTargets: string[]): Promise<void> {
  await page.evaluate(
    async ({ bigBlocks, bigTitle, linkTargets: targets }) => {
      const internals = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] as {
        invoke: (cmd: string, args: unknown) => Promise<unknown>
      }
      const invoke = (cmd: string, args: Record<string, unknown>) => internals.invoke(cmd, args)
      const words = 'lorem ipsum dolor sit amet project meeting idea review draft notes'.split(' ')
      const sentence = (n: number) =>
        Array.from({ length: 8 + (n % 10) }, (_, k) => words[(n + k * 7) % words.length]).join(' ')
      const big = await invoke('create_page_in_space', {
        parentId: null,
        content: bigTitle,
        spaceId: 'SPACE_PERSONAL',
      })
      await invoke('create_blocks_batch', {
        specs: Array.from({ length: bigBlocks }, (_, i) => {
          const target = targets[i % Math.max(1, targets.length)]
          const link = target ? ` [[${target}]]` : ''
          return {
            blockType: 'content',
            content: `${i % 9 === 0 ? 'TODO ' : ''}${sentence(i)} **bold** \`code\`${link}`,
            parentId: big,
            position: null,
          }
        }),
      })
    },
    { bigBlocks: BIG_BLOCKS, bigTitle: BIG_TITLE, linkTargets },
  )
}

async function openViaPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+k')
  const input = page.locator('[cmdk-input]').first()
  await input.fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await page.locator('[aria-label="Page title"]').waitFor()
}

test('perf: core journeys on a seeded vault', async ({ page }) => {
  test.skip(!process.env['AGARIC_PERF'], 'opt-in: AGARIC_PERF=1')
  test.setTimeout(15 * 60_000)

  const sidebar = (label: string) =>
    page.locator('[data-slot="sidebar"]').getByRole('button', { name: label, exact: true })
  const blocks = page.locator('[data-testid="block-static"]')
  const rows: Row[] = []
  await page.addInitScript(installProbes)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await cdp.send('Profiler.enable')
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })
  const measure = makeMeasure(page, cdp, rows)

  await measure('boot', async () => {
    await page.goto('/')
    await blocks.first().waitFor()
  })
  await seedVault(page)
  await measure('pages view', async () => {
    await sidebar('Pages').click()
    await page.getByText('Perf page 0000', { exact: true }).waitFor()
  })
  await measure('open big page', async () => {
    await openViaPalette(page, BIG_TITLE)
    await blocks.nth(10).waitFor()
  })
  await measure('click block → editor', async () => {
    await blocks.nth(3).click()
    await page.locator('[data-testid="block-editor"] [contenteditable="true"]').waitFor()
  })
  await measure('type 40 chars', async () => {
    await page.keyboard.press('End')
    await page.keyboard.type(' the quick brown fox jumps over the lazy', { delay: 80 })
  })
  await measure('Enter → new block ×5', async () => {
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Enter')
      await page.keyboard.type(`new ${i}`, { delay: 30 })
    }
  })
  await measure('scroll big page', async () => {
    await page.keyboard.press('Escape')
    await blocks.nth(10).hover()
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, 1200)
      await page.waitForTimeout(50)
    }
  })
  await measure('search', async () => {
    await sidebar('Search').click()
    const input = page.getByPlaceholder('Search blocks...')
    await input.pressSequentially('lorem', { delay: 60 })
    await input.press('Enter')
    await page.locator('[data-testid^="search-result-row-"]').first().waitFor()
  })
  await measure('journal', async () => {
    await sidebar('Journal').click()
    await blocks.first().waitFor()
  })
  await measure('agenda view', async () => {
    await page.getByRole('tab', { name: 'Agenda view' }).click()
    await page.getByTestId('agenda-results-item').first().waitFor()
  })
  await measure('tags view', async () => {
    await sidebar('Tags').click()
    await page.locator('[data-testid^="tag-item-"]').first().waitFor()
  })
  await measure('open linked page', async () => {
    await openViaPalette(page, 'Perf page 0001')
    await blocks.first().waitFor()
  })
  await measure('re-open big page', async () => {
    await openViaPalette(page, BIG_TITLE)
    await blocks.nth(10).waitFor()
  })

  await saveOutput(
    'perf-report.json',
    JSON.stringify({ cpuThrottle: CPU, pages: PAGES, bigBlocks: BIG_BLOCKS, rows }, null, 2),
  )
  console.log(`\nperf (CPU ×${CPU}, ${PAGES} pages, ${BIG_BLOCKS}-block page)`)
  console.table(rows)
})

/** Milliseconds from the last click or key press in `act` until `selector` is in the DOM. */
async function timeToReady(
  page: Page,
  selector: string,
  act: () => Promise<void>,
): Promise<number> {
  await page.evaluate((sel) => {
    let t0 = 0
    const mark = (): void => {
      t0 = performance.now()
    }
    addEventListener('click', mark, true)
    addEventListener('keydown', mark, true)
    Object.assign(window, {
      __ready__: new Promise<number>((resolve) => {
        new MutationObserver((_, observer) => {
          if (t0 === 0 || !document.querySelector(sel)) return
          observer.disconnect()
          removeEventListener('click', mark, true)
          removeEventListener('keydown', mark, true)
          resolve(performance.now() - t0)
        }).observe(document, { childList: true, subtree: true })
      }),
    })
  }, selector)
  await act()
  return Math.round(
    await page.evaluate(() => (window as unknown as { __ready__: Promise<number> }).__ready__),
  )
}

/**
 * #5444 — the first visit to a view against later ones. A view whose first
 * render suspends shows `ViewFallback`, and React holds the view back until
 * 300 ms after it; the idle preload lets the first visit render without
 * suspending. Times are in-page: Playwright's `waitFor` polls on a backoff
 * that rounds a 300 ms wait up to about 800 ms of wall time.
 */
test('perf: first and second visit to each view', async ({ page }) => {
  test.skip(!process.env['AGARIC_PERF'], 'opt-in: AGARIC_PERF=1')
  const blocks = page.locator('[data-testid="block-static"]')
  const visits: Array<[view: string, ready: string, open: () => Promise<void>]> = [
    ['Pages', '[id^="page-row-"]', () => navigateToView(page, 'Pages')],
    ['Search', 'input[placeholder="Search blocks..."]', () => navigateToView(page, 'Search')],
    ['Tags', '[data-testid^="tag-item-"]', () => navigateToView(page, 'Tags')],
    ['Settings', '[data-testid="settings-tab-rail"]', () => navigateToView(page, 'Settings')],
    ['Graph', '[data-testid="graph-view"]', () => navigateToView(page, 'Graph')],
    ['page', '[aria-label="Page title"]', () => openViaPalette(page, 'Getting Started')],
  ]
  await page.goto('/')
  await blocks.first().waitFor()
  // The preload runs at idle after boot, before a user's first click.
  await page.waitForLoadState('networkidle')
  const rows: Array<{ visit: string; view: string; ms: number }> = []
  for (const visit of ['first', 'second']) {
    for (const [view, ready, open] of visits) {
      await navigateToView(page, 'Journal')
      await blocks.first().waitFor()
      rows.push({ visit, view, ms: await timeToReady(page, ready, open) })
    }
  }
  console.table(rows)
})

interface CoverageRange {
  startOffset: number
  endOffset: number
  count: number
}

/**
 * UTF-8 bytes of `source` that V8 reports as executed. The ranges nest (a
 * function's range holds its block ranges), so they are painted outermost
 * first and the innermost range wins: an unexecuted `else` inside an executed
 * function stays unexecuted. Offsets are UTF-16 code units; each is weighted
 * by its UTF-8 size so the result is in bytes like `total`.
 */
function coveredBytes(
  source: string,
  functions: Array<{ ranges: CoverageRange[] }>,
): { executed: number; total: number } {
  // `toSorted` is stable, so equal spans keep V8's order (a later range is the more specific).
  const ranges = functions
    .flatMap((f) => f.ranges)
    .toSorted((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset)
  const executed = new Uint8Array(source.length)
  for (const r of ranges) executed.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset)
  let covered = 0
  let total = 0
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i)
    // A surrogate pair is 4 bytes in all, 2 per half.
    const bytes = code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code < 0xe000 ? 2 : 3
    total += bytes
    if (executed[i]) covered += bytes
  }
  return { executed: covered, total }
}

test('coveredBytes: the innermost range wins and bytes are UTF-8', () => {
  test.skip(!process.env['AGARIC_PERF'], 'opt-in: checks the coverage harness, AGARIC_PERF=1')
  //            0         1         2
  //            0123456789012345678901234
  const source = 'f();if(a){b()}else{é()}//'
  const executed = coveredBytes(source, [
    // Outer range ran; the nested `else` block did not; a later nested range re-ran inside it.
    {
      ranges: [
        { startOffset: 0, endOffset: 25, count: 1 },
        { startOffset: 14, endOffset: 23, count: 0 },
        { startOffset: 19, endOffset: 21, count: 2 },
      ],
    },
  ])
  // 25 chars, `é` is 2 bytes. Unexecuted: offsets 14-18 and 21-22 (7 chars, 7 bytes).
  expect(executed).toEqual({ executed: 26 - 7, total: 26 })
})

/**
 * #5441 — how much of the JS the page loads at boot actually runs. The window
 * is the issue's: from navigation until the first block renders plus 2 s.
 * Scripts are the module files the page fetched (entry, static imports,
 * dynamic imports); `coverage` is V8 precise coverage over the whole window
 * (`resetOnNavigation: false`), and a script's executed share is the bytes in
 * ranges with a count above 0 (see `coveredBytes`). "Raw" is the decoded file
 * size, so it does not depend on compression.
 *
 * Two windows are reported because main idle-preloads every view chunk (#5525)
 * after mount: `to first block` is what boot needs, `first block + 2 s` adds
 * what that preload fetches. Executed bytes for both are read at +2 s, so a
 * file loaded before the first block counts what it ran by then. Scripts a
 * `modulepreload` fetched but V8 never compiled have no coverage entry and
 * count as fully unexecuted.
 */
test('perf: boot JS executed share (#5441)', async ({ page }) => {
  test.skip(!process.env['AGARIC_PERF'], 'opt-in: AGARIC_PERF=1')
  const WINDOW_MS = 2000
  await page.addInitScript((): void => {
    performance.setResourceTimingBufferSize(2000)
    const w = window as unknown as { __firstBlock__?: number }
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-testid="block-static"]')) return
      w.__firstBlock__ = performance.now()
      observer.disconnect()
    }).observe(document, { childList: true, subtree: true })
  })
  await page.coverage.startJSCoverage({ resetOnNavigation: false })
  await page.goto('/')
  await page.locator('[data-testid="block-static"]').first().waitFor()
  const loaded = await page.evaluate(async (windowMs) => {
    const w = window as unknown as { __firstBlock__?: number }
    const first = w.__firstBlock__ ?? performance.now()
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, first + windowMs - performance.now())),
    )
    return {
      first,
      files: performance
        .getEntriesByType('resource')
        .filter((e) => /\.m?js$/.test(new URL(e.name).pathname))
        .map((e) => {
          const r = e as PerformanceResourceTiming
          return { url: r.name, end: r.responseEnd, raw: r.decodedBodySize }
        }),
    }
  }, WINDOW_MS)
  const coverage = await page.coverage.stopJSCoverage()

  const byUrl = new Map(coverage.map((c) => [c.url, c]))
  const files = loaded.files.map((f) => {
    const entry = byUrl.get(f.url)
    const sized = entry?.source ? coveredBytes(entry.source, entry.functions) : null
    return {
      file: new URL(f.url).pathname.split('/').pop() ?? f.url,
      loadedMs: Math.round(f.end),
      rawBytes: sized?.total ?? f.raw,
      executedBytes: sized?.executed ?? 0,
    }
  })
  const measure = (label: string, keep: (loadedMs: number) => boolean) => {
    const inWindow = files.filter((f) => keep(f.loadedMs))
    const raw = inWindow.reduce((a, f) => a + f.rawBytes, 0)
    const executed = inWindow.reduce((a, f) => a + f.executedBytes, 0)
    return {
      window: label,
      files: inWindow.length,
      rawKB: Math.round(raw / 1024),
      executedKB: Math.round(executed / 1024),
      executedPct: Math.round((executed / raw) * 1000) / 10,
    }
  }
  const rows = [
    measure('to first block', (ms) => ms <= loaded.first),
    measure('first block + 2 s', (ms) => ms <= loaded.first + WINDOW_MS),
  ]
  const late = files.filter((f) => f.loadedMs > loaded.first)
  console.log(`\nboot JS (first block at ${Math.round(loaded.first)} ms)`)
  console.table(rows)
  console.log(
    `loaded after the first block: ${late.map((f) => `${f.file}@${f.loadedMs}`).join(' ')}`,
  )
  await saveOutput(
    'boot-js-coverage.json',
    JSON.stringify({ firstBlockMs: loaded.first, rows, files }, null, 2),
  )

  // A harness that reports zero files, or a share outside (0, 100), measured nothing.
  expect(rows[0]?.files ?? 0).toBeGreaterThan(0)
  for (const row of rows) {
    expect(row.executedPct).toBeGreaterThan(0)
    expect(row.executedPct).toBeLessThan(100)
  }
})

/**
 * #5329 — the initial render window. Before it, opening the big page rendered
 * every one of its blocks in full once (`peakBlocks` 500, a 1.2 s frame) and
 * then swapped all but the visible ~22 for placeholders. Now the first commit
 * renders `INITIAL_WINDOW_ROWS` (30) rows and the observer hydrates only what
 * the 720 px viewport plus the 200 px margin reaches — about as many again at
 * the placeholder estimate — a frame-budgeted few at a time (#5330). Twice the
 * window is the bound; a regression to render-everything reads 500.
 */
const PEAK_RENDERED_BLOCKS_BOUND = 60

test('opening a 500-block page renders only the initial window in full (#5329)', async ({
  page,
}) => {
  const blocks = page.locator('[data-testid="block-static"]')
  await page.addInitScript(installProbes)
  await page.goto('/')
  await blocks.first().waitFor()
  await seedBigPage(page, [])
  await page.evaluate(() => {
    const probe = window.__perf__
    if (probe) probe.peakBlocks = 0
  })

  await openViaPalette(page, BIG_TITLE)
  await blocks.nth(10).waitFor()
  // Let hydration settle: the peak is read once no frame has changed the
  // rendered-block count for a while.
  await expect
    .poll(async () => {
      const before = await blocks.count()
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      )
      return (await blocks.count()) === before
    })
    .toBe(true)

  const peak = await page.evaluate(() => window.__perf__?.peakBlocks ?? -1)
  // The lower bound proves the probe saw the page at all.
  expect(peak).toBeGreaterThanOrEqual(10)
  expect(peak).toBeLessThanOrEqual(PEAK_RENDERED_BLOCKS_BOUND)
})

/**
 * #5366 — opening each list view on `SEEDED_ROWS` rows. The rendered rows stay
 * under the #5329 bound: a view that renders every row reads about 500. The
 * view's IPC from the click until it settles is pinned to the measured count,
 * so a call per row, even per rendered row, fails it. A deliberate change to a
 * view's open path re-measures and updates its `ipcOnOpen`.
 */
const SEEDED_ROWS = 500
/** Outlasts every timer on an open path: the search debounce (300 ms), the prefetch dwell (120 ms). */
const QUIET_MS = 1000

interface ListView {
  name: string
  /** One rendered data row. */
  rows: string
  ipcOnOpen: number
  seed: (page: Page) => Promise<unknown>
  open: (page: Page) => Promise<void>
}

const indices = Array.from({ length: SEEDED_ROWS }, (_, i) => String(i).padStart(4, '0'))

/** Send one `cmd` call per `calls` entry through the mock's IPC, in order. */
async function invokeEach(
  page: Page,
  cmd: string,
  calls: Array<Record<string, unknown>>,
): Promise<void> {
  await page.evaluate(
    async ({ cmd: name, calls: argsList }) => {
      const internals = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] as {
        invoke: (cmd: string, args: unknown) => Promise<unknown>
      }
      for (const args of argsList) await internals.invoke(name, args)
    },
    { cmd, calls },
  )
}

const LIST_VIEWS: ListView[] = [
  {
    name: 'Agenda',
    rows: '[data-testid="agenda-results-item"]',
    // filtered_blocks_query, get_batch_properties; page titles come from the
    // resolve store's boot preload (#5439)
    ipcOnOpen: 2,
    seed: (page) =>
      page.evaluate((n) => {
        ;(
          window as unknown as { __addMockAgendaItems: (count: number) => string[] }
        ).__addMockAgendaItems(n)
      }, SEEDED_ROWS),
    open: (page) => page.getByRole('tab', { name: 'Agenda view' }).click(),
  },
  {
    name: 'Pages',
    rows: '[id^="page-row-"]',
    // set_title, count_trash, list_pages_with_metadata. Visible rows prefetch
    // their subtree only on touch (#5446), and this viewport is a mouse one.
    ipcOnOpen: 3,
    seed: (page) =>
      invokeEach(
        page,
        'create_page_in_space',
        indices.map((i) => ({
          parentId: null,
          content: `Perf page ${i}`,
          spaceId: 'SPACE_PERSONAL',
        })),
      ),
    open: (page) => navigateToView(page, 'Pages'),
  },
  {
    name: 'Tags',
    rows: '[data-testid^="tag-item-"]',
    // set_title, list_all_tags_in_space
    ipcOnOpen: 2,
    seed: (page) =>
      invokeEach(
        page,
        'create_block',
        indices.map((i) => ({
          blockType: 'tag',
          content: `perf-tag-${i}`,
          parentId: null,
          index: null,
          scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
          blockId: null,
        })),
      ),
    open: (page) => navigateToView(page, 'Tags'),
  },
  {
    name: 'Search',
    rows: '[data-testid^="search-result-row-"]',
    // set_title, search_blocks, resolve_page_by_alias, batch_resolve
    ipcOnOpen: 4,
    // Every block of the big page holds `**bold**`.
    seed: (page) => seedBigPage(page, []),
    open: async (page) => {
      await navigateToView(page, 'Search')
      await page.getByPlaceholder('Search blocks...').fill('bold')
    },
  },
]

/** Resolves once neither the `rows` count nor the IPC log has moved for `QUIET_MS`. */
async function settle(page: Page, rows: string): Promise<void> {
  const state = () =>
    page.evaluate(
      (selector) => `${document.querySelectorAll(selector).length}:${window.__perf__?.ipc.length}`,
      rows,
    )
  await expect
    .poll(
      async () => {
        const before = await state()
        await page.waitForTimeout(QUIET_MS)
        return (await state()) === before
      },
      { timeout: 30_000 },
    )
    .toBe(true)
}

for (const view of LIST_VIEWS) {
  test(`opening ${view.name} on ${SEEDED_ROWS} rows renders a window and pins its IPC (#5366)`, async ({
    page,
  }) => {
    await page.addInitScript(installProbes)
    await page.goto('/')
    await page.locator('[data-testid="block-static"]').first().waitFor()
    await view.seed(page)
    // The boot sync (`useSyncTrigger`) fires 2 s after mount; wait it out so a
    // quick seed cannot leave it to land inside the measured window.
    await expect
      .poll(() => page.evaluate(() => window.__perf__?.ipc.includes('list_peer_refs')))
      .toBe(true)
    await settle(page, view.rows)

    const mark = await page.evaluate((selector) => {
      const probe = window.__perf__ as PerfProbe
      probe.rowSelector = selector
      probe.peakRows = 0
      return probe.ipc.length
    }, view.rows)
    await view.open(page)
    await page.locator(view.rows).first().waitFor()
    await settle(page, view.rows)
    const { peakRows, calls } = await page.evaluate((from) => {
      const probe = window.__perf__ as PerfProbe
      return { peakRows: probe.peakRows, calls: probe.ipc.slice(from) }
    }, mark)

    // The lower bound proves the probe saw the view at all.
    expect(peakRows).toBeGreaterThanOrEqual(10)
    expect(peakRows).toBeLessThanOrEqual(PEAK_RENDERED_BLOCKS_BOUND)
    expect(calls.length, calls.join(', ')).toBe(view.ipcOnOpen)
  })
}

/**
 * #5445 — opening a page from the Pages list, then following a link chip to
 * another page. Each pins the IPC sent from the click until the page settles,
 * as a sorted list of command names, so a duplicate fetch or one for a closed
 * panel fails it. A deliberate change re-measures from the failure message.
 */
const PAGE_OPEN_IPC = [
  'batch_resolve',
  'get_batch_properties',
  'get_block',
  'get_page_aliases',
  'get_properties',
  'list_all_tags_in_space',
  'list_attachments_batch',
  'list_backlinks_grouped',
  'list_inherited_tags_for_block',
  'list_pages_with_metadata',
  'list_property_defs',
  'list_tags_for_block',
  'list_unlinked_references',
  'load_page_subtree',
  'plugin:window|set_title',
]
/**
 * The open set plus the chip's target lookup, minus the tag list: the header
 * stays mounted and loads that once per space.
 */
const LINK_CLICK_IPC = [
  'batch_resolve',
  'batch_resolve',
  'get_batch_properties',
  'get_block',
  'get_block',
  'get_page_aliases',
  'get_properties',
  'list_attachments_batch',
  'list_backlinks_grouped',
  'list_inherited_tags_for_block',
  'list_pages_with_metadata',
  'list_property_defs',
  'list_tags_for_block',
  'list_unlinked_references',
  'load_page_subtree',
  'plugin:window|set_title',
]

test('opening a page and following a link chip pin their IPC (#5445)', async ({ page }) => {
  const blocks = '[data-testid="block-static"]'
  await page.addInitScript(installProbes)
  await page.goto('/')
  await page.locator(blocks).first().waitFor()
  await expect
    .poll(() => page.evaluate(() => window.__perf__?.ipc.includes('list_peer_refs')))
    .toBe(true)
  await navigateToView(page, 'Pages')
  await page.locator('[id^="page-row-"]').first().waitFor()
  await settle(page, '[id^="page-row-"]')

  const measure = async (act: () => Promise<void>, title: string): Promise<string[]> => {
    const mark = await page.evaluate(() => window.__perf__?.ipc.length ?? 0)
    await act()
    await page.locator('[aria-label="Page title"]', { hasText: title }).waitFor()
    await page.locator(blocks).first().waitFor()
    await settle(page, blocks)
    return page.evaluate((from) => (window.__perf__?.ipc.slice(from) ?? []).toSorted(), mark)
  }

  const open = await measure(
    () => page.getByText('Getting Started', { exact: true }).click(),
    'Getting Started',
  )
  const link = await measure(
    () => page.locator('[data-testid="block-link-chip"]', { hasText: 'Quick Notes' }).click(),
    'Quick Notes',
  )
  expect.soft(open, open.join(', ')).toEqual(PAGE_OPEN_IPC)
  expect(link, link.join(', ')).toEqual(LINK_CLICK_IPC)
})
