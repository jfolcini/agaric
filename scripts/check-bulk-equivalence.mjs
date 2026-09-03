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
//                  verifies that test still RUNS: a `fn <test>` exists, carries
//                  a test attribute (`#[test]` / `#[tokio::test]` / …), and is
//                  not `#[ignore]`d. Name-existence alone was not enough.
//                  `#[ignore]` matters acutely in THIS module specifically:
//                  when the oracle finds a bug it cannot fix in the same PR,
//                  the reproducer lands here `#[ignore]`d and deliberately
//                  failing (that is how #3818 and #3819 were first committed,
//                  before the fixes un-ignored them). So "an `#[ignore]`d test
//                  in bulk_equivalence/" is a shape that looks normal here —
//                  which is exactly why a real covering test silenced with
//                  `#[ignore]` must not be allowed to hide among them, and why
//                  a `fn` renamed on top of a deleted test must not keep the
//                  claim alive with nothing behind it.
//                  An optional `reason` records anything the word "covered"
//                  would otherwise overstate — e.g. a KNOWN divergence that the
//                  named test does not exercise.
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
//   - a `covered` entry whose named test no longer runs (gone, not a test, or
//     `#[ignore]`d)
//   - an `uncovered` entry, or any placeholder `TODO` reason
//
// Usage: node scripts/check-bulk-equivalence.mjs
//        node scripts/check-bulk-equivalence.mjs --update-baseline
// Exit:  0 clean, 1 = drift, 2 = repo layout failure.
// ─────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TAURI_DIR = path.join(ROOT, 'src-tauri')
const APP_SRC_DIR = path.join(TAURI_DIR, 'src')
const BASELINE_FILE = path.join(ROOT, 'scripts', 'bulk-equivalence-baseline.json')

/**
 * Every Rust source root in the workspace: the app crate, its integration
 * tests, and every sibling crate under `src-tauri/`. DISCOVERED, never hardcoded — a crate added
 * tomorrow is in scope tomorrow. App roots first, then the sibling crates in name order, so
 * output order is stable.
 *
 * @param {string} tauriDir
 * @returns {string[]}
 */
export function sourceRoots(tauriDir) {
  const roots = []
  if (fs.existsSync(path.join(tauriDir, 'src'))) roots.push(path.join(tauriDir, 'src'))
  // #4499: the app crate's suites are integration binaries under
  // `src-tauri/tests/`, and a `covered` entry's equivalence test lives there.
  if (fs.existsSync(path.join(tauriDir, 'tests'))) roots.push(path.join(tauriDir, 'tests'))
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
const TEST_PATH_SEGMENTS = new Set(['tests', 'bulk_equivalence', 'reconciliation_oracle'])
const TEST_FILE_RE =
  /(^tests?\.rs$)|(_tests?\.rs$)|(^integration_tests\.rs$)|(proptest)|(^conformance(_snapshot)?\.rs$)|(^proptest_db_harness\.rs$)/

const WRITE_PRIMITIVE_RE =
  /(append_local_op)|(begin_immediate)|(INSERT\s+(OR\s+\w+\s+)?INTO)|(UPDATE\s+[a-zA-Z_])|(DELETE\s+FROM)|(\.execute\()/i

/** An attribute that makes an item a test harness entry point. */
const TEST_ATTR_RE = /^#\[\s*(?:[a-z_][a-z0-9_]*\s*::\s*)*(?:test|rstest)\s*[([\]]/
/** `#[ignore]` and `#[ignore = "why"]` (the string is blanked in `structural`). */
const IGNORE_ATTR_RE = /^#\[\s*ignore\s*[=\]]/
const CFG_ATTR_RE = /^#\[\s*cfg_attr\b/

/** Qualifiers that may sit between an attribute stack and the `fn` keyword. */
const FN_QUALIFIERS = new Set(['pub', 'async', 'unsafe', 'const', 'extern', 'default'])

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

/**
 * Index of the `open` delimiter matching the `close` delimiter at `closeAt`,
 * scanning BACKWARDS. `-1` when the text is unbalanced.
 */
function matchBackwards(s, closeAt, open, close) {
  let depth = 0
  for (let j = closeAt; j >= 0; j -= 1) {
    if (s[j] === close) depth += 1
    else if (s[j] === open) {
      depth -= 1
      if (depth === 0) return j
    }
  }
  return -1
}

/**
 * The OUTER attributes attached to the `fn` whose keyword starts at `at`, in
 * source order, read from the STRUCTURAL view.
 *
 * Read backwards rather than by slicing a fixed window before the signature,
 * because a fixed window cannot tell "this item's attributes" from "the
 * previous item's attributes" — and both of the things this parser must decide
 * (is it a test? is it `#[ignore]`d?) are wrong in the dangerous direction if
 * they read a neighbour's stack.
 *
 * Two properties of `blank()` make the walk short: doc comments are already
 * spaces, so stepping over whitespace steps over them for free, and every
 * string literal is blanked, so no bracket inside one can unbalance the match.
 *
 * `#![…]` is an INNER attribute of the ENCLOSING item (the `#![proptest_config]`
 * at the top of a `proptest!` block), not of this fn, so the stack ends there.
 *
 * @param {string} structural
 * @param {number} at index of the `f` in `fn`
 * @returns {string[]}
 */
export function attrsBefore(structural, at) {
  let i = at
  // Step back over the signature's qualifiers: `pub(crate) async unsafe fn`.
  for (;;) {
    while (i > 0 && /\s/.test(structural[i - 1])) i -= 1
    if (i > 0 && structural[i - 1] === ')') {
      const open = matchBackwards(structural, i - 1, '(', ')')
      if (open === -1) break
      i = open
      continue
    }
    const end = i
    while (i > 0 && /[A-Za-z0-9_]/.test(structural[i - 1])) i -= 1
    const word = structural.slice(i, end)
    if (word.length > 0 && FN_QUALIFIERS.has(word)) continue
    i = end
    break
  }
  const attrs = []
  for (;;) {
    while (i > 0 && /\s/.test(structural[i - 1])) i -= 1
    if (i === 0 || structural[i - 1] !== ']') break
    const open = matchBackwards(structural, i - 1, '[', ']')
    if (open <= 0 || structural[open - 1] !== '#') break
    attrs.push(structural.slice(open - 1, i))
    i = open - 1
  }
  return attrs.toReversed()
}

/**
 * Whether an attribute stack describes a test that RUNS.
 *
 * `'live'` is the only answer callers may act on positively; it is emitted
 * only when a test attribute is present unconditionally and no `#[ignore]`
 * is. Everything this parser cannot resolve — notably a `cfg_attr` that could
 * ATTACH an `ignore`, or a test attribute that only exists under some `cfg` —
 * lands on `'ignored'` / `'not-a-test'` on purpose: the guard's job here is to
 * complain when it cannot SEE the test running, not to assume it does.
 *
 * @param {string[]} attrs
 * @returns {'live' | 'ignored' | 'not-a-test'}
 */
export function testKindOf(attrs) {
  if (!attrs.some((a) => TEST_ATTR_RE.test(a))) return 'not-a-test'
  const conditionalIgnore = attrs.some((a) => CFG_ATTR_RE.test(a) && /\bignore\b/.test(a))
  if (conditionalIgnore || attrs.some((a) => IGNORE_ATTR_RE.test(a))) return 'ignored'
  return 'live'
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
 * @returns {{ name: string, at: number, body: string, testKind: string, isTest: boolean, inCfgTest: boolean }[]}
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
    const testKind = testKindOf(attrsBefore(structural, m.index))
    out.push({
      name: m[1],
      at: m.index,
      body: braceStart === -1 ? '' : content.slice(braceStart, bodyEnd),
      testKind,
      // For the INVENTORY, `isTest` only decides whether to demand a
      // disposition, and a false skip is strictly safer than a false demand —
      // so an `#[ignore]`d test still counts as a test here. The `covered`
      // check reads `testKind` instead, where the safe direction is reversed.
      isTest: testKind !== 'not-a-test',
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

/** `live` beats `ignored` beats `not-a-test` when a name is defined more than once. */
const TEST_KIND_RANK = { live: 3, ignored: 2, 'not-a-test': 1 }

/**
 * Every `fn <name>` defined anywhere under `srcDirs`, mapped to whether it is a
 * test that RUNS — used to verify that a `covered` entry's test still covers
 * something. A name defined more than once takes its BEST kind: the claim a
 * `covered` entry makes is "a live test by this name exists", and a same-named
 * helper elsewhere in the workspace should not falsify it.
 *
 * @returns {Map<string, 'live' | 'ignored' | 'not-a-test'>}
 */
function testFnKinds(srcDirs) {
  const kinds = new Map()
  for (const srcDir of srcDirs) {
    for (const file of listRustFiles(srcDir)) {
      const structural = blank(fs.readFileSync(file, 'utf8'), { blankStrings: true })
      // Bodies are unused here, so the structural view stands in for the
      // content view rather than paying for a second pass over the file.
      for (const { name, testKind } of fnsInFile(structural, structural)) {
        const prev = kinds.get(name)
        if (!prev || TEST_KIND_RANK[testKind] > TEST_KIND_RANK[prev]) kinds.set(name, testKind)
      }
    }
  }
  return kinds
}

/** Why a `covered` entry's named test does not count as coverage. */
const DEAD_TEST_WHY = {
  missing: 'no `fn` by that name exists in the tree',
  'not-a-test':
    'that `fn` exists but carries no test attribute (`#[test]` / `#[tokio::test]` / …), so nothing runs it',
  ignored: '`#[ignore]`d, so it never runs — an ignored test covers nothing',
}

/** The `<path>::<fn>` keys a baseline pins by hand (entries carrying `pin`). */
function pinnedKeys(baseline) {
  return new Set(baseline.filter((e) => e.pin).map((e) => e.fn))
}

/**
 * Diff the live inventory against `baseline`. Pure over the filesystem apart
 * from `srcDirs`, so it can be driven against an arbitrary tree.
 */
export function analyze({ root, srcDirs, baseline }) {
  const live = inventory({ root, srcDirs, pinned: pinnedKeys(baseline) })
  const recorded = new Map(baseline.map((e) => [e.fn, e]))
  const testKinds = testFnKinds(srcDirs)

  const missing = [] // in the tree, not in the baseline
  const stale = [] // in the baseline, gone from the tree
  const kindDrift = []
  const deadTests = [] // `covered`, but the named test does not run
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
      else if (entry.reason === 'TODO') {
        undecided.push({ fn: key, why: '`covered` with a placeholder `TODO` reason' })
      } else {
        // A `covered` entry claims a test PROVES the fold. It is only a claim
        // if that test still runs, so an absent name, a non-test `fn` renamed
        // on top of it, and an `#[ignore]` all land here.
        const testKind = testKinds.get(entry.test) ?? 'missing'
        if (testKind !== 'live') {
          deadTests.push({ fn: key, test: entry.test, why: DEAD_TEST_WHY[testKind] })
        }
      }
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
    deadTests: deadTests.toSorted((a, b) => a.fn.localeCompare(b.fn)),
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

  if (r.deadTests.length > 0) {
    failed = true
    console.error('ERROR: `covered` entr(ies) whose equivalence test does not run:')
    for (const { fn, test, why } of r.deadTests) console.error(`  ${fn}  (fn ${test}: ${why})`)
    console.error('')
    console.error('`covered` means a test PROVES this bulk path folds. Deleting that test,')
    console.error('renaming an ordinary function on top of it, or silencing it with #[ignore]')
    console.error('all leave the claim standing with nothing behind it. Restore the test, or')
    console.error('re-record the entry as `gap` with the reason it is uncovered.')
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

// ─── main ───────────────────────────────────────────────────────────

if (process.argv.includes('--update-baseline')) {
  updateBaseline()
} else {
  runGuard()
}
