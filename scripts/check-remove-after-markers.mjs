#!/usr/bin/env node
// #4129 accuracy guard — fail a commit that reaches or passes the version
// named by a `REMOVE AFTER <x.y.z>` marker still sitting in tracked source.
//
// ─── The incident ──────────────────────────────────────────────────────
//
// `migrate_personal_pages_to_work` carried a doc comment that named its own
// kill-date: "REMOVE AFTER `0.3.0`. Removal trigger: when `0.3.0` is cut,
// delete the function and its helpers in the same commit that bumps the
// version." The plan was clear, correct, and self-describing. It still
// failed: the repo reached 0.9.8 — six minor versions and roughly four
// months later — with the migration still exported, still reachable, still
// running an extra query on every cold boot. It was removed only because a
// deep review happened to read the doc comment. The containment mechanism
// was "a human remembers at release time", and it failed silently — see
// #3282 finding 2.
//
// ─── Canonical "current version" — src-tauri/tauri.conf.json ────────────
//
// The repo carries FIVE version manifests
// (`package.json`, `package-lock.json`, `src-tauri/Cargo.toml`,
// `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`) that
// `verify-version-agreement` (`.github/workflows/_validate.yml`) already
// keeps in mutual lockstep on every PR/push. This guard still has to pick
// ONE to read `CURRENT_VERSION` from, and picks `src-tauri/tauri.conf.json`:
//   - it is the Tauri application manifest — the version the SHIPPED app
//     itself reports (window title / About surface, the updater's own
//     version check) — which is the exact question a "REMOVE AFTER" marker
//     is asking: has a RUNNING INSTANCE of the app reached this version.
//     `package.json` / `Cargo.toml` are build-tooling manifests one hop
//     further from that question;
//   - `verify-version-agreement`'s own comparison already treats it as the
//     pivot value (`CONF`) every other manifest is checked against
//     (`.github/workflows/_validate.yml`'s `verify-version-agreement` job):
//     `for v in "$CARGO" "$CARGO_LOCK" "$PKG" "$PKG_LOCK"; do if [ "$v" !=
//     "$CONF" ]`. Reusing that pivot keeps this guard's notion of "current"
//     answering the same question the existing mutual-agreement check does.
// Since the five manifests are already enforced to agree, which one is read
// matters only for defining the rule precisely — not for correctness day to
// day; tauri.conf.json is the one with a real semantic tie to "has this
// version shipped".
//
// ─── Canonical marker spelling ───────────────────────────────────────────
//
// Exactly `REMOVE AFTER <x.y.z>` (all-caps, that literal phrase, a semver
// TRIPLE — no `v` prefix, no pre-release suffix, no extra `.w` component),
// optionally wrapped in markdown backticks, as the original comment used
// it. Markdown BOLD (`**1.2.3**`) is NOT a canonical wrapping — a bold
// marker is reported malformed, same as any other near-miss. The regex
// below is deliberately narrow: mechanical findability was the whole
// design goal (#4129's own text — "the value is in the marker being
// mechanically findable, so the format has to be fixed, not prose"), so a
// line that says "REMOVE AFTER" but does not carry a well-formed triple is
// its own failure — a near-miss marker that silently guards nothing is
// worse than no marker, and this guard refuses to let one pass quietly.
//
// ─── Where it runs — version-bump commits needed no `.github/workflows/` change ──
//
// #4129 asks: pre-commit-only would not have caught the real incident,
// because the version bump and the marker lived in DIFFERENT commits — a
// hook gated on "did a file matching X change in THIS commit" never fires
// on a bump-version commit that only touches the 5 manifests. The fix is
// not a new CI job: it is including THOSE FIVE MANIFESTS in this hook's own
// `files` trigger (see `prek.toml`), so a commit that bumps the version — a
// `bump-version.sh` commit touches exactly those five — also re-scans the
// WHOLE tracked tree for markers (`pass_filenames = false`), independent of
// which files that particular commit touched. And for the case where a
// commit skips hooks entirely (`--no-verify`), the existing CI backstop
// already covers it without any change here: the `lint` job runs
// `prek run --all-files` (`.github/workflows/_validate.yml`) unconditionally
// whenever the push is not docs-only — and a version bump never is.
//
// A DIFFERENT gap needed a workflow change: `_validate.yml`'s docs-only fast
// path (`docs-lint`) ran only `markdownlint`, `md-link-targets`,
// `doc-vs-code-paths` and `typos` — not this hook — so a docs-only PR adding
// an expired marker to a `.md` file merged clean despite the `.md` coverage
// this header claims (#4147). `docs-lint` now also runs `remove-after-markers`
// on its reduced hook-id command line (still no `prek.toml` change; see that
// job's comment in `_validate.yml`).
//
// ─── Markdown fenced code blocks ─────────────────────────────────────────
//
// #4146: the canonical spelling above cannot be documented anywhere a
// contributor would look for it, because writing about it trips the same
// scan it is explaining — a well-formed illustration (`REMOVE AFTER
// 1.2.3`) reads as an expired marker, and a description standing in for a
// version (`REMOVE AFTER x.y.z`) reads as malformed. Before this, the only
// exemption was `docs/session-log/**`, which does not help a live
// CONTRIBUTING-style reference.
//
// The fix (option 3 of #4146's own list): a line inside a MARKDOWN FENCED
// CODE BLOCK is exempt from both the expiry and malformed checks. A fence
// is the natural way to write about a mechanically-scanned syntax — the
// content is self-evidently an example, not a live annotation — and it
// requires no NEW convention layered on top of the one already being
// documented (unlike an escape token, #4146's option 1, or widening the
// path-exemption list, option 2, both of which trade the original problem
// for a second one). It is markdown-only (`isMarkdown` below, gated on the
// file's own `.md` extension): a doc comment explaining the convention
// inside a `.rs`/`.ts` file has no fence syntax to exempt it, and still
// needs the phrase to name a real deadline or be reported malformed, same
// as before.
//
// Fence detection (`MD_FENCE_RE`): a line consisting of leading SPACES
// (capped at 0–3, CommonMark's own per-container fence-indent allowance —
// spaces only, never a tab, which CommonMark expands to the next 4-column
// tab stop and is therefore already indented code, not a fence),
// then 3-or-more backticks or tildes OPENS a fence, recording its delimiter
// CHARACTER, LENGTH, and blockquote NESTING DEPTH; the fence delimiter line
// itself, and every line while a fence is open, are skipped before either
// marker regex runs.
//
// Widened for #4174, in PART: the 0–3-space allowance may now be preceded
// by one or more `>` blockquote markers (each optionally preceded by 0–3
// spaces of its own, `MD_FENCE_RE`'s `(?: {0,3}>)*` — CommonMark's cap on
// the indent before a block-quote marker), so a fence written
// inside a blockquote — `> ` followed by the delimiter — is recognized.
// Before this, that shape never matched at all: the "fence" never opened,
// and a `REMOVE AFTER` marker written inside one as inert documentation
// (the way CONTRIBUTING.md's own "Marking code with a removal deadline"
// section does) was scanned as ordinary text and falsely reported.
//
// #4174 ALSO asked to recognize a fence nested inside a list item at 4+
// spaces of content indent (legal CommonMark once the list item's own
// marker is wide enough, e.g. a two-digit ordered marker, "10. ", is
// itself 4 columns) by making the leading whitespace unbounded instead of
// capped at 0–3. That half was tried and REJECTED on review: this scanner
// has no notion of list-item content columns, so "unbounded whitespace
// opens a fence" cannot tell a list-nested fence apart from a plain
// 4-space INDENTED CODE block (not inside a list item at all) whose
// content happens to start with a fence-shaped line — CommonMark reads
// that as literal text, never a fence. Unbounded, this scanner reads it as
// a fence open instead, and if that block (as is typical — it is not
// actually a fence) never carries a matching bare closer, the "fence"
// stays open through EOF, silently skipping every line after it — INCLUDING
// a genuinely live `REMOVE AFTER` marker elsewhere in the same document.
// That is not the false-positive #4174 sets out to fix; it is the false
// NEGATIVE this whole guard exists to prevent (#4129's own incident), and
// unlike the accepted "unterminated fence swallows to EOF" tradeoff
// documented below, it is triggered by ordinary indented prose, not a
// malformed fence — demonstrated live in review (see the
// `plainIndentedCodeIsNotAFenceScenarios` self-test below, the fixture
// that would have gone red-before/green-after this rejection). So the
// list-nested-4-space shape stays UNrecognized, same as before #4174: a
// false positive (CI goes red, visibly and loudly) rather than a silent
// hole. Left as a documented limitation, per #4174's own stated fallback
// ("explicitly document the current limitation... if a full
// CommonMark-accurate block-container model is out of scope").
//
// A later fence-shaped line only CLOSES an open fence if the run uses the
// SAME character, is AT LEAST AS LONG as the opener, is at the SAME
// blockquote nesting depth as the opener, and carries nothing else on the
// line — CommonMark's own closing-fence rule, plus the nesting-depth match
// this review added. Without the depth match, a blockquoted opener could
// be closed by a bare (non-blockquoted) fence-shaped line elsewhere in the
// document, or vice versa — demonstrated live in review to desync the
// open/close PARITY for the rest of the file: an unrelated, well-formed
// bare fence closes early against a distant blockquoted line that merely
// happens to share its character and length, and the bare fence's own
// intended closer then reads as a fresh OPEN, silently swallowing
// everything after it, including a live marker. Requiring the depth to
// match closes that: a depth-mismatched pairing simply does not close —
// the fence stays open to EOF, same "unterminated fence" reading already
// documented and accepted below, not a cross-fence corruption. This
// matters generally, not just for blockquote depth: a doc that nests a
// shorter example fence inside a longer one (```` wrapping a literal ```
// shown as text, or vice versa with `~~~`/backticks mixed) must not have
// the inner delimiter-shaped line close the OUTER fence early — early
// closing does not just under-hide the nested example, it also desyncs
// parity for the rest of the file, which can hide a later, genuinely live
// marker in ordinary prose that was never meant to be fenced at all. (This
// was live and demonstrable before length/character matching was added —
// see `fenceStateMachineScenarios` in the self-test below.) An odd number
// of correctly-matched fence delimiters (an unterminated fence) leaves it
// open through end of file. At the document level that is the same "rest
// of the document is code" reading CommonMark itself gives an unclosed
// fence; CommonMark actually closes an unclosed fence at the end of its
// *containing block* (e.g. a list item), so a fence opened inside a list
// item and never closed diverges from CommonMark there — this scanner has
// no notion of block containers, so it keeps the fence open through EOF
// regardless. Deliberate, not a special case here.
//
// ─── The escape hatch ────────────────────────────────────────────────────
//
// Bump the marker itself. There is deliberately no CLI opt-out flag: "yes,
// deliberately keeping this one more release" is a one-line, reviewable
// edit to the marker's own version, exactly as visible in the diff as
// forgetting would be invisible in its absence (#4129's own framing).
//
// Heuristic:
//   - Scan every tracked `*.rs`, `*.ts`, `*.tsx`, `*.js`, `*.mjs`, `*.py`,
//     `*.sh`, `*.md` file (this script's own path excluded) for a line
//     containing the literal substring `REMOVE AFTER`. `*.js`/`*.mjs` are
//     in scope so a marker left in a GUARD SCRIPT — `scripts/` itself — is
//     as findable as one left in application source; the exclusion of
//     THIS file's own path (see `SELF_PATH` below) is what keeps that from
//     self-triggering on this header's own prose examples and the
//     self-test fixtures' string literals below.
//   - A line matching the canonical spelling records a marker; the CURRENT
//     version is compared against it with NUMERIC per-component semver
//     comparison (major, then minor, then patch, each as an integer —
//     never a string compare, which gets `0.10.0` vs `0.9.8` backwards).
//     Fail when `CURRENT >= MARKER`.
//   - A line containing the substring but not matching the canonical
//     spelling is a MALFORMED marker — also a failure, named separately.
//   - `docs/session-log/**` is excluded: a historical session recounting a
//     marker that has since been resolved is an archive, not a live one.
//   - In `.md` files only, a line inside a fenced code block (a ` ``` ` or
//     `~~~` delimiter line — indented 0–3 spaces, optionally blockquoted,
//     e.g. `> ` ``` `) is exempt from BOTH checks — see "Markdown fenced
//     code blocks" below (#4146, widened for #4174's blockquote case only;
//     see that section for why the list-nested-4-space case was NOT
//     widened).
//   - Each file (including the version manifest itself) is read from the
//     copy the caller is actually judging — the STAGED INDEX during a
//     commit, the WORKING TREE otherwise (#3962). `--cached` / `--worktree`
//     force it; with neither, `GIT_INDEX_FILE` decides. Rationale:
//     scripts/lib/guard-file-source.mjs.
//
// Usage:
//   node scripts/check-remove-after-markers.mjs              # auto source
//   node scripts/check-remove-after-markers.mjs --cached     # staged index
//   node scripts/check-remove-after-markers.mjs --worktree   # working tree
//   node scripts/check-remove-after-markers.mjs --print-source
//   node scripts/check-remove-after-markers.mjs --self-test
//
// Any OTHER argument is a usage error, not a silently ignored one.
//
// Exit codes: 0 clean / 1 an expired or malformed marker / 2 invocation error.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  initScratchRepo,
  scrubbedGitEnv,
  withScrubbedProcessEnv,
} from './lib/git-scratch-guard.mjs'
import {
  describeSource,
  gitEnv,
  listTrackedEntries,
  readContents,
  repoRootFromCwd,
  resolveSource,
} from './lib/guard-file-source.mjs'

// cwd-derived, not script-anchored — the documented EXCEPTION to "a guard
// judges the tree that contains it", taken through the SHARED
// `repoRootFromCwd` rather than a private `show-toplevel` (#4192). See
// `scripts/lib/guard-file-source.mjs`, "Which TREE is judged, and the one
// documented exception".
const REPO_ROOT = repoRootFromCwd()

const GIT_ENV = gitEnv(REPO_ROOT, process.env)

// This file's own repo-relative path — excluded from the marker scan
// because `SCAN_EXT_RE` below includes `.mjs`, and this file's own text
// carries plenty of `REMOVE AFTER` occurrences that are not live markers:
// the incident recap in the header (a canonical `` `0.3.0` `` triple, used
// as a WORKED EXAMPLE), and the self-test fixtures further down, whose
// string literals write canonical-looking and malformed-looking markers
// (`0.1.0`, `9.9.9`, `0.10.0`, `1.2.3-beta`, …) into THIS source file even
// though they are only ever materialised into throwaway scratch repos.
// Without this exclusion this script would self-trigger.
const SELF_PATH = 'scripts/check-remove-after-markers.mjs'

// The canonical "current version" manifest — see the header's rationale.
const VERSION_MANIFEST = 'src-tauri/tauri.conf.json'

// Historical archive, same exemption the citation guards use.
const EXCLUDE_PATH_RE = /^docs\/session-log\//

const SCAN_EXT_RE = /\.(rs|ts|tsx|js|mjs|py|sh|md)$/

// The literal phrase, checked FIRST and cheaply per line before the
// stricter parse below — this is what lets a near-miss (right phrase,
// malformed version) be told apart from "no marker on this line at all".
const MARKER_PHRASE_RE = /REMOVE AFTER/
// Canonical spelling: the phrase, whitespace, an optional opening
// backtick, a semver TRIPLE, an optional closing backtick. No `v` prefix,
// no pre-release suffix — `#4129`'s own text pins the format to keep it
// mechanically findable. The trailing negative lookahead END-ANCHORS the
// triple: it refuses to match when the digits are immediately followed by
// `-` (a pre-release suffix, `1.2.3-beta`) or `.<digit>` (a fourth
// component, `1.2.3.4`) — without it those forms would silently match on
// their `1.2.3` PREFIX and be recorded as well-formed with the remainder
// dropped, rather than reported as the malformed near-misses they are.
//
// The lookahead's first branch is `[\d-]`, NOT a bare `-`: `(\d+)` is
// GREEDY, and a bare `-` lookahead is defeated by backtracking whenever the
// patch component has two or more digits. On `1.2.34-beta`, `(\d+)` first
// takes `34`; the lookahead sees `-` and fails; the engine backtracks the
// capture to `3`; the next character is `4` — neither `-` nor `.<digit>` —
// so the (now too-narrow) lookahead passes, and the marker is silently
// recorded as the well-formed `1.2.3`, with `4-beta` dropped. Excluding any
// trailing DIGIT too (not just `-`) closes that: backtracking to any
// shorter prefix still leaves a digit immediately after, which the
// lookahead now also rejects. Same shape turns `1.0.12.4` into `1.0.1`.
const MARKER_STRICT_RE = /REMOVE AFTER\s+`?(\d+)\.(\d+)\.(\d+)(?![\d-]|\.\d)`?/

// A markdown fenced code block delimiter: zero or more `>` blockquote
// markers (each optionally preceded by 0–3 SPACES of its own, CommonMark's
// cap on the indent before a block-quote marker; captured in group 1 so the
// caller can compute nesting DEPTH), then 0–3 more spaces —
// CommonMark's own per-container fence-indent cap, deliberately NOT widened
// past that (see below) — then 3-or-more backticks or tildes (group 2, so
// the caller can read back which character and how many). Checked only for
// `.md` files (see "Markdown fenced code blocks" in the header, #4146).
// Widened for #4174 to also recognize a fence inside a blockquote — the
// list-nested-4+-space case #4174 also asked for was tried and REJECTED on
// review (see the header's "Fence detection" paragraph for why: unbounded
// indent cannot be told apart from a plain 4-space indented code block, and
// demonstrably creates a silent false negative, not just an accepted
// tradeoff). Matching this regex is necessary but NOT sufficient to CLOSE
// an already-open fence — see `MD_FENCE_BARE_RE` and the character/length/
// depth check in `findMarkers` below; a fence-shaped line with a different
// character, a shorter run, a different blockquote nesting depth, or
// trailing content past the run (an info string, e.g. an inner ` ``` `
// shown as literal text) is fenced CONTENT, not a delimiter, while a fence
// is already open.
//
// Every whitespace allowance here is SPACES ONLY — no `\t` — in both
// positions, and both are capped at 3. A tab is not a space of indent:
// CommonMark expands one to the next 4-column tab stop, so a SINGLE
// leading tab is already 4 columns, i.e. indented code, whose content is
// literal text and never a fence. Admitting `\t` into either class
// (`[ \t]{0,3}`) makes one tab satisfy the cap and phantom-opens a fence
// on tab-indented code; an unbounded ` *` before the `>` marker does the
// same for a `>` sitting at 4+ columns, which CommonMark also reads as
// indented code. Both are the identical fail-open the list-nested
// widening was rejected for (see the header), and both are pinned red-
// before/green-after by `plainIndentedCodeIsNotAFenceScenarios`. Note
// that MD010 is NOT a backstop for the tab shape: `.markdownlint-cli2
// .jsonc` ignores every `AGENTS.md`, `PROMPT.md`, `REVIEW-LATER.md`,
// `FEATURE-MAP.md` and `SESSION-LOG.md`, while `EXCLUDE_PATH_RE` here
// excludes only `^docs/session-log/` — so those files are scanned by this
// guard with hard tabs entirely unlinted.
const MD_FENCE_RE = /^((?: {0,3}>)*) {0,3}(`{3,}|~{3,})/

// The stricter shape a CLOSING fence must have: the same blockquote-prefix/
// whitespace allowance, the delimiter run, and then NOTHING but trailing
// whitespace — no info string. An opening fence may carry one
// (`` ```rust ``); a closing one, per CommonMark, may not.
const MD_FENCE_BARE_RE = /^((?: {0,3}>)*) {0,3}(`{3,}|~{3,})\s*$/

function scanTargets(tracked) {
  return tracked.filter((f) => {
    if (f === SELF_PATH) return false
    if (EXCLUDE_PATH_RE.test(f)) return false
    return SCAN_EXT_RE.test(f)
  })
}

/** `[major, minor, patch]` as integers, or `null` if `v` isn't `\d+\.\d+\.\d+`. */
function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Numeric per-component comparison — NEVER a string compare (`"0.10.0" <
 * "0.9.8"` lexically, which is backwards: 10 > 9). Returns <0 / 0 / >0. */
function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/**
 * Walk every target's lines for `REMOVE AFTER`. Returns
 * `{ markers, malformed }`:
 *   - `markers`: `{ file, lineNo, text, version: [maj,min,pat], versionStr }`
 *     for every line matching the CANONICAL spelling;
 *   - `malformed`: `{ file, lineNo, text }` for every line carrying the
 *     phrase but NOT the canonical spelling — a marker nobody can act on
 *     mechanically, which is exactly the failure mode #4129 exists to
 *     prevent, so it is reported rather than silently skipped.
 *
 * In `.md` files, a line inside a fenced code block is exempt from both
 * checks (#4146, see the header's "Markdown fenced code blocks") — the
 * fence state is tracked PER FILE (`fence`, reset for each file), never
 * across files. A fence only CLOSES on a same-character, same-or-longer,
 * same-blockquote-depth, bare delimiter line (CommonMark's own rule, plus
 * the depth match #4174's review added) — a shorter, different-character,
 * or different-depth fence-shaped line nested inside is fenced content,
 * not a close, so it cannot desync the open/close parity for the rest of
 * the file (see the header's fence-detection paragraph, #4146/#4174).
 */
function findMarkers(files, bodies) {
  const markers = []
  const malformed = []
  for (const file of files) {
    const body = bodies.get(file)
    if (body === undefined) continue
    const isMarkdown = file.endsWith('.md')
    // `null` while outside a fence; `{ char, len, quoteDepth }` — the
    // OPENING delimiter's character (`` ` `` or `~`), run length, and
    // blockquote nesting depth — while inside one, so a later fence-shaped
    // line can be judged against what actually opened it rather than
    // toggled unconditionally.
    let fence = null
    const lines = body.split('\n')
    lines.forEach((line, idx) => {
      if (isMarkdown) {
        const fenceMatch = MD_FENCE_RE.exec(line)
        if (fenceMatch) {
          const quoteDepth = (fenceMatch[1].match(/>/g) ?? []).length
          const delim = fenceMatch[2]
          if (fence === null) {
            fence = { char: delim[0], len: delim.length, quoteDepth }
          } else if (
            delim[0] === fence.char &&
            delim.length >= fence.len &&
            quoteDepth === fence.quoteDepth &&
            MD_FENCE_BARE_RE.test(line)
          ) {
            fence = null
          }
          // Either way (opened, closed, or a mismatched nested delimiter
          // that stayed content) this line itself is never scanned.
          return
        }
        if (fence !== null) return
      }
      if (!MARKER_PHRASE_RE.test(line)) return
      const m = MARKER_STRICT_RE.exec(line)
      if (!m) {
        malformed.push({ file, lineNo: idx + 1, text: line.trim() })
        return
      }
      markers.push({
        file,
        lineNo: idx + 1,
        text: line.trim(),
        version: [Number(m[1]), Number(m[2]), Number(m[3])],
        versionStr: `${m[1]}.${m[2]}.${m[3]}`,
      })
    })
  }
  return { markers, malformed }
}

function check() {
  let chosen
  try {
    chosen = resolveSource(process.argv, process.env, {
      extraFlags: ['--print-source', '--self-test'],
      repoRoot: REPO_ROOT,
    })
  } catch (err) {
    process.stderr.write(`check-remove-after-markers: invocation error: ${err.message}\n`)
    return 2
  }
  if (process.argv.includes('--print-source')) {
    console.log(`check-remove-after-markers: ${describeSource(chosen.source)} (${chosen.why})`)
    return 0
  }
  let entries
  try {
    entries = listTrackedEntries(REPO_ROOT, { env: GIT_ENV })
  } catch (err) {
    process.stderr.write(`check-remove-after-markers: invocation error: ${err.message}\n`)
    return 2
  }
  if (entries === null) {
    console.warn('check-remove-after-markers: not a git repo; skipping.')
    return 0
  }
  const tracked = new Set(entries.paths)
  if (!tracked.has(VERSION_MANIFEST)) {
    process.stderr.write(
      `check-remove-after-markers: invocation error: ${VERSION_MANIFEST} is not tracked; cannot read the current version.\n`,
    )
    return 2
  }
  const targets = scanTargets(entries.paths)
  let bodies
  let manifestBody
  try {
    bodies = readContents(targets, {
      repoRoot: REPO_ROOT,
      source: chosen.source,
      entries,
      env: GIT_ENV,
    })
    manifestBody = readContents([VERSION_MANIFEST], {
      repoRoot: REPO_ROOT,
      source: chosen.source,
      entries,
      env: GIT_ENV,
    }).get(VERSION_MANIFEST)
  } catch (err) {
    process.stderr.write(`check-remove-after-markers: invocation error: ${err.message}\n`)
    return 2
  }
  if (manifestBody === undefined) {
    process.stderr.write(
      `check-remove-after-markers: invocation error: could not read ${VERSION_MANIFEST} from the ${describeSource(chosen.source)}.\n`,
    )
    return 2
  }
  let currentVersionStr
  try {
    const parsed = JSON.parse(manifestBody)
    currentVersionStr = parsed.version
  } catch (err) {
    process.stderr.write(
      `check-remove-after-markers: invocation error: ${VERSION_MANIFEST} is not valid JSON: ${err.message}\n`,
    )
    return 2
  }
  const current = parseSemver(String(currentVersionStr ?? ''))
  if (!current) {
    process.stderr.write(
      `check-remove-after-markers: invocation error: ${VERSION_MANIFEST}'s "version" (${JSON.stringify(currentVersionStr)}) is not a plain X.Y.Z semver triple.\n`,
    )
    return 2
  }

  const { markers, malformed } = findMarkers(targets, bodies)
  const expired = markers.filter((mk) => compareSemver(current, mk.version) >= 0)

  if (expired.length === 0 && malformed.length === 0) {
    return 0
  }
  process.stderr.write(
    `  (judged the ${describeSource(chosen.source)} — ${chosen.why}; current version ${current.join('.')} from ${VERSION_MANIFEST})\n`,
  )
  if (expired.length > 0) {
    process.stderr.write(
      'ERROR: a REMOVE AFTER marker has reached or passed the current version:\n',
    )
    for (const mk of expired) {
      process.stderr.write(
        `  - ${mk.file}:${mk.lineNo}: marker ${mk.versionStr}, current ${current.join('.')} — ${mk.text}\n`,
      )
    }
    process.stderr.write(
      '\nFix: delete the code the marker guards, or — if it must live one more release —\n' +
        'bump the marker to a version past the current one (a visible, reviewable choice).\n',
    )
  }
  if (malformed.length > 0) {
    process.stderr.write(
      'ERROR: a line names "REMOVE AFTER" but not in the canonical `REMOVE AFTER x.y.z` form:\n',
    )
    for (const mk of malformed) {
      process.stderr.write(`  - ${mk.file}:${mk.lineNo}: ${mk.text}\n`)
    }
    process.stderr.write('\nFix: spell it exactly `REMOVE AFTER x.y.z` (a plain semver triple).\n')
  }
  return 1
}

// ─── self-test ────────────────────────────────────────────────────────

function tauriConf(version) {
  return `${JSON.stringify({ version, productName: 'fixture' }, null, 2)}\n`
}

function run(dir, env, flags) {
  const r = spawnSync(process.execPath, [import.meta.filename, ...flags], {
    cwd: dir,
    env,
    encoding: 'utf8',
  })
  return { status: r.status, stderr: r.stderr ?? '' }
}

/**
 * #4129's own acceptance test: a fixture carrying `REMOVE AFTER 0.1.0`
 * while the manifest is at a later version fails and NAMES BOTH versions;
 * bumping the fixture's marker past the manifest clears it.
 */
function expiryScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'expiry')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    mkdirSync(join(dir, 'src-tauri'), { recursive: true })
    writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), tauriConf('1.5.0'))
    mkdirSync(join(dir, 'src-tauri', 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src-tauri', 'src', 'migration.rs'),
      '// REMOVE AFTER 0.1.0. Delete this migration once cut.\nfn migrate() {}\n',
    )
    git('add', '-A')
    const expired = run(dir, env, ['--worktree'])
    record(
      'a marker whose version the manifest has already passed is red, naming both versions',
      expired.status === 1 &&
        /0\.1\.0/.test(expired.stderr) &&
        /1\.5\.0/.test(expired.stderr) &&
        /migration\.rs/.test(expired.stderr),
      `expected 1 naming 0.1.0 + 1.5.0 + migration.rs, got ${expired.status}: ${expired.stderr}`,
    )

    // Falsification's second half: bump the marker PAST the manifest — the
    // same fixture, same file, now green.
    writeFileSync(
      join(dir, 'src-tauri', 'src', 'migration.rs'),
      '// REMOVE AFTER 9.9.9. Delete this migration once cut.\nfn migrate() {}\n',
    )
    git('add', '-A')
    const future = run(dir, env, ['--worktree'])
    record(
      'the SAME marker, bumped past the manifest version, is green',
      future.status === 0,
      `expected 0, got ${future.status}: ${future.stderr}`,
    )
    return results
  })
}

/**
 * Numeric-vs-string comparison. Manifest at `0.9.8`, marker at `0.10.0`.
 * `0.10.0` has NOT been reached (10 > 9 in the minor slot) — a STRING
 * comparison gets this backwards (`"0.10.0" < "0.9.8"` lexically, because
 * `'1' < '9'` at the second character), which would wrongly report the
 * marker as expired.
 */
function numericComparisonScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'numeric')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    mkdirSync(join(dir, 'src-tauri'), { recursive: true })
    writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.8'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'notes.ts'), '// REMOVE AFTER 0.10.0\nexport const x = 1\n')
    git('add', '-A')
    const result = run(dir, env, ['--worktree'])
    record(
      '0.9.8 has NOT reached 0.10.0 (numeric minor 9 < 10) — a string compare would say otherwise',
      result.status === 0,
      `expected 0 (not yet expired), got ${result.status}: ${result.stderr}`,
    )
    return results
  })
}

/** A line naming the phrase without a well-formed triple is its own failure. */
function malformedScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'malformed')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    mkdirSync(join(dir, 'src-tauri'), { recursive: true })
    writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), tauriConf('1.0.0'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'notes.ts'),
      '// REMOVE AFTER the next major release\nexport const x = 1\n',
    )
    git('add', '-A')
    const result = run(dir, env, ['--worktree'])
    record(
      'REMOVE AFTER without a semver triple is a red, distinct from an expiry',
      result.status === 1 &&
        /not in the canonical/.test(result.stderr) &&
        /notes\.ts/.test(result.stderr),
      `expected 1 naming a malformed marker in notes.ts, got ${result.status}: ${result.stderr}`,
    )
    return results
  })
}

/**
 * The header/regex end-anchoring, both directions. A pre-release suffix
 * (`1.2.3-beta`) and a fourth component (`1.2.3.4`) must NOT silently match
 * on their `1.2.3` prefix — they are near-misses, reported malformed, not
 * accepted with the remainder dropped. Markdown BOLD is not a canonical
 * wrapping (only backticks are) — a bold triple is malformed too, not a
 * near-miss the header fails to document.
 *
 * The two multi-digit-patch cases (`1.2.34-beta`, `1.0.12.4`) exist
 * SEPARATELY from their single-digit siblings above for a reason: a bare
 * `-` / `.` lookahead is defeated by BACKTRACKING once the patch component
 * has two or more digits — `(\d+)` greedily takes `34`, the lookahead
 * fails, the engine backtracks the capture to `3`, and the character now
 * immediately after (`4`) satisfies a too-narrow lookahead, so the marker
 * is silently recorded as well-formed `1.2.3` with the remainder dropped.
 * Single-digit patches (`1.2.3-beta`, `1.2.3.4`) cannot exercise this —
 * there is nothing shorter to backtrack `3` to — which is exactly why they
 * passed against the shipped regex while this defect was live. These two
 * cases are the ones that would have failed.
 */
function nearMissFormScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const cases = [
      ['pre-release', '// REMOVE AFTER 1.2.3-beta\nexport const x = 1\n'],
      ['fourth component', '// REMOVE AFTER 1.2.3.4\nexport const x = 1\n'],
      ['bold wrapping', '// REMOVE AFTER **1.2.3**\nexport const x = 1\n'],
      [
        'pre-release, multi-digit patch (backtracking)',
        '// REMOVE AFTER 1.2.34-beta\nexport const x = 1\n',
      ],
      [
        'fourth component, multi-digit patch (backtracking)',
        '// REMOVE AFTER 1.0.12.4\nexport const x = 1\n',
      ],
    ]
    for (const [label, contents] of cases) {
      const dir = join(root, `near-miss-${label.replace(/\s+/g, '-')}`)
      const env = scrubbedGitEnv(root)
      const git = initScratchRepo(dir, env)
      mkdirSync(join(dir, 'src-tauri'), { recursive: true })
      writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), tauriConf('1.0.0'))
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'notes.ts'), contents)
      git('add', '-A')
      const result = run(dir, env, ['--worktree'])
      record(
        `${label} does not match the canonical triple — reported malformed, not silently truncated`,
        result.status === 1 &&
          /not in the canonical/.test(result.stderr) &&
          /notes\.ts/.test(result.stderr),
        `expected 1 naming a malformed marker in notes.ts, got ${result.status}: ${result.stderr}`,
      )
    }
    return results
  })
}

/**
 * The two forms that MUST keep matching after the backtracking fix — this
 * is the falsification half of `nearMissFormScenarios` above: tightening
 * the lookahead to also exclude a trailing digit must not, as a side
 * effect, start rejecting well-formed markers it used to accept.
 *   - backtick-wrapped, the original incident's own spelling
 *     (`` REMOVE AFTER `0.9.9` ``);
 *   - the bare prose-sentence form, the exact shape the incident comment
 *     used (`REMOVE AFTER 0.3.0. Removal trigger: …`) — a period directly
 *     after the triple, no backtick, no wrapping at all.
 * Both are given manifests at or past their marker version, so a pass here
 * requires the marker to have been PARSED (not just "not reported
 * malformed") — the expiry report names the exact marker version, which a
 * silently-truncated or unmatched marker could not produce.
 */
function stillMatchesCanonicalScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })

    const backtickDir = join(root, 'still-matches-backtick')
    const backtickEnv = scrubbedGitEnv(root)
    const backtickGit = initScratchRepo(backtickDir, backtickEnv)
    mkdirSync(join(backtickDir, 'src-tauri'), { recursive: true })
    writeFileSync(join(backtickDir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.9'))
    mkdirSync(join(backtickDir, 'src'), { recursive: true })
    writeFileSync(
      join(backtickDir, 'src', 'notes.ts'),
      '// REMOVE AFTER `0.9.9`\nexport const x = 1\n',
    )
    backtickGit('add', '-A')
    const backtickResult = run(backtickDir, backtickEnv, ['--worktree'])
    record(
      'backtick-wrapped `REMOVE AFTER `0.9.9`` still matches canonically and is reported expired, not malformed',
      backtickResult.status === 1 &&
        /0\.9\.9/.test(backtickResult.stderr) &&
        !/not in the canonical/.test(backtickResult.stderr),
      `expected 1 naming 0.9.9 without a malformed report, got ${backtickResult.status}: ${backtickResult.stderr}`,
    )

    const sentenceDir = join(root, 'still-matches-sentence')
    const sentenceEnv = scrubbedGitEnv(root)
    const sentenceGit = initScratchRepo(sentenceDir, sentenceEnv)
    mkdirSync(join(sentenceDir, 'src-tauri'), { recursive: true })
    writeFileSync(join(sentenceDir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.8'))
    mkdirSync(join(sentenceDir, 'src-tauri', 'src'), { recursive: true })
    writeFileSync(
      join(sentenceDir, 'src-tauri', 'src', 'migration.rs'),
      '// REMOVE AFTER 0.3.0. Removal trigger: when `0.3.0` is cut, delete the\n' +
        '// function and its helpers in the same commit that bumps the version.\n' +
        'fn migrate_personal_pages_to_work() {}\n',
    )
    sentenceGit('add', '-A')
    const sentenceResult = run(sentenceDir, sentenceEnv, ['--worktree'])
    record(
      'bare sentence form `REMOVE AFTER 0.3.0. Removal trigger: …` (the original incident) still matches and is reported expired, not malformed',
      sentenceResult.status === 1 &&
        /0\.3\.0/.test(sentenceResult.stderr) &&
        !/not in the canonical/.test(sentenceResult.stderr),
      `expected 1 naming 0.3.0 without a malformed report, got ${sentenceResult.status}: ${sentenceResult.stderr}`,
    )

    return results
  })
}

/**
 * #4146 — a `.md` fenced code block is exempt from BOTH checks, so the
 * convention can finally be documented where a contributor would look for
 * it. Falsification in both directions, mirroring the issue's own
 * acceptance criteria:
 *   - a well-formed example AND a malformed (no-digits) example, both
 *     fenced, in a manifest that has already passed the example's version —
 *     green, because neither line is scanned at all;
 *   - a genuinely expired marker in the SAME file but OUTSIDE the fence —
 *     still red, naming only that line, proving the exemption is scoped to
 *     fenced content and not a blanket pass for the whole file;
 *   - the identical fenced content in a NON-`.md` file (`.ts`) — still red,
 *     proving the exemption is markdown-only, not a general fence syntax
 *     exemption (the issue's own stated caveat: option 3 "only helps
 *     `.md`").
 */
function fencedCodeBlockScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })

    // Both example forms, fenced, are ignored entirely.
    const cleanDir = join(root, 'fenced-clean')
    const cleanEnv = scrubbedGitEnv(root)
    const cleanGit = initScratchRepo(cleanDir, cleanEnv)
    mkdirSync(join(cleanDir, 'src-tauri'), { recursive: true })
    writeFileSync(join(cleanDir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.8'))
    writeFileSync(
      join(cleanDir, 'CONTRIBUTING.md'),
      [
        '# Contributing',
        '',
        'The canonical form:',
        '',
        '```rust',
        '// REMOVE AFTER 0.3.0. Removal trigger: when 0.3.0 is cut, delete this.',
        '```',
        '',
        'A malformed near-miss:',
        '',
        '```rust',
        '// REMOVE AFTER x.y.z, once the replacement API ships',
        '```',
        '',
      ].join('\n'),
    )
    cleanGit('add', '-A')
    const cleanResult = run(cleanDir, cleanEnv, ['--worktree'])
    record(
      'a well-formed example AND a malformed example, both inside md fences, are both ignored (green)',
      cleanResult.status === 0,
      `expected 0, got ${cleanResult.status}: ${cleanResult.stderr}`,
    )

    // The same fenced examples, PLUS a genuinely expired marker outside any
    // fence in the same file — still red, naming only the unfenced line.
    const mixedDir = join(root, 'fenced-mixed')
    const mixedEnv = scrubbedGitEnv(root)
    const mixedGit = initScratchRepo(mixedDir, mixedEnv)
    mkdirSync(join(mixedDir, 'src-tauri'), { recursive: true })
    writeFileSync(join(mixedDir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.8'))
    writeFileSync(
      join(mixedDir, 'CONTRIBUTING.md'),
      [
        '# Contributing',
        '',
        '```rust',
        '// REMOVE AFTER 0.3.0. Removal trigger: when 0.3.0 is cut, delete this.',
        '```',
        '',
        'Oops, a real one, written outside the fence by mistake:',
        'REMOVE AFTER 0.1.0',
        '',
      ].join('\n'),
    )
    mixedGit('add', '-A')
    const mixedResult = run(mixedDir, mixedEnv, ['--worktree'])
    record(
      'a genuinely expired marker OUTSIDE the fence in the same file is still caught',
      mixedResult.status === 1 &&
        /0\.1\.0/.test(mixedResult.stderr) &&
        !/0\.3\.0/.test(mixedResult.stderr) &&
        /CONTRIBUTING\.md/.test(mixedResult.stderr),
      `expected 1 naming only 0.1.0 in CONTRIBUTING.md, got ${mixedResult.status}: ${mixedResult.stderr}`,
    )

    // The exemption is markdown-only: identical fenced content in a `.ts`
    // file is NOT exempt.
    const nonMdDir = join(root, 'fenced-non-md')
    const nonMdEnv = scrubbedGitEnv(root)
    const nonMdGit = initScratchRepo(nonMdDir, nonMdEnv)
    mkdirSync(join(nonMdDir, 'src-tauri'), { recursive: true })
    writeFileSync(join(nonMdDir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.8'))
    mkdirSync(join(nonMdDir, 'src'), { recursive: true })
    // The fence delimiter lines are unindented, unprefixed backticks — the
    // exact shape `MD_FENCE_RE` matches — so this fixture would ALSO be
    // exempted by a fence check that forgot the `isMarkdown` gate; a `// `
    // comment prefix in front of the backticks would not exercise that gate
    // at all (`MD_FENCE_RE` requires the backticks to open the line).
    writeFileSync(
      join(nonMdDir, 'src', 'notes.ts'),
      ['export const x = 1', '```', 'REMOVE AFTER 0.3.0', '```', ''].join('\n'),
    )
    nonMdGit('add', '-A')
    const nonMdResult = run(nonMdDir, nonMdEnv, ['--worktree'])
    record(
      'fence-shaped lines in a non-.md file do NOT exempt a marker — the exemption is markdown-only',
      nonMdResult.status === 1 &&
        /0\.3\.0/.test(nonMdResult.stderr) &&
        /notes\.ts/.test(nonMdResult.stderr),
      `expected 1 naming 0.3.0 in notes.ts, got ${nonMdResult.status}: ${nonMdResult.stderr}`,
    )

    return results
  })
}

/**
 * Adversarial probes of the fence STATE MACHINE itself, not just the
 * exemption's existence (#4146 review). `fencedCodeBlockScenarios` above
 * covers the issue's own acceptance criteria (fenced examples ignored, an
 * unfenced real marker in the same file still caught, `.md`-only); these
 * cover the ways a naive "any fence-shaped line toggles" implementation can
 * be WRONG about where a fence actually starts and ends:
 *
 *   - differing fence lengths: a shorter fence-shaped line NESTED inside a
 *     longer one (a doc showing what a fence looks like, wrapped in a
 *     longer fence so the example itself doesn't terminate the real one)
 *     must not close the outer fence — and, critically, must not desync
 *     the open/close PARITY for the rest of the file. This is a regression
 *     test for a real bug: before length/character matching was added to
 *     `findMarkers`, this exact shape caused a genuinely expired marker in
 *     ordinary prose AFTER the nested example to go unreported (proven
 *     against the code the fix replaced — see `MD_FENCE_BARE_RE`'s call
 *     site).
 *   - `~~~` vs backticks: a fence opened with one delimiter character is
 *     not closed by a fence-shaped line using the OTHER character — same
 *     parity-corruption risk, different trigger.
 *   - indented fences: a fence nested inside a list item (indented 1–3
 *     spaces, CommonMark's own allowance) still opens and closes correctly
 *     — a positive case, not just "still red on the unfenced line".
 *   - an unterminated fence at EOF: a fence opened but never closed
 *     swallows the rest of the file, INCLUDING a genuine expired marker
 *     that follows it — this is accepted, documented behavior (the header's
 *     "Fence detection" paragraph), matching CommonMark's own reading of an
 *     unclosed fence, not a gap this guard closes. The scenario locks that
 *     reading in as intentional so a future change cannot silently narrow
 *     or widen it without this test noticing.
 */
function fenceStateMachineScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })

    // A shorter (3-backtick) fence-shaped line nested inside a longer
    // (4-backtick) fence must stay CONTENT, not close the outer fence —
    // and a real marker in prose after the outer fence's real close must
    // still be caught, proving the parity survived the nested line.
    const lengthDir = join(root, 'fence-length-mismatch')
    const lengthEnv = scrubbedGitEnv(root)
    const lengthGit = initScratchRepo(lengthDir, lengthEnv)
    mkdirSync(join(lengthDir, 'src-tauri'), { recursive: true })
    writeFileSync(join(lengthDir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.8'))
    writeFileSync(
      join(lengthDir, 'CONTRIBUTING.md'),
      [
        'Nested fence example (outer fence longer than the inner one it shows):',
        '',
        '````',
        'outer content',
        '```',
        'more outer content — the 3-backtick line above is literal text inside',
        'the 4-backtick outer fence, not a close',
        '````',
        '',
        'REMOVE AFTER 0.1.0',
        '',
      ].join('\n'),
    )
    lengthGit('add', '-A')
    const lengthResult = run(lengthDir, lengthEnv, ['--worktree'])
    record(
      'a shorter fence-shaped line nested inside a longer fence does not close it, and a real marker after the real close is still caught',
      lengthResult.status === 1 &&
        /0\.1\.0/.test(lengthResult.stderr) &&
        /CONTRIBUTING\.md/.test(lengthResult.stderr),
      `expected 1 naming 0.1.0 in CONTRIBUTING.md, got ${lengthResult.status}: ${lengthResult.stderr}`,
    )

    // A fence opened with tildes is not closed by a backtick-shaped line
    // (or vice versa) — same parity-corruption risk, different trigger.
    const charDir = join(root, 'fence-char-mismatch')
    const charEnv = scrubbedGitEnv(root)
    const charGit = initScratchRepo(charDir, charEnv)
    mkdirSync(join(charDir, 'src-tauri'), { recursive: true })
    writeFileSync(join(charDir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.8'))
    writeFileSync(
      join(charDir, 'CONTRIBUTING.md'),
      [
        'Tilde fence wrapping a backtick example:',
        '',
        '~~~',
        'outer content',
        '```',
        'the 3-backtick line above is literal text inside the tilde fence',
        '~~~',
        '',
        'REMOVE AFTER 0.1.0',
        '',
      ].join('\n'),
    )
    charGit('add', '-A')
    const charResult = run(charDir, charEnv, ['--worktree'])
    record(
      'a backtick-shaped line nested inside a tilde fence does not close it, and a real marker after the real close is still caught',
      charResult.status === 1 &&
        /0\.1\.0/.test(charResult.stderr) &&
        /CONTRIBUTING\.md/.test(charResult.stderr),
      `expected 1 naming 0.1.0 in CONTRIBUTING.md, got ${charResult.status}: ${charResult.stderr}`,
    )

    // A fence indented inside a list item (1-3 spaces) still exempts its
    // content — a positive case for CommonMark's list-indent allowance.
    const indentDir = join(root, 'fence-indented')
    const indentEnv = scrubbedGitEnv(root)
    const indentGit = initScratchRepo(indentDir, indentEnv)
    mkdirSync(join(indentDir, 'src-tauri'), { recursive: true })
    writeFileSync(join(indentDir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.8'))
    writeFileSync(
      join(indentDir, 'CONTRIBUTING.md'),
      [
        '1. Do the thing:',
        '',
        '   ```rust',
        '   // REMOVE AFTER 0.1.0. Example only, inside a list-item fence.',
        '   ```',
        '',
      ].join('\n'),
    )
    indentGit('add', '-A')
    const indentResult = run(indentDir, indentEnv, ['--worktree'])
    record(
      'a fence indented 3 spaces inside a list item still exempts its content (green)',
      indentResult.status === 0,
      `expected 0, got ${indentResult.status}: ${indentResult.stderr}`,
    )

    // An unterminated fence swallows the REST OF THE FILE, including a real
    // expired marker after it — accepted, documented behavior (matches
    // CommonMark's own unclosed-fence reading), locked in so a future
    // change cannot silently alter it without this test noticing.
    const unterminatedDir = join(root, 'fence-unterminated')
    const unterminatedEnv = scrubbedGitEnv(root)
    const unterminatedGit = initScratchRepo(unterminatedDir, unterminatedEnv)
    mkdirSync(join(unterminatedDir, 'src-tauri'), { recursive: true })
    writeFileSync(join(unterminatedDir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.8'))
    writeFileSync(
      join(unterminatedDir, 'CONTRIBUTING.md'),
      [
        '```rust',
        '// an example fence, accidentally never closed',
        '',
        'REMOVE AFTER 0.1.0',
        '',
      ].join('\n'),
    )
    unterminatedGit('add', '-A')
    const unterminatedResult = run(unterminatedDir, unterminatedEnv, ['--worktree'])
    record(
      'an unterminated fence swallows the rest of the file (including a real marker after it) — documented behavior, not a special case',
      unterminatedResult.status === 0,
      `expected 0 (accepted limitation), got ${unterminatedResult.status}: ${unterminatedResult.stderr}`,
    )

    return results
  })
}

/**
 * #4174 — `MD_FENCE_RE`/`MD_FENCE_BARE_RE` widened to recognize a fence
 * inside a blockquote (`> ` prefix), which previously never matched at
 * all: the "fence" never opened, and a `REMOVE AFTER` marker written
 * inside one as inert documentation — as it did in the false-positive
 * #4174 reports, the way CONTRIBUTING.md's own "Marking code with a
 * removal deadline" section does — was scanned as ordinary text and
 * falsely reported as a live marker.
 *
 * #4174's OTHER named shape — a fence nested in a list item at 4+ spaces
 * of content indent — was tried (widening the leading whitespace to
 * unbounded) and REJECTED on review: see the header's "Fence detection"
 * paragraph for why (it cannot be told apart from a plain 4-space indented
 * code block, and demonstrably creates a silent false negative). The first
 * scenario below locks that rejection in: the SAME list-nested fixture
 * #4174 asked to exempt must still be caught (RED), proving the guard did
 * not silently regress to the rejected widening. See
 * `plainIndentedCodeIsNotAFenceScenarios` below for the actual false
 * negative that rejection avoids.
 */
function blockContainerFenceScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })

    // A fence nested in a list item at 4-space content indent — a
    // two-digit ordered marker ("10. ") is itself 4 columns wide, past
    // `MD_FENCE_RE`'s 0–3-space cap. #4174 asked for this to be
    // recognized; review rejected that (see the header), so this stays
    // UNrecognized — the marker is still caught, not exempt.
    const listDir = join(root, 'fence-list-nested')
    const listEnv = scrubbedGitEnv(root)
    const listGit = initScratchRepo(listDir, listEnv)
    mkdirSync(join(listDir, 'src-tauri'), { recursive: true })
    writeFileSync(join(listDir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.8'))
    writeFileSync(
      join(listDir, 'CONTRIBUTING.md'),
      [
        '10. Nested example (a two-digit ordered marker gives 4-space content indent):',
        '',
        '    ```rust',
        '    // REMOVE AFTER 0.1.0. Example only, inside a two-digit ordered list item.',
        '    ```',
        '',
      ].join('\n'),
    )
    listGit('add', '-A')
    const listResult = run(listDir, listEnv, ['--worktree'])
    record(
      'a marker inside a fence nested in a list item at 4-space content indent is NOT exempt (still red) — the widening review rejected, locked in',
      listResult.status === 1 && /0\.1\.0/.test(listResult.stderr),
      `expected 1 naming 0.1.0, got ${listResult.status}: ${listResult.stderr}`,
    )

    // A fence inside a blockquote — the `>` prefix means the delimiter
    // line never matched the old unprefixed-only regex.
    const quoteDir = join(root, 'fence-blockquoted')
    const quoteEnv = scrubbedGitEnv(root)
    const quoteGit = initScratchRepo(quoteDir, quoteEnv)
    mkdirSync(join(quoteDir, 'src-tauri'), { recursive: true })
    writeFileSync(join(quoteDir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.8'))
    writeFileSync(
      join(quoteDir, 'CONTRIBUTING.md'),
      [
        '> Documenting the convention:',
        '>',
        '> ```rust',
        '> // REMOVE AFTER 0.1.0. Example only, inside a blockquote fence.',
        '> ```',
        '',
      ].join('\n'),
    )
    quoteGit('add', '-A')
    const quoteResult = run(quoteDir, quoteEnv, ['--worktree'])
    record(
      'a marker inside a fence inside a blockquote is exempt (green)',
      quoteResult.status === 0,
      `expected 0, got ${quoteResult.status}: ${quoteResult.stderr}`,
    )

    return results
  })
}

/**
 * The false negative the unbounded-indent widening was rejected to avoid
 * (see the header's "Fence detection" paragraph). A PLAIN 4-space indented
 * code block (no list item, no blockquote) whose content happens to start
 * with a fence-shaped line: CommonMark reads that whole block as literal
 * indented-code text, never a fence. An UNBOUNDED `MD_FENCE_RE` reads the
 * fence-shaped line as an OPEN instead — and since the block is not
 * actually a fence, nothing that follows carries a matching bare closer,
 * so the "fence" stays open through EOF, silently skipping every line
 * after it, including a genuinely live `REMOVE AFTER` marker elsewhere in
 * the document. `MD_FENCE_RE`'s 0–3-space cap means the indented line
 * never matches at all, so this fixture's marker is caught throughout —
 * this is the fixture that would have gone red-before/green-after had the
 * rejected widening shipped instead: red under the unbounded regex
 * (swallowed, exit 0 — wrongly GREEN, an unreported expired marker), red
 * (correctly, exit 1) under the shipped 0–3 cap.
 *
 * The other two cases pin the same property against the two OTHER ways the
 * cap can be widened past CommonMark, both of which shipped briefly on this
 * branch and were caught on review — each was genuinely red-before (exit 0,
 * marker swallowed) and green-after here:
 *   - a TAB-indented block. Admitting `\t` into the leading-indent class
 *     (`[ \t]{0,3}`) lets ONE tab satisfy the 0–3 cap, but CommonMark
 *     expands a tab to the next 4-column tab stop, so one tab is already
 *     4 columns of indented code.
 *   - a `>` marker at 4 leading spaces. An unbounded whitespace star before
 *     each marker (`(?:[ \t]*>)*`) opens a depth-1 fence there; CommonMark
 *     caps the pre-marker indent at 3 spaces, so at 4 the line is indented
 *     code and the `>` is literal text.
 */
function plainIndentedCodeIsNotAFenceScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })

    // Each case: a document whose indented-code block holds a fence-SHAPED
    // line that must NOT open a fence, followed by a genuinely expired
    // marker in ordinary prose. If the shaped line phantom-opens, the
    // fence never closes (nothing below is a matching bare closer) and the
    // marker is silently swallowed — exit 0 instead of 1.
    const phantom = (slug, name, docLines) => {
      const dir = join(root, slug)
      const env = scrubbedGitEnv(root)
      const git = initScratchRepo(dir, env)
      mkdirSync(join(dir, 'src-tauri'), { recursive: true })
      writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.8'))
      writeFileSync(
        join(dir, 'CONTRIBUTING.md'),
        [
          ...docLines,
          '',
          'Back to normal prose. Here is a REAL expired marker:',
          '',
          'REMOVE AFTER 0.1.0',
          '',
        ].join('\n'),
      )
      git('add', '-A')
      const result = run(dir, env, ['--worktree'])
      record(
        name,
        result.status === 1 && /0\.1\.0/.test(result.stderr),
        `expected 1 naming 0.1.0, got ${result.status}: ${result.stderr}`,
      )
    }

    phantom(
      'plain-indented-code-phantom-fence',
      'a fence-shaped line inside a plain 4-space indented code block does not phantom-open a fence — a real marker later in the document is still caught',
      [
        'Some doc text.',
        '',
        '    This is a PLAIN 4-space indented code block (not a list item,',
        '    not a fenced block). Its content happens to include a line',
        '    that looks like a fence opener:',
        '    ```',
        '    that indented line above is CommonMark literal text, not a fence',
      ],
    )

    // Same shape, indented with a TAB. CommonMark expands a tab to the
    // next 4-column tab stop, so ONE leading tab is already 4 columns —
    // indented code, never a fence. A leading-indent class that admits
    // `\t` alongside the space lets a single tab satisfy the 0–3
    // repetition cap and phantom-opens here.
    phantom(
      'tab-indented-code-phantom-fence',
      'a fence-shaped line inside a TAB-indented code block does not phantom-open a fence — one tab is 4 columns, past the 0–3 cap',
      [
        'Some doc text.',
        '',
        '\tThis is a TAB-indented code block — one tab expands to the next',
        '\t4-column tab stop, so this is indented code, not a fence:',
        '\t```',
        '\tthat tab-indented line above is CommonMark literal text',
      ],
    )

    // A `>` marker preceded by FOUR spaces. CommonMark allows 0–3 spaces
    // before a block-quote marker; at 4 the line is plain indented code
    // and the `>` is literal text. A blockquote-prefix group with an
    // UNBOUNDED whitespace star before each marker opens a depth-1 fence
    // here instead.
    phantom(
      'overindented-blockquote-phantom-fence',
      'a fence-shaped line whose `>` marker carries FOUR leading spaces does not phantom-open a blockquoted fence — 4 spaces before the marker is indented code',
      [
        'Some doc text.',
        '',
        '    This is a PLAIN 4-space indented code block whose content',
        '    happens to start with a blockquote-shaped fence line:',
        '    > ```',
        '    that line above is CommonMark literal text, not a blockquote',
      ],
    )

    return results
  })
}

/**
 * The false negative a blockquote-depth-BLIND close check would create
 * (see the header's "Fence detection" paragraph): without requiring the
 * closer's blockquote nesting depth to match the opener's, a bare fence
 * and a blockquoted fence — two otherwise-unrelated fences that merely
 * share a character and length — can close EACH OTHER's containers,
 * desyncing open/close parity for the rest of the file.
 *
 * Concretely: a bare fence opens; a blockquoted aside elsewhere (`> ` ```,
 * alone on its own line — e.g. quoting someone explaining "just write
 * ` ``` `") happens to match the same character/length and, without a
 * depth check, closes the bare fence EARLY. The bare fence's own real,
 * intended closer then reads as a fresh OPEN (since the fence state is
 * already `null`), silently swallowing everything after it, including a
 * genuinely live marker. Requiring the depth to match means the
 * mismatched blockquoted line never closes the bare fence — it stays open
 * content until the real bare closer is reached, exactly once, at the
 * right place.
 *
 * This is the fixture that was red-before/green-after in review: GREEN
 * (wrongly — exit 0, an unreported expired marker) before the depth check
 * was added, RED (correctly — exit 1) after.
 */
function blockquoteDepthMismatchScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })

    const dir = join(root, 'blockquote-depth-mismatch-cascade')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    mkdirSync(join(dir, 'src-tauri'), { recursive: true })
    writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.8'))
    writeFileSync(
      join(dir, 'CONTRIBUTING.md'),
      [
        '```',
        'genuinely hidden line 1',
        '> ```',
        'genuinely hidden line 2 (must still be hidden — the line above must',
        'not close this fence; its blockquote depth does not match the opener)',
        '```',
        '',
        'REMOVE AFTER 0.1.0',
        '',
      ].join('\n'),
    )
    git('add', '-A')
    const result = run(dir, env, ['--worktree'])
    record(
      'a depth-mismatched blockquoted fence-shaped line does not close a bare fence early — the real closer still closes it once, and a marker after is caught',
      result.status === 1 && /0\.1\.0/.test(result.stderr),
      `expected 1 naming 0.1.0, got ${result.status}: ${result.stderr}`,
    )

    return results
  })
}

/**
 * `SCAN_EXT_RE` covers `.js`/`.mjs` so a marker left in a GUARD SCRIPT is as
 * findable as one in application source — a fixture `.mjs` file under
 * `scripts/` (NOT this guard's own `SELF_PATH`) with an expired marker must
 * be reported, proving the extension is genuinely in scan scope rather than
 * merely claimed in the header.
 */
function scriptExtensionScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'script-extension')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    mkdirSync(join(dir, 'src-tauri'), { recursive: true })
    writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), tauriConf('3.0.0'))
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(
      join(dir, 'scripts', 'some-other-guard.mjs'),
      '// REMOVE AFTER 0.1.0 — delete this fixture guard once cut.\nconsole.log("guard")\n',
    )
    git('add', '-A')
    const result = run(dir, env, ['--worktree'])
    record(
      'an expired marker inside a `.mjs` script (not this guard itself) is caught, not scan-exempt',
      result.status === 1 &&
        /0\.1\.0/.test(result.stderr) &&
        /some-other-guard\.mjs/.test(result.stderr),
      `expected 1 naming 0.1.0 in some-other-guard.mjs, got ${result.status}: ${result.stderr}`,
    )
    return results
  })
}

/**
 * #3962 — index vs working tree, ONE targeted pair (not the full generic
 * battery — this guard's fixture needs TWO tracked files in lockstep, which
 * the shared single-file `runSourceScenarios` harness does not model): a
 * marker staged as expired, then fixed on disk WITHOUT `git add`. The
 * WORKING TREE reader must see the fix; the INDEX reader must still block
 * the commit that is actually about to land.
 */
function sourceScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'source')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    mkdirSync(join(dir, 'src-tauri'), { recursive: true })
    writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), tauriConf('2.0.0'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'notes.ts'), '// REMOVE AFTER 0.1.0\nexport const x = 1\n')
    git('add', '-A')
    // Fixed on disk, NOT re-staged — the commit still carries the expired
    // marker.
    writeFileSync(join(dir, 'src', 'notes.ts'), '// REMOVE AFTER 9.9.9\nexport const x = 1\n')
    const cached = run(dir, env, ['--cached'])
    const worktree = run(dir, env, ['--worktree'])
    record(
      'the INDEX reader still blocks the commit that actually carries the expired marker',
      cached.status === 1 && /0\.1\.0/.test(cached.stderr),
      `expected 1 naming 0.1.0, got ${cached.status}: ${cached.stderr}`,
    )
    record(
      'the WORKING TREE reader sees the on-disk fix (a different, and valid, question)',
      worktree.status === 0,
      `expected 0, got ${worktree.status}: ${worktree.stderr}`,
    )
    return results
  })
}

/**
 * Extract one top-level GitHub Actions job's body from a workflow file's
 * raw text: from the `  <jobName>:` header line (exclusive) to the line
 * before the next top-level job KEY (or EOF). A coarse, indentation-based
 * slice — not a YAML parser — but jobs in this repo's workflows are always
 * top-level 2-space keys (verified against `_validate.yml`'s own job list),
 * which is all this needs.
 *
 * The termination check matches an actual job-key SHAPE
 * (`^ {2}[A-Za-z_][\w-]*:(?:\s|$)`), not merely "the first 2-space-indented,
 * non-space line" (#4175 finding 2). `_validate.yml` happens to put a
 * `# ---` comment banner at 2-space indent between jobs, which the old,
 * looser check also matched — but only by COINCIDENCE: any real job key
 * matches the looser check too (a job key is always 2-space-indented,
 * non-space), so the banner was never load-bearing for correctness, and
 * removing it changes nothing either way. What the looser check actually
 * got wrong is the other direction — a stray 2-space-indented COMMENT
 * *inside* a job body (not a banner between jobs) would terminate the slice
 * right there, silently truncating the rest of the job. Matching the
 * job-key shape instead means only a real job key ends the block, whatever
 * comments do or don't appear at 2-space indent along the way. See
 * `extractJobBlockScenarios` below for the falsifying fixture.
 *
 * The key shape deliberately tolerates TRAILING CONTENT after the colon
 * (`(?:\s|$)`, not `\s*$`). Anchoring at end-of-line narrows the match set
 * to a strict subset of the old check's, which fixes stopping too EARLY but
 * introduces the opposite failure the old check could not have: a next-job
 * key written with a trailing comment (`  vitest: # docs-only PRs skip it`)
 * or a YAML anchor (`  vitest: &vitest`) is a real job key that `\s*$`
 * refuses, so the slice runs ON into the following jobs. `docsLintWiring
 * Scenario` would then be searching a body containing OTHER jobs' steps and
 * could match one of THEIR `prek run --all-files` lines — passing the #4147
 * wiring assertion vacuously, against a run line that has nothing to do with
 * `docs-lint`. A comment cannot be mistaken for a key either way: `#` is not
 * in `[A-Za-z_]`.
 */
function extractJobBlock(text, jobName) {
  const lines = text.split('\n')
  const headerRe = new RegExp(`^ {2}${jobName}:\\s*$`)
  const start = lines.findIndex((l) => headerRe.test(l))
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z_][\w-]*:(?:\s|$)/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start + 1, end).join('\n')
}

/**
 * #4147 wiring check — NOT a fixture scenario like its siblings above. The
 * bug was that `_validate.yml`'s `docs-lint` job (the docs-only fast path)
 * omitted this hook from its explicit `prek run --all-files <ids…>` hook
 * list, so a docs-only PR never ran this guard against `.md` at all. That
 * is a property of a WORKFLOW FILE this guard has no runtime relationship
 * to and cannot exercise by running itself against a scratch repo — so
 * this reads the REAL repo's `_validate.yml` (not a fixture) and asserts
 * the wiring textually, the same "read the real file, not a simulation of
 * it" shape `scripts/check-zizmor-version-pin.mjs` uses for its own
 * cross-file consistency check.
 *
 * Failing to find a `docs-lint:` job at all — or a `run: prek run
 * --all-files …` line inside it — is ALSO a failure, not a silent pass:
 * same "an empty scan throws" reasoning `check-zizmor-version-pin.mjs`
 * documents — a workflow restructure that renames the job or the step
 * would otherwise make this scenario green by construction forever, which
 * is the opposite of what it exists to catch.
 *
 * Scope, honestly stated: this only catches drift when `--self-test` runs
 * — today that means whenever THIS SCRIPT changes (the
 * `remove-after-markers-selftest` pre-commit hook's `files` pattern), not
 * on every future edit to `_validate.yml` itself. Wiring the selftest hook
 * to also fire on workflow edits was considered and rejected: `_validate.yml`
 * is a large, frequently-touched file for many unrelated reasons, and
 * spinning up this file's full scratch-repo self-test battery on every
 * touch would be disproportionate noise for one string check. This closes
 * the "no local test at all" gap for THIS fix without taking on that wider,
 * separate design decision.
 */
/**
 * The `run:` line inside a `docs-lint`-shaped job body that actually names
 * this hook — NOT simply the first `run: prek run --all-files …` line
 * (#4175 finding 1). `_validate.yml`'s `docs-lint` job has TWO steps whose
 * `run:` line matches that shape: the doc-hooks step (which must name
 * `remove-after-markers`) and a `--hook-stage pre-push lychee` step. A bare
 * `.find()` over both would only be correct by STEP ORDER — whichever one
 * happens to come first in the job body. Excluding the
 * `--hook-stage`-qualified line picks the doc-hooks step regardless of
 * which one comes first, so a future reordering of the two steps can't
 * silently make this scenario assert against the wrong line. See
 * `docsLintRunLineOrderScenario` below for the falsifying fixture.
 */
function findDocsLintRunLine(jobBody) {
  return jobBody
    .split('\n')
    .find((l) => /^\s*run:\s*prek run --all-files\b/.test(l) && !/--hook-stage\b/.test(l))
}

function docsLintWiringScenario() {
  const results = []
  const record = (name, ok, detail = '') => results.push({ name, ok, detail })
  const workflowPath = join(REPO_ROOT, '.github', 'workflows', '_validate.yml')
  let text
  try {
    text = readFileSync(workflowPath, 'utf8')
  } catch (err) {
    record('_validate.yml is readable', false, `${workflowPath}: ${err.message}`)
    return results
  }
  const jobBody = extractJobBlock(text, 'docs-lint')
  if (jobBody === null) {
    record(
      "the docs-lint job's prek hook list includes remove-after-markers (#4147)",
      false,
      'no `  docs-lint:` job found in _validate.yml — job renamed or removed?',
    )
    return results
  }
  const runLine = findDocsLintRunLine(jobBody)
  record(
    "the docs-lint job's prek hook list includes remove-after-markers (#4147)",
    !!runLine && /\bremove-after-markers\b/.test(runLine),
    runLine
      ? `docs-lint's run line: ${runLine.trim()}`
      : 'no non-`--hook-stage` `run: prek run --all-files …` line found in the docs-lint job',
  )
  return results
}

/**
 * #4175 finding 1 — falsification of the `.find()` first-match-wins
 * dependency `findDocsLintRunLine` replaces. A synthetic docs-lint-shaped
 * job body carrying the SAME two `run: prek run --all-files` steps as the
 * real job, but in REVERSE order (the `--hook-stage pre-push lychee` step
 * BEFORE the doc-hooks step) — the exact shape a future reordering of
 * `_validate.yml`'s steps could produce. A naive first-match `.find()`
 * would return the lychee line here, which does not name
 * `remove-after-markers`, and the wiring check would wrongly fail even
 * though the job IS correctly wired — proving the matcher has to find the
 * doc-hooks line by its shape, not by position.
 */
function docsLintRunLineOrderScenario() {
  const results = []
  const record = (name, ok, detail = '') => results.push({ name, ok, detail })
  const reversedJobBody = [
    '    needs: detect-changes',
    '    steps:',
    '      - name: Run lychee link check (pre-push-staged hook)',
    '        run: prek run --all-files --hook-stage pre-push lychee',
    '      - name: Run doc-only prek hooks (markdownlint, link/citation, typos, remove-after-markers)',
    '        run: prek run --all-files markdownlint md-link-targets doc-vs-code-paths typos remove-after-markers',
  ].join('\n')
  const runLine = findDocsLintRunLine(reversedJobBody)
  record(
    'the doc-hooks run line is found even when the --hook-stage lychee step comes first in the job body (order-independent)',
    !!runLine && /\bremove-after-markers\b/.test(runLine),
    runLine ? `matched: ${runLine.trim()}` : 'no non-`--hook-stage` run line found',
  )
  return results
}

/**
 * #4175 finding 2 — falsification of `extractJobBlock`'s termination
 * condition, in BOTH directions.
 *
 * Too EARLY: every real job-key line already satisfies the ORIGINAL "any
 * 2-space-indented non-space line" condition, so that check could only go
 * wrong by stopping too early, on a 2-space-indented line that is not a job
 * key. The falsifying fixture is a stray 2-space-indented comment INSIDE a
 * job body (not a banner between jobs): the original code truncates the
 * block right there, losing the rest of the job — in the real file, that
 * would mean losing the `remove-after-markers` run line itself.
 *
 * Too LATE: tightening to a job-key shape ANCHORED at end of line
 * (`:\s*$`) fixes that but opens the opposite hole, which the original
 * check could not have had — its match set was a strict superset. A real
 * job key carrying a trailing comment or a YAML anchor no longer
 * terminates, so the slice runs on into following jobs and
 * `findDocsLintRunLine` can match one of THEIR run lines, passing the
 * #4147 wiring assertion vacuously. The last two fixtures below pin that:
 * the first shows the leak directly, the second shows the vacuous pass it
 * causes. Both are red under `:\s*$` and green under the shipped
 * `:(?:\s|$)`.
 *
 * The issue's OTHER named case — the `# ---` banner between jobs simply
 * REMOVED, next job's key following directly — is kept here too, but does
 * NOT diverge under the old code, and structurally cannot: the next job's
 * key line is itself a 2-space-indented non-space line, so it already
 * satisfies the old condition on its own, banner or not (verified: same
 * output either way). It is included as a locked-in correctness case, not
 * a red-before/green-after fixture.
 */
function extractJobBlockScenarios() {
  const results = []
  const record = (name, ok, detail = '') => results.push({ name, ok, detail })

  const makeFixture = (middleLines, nextJobKey = '  vitest:') =>
    [
      '  docs-lint:',
      '    needs: detect-changes',
      '    steps:',
      '      - name: doc hooks',
      ...middleLines,
      '        run: prek run --all-files markdownlint remove-after-markers',
      '      - name: lychee',
      '        run: prek run --all-files --hook-stage pre-push lychee',
      nextJobKey,
      '    needs: detect-changes',
    ].join('\n')

  const noBannerBody = extractJobBlock(makeFixture([]), 'docs-lint')
  record(
    'with no `# ---` banner at all, the block still ends exactly at the next job key (not a red-before case — see doc comment above)',
    !!noBannerBody && /remove-after-markers/.test(noBannerBody) && !/vitest/.test(noBannerBody),
    `got: ${JSON.stringify(noBannerBody)}`,
  )

  const interiorBody = extractJobBlock(
    makeFixture(['  # a stray 2-space-indented comment landing inside the job body']),
    'docs-lint',
  )
  record(
    'a 2-space-indented comment INSIDE the job body does not truncate the block early',
    !!interiorBody && /remove-after-markers/.test(interiorBody) && !/vitest/.test(interiorBody),
    `got: ${JSON.stringify(interiorBody)}`,
  )

  // Red-before/green-after for the OTHER direction — stopping too LATE.
  // The next job's key carries a trailing comment, which an end-anchored
  // key shape (`:\s*$`) refuses, so the slice runs on into that job.
  const trailingCommentBody = extractJobBlock(
    makeFixture([], '  vitest: # docs-only PRs skip this one'),
    'docs-lint',
  )
  record(
    'a next-job key with a TRAILING COMMENT still terminates the block — the slice does not run on into the following job',
    !!trailingCommentBody &&
      /remove-after-markers/.test(trailingCommentBody) &&
      !/vitest/.test(trailingCommentBody),
    `got: ${JSON.stringify(trailingCommentBody)}`,
  )

  // The consequence that makes stopping too late a real defect, not a
  // cosmetic one: a docs-lint job with NO doc-hooks `prek run --all-files`
  // step of its own (exactly the #4147 bug) must FAIL the wiring check. If
  // the block runs on past a trailing-comment job key, `findDocsLintRunLine`
  // finds the NEXT job's run line instead and the assertion passes
  // VACUOUSLY, against a line that has nothing to do with docs-lint.
  const vacuousFixture = [
    '  docs-lint:',
    '    needs: detect-changes',
    '    steps:',
    '      - name: lychee',
    '        run: prek run --all-files --hook-stage pre-push lychee',
    '  other-lint: # a job key with a trailing comment',
    '    steps:',
    '      - name: doc hooks',
    '        run: prek run --all-files markdownlint remove-after-markers',
  ].join('\n')
  const vacuousRunLine = findDocsLintRunLine(extractJobBlock(vacuousFixture, 'docs-lint') ?? '')
  record(
    "a docs-lint job missing its own doc-hooks run line does not borrow a LATER job's — the #4147 wiring check cannot pass vacuously",
    vacuousRunLine === undefined,
    `expected no run line, got: ${JSON.stringify(vacuousRunLine)}`,
  )

  return results
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'remove-after-markers-selftest-'))
  try {
    const results = [
      ...expiryScenarios(root),
      ...numericComparisonScenarios(root),
      ...malformedScenarios(root),
      ...nearMissFormScenarios(root),
      ...stillMatchesCanonicalScenarios(root),
      ...fencedCodeBlockScenarios(root),
      ...fenceStateMachineScenarios(root),
      ...blockContainerFenceScenarios(root),
      ...plainIndentedCodeIsNotAFenceScenarios(root),
      ...blockquoteDepthMismatchScenarios(root),
      ...scriptExtensionScenarios(root),
      ...sourceScenarios(root),
      ...docsLintWiringScenario(),
      ...docsLintRunLineOrderScenario(),
      ...extractJobBlockScenarios(),
    ]
    let failures = 0
    for (const result of results) {
      if (result.ok) {
        console.log(`  ok   - ${result.name}`)
      } else {
        failures += 1
        console.error(`  FAIL - ${result.name}: ${result.detail}`)
      }
    }
    if (failures > 0) {
      console.error('\nself-test FAILED')
      return 1
    }
    console.log('self-test OK')
    return 0
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

process.exit(process.argv.includes('--self-test') ? selfTest() : check())
