#!/usr/bin/env node
// #3722 meta-guard — fixing ONE script that runs git in a throwaway fixture
// does not fix the CLASS. Four scripts have now independently reinvented the
// same scrub for the same reason (#3690, then this script's own history in
// check-migrations-immutable.sh / test-related-rust.sh / check-sqlx-cache-drift.sh
// / check-session-log-numbering.sh, then #3736 for a FIFTH, unprotected
// script — pr-overlap-diverged.sh — before it was migrated to the shared
// helper). Each private copy protected only the one script that carried it;
// the next self-test author had no way to know the pattern existed, wrote
// their own throwaway `git -C <dir> init`, and reproduced the incident.
//
// scripts/lib/git-scratch-guard.sh is the shared fix (`git_scratch_guard` +
// `git_scratch_init`). This script is the thing that makes it STICK: it
// scans every shell script under scripts/ and fails the commit if either —
//
//   1. it hand-rolls its own `unset ... GIT_DIR ...` scrub instead of
//      sourcing the shared helper (the exact shape of all four incidents:
//      "smart enough to know about the danger, but reinventing the fix"), or
//   2. it runs `git init` / `git -C <dir> init` — the fixture-creating
//      command that is unsafe under an inherited GIT_DIR — without sourcing
//      the shared helper AT ALL (the "never learned about the danger"
//      shape: pr-overlap-diverged.sh before #3724).
//
// scripts/lib/git-scratch-guard.sh itself is exempt from both checks — it IS
// the canonical implementation of `git init` inside a fixture, and the one
// place allowed to contain a raw `unset` of these variables (the scrub loop
// itself, plus a deliberately UNGUARDED demonstration inside its own
// self-test, proving the incident is real rather than hypothetical).
//
// Deliberately grep-based, not a real shell parser (matching the issue's own
// suggested fix: "a meta-guard that greps hook scripts and self-tests for
// git invocations"). Two known, deliberately-accepted gaps:
//
//   * It cannot prove a script calls `git_scratch_guard` BEFORE its first
//     git command — only that the file sources the helper somewhere. That
//     is a real gap, but the alternative (parsing bash control flow) is a
//     much bigger tool for a problem four independent one-off patches
//     already show is dominated by "nobody sourced the shared code at all",
//     not by subtle ordering bugs in scripts that did.
//   * The `git init` detector is a literal-text match on the word `git`
//     adjacent to `init`. A script that indirects the command name through
//     a variable (`GITBIN=git; "$GITBIN" -C "$dir" init`) or an alias is
//     invisible to it and passes uncaught, hand-rolled scrub or not.
//     Textual regexes cannot generally defeat deliberate obfuscation;
//     closing this needs a real shell parser (see the point above) and is
//     not attempted here. If this is ever hit for real, it is evidence the
//     grep-based approach has reached its limit, not a bug in this file.
//
// Usage:
//   node scripts/check-git-fixture-isolation.mjs
//   node scripts/check-git-fixture-isolation.mjs --self-test
//
// Exit codes: 0 = every fixture-building script is wired through the shared
// guard; 1 = at least one is not (or the wiring itself looks broken);
// 2 = self-test failure.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

const SCRIPTS_DIR = join(import.meta.dirname)
// The one file exempt from both checks — see the header.
const SHARED_GUARD_BASENAME = 'git-scratch-guard.sh'
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '__pycache__', '.git'])

// ---------------------------------------------------------------------------
// Text-level detection
// ---------------------------------------------------------------------------

/** Drop whole-line `#` comments — a comment merely NAMING `git init` or
 * `GIT_DIR` in prose (every migrated script's docstring does this, on
 * purpose, to explain the incident) must not be mistaken for the code this
 * guard actually cares about. */
export function stripLineComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

/** Bash line-continuation (`\` at end of line) joined to one logical line,
 * so a multi-line `unset FOO BAR \` + `  BAZ` statement is inspected whole
 * rather than missed because the interesting variable is on the second
 * physical line. */
function joinContinuations(text) {
  return text.replace(/\\\r?\n/g, ' ')
}

const GIT_ENV_VAR_RE =
  /\b(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_COMMON_DIR|GIT_NAMESPACE)\b/

/**
 * A hand-rolled scrub: a bash `unset` statement naming at least one of the
 * git-context variables that outrank `git -C <dir>` (#3722). This is what
 * every one of the four incidents' fixes looked like BEFORE being migrated
 * to the shared helper — each is a legitimate, working scrub, and each is
 * exactly the private copy this guard exists to stop from reappearing.
 */
export function hasHandRolledGitEnvUnset(text) {
  const joined = joinContinuations(text)
  return joined.split('\n').some((line) => /^\s*unset\b/.test(line) && GIT_ENV_VAR_RE.test(line))
}

/**
 * A fixture-creating `git init`, bare or `-C`-scoped — the command that is
 * unsafe under an inherited GIT_DIR. Comments are stripped first (see
 * `stripLineComments`), and continuations are joined (mirroring
 * `hasHandRolledGitEnvUnset`) — `git -C "$dir" \` + `  init` is the same
 * unsafe command split across a line break, and a scanner that joins one
 * detector's continuations but not the other's is itself an evasion.
 */
export function hasFixtureGitInit(text) {
  return /\bgit\s+(-C\s+\S+\s+)?init\b/.test(joinContinuations(stripLineComments(text)))
}

/**
 * Whether the file SOURCES the shared helper — a `.` or `source` statement
 * naming it — not merely whether the basename appears anywhere in the file.
 * Comments are stripped first: a docstring explaining the incident and
 * naming `scripts/lib/git-scratch-guard.sh` in prose (every migrated
 * script's header does this) must not be read as evidence the file sources
 * it, and neither must a stray runtime string that happens to contain the
 * basename. Not WHERE relative to the fixture code, see the header's stated
 * limitation.
 */
export function sourcesSharedGuard(text) {
  const escaped = SHARED_GUARD_BASENAME.replace('.', '\\.')
  const nameRe = new RegExp(escaped)
  const lines = joinContinuations(stripLineComments(text)).split('\n')
  return lines.some((line) => {
    const trimmed = line.trim()
    // A dot-command or `source` invocation, as its own statement (allowing a
    // leading `;`/`&&`/`|`/`{` from a compound command). The path argument
    // itself may be an arbitrarily complex `$(...)"..."` expression full of
    // spaces (every real call site in this repo looks like
    // `. "$(dirname "$0")/lib/git-scratch-guard.sh"`), so this only
    // anchors WHERE the statement starts, then checks the basename appears
    // anywhere in that same logical line — not merely anywhere in the file.
    return /^(\.|source)\s+\S/.test(trimmed) && nameRe.test(trimmed)
  })
}

// ---------------------------------------------------------------------------
// Corpus scan
// ---------------------------------------------------------------------------

/** Every `.sh` file under `dir`, recursively, as `{ path, text }` with
 * `path` relative to `dir` (posix-separated, so messages are stable across
 * platforms) — except the shared helper itself, which is exempt (see the
 * header). Sorted for deterministic output. */
export function listShellScripts(dir) {
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name.startsWith('.')) continue
      const full = join(d, entry.name)
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.sh')) continue
      if (entry.name === SHARED_GUARD_BASENAME) continue
      out.push({
        path: relative(dir, full).split(sep).join('/'),
        text: readFileSync(full, 'utf8'),
      })
    }
  }
  walk(dir)
  return out
}

// ---------------------------------------------------------------------------
// Consistency check
// ---------------------------------------------------------------------------

/** Every problem found across `files` (as returned by `listShellScripts`),
 * human-readable — empty means every fixture-building script is wired
 * through the shared guard. */
export function checkFixtureIsolation(files) {
  const problems = []
  for (const { path, text } of files) {
    if (hasHandRolledGitEnvUnset(text)) {
      problems.push(
        `${path}: hand-rolls its own git-environment \`unset\` block instead of sourcing ` +
          'scripts/lib/git-scratch-guard.sh (#3722) — every private copy of this scrub is ' +
          'exactly how the NEXT script goes unprotected. Call `git_scratch_guard` (and ' +
          '`git_scratch_init` for a fresh fixture) from the shared helper instead.',
      )
    }
    if (hasFixtureGitInit(text) && !sourcesSharedGuard(text)) {
      problems.push(
        `${path}: runs \`git init\` / \`git -C <dir> init\` (builds a git fixture) without ` +
          'sourcing scripts/lib/git-scratch-guard.sh at all. A self-test wired as a prek hook ' +
          'runs inside the pre-commit environment, where GIT_DIR / GIT_WORK_TREE / ' +
          'GIT_INDEX_FILE outrank `git -C <dir>` — every fixture command lands on the ' +
          "developer's REAL repository instead (#3722, #3690, #3736).",
      )
    }
  }
  return problems
}

/** Throws with every offending file named, or returns silently. */
export function assertFixtureIsolation({ scriptsDir = SCRIPTS_DIR } = {}) {
  const files = listShellScripts(scriptsDir)
  // Wiring guard (mirrors check-zizmor-version-pin.mjs): if the scan finds
  // no `.sh` files at all, this script fell out of step with the repo — the
  // scripts/ directory is never actually empty of shell scripts — rather
  // than silently reporting "zero problems, zero files checked" forever.
  if (files.length === 0) {
    throw new Error(
      'scripts/check-git-fixture-isolation.mjs found ZERO .sh files under scripts/ — ' +
        'the corpus scan itself is broken (wrong directory? scripts/ restructured?), ' +
        'not a clean repo. Fix the scan before trusting its "clean" verdict.',
    )
  }
  const problems = checkFixtureIsolation(files)
  if (problems.length > 0) {
    throw new Error(
      `scripts/check-git-fixture-isolation.mjs found ${problems.length} script(s) not wired ` +
        `through the shared git-fixture guard (#3722):\n  - ${problems.join('\n  - ')}`,
    )
  }
  return { checked: files.length }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main() {
  const { checked } = assertFixtureIsolation()
  console.log(
    `OK  git fixture isolation: ${checked} shell script(s) under scripts/ checked, ` +
      'none hand-roll a git-environment scrub or build a fixture without ' +
      'scripts/lib/git-scratch-guard.sh',
  )
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

function selfTestDetection({ check }) {
  check(
    hasHandRolledGitEnvUnset('unset GIT_DIR GIT_WORK_TREE\n') === true,
    'a single-line unset naming GIT_DIR is detected',
    '',
  )
  check(
    hasHandRolledGitEnvUnset(
      'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \\\n' +
        '      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR\n',
    ) === true,
    'a multi-line (backslash-continued) unset naming a git var is still detected',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('unset SOME_OTHER_VAR\n') === false,
    'an unset of an unrelated variable is not a false positive',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('# unset GIT_DIR — see the shared helper instead\n') === false,
    'a COMMENT mentioning unset+GIT_DIR (not a real statement) is not flagged',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('echo "GIT_DIR leaks matter" # unset nothing here\n') === false,
    'a line that merely CONTAINS the words is not a match unless it starts with unset',
    '',
  )

  check(hasFixtureGitInit('git init -q -b main .\n') === true, 'a bare `git init` is detected', '')
  check(
    hasFixtureGitInit('git -C "$dir" init -q -b main\n') === true,
    'a `git -C <dir> init` is detected',
    '',
  )
  check(
    hasFixtureGitInit(
      '# When this runs from a git hook, `git init` there is a re-init that rewrites\n' +
        '# core.worktree.\ngit_scratch_init "$tmp"\n',
    ) === false,
    'a comment NARRATING `git init` (every migrated script has one) is not a false positive, ' +
      'and calling the git_scratch_init FUNCTION is not mistaken for the raw command',
    '',
  )
  check(
    hasFixtureGitInit('git commit -qm "no init here"\n') === false,
    'an unrelated git subcommand is not a false positive',
    '',
  )
  check(
    hasFixtureGitInit('git -C "$dir" \\\n  init -q -b main\n') === true,
    'a `git -C <dir> init` split across a backslash line-continuation is still detected ' +
      '(an evasion of the pre-fix regex, which joined continuations for the unset check but not this one)',
    '',
  )

  check(
    sourcesSharedGuard('. "$(dirname "$0")/lib/git-scratch-guard.sh"\n') === true,
    'sourcing the shared helper is detected',
    '',
  )
  check(sourcesSharedGuard('echo hello\n') === false, 'a script that never mentions it is not', '')
  check(
    sourcesSharedGuard(
      '# (See scripts/lib/git-scratch-guard.sh for the "right" way to do this, not that we use it.)\n' +
        'git -C "$tmp" init -q -b main\n',
    ) === false,
    "a COMMENT merely mentioning the helper's filename does not count as sourcing it (a pre-fix " +
      'evasion: naming it in prose disabled the unsourced-fixture-init check entirely)',
    '',
  )
  check(
    sourcesSharedGuard('echo "not sourcing git-scratch-guard.sh here, just naming it"\n') === false,
    'the basename appearing in a non-comment line that is not itself a `.`/`source` statement ' +
      'does not count as sourcing it',
    '',
  )
}

/** `checkFixtureIsolation` against real files on disk, not just parsed
 * strings — proves the file-scan wiring (which path, comment-stripping
 * across a real file) rather than only the per-string regex. */
function selfTestDiskScan({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'git-fixture-isolation-scan-'))
  try {
    // (a) sources the shared guard AND builds a fixture -> clean.
    const good = [
      '#!/usr/bin/env bash',
      "# The fixture must not inherit the caller's git context (git init there",
      '# would be a re-init of the real repo).',
      '. "$(dirname "$0")/lib/git-scratch-guard.sh"',
      'git_scratch_guard "$tmp"',
      'git_scratch_init "$tmp"',
      '',
    ].join('\n')
    // (b) builds a fixture, never sources anything -> the #3736 shape.
    const naive = [
      '#!/usr/bin/env bash',
      'tmp=$(mktemp -d)',
      'git -C "$tmp" init -q -b main',
      '',
    ].join('\n')
    // (c) hand-rolls its own scrub -> the #3690/#3722 shape, even though it
    // also happens to source the helper for something unrelated.
    const reinvented = [
      '#!/usr/bin/env bash',
      '. "$(dirname "$0")/lib/git-scratch-guard.sh"',
      'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE',
      'git -C "$tmp" init -q -b main',
      '',
    ].join('\n')
    // (d) no git fixtures at all -> irrelevant, must not be flagged.
    const unrelated = ['#!/usr/bin/env bash', 'echo "nothing to see here"', ''].join('\n')
    // (e) an adversarial evasion: builds a fixture, sources nothing, but a
    // COMMENT merely names the helper's filename in passing. Before this
    // guard stripped comments from `sourcesSharedGuard`, that comment alone
    // satisfied the "sources it" check and silently disabled detection of
    // the unsourced `git init` right below it.
    const commentMention = [
      '#!/usr/bin/env bash',
      '# (See scripts/lib/git-scratch-guard.sh for the "right" way to do this, not that we use it.)',
      'tmp=$(mktemp -d)',
      'git -C "$tmp" init -q -b main',
      '',
    ].join('\n')
    // (f) another adversarial evasion: the exact same unsafe command as (b),
    // with `init` pushed onto a continuation line. Before this guard joined
    // continuations for `hasFixtureGitInit` too, the regex never saw "init"
    // adjacent to "git" and missed it.
    const continuationSplit = [
      '#!/usr/bin/env bash',
      'tmp=$(mktemp -d)',
      'git -C "$tmp" \\',
      '  init -q -b main',
      '',
    ].join('\n')

    writeFileSync(join(dir, 'good.sh'), good, 'utf8')
    writeFileSync(join(dir, 'naive.sh'), naive, 'utf8')
    writeFileSync(join(dir, 'reinvented.sh'), reinvented, 'utf8')
    writeFileSync(join(dir, 'unrelated.sh'), unrelated, 'utf8')
    writeFileSync(join(dir, 'comment-mention.sh'), commentMention, 'utf8')
    writeFileSync(join(dir, 'continuation-split.sh'), continuationSplit, 'utf8')
    writeFileSync(join(dir, 'not-shell.py'), naive, 'utf8') // wrong extension, ignored
    mkdirSync(join(dir, 'lib'))
    // The shared helper itself, even dropped in a scanned tree, is exempt —
    // it necessarily contains the raw `git init` this guard looks for.
    writeFileSync(
      join(dir, 'lib', 'git-scratch-guard.sh'),
      'git -C "$dir" init -q -b main\nunset GIT_DIR\n',
      'utf8',
    )

    const files = listShellScripts(dir)
    check(
      files.length === 6,
      'the scan finds exactly the six scoped .sh files, excluding the .py file and the shared helper',
      JSON.stringify(files.map((f) => f.path)),
    )

    const problems = checkFixtureIsolation(files)
    check(
      problems.some((p) => p.startsWith('naive.sh:')),
      'a fixture-builder that sources nothing is flagged',
      JSON.stringify(problems),
    )
    check(
      problems.some((p) => p.startsWith('reinvented.sh:')),
      'a fixture-builder with its own hand-rolled unset is flagged EVEN THOUGH it also sources the helper',
      JSON.stringify(problems),
    )
    check(
      !problems.some((p) => p.startsWith('good.sh:')),
      'a fixture-builder that only calls the shared helper is clean',
      JSON.stringify(problems),
    )
    check(
      !problems.some((p) => p.startsWith('unrelated.sh:')),
      'a script with no git fixture at all is clean regardless of what it sources',
      JSON.stringify(problems),
    )
    check(
      problems.some((p) => p.startsWith('comment-mention.sh:')),
      'a fixture-builder that only NAMES the helper in a comment (never sources it) is still flagged',
      JSON.stringify(problems),
    )
    check(
      problems.some((p) => p.startsWith('continuation-split.sh:')),
      'a fixture-builder whose `git -C <dir> init` is split across a line continuation is still flagged',
      JSON.stringify(problems),
    )
    check(
      problems.length === 4,
      'exactly the four offending files are reported, nothing else',
      JSON.stringify(problems),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The wiring guard: zero `.sh` files found is a failure, not a vacuous pass. */
function selfTestWiringGuard({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'git-fixture-isolation-empty-'))
  try {
    let threw = null
    try {
      assertFixtureIsolation({ scriptsDir: dir })
    } catch (err) {
      threw = err
    }
    check(
      threw !== null && /ZERO \.sh files/.test(threw.message),
      'an empty directory (no .sh files at all) fails loud instead of reporting a vacuous clean scan',
      threw ? threw.message : '(no throw)',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The real repo, as it stands right now, must itself be clean — the
 * migration this guard exists to lock in. */
function selfTestRealRepo({ check, fail }) {
  try {
    const { checked } = assertFixtureIsolation()
    check(
      checked >= 5,
      `the real scripts/ tree is checked (found ${checked} .sh files, expected at least 5)`,
      String(checked),
    )
  } catch (err) {
    fail('the real repo is clean under this guard right now', err.message)
  }
}

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok  - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }
  const check = (cond, name, detail) => (cond ? ok(name) : fail(name, detail))

  selfTestDetection({ check })
  selfTestDiskScan({ check })
  selfTestWiringGuard({ check })
  selfTestRealRepo({ check, fail })

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  if (process.argv.slice(2).includes('--self-test')) {
    runSelfTest()
  } else {
    try {
      main()
    } catch (err) {
      console.error(`check-git-fixture-isolation: ${err.message}`)
      process.exit(1)
    }
  }
}
