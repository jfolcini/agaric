#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// tsc root-file drop guard (#3912).
//
// `tsc -b` silently drops a config's root file whenever it shares a
// basename with a same-directory sibling of a different TS extension —
// concretely, a `.ts` file makes `tsc` skip a same-named `.tsx` file
// matched by the same `include` glob, with NO error, NO warning, and a
// clean (0) exit. That is exactly how `src/hooks/__tests__/
// useStarredPages.test.tsx` went unchecked since it was added: both
// `useStarredPages.test.ts` and `useStarredPages.test.tsx` are real,
// tracked, vitest-covered files, but only the `.ts` one ever reached the
// type checker.
//
//   $ npx tsc -p tsconfig.app.json --noEmit --listFilesOnly | grep useStarredPages
//   .../src/hooks/useStarredPages.ts
//   .../src/hooks/__tests__/useStarredPages.test.ts   # .tsx sibling: silently absent
//
// `npm run typecheck` (`tsc -b`) is the ONLY typecheck any gate runs
// (tsconfig.json's own header comment, #3805) — a file `tsc` silently
// drops from a project's root-file set gets NO type checking anywhere,
// ever, and a green `tsc -b` is indistinguishable from a checked tree.
// This guard makes the drop itself the thing that turns the gate red,
// instead of relying on someone noticing a specific missing file.
//
// ─── How it works ───────────────────────────────────────────────────
//
// For every project referenced from the root `tsconfig.json` (read live,
// not hardcoded — a project that stops being referenced there already
// stops being typechecked at all, which is #3805's trap, not this one):
//
//   1. ACTUAL: run `tsc -p <project> --showConfig`, which resolves
//      `include`/`exclude`/`extends` exactly the way `tsc -b` itself
//      would and prints the resolved root `files` list as JSON — the
//      same resolution that produced the `.tsx` drop above, so it
//      reflects the drop when one exists.
//   2. INTENDED: independently re-walk the filesystem against that same
//      project's raw `include`/`exclude` patterns (also read from the
//      `--showConfig` output, so there is no separate JSONC parse to
//      keep in sync — tsconfig.app.json/tsconfig.node.json use trailing
//      commas that plain `JSON.parse` rejects). This walk does NOT
//      replicate tsc's same-basename/different-extension collapsing —
//      that collapsing is the exact behavior under test, so encoding it
//      here would make the guard structurally unable to see its own
//      target.
//   3. Diff the two `.ts`/`.tsx` file sets (only `.ts`/`.tsx` — `.d.ts`
//      pairing with a same-name `.ts` is TypeScript's OTHER, intentional
//      use of this priority mechanism, e.g. hand-written ambient
//      declarations superseded by a real implementation, and is out of
//      scope here). A file in INTENDED but missing from ACTUAL is a
//      silent drop: FAIL, naming the file and its colliding sibling. A
//      file in ACTUAL but absent from INTENDED means this guard's own
//      independent walk disagrees with tsc for some other reason: also
//      FAIL — an unexplained mismatch is a bug in this guard's model,
//      not a pass.
//
// Only three `include`/`exclude` pattern shapes appear in this repo's
// five tsconfig files today: a bare directory (`"src"`), a literal file
// (`"wdio.conf.ts"`, `"src/lib/bindings.ts"`), and `"<dir>/**/*.<ext>"`.
// The resolver below handles exactly those and throws (exit 2, not a
// silent no-op) on anything else, so a new pattern shape this guard
// cannot model is a loud failure, not an unchecked gap.
//
// Usage: node scripts/check-tsc-root-files.mjs
// Exit:  0 = every project's actual root-file set matches its intended
//        set exactly, 1 = a drop (or unexplained extra) was found,
//        2 = repo layout failure.
// ─────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TSC_BIN = path.join(ROOT, 'node_modules', '.bin', 'tsc')
const ROOT_TSCONFIG = path.join(ROOT, 'tsconfig.json')
const TS_EXTS = ['.ts', '.tsx']
const SKIP_DIRS = new Set(['node_modules', '.git'])

// ─── helpers ────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/** List the tsconfig project files referenced from the root tsconfig.json. */
function listReferencedProjects(rootTsconfigPath) {
  const parsed = JSON.parse(fs.readFileSync(rootTsconfigPath, 'utf8'))
  const refs = parsed.references ?? []
  const rootDir = path.dirname(rootTsconfigPath)
  return refs.map((r) => path.resolve(rootDir, r.path))
}

/** `tsc -p <project> --showConfig`, parsed. */
function showConfig(projectPath, tscBin = TSC_BIN) {
  const out = execFileSync(tscBin, ['-p', projectPath, '--showConfig'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return JSON.parse(out)
}

// tsc's own documented include/exclude wildcard syntax is `*`, `?`, and
// `**/` — nothing else. A pattern using `?` alone (no `*`) previously
// fell through to the literal-path branch below and silently resolved
// to "no match" instead of hitting the throwing glob-shape resolver —
// a silent no-op, not the loud failure the header comment promises.
function isGlobPattern(p) {
  return p.includes('*') || p.includes('?')
}

/** Recursively collect files under `dir` whose name ends with one of `exts`. */
function walkDirForExt(dir, exts) {
  const out = []
  const visit = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        visit(full)
      } else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) {
        out.push(full)
      }
    }
  }
  if (fs.existsSync(dir)) visit(dir)
  return out
}

const GLOB_RE = /^(.*)\/\*\*\/\*\.([\w.]+)$/

/** Expand one `include` pattern to absolute `.ts`/`.tsx` file paths, relative to `baseDir`. */
function expandInclude(baseDir, pattern) {
  if (!isGlobPattern(pattern)) {
    const abs = path.join(baseDir, pattern)
    if (!fs.existsSync(abs)) return []
    const st = fs.statSync(abs)
    if (st.isDirectory()) return walkDirForExt(abs, TS_EXTS)
    return TS_EXTS.includes(path.extname(abs)) ? [abs] : []
  }
  const m = pattern.match(GLOB_RE)
  if (!m) {
    throw new Error(
      `Unsupported include glob shape (extend expandInclude to handle it): "${pattern}"`,
    )
  }
  const ext = `.${m[2]}`
  if (!TS_EXTS.includes(ext)) return [] // a non-ts/tsx glob (e.g. *.json) is out of scope here
  return walkDirForExt(path.join(baseDir, m[1]), [ext])
}

/** Build a predicate matching absolute paths excluded by one `exclude` pattern. */
function excludePredicate(baseDir, pattern) {
  if (!isGlobPattern(pattern)) {
    const abs = path.join(baseDir, pattern)
    return (file) => file === abs || file.startsWith(abs + path.sep)
  }
  const m = pattern.match(GLOB_RE)
  if (!m) {
    throw new Error(
      `Unsupported exclude glob shape (extend excludePredicate to handle it): "${pattern}"`,
    )
  }
  const dir = path.join(baseDir, m[1])
  const ext = `.${m[2]}`
  return (file) => file.startsWith(dir + path.sep) && file.endsWith(ext)
}

/** The basename a file shares with its same-directory `.ts`/`.tsx`/`.d.ts` siblings. */
function collapseStem(file) {
  const base = file.endsWith('.d.ts')
    ? file.slice(0, -'.d.ts'.length)
    : file.slice(0, -path.extname(file).length)
  return base
}

/**
 * Independently resolve the `.ts`/`.tsx` file set a project's raw
 * `include`/`exclude` patterns name, WITHOUT tsc's same-basename
 * extension-priority collapsing — EXCEPT for `.d.ts` vs. `.ts`/`.tsx`,
 * which is TypeScript's OTHER, intentional use of that same priority
 * mechanism (a hand-written ambient declaration superseded by a real
 * implementation) and is explicitly out of scope for this guard: a
 * `.d.ts` file is dropped from the intended set whenever a same-stem
 * `.ts`/`.tsx` file is also present, so that tsc's expected collapse in
 * that specific case is not reported as a drop.
 */
function resolveIntendedSet(baseDir, include, exclude) {
  const excludePreds = (exclude ?? []).map((p) => excludePredicate(baseDir, p))
  const set = new Set()
  for (const pattern of include ?? []) {
    for (const abs of expandInclude(baseDir, pattern)) {
      if (excludePreds.some((pred) => pred(abs))) continue
      set.add(abs)
    }
  }
  const nonDtsStems = new Set([...set].filter((f) => !f.endsWith('.d.ts')).map(collapseStem))
  for (const f of set) {
    if (f.endsWith('.d.ts') && nonDtsStems.has(collapseStem(f))) set.delete(f)
  }
  return set
}

/** The `.ts`/`.tsx` file set tsc actually resolved as this project's root files. */
function resolveActualSet(baseDir, files) {
  const set = new Set()
  for (const f of files ?? []) {
    const abs = path.resolve(baseDir, f)
    if (TS_EXTS.includes(path.extname(abs))) set.add(abs)
  }
  return set
}

/**
 * Compare a project's intended vs. actual `.ts`/`.tsx` root-file sets.
 * Returns `{ missing, extra }` (both sorted absolute-path arrays).
 */
function diffSets(intended, actual) {
  const missing = [...intended].filter((f) => !actual.has(f)).toSorted()
  const extra = [...actual].filter((f) => !intended.has(f)).toSorted()
  return { missing, extra }
}

/** Full end-to-end check for one tsconfig project path. Shells out to `tsc`. */
function checkProject(projectPath, tscBin = TSC_BIN) {
  const config = showConfig(projectPath, tscBin)
  const baseDir = path.dirname(projectPath)
  const intended = resolveIntendedSet(baseDir, config.include, config.exclude)
  const actual = resolveActualSet(baseDir, config.files)
  const { missing, extra } = diffSets(intended, actual)
  return { projectPath, intended, actual, missing, extra }
}

/** Group a flat list of absolute file paths by their basename-without-extension. */
function groupByStem(files) {
  const byStem = new Map()
  for (const f of files) {
    const stem = path.join(path.dirname(f), path.basename(f, path.extname(f)))
    if (!byStem.has(stem)) byStem.set(stem, [])
    byStem.get(stem).push(f)
  }
  return byStem
}

// ─── main ───────────────────────────────────────────────────────────

runGuard()

function runGuard() {
  if (!fs.existsSync(ROOT_TSCONFIG)) {
    console.error(`ERROR: expected file not found (repo layout changed?): ${ROOT_TSCONFIG}`)
    process.exit(2)
  }
  if (!fs.existsSync(TSC_BIN)) {
    console.error(`ERROR: tsc binary not found (repo layout changed?): ${TSC_BIN}`)
    process.exit(2)
  }

  const projects = listReferencedProjects(ROOT_TSCONFIG)
  const results = projects.map((p) => checkProject(p))

  const problems = []
  let totalIntended = 0
  let totalActual = 0
  for (const r of results) {
    totalIntended += r.intended.size
    totalActual += r.actual.size
    const relProject = toPosix(path.relative(ROOT, r.projectPath))
    for (const abs of r.missing) {
      const stem = path.join(path.dirname(abs), path.basename(abs, path.extname(abs)))
      const siblings = groupByStem([...r.intended])
        .get(stem)
        .filter((f) => f !== abs)
        .map((f) => toPosix(path.relative(ROOT, f)))
      const suffix =
        siblings.length > 0
          ? ` (shares its basename with: ${siblings.join(', ')} — tsc kept only the ` +
            `higher-priority extension and silently discarded this one)`
          : ` (present on disk, matched by include/exclude, but absent from tsc's resolved ` +
            `root-file list for an unexplained reason)`
      problems.push(`  [${relProject}] DROPPED: ${toPosix(path.relative(ROOT, abs))}${suffix}`)
    }
    for (const abs of r.extra) {
      problems.push(
        `  [${relProject}] UNEXPECTED: tsc includes ${toPosix(path.relative(ROOT, abs))} but this ` +
          `guard's independent include/exclude walk does not — the guard's pattern resolver is out ` +
          `of sync with tsc and needs a fix, not a bigger allowlist.`,
      )
    }
  }

  if (problems.length > 0) {
    console.error('ERROR: tsc root-file set does not match what the config intends:')
    console.error('')
    for (const p of problems) console.error(p)
    console.error('')
    console.error(
      'A DROPPED file receives NO type checking from `tsc -b` (npm run typecheck) — ever, ' +
        'silently, with a clean exit. Rename one of the colliding files so their basenames ' +
        'differ, or otherwise change the file set so tsc keeps every intended root file.',
    )
    process.exit(1)
  }

  console.log(
    `OK: ${results.length} tsconfig project(s), ${totalActual} actual root .ts/.tsx file(s) ` +
      `match ${totalIntended} intended (no drops, no unexplained extras).`,
  )
}
