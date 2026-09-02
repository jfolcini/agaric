#!/usr/bin/env node
// #3737 — `.github/zizmor.yml` used to suppress zizmor's `cache-poisoning`
// finding on ci.yml's build-only cache steps (`Swatinem/rust-cache` and
// `actions/setup-node`) by LINE NUMBER: `ci.yml:318`, etc. A line
// number is not a key for "this step" — it is a key for "whatever text is on
// this line today". Four times in one day, an unrelated comment added
// anywhere above those anchors in ci.yml shifted every line below it, so a
// diff that touched no cache step turned four suppressed findings into four
// `high` failures (loud direction) — and, un-noticed until it happens, could
// just as easily re-attach an anchor to a *different* step and silently
// suppress a real new finding (quiet direction). Full history: the file
// header of `.github/zizmor.yml`.
//
// The fix is to stop anchoring by position. zizmor has its own suppression
// mechanism for exactly this: a `# zizmor: ignore[rule-id]` comment placed
// anywhere inside the finding's step (see `IGNORE_EXPR` in zizmor's
// `finding/location.rs`). That anchors to the step's CONTENT — the comment
// travels with the step through any number of unrelated edits elsewhere in
// the file — so `.github/zizmor.yml` no longer carries a `cache-poisoning`
// `ignore:` list at all; each suppression lives as an inline comment on the
// step it covers (`EXPECTED_INLINE_SUPPRESSIONS` below counts them).
//
// This guard protects that invariant two ways:
//   1. `.github/zizmor.yml` must never regain a line-anchored
//      `cache-poisoning` `ignore:` list — that would be reintroducing the
//      exact fragility #3737 removed.
//   2. At least one inline `# zizmor: ignore[cache-poisoning]` comment must
//      exist somewhere under `.github/workflows/**` — finding zero is a
//      WIRING failure (this guard, or the suppression mechanism itself, has
//      fallen out of step with the repo), not a vacuous pass. Same shape as
//      `check-zizmor-version-pin.mjs`'s "zero tool: sites found" guard.
//
// Deliberately NOT re-implementing zizmor's own cache-poisoning heuristics
// (which steps actually trigger the audit, under which `on:` triggers) in
// JS: that would be a second copy of logic zizmor already owns, and a
// second copy is exactly the kind of thing these guards exist to catch
// drifting apart, not to create (see `scripts/check-mutants-scope.mjs`'s
// note on why this family of script avoids importing a YAML library and
// stays line-based — the same reasoning applies one level up to avoiding a
// second audit engine).
//
// Usage:
//   node scripts/check-cache-poisoning-suppressions.mjs
//
// Exit codes: 0 = healthy; 1 = a real problem (or the wiring guard above).

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const SCRIPTS_DIR = import.meta.dirname
const REPO_ROOT = join(SCRIPTS_DIR, '..')
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows')
const ZIZMOR_CONFIG_PATH = join(REPO_ROOT, '.github', 'zizmor.yml')

/**
 * How many inline `# zizmor: ignore[cache-poisoning]` suppressions the repo
 * is expected to carry — the two on ci.yml's `android-build` cache steps.
 * The `build` job's pair went with those steps into
 * `.github/actions/toolchain`, where the audit does not fire: cache-poisoning
 * keys off a workflow's publishing triggers, and a composite action has none.
 *
 * EXACT on purpose, and the strictness is the point: `checkHygiene` only
 * notices zero, so without an exact count a suppression appearing in some
 * other workflow — a decision nobody reviewed as a cache-poisoning decision —
 * lands silently. Adding a fifth is a legitimate thing to do; it just has to
 * be a deliberate edit here, which is why the failure detail says so instead
 * of reading like a defect report.
 */
export const EXPECTED_INLINE_SUPPRESSIONS = 2

// ---------------------------------------------------------------------------
// (1) The regression this guard exists to catch: a line-anchored
//     `cache-poisoning` ignore list reappearing in the baseline file.
// ---------------------------------------------------------------------------

/**
 * Scans `.github/zizmor.yml`'s text for a `rules: / cache-poisoning: /
 * ignore:` block and returns every `filename.yml:NNN`-shaped entry found
 * inside it — the exact shape #3737 removed. An empty array means healthy
 * (no rule block, or a rule block with no `ignore:` list, or an `ignore:`
 * list that names something other than a bare workflow-line anchor).
 *
 * Line-based on purpose (see file header): this only needs to recognise the
 * one shape it must forbid, not parse arbitrary zizmor config YAML.
 *
 * The key is matched at ANY indent, and with optional quotes. It used to
 * require exactly two spaces, which made the guard fail OPEN on its own
 * subject matter: reformatting `.github/zizmor.yml` to four-space indent —
 * something a YAML formatter does without anyone reading the diff — put the
 * forbidden shape back while `checkHygiene` reported healthy, because
 * `ruleLineIdx === -1` returns `[]` and `[]` means "no problem". Over-
 * matching (a `cache-poisoning:` key nested somewhere unexpected) can only
 * make this guard louder, and loud is the direction it must err in.
 *
 * EVERY occurrence of the key is scanned, not just the first. `findIndex`
 * stopped at occurrence one, so a second `cache-poisoning:` block — a
 * duplicate key, a per-`rules:` section, a merged config — carried its
 * anchors past the guard, and `[]` is again how this module spells
 * "healthy". That is the same fail-open SHAPE as the four-space-indent bug
 * above, one axis over; a loop is the whole cost of closing it.
 *
 * And COMMENTS do not end a block. They carry no YAML structure, but the
 * dedent test treated them as if they did, so a banner or a commented-out
 * anchor at column 0 inside the block truncated the scan — `[]`, healthy,
 * third instance of the same family in this one function. Blank lines were
 * already exempt for exactly this reason; comments are the same case.
 */
const CACHE_POISONING_KEY_RE = /^\s*['"]?cache-poisoning['"]?:\s*$/

export function findLineAnchoredCachePoisoningIgnores(zizmorYmlText) {
  const lines = zizmorYmlText.split('\n')
  const anchors = []
  for (const [ruleLineIdx, ruleLine] of lines.entries()) {
    if (!CACHE_POISONING_KEY_RE.test(ruleLine)) continue
    const ruleIndent = ruleLine.match(/^(\s*)/)[1].length
    for (let i = ruleLineIdx + 1; i < lines.length; i++) {
      const line = lines[i]
      // Blank lines and comments are not structure: neither can end a block,
      // and an anchor line's own trailing comment is handled by the match
      // below. A `#` at column 0 used to end it, which read as healthy.
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      const indent = line.match(/^(\s*)/)[1].length
      // Dedented back to (or past) the `cache-poisoning:` key's own indent —
      // its block has ended.
      if (indent <= ruleIndent) break
      const m = line.match(/^\s*-\s*([^\s#]+\.ya?ml:\d+(?::\d+)?)\s*(?:#.*)?$/)
      if (m) anchors.push(m[1])
    }
  }
  return anchors
}

// ---------------------------------------------------------------------------
// (2) Inventory of the inline suppressions that replaced the anchor list.
// ---------------------------------------------------------------------------

const INLINE_IGNORE_RE = /#\s*zizmor:\s*ignore\[([^\]]*)\]/

/**
 * True when a line carries an inline zizmor suppression that names
 * `cache-poisoning` — including as one entry of a comma-separated list.
 *
 * Shared by the inventory scan and by the negative control's "strip today's
 * suppressions" step, which must strip THESE and only these: stripping every
 * inline ignore regardless of rule id was correct only for as long as every
 * inline ignore in ci.yml happened to be a cache-poisoning one. The first
 * suppression for some other rule would have been deleted along with them
 * and its finding attributed to the control's line-anchor list.
 */
export function ignoresCachePoisoning(line) {
  const m = line.match(INLINE_IGNORE_RE)
  if (!m) return false
  return m[1]
    .split(',')
    .map((r) => r.trim())
    .includes('cache-poisoning')
}

/** Every `.yml`/`.yaml` under `dir`, recursively, as paths relative to `dir`. */
function workflowFilesUnder(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...workflowFilesUnder(join(dir, entry.name), rel))
    } else if (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) {
      out.push(rel)
    }
  }
  return out
}

/**
 * Every `# zizmor: ignore[...]` comment naming `cache-poisoning` found
 * across `.github/workflows/**`, as `{ location }` (`file:line`). Scans ALL
 * workflow files, not a hardcoded filename list, for the same reason
 * `check-zizmor-version-pin.mjs`'s `findZizmorToolPins` does: a suppression
 * moved or added to a different workflow is covered automatically.
 *
 * Recursive, so the `**` in that description is the truth and not a rounding
 * of it: `.github/zizmor.yml` and this script's header both describe the
 * coverage that way, and a flat `readdirSync` would have quietly stopped
 * counting a suppression parked one directory down.
 */
export function findInlineCachePoisoningSuppressions(dir = WORKFLOWS_DIR) {
  if (!existsSync(dir)) throw new Error(`no workflow directory at ${dir}`)
  const hits = []
  for (const name of workflowFilesUnder(dir)) {
    const text = readFileSync(join(dir, name), 'utf8')
    text.split('\n').forEach((line, idx) => {
      if (ignoresCachePoisoning(line)) hits.push({ location: `${name}:${idx + 1}` })
    })
  }
  return hits
}

// ---------------------------------------------------------------------------
// Consistency check
// ---------------------------------------------------------------------------

/**
 * Returns an array of human-readable problem strings — empty means healthy.
 *
 * `expectedInlineSuppressions` is OPTIONAL and undefined by default: the
 * count check only runs when a caller supplies it, so the unit tests below
 * that construct small `inlineHits` fixtures (one hit, two hits) are not
 * accidentally asserting against the real repo's count of four. The one
 * caller that DOES supply it is `assertCachePoisoningSuppressionHygiene`
 * (via `main()`) — see its comment for why that is where an exact-count
 * check must live to actually be reachable (#3987).
 */
export function checkHygiene({ lineAnchors, inlineHits, expectedInlineSuppressions }) {
  const problems = []
  if (lineAnchors.length > 0) {
    problems.push(
      `.github/zizmor.yml has a line-anchored \`cache-poisoning\` ignore list again ` +
        `(${lineAnchors.join(', ')}) — this is the exact fragility #3737 removed. Suppress ` +
        `the finding with an inline \`# zizmor: ignore[cache-poisoning]\` comment on the step ` +
        `itself instead, and delete the anchor.`,
    )
  }
  if (inlineHits.length === 0) {
    problems.push(
      'no `# zizmor: ignore[cache-poisoning]` comment found anywhere in .github/workflows/** — ' +
        'either the suppression mechanism this guard checks has moved (update this script), ' +
        'or every cache-poisoning finding was fixed outright and the suppressions were rightly ' +
        'deleted (delete this guard too), or a suppression was deleted by accident (restore it)',
    )
  } else if (
    expectedInlineSuppressions !== undefined &&
    inlineHits.length !== expectedInlineSuppressions
  ) {
    problems.push(
      `.github/workflows/** carries ${inlineHits.length} inline ` +
        `\`# zizmor: ignore[cache-poisoning]\` suppression(s) ` +
        `(${inlineHits.map((h) => h.location).join(', ')}), not the expected ` +
        `${expectedInlineSuppressions} — if you ADDED one on purpose, bump ` +
        `EXPECTED_INLINE_SUPPRESSIONS in scripts/check-cache-poisoning-suppressions.mjs ` +
        `(and say in the commit which step it covers); if you did not, a suppression appeared ` +
        `or vanished without review. Checked on every run of this \`always_run\` hook, whichever files changed.`,
    )
  }
  return problems
}

/**
 * Throws with every problem spelled out, or returns silently.
 *
 * #3987 — `expectedInlineSuppressions` defaults to `EXPECTED_INLINE_SUPPRESSIONS`
 * HERE, in the path `main()` calls, and `main()` is what the
 * `cache-poisoning-suppressions` prek hook runs on EVERY commit
 * (`always_run = true`). Before this, the exact-count assertion lived behind
 * a narrow `files` pattern, so a fifth suppression added to a workflow
 * outside those paths (e.g. `release.yml`) tripped nothing: the narrow hook
 * never re-ran, and the always-run hook's `checkHygiene` only ever noticed
 * zero. Checking the count here closes that gap — it runs whether or not the
 * touched file is one this guard already watches.
 */
export function assertCachePoisoningSuppressionHygiene({
  zizmorConfigPath = ZIZMOR_CONFIG_PATH,
  workflowsDir = WORKFLOWS_DIR,
  expectedInlineSuppressions = EXPECTED_INLINE_SUPPRESSIONS,
} = {}) {
  const lineAnchors = findLineAnchoredCachePoisoningIgnores(readFileSync(zizmorConfigPath, 'utf8'))
  const inlineHits = findInlineCachePoisoningSuppressions(workflowsDir)
  const problems = checkHygiene({ lineAnchors, inlineHits, expectedInlineSuppressions })
  if (problems.length > 0) {
    throw new Error(
      `scripts/check-cache-poisoning-suppressions.mjs found a problem (#3737):\n  - ${problems.join('\n  - ')}`,
    )
  }
  return { lineAnchors, inlineHits }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main() {
  const { inlineHits } = assertCachePoisoningSuppressionHygiene()
  console.log(
    `OK  cache-poisoning suppressions: no line-anchored ignore list, ${inlineHits.length} inline suppression(s) found (${inlineHits.map((h) => h.location).join(', ')})`,
  )
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  try {
    main()
  } catch (err) {
    console.error(`check-cache-poisoning-suppressions: ${err.message}`)
    process.exit(1)
  }
}
