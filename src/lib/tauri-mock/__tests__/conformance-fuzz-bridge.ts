/**
 * #4669 — the mock end of the differential-fuzz lane.
 *
 * The Rust lane (`src-tauri/tests/command_integration/conformance_fuzz.rs`)
 * generates an op chain with the materializer proptest generator, renders it as
 * a conformance fixture, replays it against the REAL backend, and needs the
 * mock's snapshot of the SAME fixture to compare against. A long-lived child
 * process is what makes that affordable inside a proptest loop, where shrinking
 * replays a chain dozens of times: one bundle + one node start, then a
 * newline-delimited JSON request per candidate chain.
 *
 * Protocol — one JSON object per line, in and out:
 *
 *   in   {"name": …, "seed": {…}, "ops": […]}   (a `Fixture`, minus `expected`)
 *   out  {"ok": true,  "snapshot": {…}, "records": […]}
 *   out  {"ok": false, "error": "…"}
 *
 * `records` is one entry per `via: "command"` op, as `expected_ops` holds it.
 * Each op arrives declaring the refusal the backend recorded for it (#6054), so
 * a mock that refuses differently fails its declaration check and comes back as
 * `ok: false` rather than killing the process; the Rust side reports it as the
 * divergence it is and can shrink it like any other.
 *
 * Run as a bundle, not through the vite pipeline: `npx esbuild … --bundle
 * --alias:@=./src` (the Rust side builds it). `conformance.test.ts` asserts the
 * SAME replay over every committed fixture under vitest, so the two module
 * pipelines are cross-checked on the corpus.
 */

import { createInterface } from 'node:readline'

import {
  type Fixture,
  replayFixtureWithRecords,
} from '@/lib/tauri-mock/__tests__/conformance-replay'

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line: string) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  let response: string
  try {
    const fixture = JSON.parse(trimmed) as Fixture
    response = JSON.stringify({ ok: true, ...replayFixtureWithRecords(fixture) })
  } catch (error) {
    // A mock rejection is `{ kind, message }`, a JS throw is an `Error`, and a
    // parse failure is a `SyntaxError`. Render all three as one line so the
    // Rust side always gets exactly one response per request.
    const message =
      error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : JSON.stringify(error)
    response = JSON.stringify({ ok: false, error: message })
  }
  process.stdout.write(`${response}\n`)
})
