import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// #3386 — the Rust `mutants` lane produced ZERO mutation coverage for its
// entire life, and the only reason anyone found out is that #3057 added a
// guard three weeks ago. Three independent silent failures stacked up:
// a config file at a path cargo-mutants never reads, globs pointing into
// packages the lane does not examine (the #2621 arch-wave move), and reader
// paths one level short of where `--output DIR` actually writes.
//
// These assertions live in the GATING vitest suite so the next such drift is
// caught on the PR that causes it, not by the following Monday's scheduled
// run — which is the whole point, given the failure mode is a lane that keeps
// reporting success while measuring nothing.
const SCRIPT = join(__dirname, '../../scripts/check-mutants-scope.mjs')

describe('check-mutants-scope.mjs', () => {
  it('the real config, workflow and workspace agree', () => {
    expect(() => execFileSync('node', [SCRIPT], { encoding: 'utf8' })).not.toThrow()
  })

  it('passes its own fixture suite (the guard can actually fail)', () => {
    const out = execFileSync('node', [SCRIPT, '--self-test'], { encoding: 'utf8' })
    expect(out).toContain('self-test: all assertions passed')
    // Name the two assertions that carry the load, so a self-test quietly
    // reduced to trivia fails here.
    expect(out).toContain('a bare invocation examines only the root package')
    expect(out).toContain('dropping --workspace flags all three moved-out globs')
  })

  it('--shard-count reports the matrix total, and fails closed without a matrix', () => {
    // `mutants-merge` compares the shards that uploaded against this number
    // and refuses to publish a short merge (#3393). Printing a 0 that every
    // merge trivially clears would be worse than printing nothing, so a root
    // with no workflow must exit non-zero with empty stdout.
    const count = execFileSync('node', [SCRIPT, '--shard-count'], { encoding: 'utf8' }).trim()
    expect(count).toMatch(/^[1-9]\d*$/)

    const empty = mkdtempSync(join(tmpdir(), 'mutants-scope-'))
    const { status, stdout, stderr } = spawnSync(
      'node',
      [SCRIPT, '--shard-count', '--root', empty],
      { encoding: 'utf8' },
    )
    expect(status).toBe(2)
    expect(stdout).toBe('')
    expect(stderr).toContain('no shard matrix')
  })

  it('exits non-zero when the config is not where cargo-mutants reads it', () => {
    // End-to-end proof that the failure path is reachable: run the guard
    // against an empty root, where `src-tauri/.cargo/mutants.toml` — the one
    // path `Config::read_tree_config` looks at — does not exist. A guard
    // whose non-zero exit is never executed is decoration.
    const empty = mkdtempSync(join(tmpdir(), 'mutants-scope-'))
    const { status, stderr } = spawnSync('node', [SCRIPT, '--root', empty], { encoding: 'utf8' })
    expect(status).toBe(1)
    expect(stderr).toContain('config-missing')
    expect(stderr).toContain('silently falls back to Config::default()')
  })
})
