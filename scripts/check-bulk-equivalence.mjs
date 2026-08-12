#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Bulk-vs-fold equivalence inventory ratchet (#3346).
//
// Every bulk command is an optimisation of a loop, and the contract is
// always the same: `f_bulk([a, b, c])` must leave the world in the state
// `f(a); f(b); f(c)` would have left it in. Nothing enforced that. Where a
// bulk path RE-IMPLEMENTS the single path's SQL instead of calling it, the
// two bodies drift silently — #3280 is exactly that (the batch reverse
// kernel never read `payload.prev_edit`, so undo-from-a-selection restored
// different text than undo-one-at-a-time, for a year).
//
// `src-tauri/src/bulk_equivalence/` is the oracle. This script is the
// INVENTORY guard that keeps the oracle honest: it enumerates every
// bulk-named function in the WORKSPACE and fails if one appears without a
// recorded disposition. It is a ratchet, not a linter — it does not judge
// code, it judges whether a decision was recorded.
//
// ─── Scan scope ──────────────────────────────────────────────────────
//
// Every `src-tauri/*/src` tree plus `src-tauri/src` itself — the app crate
// AND every sibling crate (agaric-core, agaric-engine, agaric-store,
// agaric-sync, agaric-observability, diagnostics, …). The crate list is
// DISCOVERED (any `src-tauri/<dir>/src` that exists), never hardcoded, so a
// new crate is in scope the day it is created rather than the day someone
// remembers this file.
//
// This was not always true: the first cut of this guard walked only
// `src-tauri/src/**`, while its header claimed to enumerate "every
// bulk-named function". Fourteen sat outside the walk, one of them a
// MUTATING batch fan-out (`replay_inbox_batch`) — the exact population the
// ratchet exists for.
//
// ─── What counts as a "bulk-named" function ──────────────────────────
//
// The name is split on `_` and matched on SEGMENTS, not on a raw suffix, so
// the `_inner` variants that carry the actual logic are caught alongside
// their IPC wrappers:
//
//   - a `batch` segment      → `create_blocks_batch`, `count_agenda_batch_inner`,
//                              `batch_resolve`, `get_batch_properties`
//   - a `bulk` segment       → `read_blocks_bulk`
//   - adjacent `by` + `ids`  → `delete_blocks_by_ids_inner`, `add_tags_by_ids`
//
// The heuristic is deliberately over-inclusive: it also catches functions
// that are not fan-outs at all (`bulk_err`, `ensure_batch_within_cap`,
// `send_bulk` — "bulk" as in "a bulk byte stream"). Those get the
// `not-a-fan-out` disposition rather than a narrowed regex, because a
// narrowed regex is how a real fan-out slips out of scope.
//
// Names alone cannot find every hand-copied kernel, so the baseline can also
// PIN a function that the heuristic misses: an entry carrying a `pin`
// justification is inventoried by exact `<path>::<fn>` key even though its
// name is not bulk-shaped, and deleting it then fails the guard as a stale
// entry. `fetch_prior_text_fallback_only` is the motivating case — one of
// `compute_reverse_batch`'s six hand-copied prior-state kernels, sibling to
// five `*_batch` names that the heuristic does catch.
//
// ─── The read-only discriminator ─────────────────────────────────────
//
// A read-only N-key fan-out (`count_agenda_batch`, `get_batch_properties`,
// `count_backlinks_batch`, …) appends no op_log rows and mutates nothing, so
// there is no state for it to fork on and no equivalence test to demand. The
// discriminator is PRINCIPLED rather than a hardcoded name list: a function
// is MUTATING iff its body (comments blanked, string literals KEPT — the SQL
// lives in them) mentions any write primitive:
//
//   append_local_op* | begin_immediate | INSERT INTO | UPDATE <ident>
//   | DELETE FROM | .execute(
//
// …OR it CALLS a function defined in the SAME FILE whose body does. That
// second clause is load-bearing rather than decorative: without it every
// forwarding function — all 14 `#[tauri::command]` wrappers, and
// `ingest_replicated_batch`, whose writes all land in the same file's
// `insert_replicated_op` — computes `read-only`, and the advertised "someone
// adds a write to a read-only fan-out and the guard fails" never fires for
// them.
//
// The expansion is exactly ONE level and does not cross files. Both limits
// are honest scope, not laziness: chasing calls across crates needs a call
// graph this script has no business building, and each extra hop widens the
// blast radius of a false `mutating`. So the claim this guard actually makes
// is: a write introduced in a bulk function OR in a helper it calls in the
// same file flips its kind. A write two hops away, or one file away, does
// not — and if THAT matters for some path, the answer is an equivalence
// test, which is what the whole inventory is pushing toward anyway.
//
// The classification is RECORDED in the baseline and re-checked on every
// run. That is where most of this guard's value is: if someone adds a write
// to a function currently recorded `read-only`, the computed kind flips, the
// recorded kind does not, and the guard fails — which is precisely the
// moment a new fork can be introduced unnoticed.
//
// ─── Dispositions ────────────────────────────────────────────────────
//
// Each baseline entry carries a `status`:
//
//   covered      — an equivalence test exists; `test` names it and the guard
//                  verifies a `fn <test>` still exists in the tree (so deleting
//                  the test fails the guard rather than silently un-covering).
//   converged    — the bulk path and the single path share ONE body (a common
//                  `*_in_tx` / `*_subtree_*` helper), so there is nothing to
//                  fork. Needs a `reason`. Beware: "shares a helper" is a claim
//                  about the WHOLE body. `purge_blocks_by_ids_inner` was
//                  recorded `converged` because all three purge variants run
//                  one `purge_subtree_tables` cascade — and the MEMBER SET fed
//                  to that cascade was a second, hand-written CTE. It is
//                  `covered` now, and its oracle found a live bug on the first
//                  run. A shared helper converges only the part of the body it
//                  spans.
//   read-only    — an N-key read fan-out. Needs a `reason`; the guard also
//                  requires the computed kind to agree.
//   wrapper      — a thin shim (usually a `#[tauri::command]`) that only
//                  forwards to an `*_inner` carrying the real disposition.
//                  Needs a `reason` naming that inner function. Its computed
//                  kind now follows the inner's when they share a file, so a
//                  mutating command reads `mutating` here rather than
//                  `read-only`.
//   not-a-fan-out— matches the name heuristic but takes no N-key input to fan
//                  out over (a partitioner, a cap check, an error constructor,
//                  a byte-stream transfer). Needs a `reason`.
//   exception    — a DOCUMENTED product-level divergence from the single
//                  sibling (the bulk path is deliberately not equivalent).
//                  Needs a `reason`.
//   gap          — a KNOWN, JUSTIFIED uncovered fork: a real batch-vs-fold
//                  risk with no oracle yet, recorded with why not. Needs a
//                  `reason`. Does not fail the guard (the ratchet's job is to
//                  make gaps enumerable, not to block the tree on them), but
//                  every run PRINTS the list, so it cannot go quiet.
//   uncovered    — written by `--update-baseline` for a newly-seen mutating
//                  function. ALWAYS fails the guard: it is the prompt to make
//                  a decision, not a disposition. `gap` is the decision
//                  "not yet, and here is why"; `uncovered` is no decision.
//
// ─── Failure modes (all exit 1) ──────────────────────────────────────
//
//   - a NEW bulk-named function with no baseline entry
//   - a STALE baseline entry (the function is gone) — so the baseline only
//     ratchets DOWN, exactly like `check-lib-layering.mjs`
//   - a recorded kind that no longer matches the computed kind
//   - a `covered` entry whose named test no longer exists
//   - an `uncovered` entry, or any placeholder `TODO` reason
//
// Usage: node scripts/check-bulk-equivalence.mjs
//        node scripts/check-bulk-equivalence.mjs --update-baseline
//        node scripts/check-bulk-equivalence.mjs --self-test
// Exit:  0 clean, 1 = drift, 2 = repo layout / self-test failure.
// ─────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TAURI_DIR = path.join(ROOT, 'src-tauri')
const APP_SRC_DIR = path.join(TAURI_DIR, 'src')
const BASELINE_FILE = path.join(ROOT, 'scripts', 'bulk-equivalence-baseline.json')

/**
 * Every Rust source root in the workspace: the app crate plus every sibling
 * crate under `src-tauri/`. DISCOVERED, never hardcoded — a crate added
 * tomorrow is in scope tomorrow. Returned sorted so output order is stable.
 *
 * @param {string} tauriDir
 * @returns {string[]}
 */
export function sourceRoots(tauriDir) {
  const roots = []
  if (fs.existsSync(path.join(tauriDir, 'src'))) roots.push(path.join(tauriDir, 'src'))
  if (!fs.existsSync(tauriDir)) return roots
  for (const entry of fs
    .readdirSync(tauriDir, { withFileTypes: true })
    .toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === 'src') continue
    const src = path.join(tauriDir, entry.name, 'src')
    if (fs.existsSync(src)) roots.push(src)
  }
  return roots
}

/**
 * Directories and file-name shapes that are ENTIRELY test code. Their module
 * declarations carry `#[cfg(test)]` in `lib.rs` rather than in the file
 * itself, so no amount of in-file scanning finds them.
 */
const TEST_PATH_SEGMENTS = new Set([
  'tests',
  'command_integration_tests',
  'bulk_equivalence',
  'reconciliation_oracle',
])
const TEST_FILE_RE =
  /(^tests?\.rs$)|(_tests?\.rs$)|(^integration_tests\.rs$)|(proptest)|(^conformance(_snapshot)?\.rs$)|(^proptest_db_harness\.rs$)/

const WRITE_PRIMITIVE_RE =
  /(append_local_op)|(begin_immediate)|(INSERT\s+(OR\s+\w+\s+)?INTO)|(UPDATE\s+[a-zA-Z_])|(DELETE\s+FROM)|(\.execute\()/i

const VALID_STATUSES = new Set([
  'covered',
  'converged',
  'read-only',
  'wrapper',
  'not-a-fan-out',
  'exception',
  'gap',
  'uncovered',
])

// ─── helpers ────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/**
 * Blank out Rust comments (line + block) and, optionally, string/char
 * literals, replacing each blanked character with a space so BYTE OFFSETS
 * are preserved and the two views can be indexed interchangeably.
 *
 * String literals are blanked for the STRUCTURAL view (brace matching, `fn`
 * discovery) and KEPT for the CONTENT view — every SQL statement in this
 * codebase lives inside a string literal, so blanking them would make the
 * write-primitive discriminator classify every command as read-only.
 *
 * @param {string} src
 * @param {{ blankStrings: boolean }} opts
 */
export function blank(src, { blankStrings }) {
  const out = src.split('')
  let i = 0
  const n = src.length
  const wipe = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      let j = i
      while (j < n && src[j] !== '\n') j += 1
      wipe(i, j)
      i = j
    } else if (c === '/' && d === '*') {
      // Rust block comments nest.
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') {
          depth += 1
          j += 2
        } else if (src[j] === '*' && src[j + 1] === '/') {
          depth -= 1
          j += 2
        } else j += 1
      }
      wipe(i, j)
      i = j
    } else if (c === 'r' && (d === '"' || d === '#')) {
      // Raw string: r"..." / r#"..."# / r##"..."##
      let hashes = 0
      let j = i + 1
      while (src[j] === '#') {
        hashes += 1
        j += 1
      }
      if (src[j] !== '"') {
        i += 1
        continue
      }
      const terminator = `"${'#'.repeat(hashes)}`
      const end = src.indexOf(terminator, j + 1)
      const stop = end === -1 ? n : end + terminator.length
      if (blankStrings) wipe(i, stop)
      i = stop
    } else if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (src[j] === '\\') j += 2
        else if (src[j] === '"') {
          j += 1
          break
        } else j += 1
      }
      if (blankStrings) wipe(i, j)
      i = j
    } else if (c === "'") {
      // Char literal or a lifetime (`'a`). Only the former can hide a quote.
      const m = /^'(\\.|[^\\'])'/.exec(src.slice(i))
      if (m) {
        if (blankStrings) wipe(i, i + m[0].length)
        i += m[0].length
      } else i += 1
    } else i += 1
  }
  return out.join('')
}

/** Byte ranges covered by `#[cfg(test)]`-annotated items, from `structural`. */
function cfgTestRanges(structural) {
  const ranges = []
  const re = /#\[cfg\(test\)\]/g
  let m
  while ((m = re.exec(structural)) !== null) {
    // Find the item's opening brace; if the item is a `mod foo;` declaration
    // (no brace before the `;`) there is no range to record.
    let i = m.index + m[0].length
    let brace = -1
    while (i < structural.length) {
      const c = structural[i]
      if (c === '{') {
        brace = i
        break
      }
      if (c === ';') break
      i += 1
    }
    if (brace === -1) continue
    let depth = 0
    let j = brace
    for (; j < structural.length; j += 1) {
      if (structural[j] === '{') depth += 1
      else if (structural[j] === '}') {
        depth -= 1
        if (depth === 0) {
          j += 1
          break
        }
      }
    }
    ranges.push([m.index, j])
  }
  return ranges
}

/** Does `name` read as a bulk fan-out? Segment-based, not suffix-based. */
export function isBulkName(name) {
  const segs = name.split('_')
  if (segs.includes('batch') || segs.includes('bulk')) return true
  for (let i = 0; i + 1 < segs.length; i += 1) {
    if (segs[i] === 'by' && segs[i + 1] === 'ids') return true
  }
  return false
}

function isTestPath(relPosix) {
  const parts = relPosix.split('/')
  const file = parts.at(-1)
  if (parts.slice(0, -1).some((p) => TEST_PATH_SEGMENTS.has(p))) return true
  return TEST_FILE_RE.test(file)
}

function listRustFiles(dir) {
  const out = []
  const visit = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && entry.name.endsWith('.rs')) out.push(full)
    }
  }
  if (fs.existsSync(dir)) visit(dir)
  return out
}

/**
 * Every `fn` in a file, in source order, with its body span already resolved.
 *
 * @returns {{ name: string, at: number, body: string, isTest: boolean, inCfgTest: boolean }[]}
 */
function fnsInFile(structural, content) {
  const skip = cfgTestRanges(structural)
  const inSkip = (i) => skip.some(([a, b]) => i >= a && i < b)

  const out = []
  const re = /\bfn\s+([a-z_][a-z0-9_]*)\s*[(<]/g
  let m
  while ((m = re.exec(structural)) !== null) {
    // Body span, by brace matching from the first `{` after the signature.
    const braceStart = structural.indexOf('{', re.lastIndex)
    let bodyEnd = braceStart
    if (braceStart !== -1) {
      let depth = 0
      for (let j = braceStart; j < structural.length; j += 1) {
        if (structural[j] === '{') depth += 1
        else if (structural[j] === '}') {
          depth -= 1
          if (depth === 0) {
            bodyEnd = j
            break
          }
        }
      }
    }
    // `#[test]` / `#[tokio::test]` / `#[rstest]` within the preceding 400
    // chars — attribute stacks on these are short, and a false skip is
    // strictly safer than a false demand for an equivalence test.
    const preamble = structural.slice(Math.max(0, m.index - 400), m.index)
    out.push({
      name: m[1],
      at: m.index,
      body: braceStart === -1 ? '' : content.slice(braceStart, bodyEnd),
      isTest: /#\[(tokio::)?(rs)?test\b|#\[test\]/.test(preamble),
      inCfgTest: inSkip(m.index),
    })
  }
  return out
}

/**
 * Extract this file's non-test inventoried functions with their computed kind.
 *
 * A function is inventoried when its NAME reads as a fan-out
 * ([`isBulkName`]) or when `isPinned(name)` says the baseline pinned it by
 * hand. Its kind is `mutating` when its own body mentions a write primitive
 * OR when it calls a same-file function whose body does — see the
 * "read-only discriminator" section of the header for why that one hop is
 * there and why it stops at one.
 *
 * @param {string} src
 * @param {(name: string) => boolean} [isPinned]
 * @returns {{ name: string, kind: 'mutating' | 'read-only' }[]}
 */
export function scanFile(src, isPinned = () => false) {
  const structural = blank(src, { blankStrings: true })
  const content = blank(src, { blankStrings: false })
  const all = fnsInFile(structural, content)

  // Same-file helpers that write. Test-only helpers are included on purpose:
  // a production fan-out has no business calling one, and if it does, the
  // resulting `mutating` is a finding rather than a false positive.
  const writers = new Set()
  for (const f of all) if (WRITE_PRIMITIVE_RE.test(f.body)) writers.add(f.name)

  const out = []
  for (const f of all) {
    if (f.isTest || f.inCfgTest) continue
    if (!isBulkName(f.name) && !isPinned(f.name)) continue
    const writesDirectly = writers.has(f.name) && WRITE_PRIMITIVE_RE.test(f.body)
    const callsAWriter = [...writers].some(
      (w) => w !== f.name && new RegExp(String.raw`\b${w}\s*\(`).test(f.body),
    )
    out.push({ name: f.name, kind: writesDirectly || callsAWriter ? 'mutating' : 'read-only' })
  }
  return out
}

/**
 * The live inventory: every non-test bulk-named (or baseline-PINNED) function
 * under any of `srcDirs`, keyed `<repo-relative posix path>::<fn name>`.
 *
 * `pinned` is the set of full `<path>::<fn>` keys the baseline pinned by hand;
 * a pin is per-FILE, so a same-named function elsewhere is not dragged in.
 *
 * @returns {Map<string, { kind: string }>}
 */
export function inventory({ root, srcDirs, pinned = new Set() }) {
  const found = new Map()
  for (const srcDir of srcDirs) {
    for (const file of listRustFiles(srcDir)) {
      const rel = toPosix(path.relative(root, file))
      if (isTestPath(toPosix(path.relative(srcDir, file)))) continue
      const src = fs.readFileSync(file, 'utf8')
      for (const { name, kind } of scanFile(src, (n) => pinned.has(`${rel}::${n}`))) {
        // A name can legitimately appear once per file; keep the first (and
        // upgrade to `mutating` if any overload writes).
        const key = `${rel}::${name}`
        const prev = found.get(key)
        if (!prev || (prev.kind === 'read-only' && kind === 'mutating')) found.set(key, { kind })
      }
    }
  }
  return found
}

/** Every `fn <name>` defined anywhere under `srcDirs` — used to verify tests exist. */
function definedFnNames(srcDirs) {
  const names = new Set()
  for (const srcDir of srcDirs) {
    for (const file of listRustFiles(srcDir)) {
      const structural = blank(fs.readFileSync(file, 'utf8'), { blankStrings: true })
      const re = /\bfn\s+([a-z_][a-z0-9_]*)\s*[(<]/g
      let m
      while ((m = re.exec(structural)) !== null) names.add(m[1])
    }
  }
  return names
}

/** The `<path>::<fn>` keys a baseline pins by hand (entries carrying `pin`). */
function pinnedKeys(baseline) {
  return new Set(baseline.filter((e) => e.pin).map((e) => e.fn))
}

/**
 * Diff the live inventory against `baseline`. Pure over the filesystem apart
 * from `srcDirs`, so the self-test can drive it against a synthetic tree.
 */
export function analyze({ root, srcDirs, baseline }) {
  const live = inventory({ root, srcDirs, pinned: pinnedKeys(baseline) })
  const recorded = new Map(baseline.map((e) => [e.fn, e]))
  const testNames = definedFnNames(srcDirs)

  const missing = [] // in the tree, not in the baseline
  const stale = [] // in the baseline, gone from the tree
  const kindDrift = []
  const missingTests = []
  const undecided = []
  const gaps = [] // recorded, justified, still uncovered — reported, not fatal

  for (const [key, { kind }] of live) {
    const entry = recorded.get(key)
    if (!entry) {
      missing.push({ fn: key, kind })
      continue
    }
    if (entry.kind !== kind) kindDrift.push({ fn: key, recorded: entry.kind, computed: kind })
    if (entry.status === 'uncovered') undecided.push({ fn: key, why: 'status is `uncovered`' })
    else if (!VALID_STATUSES.has(entry.status)) {
      undecided.push({ fn: key, why: `unknown status \`${entry.status}\`` })
    } else if (entry.status === 'covered') {
      if (!entry.test) undecided.push({ fn: key, why: '`covered` with no `test` name' })
      else if (!testNames.has(entry.test)) missingTests.push({ fn: key, test: entry.test })
    } else if (!entry.reason || entry.reason === 'TODO') {
      undecided.push({ fn: key, why: `\`${entry.status}\` with no justification` })
    } else if (entry.status === 'gap') {
      gaps.push({ fn: key, reason: entry.reason })
    }
    // NOTE: a `read-only` STATUS whose computed kind is `mutating` needs no
    // separate report — the `kindDrift` check above already fires on exactly
    // that pair, and duplicating it would print the same function twice.
  }

  for (const key of recorded.keys()) if (!live.has(key)) stale.push(key)

  return {
    live,
    missing: missing.toSorted((a, b) => a.fn.localeCompare(b.fn)),
    stale: stale.toSorted(),
    kindDrift: kindDrift.toSorted((a, b) => a.fn.localeCompare(b.fn)),
    missingTests: missingTests.toSorted((a, b) => a.fn.localeCompare(b.fn)),
    undecided: undecided.toSorted((a, b) => a.fn.localeCompare(b.fn)),
    gaps: gaps.toSorted((a, b) => a.fn.localeCompare(b.fn)),
  }
}

// ─── baseline IO ────────────────────────────────────────────────────

function readBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return null
  const raw = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  if (!Array.isArray(raw)) throw new Error(`baseline file is not a JSON array: ${BASELINE_FILE}`)
  return raw
}

function updateBaseline() {
  if (!fs.existsSync(APP_SRC_DIR)) {
    console.error(`ERROR: expected directory not found (repo layout changed?): ${APP_SRC_DIR}`)
    process.exit(2)
  }
  const prevEntries = readBaseline() ?? []
  const previous = new Map(prevEntries.map((e) => [e.fn, e]))
  const live = inventory({
    root: ROOT,
    srcDirs: sourceRoots(TAURI_DIR),
    pinned: pinnedKeys(prevEntries),
  })
  const entries = []
  for (const [fn, { kind }] of [...live.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
    const prev = previous.get(fn)
    // Annotations are PRESERVED across regenerations; only the computed
    // `kind` is refreshed (in place, so the recorded key ORDER is stable and
    // a regeneration produces no incidental diff). A newly-seen function gets
    // a disposition that deliberately fails the guard until a human writes one.
    if (prev) {
      prev.kind = kind
      entries.push(prev)
    } else if (kind === 'mutating') {
      entries.push({ fn, kind, status: 'uncovered', reason: 'TODO' })
    } else {
      entries.push({ fn, kind, status: 'read-only', reason: 'TODO' })
    }
  }
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(entries, null, 2)}\n`)
  console.log(
    `OK: wrote baseline with ${entries.length} bulk-named function(s) to ${path.relative(ROOT, BASELINE_FILE)}`,
  )
}

function runGuard() {
  if (!fs.existsSync(APP_SRC_DIR)) {
    console.error(`ERROR: expected directory not found (repo layout changed?): ${APP_SRC_DIR}`)
    process.exit(2)
  }
  const baseline = readBaseline()
  if (baseline === null) {
    console.error(`ERROR: baseline file not found: ${BASELINE_FILE}`)
    console.error('Seed it with: node scripts/check-bulk-equivalence.mjs --update-baseline')
    process.exit(2)
  }

  const r = analyze({ root: ROOT, srcDirs: sourceRoots(TAURI_DIR), baseline })
  let failed = false

  if (r.missing.length > 0) {
    failed = true
    console.error('ERROR: new bulk-named function(s) with no recorded disposition (#3346):')
    for (const { fn, kind } of r.missing) console.error(`  ${fn}  (computed kind: ${kind})`)
    console.error('')
    console.error('A bulk function is an optimisation of a loop; say how you know it still')
    console.error('agrees with that loop. Add an equivalence test in')
    console.error('src-tauri/src/bulk_equivalence/ and record it, or record why none is owed')
    console.error('(converged / read-only / not-a-fan-out / exception / gap). Then run:')
    console.error('  node scripts/check-bulk-equivalence.mjs --update-baseline')
  }

  if (r.stale.length > 0) {
    failed = true
    console.error('ERROR: stale baseline entr(ies) — these functions no longer exist and must')
    console.error('be pruned so the inventory ratchets down:')
    for (const fn of r.stale) console.error(`  ${fn}`)
    console.error('')
    console.error('Prune them with: node scripts/check-bulk-equivalence.mjs --update-baseline')
  }

  if (r.kindDrift.length > 0) {
    failed = true
    console.error('ERROR: recorded kind no longer matches the computed kind:')
    for (const { fn, recorded, computed } of r.kindDrift) {
      console.error(`  ${fn}  recorded=${recorded} computed=${computed}`)
    }
    console.error('')
    console.error('A function that gained a write primitive can now FORK from its single-item')
    console.error('sibling. Re-decide its disposition (an equivalence test is the default')
    console.error('answer), then re-run with --update-baseline.')
  }

  if (r.missingTests.length > 0) {
    failed = true
    console.error('ERROR: `covered` entr(ies) whose equivalence test no longer exists:')
    for (const { fn, test } of r.missingTests) console.error(`  ${fn}  (expected fn ${test})`)
  }

  if (r.undecided.length > 0) {
    failed = true
    console.error('ERROR: baseline entr(ies) with no real disposition:')
    for (const { fn, why } of r.undecided) console.error(`  ${fn}  — ${why}`)
  }

  if (failed) process.exit(1)

  // Known gaps are NOT a failure — they are a decision already made and
  // justified — but they are printed on every clean run so "we'll cover it
  // later" cannot decay into silence the way a `converged` misclassification
  // does.
  if (r.gaps.length > 0) {
    console.log(`NOTE: ${r.gaps.length} recorded, still-uncovered fork(s) (#3346):`)
    for (const { fn, reason } of r.gaps) console.log(`  ${fn}\n    ${reason}`)
  }

  const byStatus = new Map()
  for (const e of baseline) byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1)
  const summary = [...byStatus.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([s, n]) => `${n} ${s}`)
    .join(', ')
  console.log(
    `OK: ${r.live.size} bulk-named function(s) inventoried (${summary}), no new entries, no stale entries`,
  )
}

// ─── self-test ──────────────────────────────────────────────────────

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  // --- pure-function assertions ---------------------------------------
  for (const [name, want] of [
    ['delete_blocks_by_ids_inner', true],
    ['create_blocks_batch', true],
    ['batch_resolve_inner', true],
    ['read_blocks_bulk', true],
    ['count_agenda_batch_by_source_inner', true],
    ['delete_block_inner', false],
    ['identify_by_id', false],
    ['debatch', false],
  ]) {
    if (isBulkName(name) === want) ok(`isBulkName(${name}) === ${want}`)
    else fail(`isBulkName(${name})`, `got ${isBulkName(name)}`)
  }

  // SQL lives in string literals: the CONTENT view must keep them, or every
  // command classifies as read-only and the guard is defanged.
  const sqlSrc = 'fn f_batch() { sqlx::query("UPDATE blocks SET x = 1"); }'
  if (blank(sqlSrc, { blankStrings: false }).includes('UPDATE blocks')) {
    ok('content view preserves SQL inside string literals')
  } else fail('content view preserves SQL', blank(sqlSrc, { blankStrings: false }))
  if (!blank(sqlSrc, { blankStrings: true }).includes('UPDATE blocks')) {
    ok('structural view blanks string literals')
  } else fail('structural view blanks strings', 'string survived')

  // A comment must NOT be able to make a read-only fan-out look mutating.
  const commentSrc = 'fn g_batch() { // INSERT INTO blocks\n let x = 1; }'
  if (scanFile(commentSrc)[0]?.kind === 'read-only') ok('comments do not classify as mutating')
  else fail('comments do not classify as mutating', JSON.stringify(scanFile(commentSrc)))

  // The one-hop discriminator: a forwarding fan-out whose write lands in a
  // same-file helper must still compute `mutating`. Without this every
  // wrapper (and `ingest_replicated_batch`) reads as read-only and the
  // "a new write flips the kind" promise is vacuous for them.
  const hopSrc = [
    'pub async fn forwards_batch(ids: Vec<String>) { do_the_write(ids).await }',
    'async fn do_the_write(ids: Vec<String>) {',
    '    sqlx::query("INSERT INTO blocks VALUES (1)").execute(&p).await;',
    '}',
  ].join('\n')
  if (scanFile(hopSrc).find((f) => f.name === 'forwards_batch')?.kind === 'mutating') {
    ok('a write in a same-file callee makes the caller `mutating`')
  } else fail('same-file callee expansion', JSON.stringify(scanFile(hopSrc)))

  // …and the hop must not be a blanket "any same-file writer taints
  // everything": a fan-out that calls NOTHING mutating stays read-only even
  // when the file next door in the same file writes.
  const noHopSrc = [
    'pub async fn reads_batch(ids: Vec<String>) { count_them(ids).await }',
    'async fn count_them(ids: Vec<String>) -> i64 {',
    '    sqlx::query_scalar("SELECT COUNT(*) FROM blocks").fetch_one(&p).await',
    '}',
    'async fn unrelated_writer() { sqlx::query("DELETE FROM blocks").execute(&p).await; }',
  ].join('\n')
  if (scanFile(noHopSrc).find((f) => f.name === 'reads_batch')?.kind === 'read-only') {
    ok('an unrelated same-file writer does not taint a read fan-out')
  } else fail('same-file expansion is call-scoped', JSON.stringify(scanFile(noHopSrc)))

  runTreeSelfTest(ok, fail)
  runCliSelfTest(ok, fail)

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

/**
 * Assertions that need a synthetic repo on disk: the multi-crate walk, the
 * baseline diff, and every failure mode the guard is supposed to have.
 */
function runTreeSelfTest(ok, fail) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-equivalence-selftest-'))
  try {
    const tauri = path.join(tmp, 'src-tauri')
    const srcDir = path.join(tauri, 'src')
    const siblingSrc = path.join(tauri, 'agaric-sibling', 'src')
    fs.mkdirSync(path.join(srcDir, 'commands'), { recursive: true })
    fs.mkdirSync(path.join(srcDir, 'tests'), { recursive: true })
    fs.mkdirSync(siblingSrc, { recursive: true })

    fs.writeFileSync(
      path.join(srcDir, 'commands', 'ops.rs'),
      [
        'pub async fn wipe_blocks_by_ids_inner(ids: Vec<String>) {',
        '    sqlx::query("UPDATE blocks SET deleted_at = 1").execute(&pool).await;',
        '}',
        'pub async fn count_things_batch(ids: Vec<String>) -> i64 {',
        '    sqlx::query_scalar("SELECT COUNT(*) FROM blocks").fetch_one(&pool).await',
        '}',
        'pub async fn covered_batch(ids: Vec<String>) {',
        '    sqlx::query("DELETE FROM blocks").execute(&pool).await;',
        '}',
        // Forwards its write to a same-file helper: `mutating` only because of
        // the one-hop expansion.
        'pub async fn wrapper_batch(ids: Vec<String>) { forward_write(ids).await }',
        'async fn forward_write(ids: Vec<String>) {',
        '    sqlx::query("INSERT INTO blocks VALUES (1)").execute(&pool).await;',
        '}',
        // NOT bulk-named: reachable only because the baseline pins it.
        'pub async fn hand_copied_kernel(id: &str) -> String {',
        '    sqlx::query_scalar("SELECT content FROM blocks").fetch_one(&pool).await',
        '}',
        'pub fn plain_helper(x: i64) -> i64 { x }',
        '#[cfg(test)]',
        'mod tests {',
        '    #[tokio::test]',
        '    async fn some_batch_test_fn() { let _ = 1; }',
        '}',
      ].join('\n'),
    )
    // A SIBLING CRATE. Invisible to the original app-crate-only walk; the
    // whole point of `sourceRoots()`.
    fs.writeFileSync(
      path.join(siblingSrc, 'net.rs'),
      'pub fn ship_batch(ids: Vec<String>) -> usize { ids.len() }\n',
    )
    // A whole-file test module: excluded by PATH, since its `#[cfg(test)]`
    // lives in lib.rs and cannot be seen from inside the file.
    fs.writeFileSync(
      path.join(srcDir, 'tests', 'helpers.rs'),
      'pub async fn seed_blocks_batch() { sqlx::query("INSERT INTO blocks VALUES (1)"); }',
    )
    // The equivalence test itself is BULK-NAMED (it names the function it
    // covers) and lives in a test path, so it must be excluded from the
    // inventory while staying FINDABLE by name for `covered` verification.
    fs.writeFileSync(
      path.join(srcDir, 'tests', 'oracle.rs'),
      'fn covered_batch_matches_fold() { let _ = 1; }',
    )

    const srcDirs = sourceRoots(tauri)
    if (srcDirs.length === 2 && srcDirs[1] === siblingSrc) ok('sourceRoots finds sibling crates')
    else fail('sourceRoots finds sibling crates', JSON.stringify(srcDirs))

    const base = [
      {
        fn: 'src-tauri/src/commands/ops.rs::wipe_blocks_by_ids_inner',
        kind: 'mutating',
        status: 'converged',
        reason: 'shares one helper',
      },
      {
        fn: 'src-tauri/src/commands/ops.rs::count_things_batch',
        kind: 'read-only',
        status: 'read-only',
        reason: 'N-key COUNT fan-out',
      },
      {
        fn: 'src-tauri/src/commands/ops.rs::covered_batch',
        kind: 'mutating',
        status: 'covered',
        test: 'covered_batch_matches_fold',
      },
      {
        fn: 'src-tauri/src/commands/ops.rs::wrapper_batch',
        kind: 'mutating',
        status: 'wrapper',
        reason: 'forwards to forward_write',
      },
      {
        fn: 'src-tauri/src/commands/ops.rs::hand_copied_kernel',
        kind: 'read-only',
        status: 'covered',
        test: 'covered_batch_matches_fold',
        pin: 'not bulk-named; pinned so deleting it fails the guard',
      },
      {
        fn: 'src-tauri/agaric-sibling/src/net.rs::ship_batch',
        kind: 'read-only',
        status: 'not-a-fan-out',
        reason: 'a partitioner, not an N-key fan-out',
      },
    ]
    const clean = analyze({ root: tmp, srcDirs, baseline: base })

    if (clean.missing.length === 0 && clean.stale.length === 0 && clean.undecided.length === 0) {
      ok('a fully-recorded inventory is clean')
    } else {
      fail(
        'fully-recorded inventory is clean',
        JSON.stringify({ ...clean, live: [...clean.live.keys()] }, null, 1),
      )
    }

    if (!clean.live.has('src-tauri/src/commands/ops.rs::plain_helper')) {
      ok('non-bulk fn is ignored')
    } else fail('non-bulk fn ignored', 'plain_helper was inventoried')

    if (![...clean.live.keys()].some((k) => k.includes('covered_batch_matches_fold'))) {
      ok('the bulk-named equivalence TEST itself is not inventoried')
    } else fail('equivalence test not inventoried', [...clean.live.keys()].join(','))

    if (![...clean.live.keys()].some((k) => k.includes('some_batch_test_fn'))) {
      ok('#[cfg(test)] mod contents are ignored')
    } else fail('cfg(test) ignored', [...clean.live.keys()].join(','))

    if (![...clean.live.keys()].some((k) => k.includes('seed_blocks_batch'))) {
      ok('whole-file test module is ignored by path')
    } else fail('test path ignored', [...clean.live.keys()].join(','))

    // NEW bulk fn -> flagged.
    const newFn = analyze({ root: tmp, srcDirs, baseline: base.slice(0, 2) })
    if (newFn.missing.some((m) => m.fn.endsWith('::covered_batch'))) ok('new bulk fn is flagged')
    else fail('new bulk fn flagged', JSON.stringify(newFn.missing))

    // STALE entry -> flagged.
    const withStale = analyze({
      root: tmp,
      srcDirs,
      baseline: [
        ...base,
        {
          fn: 'src-tauri/src/commands/ops.rs::gone_batch',
          kind: 'read-only',
          status: 'read-only',
          reason: 'x',
        },
      ],
    })
    if (withStale.stale.includes('src-tauri/src/commands/ops.rs::gone_batch')) {
      ok('stale baseline entry is flagged')
    } else fail('stale entry flagged', JSON.stringify(withStale.stale))

    // Return a COPY of `base` with `patch` applied to the entry whose key ends
    // in `suffix`, leaving every other entry untouched.
    const patched = (suffix, patch) =>
      base.map((e) => (e.fn.endsWith(suffix) ? Object.assign({}, e, patch) : e))

    // KIND DRIFT -> flagged (a read-only fan-out that grew a write).
    const drifted = analyze({
      root: tmp,
      srcDirs,
      baseline: patched('::wipe_blocks_by_ids_inner', { kind: 'read-only' }),
    })
    if (drifted.kindDrift.some((d) => d.fn.endsWith('::wipe_blocks_by_ids_inner'))) {
      ok('kind drift (read-only -> mutating) is flagged')
    } else fail('kind drift flagged', JSON.stringify(drifted.kindDrift))

    // DELETED equivalence test -> flagged.
    const noTest = analyze({
      root: tmp,
      srcDirs,
      baseline: patched('::covered_batch', { test: 'vanished_test' }),
    })
    if (noTest.missingTests.some((t) => t.test === 'vanished_test')) {
      ok('a `covered` entry whose test vanished is flagged')
    } else fail('missing test flagged', JSON.stringify(noTest.missingTests))

    // `uncovered` / placeholder reasons -> flagged.
    const undecided = analyze({
      root: tmp,
      srcDirs,
      baseline: base.map((e) =>
        e.fn.endsWith('::covered_batch')
          ? { fn: e.fn, kind: e.kind, status: 'uncovered', reason: 'TODO' }
          : e,
      ),
    })
    if (undecided.undecided.some((u) => u.fn.endsWith('::covered_batch'))) {
      ok('`uncovered` status is flagged')
    } else fail('uncovered flagged', JSON.stringify(undecided.undecided))

    const placeholder = analyze({
      root: tmp,
      srcDirs,
      baseline: patched('::count_things_batch', { reason: 'TODO' }),
    })
    if (placeholder.undecided.some((u) => u.fn.endsWith('::count_things_batch'))) {
      ok('placeholder `TODO` justification is flagged')
    } else fail('TODO reason flagged', JSON.stringify(placeholder.undecided))

    // A SIBLING CRATE's bulk fn is inventoried — the Hole-2 regression.
    if (clean.live.has('src-tauri/agaric-sibling/src/net.rs::ship_batch')) {
      ok('a sibling crate’s bulk fn is inventoried')
    } else fail('sibling crate inventoried', [...clean.live.keys()].join(','))

    // The one-hop discriminator, end to end: `wrapper_batch` only writes via
    // `forward_write`, and the baseline records it `mutating`. If the hop
    // regressed, this shows up as kind drift on a clean tree.
    if (clean.live.get('src-tauri/src/commands/ops.rs::wrapper_batch')?.kind === 'mutating') {
      ok('a forwarding wrapper computes `mutating` through its same-file callee')
    } else fail('wrapper is mutating', JSON.stringify([...clean.live]))

    // PINNED entry: present only because the baseline pinned it…
    if (clean.live.has('src-tauri/src/commands/ops.rs::hand_copied_kernel')) {
      ok('a pinned, non-bulk-named fn is inventoried')
    } else fail('pin inventoried', [...clean.live.keys()].join(','))
    // …and NOT present when the pin is dropped, which is what makes the pin a
    // real mechanism rather than an inert extra field.
    const unpinned = analyze({
      root: tmp,
      srcDirs,
      baseline: base
        .filter((e) => !e.pin)
        .concat({
          fn: 'src-tauri/src/commands/ops.rs::hand_copied_kernel',
          kind: 'read-only',
          status: 'read-only',
          reason: 'x',
        }),
    })
    if (unpinned.stale.includes('src-tauri/src/commands/ops.rs::hand_copied_kernel')) {
      ok('without its `pin` the same entry is not inventoried')
    } else fail('pin is load-bearing', JSON.stringify(unpinned.stale))

    // …and a pinned fn that is DELETED from the tree goes stale, which is the
    // whole reason to pin it.
    const before = fs.readFileSync(path.join(srcDir, 'commands', 'ops.rs'), 'utf8')
    fs.writeFileSync(
      path.join(srcDir, 'commands', 'ops.rs'),
      before.replace(
        'pub async fn hand_copied_kernel(id: &str) -> String {',
        'pub async fn gone(id: &str) -> String {',
      ),
    )
    const pinDeleted = analyze({ root: tmp, srcDirs, baseline: base })
    fs.writeFileSync(path.join(srcDir, 'commands', 'ops.rs'), before)
    if (pinDeleted.stale.includes('src-tauri/src/commands/ops.rs::hand_copied_kernel')) {
      ok('deleting a pinned fn is flagged as stale')
    } else fail('pinned deletion flagged', JSON.stringify(pinDeleted.stale))

    // `gap` is a RECORDED disposition: reported, never fatal.
    const gapped = analyze({
      root: tmp,
      srcDirs,
      baseline: patched('::wipe_blocks_by_ids_inner', {
        status: 'gap',
        reason: 'a real fork, no oracle yet, tracked in #NNNN',
      }),
    })
    if (
      gapped.undecided.length === 0 &&
      gapped.gaps.some((g) => g.fn.endsWith('::wipe_blocks_by_ids_inner'))
    ) {
      ok('`gap` is reported but does not fail')
    } else fail('gap reported not fatal', JSON.stringify({ u: gapped.undecided, g: gapped.gaps }))

    // …but a `gap` with no justification is still no decision at all.
    const lazyGap = analyze({
      root: tmp,
      srcDirs,
      baseline: patched('::wipe_blocks_by_ids_inner', { status: 'gap', reason: 'TODO' }),
    })
    if (lazyGap.undecided.some((u) => u.fn.endsWith('::wipe_blocks_by_ids_inner'))) {
      ok('an unjustified `gap` is flagged')
    } else fail('unjustified gap flagged', JSON.stringify(lazyGap.undecided))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * End-to-end CLI self-test: spawns THIS script as a real subprocess against a
 * synthetic fixture repo and asserts on the actual process exit code. The
 * assertions above drive `analyze()` directly and never reach `runGuard()`'s
 * `process.exit(1)` — a regression that dropped that call would defang the
 * gate entirely and still pass every assertion, since `prek.toml` only runs
 * `--self-test` when this script changes. Same hole `check-lib-layering.mjs`
 * closes, closed the same way.
 */
function runCliSelfTest(ok, fail) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-equivalence-cli-'))
  try {
    const fixtureScripts = path.join(fixtureRoot, 'scripts')
    const fixtureSrc = path.join(fixtureRoot, 'src-tauri', 'src')
    fs.mkdirSync(fixtureScripts, { recursive: true })
    fs.mkdirSync(fixtureSrc, { recursive: true })
    fs.copyFileSync(import.meta.filename, path.join(fixtureScripts, 'check-bulk-equivalence.mjs'))
    fs.writeFileSync(path.join(fixtureSrc, 'clean.rs'), 'pub fn plain(x: i64) -> i64 { x }\n')

    const run = () =>
      spawnSync(process.execPath, [path.join(fixtureScripts, 'check-bulk-equivalence.mjs')], {
        cwd: fixtureRoot,
        encoding: 'utf8',
      })

    let res = run()
    if (res.status === 2) ok('CLI exits 2 when the baseline file is missing')
    else fail('CLI exits 2 when baseline missing', `status=${res.status}`)

    fs.writeFileSync(path.join(fixtureScripts, 'bulk-equivalence-baseline.json'), '[]\n')
    res = run()
    if (res.status === 0) ok('CLI exits 0 on a clean tree')
    else fail('CLI exits 0 on a clean tree', `status=${res.status} stderr=${res.stderr}`)

    fs.writeFileSync(
      path.join(fixtureSrc, 'offender.rs'),
      'pub async fn nuke_blocks_by_ids() { sqlx::query("DELETE FROM blocks").execute(&p).await; }\n',
    )
    res = run()
    if (res.status === 1) ok('CLI exits 1 on a new bulk fn (the gate actually blocks)')
    else fail('CLI exits 1 on a new bulk fn', `status=${res.status} stdout=${res.stdout}`)

    // The Hole-2 regression, at the CLI: an offender in a SIBLING CRATE must
    // block just as hard. Assert on the printed key so a walk that quietly
    // stopped at `src-tauri/src` cannot pass by failing for the other reason.
    fs.rmSync(path.join(fixtureSrc, 'offender.rs'))
    const siblingSrc = path.join(fixtureRoot, 'src-tauri', 'agaric-elsewhere', 'src')
    fs.mkdirSync(siblingSrc, { recursive: true })
    fs.writeFileSync(
      path.join(siblingSrc, 'offender.rs'),
      'pub async fn nuke_blocks_by_ids() { sqlx::query("DELETE FROM blocks").execute(&p).await; }\n',
    )
    res = run()
    if (res.status === 1 && res.stderr.includes('src-tauri/agaric-elsewhere/src/offender.rs')) {
      ok('CLI exits 1 on a new bulk fn in a SIBLING CRATE')
    } else
      fail('CLI blocks on a sibling-crate bulk fn', `status=${res.status} stderr=${res.stderr}`)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

// ─── main ───────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else if (process.argv.includes('--update-baseline')) {
  updateBaseline()
} else {
  runGuard()
}
