#!/usr/bin/env node
// Runner-slot and cache report from the GitHub Actions API (#5853): re-measure
// after any change to what CI runs or caches, and compare against the last
// report instead of guessing.
//
//   node scripts/ci-capacity-report.mjs [--since 6h] [--until <ISO>] [--max-logs 150]
//                                       [--log-jobs <regex>] [--repo owner/name] [--json]
//
// --since takes an ISO timestamp or a relative `<N>h` / `<N>d` (default 6h).
// Reads through `gh`, so it needs a logged-in `gh` and nothing else. It reports:
//
// - Peak concurrent jobs: the most jobs running at one instant, across every
//   workflow in the window (the plan's concurrency cap counts all of them), and
//   the most jobs waiting for a slot at one instant.
// - Queue wait per event (`pull_request`, `push`, ...): median, p90 and max of
//   a job's `started_at - created_at`. A job is created when its `needs` are
//   met, so this is the time it waited for a runner slot.
// - Cache restores per key: hit (exact key), partial (a restore-key prefix
//   match) and miss, split into PR and main runs. Read from the job logs of the
//   newest `--max-logs` jobs that ran whose name matches `--log-jobs` (all by
//   default; `--log-jobs 'lint|cargo-tests|mcp-tests|build|e2e'` reaches
//   further back for the Rust keys), because the API records no restore
//   outcome. Keys are shown without their trailing lockfile/content hashes, so
//   every generation of a key counts as that key.
// - Cache inventory: each key's live entries in `main`'s scope and in PR
//   scopes, with their size, against the repo's total usage.
//
// Cost: one API request per workflow run in the window, plus one per log
// read, against the 5,000 an hour the account shares with every other `gh`
// call (a 9-hour window here was ~650 runs). The runs API returns at most 1000
// runs per query; a window that busy is reported as truncated rather than
// silently undercounted. A job log GitHub no longer has (404) is reported on
// stderr and contributes no restores.

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

const LOG_FETCH_CONCURRENCY = 8
const RUNS_API_CAP = 1000

async function gh(args) {
  const { stdout } = await run('gh', args, { maxBuffer: 256 * 1024 * 1024 })
  return stdout
}

/** `gh api --paginate` with a jq filter that emits one `@json` string per item. */
async function ghItems(path, jq) {
  const out = await gh(['api', '--paginate', path, '--jq', `${jq} | @json`])
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

export function parseSince(value, now = Date.now()) {
  const rel = /^(\d+)([hd])$/.exec(value)
  if (rel) return new Date(now - Number(rel[1]) * (rel[2] === 'h' ? 3_600_000 : 86_400_000))
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`not a time or <N>h/<N>d: ${value}`)
  return date
}

/** Nearest-rank percentile of an unsorted list; `undefined` when it is empty. */
export function percentile(values, p) {
  if (values.length === 0) return undefined
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

/**
 * The most intervals open at one instant, and when. An interval is
 * `[start, end)` in ms; one that ends as another starts does not overlap it.
 */
export function peakOverlap(intervals) {
  const edges = []
  for (const [start, end] of intervals) {
    if (end <= start) continue
    edges.push([start, 1], [end, -1])
  }
  let open = 0
  let peak = 0
  let at
  // Ends sort before starts at the same instant.
  for (const [time, delta] of edges.toSorted((a, b) => a[0] - b[0] || a[1] - b[1])) {
    open += delta
    if (open > peak) {
      peak = open
      at = time
    }
  }
  return { peak, at }
}

/** A cache key without its trailing content hashes, so generations group together. */
export function keyFamily(key) {
  // Swatinem/rust-cache: v0-rust-<shared-key>-<os>-<arch>-<env hash>-<lock hash>.
  if (key.startsWith('v0-rust-')) return key.replace(/(-[0-9a-f]{8}){2}$/, '')
  // actions/cache, setup-node, CodeQL: <prefix>-<sha1 or sha256 of the inputs>.
  return key.replace(/-[0-9a-f]{32,}$/, '')
}

/**
 * Every cache restore in one job log, as `{ family, outcome, sizeMb }`, where
 * outcome is `hit` (exact key), `partial` (restore-key prefix) or `miss`.
 *
 * Swatinem/rust-cache prints `Cache Key:` with the key on the next line, then
 * `Restored from cache key "…" full match: true|false.` or `No cache found.`
 * actions/cache echoes its `key:` input, then `Cache restored from key: …` or
 * `Cache not found for input keys: …`; setup-node prints the restore line with
 * no `key:` input, so its restores count as hits.
 */
export function parseCacheRestores(log) {
  const restores = []
  let rustKey
  let requestedKey
  let sizeMb
  let expectRustKey = false
  for (const raw of log.split('\n')) {
    const line = raw.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '').trimEnd()
    if (expectRustKey) {
      rustKey = line.trim()
      expectRustKey = false
      continue
    }
    if (line === 'Cache Key:') {
      expectRustKey = true
      continue
    }
    if (line.startsWith('##[group]Run ')) {
      requestedKey = undefined
      sizeMb = undefined
      continue
    }
    let m = /^ {2}key: (\S+)$/.exec(line)
    if (m) {
      requestedKey = m[1]
      continue
    }
    m = /^Cache Size: ~(\d+) MB/.exec(line)
    if (m) {
      sizeMb = Number(m[1])
      continue
    }
    m = /^Restored from cache key "([^"]+)" full match: (true|false)\.$/.exec(line)
    if (m) {
      restores.push({
        family: keyFamily(rustKey ?? m[1]),
        outcome: m[2] === 'true' ? 'hit' : 'partial',
        sizeMb,
      })
      rustKey = undefined
      continue
    }
    if (line === 'No cache found.' && rustKey !== undefined) {
      restores.push({ family: keyFamily(rustKey), outcome: 'miss', sizeMb: undefined })
      rustKey = undefined
      continue
    }
    m = /^Cache restored from key: (\S+)$/.exec(line)
    if (m) {
      const exact = requestedKey === undefined || requestedKey === m[1]
      restores.push({
        family: keyFamily(requestedKey ?? m[1]),
        outcome: exact ? 'hit' : 'partial',
        sizeMb,
      })
      continue
    }
    m = /^Cache not found for input keys: ([^,\s]+)/.exec(line)
    if (m) restores.push({ family: keyFamily(m[1]), outcome: 'miss', sizeMb: undefined })
  }
  return restores
}

function parseArgs(argv) {
  const args = {
    since: '6h',
    until: undefined,
    maxLogs: 150,
    logJobs: /./,
    repo: undefined,
    json: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--since') args.since = argv[++i]
    else if (a === '--until') args.until = argv[++i]
    else if (a === '--max-logs') args.maxLogs = Number(argv[++i])
    else if (a === '--log-jobs') args.logJobs = new RegExp(argv[++i])
    else if (a === '--repo') args.repo = argv[++i]
    else if (a === '--json') args.json = true
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!Number.isInteger(args.maxLogs) || args.maxLogs < 0) {
    throw new Error('--max-logs takes a whole number')
  }
  return args
}

async function mapPool(items, limit, fn) {
  const results = Array.from({ length: items.length })
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const ms = (iso) => new Date(iso).getTime()
const eventBucket = (event, branch) =>
  event === 'push' && branch === 'main' ? 'main' : event === 'pull_request' ? 'pr' : event

function summarizeWaits(jobs) {
  const byEvent = {}
  for (const job of jobs) {
    const wait = (ms(job.started_at) - ms(job.created_at)) / 1000
    ;(byEvent[job.bucket] ??= []).push(wait)
  }
  return Object.fromEntries(
    Object.entries(byEvent).map(([bucket, waits]) => [
      bucket,
      {
        jobs: waits.length,
        medianS: percentile(waits, 50),
        p90S: percentile(waits, 90),
        maxS: Math.max(...waits),
      },
    ]),
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const repo =
    args.repo ??
    (await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).trim()
  const since = parseSince(args.since)
  const until = args.until === undefined ? new Date() : parseSince(args.until)
  const window = `${since.toISOString()}..${until.toISOString()}`

  // Runs created while paging shift the pages, so one run can come back twice.
  const runs = [
    ...new Map(
      (
        await ghItems(
          `repos/${repo}/actions/runs?per_page=100&created=${encodeURIComponent(window)}`,
          '.workflow_runs[] | {id, name, event, head_branch}',
        )
      ).map((r) => [r.id, r]),
    ).values(),
  ]
  const jobLists = await mapPool(runs, LOG_FETCH_CONCURRENCY, (r) =>
    ghItems(
      `repos/${repo}/actions/runs/${r.id}/jobs?per_page=100&filter=all`,
      '.jobs[] | {id, name, status, conclusion, created_at, started_at, completed_at, runner_name}',
    ),
  )
  const now = Date.now()
  // `filter=all` lists every attempt, and a re-run copies the jobs it does not
  // re-run into the new attempt under new ids, with the original runner and
  // times. A hosted runner serves one job, so the runner names the job.
  const jobsByRunner = new Map()
  for (const [i, jobs] of jobLists.entries()) {
    for (const job of jobs) {
      const key = job.runner_name ? `${job.runner_name}|${job.started_at}` : job.id
      // The original holds the log; the copy's log 404s.
      if ((jobsByRunner.get(key)?.id ?? Infinity) < job.id) continue
      jobsByRunner.set(key, { ...job, bucket: eventBucket(runs[i].event, runs[i].head_branch) })
    }
  }
  const allJobs = [...jobsByRunner.values()]
  // A job took a slot only once a runner picked it up. GitHub stamps
  // `started_at` on skipped and still-queued jobs too, so that alone says nothing.
  const ranJobs = allJobs.filter(
    (j) => j.runner_name && j.status !== 'queued' && j.status !== 'waiting',
  )

  const running = peakOverlap(
    ranJobs.map((j) => [ms(j.started_at), j.completed_at === null ? now : ms(j.completed_at)]),
  )
  const waiting = peakOverlap(
    allJobs
      .filter((j) => j.conclusion !== 'skipped')
      // A job cancelled while queued waited until it completed.
      .map((j) => [
        ms(j.created_at),
        j.runner_name ? ms(j.started_at) : j.completed_at === null ? now : ms(j.completed_at),
      ]),
  )

  const logJobs = ranJobs
    .filter((j) => j.completed_at !== null && args.logJobs.test(j.name))
    .toSorted((a, b) => ms(b.started_at) - ms(a.started_at))
    .slice(0, args.maxLogs)
  const logs = await mapPool(logJobs, LOG_FETCH_CONCURRENCY, async (job) => {
    try {
      return await gh(['api', `repos/${repo}/actions/jobs/${job.id}/logs`])
    } catch (err) {
      // Logs expire; a job without one contributes no restores, and says so.
      process.stderr.write(
        `no log for job ${job.id} (${job.name}): ${err.message.split('\n')[0]}\n`,
      )
      return ''
    }
  })
  const restores = {}
  for (const [i, log] of logs.entries()) {
    for (const r of parseCacheRestores(log)) {
      const row = (restores[r.family] ??= {})
      const cell = (row[logJobs[i].bucket] ??= { hit: 0, partial: 0, miss: 0, sizesMb: [] })
      cell[r.outcome]++
      if (r.sizeMb !== undefined) cell.sizesMb.push(r.sizeMb)
    }
  }

  const caches = await ghItems(
    `repos/${repo}/actions/caches?per_page=100`,
    '.actions_caches[] | {key, ref, size_in_bytes}',
  )
  const usage = JSON.parse(await gh(['api', `repos/${repo}/actions/cache/usage`]))
  const inventory = {}
  for (const c of caches) {
    const row = (inventory[keyFamily(c.key)] ??= { main: { n: 0, mb: 0 }, pr: { n: 0, mb: 0 } })
    const cell = c.ref === 'refs/heads/main' ? row.main : row.pr
    cell.n++
    cell.mb += c.size_in_bytes / 1_048_576
  }

  const report = {
    repo,
    window,
    runs: runs.length,
    truncated: runs.length >= RUNS_API_CAP,
    jobsRan: ranJobs.length,
    peakRunning: { jobs: running.peak, at: running.at && new Date(running.at).toISOString() },
    peakWaiting: { jobs: waiting.peak, at: waiting.at && new Date(waiting.at).toISOString() },
    queueWait: summarizeWaits(ranJobs),
    logsRead: logJobs.length,
    restores,
    inventory,
    cacheUsageMb: Math.round(usage.active_caches_size_in_bytes / 1_048_576),
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  printReport(report)
}

function printReport(r) {
  const out = (s = '') => process.stdout.write(`${s}\n`)
  const min = (s) => (s === undefined ? '-' : `${(s / 60).toFixed(1)}m`)
  out(`${r.repo}  ${r.window}`)
  out(
    `${r.runs} runs${r.truncated ? ' (TRUNCATED at the runs API cap: narrow the window)' : ''}, ${r.jobsRan} jobs ran`,
  )
  out(`peak running: ${r.peakRunning.jobs} jobs at ${r.peakRunning.at ?? '-'}`)
  out(`peak waiting: ${r.peakWaiting.jobs} jobs at ${r.peakWaiting.at ?? '-'}`)
  out()
  out('queue wait (started_at - created_at)')
  out('event   jobs  median  p90     max')
  for (const [bucket, w] of Object.entries(r.queueWait)) {
    out(
      `${bucket.padEnd(8)}${String(w.jobs).padEnd(6)}${min(w.medianS).padEnd(8)}${min(w.p90S).padEnd(8)}${min(w.maxS)}`,
    )
  }
  out()
  out(`cache restores, from the newest ${r.logsRead} job logs (hit/partial/miss)`)
  out(
    'key                                         pr            main          restored MB (median)',
  )
  const fmt = (c) => (c === undefined ? '-' : `${c.hit}/${c.partial}/${c.miss}`)
  for (const [family, row] of Object.entries(r.restores).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const sizes = [...(row.pr?.sizesMb ?? []), ...(row.main?.sizesMb ?? [])]
    out(
      `${family.padEnd(44)}${fmt(row.pr).padEnd(14)}${fmt(row.main).padEnd(14)}${percentile(sizes, 50) ?? '-'}`,
    )
  }
  out()
  out(`cache inventory (${r.cacheUsageMb} MB in use)`)
  out('key                                         main: n / MB      pr scopes: n / MB')
  const inv = Object.entries(r.inventory).toSorted(
    (a, b) => b[1].main.mb + b[1].pr.mb - (a[1].main.mb + a[1].pr.mb),
  )
  for (const [family, row] of inv) {
    const cell = (c) => `${c.n} / ${Math.round(c.mb)}`
    out(`${family.padEnd(44)}${cell(row.main).padEnd(18)}${cell(row.pr)}`)
  }
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(`ci-capacity-report: ${err.message}\n`)
    process.exit(1)
  })
}
