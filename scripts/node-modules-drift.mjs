#!/usr/bin/env node
// Whether a worktree can run on the main checkout's `node_modules`, which
// `scripts/seed-worktree.sh` symlinks into it. Two ways it cannot:
//
//   1. The main checkout's install lags its own `package-lock.json`. npm
//      records what it installed in `node_modules/.package-lock.json` (its
//      hidden lockfile), keyed by the same paths as the lockfile's `packages`,
//      so the two are compared version by version. `npm ls` would not do: it
//      checks `package.json`'s ranges, which a stale install still satisfies.
//   2. This worktree's `package-lock.json` differs from the main checkout's: a
//      branch that changed it, or a main checkout behind `origin/main`.
//
// Usage: node scripts/node-modules-drift.mjs <main checkout> <worktree>
// Exit 0 when both match; 1 with what is stale and the fix, including when a
// file cannot be read; 2 on bad usage. It never installs anything: another
// agent's tests may be running from that `node_modules`.

import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

/**
 * The paths of two lockfile `packages` maps whose versions differ, as
 * `{ path, want, have }` with `null` for a side that lacks the path. The root
 * entry (`""`) carries the app's own version and is skipped. With
 * `skipOptional`, a path `want` marks optional may be missing from `have`:
 * npm never installs another platform's binaries.
 */
export function lockDrift(want, have, { skipOptional = false } = {}) {
  const drift = []
  for (const [path, entry] of Object.entries(want)) {
    if (path === '') continue
    const got = have[path]
    if (got === undefined) {
      if (!(skipOptional && entry.optional === true)) {
        drift.push({ path, want: entry.version, have: null })
      }
    } else if (got.version !== entry.version) {
      drift.push({ path, want: entry.version, have: got.version })
    }
  }
  for (const [path, entry] of Object.entries(have)) {
    if (path !== '' && !Object.hasOwn(want, path)) {
      drift.push({ path, want: null, have: entry.version })
    }
  }
  return drift
}

/** A lockfile's `packages` map; throws when the file is missing or malformed. */
function readPackages(file) {
  const packages = JSON.parse(readFileSync(file, 'utf8')).packages
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error(`${file} has no "packages" map`)
  }
  return packages
}

const SHOWN = 10

function report(title, drift, [wantLabel, haveLabel], fix) {
  console.error(title)
  for (const { path, want, have } of drift.slice(0, SHOWN)) {
    console.error(`  ${path}: ${wantLabel} ${want ?? '(none)'}, ${haveLabel} ${have ?? '(none)'}`)
  }
  if (drift.length > SHOWN) console.error(`  … and ${drift.length - SHOWN} more`)
  for (const line of fix) console.error(line)
}

function main([mainRoot, worktree, ...rest]) {
  if (mainRoot === undefined || worktree === undefined || rest.length > 0) {
    console.error('usage: node scripts/node-modules-drift.mjs <main checkout> <worktree>')
    return 2
  }
  const npmCi = `  Fix: run \`npm ci\` in ${mainRoot} once no other agent is testing from it.`
  let mainLock, installed, worktreeLock
  try {
    mainLock = readPackages(join(mainRoot, 'package-lock.json'))
    installed = readPackages(join(mainRoot, 'node_modules/.package-lock.json'))
    worktreeLock = readPackages(join(worktree, 'package-lock.json'))
  } catch (err) {
    console.error(`Cannot tell whether ${mainRoot}/node_modules is current: ${err.message}`)
    console.error(npmCi)
    return 1
  }
  const stale = lockDrift(mainLock, installed, { skipOptional: true })
  if (stale.length > 0) {
    report(
      `${mainRoot}/node_modules does not match its package-lock.json:`,
      stale,
      ['locked', 'installed'],
      [npmCi],
    )
  }
  const diverged = lockDrift(worktreeLock, mainLock)
  if (diverged.length > 0) {
    report(
      `This worktree's package-lock.json differs from ${mainRoot}'s:`,
      diverged,
      ['here', 'there'],
      [
        '  Fix: if this branch changed the lockfile, give the worktree its own install:',
        '    rm node_modules && npm ci',
        `  Otherwise ${mainRoot} is behind: update it to origin/main, then run \`npm ci\` there.`,
      ],
    )
  }
  return stale.length > 0 || diverged.length > 0 ? 1 : 0
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) process.exitCode = main(process.argv.slice(2))
