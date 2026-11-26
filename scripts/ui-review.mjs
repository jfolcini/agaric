#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// ui-review.mjs — shoot every view and state of the app on a phone and a
// desktop, light and dark, and report what changed against another ref (#7040).
//
//   node scripts/ui-review.mjs                      # shoot this checkout (against the last base)
//   node scripts/ui-review.mjs --base origin/main   # shoot both, report the change
//   node scripts/ui-review.mjs --report-only        # rebuild the report from the shots
//   node scripts/ui-review.mjs --base main -- --grep "phone light"
//   node scripts/ui-review.mjs --report-only --notes notes.json
//
// Each tree is built with the e2e mock (`VITE_E2E=1 vite build`), served by
// `vite preview` on a free port and toured by `e2e/ui-review/ui-review.tour.ts`
// — this checkout's tour for both, so a screen the base lacks shows as new.
// The base is built in a temporary `git worktree` that borrows this checkout's
// node_modules. Arguments after `--` go to `playwright test`.
//
// Output, in `ui-review-out/` (gitignored; `--out` moves it):
//   shots/before|after/<profile>-<theme>/<scene>/<shot>.png   the raw shots
//   report/index.html   every shot, side by side where it changed, with a diff
//
// Under each changed pair the report says in one line what changed: the first
// pattern in the `--notes` JSON file (`{ "<set>/<scene>/<shot>": "<line>" }`,
// `*` matching within one path segment) that matches the shot, or else where
// on the screen the changed pixels are.
// ─────────────────────────────────────────────────────────────────────

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { chromium } from '@playwright/test'

const ROOT = resolve(import.meta.dirname, '..')
const CONFIG = 'e2e/ui-review/playwright.config.ts'
const CLOUD_CHROMIUM = '/opt/pw-browsers/chromium'

function parseArgs(argv) {
  const opts = { base: null, out: 'ui-review-out', notes: null, reportOnly: false, playwright: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      opts.playwright = argv.slice(i + 1)
      break
    }
    if (arg === '--base') opts.base = argv[++i]
    else if (arg === '--out') opts.out = argv[++i]
    else if (arg === '--notes') opts.notes = argv[++i]
    else if (arg === '--report-only') opts.reportOnly = true
    else
      throw new Error(`ui-review: unknown argument ${arg} (arguments for Playwright go after --)`)
  }
  if (opts.base === undefined || opts.out === undefined || opts.notes === undefined) {
    throw new Error('ui-review: --base, --out and --notes each take a value')
  }
  return opts
}

function run(cmd, args, options) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  return result.status ?? 1
}

function must(cmd, args, options) {
  const status = run(cmd, args, options)
  if (status !== 0) throw new Error(`ui-review: ${cmd} ${args.join(' ')} exited ${status}`)
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
      server.close(() => done(port))
    })
  })
}

async function waitForServer(url, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`ui-review: vite preview exited ${child.exitCode}`)
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error(`ui-review: nothing answered at ${url} within a minute`)
}

/** Build the app in `tree` into `dist`, with the e2e mock in the bundle. */
function build(tree, dist) {
  must('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], {
    cwd: tree,
    env: { ...process.env, VITE_E2E: '1' },
  })
}

/** Check `ref` out into a temporary worktree, build it into `dist`, remove the worktree. */
function buildRef(ref, dist) {
  const tree = mkdtempSync(join(tmpdir(), 'agaric-ui-review-'))
  must('git', ['worktree', 'add', '--detach', tree, ref], { cwd: ROOT })
  try {
    symlinkSync(join(ROOT, 'node_modules'), join(tree, 'node_modules'))
    build(tree, dist)
  } finally {
    run('git', ['worktree', 'remove', '--force', tree], { cwd: ROOT })
  }
}

/** Serve `dist`, tour it into `shots`; returns Playwright's exit status. */
async function tour(dist, shots, playwrightArgs) {
  rmSync(shots, { recursive: true, force: true })
  const port = await freePort()
  const server = spawn(
    'npx',
    ['vite', 'preview', '--outDir', dist, '--port', String(port), '--strictPort'],
    { cwd: ROOT, env: { ...process.env, VITE_E2E: '1' }, stdio: 'ignore', detached: true },
  )
  try {
    const url = `http://localhost:${port}`
    await waitForServer(url, server)
    return run('npx', ['playwright', 'test', '-c', CONFIG, ...playwrightArgs], {
      cwd: ROOT,
      env: { ...process.env, UI_REVIEW_URL: url, UI_REVIEW_OUT: shots },
    })
  } finally {
    stop(server)
  }
}

/** Stop `child` and its group: npx's own child is the server. */
function stop(child) {
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ESRCH') throw err
  }
}

/** `<profile>-<theme>/<scene>/<shot>` → { png?, failed? } for one run's shots. */
function readShots(dir) {
  const shots = new Map()
  if (!existsSync(dir)) return shots
  for (const set of readdirSync(dir)) {
    if (set.startsWith('.')) continue
    for (const scene of readdirSync(join(dir, set))) {
      for (const file of readdirSync(join(dir, set, scene))) {
        const failed = file.endsWith('.failed.txt')
        if (!failed && (!file.endsWith('.png') || file.endsWith('.failed.png'))) continue
        const name = file.replace(/\.failed\.txt$|\.png$/, '')
        const key = `${set}/${scene}/${name}`
        const entry = shots.get(key) ?? { set, scene, name }
        if (failed) entry.failed = readFileSync(join(dir, set, scene, file), 'utf8').trim()
        else entry.png = join(dir, set, scene, file)
        shots.set(key, entry)
      }
    }
  }
  return shots
}

/**
 * Runs in the page: decode the two PNGs, count the pixels that differ by more
 * than anti-aliasing does, and return WebP copies plus a diff (the after shot
 * faded, changed pixels red).
 *
 * @param {{ before: string | null, after: string | null }} shots
 */
async function compareInPage({ before, after }) {
  /** @param {string | null} b64 */
  const load = async (b64) => {
    if (!b64) return null
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = /** @type {CanvasRenderingContext2D} */ (
      canvas.getContext('2d', { willReadFrequently: true })
    )
    ctx.drawImage(img, 0, 0)
    return { canvas, ctx }
  }
  /** @param {HTMLCanvasElement} canvas */
  const webp = (canvas) => canvas.toDataURL('image/webp', 0.82).split(',')[1]
  const a = await load(before)
  const b = await load(after)
  /**
   * @type {{
   *   ratio: number | null,
   *   before: string | null | undefined,
   *   after: string | null | undefined,
   *   diff: string | null | undefined,
   *   box: { top: number, bottom: number, left: number, right: number } | null,
   *   sizes: number[][] | null,
   * }}
   */
  const result = {
    ratio: null,
    before: a && webp(a.canvas),
    after: b && webp(b.canvas),
    diff: null,
    box: null,
    sizes: null,
  }
  if (!a || !b) return result
  if (a.canvas.width !== b.canvas.width || a.canvas.height !== b.canvas.height) {
    result.ratio = 1
    result.sizes = [
      [a.canvas.width, a.canvas.height],
      [b.canvas.width, b.canvas.height],
    ]
    return result
  }
  const { width, height } = b.canvas
  const pa = a.ctx.getImageData(0, 0, width, height).data
  const pb = b.ctx.getImageData(0, 0, width, height).data
  const out = b.ctx.createImageData(width, height)
  /** @param {Uint8ClampedArray} data @param {number} i */
  const at = (data, i) => data[i] ?? 0
  let changed = 0
  const box = { top: height, bottom: 0, left: width, right: 0 }
  for (let i = 0; i < pb.length; i += 4) {
    const delta = Math.max(
      Math.abs(at(pa, i) - at(pb, i)),
      Math.abs(at(pa, i + 1) - at(pb, i + 1)),
      Math.abs(at(pa, i + 2) - at(pb, i + 2)),
    )
    if (delta > 24) {
      changed++
      const x = (i / 4) % width
      const y = Math.floor(i / 4 / width)
      box.top = Math.min(box.top, y)
      box.bottom = Math.max(box.bottom, y + 1)
      box.left = Math.min(box.left, x)
      box.right = Math.max(box.right, x + 1)
      out.data.set([230, 30, 40, 255], i)
    } else {
      const grey = (at(pb, i) + at(pb, i + 1) + at(pb, i + 2)) / 3
      const faded = 255 - (255 - grey) * 0.25
      out.data.set([faded, faded, faded, 255], i)
    }
  }
  result.ratio = changed / (width * height)
  if (changed > 0) {
    b.ctx.putImageData(out, 0, 0)
    result.diff = webp(b.canvas)
    result.box = {
      top: box.top / height,
      bottom: box.bottom / height,
      left: box.left / width,
      right: box.right / width,
    }
  } else {
    result.before = null
  }
  return result
}

/** `--notes` as [matcher, line] pairs, in the file's order. */
function readNotes(file) {
  if (file === null) return []
  const notes = JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'))
  return Object.entries(notes).map(([pattern, line]) => {
    const source = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*')
    return [new RegExp(`^${source}$`), String(line)]
  })
}

/** Where on the screen a change is, for a pair nobody wrote a note for. */
function describeChange({ box, sizes }) {
  if (sizes) {
    const [[w0, h0], [w1, h1]] = sizes
    return `The shot's size changed: ${w0}×${h0} → ${w1}×${h1} px.`
  }
  if (!box) return null
  const pct = (f) => Math.round(f * 100)
  let across = 'in the middle'
  if (box.right - box.left > 0.8) across = 'across the width'
  else if (box.left >= 0.5) across = 'on the right'
  else if (box.right <= 0.5) across = 'on the left'
  return `Pixels changed ${pct(box.top)}–${pct(box.bottom)}% down the screen, ${across}.`
}

async function launchBrowser() {
  try {
    return await chromium.launch()
  } catch (err) {
    if (!existsSync(CLOUD_CHROMIUM)) throw err
    return chromium.launch({ executablePath: CLOUD_CHROMIUM })
  }
}

async function writeReport(out, hasBase, notes) {
  const before = hasBase ? readShots(join(out, 'shots', 'before')) : new Map()
  const after = readShots(join(out, 'shots', 'after'))
  const reportDir = join(out, 'report')
  rmSync(reportDir, { recursive: true, force: true })
  mkdirSync(join(reportDir, 'img'), { recursive: true })
  const browser = await launchBrowser()
  const page = await browser.newPage()
  const entries = []
  const keys = [...new Set([...before.keys(), ...after.keys()])].toSorted((x, y) =>
    x < y ? -1 : x > y ? 1 : 0,
  )
  for (const key of keys) {
    const b = before.get(key)
    const a = after.get(key)
    const { set, scene, name } = a ?? b
    const read = (shot) => (shot?.png ? readFileSync(shot.png).toString('base64') : null)
    const cmp = await page.evaluate(compareInPage, { before: read(b), after: read(a) })
    let status
    if (a?.failed) status = 'failed'
    else if (!hasBase) status = 'shot'
    else if (!b?.png) status = 'new'
    else if (!a?.png) status = 'gone'
    else status = (cmp.ratio ?? 0) > 0 ? 'changed' : 'same'
    const stem = `${set}--${scene}--${name}`
    const img = {}
    for (const kind of ['before', 'after', 'diff']) {
      if (!cmp[kind]) continue
      img[kind] = `img/${stem}.${kind}.webp`
      writeFileSync(join(reportDir, img[kind]), Buffer.from(cmp[kind], 'base64'))
    }
    entries.push({
      set,
      scene,
      name,
      status,
      ratio: cmp.ratio,
      img,
      failed: a?.failed ?? null,
      baseFailed: b?.failed ?? null,
      note:
        status === 'changed' || status === 'new'
          ? (notes.find(([re]) => re.test(key))?.[1] ?? null)
          : null,
      where: status === 'changed' ? describeChange(cmp) : null,
    })
  }
  await browser.close()
  const template = readFileSync(join(ROOT, 'e2e/ui-review/report.html'), 'utf8')
  const data = JSON.stringify({ hasBase, entries }).replace(/</g, '\\u003c')
  writeFileSync(join(reportDir, 'index.html'), template.replace('__UI_REVIEW_DATA__', data))
  return entries
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const out = resolve(ROOT, opts.out)
  let status = 0
  if (!opts.reportOnly) {
    mkdirSync(out, { recursive: true })
    if (opts.base !== null) {
      rmSync(join(out, 'shots', 'before'), { recursive: true, force: true })
      console.log(`ui-review: building ${String(opts.base)}`)
      buildRef(opts.base, join(out, 'build', 'before'))
      await tour(join(out, 'build', 'before'), join(out, 'shots', 'before'), opts.playwright)
    }
    console.log('ui-review: building this checkout')
    build(ROOT, join(out, 'build', 'after'))
    status = await tour(join(out, 'build', 'after'), join(out, 'shots', 'after'), opts.playwright)
  }
  // Without `--base`, the base shot last time, if any, stays the comparison.
  const hasBase = existsSync(join(out, 'shots', 'before'))
  const entries = await writeReport(out, hasBase, readNotes(opts.notes))
  const count = (s) => entries.filter((e) => e.status === s).length
  console.log(
    `ui-review: ${entries.length} shots — ${count('changed')} changed, ${count('new')} new, ` +
      `${count('gone')} gone, ${count('failed')} failed, ${count('same')} same`,
  )
  for (const e of entries.filter((x) => x.status === 'failed')) {
    console.log(`  failed: ${e.set}/${e.scene}/${e.name}: ${e.failed.split('\n')[0]}`)
  }
  console.log(`ui-review: report at ${join(out, 'report', 'index.html')}`)
  process.exitCode = status
}

await main()
