#!/usr/bin/env node
// Delete the advisory waivers a Dependabot update left matching nothing, so its
// PR does not stay red on `unused-ignored-advisory = "deny"` (src-tauri/deny.toml)
// or the unused-waiver check in scripts/npm-audit-retry.sh (.nsprc).
//
//   node scripts/prune-advisory-waivers.mjs list <branch>   print, as JSON, the
//       waivers the branch left unused: {"cargo": [...], "npm": [...]}. Each half
//       runs only on its own ecosystem's Dependabot branch. CI's lint job runs
//       this on a failed Dependabot PR and uploads the result.
//   node scripts/prune-advisory-waivers.mjs apply <file>    delete those waivers
//       from deny.toml and .nsprc. advisory-waiver-prune.yml runs this, from the
//       default branch, on the list the CI run uploaded.
//
// Only ever deletes: an id that is malformed or not waived fails the run.

import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ID = /^(RUSTSEC-\d{4}-\d{4}|GHSA(-[0-9a-z]{4}){3}|\d+)$/

/** The unused waivers in cargo deny's JSON diagnostics and better-npm-audit's report. */
export function unusedFromReports(cargoDenyStderr, npmAuditJson) {
  const cargo = cargoDenyStderr
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .filter((d) => d.type === 'diagnostic' && d.fields.code === 'advisory-not-detected')
    .map((d) => d.fields.labels[0].span)
  const npm = npmAuditJson ? JSON.parse(npmAuditJson).unusedExceptionIds.map(String) : []
  return { cargo, npm }
}

/** Parse the `list` output, accepting nothing but advisory ids. */
export function parseUnused(text) {
  const parsed = JSON.parse(text)
  /** @type {[string, RegExp][]} */
  const checks = [
    ['cargo', /^RUSTSEC-\d{4}-\d{4}$/],
    ['npm', ID],
  ]
  for (const [key, pattern] of checks) {
    if (!Array.isArray(parsed[key])) throw new Error(`${key} is not a list`)
    for (const id of parsed[key]) {
      if (typeof id !== 'string' || !pattern.test(id))
        throw new Error(`${key}: ${JSON.stringify(id)} is not an advisory id`)
    }
  }
  return { cargo: parsed.cargo, npm: parsed.npm }
}

/** deny.toml without the one-line `[advisories].ignore` entry of each id. */
export function pruneDeny(text, ids) {
  const lines = text.split('\n')
  for (const id of ids) {
    const at = lines.findIndex((l) => l.trimStart().startsWith(`{ id = "${id}", reason = `))
    if (at < 0) throw new Error(`${id} is not a one-line [advisories].ignore entry`)
    lines.splice(at, 1)
  }
  return lines.join('\n')
}

/** .nsprc without the entry of each id. */
export function pruneNsprc(text, ids) {
  const waivers = JSON.parse(text)
  for (const id of ids) {
    if (!Object.hasOwn(waivers, id)) throw new Error(`${id} is not waived in .nsprc`)
    delete waivers[id]
  }
  return `${JSON.stringify(waivers, null, 2)}\n`
}

// Both tools exit non-zero on any finding, so the status is not the verdict.
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.error) throw r.error
  return r
}

/** @param {string[]} argv */
function main(argv) {
  const [cmd, arg] = argv
  if (cmd === 'list' && arg) {
    const cargo = arg.startsWith('dependabot/cargo/')
      ? run('cargo', ['deny', '--format', 'json', 'check', 'advisories'], join(ROOT, 'src-tauri'))
          .stderr
      : ''
    const npm = arg.startsWith('dependabot/npm_and_yarn/')
      ? run('npx', ['better-npm-audit', 'audit', '--json'], ROOT).stdout
      : ''
    process.stdout.write(`${JSON.stringify(unusedFromReports(cargo, npm))}\n`)
    return
  }
  if (cmd === 'apply' && arg) {
    const { cargo, npm } = parseUnused(readFileSync(arg, 'utf8'))
    for (const [ids, file, prune] of [
      [cargo, 'src-tauri/deny.toml', pruneDeny],
      [npm, '.nsprc', pruneNsprc],
    ]) {
      if (ids.length === 0) continue
      const path = join(ROOT, file)
      writeFileSync(path, prune(readFileSync(path, 'utf8'), ids))
      console.log(`${file}: deleted ${ids.join(', ')}`)
    }
    return
  }
  throw new Error('usage: prune-advisory-waivers.mjs list <branch> | apply <file>')
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) main(process.argv.slice(2))
