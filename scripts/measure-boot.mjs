#!/usr/bin/env node
// Boot timing of release binaries against copies of a vault, interleaved A/B.
//
// Usage: node scripts/measure-boot.mjs <baseline-dir> <rewind-ops> <rounds> NAME=binary [NAME=binary ...]
//
// <baseline-dir> is a copy of a vault, never the live one: `notes.db` taken with
// `sqlite3 <vault>/notes.db ".backup <dir>/notes.db"` (a consistent copy of a WAL database)
// plus `<vault>/device-id`, and optionally the webview's own files from the same directory
// (`localstorage/`, `storage/`, …), which carry the persisted UI state the first render reads.
// Each boot runs on a fresh copy of it with `materializer_apply_cursor` rewound by
// <rewind-ops>, so replay re-applies that many already-applied ops, the same work as a real
// backlog; 0 leaves the cursor alone. Rounds alternate the binaries' order, so load drift on
// the box hits every binary alike. The first round runs cold (page cache), so read medians
// over five or more rounds.
//
// Timings come from the copy's JSON log, measured from `log directory initialized`, plus the
// wrapper's own exec timestamp for the part before the first log line. The end mark is the
// frontend's `boot resolved` line (`src/stores/boot.ts`); every milestone in between is
// reported as a step, the time since the milestone before it.
//
// Isolation: `AGARIC_E2E_SANDBOX=1` makes a missing or suspicious `AGARIC_DATA_DIR` a boot failure,
// never a fallback to the real vault; `XDG_*_HOME` move the webview's data and caches, which
// follow the OS-default app directory, not `AGARIC_DATA_DIR`, into the run directory;
// `unshare -rn` gives it no network, so the copied identity cannot sync with real peers;
// `dbus-run-session` keeps the single-instance plugin from handing off to a running Agaric,
// on a bus that activates no services: GTK's call to the desktop portal otherwise starts
// one that never answers, and the app stalls the 25 s D-Bus timeout before `setup`;
// `xvfb-run` supplies the display, with Wayland stripped and GTK forced to X11 so the window
// cannot open on the user's desktop, and openbox as the window manager.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const [baseline, rewindArg, roundsArg, ...binArgs] = process.argv.slice(2)
const rewind = Number(rewindArg)
const rounds = Number(roundsArg)
if (!baseline || !(rewind >= 0) || !(rounds > 0) || binArgs.length === 0) {
  console.error('usage: measure-boot.mjs <baseline-dir> <rewind-ops> <rounds> NAME=binary ...')
  process.exit(2)
}
const bins = binArgs.map((a) => a.split('=', 2))
const device = fs.readFileSync(path.join(baseline, 'device-id'), 'utf8').trim()

// Boot milestones, matched on the first line whose message starts with `prefix` (the last
// one with `last`). `optional` ones are absent on some boots: no replay at rewind 0, no
// recovered drafts, a link backfill that already ran.
const MILESTONES = [
  { key: 'logInit', prefix: 'log directory initialized' },
  { key: 'poolsOpen', prefix: 'boot: read pool open' },
  { key: 'identityLoaded', prefix: 'sync endpoint identity loaded' },
  { key: 'rehydrated', prefix: 'loro: rehydrated per-space' },
  { key: 'replayEnqueued', prefix: 'replay: enqueuing', optional: true },
  { key: 'replayDone', prefix: 'replay: complete', optional: true },
  { key: 'recoveryDone', prefix: 'recovery completed' },
  { key: 'spacesBootstrapped', prefix: 'spaces bootstrap complete' },
  { key: 'sweepDone', prefix: 'empty-block sweep complete' },
  { key: 'repairsDone', prefix: 'content repair complete', last: true },
  { key: 'bootstrapDone', prefix: 'boot: space bootstrap, sweep and repairs done' },
  { key: 'syncStarted', prefix: 'SyncDaemon started' },
  { key: 'bootResolved', prefix: 'boot resolved', target: 'frontend' },
]
// Headline spans: from log start to each mark, and the frontend's own part.
const SPANS = {
  rehydratedMs: ['logInit', 'rehydrated'],
  replayMs: ['replayEnqueued', 'replayDone'],
  replayDoneMs: ['logInit', 'replayDone'],
  syncStartedMs: ['logInit', 'syncStarted'],
  bootResolvedMs: ['logInit', 'bootResolved'],
  frontendMs: ['syncStarted', 'bootResolved'],
  execToLogMs: ['exec', 'logInit'],
}
// The wrapper inside the display: refuse a leaked Wayland socket, wait for openbox to own the
// screen, stamp the exec time, then become the app.
const WRAPPER = `set -eu
[ -z "\${WAYLAND_DISPLAY:-}" ] && [ -z "\${WAYLAND_SOCKET:-}" ] || { echo 'Wayland leaked into the run' >&2; exit 3; }
openbox >/dev/null 2>&1 &
for _ in $(seq 100); do
  xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id' && break
  sleep 0.05
done
xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id' || { echo 'openbox did not start' >&2; exit 3; }
date +%s%3N > "$1"
exec "$2"`
const BUS_CONFIG = `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readMilestones(logDir) {
  const found = {}
  if (!fs.existsSync(logDir)) return found
  for (const name of fs.readdirSync(logDir).filter((n) => n.startsWith('agaric.log'))) {
    for (const line of fs.readFileSync(path.join(logDir, name), 'utf8').split('\n')) {
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      const message = rec.fields?.message ?? ''
      for (const m of MILESTONES) {
        if (found[m.key] && !m.last) continue
        if (!message.startsWith(m.prefix) || (m.target && rec.target !== m.target)) continue
        found[m.key] = { at: Date.parse(rec.timestamp), fields: rec.fields }
      }
    }
  }
  return found
}

async function boot(name, binary, round) {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), `measure-boot-${name}-`))
  const vault = path.join(run, 'vault')
  fs.cpSync(baseline, vault, { recursive: true })
  if (rewind > 0) {
    const db = new DatabaseSync(path.join(vault, 'notes.db'))
    const { top } = db.prepare('SELECT max(seq) AS top FROM op_log WHERE device_id = ?').get(device)
    db.prepare(
      'UPDATE materializer_apply_cursor SET materialized_through_seq = ? WHERE id = 1',
    ).run(top - rewind)
    db.close()
  }
  // The webview keeps its files in the OS-default app directory, which sat beside `notes.db`
  // when the baseline was copied, so point that directory at the vault copy.
  for (const sub of ['xdg-data', 'xdg-config', 'xdg-state', 'xdg-cache']) {
    fs.mkdirSync(path.join(run, sub))
  }
  fs.symlinkSync(vault, path.join(run, 'xdg-data', 'com.agaric.app'))

  const env = {
    ...process.env,
    AGARIC_DATA_DIR: vault,
    AGARIC_E2E_SANDBOX: '1',
    XDG_DATA_HOME: path.join(run, 'xdg-data'),
    XDG_CONFIG_HOME: path.join(run, 'xdg-config'),
    XDG_STATE_HOME: path.join(run, 'xdg-state'),
    XDG_CACHE_HOME: path.join(run, 'xdg-cache'),
    GDK_BACKEND: 'x11',
    XDG_SESSION_TYPE: 'x11',
  }
  delete env.WAYLAND_DISPLAY
  delete env.WAYLAND_SOCKET
  const execFile = path.join(run, 'exec-ms')
  const busConfig = path.join(run, 'session-bus.conf')
  fs.writeFileSync(busConfig, BUS_CONFIG)
  const args = ['-rn', 'xvfb-run', '-a', 'dbus-run-session', `--config-file=${busConfig}`, '--']
  args.push('bash', '-c', WRAPPER, 'wrapper', execFile, binary)
  const stderr = fs.openSync(path.join(run, 'stderr.log'), 'w')
  const child = spawn('unshare', args, { env, stdio: ['ignore', 'ignore', stderr], detached: true })
  const { pid } = child
  if (pid === undefined) throw new Error('could not spawn unshare')
  let exited = false
  child.on('exit', () => {
    exited = true
  })
  const logDir = path.join(vault, 'logs')
  const deadline = Date.now() + 120_000
  while (!exited && Date.now() < deadline && !readMilestones(logDir).bootResolved) {
    await sleep(200)
  }
  // Let the async sync-daemon line land if it trails the frontend.
  await sleep(500)
  const found = readMilestones(logDir)
  if (fs.existsSync(execFile)) {
    found.exec = { at: Number(fs.readFileSync(execFile, 'utf8').trim()) }
  }
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
  fs.closeSync(stderr)
  const missing = MILESTONES.filter((m) => !m.optional && !found[m.key]).map((m) => m.key)
  if (missing.length > 0) {
    const tail = fs.readFileSync(path.join(run, 'stderr.log'), 'utf8').split('\n').slice(-15)
    console.error(`${name} round ${round}: stderr tail\n${tail.join('\n')}`)
  }
  fs.rmSync(run, { recursive: true, force: true })

  const result = {
    name,
    round,
    missing,
    ops: found.replayEnqueued?.fields.ops_to_replay,
    outcome: found.bootResolved && JSON.parse(found.bootResolved.fields.data || '{}').outcome,
  }
  for (const [key, [from, to]] of Object.entries(SPANS)) {
    if (found[from] && found[to]) result[key] = found[to].at - found[from].at
  }
  // Each milestone's step is the time since the milestone logged just before it.
  const ordered = MILESTONES.filter((m) => found[m.key]).toSorted(
    (a, b) => found[a.key].at - found[b.key].at,
  )
  result.steps = {}
  for (let i = 1; i < ordered.length; i++) {
    const [prev, cur] = [ordered[i - 1].key, ordered[i].key]
    result.steps[`${prev}->${cur}`] = found[cur].at - found[prev].at
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
const cell = (label, xs) =>
  xs.length === 0
    ? `${label} none`
    : `${label} median ${median(xs)} [${Math.min(...xs)}..${Math.max(...xs)}] n=${xs.length}`
console.log(`== rewind=${rewind} rounds=${rounds}`)
for (const [name] of bins) {
  const mine = results.filter((r) => r.name === name)
  console.log(`  ${name}`)
  for (const key of Object.keys(SPANS)) {
    console.log(
      `    ${cell(
        key,
        mine.map((r) => r[key]).filter((x) => x !== undefined),
      )}`,
    )
  }
  console.log('    steps:')
  const stepKeys = [...new Set(mine.flatMap((r) => Object.keys(r.steps)))]
  for (const key of stepKeys) {
    console.log(
      `      ${cell(
        key,
        mine.map((r) => r.steps[key]).filter((x) => x !== undefined),
      )}`,
    )
  }
}
if (results.some((r) => r.missing.length > 0 || r.outcome !== 'ready')) process.exit(1)
