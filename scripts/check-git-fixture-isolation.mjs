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
// `git_scratch_init`), with `scripts/lib/git-scratch-guard.mjs` as its Node
// sibling. This script is the thing that makes it STICK: it scans every
// `.sh`, `.mjs` and `.py` file under scripts/ and fails the commit if
// either —
//
//   1. it hand-rolls its own `unset ... GIT_DIR ...` scrub instead of
//      sourcing the shared helper (the exact shape of all four incidents:
//      "smart enough to know about the danger, but reinventing the fix"), or
//   2. it runs `git init` / `git -C <dir> init` — the fixture-creating
//      command that is unsafe under an inherited GIT_DIR — without sourcing
//      the shared helper AT ALL (the "never learned about the danger"
//      shape: pr-overlap-diverged.sh before #3724).
//
// scripts/lib/git-scratch-guard.sh and its Node sibling
// scripts/lib/git-scratch-guard.mjs are exempt from both checks — they ARE
// the canonical implementations of `git init` inside a fixture, and the one
// place allowed to contain a raw `unset` / `delete env[...]` of these
// variables (the scrub loop itself, plus a deliberately UNGUARDED
// demonstration inside the shell one's self-test, proving the incident is
// real rather than hypothetical). This file is exempt too: it necessarily
// contains the offending patterns as detector fixtures.
//
// ─── The four design calls (#4043, #4044, #4045, #4064) ──────────────────
//
// Each of these is a decision this file used to make silently, by the shape
// of a regex, so the next reader had to infer it. They are stated here
// because the answer is not derivable from the code — only visible in it.
//
// 1. A COMMAND-SCOPED SCRUB COUNTS, WHEN THE COMMAND IT SCOPES IS `git`
//    (#4043). `env -u GIT_INDEX_FILE git …`, `env -i PATH=$PATH git -C "$d"
//    init` and `GIT_DIR= GIT_WORK_TREE= git -C "$d" init` are all working
//    private scrubs of a git command's environment — the same defect as a
//    process-wide `unset`, spelled per-command, and `env -u` is the idiom
//    someone who already knows about #3722 reaches for first. They are rule-1
//    matches.
//
//    Scrubbing some OTHER program's environment is NOT a fixture scrub and is
//    not matched. `scripts/test-py-guard-file-source.sh` runs
//    `env -u GIT_INDEX_FILE python3 <guard>` six times: that is pinning the
//    INPUT of the guard under test (these guards resolve their source FROM
//    `GIT_INDEX_FILE`, so a leaked one would turn every "auto" assertion into
//    an index read and the suite would pass without testing the default), on
//    top of a `git_scratch_guard` it already calls. No git command runs under
//    that environment, so nothing about it is a copy of the fixture scrub.
//    Requiring `git` on the same logical line is what draws that line, and it
//    is the reason that file needs no exemption.
//
// 2. A DYNAMIC `import()` COUNTS AS WIRING (#4044). `await import('…/
//    git-scratch-guard.mjs')` was reported as "without wiring itself … at
//    all" — a false red whose remedy the author had already applied. The
//    symmetric objection (a dynamic import is weaker evidence than a static
//    one, because it may never be evaluated) does not discriminate: this
//    guard ALREADY cannot prove the helper is called before the first git
//    command, for any import form. Under that stated limitation static and
//    dynamic are the same evidence, so treating them differently would be
//    precision the guard does not have.
//
// 3. RULE 1 APPLIES TO `.py` ONLY WHERE RULE 2 ALSO DOES (#4045, #4064).
//    There is no Python sibling of the scrubber, so `sourcesSharedGuard(…,
//    'py')` is `false` unconditionally and rule 1 for Python read as "no
//    Python file may touch a `GIT_` variable", with nothing to point at as
//    the remedy — a rule no file can satisfy is not a rule, it is a tax.
//    `scripts/lib/guard_file_source.py` paid it: removing a foreign
//    `GIT_INDEX_FILE` from a subprocess environment is the one place that
//    decides which INDEX a guard reads, and it needed an exemption for it.
//    Rule 1 for `.py` is therefore scoped to files that ALSO build a fixture
//    — where the message rule 2 already prints ("write it in Node or shell,
//    or add the Python sibling") is the remedy, and the hand-rolled scrub is
//    the #3722 shape rather than ordinary environment handling.
//
//    NOT widened to `.sh`/`.mjs`: those languages HAVE a helper, so rule 1's
//    message names a real remedy there, and a script that scrubs by hand for
//    a fixture it built some other way (`git clone`, a tarball) is a case
//    only rule 1 can see.
//
// 4. `not-a-fixture-scrub: <reason>` REPLACES THE EXEMPTION LIST (#4064). A
//    set of basenames in this file grew an entry every time a legitimate
//    `GIT_` removal appeared elsewhere, and it excused the WHOLE file's
//    rule 1 rather than the one statement that earned it. The pragma is a
//    trailing comment on the scrub line itself, carries a mandatory reason,
//    and waives rule 1 for THAT LINE ONLY:
//
//      delete out.GIT_INDEX_FILE // not-a-fixture-scrub: <why>
//
//    Its one live user is `scripts/lib/guard-file-source.mjs`'s `gitEnv`.
//    A bare `not-a-fixture-scrub:` with no reason does not waive anything —
//    the reason is the whole mechanism, and a pragma that could be typed
//    without one would be the exemption list again, distributed.
//
// ─── Why `.mjs` and `.py` are scanned, not just `.sh` (#4015) ─────────────
//
// This guard used to enumerate with `entry.name.endsWith('.sh')`, so it
// inspected ~30 shell scripts and nothing else. That is the meta-guard
// committing the exact error it was written to end: a per-LANGUAGE fix does
// not end a class of defect any more than a per-SCRIPT one does, it just
// moves the next occurrence somewhere new.
//
// It did. `scripts/lib/git-scratch-guard.mjs` was added during #3962 as the
// Node sibling of the shell helper; its own header names this gap
// explicitly — that a `.mjs` self-test spawning git is the unwatched case —
// and the very file that says so shipped a scenario which leaked. One
// scenario read the index IN PROCESS rather than through a spawned guard,
// with no `env` threaded to `git ls-files`, so under a real `git commit` the
// ambient `GIT_INDEX_FILE` (which OUTRANKS `cwd`) made it enumerate the real
// repository's 4,610 paths instead of the fixture's 8. The standalone
// self-test passed, `prek run --all-files` passed, and three adversarial
// review passes over the diff passed; only an actual `git commit`
// reproduced it, because that is the only context which sets
// `GIT_INDEX_FILE`.
//
// `.py` is in scope for the same reason, pre-emptively rather than after the
// fact: no Python script builds a git fixture today, and the first one that
// does must not be the one that discovers this guard could not see it. There
// is no Python sibling of the shared scrubber, so a `.py` fixture-builder is
// reported as such — write the fixture in Node or shell, or add the sibling.
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
//
// Exit codes: 0 = every fixture-building script is wired through the shared
// guard; 1 = at least one is not (or the wiring itself looks broken).

import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SCRIPTS_DIR = join(import.meta.dirname)
// The shared scrubbers, one per language that has one — see the header. The
// shell name is also what a `.sh` script must be seen to SOURCE, and the
// `.mjs` name what a Node script must be seen to IMPORT.
const SHARED_GUARD_BASENAME = 'git-scratch-guard.sh'
const SHARED_GUARD_MJS_BASENAME = 'git-scratch-guard.mjs'
// Exempt from EVERY check — never opened, neither rule run: the two canonical
// implementations, and this file, which necessarily carries the offending
// patterns as detector fixtures.
const EXEMPT_BASENAMES = new Set([
  SHARED_GUARD_BASENAME,
  SHARED_GUARD_MJS_BASENAME,
  'check-git-fixture-isolation.mjs',
])

const EXCLUDED_DIR_NAMES = new Set(['node_modules', '__pycache__', '.git'])

/** Extension -> language tag. The scanned corpus is exactly these keys, and
 * the wiring guard below asserts each one still matches at least one real
 * file, so an extension list that falls out of step with the repo is a loud
 * failure rather than a silently narrower scan. */
export const SCANNED_EXTENSIONS = new Map([
  ['.sh', 'sh'],
  ['.mjs', 'mjs'],
  ['.py', 'py'],
])

// ---------------------------------------------------------------------------
// Text-level detection
// ---------------------------------------------------------------------------

/** Python DOCSTRINGS, blanked in place — every triple-quoted string in the
 * file walked IN ORDER, so a delimiter can only ever be read in the role it
 * actually plays.
 *
 * Exported so a caller can run a second blanking pass on this function's
 * OUTPUT directly, before `stripLineComments`'s `#`-comment-line filter
 * runs — the ORDER matters (#4477 note 4).
 *
 * A docstring is a triple-quoted literal that OPENS a statement: at the start
 * of a line, after indentation and after any of the `r`/`b`/`u`/`f` prefixes.
 * That is where a module, class or function docstring always begins and where
 * an argument like `subprocess.run("""git init""", shell=True)` never does, so
 * only those are blanked; every other triple-quoted literal is left as the
 * code it is.
 *
 * WHY A WALK AND NOT A REGEX. This was `/^[ \t]*[rRbBuUfF]{0,2}("""|''')[\s\S]*?\1/gm`,
 * which asks only "is this delimiter at the start of a line?" — and the
 * CLOSING delimiter of a multi-line string that opened mid-line is at the
 * start of a line too. Measured, before the fix:
 *
 *     SQL = """
 *     select 1
 *     """
 *     subprocess.run(["git", "init"])
 *     """trailing"""
 *
 * the line-3 `"""` matched as an OPENER and `[\s\S]*?` blanked forward to the
 * line-5 delimiter, erasing the fixture spawn on line 4 — `hasFixtureGitInit`
 * returned false. A false negative in exactly the language #4015 widened the
 * scan to cover, produced by the strip rather than by the detector. Walking
 * from the top means the line-1 `"""` is entered as a non-docstring literal
 * and its own closing delimiter on line 3 is CONSUMED as a close, so nothing
 * downstream can mistake it for an opener.
 *
 * Two deliberate conservatisms, both erring toward reporting rather than
 * hiding (the direction this guard's failures must take):
 *
 *   * an UNTERMINATED literal ends the walk and leaves the remainder of the
 *     file untouched, rather than blanking to EOF — a file that would blank
 *     its own tail is a file whose fixture spawns stop being visible;
 *   * a delimiter escaped inside a literal (`"""a \""" b"""`) is not modelled,
 *     exactly as the previous regex did not model it.
 *
 * Blanked rather than deleted so line structure — and therefore the per-line
 * detectors below — is unchanged; see `stripLineComments`. */
export function blankPyDocstrings(text) {
  const DELIM_RE = /"""|'''/g
  let out = ''
  let pos = 0
  for (;;) {
    DELIM_RE.lastIndex = pos
    const open = DELIM_RE.exec(text)
    if (open === null) {
      out += text.slice(pos)
      break
    }
    // Back up over an `r`/`b`/`u`/`f` string prefix (at most two characters),
    // so `r"""…` at the head of a line still reads as line-initial.
    let litStart = open.index
    while (
      litStart > pos &&
      open.index - litStart < 2 &&
      /[rRbBuUfF]/.test(text[litStart - 1] ?? '')
    ) {
      litStart -= 1
    }
    const lineStart = text.lastIndexOf('\n', litStart - 1) + 1
    const isDocstring = /^[ \t]*$/.test(text.slice(lineStart, litStart))
    const close = text.indexOf(open[0], open.index + 3)
    if (close === -1) {
      // Unterminated. Leave everything from here on as-is — see above.
      out += text.slice(pos)
      break
    }
    const end = close + 3
    out += text.slice(pos, litStart)
    out += isDocstring
      ? text.slice(litStart, end).replace(/[^\n]/g, ' ')
      : text.slice(litStart, end)
    pos = end
  }
  return out
}

/** Drop whole-line comments — a comment merely NAMING `git init` or
 * `GIT_DIR` in prose (every migrated script's docstring does this, on
 * purpose, to explain the incident) must not be mistaken for the code this
 * guard actually cares about.
 *
 * `lang` picks the comment marker: `#` for shell and Python, `//` for Node.
 * Getting this wrong is not cosmetic — a Node file whose entire 30-line
 * header explains the incident would have every one of those lines read as
 * CODE, and `hasFixtureGitInit` would flag the file that documents the
 * hazard as if it committed it. Node block comments (`/* … *\/`) are
 * stripped too, wherever they start.
 *
 * PYTHON'S PROSE IS THE DOCSTRING, not the `#` line, so stripping only `#`
 * gave `.py` — the language #4015 added to the scan — the exact treatment
 * the paragraph above says is not cosmetic. Measured: adding two lines of
 * ordinary prose naming `git` and `init` to `scripts/lib/guard_file_source.py`
 * (a file that spawns no fixture at all) made this guard fail the commit,
 * advising the author to "write the fixture in Node or shell" — and unlike
 * the other two languages there was no way to comment the sentence out,
 * because the comment form IS the thing being scanned. Both existing `.py`
 * scripts that pass today do so by luck: they already carry a quoted
 * `"git"` and are one nearby `"init"` away. */
export function stripLineComments(text, lang = 'sh') {
  const body =
    lang === 'mjs'
      ? text.replace(/\/\*[\s\S]*?\*\//g, '')
      : lang === 'py'
        ? // Blanked, not deleted: the per-line detectors below split on
          // `\n`, and deleting a multi-line docstring would splice the line
          // above it onto the line below and invent a statement neither one
          // contains. (The `.mjs` branch predates this and is left alone.)
          blankPyDocstrings(text)
        : text
  const commentRe = lang === 'mjs' ? /^\s*\/\// : /^\s*#/
  return body
    .split('\n')
    .filter((line) => !commentRe.test(line))
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

/** The per-statement waiver (design call 4). A TRAILING comment — `#` or
 * `//` — on the scrub line, carrying a non-empty reason. Trailing rather
 * than own-line because `stripLineComments` deletes whole comment lines
 * before any detector sees them, so a pragma on its own line would be gone
 * by the time this runs; and per-line rather than per-file because "this one
 * removal is not a fixture scrub" is the only claim that is ever true.
 *
 * The `\S` is load-bearing: a bare `not-a-fixture-scrub:` waives nothing. */
const NOT_A_FIXTURE_SCRUB_RE = /(?:#|\/\/)\s*not-a-fixture-scrub:\s*\S/

/** Spellings that identify a line as a SCRUB STATEMENT but do not themselves
 * name the variable — the line must ALSO name one of `GIT_ENV_VAR_RE`.
 *
 *   sh   `unset GIT_DIR …`; `export -n GIT_DIR` (removing a name from the
 *        export list is, to a child process, the same thing as unsetting it)
 *   mjs  `delete env.GIT_DIR`, `delete process.env['GIT_INDEX_FILE']`, and
 *        `env.GIT_DIR = undefined` — Node's `child_process` DROPS an
 *        `undefined` env value, so the assignment is the same scrub as the
 *        deletion (#4045)
 *   py   `del os.environ["GIT_DIR"]`, `env.pop("GIT_WORK_TREE", None)`
 */
const SCRUB_STATEMENT_RE = {
  sh: /^\s*unset\b|\bexport\s+-n\b/,
  mjs: /\bdelete\s+[\w$.[\]'"]*GIT_|GIT_\w+(?:['"`]\s*\])?\s*(?<![=!<>])=(?!=)\s*(?:undefined|null)\b/,
  py: /\b(?:del\s+[\w.[\]'"]*GIT_|\.pop\s*\(\s*['"]GIT_)/,
}

/** Spellings that are SELF-IDENTIFYING: the pattern names the variable (or
 * the `GIT_` prefix) itself, so no separate `GIT_ENV_VAR_RE` test applies —
 * `env -i` names nothing at all, and a prefix filter names a prefix rather
 * than any one variable.
 *
 *   sh   `env -u GIT_DIR git …`, `env -i … git …`, `GIT_DIR= … git …` — the
 *        command-scoped scrubs of design call 1. Each requires `git` on the
 *        same logical line: scrubbing another program's environment is not a
 *        fixture scrub.
 *   mjs  `k.startsWith('GIT_')` — the filtering spelling of the same scrub.
 *   py   `k.startswith("GIT_")`, and a `for … if …` comprehension keyed on a
 *        `GIT_` name (`{k: v for k, v in env.items() if k != "GIT_DIR"}`) —
 *        arguably the most idiomatic Python spelling, and previously the
 *        documented way to reword a true positive until it passed (#4045).
 *
 * The comprehension form is matched per LOGICAL LINE, deliberately, and so
 * does not see one wrapped across physical lines. That is a stated bound,
 * not an oversight: the alternative — an N-character window over raw text —
 * is precisely the defect #4064 filed against the argv-array detector, and
 * reintroducing it here to catch a wrapped comprehension would trade a known
 * false negative for an unbounded false positive.
 */
const SCRUB_SELF_EVIDENT_RE = {
  sh: new RegExp(
    [
      // `env [-flags…] -u GIT_FOO … git …`
      /\benv\b[^\n]*?\s-u\s+GIT_\w+[^\n]*\bgit\b/.source,
      // `env [assignments…] -i … git …`
      /\benv\s(?:[^\n]*\s)?-i(?![\w-])[^\n]*\bgit\b/.source,
      // `GIT_DIR= GIT_WORK_TREE= git …` — an env-prefix assignment to EMPTY.
      // A non-empty one (`GIT_INDEX_FILE=.git/index cmd`) REDIRECTS git
      // rather than scrubbing it and is not this.
      /(?:^|[\s;&|(])GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|NAMESPACE)=(?:''|"")?(?=\s)[^\n]*\bgit\b/
        .source,
    ].join('|'),
  ),
  mjs: /\bstartsWith\s*\(\s*['"`]GIT_/,
  py: /\bstartswith\s*\(\s*['"]GIT_|\bfor\b[^\n]*\bif\b[^\n]*['"]GIT_/,
}

/**
 * A hand-rolled scrub: a statement that removes at least one of the
 * git-context variables that outrank `git -C <dir>` (#3722) from the
 * environment, in whichever way the language spells that. This is what every
 * one of the four incidents' fixes looked like BEFORE being migrated to the
 * shared helper — each is a legitimate, working scrub, and each is exactly
 * the private copy this guard exists to stop from reappearing. The spellings
 * are enumerated on `SCRUB_STATEMENT_RE` and `SCRUB_SELF_EVIDENT_RE`.
 *
 * Comments are stripped first, for the reason `stripLineComments` gives: the
 * shared helper's own prose names every one of these variables, and so does
 * every migrated script's header. What survives that strip is a TRAILING
 * comment on a code line, which is exactly where the `not-a-fixture-scrub:`
 * pragma lives.
 */
export function hasHandRolledGitEnvUnset(text, lang = 'sh') {
  const joined = joinContinuations(stripLineComments(text, lang))
  const statementRe = SCRUB_STATEMENT_RE[lang] ?? SCRUB_STATEMENT_RE.sh
  const selfEvidentRe = SCRUB_SELF_EVIDENT_RE[lang] ?? SCRUB_SELF_EVIDENT_RE.sh
  return joined
    .split('\n')
    .some(
      (line) =>
        !NOT_A_FIXTURE_SCRUB_RE.test(line) &&
        ((statementRe.test(line) && GIT_ENV_VAR_RE.test(line)) || selfEvidentRe.test(line)),
    )
}

/**
 * A fixture-creating `git init` — the command that is unsafe under an
 * inherited GIT_DIR — in either of the two shapes a script can spell it:
 *
 *   1. as a COMMAND LINE, bare or `-C`-scoped: `git init`,
 *      `git -C "$dir" init`. This is the shell form, and also what a `.mjs`
 *      `execSync('git init -q')` or a `.py` `subprocess.run("git init",
 *      shell=True)` looks like textually.
 *   2. as an ARGV ARRAY, which is how Node and Python normally spawn:
 *      `execFileSync('git', ['init', …])`, `subprocess.run(["git", "-C",
 *      dir, "init"])`. Nothing in that text puts the word `git` adjacent to
 *      the word `init`, so shape 1's regex is blind to it — scanning `.mjs`
 *      with only shape 1 would be a scanner that reports "checked" while
 *      unable to see the dominant spelling in the language it just started
 *      checking.
 *
 * Shape 2 requires the two literals to be in the SAME CALL (#4064). It was
 * `/(['"`])git\1[\s\S]{0,400}?(['"`])init\2/` — quote-anchored on both
 * halves, so `gitignore`/`initialise` could not satisfy either, but with no
 * same-call requirement at all: ANY quoted `git` and ANY quoted `init`
 * within 400 characters matched, across statement and even function
 * boundaries. Measured, before the fix:
 *
 *     subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True)
 *     BASELINE = os.path.join(root, "init", "baseline.json")
 *
 * was reported as a Python fixture-builder and its author advised to "write
 * the fixture in Node or shell" — about a file that spawns no fixture. That
 * is a guard telling someone to restructure working code, which is the
 * failure mode most likely to get a guard disabled; and this file already
 * conceded that both `.py` scripts passing at the time did so BY LUCK, being
 * one nearby `"init"` away from a false red.
 *
 * `argvGitInit` replaces the character window with a bracket scan: from a
 * quoted `git` in argument position, walk forward tracking nesting depth and
 * stop at the close of the ENCLOSING group. A quoted `init` seen before that
 * close is in the same call; one seen after it is in a different one. That
 * covers both real spellings — `execFileSync('git', ['init', …])`, where
 * `git` is the file argument and `init` is inside a nested array, and
 * `subprocess.run(["git", …, "init"])`, where both are elements of one list
 * — and no full parser is needed. The header's "textual regexes cannot
 * defeat deliberate obfuscation" limitation is unchanged by this.
 *
 * Comments are stripped first (see `stripLineComments`), and continuations
 * are joined (mirroring `hasHandRolledGitEnvUnset`) — `git -C "$dir" \` +
 * `  init` is the same unsafe command split across a line break, and a
 * scanner that joins one detector's continuations but not the other's is
 * itself an evasion.
 */
export function hasFixtureGitInit(text, lang = 'sh') {
  const body = joinContinuations(stripLineComments(text, lang))
  if (/\bgit\s+(-C\s+\S+\s+)?init\b/.test(body)) return true
  if (lang === 'sh') return false
  return argvGitInit(body)
}

/** The string literal opening at `i`, as `{ value, end }` with `end` the
 * index of its LAST delimiter character, or null when it is unterminated.
 * Triple-quoted Python literals are read whole so a `"""` cannot be misread
 * as an empty `""` followed by a stray quote. Escapes are consumed so a
 * literal `\'` does not end the string early. */
function readStringLiteral(text, i) {
  const triple = text.slice(i, i + 3)
  if (triple === '"""' || triple === "'''") {
    const close = text.indexOf(triple, i + 3)
    return close === -1 ? null : { value: text.slice(i + 3, close), end: close + 2 }
  }
  const quote = text[i]
  let value = ''
  for (let j = i + 1; j < text.length; j += 1) {
    const c = text[j]
    if (c === '\\') {
      value += text[j + 1] ?? ''
      j += 1
      continue
    }
    if (c === quote) return { value, end: j }
    value += c
  }
  return null
}

const QUOTE_CHARS = new Set(['"', "'", '`'])
/** A quoted `git` in ARGUMENT position — immediately after a `(`, `[` or `,`
 * — which is where the file argument of a spawn and the first element of an
 * argv array both sit. A `const GITBIN = 'git'` is not in argument position
 * and is the indirection the header already documents as out of reach. */
const ARGV_GIT_RE = /(?<=[([,]\s*)(['"`])git\1/g

/** Whether any quoted `git` in argument position has a quoted `init` inside
 * the SAME call — see `hasFixtureGitInit`. The walk descends into nested
 * groups and ends at the first close that has no matching open, which is the
 * end of the group enclosing the `git`; a `git` at top level with no
 * enclosing group therefore matches nothing, because it is in no call. */
function argvGitInit(body) {
  ARGV_GIT_RE.lastIndex = 0
  for (let m = ARGV_GIT_RE.exec(body); m !== null; m = ARGV_GIT_RE.exec(body)) {
    if (initInSameCall(body, m.index + m[0].length)) return true
  }
  return false
}

function initInSameCall(body, from) {
  let depth = 0
  for (let i = from; i < body.length; i += 1) {
    const c = body[i]
    if (QUOTE_CHARS.has(c)) {
      const literal = readStringLiteral(body, i)
      // Unterminated: stop this walk rather than guess where the call ends.
      if (literal === null) return false
      if (literal.value === 'init') return true
      i = literal.end
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return false
      depth -= 1
    }
  }
  return false
}

/**
 * Whether the file WIRES ITSELF to the shared helper for its language — a
 * `.`/`source` statement for shell, an `import`/`require` for Node — not
 * merely whether the basename appears anywhere in the file. Comments are
 * stripped first: a docstring explaining the incident and naming
 * `scripts/lib/git-scratch-guard.sh` in prose (every migrated script's
 * header does this) must not be read as evidence the file uses it, and
 * neither must a stray runtime string that happens to contain the basename.
 * Not WHERE relative to the fixture code, see the header's stated
 * limitation.
 *
 * Python always returns false: there is no Python sibling of the scrubber to
 * wire to. That is reported as its own problem rather than silently treated
 * as "unsourced", so the message names the actual remedy.
 */
export function sourcesSharedGuard(text, lang = 'sh') {
  if (lang === 'py') return false
  const basename = lang === 'mjs' ? SHARED_GUARD_MJS_BASENAME : SHARED_GUARD_BASENAME
  const nameRe = new RegExp(basename.replace('.', '\\.'))
  const lines = joinContinuations(stripLineComments(text, lang)).split('\n')
  if (lang === 'mjs') {
    // An ES `import` (the only form in this repo) or a CommonJS `require`,
    // as its own statement. A multi-line `import { a, b } from '…'` is one
    // logical line only after continuations are joined, which bash-style
    // joining does not do for JS — so the specifier is matched against the
    // WHOLE stripped body for `import`, anchored on the statement keyword.
    const body = stripLineComments(text, lang)
    const escaped = basename.replace('.', '\\.')
    const importRe = new RegExp(
      `(?:^|\\n)\\s*import[\\s\\S]{0,200}?from\\s*['"\`][^'"\`]*${escaped}`,
    )
    const requireRe = new RegExp(`require\\s*\\(\\s*['"\`][^'"\`]*${escaped}`)
    const bareImportRe = new RegExp(`(?:^|\\n)\\s*import\\s*['"\`][^'"\`]*${escaped}`)
    // A DYNAMIC import (#4044). `import(` rather than `import '`/`import {`,
    // so it is matched wherever it appears — `await import(…)` inside a
    // function is the whole point of the form and is on no statement line of
    // its own. Counted as wiring: see design call 2 in the header.
    const dynamicImportRe = new RegExp(`\\bimport\\s*\\(\\s*['"\`][^'"\`]*${escaped}`)
    return (
      importRe.test(body) ||
      requireRe.test(body) ||
      bareImportRe.test(body) ||
      dynamicImportRe.test(body)
    )
  }
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

/** Every `.sh`, `.mjs` and `.py` file under `dir`, recursively, as
 * `{ path, lang, text }` with `path` relative to `dir` (posix-separated, so
 * messages are stable across platforms) — except the canonical helpers and
 * this file, which are exempt from everything (see the header). There is no
 * per-file rule-1 exemption any more: a legitimate `GIT_` removal says so at
 * the statement, with `not-a-fixture-scrub: <reason>` (#4064). Sorted for
 * deterministic output. */
export function listGuardedScripts(dir) {
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
      if (!entry.isFile()) continue
      // Longest extension first, so `.test.mjs` is matched as `.mjs` rather
      // than being missed for want of an exact key.
      const ext = [...SCANNED_EXTENSIONS.keys()].find((e) => entry.name.endsWith(e))
      if (!ext) continue
      if (EXEMPT_BASENAMES.has(entry.name)) continue
      out.push({
        path: relative(dir, full).split(sep).join('/'),
        lang: SCANNED_EXTENSIONS.get(ext),
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

/** The shared helper a file of this language is expected to wire itself to,
 * or null when the language has no sibling. */
const SHARED_GUARD_FOR = {
  sh: 'scripts/lib/git-scratch-guard.sh',
  mjs: 'scripts/lib/git-scratch-guard.mjs',
  py: null,
}

const HAZARD =
  'A self-test wired as a prek hook runs inside the pre-commit environment, where ' +
  'GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE outrank `git -C <dir>` (and outrank a spawn ' +
  "`cwd`) — every fixture command lands on the developer's REAL repository instead " +
  '(#3722, #3690, #3736, #4015).'

/** Every problem found across `files` (as returned by `listGuardedScripts`),
 * human-readable — empty means every fixture-building script is wired
 * through the shared guard for its language. */
export function checkFixtureIsolation(files) {
  const problems = []
  for (const { path, lang, text } of files) {
    const helper = SHARED_GUARD_FOR[lang]
    const buildsFixture = hasFixtureGitInit(text, lang)
    // Rule 1 speaks to a language with a shared helper to point at. Python
    // has none, so it applies there only to a file that ALSO builds a
    // fixture — where rule 2's message carries the remedy. Design call 3.
    const rule1Applies = helper !== null || buildsFixture
    if (rule1Applies && hasHandRolledGitEnvUnset(text, lang)) {
      problems.push(
        `${path}: hand-rolls its own git-environment scrub instead of using ` +
          `${helper ?? 'a shared helper'} (#3722) — every private copy of this scrub is ` +
          'exactly how the NEXT script goes unprotected. Call the shared scrubber ' +
          '(`git_scratch_guard`/`git_scratch_init`, or `scrubbedGitEnv`/' +
          '`withScrubbedProcessEnv`/`initScratchRepo`) instead.',
      )
    }
    if (buildsFixture && !sourcesSharedGuard(text, lang)) {
      problems.push(
        helper === null
          ? `${path}: builds a git fixture (\`git\` … \`init\`) from Python, and there is no ` +
              'Python sibling of the shared scrubber to route it through. ' +
              `${HAZARD} Write the fixture in Node (scripts/lib/git-scratch-guard.mjs) or shell ` +
              '(scripts/lib/git-scratch-guard.sh), or add the Python sibling and teach this ' +
              'guard about it.'
          : `${path}: runs \`git init\` (builds a git fixture) without wiring itself to ` +
              `${helper} at all. ${HAZARD}`,
      )
    }
  }
  return problems
}

/** Throws with every offending file named, or returns silently. */
export function assertFixtureIsolation({ scriptsDir = SCRIPTS_DIR } = {}) {
  const files = listGuardedScripts(scriptsDir)
  // Wiring guard (mirrors check-zizmor-version-pin.mjs), PER EXTENSION. A
  // total-count check is not enough: this guard's own #4015 defect was a scan
  // that found ~30 files and reported "checked" while an entire language went
  // uninspected, so the thing that has to be impossible is a scanned
  // extension quietly matching nothing. scripts/ contains `.sh`, `.mjs` and
  // `.py` files today and there is no plausible future in which it contains
  // none of one of them without this guard needing to be revisited.
  const missing = [...SCANNED_EXTENSIONS.keys()].filter(
    (ext) => !files.some((f) => f.path.endsWith(ext)),
  )
  if (missing.length > 0) {
    throw new Error(
      `scripts/check-git-fixture-isolation.mjs found ZERO ${missing.join(' / ')} file(s) under ` +
        'scripts/ — the corpus scan itself is broken (wrong directory? scripts/ ' +
        'restructured? extension list out of step?), not a clean repo. Fix the scan before ' +
        'trusting its "clean" verdict.',
    )
  }
  const problems = checkFixtureIsolation(files)
  if (problems.length > 0) {
    throw new Error(
      `scripts/check-git-fixture-isolation.mjs found ${problems.length} script(s) not wired ` +
        `through the shared git-fixture guard (#3722):\n  - ${problems.join('\n  - ')}`,
    )
  }
  const byLang = new Map()
  for (const { lang } of files) byLang.set(lang, (byLang.get(lang) ?? 0) + 1)
  return { checked: files.length, byLang }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main() {
  const { checked, byLang } = assertFixtureIsolation()
  const breakdown = [...byLang].map(([lang, n]) => `${n} .${lang}`).join(', ')
  console.log(
    `OK  git fixture isolation: ${checked} script(s) under scripts/ checked (${breakdown}), ` +
      'none hand-roll a git-environment scrub or build a fixture without the shared ' +
      'scratch guard',
  )
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  try {
    main()
  } catch (err) {
    console.error(`check-git-fixture-isolation: ${err.message}`)
    process.exit(1)
  }
}
