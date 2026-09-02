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

  // ── #4015: the same three detectors, per language ───────────────────────
  //
  // Every assertion below is a PAIR — the shape that must be detected and
  // the shape that must not. A detector that returns true for everything
  // satisfies half of this suite and would make the widened scan worse than
  // the narrow one it replaced.
  check(
    hasFixtureGitInit("execFileSync('git', ['init', '-q'], { cwd: dir })\n", 'mjs') === true,
    'mjs: an argv-array `git`/`init` spawn is detected (the shell regex sees no adjacency here)',
    '',
  )
  check(
    hasFixtureGitInit('subprocess.run(["git", "-C", str(d), "init"])\n', 'py') === true,
    'py: an argv-array `git`/`init` spawn is detected',
    '',
  )
  check(
    hasFixtureGitInit("execSync('git init -q -b main', { cwd: dir })\n", 'mjs') === true,
    'mjs: the command-line spelling inside a string is detected too',
    '',
  )
  check(
    hasFixtureGitInit("// execFileSync('git', ['init']) would re-init the real repo\n", 'mjs') ===
      false,
    'mjs: a `//` COMMENT narrating the spawn is not a false positive (`//` stripping)',
    '',
  )
  check(
    hasFixtureGitInit("/* execFileSync('git', ['init']) — the hazard */\n", 'mjs') === false,
    'mjs: a BLOCK comment narrating the spawn is not a false positive either',
    '',
  )
  check(
    hasFixtureGitInit("execFileSync('git', ['rev-parse', '--show-toplevel'])\n", 'mjs') === false,
    'mjs: a git spawn that is not an init is not a false positive',
    '',
  )
  check(
    hasFixtureGitInit("const s = 'gitignore'\nconst t = 'initialise'\n", 'mjs') === false,
    'mjs: `gitignore` / `initialise` are not the words `git` and `init` (the literals are ' +
      'quote-anchored, so a substring cannot satisfy either half)',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('delete env.GIT_DIR\n', 'mjs') === true &&
      hasHandRolledGitEnvUnset("delete process.env['GIT_INDEX_FILE']\n", 'mjs') === true,
    'mjs: a hand-rolled `delete env.GIT_*` scrub is detected, dotted or bracketed',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('delete env.SOME_OTHER_VAR\n', 'mjs') === false &&
      hasHandRolledGitEnvUnset('// delete env.GIT_DIR — use the helper\n', 'mjs') === false,
    'mjs: an unrelated delete, and a commented one, are not false positives',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('del os.environ["GIT_DIR"]\n', 'py') === true &&
      hasHandRolledGitEnvUnset('env.pop("GIT_WORK_TREE", None)\n', 'py') === true,
    'py: `del os.environ[...]` and `env.pop("GIT_*")` scrubs are detected',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('env.pop("SOME_OTHER_VAR", None)\n', 'py') === false &&
      hasHandRolledGitEnvUnset('# del os.environ["GIT_DIR"] — use the helper\n', 'py') === false,
    'py: an unrelated pop, and a commented scrub, are not false positives',
    '',
  )
  check(
    sourcesSharedGuard("import { initScratchRepo } from './lib/git-scratch-guard.mjs'\n", 'mjs') ===
      true,
    'mjs: importing the Node helper counts as wiring',
    '',
  )
  check(
    sourcesSharedGuard(
      'import {\n  scrubbedGitEnv,\n  initScratchRepo,\n} from "../lib/git-scratch-guard.mjs"\n',
      'mjs',
    ) === true,
    'mjs: a multi-line import is still wiring (the specifier is not on the `import` line)',
    '',
  )
  check(
    sourcesSharedGuard('// see ./lib/git-scratch-guard.mjs for the right way\n', 'mjs') === false,
    'mjs: naming the helper in a `//` comment is NOT wiring — the .sh evasion, ported',
    '',
  )
  check(
    sourcesSharedGuard('. "$(dirname "$0")/lib/git-scratch-guard.sh"\n', 'mjs') === false,
    'mjs: sourcing the SHELL helper is not wiring for a Node file (wrong sibling)',
    '',
  )
  check(
    sourcesSharedGuard('import subprocess\n', 'py') === false,
    'py: nothing counts as wiring — there is no Python sibling, which is the reported problem',
    '',
  )

  // ── Python DOCSTRINGS are prose, and prose is not code ───────────────────
  //
  // The `#` line is not how Python documents anything. Stripping only `#`
  // gave `.py` the treatment `stripLineComments` says is not cosmetic: a
  // module that spawns no fixture at all was flagged for EXPLAINING one, and
  // told to rewrite itself in Node or shell. Both directions, because a
  // stripper that swallowed the whole file would satisfy the first assertion
  // alone and blind the scan to the language it was just widened to cover.
  check(
    hasFixtureGitInit('"""Why `git init` in a hook is unsafe."""\nimport sys\n', 'py') === false,
    'py: a DOCSTRING narrating `git init` is not a false positive (the .sh/.mjs comment rule, ' +
      'ported to the form Python actually uses for prose)',
    '',
  )
  check(
    hasFixtureGitInit('"""We spawn ["git", "status"]; never "init" from here."""\n', 'py') ===
      false,
    'py: a docstring quoting "git" and "init" in prose is not a false positive either — the ' +
      'argv-array shape is what #4015 widened the scan FOR, so prose that merely resembles it ' +
      'is the false positive most likely to fire',
    '',
  )
  check(
    hasFixtureGitInit(
      '"""Builds a fixture; see the incident notes."""\nsubprocess.run(["git", "-C", d, "init"])\n',
      'py',
    ) === true,
    'py: a REAL fixture init below a docstring is still detected — the docstring is blanked, ' +
      'not the file',
    '',
  )
  check(
    hasFixtureGitInit("'''Prose.'''\nsubprocess.run(['git', 'init'])\n", 'py') === true &&
      hasFixtureGitInit('"""Prose."""\n', 'py') === false,
    "py: single-quoted (`'''`) docstrings are stripped too, and neither delimiter swallows the " +
      'code after it',
    '',
  )
  check(
    hasFixtureGitInit('subprocess.run("""git init""", shell=True)\n', 'py') === true,
    'py: a triple-quoted string used as an ARGUMENT is not a docstring and is still scanned ' +
      '(the strip is anchored to the start of a statement, which is the only place a docstring ' +
      'can begin)',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('"""Prose about GIT_DIR."""\ndel os.environ["GIT_DIR"]\n', 'py') ===
      true,
    'py: blanking a docstring preserves line structure, so the per-line scrub detector still ' +
      'sees the statement below it',
    '',
  )

  // ── A CLOSING delimiter is not an opener ────────────────────────────────
  //
  // The strip used to ask only "is this triple-quote at the start of a
  // line?", which the closing delimiter of a multi-line string that opened
  // MID-line also satisfies. It then blanked forward to the next delimiter,
  // erasing the code in between. Both arms, because a strip that simply
  // stopped blanking anything would satisfy the first assertion alone and
  // hand back every docstring in the repo as code — the false positive the
  // blanking was added to end.
  check(
    hasFixtureGitInit(
      'SQL = """\nselect 1\n"""\nsubprocess.run(["git", "init"])\n"""trailing"""\n',
      'py',
    ) === true,
    'py: a fixture spawn BELOW the closing delimiter of a mid-line multi-line string is still ' +
      'detected — the close is consumed as a close, not re-read as an opener',
    '',
  )
  check(
    hasHandRolledGitEnvUnset(
      'SQL = """\nselect 1\n"""\ndel os.environ["GIT_DIR"]\n"""trailing"""\n',
      'py',
    ) === true,
    'py: the same hole in the SCRUB detector — a `del os.environ[...]` hidden behind a closing ' +
      'delimiter is still seen',
    '',
  )
  check(
    hasFixtureGitInit(
      '"""Module prose.\n\nWe never run `git` `init` here; the fixture is built in shell.\n"""\n' +
        'import subprocess\nsubprocess.run(["git", "status"])\n',
      'py',
    ) === false,
    'py: a genuine MULTI-LINE module docstring naming `git`/`init` in prose is still blanked ' +
      'whole and is not a false positive (the arm the walk must not break)',
    '',
  )
  check(
    hasFixtureGitInit(
      'def build(d):\n    """Prose.\n\n    Mentions "git" and "init" only in words.\n    """\n' +
        '    return d\n',
      'py',
    ) === false,
    'py: an INDENTED multi-line function docstring is a docstring too — the line-initial test ' +
      'allows leading whitespace',
    '',
  )
  check(
    hasFixtureGitInit('SQL = """\nselect 1\nsubprocess.run(["git", "init"])\n', 'py') === true,
    'py: an UNTERMINATED literal leaves the rest of the file scanned rather than blanking to ' +
      'EOF — the conservative direction is to report, not to hide',
    '',
  )
  check(
    hasFixtureGitInit(
      'r"""Raw prose about `git init`."""\nimport subprocess\nsubprocess.run(["git", "log"])\n',
      'py',
    ) === false,
    'py: an `r`-prefixed docstring is recognised as line-initial (the prefix is stepped back over)',
    '',
  )

  // ── #4064: the argv-array detector's SAME-CALL requirement ──────────────
  //
  // The pre-fix regex asked only for a quoted `git` and a quoted `init`
  // within 400 characters of raw text, so two unrelated calls satisfied it.
  // Both arms, because a detector that stopped matching argv arrays entirely
  // would satisfy the first assertion alone and re-blind the scan to the
  // dominant spelling in the two languages #4015 widened it to cover.
  check(
    hasFixtureGitInit(
      'subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True)\n' +
        'BASELINE = os.path.join(root, "init", "baseline.json")\n',
      'py',
    ) === false,
    'py: a quoted `git` and a quoted `init` in DIFFERENT calls are not a fixture init — the ' +
      'window is the enclosing call, not 400 characters of text (#4064)',
    '',
  )
  check(
    hasFixtureGitInit("execFileSync('git', ['rev-parse'])\nconst p = join(d, 'init')\n", 'mjs') ===
      false,
    'mjs: the same, in the other language — an `init` in a later, unrelated call does not make ' +
      'the earlier `git` spawn a fixture builder',
    '',
  )
  check(
    hasFixtureGitInit(
      'subprocess.run(\n  [\n    "git",\n    "-C", d,\n    "init",\n  ],\n  check=True,\n)\n',
      'py',
    ) === true,
    'py: an argv array WRAPPED across lines is still one call and is still detected — the ' +
      'bracket scan crosses newlines, so narrowing the window did not narrow the real spelling',
    '',
  )
  check(
    hasFixtureGitInit("execFileSync('git', [...base, 'init'], { cwd: d })\n", 'mjs') === true,
    'mjs: an `init` NESTED deeper inside the same call is still in that call (the scan descends ' +
      'into groups, it does not stop at the first bracket)',
    '',
  )
  check(
    hasFixtureGitInit("const GITBIN = 'git'\nrun(GITBIN, ['init'])\n", 'mjs') === false,
    'mjs: a quoted `git` that is not in ARGUMENT position is not an argv spawn — the ' +
      'command-name indirection the header documents as out of reach, unchanged',
    '',
  )

  // ── #4043: command-scoped scrubs, and the line design call 1 draws ──────
  //
  // Each pair is "in front of a git command" versus "in front of something
  // else". A detector that matched `env -u` unconditionally would satisfy
  // every first arm and would flag scripts/test-py-guard-file-source.sh six
  // times over for pinning the INPUT of the guard it is testing.
  check(
    hasHandRolledGitEnvUnset('env -u GIT_INDEX_FILE git -C "$d" init -q\n') === true,
    'sh: `env -u GIT_*` in front of a git command is a private copy of the scrub (#4043)',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('env -u GIT_INDEX_FILE python3 "$@" >/dev/null 2>&1\n') === false,
    'sh: `env -u GIT_*` in front of some OTHER program is not a fixture scrub — the live shape ' +
      'in scripts/test-py-guard-file-source.sh, and the reason it needs no exemption',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('env -i PATH=$PATH git -C "$d" init -q\n') === true,
    'sh: `env -i` in front of a git command scrubs every git variable at once and is detected, ' +
      'even though it NAMES none of them',
    '',
  )
  check(
    hasHandRolledGitEnvUnset(
      'env -i "PATH=$sandbox" "HOME=$home" AWK= "$bash_bin" -c "cd \\"$HOME\\""\n',
    ) === false,
    'sh: an `env -i` sandbox around a non-git command is not a fixture scrub (the live shape in ' +
      'scripts/zizmor-hook.sh)',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('GIT_DIR= GIT_WORK_TREE= git -C "$d" init -q\n') === true,
    'sh: an env-prefix assignment to EMPTY in front of a git command is a scrub',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('GIT_INDEX_FILE=.git/index python3 "$@"\n') === false,
    'sh: a NON-empty env-prefix assignment REDIRECTS git rather than scrubbing it, and is not ' +
      'flagged (the shape scripts/test-py-guard-file-source.sh uses to plant a commit in flight)',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('export -n GIT_DIR\n') === true &&
      hasHandRolledGitEnvUnset('export -n SOME_OTHER_VAR\n') === false,
    'sh: `export -n GIT_DIR` removes it from the export list — to a child process the same thing ' +
      'as unsetting it — and the same statement on an unrelated variable is not a false positive',
    '',
  )

  // ── #4045: the two spellings rule 1 could not see ───────────────────────
  check(
    hasHandRolledGitEnvUnset('env.GIT_DIR = undefined\n', 'mjs') === true &&
      hasHandRolledGitEnvUnset("env['GIT_INDEX_FILE'] = undefined\n", 'mjs') === true,
    'mjs: assigning `undefined` is the same scrub as deleting — child_process DROPS an ' +
      'undefined env value (#4045)',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('if (env.GIT_DIR === undefined) return null\n', 'mjs') === false,
    'mjs: COMPARING against undefined is not assigning it — the arm that keeps the assignment ' +
      'pattern from matching every file that reads a git variable',
    '',
  )
  check(
    hasHandRolledGitEnvUnset(
      'e = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}\n',
      'py',
    ) === true &&
      hasHandRolledGitEnvUnset('e = {k: v for k, v in env.items() if k != "GIT_DIR"}\n', 'py') ===
        true,
    'py: a `GIT_`-filtering comprehension is a scrub — both the prefix and the named-variable ' +
      'spelling, the second of which this file used to document as a way to pass the scan',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('e = {k: v for k, v in env.items() if k != "HOME"}\n', 'py') === false,
    'py: a comprehension filtering something OTHER than a git variable is not a false positive',
    '',
  )
  check(
    hasHandRolledGitEnvUnset(
      "const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))\n",
      'mjs',
    ) === true,
    'mjs: the filtering spelling, ported — closing the Python evasion and leaving the Node twin ' +
      'open would just move it',
    '',
  )

  // ── #4064: the per-statement pragma ─────────────────────────────────────
  check(
    hasHandRolledGitEnvUnset(
      'delete out.GIT_INDEX_FILE // not-a-fixture-scrub: decides which INDEX a guard reads\n',
      'mjs',
    ) === false,
    'a `not-a-fixture-scrub:` pragma WITH a reason waives rule 1 for that statement',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('delete out.GIT_INDEX_FILE // not-a-fixture-scrub:\n', 'mjs') === true,
    'a BARE pragma with no reason waives nothing — the reason is the entire mechanism, and a ' +
      'pragma typeable without one is the exemption list again, distributed',
    '',
  )
  check(
    hasHandRolledGitEnvUnset(
      'delete env.GIT_DIR\ndelete env.GIT_INDEX_FILE // not-a-fixture-scrub: reason\n',
      'mjs',
    ) === true,
    'the pragma is PER STATEMENT, not per file — an unannotated scrub on another line is still ' +
      'reported (the whole complaint against the basename exemption it replaces)',
    '',
  )
  check(
    hasHandRolledGitEnvUnset('del env["GIT_INDEX_FILE"]  # not-a-fixture-scrub: reason\n', 'py') ===
      false,
    'the pragma works in Python too, with the comment marker that language uses',
    '',
  )

  // ── #4044: a dynamic import is wiring ───────────────────────────────────
  check(
    sourcesSharedGuard("const g = await import('./lib/git-scratch-guard.mjs')\n", 'mjs') === true,
    'mjs: a DYNAMIC import of the Node helper counts as wiring (#4044) — the guard cannot prove ' +
      'call order for a STATIC import either, so the two are the same evidence',
    '',
  )
  check(
    sourcesSharedGuard("// const g = await import('./lib/git-scratch-guard.mjs')\n", 'mjs') ===
      false &&
      sourcesSharedGuard("const g = await import('./lib/git-scratch-guard.sh')\n", 'mjs') === false,
    'mjs: a COMMENTED dynamic import is not wiring, and neither is a dynamic import of the ' +
      'SHELL sibling — the widening did not turn `import(` into a wildcard',
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

    // ── The #4015 cases: the same six shapes, in the languages the scanner
    // used to be blind to. `naive.mjs` is the live instance the issue was
    // filed about — a `.mjs` self-test spawning `git … init` through an argv
    // array, which puts no `git` next to any `init` for the shell regex to
    // find, in a file the old `entry.name.endsWith('.sh')` never opened.
    //
    // (g) imports the Node helper AND builds a fixture -> clean.
    const goodMjs = [
      "import { scrubbedGitEnv, initScratchRepo } from './lib/git-scratch-guard.mjs'",
      'const env = scrubbedGitEnv(root)',
      'const git = initScratchRepo(dir, env)',
      "execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env })",
      '',
    ].join('\n')
    // (h) THE LIVE INSTANCE: builds a fixture through an argv array, imports
    // nothing.
    const naiveMjs = [
      "import { execFileSync } from 'node:child_process'",
      "const dir = mkdtempSync(join(tmpdir(), 'fx-'))",
      "execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })",
      '',
    ].join('\n')
    // (i) the `.mjs` twin of (e): a `//` header naming the helper in prose,
    // and a real fixture init below it. Comment-stripping for `//` is what
    // stands between this and a scanner that reads a 30-line incident
    // docstring as code.
    const headerMentionMjs = [
      '// See scripts/lib/git-scratch-guard.mjs for the right way to do this;',
      "// it wraps execFileSync('git', ['init']) with a scrubbed env.",
      "spawnSync('git', ['-C', dir, 'init'], { encoding: 'utf8' })",
      '',
    ].join('\n')
    // (j) the `.mjs` twin of (c): wired to the helper, but scrubs by hand.
    const reinventedMjs = [
      "import { initScratchRepo } from './lib/git-scratch-guard.mjs'",
      'const env = { ...process.env }',
      'delete env.GIT_DIR',
      'delete env.GIT_INDEX_FILE',
      "execFileSync('git', ['init'], { cwd: dir, env })",
      '',
    ].join('\n')
    // (k) the `.mjs` twin of (d): no fixture at all, and a comment that
    // NARRATES one. Must be clean, or every migrated file's header becomes a
    // false positive.
    const unrelatedMjs = [
      '// A prek hook that runs `git -C "$dir" init` inherits GIT_DIR, so',
      "// execFileSync('git', ['init']) there re-inits the real repo.",
      "console.log('nothing to see here')",
      '',
    ].join('\n')
    // (l) Python: builds a fixture, and there is no Python sibling to route
    // it through — reported with the remedy that actually exists.
    const naivePy = [
      'import subprocess',
      'subprocess.run(["git", "-C", str(tmp), "init", "-q"], check=True)',
      '',
    ].join('\n')
    // (m) Python with no fixture -> clean.
    const unrelatedPy = ['import sys', 'print("nothing to see here")', ''].join('\n')
    // (n) the `.py` twin of (k): a module whose DOCSTRING narrates the hazard
    // and spawns nothing. Python's prose form is the docstring, not the `#`
    // line, so this is the file the widened scan is most likely to flag for
    // documenting the very incident the scan exists for — and, unlike the
    // other two languages, its author has no comment syntax to hide in.
    const docstringPy = [
      '"""Reads the staged index.',
      '',
      'Fixtures for this module are built in shell, never here: a `git`',
      'fixture needs `init` under a scrubbed environment, and there is no',
      'Python sibling of scripts/lib/git-scratch-guard.sh to provide one.',
      '"""',
      'import subprocess',
      'subprocess.run(["git", "ls-files", "-s", "-z"], capture_output=True)',
      '',
    ].join('\n')
    // (o) the `.py` twin of (f): the fixture spawn is hidden not by a line
    // continuation but by the CLOSING delimiter of a multi-line string, which
    // the old line-initial strip read as an opener and blanked forward from.
    // On disk rather than only as a parsed string, because the strip runs on
    // whole files and this is the shape a real module carries it in.
    const closingDelimiterPy = [
      'SQL = """',
      'select 1',
      '"""',
      'subprocess.run(["git", "init"])',
      '"""trailing"""',
      '',
    ].join('\n')
    // ── The #4043/#4044/#4045/#4064 cases. Every one is a PAIR: the file
    // that must be reported and the file that must not, because each of
    // these fixes either widens a detector (where the risk is a false red)
    // or narrows one (where the risk is a false green).
    //
    // (p) Python that scrubs and builds NO fixture -> clean. There is no
    // Python sibling of the scrubber, so rule 1 for `.py` had no remedy to
    // name and read as "no Python file may touch a GIT_ variable"; the real
    // scripts/lib/guard_file_source.py needed an exemption for exactly this.
    // Rule 1 for `.py` is now scoped to files that also build a fixture.
    const scrubOnlyPy = [
      'import os',
      'env = dict(os.environ)',
      'del env["GIT_INDEX_FILE"]',
      '',
    ].join('\n')
    // (q) …and the SAME scrub in a Python file that DOES build a fixture is
    // reported by both rules — the scoping is a scoping, not a removal. The
    // scrub is spelled as a `GIT_`-filtering comprehension, which rule 1
    // could not see at all and which this file used to document as the way
    // to reword a true positive until it passed (#4045).
    const scrubAndFixturePy = [
      'import os, subprocess',
      'env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}',
      'subprocess.run(["git", "-C", str(tmp), "init", "-q"], env=env, check=True)',
      '',
    ].join('\n')
    // (r) the Node half of the same question, and the arm that keeps (p)
    // honest: `.mjs` HAS a shared helper, so rule 1 there still applies to a
    // file that builds no fixture. If the Python scoping had been written as
    // a general rule this file would go silently clean.
    const scrubOnlyMjs = [
      'const env = { ...process.env }',
      'delete env.GIT_DIR',
      "console.log('no fixture here')",
      '',
    ].join('\n')
    // (s) …and the same statement carrying the `not-a-fixture-scrub:` pragma
    // is clean. This is the mechanism that REPLACED the basename exemption
    // list: the justification lives beside the statement, and waives that
    // statement only.
    const pragmaMjs = [
      'const env = { ...process.env }',
      'delete env.GIT_INDEX_FILE // not-a-fixture-scrub: picks which index this guard reads',
      "console.log('no fixture here')",
      '',
    ].join('\n')
    // (t) THE #4064 CASE: a Python file carrying a quoted `git` and a quoted
    // `init` in UNRELATED calls. The pre-fix detector matched any pair within
    // 400 characters of raw text, so this file was told to "write the fixture
    // in Node or shell" — about a file that spawns no fixture at all.
    const unrelatedCallsPy = [
      'import os, subprocess',
      'subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True)',
      'BASELINE = os.path.join(root, "init", "baseline.json")',
      '',
    ].join('\n')
    // (u) THE #4044 CASE: a `.mjs` wired to the Node helper through a DYNAMIC
    // import, building a fixture. Reported as "without wiring itself … at
    // all" — a false red whose remedy the author had already applied.
    const dynamicImportMjs = [
      "const { initScratchRepo } = await import('./lib/git-scratch-guard.mjs')",
      'const git = initScratchRepo(dir)',
      "execFileSync('git', ['init', '-q'], { cwd: dir })",
      '',
    ].join('\n')
    // (v) THE #4045 `.mjs` CASE: a scrub spelled as an assignment rather than
    // a deletion. `child_process` drops an `undefined` env value, so the two
    // are the same scrub; only one of them was detected.
    const assignUndefinedMjs = [
      "import { initScratchRepo } from './lib/git-scratch-guard.mjs'",
      'const env = { ...process.env }',
      'env.GIT_DIR = undefined',
      'env.GIT_INDEX_FILE = undefined',
      '',
    ].join('\n')
    // (w) THE #4043 CASE: a command-scoped scrub in front of a GIT command.
    // The file sources the helper, so rule 2 is satisfied and rule 1 is the
    // only thing that can report it — which it could not, in this spelling.
    const envScrubSh = [
      '#!/usr/bin/env bash',
      '. "$(dirname "$0")/lib/git-scratch-guard.sh"',
      'env -u GIT_DIR -u GIT_WORK_TREE git -C "$tmp" init -q -b main',
      '',
    ].join('\n')
    // (x) …and the line design call 1 draws: the same `env -u` in front of
    // some OTHER program. Nothing about that is a copy of the fixture scrub,
    // and scripts/test-py-guard-file-source.sh does it six times to pin the
    // INPUT of the guard under test. Without this arm the widening in (w)
    // would flag a working, documented file.
    const envScrubOtherSh = [
      '#!/usr/bin/env bash',
      '. "$(dirname "$0")/lib/git-scratch-guard.sh"',
      'env -u GIT_INDEX_FILE python3 "$guard" --cached "$file" >/dev/null 2>&1',
      '',
    ].join('\n')

    writeFileSync(join(dir, 'good.sh'), good, 'utf8')
    writeFileSync(join(dir, 'naive.sh'), naive, 'utf8')
    writeFileSync(join(dir, 'reinvented.sh'), reinvented, 'utf8')
    writeFileSync(join(dir, 'unrelated.sh'), unrelated, 'utf8')
    writeFileSync(join(dir, 'comment-mention.sh'), commentMention, 'utf8')
    writeFileSync(join(dir, 'continuation-split.sh'), continuationSplit, 'utf8')
    writeFileSync(join(dir, 'good.mjs'), goodMjs, 'utf8')
    writeFileSync(join(dir, 'naive.mjs'), naiveMjs, 'utf8')
    writeFileSync(join(dir, 'header-mention.mjs'), headerMentionMjs, 'utf8')
    writeFileSync(join(dir, 'reinvented.mjs'), reinventedMjs, 'utf8')
    writeFileSync(join(dir, 'unrelated.mjs'), unrelatedMjs, 'utf8')
    writeFileSync(join(dir, 'naive.py'), naivePy, 'utf8')
    writeFileSync(join(dir, 'unrelated.py'), unrelatedPy, 'utf8')
    writeFileSync(join(dir, 'docstring-prose.py'), docstringPy, 'utf8')
    writeFileSync(join(dir, 'closing-delimiter.py'), closingDelimiterPy, 'utf8')
    writeFileSync(join(dir, 'scrub-only.py'), scrubOnlyPy, 'utf8')
    writeFileSync(join(dir, 'scrub-and-fixture.py'), scrubAndFixturePy, 'utf8')
    writeFileSync(join(dir, 'scrub-only.mjs'), scrubOnlyMjs, 'utf8')
    writeFileSync(join(dir, 'pragma.mjs'), pragmaMjs, 'utf8')
    writeFileSync(join(dir, 'unrelated-calls.py'), unrelatedCallsPy, 'utf8')
    writeFileSync(join(dir, 'dynamic-import.mjs'), dynamicImportMjs, 'utf8')
    writeFileSync(join(dir, 'assign-undefined.mjs'), assignUndefinedMjs, 'utf8')
    writeFileSync(join(dir, 'env-scrub.sh'), envScrubSh, 'utf8')
    writeFileSync(join(dir, 'env-scrub-other.sh'), envScrubOtherSh, 'utf8')
    writeFileSync(join(dir, 'notes.md'), naive, 'utf8') // unscanned extension, ignored
    mkdirSync(join(dir, 'lib'))
    // The shared helpers themselves, even dropped in a scanned tree, are
    // exempt — they necessarily contain the raw `git init` this guard looks
    // for, and the raw scrub.
    writeFileSync(
      join(dir, 'lib', 'git-scratch-guard.sh'),
      'git -C "$dir" init -q -b main\nunset GIT_DIR\n',
      'utf8',
    )
    writeFileSync(
      join(dir, 'lib', 'git-scratch-guard.mjs'),
      "execFileSync('git', ['init'], { cwd: dir })\ndelete env.GIT_DIR\n",
      'utf8',
    )
    // …and so is this guard, which carries every offending pattern above as
    // a detector fixture.
    writeFileSync(
      join(dir, 'check-git-fixture-isolation.mjs'),
      "execFileSync('git', ['init'], { cwd: dir })\ndelete env.GIT_DIR\n",
      'utf8',
    )

    const files = listGuardedScripts(dir)
    check(
      files.length === 24,
      'the scan finds all 24 scoped .sh/.mjs/.py files, excluding the .md, the two shared ' +
        'helpers and the guard itself',
      JSON.stringify(files.map((f) => f.path)),
    )
    check(
      files.filter((f) => f.lang === 'mjs').length === 9 &&
        files.filter((f) => f.lang === 'py').length === 7,
      'the .mjs and .py files are actually opened — the scan is no longer .sh-only (#4015)',
      JSON.stringify(files.map((f) => `${f.path}:${f.lang}`)),
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
    // ── The #4015 assertions, both directions per language.
    check(
      problems.some((p) => p.startsWith('naive.mjs:')),
      'THE #4015 CASE: a .mjs that spawns `git` `init` through an argv array, importing ' +
        'nothing, is flagged — the file the old .sh-only scan never opened',
      JSON.stringify(problems),
    )
    check(
      problems.some((p) => p.startsWith('header-mention.mjs:')),
      'a .mjs that only NAMES the Node helper in a `//` comment is still flagged',
      JSON.stringify(problems),
    )
    check(
      problems.some((p) => p.startsWith('reinvented.mjs:')),
      'a .mjs that scrubs by hand (`delete env.GIT_DIR`) is flagged even though it imports the helper',
      JSON.stringify(problems),
    )
    check(
      !problems.some((p) => p.startsWith('good.mjs:')),
      'a .mjs that imports the Node helper and builds its fixture through it is clean',
      JSON.stringify(problems),
    )
    check(
      !problems.some((p) => p.startsWith('unrelated.mjs:')),
      'a .mjs whose `//` comments merely NARRATE a fixture init is clean (`//` stripping works)',
      JSON.stringify(problems),
    )
    check(
      problems.some((p) => p.startsWith('naive.py:') && /no Python sibling/.test(p)),
      'a .py that builds a git fixture is flagged, and named the remedy that exists',
      JSON.stringify(problems),
    )
    check(
      !problems.some((p) => p.startsWith('unrelated.py:')),
      'a .py with no git fixture at all is clean',
      JSON.stringify(problems),
    )
    check(
      !problems.some((p) => p.startsWith('docstring-prose.py:')),
      'a .py whose DOCSTRING narrates a fixture init — and which spawns a non-init git command ' +
        'below it — is clean: Python prose is the docstring, so scanning it as code flagged ' +
        'files for documenting the incident this guard exists for',
      JSON.stringify(problems),
    )
    check(
      problems.some((p) => p.startsWith('closing-delimiter.py:')),
      'a .py whose fixture spawn sits below the CLOSING delimiter of a mid-line multi-line ' +
        'string is flagged — the strip no longer reads that delimiter as an opener and blanks ' +
        'the spawn away',
      JSON.stringify(problems),
    )
    // ── The #4043/#4044/#4045/#4064 assertions, on disk.
    check(
      !problems.some((p) => p.startsWith('scrub-only.py:')),
      'a .py that hand-rolls a scrub and builds NO fixture is clean — rule 1 for Python named no ' +
        'remedy (there is no Python sibling) and so read as "no Python file may touch a GIT_ ' +
        'variable"; the real guard_file_source.py needed an exemption for exactly this (#4045)',
      JSON.stringify(problems),
    )
    check(
      problems.some((p) => p.startsWith('scrub-and-fixture.py: hand-rolls')) &&
        problems.some((p) => p.startsWith('scrub-and-fixture.py:') && /no Python sibling/.test(p)),
      'the SAME Python scrub in a file that DOES build a fixture is reported by both rules — the ' +
        'scoping is a scoping, not a removal, and the scrub is the `GIT_`-filtering comprehension ' +
        'rule 1 could not see at all',
      JSON.stringify(problems),
    )
    check(
      problems.some((p) => p.startsWith('scrub-only.mjs: hand-rolls')),
      'a .mjs that hand-rolls a scrub and builds no fixture is STILL flagged — `.mjs` has a ' +
        'helper to point at, so the Python scoping must not have been written as a general rule',
      JSON.stringify(problems),
    )
    check(
      !problems.some((p) => p.startsWith('pragma.mjs:')),
      'the same statement carrying `not-a-fixture-scrub: <reason>` is clean — the per-statement ' +
        'waiver that replaced the basename exemption list (#4064)',
      JSON.stringify(problems),
    )
    check(
      !problems.some((p) => p.startsWith('unrelated-calls.py:')),
      'THE #4064 CASE: a .py with a quoted `git` and a quoted `init` in UNRELATED calls is ' +
        'clean — the pre-fix detector matched any pair within 400 characters and advised its ' +
        'author to "write the fixture in Node or shell" about a file that spawns none',
      JSON.stringify(problems),
    )
    check(
      !problems.some((p) => p.startsWith('dynamic-import.mjs:')),
      'THE #4044 CASE: a .mjs wired to the Node helper through a DYNAMIC import is clean — it ' +
        'was reported as "without wiring itself … at all", with a remedy already applied',
      JSON.stringify(problems),
    )
    check(
      problems.some((p) => p.startsWith('assign-undefined.mjs: hand-rolls')),
      'THE #4045 .mjs CASE: `env.GIT_DIR = undefined` is the same scrub as `delete env.GIT_DIR` ' +
        '— child_process drops an undefined env value — and is now flagged like it',
      JSON.stringify(problems),
    )
    check(
      problems.some((p) => p.startsWith('env-scrub.sh: hand-rolls')) &&
        !problems.some((p) => p.startsWith('env-scrub.sh:') && /without wiring/.test(p)),
      'THE #4043 CASE: `env -u GIT_* … git … init` is a private copy of the scrub, reported by ' +
        'rule 1 — the file sources the helper, so rule 1 is the only rule that can see it',
      JSON.stringify(problems),
    )
    check(
      !problems.some((p) => p.startsWith('env-scrub-other.sh:')),
      'the line design call 1 draws: the same `env -u GIT_INDEX_FILE` in front of some OTHER ' +
        'program is not a fixture scrub and is clean — scripts/test-py-guard-file-source.sh does ' +
        'this six times to pin the INPUT of the guard under test',
      JSON.stringify(problems),
    )
    check(
      problems.length === 14,
      'exactly the fourteen problems are reported, nothing else',
      JSON.stringify(problems),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The wiring guard: a scanned extension that matches NOTHING is a failure,
 * not a vacuous pass — per extension, not merely in total. #4015 is the case
 * this exists for: a scan that found 30 `.sh` files and reported "checked"
 * while `.mjs` went entirely uninspected would satisfy any total-count
 * check. */
function selfTestWiringGuard({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'git-fixture-isolation-empty-'))
  try {
    const attempt = () => {
      try {
        assertFixtureIsolation({ scriptsDir: dir })
        return null
      } catch (err) {
        return err
      }
    }
    const onEmpty = attempt()
    check(
      onEmpty !== null && /ZERO/.test(onEmpty.message),
      'an empty directory (no scanned files at all) fails loud instead of reporting a vacuous clean scan',
      onEmpty ? onEmpty.message : '(no throw)',
    )
    // …and a tree holding every extension BUT one still fails, naming the
    // one that vanished. Without this, "ZERO files" is satisfiable by a
    // guard that only notices a completely empty directory — which is
    // exactly the shape that let `.mjs` go unscanned for as long as `.sh`
    // kept matching.
    writeFileSync(join(dir, 'a.sh'), 'echo hi\n', 'utf8')
    writeFileSync(join(dir, 'a.py'), 'print(1)\n', 'utf8')
    const onMissingMjs = attempt()
    check(
      onMissingMjs !== null && /ZERO \.mjs/.test(onMissingMjs.message),
      'a tree with .sh and .py but NO .mjs still fails, and names .mjs — a per-extension ' +
        'wiring guard, not a total-count one (#4015)',
      onMissingMjs ? onMissingMjs.message : '(no throw)',
    )
    // …and with all three present it is clean, so the check above is a
    // discrimination rather than a guard that refuses every tree.
    writeFileSync(join(dir, 'a.mjs'), "console.log('hi')\n", 'utf8')
    const onComplete = attempt()
    check(
      onComplete === null,
      'a tree holding all three scanned extensions, none of them offending, is clean',
      onComplete ? onComplete.message : '',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The real repo, as it stands right now, must itself be clean — the
 * migration this guard exists to lock in. */
function selfTestRealRepo({ check, fail }) {
  try {
    const { checked, byLang } = assertFixtureIsolation()
    check(
      checked >= 5 && (byLang.get('mjs') ?? 0) >= 5 && (byLang.get('py') ?? 0) >= 1,
      `the real scripts/ tree is checked in every scanned language (found ${checked} files: ` +
        `${[...byLang].map(([l, n]) => `${n} .${l}`).join(', ')})`,
      JSON.stringify([...byLang]),
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
