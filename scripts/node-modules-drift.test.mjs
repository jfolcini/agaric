import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { lockDrift } from './node-modules-drift.mjs'

const SCRIPT = join(import.meta.dirname, 'node-modules-drift.mjs')

// Every `test()` below is `void`-ed: node:test's returned promise fulfils even
// when the test fails, so there is nothing for a caller to await or catch.

const SELECT = 'node_modules/@radix-ui/react-select'
const ESBUILD_DARWIN = 'node_modules/@esbuild/darwin-arm64'
const LOCK = {
  '': { name: 'agaric', version: '0.23.0' },
  [SELECT]: { version: '2.4.1' },
  [ESBUILD_DARWIN]: { version: '0.25.0', optional: true, os: ['darwin'] },
}
const INSTALLED = { [SELECT]: { version: '2.4.1' } }

void test('an install that matches its lockfile has no drift', () => {
  assert.deepEqual(lockDrift(LOCK, INSTALLED, { skipOptional: true }), [])
})

void test('an installed version behind the lockfile is drift', () => {
  const installed = { [SELECT]: { version: '2.3.8' } }
  assert.deepEqual(lockDrift(LOCK, installed, { skipOptional: true }), [
    { path: SELECT, want: '2.4.1', have: '2.3.8' },
  ])
})

void test('a locked package missing from the install is drift unless optional', () => {
  assert.deepEqual(lockDrift(LOCK, {}, { skipOptional: true }), [
    { path: SELECT, want: '2.4.1', have: null },
  ])
  assert.deepEqual(lockDrift(LOCK, INSTALLED), [
    { path: ESBUILD_DARWIN, want: '0.25.0', have: null },
  ])
})

void test('an installed package the lockfile no longer has is drift', () => {
  const installed = { ...INSTALLED, 'node_modules/left-pad': { version: '1.3.0' } }
  assert.deepEqual(lockDrift(LOCK, installed, { skipOptional: true }), [
    { path: 'node_modules/left-pad', want: null, have: '1.3.0' },
  ])
})

void test("the root entry's own version is not drift", () => {
  const bumped = { ...LOCK, '': { name: 'agaric', version: '0.24.0' } }
  assert.deepEqual(lockDrift(bumped, LOCK), [])
})

// A main checkout and a worktree on disk; `installed` null leaves out the
// hidden lockfile, and a string is written verbatim.
function withCheckouts({ mainLock = LOCK, installed = INSTALLED, worktreeLock = LOCK }, fn) {
  const root = mkdtempSync(join(tmpdir(), 'node-modules-drift-'))
  try {
    const main = join(root, 'main')
    const worktree = join(root, 'worktree')
    mkdirSync(join(main, 'node_modules'), { recursive: true })
    mkdirSync(worktree)
    const write = (file, packages) =>
      writeFileSync(
        file,
        typeof packages === 'string' ? packages : JSON.stringify({ lockfileVersion: 3, packages }),
      )
    write(join(main, 'package-lock.json'), mainLock)
    if (installed !== null) write(join(main, 'node_modules/.package-lock.json'), installed)
    write(join(worktree, 'package-lock.json'), worktreeLock)
    const r = spawnSync(process.execPath, [SCRIPT, main, worktree], { encoding: 'utf8' })
    return fn({ code: r.status, err: r.stderr, main })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

void test('the CLI passes when the install and both lockfiles agree', () =>
  withCheckouts({}, ({ code, err }) => {
    assert.equal(code, 0, err)
    assert.equal(err, '')
  }))

void test('the CLI names a stale package and npm ci in the main checkout', () =>
  withCheckouts({ installed: { [SELECT]: { version: '2.3.8' } } }, ({ code, err, main }) => {
    assert.equal(code, 1)
    assert.match(err, /react-select: locked 2\.4\.1, installed 2\.3\.8/)
    assert.ok(err.includes(`run \`npm ci\` in ${main}`), err)
  }))

void test("the CLI fails a worktree whose lockfile differs from the main checkout's", () =>
  withCheckouts({ worktreeLock: { [SELECT]: { version: '2.5.0' } } }, ({ code, err }) => {
    assert.equal(code, 1)
    assert.match(err, /react-select: here 2\.5\.0, there 2\.4\.1/)
    assert.match(err, /rm node_modules && npm ci/)
  }))

void test('the CLI fails closed on a missing or unparsable hidden lockfile', () => {
  for (const installed of [null, '{ not json']) {
    withCheckouts({ installed }, ({ code, err }) => {
      assert.equal(code, 1)
      assert.match(err, /^Cannot tell whether .*node_modules is current: /)
    })
  }
})
