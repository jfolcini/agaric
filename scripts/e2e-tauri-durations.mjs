#!/usr/bin/env node
// Rewrite e2e-tauri/spec-durations.json, which wdio.conf.ts deals the
// real-backend shards by: each spec's mean seconds over the last green full
// runs of the e2e-tauri lane, from the RUNNING and PASSED lines the wdio runner
// logs for every spec file. Needs `gh` signed in.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const RUNS = 10
const REPO = 'repos/jfolcini/agaric'
const LINE = /^(\S+Z) \[(0-\d+)\] (RUNNING|PASSED) in \S+ - \S*?(e2e-tauri\/\S+\.e2e\.ts)/

function gh(endpoint) {
  return execFileSync('gh', ['api', endpoint], { encoding: 'utf8', maxBuffer: 1 << 28 })
}

const samples = new Map()
let used = 0
const { workflow_runs: runs } = JSON.parse(
  gh(`${REPO}/actions/workflows/e2e-tauri-weekly.yml/runs?status=success&per_page=100`),
)
for (const run of runs) {
  if (used === RUNS) break
  const { jobs } = JSON.parse(gh(`${REPO}/actions/runs/${run.id}/jobs?per_page=100`))
  const shards = jobs.filter((job) => /^Real-backend specs \(\d+\)$/.test(job.name))
  // A spec-only diff runs one leg with just its specs; only full runs time every spec.
  if (shards.length < 2) continue
  for (const job of shards) {
    const started = new Map()
    for (const line of gh(`${REPO}/actions/jobs/${job.id}/logs`).split('\n')) {
      const match = LINE.exec(line)
      if (match === null) continue
      const [, stamp, worker, state, spec] = match
      if (state === 'RUNNING') {
        started.set(worker, Date.parse(stamp))
        continue
      }
      const seconds = (Date.parse(stamp) - started.get(worker)) / 1000
      samples.set(spec, [...(samples.get(spec) ?? []), seconds])
    }
  }
  used++
}
if (samples.size === 0) throw new Error('no spec timings found in the lane’s recent green runs')

const means = Object.fromEntries(
  [...samples]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([spec, all]) => [
      spec,
      Math.max(1, Math.round(all.reduce((a, b) => a + b) / all.length)),
    ]),
)
writeFileSync('e2e-tauri/spec-durations.json', `${JSON.stringify(means, null, 2)}\n`)
console.log(`${Object.keys(means).length} specs from ${used} runs`)
