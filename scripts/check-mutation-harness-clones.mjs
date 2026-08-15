#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Mutation-harness source-pin guard (#3907).
//
// `scripts/mutation-harnesses/*.harness.ts` each contain hand-copied
// CLONES of a real function under test, plus hand-copied clones of the
// specific mutants they discriminate — necessary, because you cannot
// sweep a mutant without a copy of it. But nothing tied the clone to the
// original: the harnesses are deliberately out of CI (minutes-long
// sweeps, no gating value) and `scripts/` is in no tsconfig project, so
// nothing type-checks them either. Editing the real function silently
// invalidates the clones, with no signal anywhere — the harness keeps
// passing, reporting numbers about code that no longer exists. That is
// the exact rot #3804 documented for the equivalence ledgers, one layer
// down.
//
// ─── How it works ───────────────────────────────────────────────────
//
// Every `*.harness.ts` file must carry one or more SOURCE-PIN markers:
//
//   // mutation-harness-source-pin: <repo-relative-path>#<functionName> sha256=<64-hex>
//
// For each marker this guard:
//   1. Resolves `<repo-relative-path>` and reads it (missing file FAILS).
//   2. Extracts the named function's FULL text (signature through its
//      matching closing brace) via a bracket-depth scanner that skips
//      over string/template literal contents — same technique as the
//      sibling `check-set-property-args.mjs` guard. Ambiguous (0 or 2+
//      matches) or unmatched-brace extraction FAILS.
//   3. Canonicalizes it (collapse all whitespace runs to a single space,
//      trim) and hashes it with sha256. Whitespace-only reformatting
//      therefore does NOT trip the gate; any token-level change
//      (including a changed comment inside the function, which in this
//      codebase's style routinely encodes the invariants a clone's
//      equivalence argument depends on) does.
//   4. Compares against the pinned hash. A mismatch FAILS, naming the
//      harness, the source location, and the fact that the clone needs
//      re-syncing and its pin needs updating.
//
// A harness file with ZERO markers FAILS — that is precisely the #3907
// gap this guard exists to close; a new harness must declare what it
// clones from day one, not leave it implicit.
//
// This is a fast, local, static check (no vitest, no execution of the
// harnesses' actual sweeps) — cheap enough to run on every commit that
// touches a harness or a pinned source file, unlike the sweeps
// themselves, which stay out of CI by design (#3804).
//
// Usage: node scripts/check-mutation-harness-clones.mjs
//        node scripts/check-mutation-harness-clones.mjs --self-test
// Exit:  0 = every pin matches, 1 = a pin is missing/stale/unresolvable,
//        2 = repo layout / self-test failure.
// ─────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const HARNESS_DIR = path.join(ROOT, 'scripts', 'mutation-harnesses')

// Matches the marker either as a standalone `//` line or as a line inside a
// `/** ... */` JSDoc block (leading ` * `), so a harness's existing header
// doc comment can carry the pin without breaking out into a separate line.
const PIN_RE =
  /^\s*(?:\/\/|\*(?!\/))\s*mutation-harness-source-pin:\s*(\S+?)#([A-Za-z_$][A-Za-z0-9_$]*)\s+sha256=([0-9a-f]{64})\s*$/

// ─── string/bracket-aware lexing (mirrors check-set-property-args.mjs) ─

function skipString(src, i) {
  const quote = src[i]
  const n = src.length
  let j = i + 1
  while (j < n) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (quote === '`' && c === '$' && src[j + 1] === '{') {
      j = skipTemplateExpr(src, j + 2)
      continue
    }
    if (c === quote) return j + 1
    j++
  }
  return n
}

function skipTemplateExpr(src, i) {
  const n = src.length
  let depth = 1
  let j = i
  while (j < n && depth > 0) {
    const c = src[j]
    if (c === "'" || c === '"' || c === '`') {
      j = skipString(src, j)
      continue
    }
    if (c === '{') {
      depth++
      j++
      continue
    }
    if (c === '}') {
      depth--
      j++
      continue
    }
    j++
  }
  return j
}

/**
 * Replace block comments and line comments with equal-length whitespace
 * (preserving newlines and overall length, so offsets into the result stay
 * valid offsets into the original), skipping over string/template literal
 * contents so a `//` or `/*` inside a string is not mistaken for a comment.
 *
 * Load-bearing for `extractFunction` below: without this, a comment
 * containing a backslash immediately before a backtick (this file's own
 * source has exactly that shape — `` `notes\` ``, a literal backslash
 * described in prose) is misread by the string/template scanner as an
 * ESCAPED backtick, so the "string" it thinks it is skipping never closes
 * where a human reads it closing, and bracket-depth tracking desyncs from
 * everything after. Comments must be blanked before any bracket-matching
 * runs, exactly as the sibling `check-set-property-args.mjs` guard does.
 */
function stripComments(src) {
  const n = src.length
  let out = ''
  let i = 0
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === "'" || c === '"' || c === '`') {
      const j = skipString(src, i)
      out += src.slice(i, j)
      i = j
      continue
    }
    if (c === '/' && c2 === '/') {
      let j = i
      while (j < n && src[j] !== '\n') j++
      out += ' '.repeat(j - i)
      i = j
      continue
    }
    if (c === '/' && c2 === '*') {
      let j = i + 2
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++
      j = Math.min(j + 2, n)
      out += src.slice(i, j).replace(/[^\n]/g, ' ')
      i = j
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Find the index of the bracket matching `src[openIdx]` (one of `([{`),
 * scanning forward and skipping over string/template literal contents.
 * Returns -1 if unmatched.
 */
function findMatchingBracket(src, openIdx) {
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const openCh = src[openIdx]
  const closeCh = pairs[openCh]
  const n = src.length
  let depth = 0
  let i = openIdx
  while (i < n) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === openCh) {
      depth++
    } else if (c === closeCh) {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/**
 * Extract the full text (signature through matching closing brace) of
 * the named top-level function from `src`. Returns `null` if there is
 * not EXACTLY one `function <name>(` declaration (0 = not found, 2+ =
 * ambiguous — both are refused rather than guessing), or if the
 * parameter list / body braces don't balance.
 *
 * The body's opening brace is the first `{` found after the parameter
 * list's closing `)` at ANGLE-BRACKET depth 0. This matters because a
 * return-type annotation can itself contain a brace before the real body
 * starts — `scanLiteralFolded` is pinned with exactly this shape,
 * `): Array<{ start: number; end: number }> {`. Without tracking angle
 * depth, the first `{` seen is the one inside `Array<{ ... }>`, and its
 * matching `}` closes on the same line — the extracted (and hashed) text
 * would be signature-only, with the entire real body outside the hash and
 * every mutation to it invisible to this guard. A `{` seen while
 * angle-depth is 0 opens the body; a `{` seen while angle-depth > 0 opens
 * a type-literal nested inside a generic argument, so it is skipped over
 * via its own matching brace instead of ending the scan.
 *
 * Remaining limitation (documented, not silently wrong, NOT fixed by the
 * angle-depth tracking above): a return-type object-type literal with NO
 * enclosing angle brackets (`): { a: string } {`) still isn't
 * distinguished from the real body — angle-depth never leaves 0 for
 * either brace, so the first one (the type literal, not the body) is
 * still taken as the body open. This is the SAME fail-open shape as the
 * bug above: the truncated text hashes stably, a pin generated from it is
 * self-consistently green today, and stays green through arbitrary body
 * drift. No function this guard currently pins has that shape (verified
 * by hand against every pinned signature); a future pin that does would
 * need a smarter scanner — this extractor only disambiguates a brace
 * that is nested inside `< >`, not one written directly after `):` with
 * no generic wrapper.
 */
function extractFunction(src, name) {
  // All matching/bracket-depth work happens on the comment-stripped view —
  // `stripComments` preserves length and newlines, so every offset found in
  // `stripped` is a valid offset into `src` too. The text ultimately sliced
  // out is from `src`, so extracted (and hashed) text keeps its real
  // comments; only the STRUCTURE search ignores them.
  const stripped = stripComments(src)
  const sigRe = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`,
    'g',
  )
  const matches = [...stripped.matchAll(sigRe)]
  if (matches.length !== 1) {
    return {
      text: null,
      matchCount: matches.length,
      otherForm: matches.length === 0 && nameAppearsInOtherForm(stripped, name),
    }
  }

  const m = matches[0]
  // Start of the actual declaration (skip the leading \n / whitespace the
  // regex consumed so the extracted text starts at `export`/`function`).
  const declStart = m.index + m[0].indexOf(m[0].trimStart())
  const openParenIdx = m.index + m[0].length - 1
  const closeParenIdx = findMatchingBracket(stripped, openParenIdx)
  if (closeParenIdx === -1) return { text: null, matchCount: matches.length }

  // Scan forward from the closing paren for the body's opening brace,
  // skipping over a return-type annotation. Track angle-bracket depth: a
  // `{` seen while depth is 0 opens the body; a `{` seen while depth > 0
  // opens an object-type literal nested inside a generic return type
  // (`Array<{ start: number; end: number }>`) and is skipped over via its
  // own matching brace instead of being mistaken for the body — see the
  // doc comment above for the case this guards against and the shape it
  // still doesn't handle.
  let i = closeParenIdx + 1
  let angleDepth = 0
  let bodyOpen = -1
  while (i < stripped.length) {
    const c = stripped[i]
    if (c === '<') {
      angleDepth++
      i++
      continue
    }
    if (c === '>') {
      if (angleDepth > 0) angleDepth--
      i++
      continue
    }
    if (c === '{') {
      if (angleDepth === 0) {
        bodyOpen = i
        break
      }
      const nestedClose = findMatchingBracket(stripped, i)
      if (nestedClose === -1) return { text: null, matchCount: matches.length }
      i = nestedClose + 1
      continue
    }
    i++
  }
  if (bodyOpen === -1) return { text: null, matchCount: matches.length }
  const bodyClose = findMatchingBracket(stripped, bodyOpen)
  if (bodyClose === -1) return { text: null, matchCount: matches.length }

  return { text: src.slice(declStart, bodyClose + 1), matchCount: matches.length }
}

/** Escape a string for safe interpolation into a `RegExp` source. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * When `extractFunction` finds zero plain `function <name>(` declarations,
 * check whether `name` nonetheless appears in some OTHER form this guard
 * doesn't extract — a generic signature (`function name<T>(`), a default
 * export (`export default function name(`), or a const/let/var assignment
 * (arrow-function refactor). Used only to pick a more accurate message;
 * doesn't change pass/fail (still fails closed either way).
 */
function nameAppearsInOtherForm(stripped, name) {
  const escaped = escapeRegExp(name)
  const otherFormRe = new RegExp(
    `function\\s+${escaped}\\s*<` +
      `|export\\s+default\\s+function\\s+${escaped}\\s*\\(` +
      `|\\b(?:const|let|var)\\s+${escaped}\\s*=`,
  )
  return otherFormRe.test(stripped)
}

/** Collapse whitespace runs to a single space and trim — reformatting-tolerant, token-sensitive. */
function canonicalize(text) {
  return text.replace(/\s+/g, ' ').trim()
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

// ─── pin discovery ──────────────────────────────────────────────────

/**
 * Replace string/template literal CONTENTS (quotes included) with
 * equal-length whitespace, preserving newlines and length — the mirror
 * image of `stripComments` (which blanks comments and preserves strings;
 * this preserves comments and blanks strings). Used before pin-line
 * matching so a pin-shaped line living inside a template literal or
 * string (data, not a real marker) is not mistaken for a real pin, while
 * a genuine pin inside a `//` or JSDoc-block comment is left untouched.
 *
 * Comment lines/blocks are copied through as whole slices (jumping `i`
 * straight to the end of the line, or to the closing star-slash), never
 * scanned character-by-character for quotes. That matters because this
 * codebase's
 * comment style routinely uses a single backtick for an inline
 * `` `identifier` `` reference — an odd count of naked backticks per
 * comment. Scanning a comment char-by-char for quotes (as an earlier,
 * broken version of this function did) misreads such a backtick as
 * opening a template literal, then hunts forward — through subsequent
 * comment lines, potentially past real pin markers — for a closing
 * backtick that has nothing to do with it, blanking everything in
 * between. Slicing whole comments out first, before any quote scanning
 * begins, avoids that entirely.
 */
function blankStringsAndTemplates(src) {
  const n = src.length
  let out = ''
  let i = 0
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === '/' && c2 === '/') {
      let j = i
      while (j < n && src[j] !== '\n') j++
      out += src.slice(i, j)
      i = j
      continue
    }
    if (c === '/' && c2 === '*') {
      let j = i + 2
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++
      j = Math.min(j + 2, n)
      out += src.slice(i, j)
      i = j
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const j = skipString(src, i)
      out += src.slice(i, j).replace(/[^\n]/g, ' ')
      i = j
      continue
    }
    out += c
    i++
  }
  return out
}

function findPins(harnessSrc) {
  const blanked = blankStringsAndTemplates(harnessSrc)
  return blanked
    .split('\n')
    .map((line, idx) => ({ line, lineNo: idx + 1 }))
    .map(({ line, lineNo }) => {
      const m = line.match(PIN_RE)
      return m ? { lineNo, sourcePath: m[1], functionName: m[2], expectedHash: m[3] } : null
    })
    .filter((x) => x !== null)
}

/**
 * Thrown by `checkTree` when the repo layout itself is wrong (the harness
 * directory is missing) rather than a pin being missing or stale. Kept
 * distinct from a `violations` entry so `runGuard` can exit 2, matching
 * this file's own documented exit code for "repo layout ... failure" —
 * an empty `{ violations: [] }` would otherwise print `OK: 0 ... 0 ...`
 * and exit 0, silently disarming the whole gate if `scripts/
 * mutation-harnesses/` is ever moved or renamed.
 */
class LayoutError extends Error {}

/**
 * Check every harness file under `harnessDir` against `root`. Returns
 * `{ violations, harnessCount, pinCount }`. `violations` is
 * `[{ harness, message }]`, one per problem found (a harness may
 * contribute more than one, or contribute a single "no pins" violation).
 * Pure over the filesystem so the self-test can point it at a synthetic
 * tree. Throws `LayoutError` if `harnessDir` itself doesn't exist.
 */
function checkTree({ root, harnessDir }) {
  const violations = []
  let harnessCount = 0
  let pinCount = 0

  if (!fs.existsSync(harnessDir)) {
    throw new LayoutError(
      `harness directory not found: ${path.relative(root, harnessDir) || harnessDir} — has ` +
        'scripts/mutation-harnesses/ been moved or renamed? (an empty tree here would otherwise ' +
        'report "OK: 0 pins across 0 harness files" and exit 0, silently disarming this whole gate)',
    )
  }

  // realpath the root once, for the symlink-escape check below (a pinned
  // source path can be lexically inside the repo yet resolve, through a
  // symlink, to somewhere outside it).
  const realRoot = fs.realpathSync(root)

  // { recursive: true } (Node >=20) so a harness placed in a subdirectory
  // of scripts/mutation-harnesses/ is still discovered and required to
  // carry a pin, instead of silently never being checked.
  const files = fs
    .readdirSync(harnessDir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.harness.ts'))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .toSorted()

  for (const harnessFile of files) {
    harnessCount += 1
    const relHarness = path.relative(root, harnessFile).split(path.sep).join('/')
    const harnessSrc = fs.readFileSync(harnessFile, 'utf8')
    const pins = findPins(harnessSrc)

    if (pins.length === 0) {
      violations.push({
        harness: relHarness,
        message:
          'no mutation-harness-source-pin marker found — this clone has no gate against drift',
      })
      continue
    }

    for (const pin of pins) {
      pinCount += 1
      const sourceFile = path.join(root, pin.sourcePath)
      const relToRoot = path.relative(root, sourceFile)
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
        violations.push({
          harness: relHarness,
          message: `${relHarness}:${pin.lineNo} pins ${pin.sourcePath}#${pin.functionName}, which resolves outside the repo root — refusing to read it`,
        })
        continue
      }
      // Existence, file-ness, symlink containment and the read all happen
      // against ONE open descriptor rather than four lookups of the same
      // path. Checking a path and then reading it is a TOCTOU race
      // (`js/file-system-race`): between the checks and the read the name
      // can be repointed, so the thing validated and the thing read are not
      // guaranteed to be the same inode. Opening first and validating the
      // descriptor closes that — `fstat` and the read cannot disagree about
      // which file they mean.
      //
      // `realpathSync` still takes a path, but it runs while we hold the fd,
      // and its answer is only used to reject; a repoint between open and
      // realpath can make us refuse a legitimate file, never accept an
      // illegitimate one. Failing closed under a race is the correct
      // direction for a guard.
      let fd
      try {
        fd = fs.openSync(sourceFile, 'r')
      } catch (err) {
        violations.push({
          harness: relHarness,
          message:
            err.code === 'ENOENT'
              ? `${relHarness}:${pin.lineNo} pins ${pin.sourcePath}#${pin.functionName}, but ${pin.sourcePath} does not exist`
              : `${relHarness}:${pin.lineNo} pins ${pin.sourcePath}#${pin.functionName}, but ${pin.sourcePath} could not be opened (${err.code ?? err.message})`,
        })
        continue
      }
      let sourceSrc
      try {
        // `existsSync` would have been true for a directory too, and reading
        // one throws an uncaught EISDIR instead of the intended violation.
        if (!fs.fstatSync(fd).isFile()) {
          violations.push({
            harness: relHarness,
            message: `${relHarness}:${pin.lineNo} pins ${pin.sourcePath}#${pin.functionName}, but ${pin.sourcePath} is a directory, not a file`,
          })
          continue
        }
        // The lexical containment check above (`path.relative` on the
        // unresolved path) catches a `../`-escaping pin path, but not a
        // symlink that sits inside the repo and points outside it.
        const realSourceFile = fs.realpathSync(sourceFile)
        const relRealToRoot = path.relative(realRoot, realSourceFile)
        if (relRealToRoot.startsWith('..') || path.isAbsolute(relRealToRoot)) {
          violations.push({
            harness: relHarness,
            message: `${relHarness}:${pin.lineNo} pins ${pin.sourcePath}#${pin.functionName}, which is a symlink resolving outside the repo root — refusing to read it`,
          })
          continue
        }
        sourceSrc = fs.readFileSync(fd, 'utf8')
      } finally {
        fs.closeSync(fd)
      }
      const { text, matchCount, otherForm } = extractFunction(sourceSrc, pin.functionName)
      if (text === null) {
        let message
        if (matchCount === 0 && otherForm) {
          message =
            `${relHarness}:${pin.lineNo} pins ${pin.sourcePath}#${pin.functionName} — the name is ` +
            `present in that file, but not as a plain \`function ${pin.functionName}(...)\` declaration ` +
            '(a generic signature, `export default function`, or a const/let/var arrow-function form ' +
            "would all look like this). This guard only extracts plain function declarations; if that's " +
            "what happened, either revert the refactor or extend the guard — don't read this as " +
            '"renamed or removed."'
        } else if (matchCount === 0) {
          message = `${relHarness}:${pin.lineNo} pins ${pin.sourcePath}#${pin.functionName}, but no such function exists there anymore (renamed or removed — the clone is orphaned)`
        } else {
          message = `${relHarness}:${pin.lineNo} pins ${pin.sourcePath}#${pin.functionName}, which is ambiguous (${matchCount} matches) or has unbalanced brackets`
        }
        violations.push({ harness: relHarness, message })
        continue
      }
      const actualHash = sha256hex(canonicalize(text))
      if (actualHash !== pin.expectedHash) {
        violations.push({
          harness: relHarness,
          message:
            `${relHarness}:${pin.lineNo} — ${pin.sourcePath}#${pin.functionName} has changed since ` +
            `this harness's clone was last verified (expected sha256=${pin.expectedHash}, ` +
            `got sha256=${actualHash}). Re-sync the hand-copied clone in the harness against the ` +
            `current source, then update the pin.`,
        })
      }
    }
  }

  return { violations, harnessCount, pinCount }
}

// ─── main ───────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  runGuard()
}

function runGuard() {
  let result
  try {
    result = checkTree({ root: ROOT, harnessDir: HARNESS_DIR })
  } catch (err) {
    if (err instanceof LayoutError) {
      console.error(`ERROR: ${err.message}`)
      process.exit(2)
    }
    throw err
  }
  const { violations, harnessCount, pinCount } = result

  if (violations.length > 0) {
    console.error(
      'ERROR: mutation-harness clone(s) have drifted from (or lack a pin to) their source:',
    )
    console.error('')
    for (const v of violations) {
      console.error(`  ${v.message}`)
    }
    console.error('')
    console.error(
      'Each scripts/mutation-harnesses/*.harness.ts hand-clones the function it sweeps; a ' +
        '`// mutation-harness-source-pin: <path>#<fn> sha256=<hex>` marker ties that clone to the ' +
        "source it was copied from. See the guard's own header comment (scripts/check-mutation-harness-clones.mjs).",
    )
    process.exit(1)
  }

  console.log(
    `OK: ${pinCount} source-pin(s) across ${harnessCount} harness file(s) all match their source`,
  )
}

// ─── self-test ──────────────────────────────────────────────────────
//
// Drives extractFunction()/checkTree() against synthetic fixtures in a
// temp dir so the guard's own exit behavior is verified: a matching pin
// PASSES, a source edit inside the pinned function FAILS, restoring it
// PASSES again, whitespace-only reformatting inside the function PASSES
// (canonicalization), an edit OUTSIDE the pinned function (a sibling
// function, or a comment before/after) does NOT trip the guard (proves
// the extraction boundary is scoped to the named function, not the
// whole file), a harness with no pin at all FAILS, a pin naming a
// missing source file FAILS, and a pin naming a function that no longer
// exists in the source FAILS.
function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  // ── extractFunction() boundary cases ───────────────────────────────

  const src1 = `
export function before() {
  return 1
}

export function target(a: number, b: string): number {
  const x = a + 1
  return x
}

export function after() {
  return 2
}
`
  const ext1 = extractFunction(src1, 'target')
  if (ext1.text && ext1.text.includes('const x = a + 1') && !ext1.text.includes('before')) {
    ok('extracts exactly the named function, not neighbors')
  } else {
    fail('extracts exactly the named function, not neighbors', JSON.stringify(ext1))
  }

  const extMissing = extractFunction(src1, 'nonexistent')
  if (extMissing.text === null && extMissing.matchCount === 0) {
    ok('missing function name yields matchCount 0')
  } else {
    fail('missing function name yields matchCount 0', JSON.stringify(extMissing))
  }

  const srcDup = `export function dup() { return 1 }\nexport function dup() { return 2 }\n`
  const extDup = extractFunction(srcDup, 'dup')
  if (extDup.text === null && extDup.matchCount === 2) {
    ok('ambiguous (2+) function name is refused, not guessed')
  } else {
    fail('ambiguous (2+) function name is refused, not guessed', JSON.stringify(extDup))
  }

  // Regression: a comment containing a backslash immediately before a
  // backtick (this guard's real-world trigger — inline-property-parse.ts's
  // `stripPropertyLines` has exactly this in a doc comment) must not be
  // misread as an escaped-backtick opening an unterminated template
  // literal, which would desync bracket-depth tracking for the rest of the
  // function and either mis-extract or fail to find the real closing brace.
  const srcCommentBacktick = `
export function withTrickyComment(a: number): number {
  // a marker like (\`literal\\\` + more text) should not confuse the scanner
  const x = a + 1
  return x
}
`
  const extTricky = extractFunction(srcCommentBacktick, 'withTrickyComment')
  if (
    extTricky.text &&
    extTricky.text.trim().endsWith('}') &&
    extTricky.text.includes('return x')
  ) {
    ok('a backslash-before-backtick inside a comment does not desync extraction')
  } else {
    fail(
      'a backslash-before-backtick inside a comment does not desync extraction',
      JSON.stringify(extTricky),
    )
  }

  // Regression (the #3951 review blocker): an object-type literal nested
  // inside a generic return-type annotation — `): Array<{ a: number }> {`,
  // exactly `scanLiteralFolded`'s real shape — must not be mistaken for
  // the body. Before the angle-bracket-depth fix, the first `{` seen (the
  // one inside `Array<{ ... }>`) was taken as the body open and its
  // same-line matching `}` as the body close, so the extracted text was
  // signature-only and every real statement in the body (the `push` call
  // below) fell outside it, silently.
  const srcGenericReturn = `
export function scanExample(
  text: string,
  flag: boolean,
): Array<{ a: number }> {
  const out: Array<{ a: number }> = []
  if (flag) {
    out.push({ a: text.length })
  }
  return out
}
`
  const extGeneric = extractFunction(srcGenericReturn, 'scanExample')
  if (
    extGeneric.text &&
    extGeneric.text.includes('out.push({ a: text.length })') &&
    extGeneric.text.trim().endsWith('\n}')
  ) {
    ok(
      'an object-type literal inside a generic return type (`Array<{ a: number }>`) does not truncate extraction to the signature',
    )
  } else {
    fail(
      'an object-type literal inside a generic return type (`Array<{ a: number }>`) does not truncate extraction to the signature',
      JSON.stringify(extGeneric),
    )
  }

  // ── canonicalize() reformatting tolerance ──────────────────────────

  const reformatted = `
export function     target(a: number, b: string): number {
  const x =
    a +
    1
  return x
}
`
  const h1 = sha256hex(canonicalize(ext1.text))
  const h2 = sha256hex(canonicalize(extractFunction(reformatted, 'target').text))
  if (h1 === h2) {
    ok('whitespace-only reformatting does not change the canonical hash')
  } else {
    fail('whitespace-only reformatting does not change the canonical hash', `${h1} vs ${h2}`)
  }

  const tokenChanged = `
export function target(a: number, b: string): number {
  const x = a + 2
  return x
}
`
  const h3 = sha256hex(canonicalize(extractFunction(tokenChanged, 'target').text))
  if (h3 !== h1) {
    ok('a real token change (a + 1 -> a + 2) changes the canonical hash')
  } else {
    fail('a real token change (a + 1 -> a + 2) changes the canonical hash', `${h1} vs ${h3}`)
  }

  // ── checkTree() end-to-end, on a synthetic filesystem ──────────────

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-harness-clones-selftest-'))
  try {
    const srcDir = path.join(tmp, 'src', 'lib')
    const harnessDir = path.join(tmp, 'scripts', 'mutation-harnesses')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.mkdirSync(harnessDir, { recursive: true })

    const sourceRel = 'src/lib/example.ts'
    const writeSource = (bodyLine) =>
      fs.writeFileSync(
        path.join(tmp, sourceRel),
        `// unrelated leading comment\nexport function example(n: number): number {\n  ${bodyLine}\n}\n// unrelated trailing comment\n`,
      )

    const pinHashFor = (bodyLine) => {
      writeSource(bodyLine)
      const s = fs.readFileSync(path.join(tmp, sourceRel), 'utf8')
      return sha256hex(canonicalize(extractFunction(s, 'example').text))
    }

    const originalBody = 'return n + 1'
    const originalHash = pinHashFor(originalBody)

    const harnessPath = path.join(harnessDir, 'example.harness.ts')
    const writeHarness = (hash) =>
      fs.writeFileSync(
        harnessPath,
        `// mutation-harness-source-pin: ${sourceRel}#example sha256=${hash}\nexport {}\n`,
      )

    // Case 1: matching pin passes.
    writeSource(originalBody)
    writeHarness(originalHash)
    let r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 0 && r.pinCount === 1) {
      ok('matching pin passes cleanly')
    } else {
      fail('matching pin passes cleanly', JSON.stringify(r.violations))
    }

    // Case 1b: the same pin, but written as a `/** ... */` JSDoc line
    // (leading ` * `) instead of a standalone `//` comment — must also pass,
    // and a bare `*/` closer line must not be misread as a marker line.
    fs.writeFileSync(
      harnessPath,
      `/**\n * mutation-harness-source-pin: ${sourceRel}#example sha256=${originalHash}\n */\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 0 && r.pinCount === 1) {
      ok('a pin written inside a JSDoc block comment also passes')
    } else {
      fail('a pin written inside a JSDoc block comment also passes', JSON.stringify(r.violations))
    }
    writeHarness(originalHash) // back to the plain `//` form for the rest

    // Case 2: DRIFT — edit the pinned function's source, pin stays stale. Must FAIL.
    writeSource('return n + 2')
    r = checkTree({ root: tmp, harnessDir })
    if (
      r.violations.length === 1 &&
      r.violations[0].message.includes('has changed since') &&
      r.violations[0].message.includes('example.harness.ts:1')
    ) {
      ok('a source edit inside the pinned function FAILS the gate')
    } else {
      fail('a source edit inside the pinned function FAILS the gate', JSON.stringify(r.violations))
    }

    // Case 3: RESTORE — revert the source. Must PASS again.
    writeSource(originalBody)
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 0) {
      ok('restoring the source PASSES the gate again')
    } else {
      fail('restoring the source PASSES the gate again', JSON.stringify(r.violations))
    }

    // Case 4: edit OUTSIDE the pinned function (leading comment) must NOT trip it.
    fs.writeFileSync(
      path.join(tmp, sourceRel),
      `// a totally different leading comment now\nexport function example(n: number): number {\n  ${originalBody}\n}\n// unrelated trailing comment\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 0) {
      ok('an edit outside the pinned function body does not trip the gate')
    } else {
      fail(
        'an edit outside the pinned function body does not trip the gate',
        JSON.stringify(r.violations),
      )
    }
    writeSource(originalBody) // restore for subsequent cases

    // Case 5: harness with NO pin at all must FAIL.
    fs.writeFileSync(harnessPath, `export {}\n`)
    r = checkTree({ root: tmp, harnessDir })
    if (
      r.violations.length === 1 &&
      r.violations[0].message.includes('no mutation-harness-source-pin')
    ) {
      ok('a harness with no source-pin marker FAILS')
    } else {
      fail('a harness with no source-pin marker FAILS', JSON.stringify(r.violations))
    }

    // Case 6: pin naming a MISSING source file must FAIL.
    writeHarness(originalHash)
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: src/lib/does-not-exist.ts#example sha256=${originalHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 1 && r.violations[0].message.includes('does not exist')) {
      ok('a pin naming a missing source file FAILS')
    } else {
      fail('a pin naming a missing source file FAILS', JSON.stringify(r.violations))
    }

    // Case 7: pin naming a function no longer present (renamed away) must FAIL.
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: ${sourceRel}#renamedAway sha256=${originalHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 1 && r.violations[0].message.includes('no such function exists')) {
      ok('a pin naming a function absent from the source FAILS')
    } else {
      fail('a pin naming a function absent from the source FAILS', JSON.stringify(r.violations))
    }

    // Case 8: a pinned function name ending in `$` must still match — `$`
    // is a valid identifier character but a regex metacharacter, so an
    // unescaped interpolation would compile `function\s+foo$\s*\(`, which
    // can never match (anchors end-of-string before the literal `(` it
    // still expects) and would misreport "renamed or removed" even though
    // the function is right there, unchanged.
    fs.writeFileSync(
      path.join(tmp, sourceRel),
      `export function example$(n: number): number {\n  return n + 1\n}\n`,
    )
    const dollarHash = sha256hex(
      canonicalize(
        extractFunction(fs.readFileSync(path.join(tmp, sourceRel), 'utf8'), 'example$').text,
      ),
    )
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: ${sourceRel}#example$ sha256=${dollarHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 0) {
      ok(
        'a pinned function name ending in `$` is matched (regex-escaped), not misreported as orphaned',
      )
    } else {
      fail(
        'a pinned function name ending in `$` is matched (regex-escaped), not misreported as orphaned',
        JSON.stringify(r.violations),
      )
    }
    writeSource(originalBody) // restore for subsequent cases

    // Case 9: a pin whose `sourcePath` escapes the repo root via `../` must
    // FAIL closed (refusing to read outside the repo), not silently resolve
    // and read whatever file happens to sit there.
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: ../../../../../../etc/passwd#example sha256=${originalHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 1 && r.violations[0].message.includes('outside the repo root')) {
      ok('a pin path escaping the repo root via `../` is rejected, not read')
    } else {
      fail(
        'a pin path escaping the repo root via `../` is rejected, not read',
        JSON.stringify(r.violations),
      )
    }
    writeHarness(originalHash) // restore for subsequent cases

    // Case 10: a name present only as a const-arrow / generic-signature /
    // default-export form (not a plain `function name(`) gets a distinct
    // "found it, but not as a plain function declaration" message instead
    // of being misdiagnosed as "renamed or removed".
    fs.writeFileSync(
      path.join(tmp, sourceRel),
      `export const example = (n: number): number => {\n  return n + 1\n}\n`,
    )
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: ${sourceRel}#example sha256=${originalHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (
      r.violations.length === 1 &&
      r.violations[0].message.includes('not as a plain') &&
      !r.violations[0].message.includes('the clone is orphaned')
    ) {
      ok('a const-arrow form of the pinned name gets its own message, not "renamed or removed"')
    } else {
      fail(
        'a const-arrow form of the pinned name gets its own message, not "renamed or removed"',
        JSON.stringify(r.violations),
      )
    }
    writeSource(originalBody) // restore for subsequent cases

    // Case 11: a pin naming a DIRECTORY (not a file) must be reported as
    // the intended violation, not crash with an uncaught EISDIR.
    const dirAsSource = path.join(tmp, 'src', 'lib', 'a-directory')
    fs.mkdirSync(dirAsSource, { recursive: true })
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: src/lib/a-directory#example sha256=${originalHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 1 && r.violations[0].message.includes('directory, not a file')) {
      ok('a pin naming a directory FAILS with a message, not an uncaught EISDIR')
    } else {
      fail(
        'a pin naming a directory FAILS with a message, not an uncaught EISDIR',
        JSON.stringify(r.violations),
      )
    }
    writeHarness(originalHash) // restore for subsequent cases

    // Case 12: a pin whose `sourcePath` is lexically inside the repo but
    // is a SYMLINK resolving outside it must FAIL closed (mirrors case 9,
    // but for a symlink escape instead of a `../` escape — a lexical-only
    // containment check passes a symlink straight through).
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-harness-clones-outside-'))
    try {
      const outsideFile = path.join(outsideDir, 'secret.ts')
      fs.writeFileSync(outsideFile, `export function example(n: number): number {\n  return n\n}\n`)
      const symlinkRel = 'src/lib/escape-link.ts'
      fs.symlinkSync(outsideFile, path.join(tmp, symlinkRel))
      fs.writeFileSync(
        harnessPath,
        `// mutation-harness-source-pin: ${symlinkRel}#example sha256=${originalHash}\nexport {}\n`,
      )
      r = checkTree({ root: tmp, harnessDir })
      if (
        r.violations.length === 1 &&
        r.violations[0].message.includes('symlink resolving outside the repo root')
      ) {
        ok('a pin path that is a symlink resolving outside the repo root is rejected, not read')
      } else {
        fail(
          'a pin path that is a symlink resolving outside the repo root is rejected, not read',
          JSON.stringify(r.violations),
        )
      }
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
    writeHarness(originalHash) // restore for subsequent cases

    // Case 13: a harness placed in a SUBDIRECTORY of `scripts/
    // mutation-harnesses/` must still be discovered and required to carry
    // a pin — `readdirSync` without `{ recursive: true }` would silently
    // skip it, leaving it un-gated forever.
    const nestedHarnessDir = path.join(harnessDir, 'nested')
    fs.mkdirSync(nestedHarnessDir, { recursive: true })
    fs.writeFileSync(path.join(nestedHarnessDir, 'nested.harness.ts'), `export {}\n`)
    r = checkTree({ root: tmp, harnessDir })
    if (
      r.harnessCount === 2 &&
      r.violations.some(
        (v) =>
          v.harness.endsWith('nested/nested.harness.ts') &&
          v.message.includes('no mutation-harness-source-pin'),
      )
    ) {
      ok('a harness in a subdirectory of scripts/mutation-harnesses/ is discovered and gated')
    } else {
      fail(
        'a harness in a subdirectory of scripts/mutation-harnesses/ is discovered and gated',
        JSON.stringify({ harnessCount: r.harnessCount, violations: r.violations }),
      )
    }
    fs.rmSync(nestedHarnessDir, { recursive: true, force: true })

    // Case 14: a pin-SHAPED line living inside a template literal (data,
    // not a real marker — e.g. a code sample embedded in a console.log)
    // must not be parsed as a real pin.
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: ${sourceRel}#example sha256=${originalHash}\n` +
        `export const sample = \`\n// mutation-harness-source-pin: src/lib/does-not-exist.ts#nope sha256=${'0'.repeat(64)}\n\`\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 0 && r.pinCount === 1) {
      ok('a pin-shaped line inside a template literal is not parsed as a real pin')
    } else {
      fail(
        'a pin-shaped line inside a template literal is not parsed as a real pin',
        JSON.stringify(r),
      )
    }
    writeHarness(originalHash) // restore for subsequent cases
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  // Case 15: a MISSING harness directory (moved/renamed) must fail the
  // repo-layout check rather than being read as "zero harnesses, zero
  // pins, all clean" — silently disarming the whole gate. `checkTree`
  // must throw `LayoutError`, not return an empty, all-clear result.
  const tmpNoHarnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-harness-clones-nodir-'))
  try {
    const missingHarnessDir = path.join(tmpNoHarnessDir, 'scripts', 'mutation-harnesses')
    let threw = null
    try {
      checkTree({ root: tmpNoHarnessDir, harnessDir: missingHarnessDir })
    } catch (err) {
      threw = err
    }
    if (threw instanceof LayoutError) {
      ok('a missing harness directory throws LayoutError instead of reporting a silent all-clear')
    } else {
      fail(
        'a missing harness directory throws LayoutError instead of reporting a silent all-clear',
        threw ? String(threw) : 'checkTree returned normally instead of throwing',
      )
    }
  } finally {
    fs.rmSync(tmpNoHarnessDir, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}
