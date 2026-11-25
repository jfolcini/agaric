#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// ui-review.mjs — shoot every view and state of the app on a phone and a
// desktop, light and dark, and report what changed against another ref (#7040).
//
//   node scripts/ui-review.mjs                      # shoot this checkout
//   node scripts/ui-review.mjs --base origin/main   # shoot both, report the change
//   node scripts/ui-review.mjs --report-only        # rebuild the report from the shots
//   node scripts/ui-review.mjs --base main -- --grep "phone light"
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
  const opts = { base: null, out: 'ui-review-out', reportOnly: false, playwright: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      opts.playwright = argv.slice(i + 1)
      break
    }
    if (arg === '--base') opts.base = argv[++i]
    else if (arg === '--out') opts.out = argv[++i]
    else if (arg === '--report-only') opts.reportOnly = true
    else
      throw new Error(`ui-review: unknown argument ${arg} (arguments for Playwright go after --)`)
  }
  if (opts.base === undefined || opts.out === undefined) {
    throw new Error('ui-review: --base and --out each take a value')
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
      const { port } = server.address()
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
    if (err.code !== 'ESRCH') throw err
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
 */
async function compareInPage({ before, after }) {
  const load = async (b64) => {
    if (!b64) return null
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    return { canvas, ctx }
  }
  const webp = (canvas) => canvas.toDataURL('image/webp', 0.82).split(',')[1]
  const a = await load(before)
  const b = await load(after)
  const result = {
    ratio: null,
    before: a && webp(a.canvas),
    after: b && webp(b.canvas),
    diff: null,
  }
  if (!a || !b) return result
  if (a.canvas.width !== b.canvas.width || a.canvas.height !== b.canvas.height) {
    result.ratio = 1
    return result
  }
  const { width, height } = b.canvas
  const pa = a.ctx.getImageData(0, 0, width, height).data
  const pb = b.ctx.getImageData(0, 0, width, height).data
  const out = b.ctx.createImageData(width, height)
  let changed = 0
  for (let i = 0; i < pb.length; i += 4) {
    const delta = Math.max(
      Math.abs(pa[i] - pb[i]),
      Math.abs(pa[i + 1] - pb[i + 1]),
      Math.abs(pa[i + 2] - pb[i + 2]),
    )
    if (delta > 24) {
      changed++
      out.data.set([230, 30, 40, 255], i)
    } else {
      const grey = (pb[i] + pb[i + 1] + pb[i + 2]) / 3
      const faded = 255 - (255 - grey) * 0.25
      out.data.set([faded, faded, faded, 255], i)
    }
  }
  result.ratio = changed / (width * height)
  if (changed > 0) {
    b.ctx.putImageData(out, 0, 0)
    result.diff = webp(b.canvas)
  } else {
    result.before = null
  }
  return result
}

async function launchBrowser() {
  try {
    return await chromium.launch()
  } catch (err) {
    if (!existsSync(CLOUD_CHROMIUM)) throw err
    return chromium.launch({ executablePath: CLOUD_CHROMIUM })
  }
}

async function writeReport(out, hasBase) {
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
    else status = cmp.ratio > 0 ? 'changed' : 'same'
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
  const hasBase = opts.base !== null || existsSync(join(out, 'shots', 'before'))
  let status = 0
  if (!opts.reportOnly) {
    mkdirSync(out, { recursive: true })
    rmSync(join(out, 'shots', 'before'), { recursive: true, force: true })
    if (opts.base !== null) {
      console.log(`ui-review: building ${String(opts.base)}`)
      buildRef(opts.base, join(out, 'build', 'before'))
      await tour(join(out, 'build', 'before'), join(out, 'shots', 'before'), opts.playwright)
    }
    console.log('ui-review: building this checkout')
    build(ROOT, join(out, 'build', 'after'))
    status = await tour(join(out, 'build', 'after'), join(out, 'shots', 'after'), opts.playwright)
  }
  const entries = await writeReport(out, opts.base !== null || (opts.reportOnly && hasBase))
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
