/**
 * Opt-in performance run: `AGARIC_PERF=1 npx playwright test e2e/perf.spec.ts`.
 *
 * Seeds a vault through the mock's own IPC (default 500 pages × 20 blocks plus
 * one 500-block page), drives the core journeys, and prints one row per journey:
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
 */

import { writeFileSync } from 'node:fs'

import type { CDPSession, Page } from '@playwright/test'

import { test } from './helpers'

const CPU = Number(process.env['AGARIC_PERF_CPU'] ?? 1)
const PAGES = Number(process.env['AGARIC_PERF_PAGES'] ?? 500)
const BIG_BLOCKS = Number(process.env['AGARIC_PERF_BLOCKS'] ?? 500)
const TRACE = process.env['AGARIC_PERF_TRACE'] === '1'
const BIG_TITLE = 'Perf big page'

interface PerfProbe {
  loaf: Array<{ start: number; duration: number; scripts: number }>
  events: Array<{ id: number; duration: number }>
  mock: Array<{ start: number; dur: number }>
  ipc: number
  commits: number
  peakBlocks: number
  peakNodes: number
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
    ipc: 0,
    commits: 0,
    peakBlocks: 0,
    peakNodes: 0,
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
        probe.ipc += 1
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
        ipc: p.ipc,
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
        ipc: p.ipc - m.ipc,
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

/** Seed the vault through the mock's IPC. Page `i`'s blocks link to page `i - 1`. */
async function seedVault(page: Page): Promise<void> {
  await page.evaluate(
    async ({ pages, bigBlocks, bigTitle }) => {
      const internals = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] as {
        invoke: (cmd: string, args: unknown) => Promise<unknown>
      }
      const invoke = (cmd: string, args: Record<string, unknown>) => internals.invoke(cmd, args)
      const words = 'lorem ipsum dolor sit amet project meeting idea review draft notes'.split(' ')
      const sentence = (n: number) =>
        Array.from({ length: 8 + (n % 10) }, (_, k) => words[(n + k * 7) % words.length]).join(' ')
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
        await invoke('create_blocks_batch', {
          specs: Array.from({ length: 20 }, (_, i) => ({
            blockType: 'content',
            content: `${sentence(p + i)}${i % 5 === 0 ? link : ''}`,
            parentId: id,
            position: null,
          })),
        })
      }
      const big = await invoke('create_page_in_space', {
        parentId: null,
        content: bigTitle,
        spaceId: 'SPACE_PERSONAL',
      })
      await invoke('create_blocks_batch', {
        specs: Array.from({ length: bigBlocks }, (_, i) => ({
          blockType: 'content',
          content: `${i % 9 === 0 ? 'TODO ' : ''}${sentence(i)} **bold** \`code\` [[${ids[i % ids.length]}]]`,
          parentId: big,
          position: null,
        })),
      })
    },
    { pages: PAGES, bigBlocks: BIG_BLOCKS, bigTitle: BIG_TITLE },
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
