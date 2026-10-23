#!/usr/bin/env node
// Page mode against block mode on WebKitGTK, Linux's webview (#5691): the numbers behind
// page mode's block cap (`PAGE_MODE_BLOCK_CAP`, `src/editor/page-mode/page-mode-fit.ts`).
// `e2e/perf.spec.ts -g 'page mode'` is the same comparison on Chromium.
//
// Usage, from the repo root (needs `webkit2gtk-driver` and xvfb):
//   VITE_E2E=1 npx vite build
//   xvfb-run -a -s '-screen 0 1280x1024x24' node scripts/measure-page-mode-webkit.mjs
//
// Env: SIZES (default 250,500,1000,2000), REPEATS (3), CONFIGS (blocks,blocks-all,page), PORT
// (5316), WD_PORT (4446), OUT (a JSON file for every sample), CSS (a stylesheet a `+css` config
// adds, e.g. CONFIGS=page,page+css CSS='.page-mode-editor [data-page-block] { … }').
//
// It serves `dist/` with `vite preview` against the in-page mock, drives MiniBrowser through
// WebKitWebDriver, and seeds a page per size and repeat through the mock's IPC (`seed`):
// paragraphs of mixed length, with tasks, headings and code blocks among them.
// The cap is lifted for the run (`window.__pageModeBlockCap`, honoured by VITE_E2E builds only).
// Each repeat rotates the order the configs open the page in, so drifting load on the box hits
// every config alike. Per config:
//  - open: the last click or key (Enter in the palette) to the frame after the page is drawn,
//    which is its first block in block mode and its last in page mode (ProseMirror renders all);
//  - key p50 / p95: 50 keys typed into the block nearest the middle, each from its event
//    timestamp to the task after the next frame; INP: the worst Event Timing interaction;
//  - scroll: 120 px a frame from top to bottom; long frames are rAF intervals over 50 ms.
// `blocks` is block mode as it opens: `INITIAL_MOUNT_LIMIT` rows mounted and a "Show more" row
// (`use-block-mount-limit.ts`); `blocks-all` clicks it until every row is mounted.
// Prints median [min–max] over the repeats. Xvfb rasterizes in software, so read frame times
// against the other configs in the same run, never as absolute numbers; read a difference
// whose ranges overlap as none.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'

import { remote } from 'webdriverio'

const SIZES = (process.env.SIZES ?? '250,500,1000,2000').split(',').map(Number)
const REPEATS = Number(process.env.REPEATS ?? 3)
const CONFIGS = (process.env.CONFIGS ?? 'blocks,blocks-all,page').split(',')
const PORT = Number(process.env.PORT ?? 5316)
const WD_PORT = Number(process.env.WD_PORT ?? 4446)
const ORIGIN = `http://localhost:${PORT}`
const TYPED = ' the quick brown fox jumps over the lazy dog again'
const PAGE_EDITOR = '[data-testid="page-mode-editor"]'
const MINIBROWSER = '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser'

if (CONFIGS.some((c) => c.endsWith('+css')) && !process.env.CSS) {
  throw new Error('a +css config needs CSS')
}

const preview = spawn(
  'node_modules/.bin/vite',
  ['preview', '--port', String(PORT), '--strictPort'],
  {
    stdio: ['ignore', 'pipe', 'inherit'],
  },
)
const children = [preview, spawn('WebKitWebDriver', [`--port=${WD_PORT}`], { stdio: 'ignore' })]
process.on('exit', () => {
  for (const child of children) child.kill()
})
// Its own banner, not a fetch: a server already on PORT answers a fetch while `--strictPort`
// makes this one exit, and the run would measure that server.
await new Promise((resolve, reject) => {
  preview.stdout.on('data', (chunk) => {
    if (String(chunk).includes('Local:')) resolve()
  })
  preview.on('exit', (code) => reject(new Error(`vite preview on ${ORIGIN} exited (${code})`)))
})

const browser = await remote({
  hostname: 'localhost',
  port: WD_PORT,
  path: '/',
  logLevel: 'error',
  strictSelectors: false,
  connectionRetryTimeout: 600_000,
  capabilities: {
    'wdio:enforceWebDriverClassic': true,
    'webkitgtk:browserOptions': { binary: MINIBROWSER, args: ['--automation'] },
  },
})
const $ = (s) => browser.$(s)
const pause = (ms) => browser.pause(ms)
const sidebar = (label) => $('[data-slot="sidebar"]').$(`button=${label}`)

function seed(size, title) {
  return browser.execute(
    (n, pageTitle) => {
      const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args)
      const words =
        'lorem ipsum dolor sit amet project meeting idea review draft notes plan ship'.split(' ')
      const sentence = (i, len) =>
        Array.from({ length: len }, (_, k) => words[(i + k * 7) % words.length]).join(' ')
      const content = (i) => {
        if (i % 40 === 17) {
          return `\`\`\`ts\nconst total = items.reduce((a, b) => a + b, 0)\nfunction f(x: number) {\n  return x * ${i}\n}\n\`\`\``
        }
        if (i % 25 === 5) return `## Section ${i}`
        const extra = i % 6 === 0 ? ' with **bold** and `code`' : ''
        return `${sentence(i, 6 + ((i * 13) % 40))}${extra}.`
      }
      return (async () => {
        const parentId = await invoke('create_page_in_space', {
          parentId: null,
          content: pageTitle,
          spaceId: 'SPACE_PERSONAL',
        })
        const created = await invoke('create_blocks_batch', {
          specs: Array.from({ length: n }, (_, i) => ({
            blockType: 'content',
            content: content(i),
            parentId,
            position: null,
          })),
        })
        const ids = created.blocks.map((b) => b.id)
        await invoke('set_todo_state_batch', {
          blockIds: ids.filter((_, i) => i % 8 === 3 && i % 16 !== 11),
          state: 'TODO',
        })
        await invoke('set_todo_state_batch', {
          blockIds: ids.filter((_, i) => i % 16 === 11),
          state: 'DONE',
        })
        return ids.length
      })()
    },
    size,
    title,
  )
}

/** Choose the editing mode as the switch does, and add or drop the experiment's stylesheet. */
async function prepare(config) {
  await browser.execute(
    (mode, css) => {
      const oldValue = localStorage.getItem('agaric-edit-mode')
      localStorage.setItem('agaric-edit-mode', mode)
      dispatchEvent(
        new StorageEvent('storage', { key: 'agaric-edit-mode', oldValue, newValue: mode }),
      )
      document.querySelector('style[data-probe-css]')?.remove()
      if (css) {
        const style = document.createElement('style')
        style.setAttribute('data-probe-css', '')
        style.textContent = css
        document.head.append(style)
      }
    },
    config.startsWith('page') ? 'page' : 'blocks',
    config.endsWith('+css') ? process.env.CSS : '',
  )
}

/** Open `title` from the palette; resolves with the time from the last click or key to the frame after `ready` appears. */
async function open(title, ready) {
  await browser.execute((sel) => {
    let t0 = 0
    const mark = () => {
      t0 = performance.now()
    }
    addEventListener('click', mark, true)
    addEventListener('keydown', mark, true)
    window.__ready__ = null
    new MutationObserver((_, observer) => {
      if (t0 === 0 || !document.querySelector(sel)) return
      observer.disconnect()
      removeEventListener('click', mark, true)
      removeEventListener('keydown', mark, true)
      requestAnimationFrame(() =>
        setTimeout(() => {
          window.__ready__ = performance.now() - t0
        }),
      )
    }).observe(document, { childList: true, subtree: true })
  }, ready)
  await browser.keys(['Escape'])
  await browser.keys(['Control', 'k'])
  const input = $('[cmdk-input]')
  await input.waitForDisplayed({ timeout: 10_000 })
  await input.setValue(title)
  await $(`[cmdk-item]*=${title}`).waitForDisplayed({ timeout: 20_000 })
  await pause(300)
  await browser.keys(['Enter'])
  let ms = null
  await browser.waitUntil(
    async () => {
      ms = await browser.execute(() => window.__ready__)
      return ms !== null
    },
    { timeout: 300_000, interval: 100 },
  )
  return ms
}

/** Tag the page's scroll container, so the scripts after this find it. */
function tagScroller(mode) {
  return browser.execute((m) => {
    let el = document.querySelector(
      m === 'page' ? '[data-page-block]' : '[data-testid="block-static"]',
    )
    while (el) {
      const oy = getComputedStyle(el).overflowY
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 10) break
      el = el.parentElement
    }
    el?.setAttribute('data-probe-scroller', '')
    return el !== null
  }, mode)
}

function scrollThrough() {
  return browser.execute(
    () =>
      new Promise((done) => {
        const el = document.querySelector('[data-probe-scroller]')
        el.scrollTop = 0
        const deltas = []
        let last = 0
        let stall = 0
        const step = (now) => {
          if (last) deltas.push(now - last)
          last = now
          const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
          stall = atEnd ? stall + 1 : 0
          // A second at the end, for rows that mount as the end nears.
          if (stall > 60 || deltas.length > 6000) {
            done({
              frames: deltas.length,
              long: deltas.filter((d) => d > 50).length,
              worst: Math.max(0, ...deltas),
              median: deltas.toSorted((a, b) => a - b)[Math.floor(deltas.length / 2)] ?? 0,
            })
            return
          }
          el.scrollTop += 120
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      }),
  )
}

/** Scroll to the middle and tag the text block nearest the viewport's centre. */
async function tagMiddleBlock(mode) {
  await browser.execute(() => {
    const el = document.querySelector('[data-probe-scroller]')
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2
  })
  await pause(800)
  return browser.execute((m) => {
    const box = document.querySelector('[data-probe-scroller]').getBoundingClientRect()
    const mid = box.top + box.height / 2
    const rows = document.querySelectorAll(
      m === 'page' ? '[data-page-block]:not([data-rendered])' : '[data-testid="block-static"]',
    )
    let best = null
    let bestDistance = Infinity
    for (const row of rows) {
      if (row.querySelector('pre')) continue
      const r = row.getBoundingClientRect()
      const distance = Math.abs(r.top + r.height / 2 - mid)
      if (r.height > 0 && distance < bestDistance) {
        bestDistance = distance
        best = row
      }
    }
    best?.setAttribute('data-probe-target', '')
    return best !== null
  }, mode)
}

/** Type TYPED a key at a time; each key's latency, and the worst interaction. */
async function typeMeasured() {
  await browser.execute(() => {
    const probe = { keys: [], events: [] }
    window.__typing__ = probe
    probe.observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.interactionId) probe.events.push(e.duration)
    })
    probe.observer.observe({ type: 'event', durationThreshold: 16 })
    probe.listener = (event) => {
      requestAnimationFrame(() =>
        setTimeout(() => probe.keys.push(performance.now() - event.timeStamp)),
      )
    }
    addEventListener('keydown', probe.listener, true)
  })
  for (const ch of TYPED) {
    await browser.keys([ch])
    await pause(100)
  }
  await pause(1000)
  return browser.execute((typed) => {
    const probe = window.__typing__
    removeEventListener('keydown', probe.listener, true)
    probe.observer.disconnect()
    const focused = document.activeElement?.closest('[contenteditable="true"]')
    return {
      keys: probe.keys,
      inp: Math.max(0, ...probe.events),
      landed: (focused?.textContent ?? '').includes(typed.trim()),
    }
  }, TYPED)
}

function quantile(values, q) {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN
}

async function measure(config, size, title) {
  const mode = config.startsWith('page') ? 'page' : 'blocks'
  await sidebar('Tags').click()
  await $('[data-testid^="tag-item-"]').waitForExist({ timeout: 30_000 })
  await prepare(config)
  const ready =
    mode === 'page'
      ? `${PAGE_EDITOR} > [data-page-block]:nth-child(${size})`
      : '[data-testid="block-static"]'
  const openMs = await open(title, ready)
  await pause(1500)
  const showMore = '[data-testid="block-tree-mount-boundary"] button'
  while (config === 'blocks-all' && (await $(showMore).isExisting())) {
    await $(showMore).click()
    await pause(1500)
  }
  if (!(await tagScroller(mode))) throw new Error(`${config} ${size}: no scroll container`)
  const scroll = await scrollThrough()
  if (!(await tagMiddleBlock(mode))) throw new Error(`${config} ${size}: no block mid-page`)
  await $('[data-probe-target]').click()
  await browser.keys(['End'])
  await pause(500)
  const typing = await typeMeasured()
  if (!typing.landed || typing.keys.length !== TYPED.length) {
    throw new Error(`${config} ${size}: typing did not land (${typing.keys.length} keys)`)
  }
  await browser.keys(['Escape'])
  await pause(1500)
  return {
    config,
    size,
    load1: loadavg()[0],
    openMs,
    keyP50: quantile(typing.keys, 0.5),
    keyP95: quantile(typing.keys, 0.95),
    inp: typing.inp,
    scrollLong: scroll.long,
    scrollWorst: scroll.worst,
    scrollMedianFrame: scroll.median,
    scrollFrames: scroll.frames,
  }
}

const samples = []
try {
  await browser.setWindowSize(1280, 900)
  await browser.setTimeout({ script: 600_000 })
  await browser.url(ORIGIN)
  await browser.execute(() => {
    localStorage.setItem('agaric-onboarding-done', 'true')
    localStorage.setItem('agaric-gesture-coachmark-seen', 'true')
  })
  for (const size of SIZES) {
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      await browser.url(ORIGIN)
      await sidebar('Journal').waitForClickable({ timeout: 30_000 })
      await sidebar('Journal').click()
      await $('[data-testid="block-static"]').waitForExist({ timeout: 30_000 })
      await browser.execute(() => {
        window.__pageModeBlockCap = 100_000
      })
      const title = `Cap probe ${size} r${repeat}`
      const seeded = await seed(size, title)
      if (seeded !== size) throw new Error(`seeded ${seeded} of ${size} blocks`)
      const k = repeat % CONFIGS.length
      for (const config of [...CONFIGS.slice(k), ...CONFIGS.slice(0, k)]) {
        const sample = await measure(config, size, title)
        samples.push(sample)
        console.log(JSON.stringify(sample))
      }
    }
  }
} finally {
  await browser.deleteSession()
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(samples, null, 2))
}

const band = (values) => {
  const sorted = values.toSorted((a, b) => a - b)
  const r = (v) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10)
  return `${r(quantile(sorted, 0.5))} [${r(sorted[0])}–${r(sorted.at(-1))}]`
}
const metrics = {
  'open, ms': (s) => s.openMs,
  'key p50, ms': (s) => s.keyP50,
  'key p95, ms': (s) => s.keyP95,
  'INP typing, ms': (s) => s.inp,
  'scroll long frames': (s) => s.scrollLong,
  'scroll worst frame, ms': (s) => s.scrollWorst,
  'scroll median frame, ms': (s) => s.scrollMedianFrame,
  'load average': (s) => s.load1,
}
console.log(`\nWebKitGTK, ${REPEATS} repeats: median [min–max]`)
console.table(
  Object.fromEntries(
    SIZES.flatMap((size) =>
      CONFIGS.map((config) => {
        const runs = samples.filter((s) => s.size === size && s.config === config)
        const row = Object.entries(metrics).map(([name, pick]) => [name, band(runs.map(pick))])
        return [`${config} ${size}`, Object.fromEntries(row)]
      }),
    ),
  ),
)
process.exit(0)
