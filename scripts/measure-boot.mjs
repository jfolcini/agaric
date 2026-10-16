#!/usr/bin/env node
// Boot timing of release binaries against copies of a real vault, interleaved A/B.
//
// Usage: node scripts/measure-boot.mjs <baseline-dir> <rewind-ops> <rounds> NAME=binary [NAME=binary ...]
//
// <baseline-dir> is a copy of a vault, never the live one: `notes.db` taken with
// `sqlite3 <vault>/notes.db ".backup <dir>/notes.db"` (a consistent copy of a WAL database)
// plus `<vault>/device-id`. Each boot runs on a fresh copy of it with
// `materializer_apply_cursor` rewound by <rewind-ops>, so replay re-applies that many
// already-applied ops, the same work as a real backlog. Rounds alternate the binaries'
// order, so load drift on the box hits every binary alike.
// The first round runs cold (page cache), so read medians over five or more rounds.
//
// Isolation: `AGARIC_E2E_SANDBOX=1` makes a missing or suspicious `AGARIC_DATA_DIR` a boot failure,
// never a fallback to the real vault;
// `unshare -rn` gives it no network, so the copied identity cannot sync with real peers;
// `dbus-run-session` keeps the single-instance plugin from handing off to a running Agaric;
// `xvfb-run` supplies the display.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const [baseline, rewindArg, roundsArg, ...binArgs] = process.argv.slice(2)
const rewind = Number(rewindArg)
const rounds = Number(roundsArg)
if (!baseline || !(rewind > 0) || !(rounds > 0) || binArgs.length === 0) {
  console.error('usage: measure-boot.mjs <baseline-dir> <rewind-ops> <rounds> NAME=binary ...')
  process.exit(2)
}
const bins = binArgs.map((a) => a.split('=', 2))
const device = fs.readFileSync(path.join(baseline, 'device-id'), 'utf8').trim()
const MARKERS = {
  logInit: 'log directory initialized',
  replayEnqueue: 'replay: enqueuing',
  replayDone: 'replay: complete',
  syncStarted: 'SyncDaemon started',
}
const TIMINGS = ['replayMs', 'replayDoneMs', 'syncStartedMs']
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readMarkers(logDir, found) {
  if (!fs.existsSync(logDir)) return
  for (const name of fs.readdirSync(logDir).filter((n) => n.startsWith('agaric.log'))) {
    for (const line of fs.readFileSync(path.join(logDir, name), 'utf8').split('\n')) {
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      const message = rec.fields?.message ?? ''
      for (const [key, marker] of Object.entries(MARKERS)) {
        if (!found[key] && message.includes(marker)) {
          found[key] = { at: Date.parse(rec.timestamp), fields: rec.fields }
        }
      }
    }
  }
}

async function boot(name, binary, round) {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), `measure-boot-${name}-`))
  fs.cpSync(baseline, run, { recursive: true })
  const db = new DatabaseSync(path.join(run, 'notes.db'))
  const { top } = db.prepare('SELECT max(seq) AS top FROM op_log WHERE device_id = ?').get(device)
  db.prepare('UPDATE materializer_apply_cursor SET materialized_through_seq = ? WHERE id = 1').run(
    top - rewind,
  )
  db.close()

  const env = { ...process.env, AGARIC_DATA_DIR: run, AGARIC_E2E_SANDBOX: '1' }
  const args = ['-rn', 'dbus-run-session', '--', 'xvfb-run', '-a', binary]
  const child = spawn('unshare', args, { env, stdio: 'ignore', detached: true })
  const { pid } = child
  if (pid === undefined) throw new Error('could not spawn unshare')
  let exited = false
  child.on('exit', () => {
    exited = true
  })
  const found = {}
  const deadline = Date.now() + 120_000
  while (!exited && Date.now() < deadline) {
    readMarkers(path.join(run, 'logs'), found)
    if (Object.keys(found).length === Object.keys(MARKERS).length) break
    await sleep(200)
  }
  readMarkers(path.join(run, 'logs'), found)
  const stop = (signal) => {
    try {
      process.kill(-pid, signal)
    } catch {
      // The process group has already exited.
    }
  }
  stop('SIGTERM')
  await sleep(2000)
  stop('SIGKILL')
  fs.rmSync(run, { recursive: true, force: true })

  const result = {
    name,
    round,
    missing: Object.keys(MARKERS).filter((k) => !found[k]),
    ops: found.replayEnqueue?.fields.ops_to_replay,
  }
  const t0 = found.logInit?.at
  if (t0 !== undefined && found.replayDone) result.replayDoneMs = found.replayDone.at - t0
  if (t0 !== undefined && found.syncStarted) result.syncStartedMs = found.syncStarted.at - t0
  if (found.replayEnqueue && found.replayDone) {
    result.replayMs = found.replayDone.at - found.replayEnqueue.at
  }
  console.log(JSON.stringify(result))
  return result
}

const results = []
for (let round = 0; round < rounds; round++) {
  for (const [name, binary] of round % 2 === 0 ? bins : bins.toReversed()) {
    results.push(await boot(name, binary, round))
  }
}

const median = (xs) => {
  const s = xs.toSorted((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
console.log(`== rewind=${rewind} rounds=${rounds}`)
for (const [name] of bins) {
  const mine = results.filter((r) => r.name === name)
  const cells = TIMINGS.map((key) => {
    const xs = mine.map((r) => r[key]).filter((x) => x !== undefined)
    if (xs.length === 0) return `${key} none`
    return `${key} median ${median(xs)} [${Math.min(...xs)}..${Math.max(...xs)}] n=${xs.length}`
  })
  console.log(`  ${name} | ${cells.join(' | ')}`)
}
if (results.some((r) => r.missing.length > 0)) process.exit(1)
