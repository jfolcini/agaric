#!/usr/bin/env node
// Prints the next free session-log number: one past the numeric max over the
// merge target, this branch, and the session logs that open PRs add. The
// numbering guard (`check-session-log-numbering.sh`) checks a new log against
// the first two only, so a number handed out before builders launch falls
// behind the PRs that merge meanwhile: ask for it when committing the log.
//
// Usage:
//   node scripts/next-session-log.mjs                  print the number
//   node scripts/next-session-log.mjs --rename <file>  move a log that has not
//       merged to that number and rewrite its `# Session N` heading to match
//       (the guard checks the two agree); prints the new path, then stage both.
//
// Without `gh`, or when it fails, it says so on stderr and counts the local
// refs alone: the guard is still the gate.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'

import { LOG_DIR, sessionNumberOf } from './check-session-log-pr-collision.mjs'

/** One past the highest session number among `paths`; others are ignored. */
export function nextFree(paths) {
  let max = 0
  for (const path of paths) max = Math.max(max, sessionNumberOf(path) ?? 0)
  return max + 1
}

function git(root, ...args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`)
  return r.stdout
}

const lines = (text) => text.split('\n').filter(Boolean)

// The guard's merge target, in its order: origin/main, then a local main.
function mergeTarget(root) {
  for (const ref of ['refs/remotes/origin/main', 'refs/heads/main']) {
    const r = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', ref])
    if (r.status === 0) return ref
  }
  return null
}

// REST, not `gh pr list`: GraphQL answers 403 in a cloud session.
function openPrLogs() {
  const gh = (path) => {
    const r = spawnSync('gh', ['api', '--paginate', path, '--jq', '.[] | .number // .filename'], {
      encoding: 'utf8',
    })
    if (r.error !== undefined || r.status !== 0) {
      throw new Error(r.error?.message ?? r.stderr.trim())
    }
    return lines(r.stdout)
  }
  try {
    return gh('repos/{owner}/{repo}/pulls?state=open&per_page=100').flatMap((n) =>
      gh(`repos/{owner}/{repo}/pulls/${n}/files?per_page=100`),
    )
  } catch (err) {
    console.error(`next-session-log: open PRs not counted (gh api failed: ${err.message})`)
    return []
  }
}

function rename(root, rel, next) {
  const m = /^(docs\/session-log\/session-)(\d+)(-[^/]+\.md)$/.exec(rel)
  if (m === null) throw new Error(`${rel} is not a ${LOG_DIR}/session-N-<slug>.md log`)
  if (Number(m[2]) === next) return rel
  const dest = `${m[1]}${next}${m[3]}`
  if (existsSync(join(root, dest))) throw new Error(`${dest} already exists`)
  const text = readFileSync(join(root, rel), 'utf8')
  const heading = /^(#[ \t]+Session[ \t]+)\d+[a-z]?/m
  if (!heading.test(text)) throw new Error(`${rel} has no '# Session N' heading`)
  renameSync(join(root, rel), join(root, dest))
  writeFileSync(join(root, dest), text.replace(heading, `$1${next}`))
  return dest
}

function main(argv) {
  const [flag, file, ...rest] = argv
  if (rest.length > 0 || (flag !== undefined && (flag !== '--rename' || file === undefined))) {
    console.error('usage: node scripts/next-session-log.mjs [--rename <file>]')
    return 2
  }
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim()
  const rel = file === undefined ? null : relative(root, resolve(file))
  const target = mergeTarget(root)
  const merged =
    target === null ? [] : lines(git(root, 'ls-tree', '-r', '--name-only', target, '--', LOG_DIR))
  if (target === null)
    console.error('next-session-log: no origin/main or main; counting this branch')
  if (rel !== null && merged.includes(rel)) {
    throw new Error(`${rel} is on ${target}: a merged log is never renamed`)
  }
  const branch = lines(git(root, 'ls-tree', '-r', '--name-only', 'HEAD', '--', LOG_DIR))
  // The log being renamed does not hold its own number down.
  const unmerged = [...branch, ...openPrLogs()].filter((path) => path !== rel)
  const next = nextFree([...merged, ...unmerged])
  if (rel === null) {
    console.log(next)
    return 0
  }
  const dest = rename(root, rel, next)
  console.log(dest)
  if (dest !== rel) console.error(`next-session-log: stage it with git add -A -- ${rel} ${dest}`)
  return 0
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    console.error(`next-session-log: ${err.message}`)
    process.exitCode = 1
  }
}
