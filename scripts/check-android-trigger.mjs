#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// `android_re` liveness guard (#3847 follow-up).
//
// `_validate.yml`'s `android_re` decides whether `ci.yml`'s `android-build`
// runs (it rides out as a `workflow_call` output). It is a
// list of literal paths, and a literal path that no longer exists does not
// fail — it silently matches nothing, so the job it guards stops running
// and CI stays green. That is how the #2621 crate split disabled the
// Android build for `agaric-sync` without anyone noticing.
//
// The first attempt to repair that regex made the SAME mistake one level
// in: it checked the alternatives it added and left `db` and
// `orchestrator` — both carried over unchanged — pointing at nothing,
// while `db`'s live successor (`agaric-store/src/db/mod.rs`, two real
// `cfg(target_os = "android")` blocks) matched no alternative at all.
//
// So this guard checks the whole regex rather than the last edit to it:
// every literal path it names must exist on disk.
//
// It deliberately does NOT try to check the converse ("every android-gated
// file is matched"). That direction needs a source scan with its own
// judgement calls — `lifecycle.rs` is matched and carries no gate today,
// which is a harmless over-trigger — and a guard that tries to be clever
// about it would be the next thing to rot. Existence is mechanical and
// cannot drift.
// ─────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const VALIDATE_YML = join(REPO_ROOT, '.github/workflows/_validate.yml')

/** Extract the `android_re='…'` value from _validate.yml. */
function readAndroidRe(src) {
  const m = src.match(/android_re='(?<re>[^']+)'/)
  if (!m?.groups?.re) {
    throw new Error(
      "could not find `android_re='…'` in _validate.yml — did the variable get renamed?",
    )
  }
  return m.groups.re
}

/**
 * Expand one alternation into concrete paths.
 *
 * Handles the two shapes actually used: a plain literal, and a single
 * `(a|b|c)` group inside a path (e.g. `src/(lib|lifecycle)\.rs`). Anything
 * else throws rather than being silently skipped — a parser that quietly
 * ignores a shape it does not understand is the same silent-no-op failure
 * this guard exists to prevent.
 */
function expand(alt) {
  const cleaned = alt
    .replace(/^\^?\(?/, '')
    .replace(/\$$/, '')
    .replaceAll('\\.', '.')
  const group = cleaned.match(/^(?<pre>[^()]*)\((?<opts>[^()]+)\)(?<post>[^()]*)$/)
  if (group?.groups) {
    const { pre, opts, post } = group.groups
    return opts.split('|').map((o) => `${pre}${o}${post}`)
  }
  if (cleaned.includes('(') || cleaned.includes(')')) {
    throw new Error(`unparsed alternation shape: ${alt}`)
  }
  return [cleaned]
}

function main() {
  const re = readAndroidRe(readFileSync(VALIDATE_YML, 'utf8'))
  // Strip the outer `^( … )` wrapper, then split on top-level `|`.
  const body = re.replace(/^\^\(/, '').replace(/\)$/, '')
  const alternatives = []
  let depth = 0
  let current = ''
  for (const ch of body) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === '|' && depth === 0) {
      alternatives.push(current)
      current = ''
      continue
    }
    current += ch
  }
  alternatives.push(current)

  const missing = []
  let checked = 0
  for (const alt of alternatives) {
    for (const path of expand(alt)) {
      // `existsSync` covers directories too, so the one directory-prefix
      // entry (`src-tauri/gen/android/`, trailing slash) needs no special
      // case — it simply must resolve, like every other entry.
      checked++
      if (!existsSync(join(REPO_ROOT, path))) missing.push(path)
    }
  }

  if (missing.length > 0) {
    console.error(
      `ERROR: _validate.yml's \`android_re\` names ${missing.length} path(s) that do not exist:`,
    )
    for (const p of missing) console.error(`  - ${p}`)
    console.error(
      '\nA literal path that no longer exists does not fail — it matches nothing, so\n' +
        '`android-build` silently stops running for whatever it used to cover (#3847).\n' +
        "Repoint the entry at the file's new location, or drop it.",
    )
    process.exit(1)
  }

  console.log(`OK: all ${checked} literal path(s) in _validate.yml's \`android_re\` exist`)
}

main()
