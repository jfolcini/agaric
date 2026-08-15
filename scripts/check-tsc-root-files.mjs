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
//        node scripts/check-tsc-root-files.mjs --self-test
// Exit:  0 = every project's actual root-file set matches its intended
//        set exactly, 1 = a drop (or unexplained extra) was found,
//        2 = repo layout / self-test failure.
// ─────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
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
 * Pure (no process/tsc calls) so the self-test can drive it directly.
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

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  runGuard()
}

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

// ─── self-test ──────────────────────────────────────────────────────
//
// Two layers:
//   1. Pure `diffSets`/`resolveIntendedSet` cases — no process spawned.
//   2. End-to-end `checkProject` against a real synthetic tsconfig,
//      shelling out to the real `tsc -p ... --showConfig` the same way
//      the guard does, so a regression in the shell-out plumbing itself
//      (not just the pure diff math) cannot silently pass.
function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }
  const assertThrows = (name, fn) => {
    try {
      fn()
      fail(name, 'did not throw')
    } catch {
      ok(name)
    }
  }

  // ── pure diffSets ──────────────────────────────────────────────────

  {
    const intended = new Set(['/p/a.ts', '/p/a.tsx', '/p/b.ts'])
    const actual = new Set(['/p/a.ts', '/p/b.ts']) // a.tsx silently dropped
    const { missing, extra } = diffSets(intended, actual)
    if (missing.length === 1 && missing[0] === '/p/a.tsx' && extra.length === 0) {
      ok('diffSets flags a file present in intended but missing from actual')
    } else {
      fail(
        'diffSets flags a file present in intended but missing from actual',
        JSON.stringify({ missing, extra }),
      )
    }
  }
  {
    const intended = new Set(['/p/a.ts'])
    const actual = new Set(['/p/a.ts', '/p/ghost.ts']) // guard's own model disagrees with tsc
    const { missing, extra } = diffSets(intended, actual)
    if (missing.length === 0 && extra.length === 1 && extra[0] === '/p/ghost.ts') {
      ok('diffSets flags a file present in actual but missing from intended')
    } else {
      fail(
        'diffSets flags a file present in actual but missing from intended',
        JSON.stringify({ missing, extra }),
      )
    }
  }
  {
    const intended = new Set(['/p/a.ts', '/p/b.tsx'])
    const actual = new Set(['/p/a.ts', '/p/b.tsx'])
    const { missing, extra } = diffSets(intended, actual)
    if (missing.length === 0 && extra.length === 0) {
      ok('diffSets is clean when intended and actual match exactly')
    } else {
      fail(
        'diffSets is clean when intended and actual match exactly',
        JSON.stringify({ missing, extra }),
      )
    }
  }

  // ── pure resolveIntendedSet / pattern shapes, against a scratch tree ──

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'check-tsc-root-files-selftest-'))
  try {
    const srcDir = path.join(scratch, 'src')
    const nestedDir = path.join(srcDir, '__tests__')
    fs.mkdirSync(nestedDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, 'a.ts'), 'export const a = 1\n')
    fs.writeFileSync(path.join(srcDir, 'a.d.ts'), 'export declare const a: number\n')
    fs.writeFileSync(path.join(srcDir, 'standalone.d.ts'), 'export declare const s: number\n')
    fs.writeFileSync(path.join(nestedDir, 'collide.ts'), 'export const b = 1\n')
    fs.writeFileSync(path.join(nestedDir, 'collide.tsx'), 'export const c = 1\n')
    fs.writeFileSync(path.join(srcDir, 'excluded.ts'), 'export const d = 1\n')
    fs.writeFileSync(path.join(srcDir, 'ignored.json'), '{}\n')

    // Bare-directory include ("src"), literal-file exclude.
    const bareDirSet = resolveIntendedSet(scratch, ['src'], ['src/excluded.ts'])
    const bareDirRel = [...bareDirSet].map((f) => toPosix(path.relative(scratch, f))).toSorted()
    const expectedBareDir = [
      'src/__tests__/collide.ts',
      'src/__tests__/collide.tsx',
      'src/a.ts',
      'src/standalone.d.ts',
    ]
    if (JSON.stringify(bareDirRel) === JSON.stringify(expectedBareDir)) {
      ok(
        'resolveIntendedSet: bare-directory include walks .ts/.tsx, skips .json, honors literal exclude',
      )
    } else {
      fail('resolveIntendedSet: bare-directory include', bareDirRel.join(', '))
    }

    // `.d.ts` vs. same-stem `.ts`: tsc's OTHER intentional priority
    // collapse (out of scope for this guard, see resolveIntendedSet's
    // doc comment) — `a.d.ts` (collides with `a.ts`) must be dropped
    // from the intended set, but `standalone.d.ts` (no `.ts`/`.tsx`
    // sibling) must NOT be, since tsc keeps standalone `.d.ts` root
    // files matched by `include`.
    if (
      !bareDirSet.has(path.join(srcDir, 'a.d.ts')) &&
      bareDirSet.has(path.join(srcDir, 'standalone.d.ts'))
    ) {
      ok(
        'resolveIntendedSet: drops a .d.ts colliding with a same-stem .ts, keeps a standalone .d.ts',
      )
    } else {
      fail(
        'resolveIntendedSet: .d.ts vs .ts collapse',
        JSON.stringify({
          hasCollidingDts: bareDirSet.has(path.join(srcDir, 'a.d.ts')),
          hasStandaloneDts: bareDirSet.has(path.join(srcDir, 'standalone.d.ts')),
        }),
      )
    }

    // `<dir>/**/*.ts` glob include: must NOT pick up the .tsx sibling
    // (mirrors how tsc itself would resolve that narrower pattern).
    const globSet = resolveIntendedSet(scratch, ['src/**/*.ts'], undefined)
    const globRel = [...globSet].map((f) => toPosix(path.relative(scratch, f))).toSorted()
    const expectedGlob = [
      'src/__tests__/collide.ts',
      'src/a.ts',
      'src/excluded.ts',
      'src/standalone.d.ts',
    ]
    if (JSON.stringify(globRel) === JSON.stringify(expectedGlob)) {
      ok('resolveIntendedSet: "<dir>/**/*.ts" glob include matches only that extension')
    } else {
      fail('resolveIntendedSet: glob include', globRel.join(', '))
    }

    // Literal-file include.
    const literalSet = resolveIntendedSet(scratch, ['src/a.ts'], undefined)
    const literalRel = [...literalSet].map((f) => toPosix(path.relative(scratch, f)))
    if (literalRel.length === 1 && literalRel[0] === 'src/a.ts') {
      ok('resolveIntendedSet: literal-file include resolves to exactly that file')
    } else {
      fail('resolveIntendedSet: literal-file include', literalRel.join(', '))
    }

    // Directory-prefix exclude.
    const dirExcludeSet = resolveIntendedSet(scratch, ['src'], ['src/__tests__'])
    const dirExcludeRel = [...dirExcludeSet]
      .map((f) => toPosix(path.relative(scratch, f)))
      .toSorted()
    const expectedDirExclude = ['src/a.ts', 'src/excluded.ts', 'src/standalone.d.ts']
    if (JSON.stringify(dirExcludeRel) === JSON.stringify(expectedDirExclude)) {
      ok('resolveIntendedSet: directory exclude removes every file under it')
    } else {
      fail('resolveIntendedSet: directory exclude', dirExcludeRel.join(', '))
    }

    // Unsupported pattern shapes must throw loudly, not silently no-op.
    assertThrows('expandInclude throws (not silently skips) on an unmodeled glob shape', () =>
      resolveIntendedSet(scratch, ['src/*.ts'], undefined),
    ) // single-star, not "**"

    // `?` alone (no `*`) is real tsc glob syntax too — must also throw,
    // not silently fall through to the literal-path branch as "no match".
    assertThrows('expandInclude throws (not silently skips) on a bare "?" glob shape', () =>
      resolveIntendedSet(scratch, ['src/?.ts'], undefined),
    )
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }

  // ── end-to-end checkProject(), shelling out to the real tsc ────────

  if (!fs.existsSync(TSC_BIN)) {
    fail('end-to-end checkProject() against real tsc', `tsc binary not found at ${TSC_BIN}`)
  } else {
    const e2eScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'check-tsc-root-files-e2e-'))
    try {
      const projSrc = path.join(e2eScratch, 'src')
      fs.mkdirSync(projSrc, { recursive: true })
      fs.writeFileSync(path.join(projSrc, 'plain.ts'), 'export const p = 1\n')
      const tsconfigPath = path.join(e2eScratch, 'tsconfig.json')
      const writeTsconfig = () =>
        fs.writeFileSync(
          tsconfigPath,
          JSON.stringify({ compilerOptions: { noEmit: true, module: 'esnext' }, include: ['src'] }),
        )
      writeTsconfig()

      // Collision case: both a.ts and a.tsx under src/ — must FAIL.
      fs.writeFileSync(path.join(projSrc, 'a.ts'), 'export const a = 1\n')
      fs.writeFileSync(path.join(projSrc, 'a.tsx'), 'export const A = () => null\n')
      const withCollision = checkProject(tsconfigPath)
      const droppedRel = withCollision.missing.map((f) => toPosix(path.relative(e2eScratch, f)))
      if (droppedRel.length === 1 && droppedRel[0] === 'src/a.tsx') {
        ok('checkProject(): real tsc -p --showConfig reproduces the a.ts/a.tsx drop end-to-end')
      } else {
        fail(
          'checkProject(): real tsc -p --showConfig reproduces the a.ts/a.tsx drop end-to-end',
          JSON.stringify({ missing: droppedRel, extra: withCollision.extra }),
        )
      }

      // Resolve the collision (rename a.tsx out of the way) — must PASS.
      fs.renameSync(path.join(projSrc, 'a.tsx'), path.join(projSrc, 'a-view.tsx'))
      const resolved = checkProject(tsconfigPath)
      if (resolved.missing.length === 0 && resolved.extra.length === 0) {
        ok('checkProject(): renaming away the collision clears the guard end-to-end')
      } else {
        fail(
          'checkProject(): renaming away the collision clears the guard end-to-end',
          JSON.stringify({ missing: resolved.missing, extra: resolved.extra }),
        )
      }
    } finally {
      fs.rmSync(e2eScratch, { recursive: true, force: true })
    }
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}
