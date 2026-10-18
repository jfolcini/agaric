import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  keyFamily,
  parseCacheRestores,
  parseSince,
  peakOverlap,
  percentile,
} from './ci-capacity-report.mjs'

const ts = (line) => `2026-10-18T13:14:39.5305386Z ${line}`
const log = (...lines) => lines.map(ts).join('\n')

void test('rust-cache: an exact restore is a hit, keyed by its family', () => {
  const restores = parseCacheRestores(
    log(
      '##[group]Run Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6',
      'Cache Key:',
      '    v0-rust-rust-lint-Linux-x64-fdb80fc9-571c9586',
      'Cache Size: ~1383 MB (1450671785 B)',
      'Restored from cache key "v0-rust-rust-lint-Linux-x64-fdb80fc9-571c9586" full match: true.',
    ),
  )
  assert.deepEqual(restores, [
    { family: 'v0-rust-rust-lint-Linux-x64', outcome: 'hit', sizeMb: 1383 },
  ])
})

void test('rust-cache: a prefix restore is partial and a miss is a miss', () => {
  const restores = parseCacheRestores(
    log(
      'Cache Key:',
      '    v0-rust-rust-cov-Linux-x64-fdb80fc9-11111111',
      'Cache Size: ~864 MB (906241970 B)',
      'Restored from cache key "v0-rust-rust-cov-Linux-x64-fdb80fc9-571c9586" full match: false.',
      'Cache Key:',
      '    v0-rust-rust-e2e-tauri-Linux-x64-fdb80fc9-571c9586',
      'No cache found.',
    ),
  )
  assert.deepEqual(restores, [
    { family: 'v0-rust-rust-cov-Linux-x64', outcome: 'partial', sizeMb: 864 },
    { family: 'v0-rust-rust-e2e-tauri-Linux-x64', outcome: 'miss', sizeMb: undefined },
  ])
})

void test('actions/cache: restore-key match is partial, exact is a hit, not found is a miss', () => {
  const restores = parseCacheRestores(
    log(
      '##[group]Run actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
      'with:',
      '  path: .lycheecache',
      `  key: lychee-Linux-${'e'.repeat(64)}`,
      `Cache restored from key: lychee-Linux-${'a'.repeat(64)}`,
      '##[group]Run actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
      'with:',
      '  key: apt-tauri-Linux-v1',
      'Cache Size: ~61 MB (63591255 B)',
      'Cache restored from key: apt-tauri-Linux-v1',
      '##[group]Run actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
      'with:',
      '  key: apt-tauri-e2e-Linux-v5',
      'Cache not found for input keys: apt-tauri-e2e-Linux-v5',
    ),
  )
  assert.deepEqual(restores, [
    { family: 'lychee-Linux', outcome: 'partial', sizeMb: undefined },
    { family: 'apt-tauri-Linux-v1', outcome: 'hit', sizeMb: 61 },
    { family: 'apt-tauri-e2e-Linux-v5', outcome: 'miss', sizeMb: undefined },
  ])
})

void test('setup-node prints no key input, so its restore counts as a hit', () => {
  const key = `node-cache-Linux-x64-npm-${'4'.repeat(64)}`
  const restores = parseCacheRestores(
    log(
      '##[group]Run actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
      `Cache restored from key: ${key}`,
    ),
  )
  assert.deepEqual(restores, [
    { family: 'node-cache-Linux-x64-npm', outcome: 'hit', sizeMb: undefined },
  ])
})

void test('a log with no cache step yields nothing', () => {
  assert.deepEqual(parseCacheRestores(log('##[group]Run npm ci', 'added 900 packages')), [])
})

void test('keyFamily strips only trailing content hashes', () => {
  assert.equal(
    keyFamily('v0-rust-rust-mcp-Linux-x64-fdb80fc9-571c9586'),
    'v0-rust-rust-mcp-Linux-x64',
  )
  assert.equal(
    keyFamily(`codeql-trap-1-2.27.2-javascript-${'0'.repeat(40)}`),
    'codeql-trap-1-2.27.2-javascript',
  )
  assert.equal(keyFamily('apt-tauri-Linux-v1'), 'apt-tauri-Linux-v1')
})

void test('percentile is nearest-rank, and undefined on no data', () => {
  const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6]
  assert.equal(percentile(values, 50), 5)
  assert.equal(percentile(values, 90), 9)
  assert.equal(percentile(values, 100), 10)
  assert.equal(percentile([], 50), undefined)
})

void test('peakOverlap counts what is open at one instant; touching intervals do not overlap', () => {
  assert.deepEqual(
    peakOverlap([
      [0, 10],
      [5, 15],
      [6, 7],
      [15, 20],
    ]),
    { peak: 3, at: 6 },
  )
  assert.deepEqual(
    peakOverlap([
      [0, 10],
      [10, 20],
    ]),
    { peak: 1, at: 0 },
  )
  assert.deepEqual(peakOverlap([]), { peak: 0, at: undefined })
})

void test('parseSince takes <N>h, <N>d and ISO, and rejects anything else', () => {
  const now = Date.parse('2026-10-18T12:00:00Z')
  assert.equal(parseSince('6h', now).toISOString(), '2026-10-18T06:00:00.000Z')
  assert.equal(parseSince('2d', now).toISOString(), '2026-10-16T12:00:00.000Z')
  assert.equal(parseSince('2026-10-01T00:00:00Z', now).toISOString(), '2026-10-01T00:00:00.000Z')
  assert.throws(() => parseSince('yesterday', now), /not a time/)
})
