#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Metric-provability guard (#3349, theme T6 "accounting for conditions
// that cannot occur, read as health").
//
// ─── Why ──────────────────────────────────────────────────────────────
//
// `src-tauri/Cargo.toml` `[profile.release]` sets `panic = "abort"`, and
// documents why. `materializer/consumer.rs` nevertheless bumps
// `fg_panics` / `bg_panics` on the `JoinError::is_panic` arm of a
// `tokio::spawn` join — an arm the runtime can only reach when a panic
// UNWINDS. Under `panic = "abort"` the process is already gone. Those two
// counters are structurally incapable of moving in a release build.
//
// That is worse than dead code. Dead code is inert; a dead counter is
// ACTIVELY MISLEADING. An operator auditing panic rates reads zero and
// concludes the system is healthy. A dashboard that is green because
// nothing ever increments the counter looks exactly like a dashboard that
// is green because the system is well. The same defect the CI-guard work
// keeps finding — a check that cannot fail — relocated into the
// observability layer.
//
// The deep review that surfaced this got the diagnosis wrong: it filed the
// panic counters as a robustness defect ("any handler panic kills the
// app"), when they are doc drift against a documented, deliberate posture.
// That a 63-reviewer pass misread it is precisely why the GATE matters more
// than the instance.
//
// ─── What counts as a metric ──────────────────────────────────────────
//
// Two registration patterns. They are NOT a complete census of "anything
// that counts something"; the shapes that are out of scope are listed under
// Known limits, and each of them is a SILENT miss.
//
//   struct-field  Every `pub <name>: Atomic{U64,U32,I64,Usize}` (or
//                 `Arc<Atomic…>`, or a file-local alias of one) field of any
//                 `pub struct <Name>Metrics` ANYWHERE in the scanned tree.
//                 In this tree that is `QueueMetrics` in
//                 `src-tauri/src/materializer/metrics.rs` — the
//                 materializer's whole counter/gauge surface, what
//                 `StatusInfo` projects and what the Status view renders —
//                 but #3349 hard-coded both the struct name and the file,
//                 so a second metrics struct, or that struct moved behind a
//                 re-export shim, was invisible (#3384).
//                 Metric id: `<Struct>::<field>`.
//
//                 The `…Metrics` suffix is a NAMING CONVENTION, and it is
//                 the one place this enumeration is not purely structural.
//                 The purely structural alternative — every struct with an
//                 atomic field — is wrong here: the tree's other atomic
//                 fields are `mark_seq`, `generation`, `peer_epoch`
//                 (identity/state) and `fanout_fires` (a `#[cfg(test)]`
//                 hook), none of which anything reports.
//
//   global-static A module that declares a module- or `mod`-level
//                 `static <NAME>: Atomic…= Atomic…::new(…)` *and* exposes a
//                 `fn count()` / `last()` / `total()` / `snapshot()`. That
//                 pair is the repo's process-global counter idiom
//                 (`sql_only_fallback`, `divergence`,
//                 `cycle_rejected_metrics`, `snapshot_fallback_metrics`,
//                 `descendant_fanout_dropped`) and is what the OTel
//                 observable counters in `agaric-observability` read.
//                 Metric id: `<module basename>::<NAME>`.
//
//                 The accessor requirement is load-bearing, not
//                 cosmetic: it is what separates a metric from a
//                 process-global *config* atomic with the identical
//                 declaration shape (`sampling.rs`'s
//                 `SAMPLING_RATIO_BITS`), which nothing reports and which
//                 no firing test could sensibly be demanded of. #3349
//                 accepted only the literal name `count`, which made a
//                 counter reported through `fn total()` a silent miss.
//
// Deliberately NOT metrics: `StatusInfo` fields (a projection of the
// above, not a registration site), `#[cfg(test)]`-only atomics (test
// hooks), and `OnceLock`/`Mutex` state.
//
// ─── The three rules ──────────────────────────────────────────────────
//
// 1. `no-firing-test`
//    No test anywhere in the scanned tree ASSERTS the metric above zero.
//    A test that only asserts the metric is `0` is not a firing proof — it
//    is the exact opposite, and it is what `fg_panics`, `bg_panics`,
//    `fg_full_waits` and `bg_full_waits` have today ("…should start at
//    zero", "…must not bump"). Such a test passes forever on a counter
//    that has been physically deleted from the emit path.
//
//    An assertion counts as firing when it puts the metric (or a local
//    binding initialised from it) on the high side of a comparison:
//    `assert_eq!(m.x.load(..), 1)`, `assert!(after > before)`,
//    `assert!(count() > 0)`, `assert_ne!(x, 0)`. Assertion MESSAGES cannot
//    contribute — every string literal is blanked before matching, so
//    `assert_eq!(n, 1, "fg_panics stays zero")` does not launder a proof
//    onto `fg_panics`.
//
//    Two more shapes count, both added by #3384 and both still requiring an
//    ASSERTION — see `findFiringAssertions` for why that word is the whole
//    design:
//      * `assert_eq!(metric, actual)` where `actual` is bound from a SQL
//        read. #3349 credited only a non-zero LITERAL expectation, so a test
//        that drives the production path and pins the counter to a live
//        `SELECT COUNT(*)` read as no test at all — which is how
//        `cached_op_log_count` came to be filed as a defect in #3382 and
//        then refuted.
//      * `let rose = m.x.load(..) > before; assert!(rose)`. NOT "a bound
//        comparison that is later read": logged, tested by a no-op `if`, or
//        rebound are all "later read" and none can fail. The reader must BE
//        an assertion.
//
// 2. `no-production-emit`
//    Nothing outside test code can move the metric. For a struct field:
//    no `<field>.fetch_add(` / `.store(` / … in production code. For a
//    global static: no production CALLER of the module's mutator (`record`,
//    `note_*`) from outside the module's own file — the mutator's own body
//    always writes the static, so requiring only that would be vacuous.
//
//    Rule 2 is the other half of rule 1 and neither subsumes the other. A
//    metric can have a firing test that pokes the atomic directly while
//    production never calls the emit path (the failure shape where
//    assertions are written against a pure function and the wiring rots
//    untested); and a metric can have a live emit site with no test that
//    ever observes it rise.
//
// 3. `unreachable-under-panic-abort`
//    The release profile sets `panic = "abort"`, and EVERY production emit
//    site for the metric sits inside a branch conditioned on panic
//    detection (`…panicked`, `is_panic()`, `catch_unwind`). Such a branch
//    requires an unwind that `panic = "abort"` makes impossible, so the
//    counter cannot move in the shipped binary however healthy or sick the
//    system is. This rule is inert unless `[profile.release]` really
//    carries `panic = "abort"` — flip that back to `unwind` and the rule
//    stops firing on its own, because the impossibility is a property of
//    the profile, not of the counter.
//
// ─── Two exemption mechanisms, both requiring a reason ─────────────────
//
// 1. Per-site marker, for a metric whose impossibility is deliberate and
//    documented at the declaration:
//
//        // metric-fire-exempt(no-firing-test): <why>
//        pub some_counter: AtomicU64,
//
//    The marker may sit on the declaration line or anywhere in the
//    contiguous comment block immediately above it (so it can live below
//    the `///` docs). The rule name must be a real rule and the reason
//    after the colon must be non-empty — a bare marker suppresses nothing.
//
// 2. `scripts/metric-firing-baseline.json`, for pre-existing debt: a
//    sorted array of `{ metric, rule, reason }`. An entry with an empty or
//    missing `reason`, an unknown rule, or a duplicate `(metric, rule)`
//    pair is a HARD ERROR (exit 2) — you cannot silently baseline a dead
//    metric. The baseline is a ratchet: an entry that no longer
//    corresponds to a live violation FAILS, so fixing a metric forces the
//    floor down.
//
// ─── Known limits (documented, not accidental) ────────────────────────
//
// - Firing detection is textual and function-local. An assertion laundered
//   through a helper (`assert_rose(&m.x)`) is not credited; use the
//   marker. Local-binding aliases (`let before = …x.load(…)`) ARE followed,
//   within the enclosing `fn` only.
// - Rule 2's global-static half credits any production file that both
//   names the module and calls the mutator; a mutator re-exported under a
//   different name is not tracked.
// - The SQL-ground-truth credit is satisfied by a ground truth that is
//   itself zero: a test that seeds no rows and asserts the counter equals
//   `SELECT COUNT(*)` is credited while proving nothing. Narrowing further
//   would need to know the value, which is not a textual property. This is
//   the ONLY loose credit in rule 1, it still requires a real assertion with
//   the metric on one side, and it replaced a strictly worse state (the
//   correct test read as no test at all).
// - Rule 3 looks at the enclosing block heads of an emit site and matches
//   `catch_unwind` or any identifier containing `panic` in them, unless that
//   identifier is negated. A `match` arm with an `if e.is_panic()` guard IS
//   matched (the guard text precedes the arm's `{`), and so are
//   `let panicked = e.is_panic(); if panicked {`, `if is_panic_outcome(&o)`
//   and `if o.was_panic`. `if !o.panicked` is NOT — that branch runs on the
//   ordinary path. The price of the widening, asserted in `--self-test` so
//   it is a known fact rather than a discovery: a gate whose name merely
//   contains `panic` (`if cfg.panic_on_error`) reads as panic detection and
//   would produce a false finding. That direction is deliberate — rule 3's
//   false positive is a named CI failure a human can exempt with a reason,
//   while its false negative is a counter silently reporting zero as health.
// - Rule 3 judges the emit SITES of a struct field. It is deliberately not
//   applied to the global-static pattern, whose only in-module writes are
//   the mutator's own body.
// - ENUMERATION HOLES. #3384 closed the six that were verified by
//   construction in #3349 (a counter in a second `…Metrics` struct, an
//   atomic behind a type alias, `Arc<Atomic…>` fields, a global static
//   exposed by `fn total()`/`snapshot()`/`last()`, a crate at
//   `src-tauri/crates/<crate>/src`, and `QueueMetrics` moving behind a
//   re-export shim). What remains open, each a SILENT miss because no rule
//   can flag a metric the enumerator never saw:
//     * a counter in a struct NOT named `…Metrics` (see above for why the
//       structural alternative is worse in this tree);
//     * an `AtomicBool` flag. A flag has no "above zero" —
//       `assert!(f.load(..) > 0)` does not compile — so admitting one would
//       create a violation no test could ever clear, only a marker. Closing
//       it needs a truthiness credit in `isFiringAssertion` first, and there
//       is no `AtomicBool` metric in the tree to justify one;
//     * a global static exposed by an accessor named outside
//       `GLOBAL_ACCESSORS`, and a metric struct outside the scan roots
//       (which are pinned by `--self-test`).
//   The scan SCOPE, by contrast, is pinned: `--self-test` asserts the exact
//   `scanRoots` set and the exact set of metric-declaring files, so a
//   narrowed walk cannot silently shrink the surface.
// - Nested block comments, raw strings (`r#"…"#`) and byte strings are
//   handled; lifetimes are distinguished from char literals by close
//   proximity of the closing quote.
//
// ─── Self-scan ────────────────────────────────────────────────────────
//
// This guard lives in `scripts/` and scans ONLY `src-tauri/src` +
// `src-tauri/<crate>/src`, so it can never match its own source, its
// own fixtures (which are written into a temp dir by `--self-test`) or its
// own baseline — even though its source contains several literal
// `pub <name>: AtomicU64,` fixture lines and several `metric-fire-exempt`
// markers.
//
// That is asserted, not assumed, and asserted in a way that can FAIL:
// `--self-test` pins the exact scan-root SET (`scanRoots`), pins the walk to
// `.rs` files, plants a metric-shaped `.rs` decoy in `scripts/`, the repo
// root and `e2e/` of a fixture tree, and asserts that THIS FILE's path does
// not lie under any scan root. The obvious assertion — "no scanned file
// lives outside `src-tauri/`" — is kept, but it is vacuous on its own:
// `scripts/` holds no `.rs`, so it survives a change that adds `scripts/` as
// a root. That was the single surviving mutant when this guard was
// mutation-tested against its own self-test; the root-set, the decoys and
// the path-under-a-root check exist to kill it. The path check replaced an
// earlier `!live.files.some(f => f.endsWith('check-metric-provable.mjs'))`,
// which could not fail at all: the walk only ever yields `.rs` paths, so no
// scanned file can end in `.mjs` no matter what the roots are.
//
// Usage: node scripts/check-metric-provable.mjs
//        node scripts/check-metric-provable.mjs --root <dir>
//        node scripts/check-metric-provable.mjs --list
//        node scripts/check-metric-provable.mjs --update-baseline
//        node scripts/check-metric-provable.mjs --self-test
// Exit:  0 = clean, 1 = new unprovable metric or stale baseline entry,
//        2 = repo layout / malformed baseline / self-test failure.
// ─────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const RULES = Object.freeze([
  'no-firing-test',
  'no-production-emit',
  'unreachable-under-panic-abort',
])

const METRICS_FILE_REL = 'src-tauri/src/materializer/metrics.rs'
const CARGO_TOML_REL = 'src-tauri/Cargo.toml'
const BASELINE_REL = 'scripts/metric-firing-baseline.json'

/**
 * Structs whose atomic fields are a metric surface, by NAME SUFFIX.
 *
 * #3349 hard-coded `QueueMetrics` in one hard-coded file, so a counter added
 * to a second `…Metrics` struct — or to `QueueMetrics` after it moved out of
 * `metrics.rs` behind a re-export shim — was a SILENT miss (#3384 item 4).
 * Both are closed by looking for the suffix anywhere in the scanned tree.
 *
 * The suffix is a convention, and admitting one is a real (small) cost: the
 * enumeration is no longer purely structural. The alternative considered was
 * "every struct with an atomic field", which is structural but wrong — the
 * live tree's non-`Metrics` atomic fields are `mark_seq`, `generation`,
 * `peer_epoch` (identity/state, not observability) and `fanout_fires` (a
 * `#[cfg(test)]` hook). Flagging those would put four unfixable entries in the
 * baseline and teach readers that baseline entries are noise.
 */
const METRIC_STRUCT_SUFFIX = 'Metrics'

const ATOMIC_TYPES = 'AtomicU64|AtomicU32|AtomicI64|AtomicUsize'

/**
 * The same atomic types, optionally written through a module path
 * (`std::sync::atomic::AtomicU64`). Rust accepts both spellings for the same
 * type; matching only the bare form made the qualified one invisible.
 */
const QUALIFIED_ATOMIC = `(?:[A-Za-z_]\\w*\\s*::\\s*)*(?:${ATOMIC_TYPES})`

/**
 * A struct FIELD may also hold the atomic behind an `Arc` — the shape a gauge
 * takes when it is shared with a background task. `Arc<AtomicUsize>` reads and
 * writes through `Deref`, so every rule downstream works unchanged.
 *
 * `AtomicBool` is deliberately still NOT a metric type. A flag has no "above
 * zero": `assert!(flag.load(..) > 0)` does not compile, so every `AtomicBool`
 * admitted here would be permanently unprovable and could only ever be
 * silenced by a marker — a rule that can only be suppressed is not a rule.
 * Admitting it needs a truthiness credit in `isFiringAssertion` first, and
 * the tree has no `AtomicBool` metric to justify that today.
 */
const ATOMIC_FIELD_TYPE = `(?:(?:[A-Za-z_]\\w*\\s*::\\s*)*Arc\\s*<\\s*${QUALIFIED_ATOMIC}\\s*>|${QUALIFIED_ATOMIC})`

/** Atomic mutators. A metric only "fires" through one of these. */
const WRITE_OPS =
  'fetch_add|fetch_sub|fetch_max|fetch_min|fetch_or|fetch_and|store|swap|compare_exchange|compare_exchange_weak'

/** Mutator function names for the global-static pattern. */
const GLOBAL_MUTATORS = Object.freeze(['record', 'note'])

/**
 * Accessor names that make a process-global atomic a REPORTED metric rather
 * than a process-global config knob. #3349 required exactly `fn count()`, so a
 * module that reported through `fn total()` or `fn snapshot()` was invisible
 * (#3384 item 4). `last` was already accepted as an observation token by
 * `metricTokens` while NOT being accepted as a registration signal — the two
 * lists are now the same list, so that inconsistency cannot come back.
 */
const GLOBAL_ACCESSORS = Object.freeze(['count', 'last', 'total', 'snapshot'])

const SKIP_DIRS = Object.freeze(
  new Set(['target', 'gen', 'node_modules', '.git', 'proptest-regressions']),
)

// ─── generic helpers ──────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/** 1-based line number lookup for a character offset. */
function makeLineLookup(src) {
  const starts = [0]
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') starts.push(i + 1)
  return (idx) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= idx) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

// ─── Rust comment + literal blanking ──────────────────────────────────

/**
 * Blank out every comment and the INTERIOR of every string / char literal,
 * preserving length and newlines so offsets and line numbers stay exact.
 *
 * Blanking string interiors is load-bearing, not tidiness: assertion
 * messages routinely name the metric they are about
 * (`assert_eq!(x, 1, "fg_panics stays zero")`). Left intact, such a message
 * would let an unrelated non-zero assertion masquerade as a firing proof
 * for the metric named in its prose — a guard satisfied by its own subject
 * matter's documentation, which is the exact shape of guard that cannot
 * fail.
 *
 * Rust specifics handled: nested block comments, raw strings (`r"…"`,
 * `r#"…"#`), byte strings (`b"…"`, `br#"…"#`), and the `'` ambiguity
 * between a char literal (`'a'`, `'\n'`) and a lifetime (`&'a str`).
 *
 * @param {string} src
 * @returns {string}
 */
/** Index just past a `/* … *\/` comment at `i`. Rust block comments nest. */
function endOfBlockComment(src, i) {
  let depth = 0
  let j = i
  while (j < src.length) {
    if (src[j] === '/' && src[j + 1] === '*') {
      depth += 1
      j += 2
    } else if (src[j] === '*' && src[j + 1] === '/') {
      depth -= 1
      j += 2
      if (depth === 0) return j
    } else {
      j += 1
    }
  }
  return j
}

/**
 * A raw / byte string starting at `i` (`r"…"`, `r#"…"#`, `b"…"`, `br#"…"#`),
 * or `null` if `i` is not one. `open`/`close` bound the interior.
 */
function rawStringSpan(src, i) {
  const m = /^(?:br|rb|r|b)(#*)"/.exec(src.slice(i, i + 12))
  if (!m) return null
  const open = i + m[0].length
  const closer = `"${m[1]}`
  const closeIdx = src.indexOf(closer, open)
  if (closeIdx === -1) return { open, close: src.length, next: src.length }
  return { open, close: closeIdx, next: closeIdx + closer.length }
}

export function stripNoise(src) {
  const out = src.split('')
  const n = src.length
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]

    if (c === '/' && d === '/') {
      let j = i
      while (j < n && src[j] !== '\n') j += 1
      blank(i, j)
      i = j
      continue
    }
    if (c === '/' && d === '*') {
      const j = endOfBlockComment(src, i)
      blank(i, j)
      i = j
      continue
    }

    // Raw / byte strings: r"…", r#"…"#, b"…", br#"…"#.
    if ((c === 'r' || c === 'b') && !/[\w]/.test(src[i - 1] ?? '')) {
      const span = rawStringSpan(src, i)
      if (span) {
        blank(span.open, span.close)
        i = span.next
        continue
      }
    }

    if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === '"') break
        j += 1
      }
      blank(i + 1, j)
      i = Math.min(j + 1, n)
      continue
    }

    if (c === "'") {
      // Char literal if a closing quote arrives within an escape's reach;
      // otherwise it is a lifetime (`&'a str`, `'static`) and must be left
      // alone or the rest of the file desyncs.
      const window = src.slice(i, i + 8)
      const lit = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|.)|[^\\'])'/.exec(window)
      if (lit) {
        blank(i + 1, i + lit[0].length - 1)
        i += lit[0].length
        continue
      }
      i += 1
      continue
    }

    i += 1
  }
  return out.join('')
}

/** Index just past the `}` matching the `{` at `open`. */
function matchBrace(src, open) {
  let depth = 0
  let j = open
  while (j < src.length) {
    if (src[j] === '{') depth += 1
    else if (src[j] === '}') {
      depth -= 1
      if (depth === 0) return j + 1
    }
    j += 1
  }
  return j
}

/**
 * Split a macro/call argument list. `open` is the index of the `(`.
 * Returns `{ end, args }` with `args` the raw top-level argument texts.
 */
function readCallArgs(src, open) {
  const args = []
  let depth = 0
  let start = open + 1
  let j = open
  while (j < src.length) {
    const c = src[j]
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ']' || c === '}') depth -= 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) {
        args.push(src.slice(start, j))
        return { end: j, args }
      }
    } else if (c === ',' && depth === 1) {
      args.push(src.slice(start, j))
      start = j + 1
    }
    j += 1
  }
  return { end: j, args }
}

// ─── test-code regions ────────────────────────────────────────────────

/**
 * Whether a repo-relative path is test code by location alone. Covers the
 * `materializer/tests/` module directory, the `*_tests.rs` /
 * `*_proptest.rs` siblings that sit next to production modules, and
 * integration-test roots.
 *
 * @param {string} rel
 */
export function isTestPath(rel) {
  const base = path.posix.basename(rel)
  if (/(?:^|\/)(?:tests|benches|fuzz|examples)\//.test(rel)) return true
  if (/^tests?\.rs$/.test(base)) return true
  if (/_(?:tests?|proptest|proptests)\.rs$/.test(base)) return true
  return false
}

/**
 * Character ranges of test-gated item bodies — `#[cfg(test)] mod … { … }`
 * and the `#[cfg(any(test, feature = "test-util"))] pub mod spy { … }` form
 * the engine crate uses for its call spies. Any assertion inside one is test
 * code even when the file itself is production.
 *
 * The predicate is "the `cfg` argument list mentions a bare `test` token and
 * does not negate it", evaluated over the comment- and string-blanked source
 * so `feature = "test-util"` does not read as `test`. `#[cfg(not(test))]` is
 * production and is deliberately excluded.
 *
 * @param {string} stripped
 * @returns {{start: number, end: number}[]}
 */
export function cfgTestRegions(stripped) {
  const out = []
  const re = /#\s*\[\s*cfg\s*\(/g
  let m
  while ((m = re.exec(stripped))) {
    const paren = m.index + m[0].length - 1
    const { end: closeParen, args } = readCallArgs(stripped, paren)
    const inner = args.join(',')
    if (!/\btest\b/.test(inner) || /\bnot\s*\(/.test(inner)) continue
    const open = stripped.indexOf('{', closeParen)
    if (open === -1) continue
    // Only treat it as a block when the `{` really belongs to this item —
    // a `#[cfg(test)] mod tests;` declaration has a `;` first.
    const between = stripped.slice(closeParen, open)
    if (between.includes(';')) continue
    out.push({ start: m.index, end: matchBrace(stripped, open) })
  }
  return out
}

function inAnyRegion(regions, idx) {
  return regions.some((r) => idx >= r.start && idx < r.end)
}

// ─── function spans (for alias scoping) ───────────────────────────────

/**
 * Body spans of every `fn` in the file, innermost-resolvable. Aliases
 * (`let before = …metric…`) are scoped to the enclosing function so a
 * binding in one test cannot vouch for an assertion in another.
 *
 * @param {string} stripped
 */
export function functionSpans(stripped) {
  const out = []
  const re = /\bfn\s+[A-Za-z_]\w*/g
  let m
  while ((m = re.exec(stripped))) {
    let j = m.index + m[0].length
    let depth = 0
    let body = -1
    while (j < stripped.length) {
      const c = stripped[j]
      if (c === '(' || c === '[') depth += 1
      else if (c === ')' || c === ']') depth -= 1
      else if (depth <= 0 && c === '{') {
        body = j
        break
      } else if (depth <= 0 && c === ';') break
      j += 1
    }
    if (body === -1) continue
    out.push({ start: body, end: matchBrace(stripped, body) })
  }
  return out
}

function innermostSpan(spans, idx) {
  let best = null
  for (const s of spans) {
    if (idx < s.start || idx >= s.end) continue
    if (!best || s.end - s.start < best.end - best.start) best = s
  }
  return best
}

// ─── enclosing block heads (rule 3) ───────────────────────────────────

/**
 * The heads of every block enclosing `idx` — the text between the previous
 * statement boundary and each open brace still on the stack. Used to ask
 * "is this emit site inside `if …panicked…`?".
 *
 * @param {string} stripped
 * @param {number} idx
 * @returns {string[]}
 */
export function enclosingBlockHeads(stripped, idx) {
  const stack = []
  let lastBoundary = 0
  for (let j = 0; j < idx; j += 1) {
    const c = stripped[j]
    if (c === '{') {
      stack.push(stripped.slice(lastBoundary, j).trim())
      lastBoundary = j + 1
    } else if (c === '}') {
      stack.pop()
      lastBoundary = j + 1
    } else if (c === ';') {
      lastBoundary = j + 1
    }
  }
  return stack
}

const PANIC_TOKEN_RE = /\bcatch_unwind\b|\b[A-Za-z_]*panic[A-Za-z0-9_]*\b/g

/**
 * Whether one enclosing block head gates its body on a panic having been
 * DETECTED — the branch rule 3 calls unreachable under `panic = "abort"`.
 *
 * #3349 matched three literal spellings (`panicked`, `is_panic(`,
 * `catch_unwind`), so a gate named `if is_panic_outcome(&o)` or
 * `if o.was_panic` was a silent miss (#3384 item 3). Any identifier
 * CONTAINING `panic` now counts.
 *
 * Widening this costs false positives in one direction only — a head like
 * `if cfg.panic_on_error` would be read as panic detection — and that is the
 * right trade here because rule 3's false positive is LOUD (a named CI failure
 * a human reads and can exempt with a reason) while its false negative is
 * silent: a counter that cannot move in the shipped binary keeps reporting
 * zero as health, which is the entire defect the guard exists to find.
 *
 * A NEGATED token is not a panic gate: `if !outcome.panicked { … }` runs on
 * the ordinary path, so an emit inside it is perfectly reachable in release.
 * #3349 matched that head too, which was a latent false positive; it is
 * rejected here.
 */
export function isPanicGateHead(head) {
  const kw = /\b(?:if|while)\b/.exec(head)
  if (!kw) return false
  const cond = head.slice(kw.index + kw[0].length)
  PANIC_TOKEN_RE.lastIndex = 0
  let t
  while ((t = PANIC_TOKEN_RE.exec(cond))) {
    // Walk back off the token's own path/field chain, then off any grouping
    // or reference sigils, and see whether a `!` is what remains.
    const stem = cond
      .slice(0, t.index)
      .replace(/[\w.:]*$/, '')
      .replace(/[\s(&*]+$/, '')
    if (stem.endsWith('!') && !stem.endsWith('!=')) continue
    return true
  }
  return false
}

// ─── metric enumeration ───────────────────────────────────────────────

/**
 * Whether the item declared on `line` (1-based) carries a `#[cfg(test)]`
 * attribute. Field-level `#[cfg(test)]` is not a block, so `cfgTestRegions`
 * cannot see it; without this a test-only counter such as
 * `InboundRebuildDebounce::fanout_fires` would enumerate as a real metric the
 * moment its struct were renamed to end in `Metrics`.
 *
 * Reads the STRIPPED lines so `#[cfg(feature = "test-util")]` — whose string
 * contains `test` — is not mistaken for a `test` cfg. A stripped comment line
 * is all blanks, which ends the walk: the attribute must be in the contiguous
 * run of attributes directly above the field, which is where rustfmt puts it.
 *
 * @param {string[]} strippedLines
 * @param {number} line
 */
function hasCfgTestAttribute(strippedLines, line) {
  for (let i = line - 2; i >= 0; i -= 1) {
    const text = (strippedLines[i] ?? '').trim()
    if (!text.startsWith('#[')) break
    if (/\bcfg\s*\(/.test(text) && /\btest\b/.test(text) && !/\bnot\s*\(/.test(text)) return true
  }
  return false
}

/**
 * File-local `type Counter = AtomicU64;` aliases, as an alternation ready to
 * be spliced into the field-type pattern.
 *
 * A field declared `pub good: Counter,` is a counter in every sense that
 * matters, and #3349 could not see it (#3384 item 4). Only aliases whose
 * right-hand side is itself an atomic are admitted, so `type Ratio = f64;`
 * still cannot turn a config field into a metric.
 *
 * @param {string} stripped
 * @returns {string[]} alias identifiers
 */
function atomicTypeAliases(stripped) {
  const re = new RegExp(`\\btype\\s+([A-Za-z_]\\w*)\\s*=\\s*${ATOMIC_FIELD_TYPE}\\s*;`, 'g')
  const out = []
  let m
  while ((m = re.exec(stripped))) out.push(m[1])
  return out
}

/**
 * Atomic fields of every `…Metrics` struct in one file, with the line each is
 * declared on and the contiguous comment block above it (where a
 * `metric-fire-exempt` marker may live).
 *
 * @param {string} raw original source (markers live in comments)
 * @returns {{struct: string, name: string, line: number, exemptions: Record<string,string>}[]}
 */
export function enumerateStructMetrics(raw) {
  const stripped = stripNoise(raw)
  const structRe = new RegExp(`\\bstruct\\s+([A-Za-z_]\\w*${METRIC_STRUCT_SUFFIX})\\b`, 'g')
  const lineOf = makeLineLookup(stripped)
  const rawLines = raw.split('\n')
  const strippedLines = stripped.split('\n')
  const cfgTest = cfgTestRegions(stripped)
  const aliases = atomicTypeAliases(stripped)
  const fieldType =
    aliases.length > 0
      ? `(?:${ATOMIC_FIELD_TYPE}|(?:${aliases.map(escapeForRegExp).join('|')}))`
      : ATOMIC_FIELD_TYPE

  const out = []
  // The visibility, the trailing comma and the type's path qualifier are all
  // OPTIONAL, because none of them is load-bearing in Rust and requiring them
  // turned three legal declarations into silent enumeration misses:
  // `pub(crate) x: AtomicU64,`, a last field with no trailing comma, and
  // `pub x: std::sync::atomic::AtomicU64,`. Verified by the fixtures below.
  const fieldRe = new RegExp(
    `^[ \\t]*(?:pub(?:\\s*\\([^)]*\\))?\\s+)?([a-z_][a-z0-9_]*)\\s*:\\s*${fieldType}\\s*,?[ \\t]*$`,
    'gm',
  )
  let sm
  while ((sm = structRe.exec(stripped))) {
    if (inAnyRegion(cfgTest, sm.index)) continue
    const open = stripped.indexOf('{', sm.index)
    if (open === -1) continue
    // `struct QueueMetrics;` / `struct QueueMetrics(u64);` have no field block.
    if (/[;)]/.test(stripped.slice(sm.index + sm[0].length, open))) continue
    const end = matchBrace(stripped, open)
    const body = stripped.slice(open, end)
    fieldRe.lastIndex = 0
    let m
    while ((m = fieldRe.exec(body))) {
      const line = lineOf(open + m.index)
      if (hasCfgTestAttribute(strippedLines, line)) continue
      out.push({ struct: sm[1], name: m[1], line, exemptions: markersAbove(rawLines, line) })
    }
  }
  return out
}

const MARKER_RE = /\/\/\s*metric-fire-exempt\s*\(\s*([a-z-]+)\s*\)\s*:(.*)$/

/**
 * `metric-fire-exempt(<rule>): <reason>` markers on `line` (1-based) or in
 * the contiguous comment block immediately above it. Returns
 * `{ rule: reason }`; an empty reason is deliberately kept as `''` so the
 * caller can reject it rather than silently honour it.
 *
 * @param {string[]} rawLines
 * @param {number} line
 */
export function markersAbove(rawLines, line) {
  const found = {}
  const take = (text) => {
    const m = MARKER_RE.exec(text)
    if (m) found[m[1]] = m[2].trim()
  }
  take(rawLines[line - 1] ?? '')
  for (let i = line - 2; i >= 0; i -= 1) {
    const text = (rawLines[i] ?? '').trim()
    if (text.length === 0) break
    if (!text.startsWith('//')) break
    take(text)
  }
  return found
}

/**
 * Global-static metrics: a `static NAME: Atomic… = …` in a module
 * that also exposes `fn count()`.
 *
 * @param {string} raw
 * @returns {{name: string, line: number, exemptions: Record<string,string>}[]}
 */
export function enumerateGlobalMetrics(raw) {
  const stripped = stripNoise(raw)
  const accessorRe = new RegExp(`\\bfn\\s+(?:${GLOBAL_ACCESSORS.join('|')})\\s*\\(\\s*\\)`)
  if (!accessorRe.test(stripped)) return []
  const lineOf = makeLineLookup(stripped)
  const rawLines = raw.split('\n')
  // Indentation and visibility are optional so a counter declared inside a
  // nested `mod` block is still seen. The two indented statics in the live
  // tree (`projection::CALLS`, `pages_cache::CALLS`) are test-only spies and
  // are excluded by `cfgTestRegions`, which recognises `#[cfg(any(test, …))]`
  // as well as a bare `#[cfg(test)]` — previously they were excluded only by
  // the accident of being indented.
  const aliases = atomicTypeAliases(stripped)
  const staticType =
    aliases.length > 0
      ? `(?:${QUALIFIED_ATOMIC}|(?:${aliases.map(escapeForRegExp).join('|')}))`
      : QUALIFIED_ATOMIC
  const re = new RegExp(
    `^[ \\t]*(?:pub(?:\\s*\\([^)]*\\))?\\s+)?static\\s+([A-Z][A-Z0-9_]*)\\s*:\\s*${staticType}\\s*=`,
    'gm',
  )
  const cfgTest = cfgTestRegions(stripped)
  const out = []
  let m
  while ((m = re.exec(stripped))) {
    if (inAnyRegion(cfgTest, m.index)) continue
    const line = lineOf(m.index)
    out.push({ name: m[1], line, exemptions: markersAbove(rawLines, line) })
  }
  return out
}

// ─── assertion classification ─────────────────────────────────────────

const ZERO_RE = /^0(?:_?[ui](?:8|16|32|64|128|size))?$/

/** Does this operand text pin the metric to something above zero? */
export function isNonZeroExpectation(text) {
  const t = text.trim()
  if (t.length === 0) return false
  // Redundant with the digit scan below, deliberately: every string ZERO_RE
  // accepts (`0`, `0u64`, `0_i32`, `0usize`, …) already fails it, because each
  // `[1-9]` inside a suffix is preceded by a word character and so loses the
  // lookbehind. Deleting EITHER line alone changes no verdict; deleting both
  // credits `assert_eq!(m, 0)` as a firing proof, which the self-test catches.
  // Kept as the explicit statement of the rule rather than an emergent
  // property of a lookbehind.
  if (ZERO_RE.test(t)) return false
  return /(?<![\w.])[1-9]\d*/.test(t)
}

function isZeroLiteral(text) {
  return ZERO_RE.test(text.trim())
}

/** Index of the first top-level comparison operator, or -1. */
function findComparison(expr) {
  let depth = 0
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i]
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if (depth === 0 && (c === '>' || c === '<' || c === '=' || c === '!')) {
      const two = expr.slice(i, i + 2)
      if (two === '>=' || two === '<=' || two === '==' || two === '!=') return i
      if ((c === '>' || c === '<') && expr[i + 1] !== '=' && expr[i - 1] !== '-') {
        // Skip turbofish / generic brackets: `Vec<u64>` has no spaces
        // around the angle bracket in this codebase's style.
        if (/\s/.test(expr[i + 1] ?? '') || /\s/.test(expr[i - 1] ?? '')) return i
      }
    }
  }
  return -1
}

/**
 * The `assert_eq!` / `assert_ne!` half of `isFiringAssertion`. Split out only
 * to keep either function under the complexity budget.
 *
 * @param {string[]} args
 * @param {boolean} ne
 * @param {(text: string) => boolean} mentions
 * @param {(text: string) => boolean} isWitness
 */
function isFiringEquality(args, ne, mentions, isWitness) {
  if (args.length < 2) return false
  const [a, b] = args
  const aHit = mentions(a)
  const bHit = mentions(b)
  if (!aHit && !bHit) return false
  const other = aHit ? b : a
  if (ne) return isZeroLiteral(other)
  if (isNonZeroExpectation(other)) return true
  // Both operands derive from the metric — `assert_eq!(after, before)`, the
  // "must not bump" shape. `witnessesIn` already refuses to make a
  // metric-derived binding a witness, so this is belt AND braces; the
  // `--self-test` pins it with a context that says yes to everything, so the
  // line is killable rather than decorative.
  if (aHit && bHit) return false
  return isWitness(other)
}

/**
 * Whether one `assert…!` invocation proves `mentions(text)` can exceed
 * zero. `mentions` answers "does this fragment name the metric (or an alias
 * of it)?".
 *
 * `ctx` carries the two function-scoped credits added by #3384. Both default
 * to "never", so a caller that passes only `mentions` gets exactly the #3349
 * literal-only behaviour.
 *
 * - `isWitness(text)` — the expectation is a local binding holding an
 *   INDEPENDENT runtime observation, so `assert_eq!(metric, actual)` is
 *   credited the way `assert_eq!(metric, 5)` already was. Consulted only when
 *   exactly ONE side names the metric: when both do, the assertion is the
 *   "must not bump" shape (`assert_eq!(after, before)`), which is the opposite
 *   of a firing proof.
 * - `isProvenPredicate(text)` — the sole argument of a bare `assert!` is a
 *   local binding whose initialiser is ITSELF a firing comparison:
 *   `let rose = m.x.load(..) > before; assert!(rose)`. This is the one way a
 *   bound comparison earns credit, and the condition is that an ASSERTION
 *   reads it, not that anything reads it. See `findFiringAssertions`.
 *
 * @param {string} macro one of assert, assert_eq, assert_ne, debug_assert…
 * @param {string[]} args raw top-level argument texts
 * @param {(text: string) => boolean} mentions
 * @param {{isWitness?: (text: string) => boolean, isProvenPredicate?: (text: string) => boolean}} ctx
 */
export function isFiringAssertion(macro, args, mentions, ctx = {}) {
  if (args.length === 0) return false
  const isWitness = ctx.isWitness ?? (() => false)
  const isProvenPredicate = ctx.isProvenPredicate ?? (() => false)
  const eq = macro.endsWith('_eq')
  const ne = macro.endsWith('_ne')

  if (eq || ne) return isFiringEquality(args, ne, mentions, isWitness)

  const expr = args[0]
  if (isProvenPredicate(expr)) return true
  if (!mentions(expr)) return false
  const at = findComparison(expr)
  if (at === -1) return false
  const op = /^(?:>=|<=|==|!=)/.exec(expr.slice(at))?.[0] ?? expr[at]
  const lhs = expr.slice(0, at)
  const rhs = expr.slice(at + op.length)
  const metricOnLeft = mentions(lhs)
  const other = metricOnLeft ? rhs : lhs
  // Normalise so the metric is always conceptually on the left.
  const flip = { '>': '<', '<': '>', '>=': '<=', '<=': '>=', '==': '==', '!=': '!=' }
  const effective = metricOnLeft ? op : flip[op]

  if (effective === '>') return true
  if (effective === '>=') return !isZeroLiteral(other)
  if (effective === '!=') return isZeroLiteral(other)
  if (effective === '==') return isNonZeroExpectation(other)
  return false
}

const ASSERT_RE = /\b((?:debug_)?assert(?:_eq|_ne)?)\s*!\s*\(/g
const LET_RE = /\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::[^=;]+)?=\s*([^;]*);/g

/**
 * Local bindings inside `span` whose initialiser names the metric, so
 * `let before = m.x.load(…)` lets a later `assert!(after > before)` be
 * recognised. Scoped to one `fn` so a binding in one test cannot vouch for
 * an assertion in another.
 *
 * @param {string} body
 * @param {(text: string) => boolean} namesMetric
 * @returns {Set<string>}
 */
function aliasesIn(body, namesMetric) {
  const aliases = new Set()
  LET_RE.lastIndex = 0
  let lm
  while ((lm = LET_RE.exec(body))) {
    if (namesMetric(lm[2])) aliases.add(lm[1])
  }
  return aliases
}

/**
 * An initialiser that reads GROUND TRUTH out of the database.
 *
 * The first cut of this rule accepted any initialiser containing a call —
 * "an independent runtime observation" — and that was measurably too loose:
 * run against the live tree it credited
 * `assert_eq!(before, sql_only_fallback::count())` in `fifo_status.rs`, where
 * `before` is the same quantity read through the status projection. Both sides
 * are zero at that point, so the assertion passes with the emit site deleted —
 * the exact shape this guard exists to reject. Restricting the witness to a
 * SQL read is what makes the credit mean "pinned against something the metric
 * pipeline did not produce".
 */
const SQL_OBSERVATION_RE = /\b(?:sqlx\s*::|query\w*\s*[!(]|fetch_(?:one|all|optional)\s*\()/

/**
 * Local bindings holding a database ground truth: the initialiser must
 * (a) not name the metric or any alias of it and (b) read from SQL.
 *
 * This is what lets `assert_eq!(cached, actual)` count, where
 * `let actual = sqlx::query_scalar("SELECT COUNT(*) …")…;`. #3349 credited only
 * a non-zero LITERAL expectation, so that test — which drives the production
 * refresh and fails the moment the refresh stops writing — read as no test at
 * all and produced a false finding in #3382 (#3384 item 1).
 *
 * Clause (a) is what keeps a CIRCULAR ground truth out — a SQL read whose own
 * text is derived from the metric, e.g.
 * `let n = sqlx::query_scalar(&fmt(m.x.load(..))).fetch_one(…)…;
 *  assert_eq!(m.x.load(..), n)`. Both sides then move together and the
 * assertion cannot fail. It is NOT what rejects "must not bump": in
 * `assert_eq!(after, before)` both operands name the metric, and
 * `isFiringEquality` refuses that pair before `isWitness` is ever consulted
 * (pinned by the "stays rejected even under the loosest context" assertion,
 * which passes `isWitness: () => true`).
 *
 * The residual hole is a SQL ground truth that is itself zero — a test that
 * seeds no rows and asserts the counter equals `SELECT COUNT(*)` would be
 * credited while proving nothing. It is recorded under Known limits. It is a
 * far smaller hole than "any bound comparison that is read", because it still
 * requires an assertion, still requires the metric on one side, and still
 * fails the moment the emit site stops writing anything non-default.
 *
 * @param {string} body
 * @param {(text: string) => boolean} mentions names the metric or an alias
 * @returns {Set<string>}
 */
function witnessesIn(body, mentions) {
  const out = new Set()
  LET_RE.lastIndex = 0
  let lm
  while ((lm = LET_RE.exec(body))) {
    if (mentions(lm[2])) continue
    if (!SQL_OBSERVATION_RE.test(lm[2])) continue
    out.add(lm[1])
  }
  return out
}

/**
 * Local bindings whose initialiser is itself a firing comparison, so that
 * `let rose = m.x.load(..) > before; assert!(rose)` is credited while the four
 * shapes that merely READ `rose` — a log line, a no-op `if`, a rebind, a dead
 * store — are not. The discriminator is not "is `rose` read" (nothing textual
 * separates those) but "is `rose` the subject of an `assert!`", which is exact.
 *
 * @param {string} body
 * @param {(text: string) => boolean} mentions
 * @returns {Set<string>}
 */
function firingPredicatesIn(body, mentions) {
  const out = new Set()
  LET_RE.lastIndex = 0
  let lm
  while ((lm = LET_RE.exec(body))) {
    if (isFiringAssertion('assert', [lm[2]], mentions)) out.add(lm[1])
  }
  return out
}

/**
 * Firing proofs found in the test regions of one file.
 *
 * Every credited shape is an `assert…!` INVOCATION. Three are recognised:
 *
 * 1. the metric (or a local binding initialised from it) on the HIGH side of a
 *    comparison — `assert!(m.x.load(..) > 0)`, `assert_eq!(x, before + 1)`;
 * 2. an equality against an independent runtime observation —
 *    `assert_eq!(cached, actual)` where `actual` came from a query
 *    (`witnessesIn`);
 * 3. a bound firing comparison that an `assert!` READS —
 *    `let rose = m.x.load(..) > before; assert!(rose)` (`firingPredicatesIn`).
 *
 * Shape 3 is deliberately not "a bound firing comparison that is later read".
 * That relaxation was tried during #3349 to accommodate `tests/idempotency.rs`
 * (which binds the comparison and `.expect()`s a *different* value
 * downstream), and it is a hole, not a refinement:
 * `let rose = …; tracing::debug!(rose);` and
 * `let rose = …; if rose { println!("nice"); }` are both "bound and later
 * read", and neither can fail. Requiring the reader to BE an assertion is the
 * line that separates them, and it is exact rather than heuristic — but it
 * does not reach `idempotency.rs`, whose proof travels through an `Option`
 * assigned inside an `if` and only then `.expect()`ed. That metric keeps a
 * *baseline entry naming its real proof* — a claim a human wrote, which the
 * ratchet retires the moment a direct assertion appears.
 *
 * @param {string} stripped comment- and string-blanked source
 * @param {{start: number, end: number}[]} testRegions
 * @param {RegExp[]} tokens metric-naming patterns (global flag OFF)
 * @returns {number[]} character offsets of the firing proofs
 */
export function findFiringAssertions(stripped, testRegions, tokens) {
  if (testRegions.length === 0) return []
  const spans = functionSpans(stripped)
  const hits = []
  const namesMetric = (text) => tokens.some((t) => t.test(text))

  const asIdent = (text) => {
    const t = text.trim()
    return /^[A-Za-z_]\w*$/.test(t) ? t : null
  }

  /** @type {Map<{start:number,end:number}|null, object>} */
  const ctxCache = new Map()
  const ctxFor = (span) => {
    if (ctxCache.has(span)) return ctxCache.get(span)
    const body = span ? stripped.slice(span.start, span.end) : ''
    const aliases = aliasesIn(body, namesMetric)
    // `(?<![.\w:])` because an alias is a LOCAL BINDING and is never reached
    // through a `.` or a path. Without it a test that binds a closure named
    // `load` (live: `maintenance.rs`) made the alias match every `.load(` in
    // the function, so `assert_eq!(last_day.load(..), today)` read as an
    // assertion about the metric. Harmless while only literals were credited;
    // a false credit the moment anything else is.
    const aliasRe =
      aliases.size > 0 ? new RegExp(`(?<![.\\w:])(?:${[...aliases].join('|')})\\b`) : null
    const mentions = (text) => namesMetric(text) || (aliasRe ? aliasRe.test(text) : false)
    const witnesses = witnessesIn(body, mentions)
    const predicates = firingPredicatesIn(body, mentions)
    const ctx = {
      mentions,
      // A bare identifier only. `i64::from(actual)` is not credited: the
      // wrapper could be anything, and being narrow here costs a baseline
      // entry while being loose costs a rule.
      isWitness: (text) => witnesses.has(asIdent(text) ?? ''),
      isProvenPredicate: (text) => predicates.has(asIdent(text) ?? ''),
    }
    ctxCache.set(span, ctx)
    return ctx
  }

  ASSERT_RE.lastIndex = 0
  let m
  while ((m = ASSERT_RE.exec(stripped))) {
    if (!inAnyRegion(testRegions, m.index)) continue
    const open = m.index + m[0].length - 1
    const { args } = readCallArgs(stripped, open)
    const ctx = ctxFor(innermostSpan(spans, m.index))
    if (isFiringAssertion(m[1], args, ctx.mentions, ctx)) hits.push(m.index)
  }

  return hits.toSorted((a, b) => a - b)
}

// ─── tree walk ────────────────────────────────────────────────────────

/**
 * The directories the scan descends into, repo-relative, sorted:
 * `src-tauri/src` plus the `src` of EVERY sibling crate directory —
 * `agaric-core`, …, and `diagnostics`, which an `agaric-`-prefix filter
 * silently excluded even though it is a real workspace member that could
 * declare a counter tomorrow. `scripts/` is NOT among them, which is why this
 * guard cannot match its own source, its own fixtures or its own baseline.
 *
 * Exported so `--self-test` can assert the exact SET. Asserting the
 * consequence instead ("no scanned file lives outside src-tauri/") would be
 * vacuous: `scripts/` holds no `.rs`, so that assertion survives a change
 * that adds `scripts/` as a root. Found by mutating this function during
 * #3349 — it was the one mutant the self-test did not kill.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function scanRoots(root) {
  const roots = []
  const tauri = path.join(root, 'src-tauri')
  if (existsSync(path.join(tauri, 'src'))) roots.push(path.join(tauri, 'src'))
  if (existsSync(tauri)) {
    for (const entry of readdirSync(tauri, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
      const dir = path.join(tauri, entry.name)
      if (existsSync(path.join(dir, 'src'))) roots.push(path.join(dir, 'src'))
      // One level deeper, for a `crates/`-style container. #3349 scanned only
      // `src-tauri/<crate>/src`, so moving a counter-declaring crate under
      // `src-tauri/crates/` would have removed it from the surface with no
      // finding and no error (#3384 item 4) — a workspace reshuffle is a
      // plausible way to lose coverage, and one extra readdir buys it back.
      for (const nested of readdirSync(dir, { withFileTypes: true })) {
        if (!nested.isDirectory() || SKIP_DIRS.has(nested.name) || nested.name === 'src') continue
        const nestedSrc = path.join(dir, nested.name, 'src')
        if (existsSync(nestedSrc)) roots.push(nestedSrc)
      }
    }
  }
  // A root nested inside another would walk the same files twice, and two
  // copies of one metric collide on their id — a hard error that would read as
  // a repo problem rather than a guard problem.
  const sorted = [...new Set(roots)].toSorted()
  const kept = sorted.filter((r) => !sorted.some((o) => o !== r && r.startsWith(`${o}${path.sep}`)))
  return kept.map((r) => toPosix(path.relative(root, r)))
}

export function listScannedFiles(root) {
  const roots = scanRoots(root).map((r) => path.join(root, r))
  const out = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        visit(path.join(dir, entry.name))
      } else if (entry.isFile() && entry.name.endsWith('.rs')) {
        out.push(toPosix(path.relative(root, path.join(dir, entry.name))))
      }
    }
  }
  for (const r of roots) visit(r)
  return out.toSorted()
}

/** Does `[profile.release]` set `panic = "abort"`? */
export function releasePanicsAbort(cargoToml) {
  // `$(?![\s\S])` is the true end of input: plain `$` under `m` matches at
  // every line end, which would close the lazy section body immediately.
  const section = /^\[profile\.release\][^\n]*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(cargoToml)
  if (!section) return false
  return /^\s*panic\s*=\s*"abort"\s*$/m.test(section[1])
}

// ─── analysis ─────────────────────────────────────────────────────────

/**
 * Parse every scanned file once: comment/string-blanked source plus its
 * test-code regions (the whole file for a test path, otherwise each
 * `#[cfg(test)] mod … { … }` body).
 *
 * @param {string} root
 * @param {string[]} files
 */
function parseTree(root, files) {
  const parsed = new Map()
  for (const rel of files) {
    const raw = readFileSync(path.join(root, rel), 'utf8')
    const stripped = stripNoise(raw)
    const whole = isTestPath(rel)
    const testRegions = whole ? [{ start: 0, end: stripped.length }] : cfgTestRegions(stripped)
    parsed.set(rel, { raw, stripped, testRegions, whole })
  }
  return parsed
}

/**
 * The metric surface of the tree, in both registration patterns, sorted by
 * id. See the header comment for what does and does not count.
 *
 * @param {string[]} files
 * @param {Map<string, {raw: string, whole: boolean}>} parsed
 */
function enumerateMetrics(files, parsed) {
  const metrics = []
  const structHint = new RegExp(`\\bstruct\\s+[A-Za-z_]\\w*${METRIC_STRUCT_SUFFIX}\\b`)
  for (const rel of files) {
    const { raw, stripped, whole } = parsed.get(rel)
    if (whole) continue
    if (!structHint.test(stripped)) continue
    for (const f of enumerateStructMetrics(raw)) {
      metrics.push({
        name: f.name,
        line: f.line,
        exemptions: f.exemptions,
        id: `${f.struct}::${f.name}`,
        kind: 'struct-field',
        file: rel,
      })
    }
  }
  for (const rel of files) {
    const { raw, whole } = parsed.get(rel)
    if (whole) continue
    for (const g of enumerateGlobalMetrics(raw)) {
      metrics.push({
        ...g,
        id: `${path.posix.basename(rel, '.rs')}::${g.name}`,
        kind: 'global-static',
        file: rel,
      })
    }
  }
  return metrics.toSorted((a, b) => a.id.localeCompare(b.id))
}

/**
 * Escape a value before interpolating it into a `RegExp` source string.
 *
 * Metric names and module basenames are Rust identifiers, so in practice this
 * is a no-op — but they are derived from paths reachable via `--root`, i.e.
 * from argv, and an unescaped interpolation of argv-derived text into a regex
 * is a genuine injection shape regardless of what today's inputs happen to
 * look like. Escaping costs nothing and removes the class rather than relying
 * on an invariant nothing enforces.
 */
function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Patterns that name `metric` in source text. */
function metricTokens(metric) {
  const tokens = [new RegExp(`\\b${escapeForRegExp(metric.name)}\\b`)]
  if (metric.kind === 'global-static') {
    const modBase = escapeForRegExp(path.posix.basename(metric.file, '.rs'))
    tokens.push(new RegExp(`\\b${modBase}\\s*::\\s*(?:${GLOBAL_ACCESSORS.join('|')})\\b`))
  }
  return tokens
}

/**
 * Production files (outside the defining module) that call one of the
 * module's mutators. Used instead of "has an atomic write" for the
 * global-static pattern, where the mutator's own body always writes the
 * static and the write test would therefore be vacuous.
 *
 * @returns {string[]}
 */
function externalMutatorCallers(metric, files, parsed) {
  const modBase = path.posix.basename(metric.file, '.rs')
  const mutSrc = `\\b(?:${GLOBAL_MUTATORS.join('|')})\\w*\\s*\\(`
  const qualSrc = `\\b${escapeForRegExp(modBase)}\\s*::\\s*(?:${GLOBAL_MUTATORS.join('|')})\\w*\\s*\\(`
  const out = []
  for (const rel of files) {
    if (rel === metric.file) continue
    const { stripped, testRegions, whole } = parsed.get(rel)
    if (whole) continue
    if (!stripped.includes(modBase)) continue
    for (const source of [qualSrc, mutSrc]) {
      const re = new RegExp(source, 'g')
      let cm
      let credited = false
      while ((cm = re.exec(stripped))) {
        if (inAnyRegion(testRegions, cm.index)) continue
        credited = true
        break
      }
      if (credited) {
        out.push(rel)
        break
      }
    }
  }
  return out
}

/**
 * Production write sites and firing proofs for one metric, across the tree.
 *
 * @returns {{productionWrites: {file: string, index: number}[], firingTests: number, firingTestFiles: string[]}}
 */
function gatherEvidence(metric, files, parsed) {
  const tokens = metricTokens(metric)
  const writeRe = new RegExp(
    `\\b${escapeForRegExp(metric.name)}\\s*\\.\\s*(?:${WRITE_OPS})\\s*\\(`,
    'g',
  )
  const productionWrites = []
  const firingTestFiles = []
  let firingTests = 0

  for (const rel of files) {
    const { stripped, testRegions, whole } = parsed.get(rel)
    if (!tokens.some((t) => t.test(stripped))) continue // cheap pre-filter

    if (!whole) {
      writeRe.lastIndex = 0
      let wm
      while ((wm = writeRe.exec(stripped))) {
        if (!inAnyRegion(testRegions, wm.index))
          productionWrites.push({ file: rel, index: wm.index })
      }
    }

    // Inside its own module a global counter is observed as a bare
    // `count()` / `last()` call, with no module qualifier to match on.
    const localTokens =
      metric.kind === 'global-static' && rel === metric.file
        ? [...tokens, new RegExp(`\\b(?:${GLOBAL_ACCESSORS.join('|')})\\s*\\(\\s*\\)`)]
        : tokens
    const hits = findFiringAssertions(stripped, testRegions, localTokens)
    if (hits.length > 0) {
      firingTests += hits.length
      firingTestFiles.push(rel)
    }
  }
  return { productionWrites, firingTests, firingTestFiles }
}

/**
 * Enumerate every metric in the tree and decide, per rule, whether it is
 * provable. Pure over the filesystem; the self-test drives it against
 * synthetic trees.
 *
 * @param {{root: string}} opts
 */
export function analyze({ root }) {
  const files = listScannedFiles(root)
  const parsed = parseTree(root, files)
  const metrics = enumerateMetrics(files, parsed)

  const duplicates = []
  const seenIds = new Set()
  for (const m of metrics) {
    if (seenIds.has(m.id)) duplicates.push(m.id)
    seenIds.add(m.id)
  }

  const cargo = path.join(root, CARGO_TOML_REL)
  const panicAbort = existsSync(cargo) ? releasePanicsAbort(readFileSync(cargo, 'utf8')) : false

  const violations = []
  for (const metric of metrics) {
    const { productionWrites, firingTests, firingTestFiles } = gatherEvidence(metric, files, parsed)
    const externalCallers =
      metric.kind === 'global-static' ? externalMutatorCallers(metric, files, parsed) : []
    const hasEmit =
      metric.kind === 'struct-field' ? productionWrites.length > 0 : externalCallers.length > 0
    const siteOf = (w) => `${w.file}:${makeLineLookup(parsed.get(w.file).stripped)(w.index)}`

    metric.evidence = {
      firingTests,
      firingTestFiles: [...new Set(firingTestFiles)].toSorted(),
      productionWrites: productionWrites.map(siteOf),
      externalCallers: externalCallers.toSorted(),
    }

    const record = (rule, detail) => {
      const reason = metric.exemptions[rule]
      if (typeof reason === 'string' && reason.length > 0) return
      violations.push({ metric: metric.id, rule, file: metric.file, line: metric.line, detail })
    }

    if (firingTests === 0) {
      record(
        'no-firing-test',
        `no test asserts \`${metric.name}\` above zero (${
          metric.kind === 'struct-field' ? 'struct field' : 'global static'
        }) — a counter with only "is zero" assertions passes forever after its emit site is deleted`,
      )
    }
    if (!hasEmit) {
      record(
        'no-production-emit',
        metric.kind === 'struct-field'
          ? `no production code writes \`${metric.name}\` (no \`.fetch_add(\`/\`.store(\`/… outside test regions)`
          : `no production code outside \`${metric.file}\` calls the module's mutator, so nothing can move \`${metric.name}\``,
      )
    }
    if (panicAbort && hasEmit && metric.kind === 'struct-field') {
      const allPanicGated = productionWrites.every((w) =>
        enclosingBlockHeads(parsed.get(w.file).stripped, w.index).some(isPanicGateHead),
      )
      if (allPanicGated) {
        record(
          'unreachable-under-panic-abort',
          `every emit site (${productionWrites.map(siteOf).join(', ')}) is inside a panic-detection branch, but \`[profile.release]\` sets \`panic = "abort"\` — the unwind those branches require cannot happen in a release build, so this counter reads zero forever`,
        )
      }
    }
  }

  violations.sort((a, b) => a.metric.localeCompare(b.metric) || a.rule.localeCompare(b.rule))
  return { metrics, violations, files, panicAbort, duplicates }
}

// ─── baseline I/O ─────────────────────────────────────────────────────

function baselinePath(root) {
  return path.join(root, BASELINE_REL)
}

function readBaseline(root) {
  const file = baselinePath(root)
  if (!existsSync(file)) return []
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(raw)) throw new Error(`baseline file is not a JSON array: ${file}`)
  return raw
}

function writeBaseline(root, entries) {
  writeFileSync(baselinePath(root), `${JSON.stringify(entries, null, 2)}\n`)
}

/**
 * Structural + "must carry a reason" validation. Returns a list of
 * problems; a non-empty list is a hard error (exit 2), never a warning.
 *
 * @param {unknown[]} baseline
 * @returns {string[]}
 */
export function validateBaseline(baseline) {
  const problems = []
  const seen = new Set()
  for (const e of baseline) {
    const label = JSON.stringify(e)
    if (!e || typeof e.metric !== 'string' || typeof e.rule !== 'string') {
      problems.push(`malformed entry (needs string \`metric\` and \`rule\`): ${label}`)
      continue
    }
    if (!RULES.includes(e.rule)) problems.push(`unknown rule "${e.rule}" in entry: ${label}`)
    if (typeof e.reason !== 'string' || e.reason.trim().length === 0) {
      problems.push(
        `entry has no \`reason\` — a baselined metric MUST say why it cannot fire: ${label}`,
      )
    }
    const key = `${e.metric}|${e.rule}`
    if (seen.has(key)) problems.push(`duplicate baseline entry: ${key}`)
    seen.add(key)
  }
  return problems
}

// ─── entry point ──────────────────────────────────────────────────────

// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is the
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])

if (isMainModule) {
  const argv = process.argv.slice(2)
  const rootFlag = argv.indexOf('--root')
  const root = rootFlag >= 0 ? path.resolve(argv[rootFlag + 1] ?? '') : ROOT
  if (argv.includes('--self-test')) runSelfTest()
  else if (argv.includes('--update-baseline')) updateBaseline(root)
  else if (argv.includes('--list')) listMetrics(root)
  else runGuard(root)
}

/**
 * Print the enumerated metric surface with the evidence found for each —
 * which tests prove it can fire, and where it is emitted. Diagnostic only;
 * always exits 0.
 */
function listMetrics(root) {
  requireLayout(root)
  const { metrics } = analyze({ root })
  for (const m of metrics) {
    const e = m.evidence
    console.log(`${m.id}  (${m.kind})  ${m.file}:${m.line}`)
    console.log(
      `    firing proofs: ${e.firingTests}${
        e.firingTestFiles.length > 0 ? ` in ${e.firingTestFiles.join(', ')}` : ''
      }`,
    )
    console.log(
      `    emit: ${
        m.kind === 'struct-field'
          ? e.productionWrites.join(', ') || '(none)'
          : e.externalCallers.join(', ') || '(no external caller)'
      }`,
    )
  }
  console.log(`\n${metrics.length} metric(s).`)
}

/**
 * A sanity anchor, no longer a load-bearing part of enumeration: since #3384
 * the struct is found wherever it lives, so `metrics.rs` surviving as a
 * re-export shim is fine and deleting it entirely fails LOUDLY (exit 2) rather
 * than quietly reducing the metric surface to the global statics.
 */
function requireLayout(root) {
  const needed = [path.join(root, 'src-tauri', 'src'), path.join(root, METRICS_FILE_REL)]
  for (const p of needed) {
    if (!existsSync(p)) {
      console.error(`ERROR: expected path not found (repo layout changed?): ${p}`)
      process.exit(2)
    }
  }
}

function updateBaseline(root) {
  requireLayout(root)
  const previous = existsSync(baselinePath(root)) ? readBaseline(root) : []
  const reasons = new Map(previous.map((e) => [`${e.metric}|${e.rule}`, e.reason ?? '']))
  const { violations } = analyze({ root })
  const entries = violations
    .map((v) => ({
      metric: v.metric,
      rule: v.rule,
      reason: reasons.get(`${v.metric}|${v.rule}`) ?? '',
    }))
    .toSorted((a, b) => a.metric.localeCompare(b.metric) || a.rule.localeCompare(b.rule))
  writeBaseline(root, entries)
  console.log(`OK: wrote ${entries.length} baseline entr(ies) to ${BASELINE_REL}`)
  const missing = entries.filter((e) => e.reason.trim().length === 0)
  if (missing.length > 0) {
    console.log('')
    console.log(`${missing.length} entr(ies) have an EMPTY reason. The guard FAILS until each one`)
    console.log('states why the metric cannot fire (or the metric is deleted instead):')
    for (const e of missing) console.log(`  ${e.metric} [${e.rule}]`)
  }
}

function runGuard(root) {
  requireLayout(root)

  let baseline
  try {
    baseline = readBaseline(root)
  } catch (err) {
    console.error(`ERROR: could not read ${BASELINE_REL}: ${err.message}`)
    process.exit(2)
  }
  const problems = validateBaseline(baseline)
  if (problems.length > 0) {
    console.error(`ERROR: ${BASELINE_REL} is invalid:`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(2)
  }

  const { metrics, violations, duplicates, panicAbort } = analyze({ root })
  if (duplicates.length > 0) {
    console.error('ERROR: two metrics enumerate to the same id (baseline keys would collide):')
    for (const d of duplicates) console.error(`  ${d}`)
    process.exit(2)
  }

  const baselineKeys = new Set(baseline.map((e) => `${e.metric}|${e.rule}`))
  const liveKeys = new Set(violations.map((v) => `${v.metric}|${v.rule}`))

  const added = violations.filter((v) => !baselineKeys.has(`${v.metric}|${v.rule}`))
  const stale = baseline.filter((e) => !liveKeys.has(`${e.metric}|${e.rule}`))

  let failed = false

  if (added.length > 0) {
    failed = true
    console.error(`FAIL: ${added.length} metric/rule pair(s) with no proof the metric can fire:`)
    for (const v of added) console.error(`  ${v.metric}  [${v.rule}]\n      ${v.detail}`)
    console.error('')
    console.error('A metric that cannot move reads zero forever, and zero is indistinguishable')
    console.error('from health. Fix, in order of preference:')
    console.error('')
    console.error('  1. DELETE the metric if the event it counts cannot occur, and assert the')
    console.error('     impossibility in a test instead (that is the durable form of the claim).')
    console.error('  2. Add a test that drives the metric ABOVE ZERO through the production emit')
    console.error('     path — not a direct poke at the atomic, which proves only that atomics')
    console.error('     increment. Assertions that the metric is 0 do not count.')
    console.error('  3. If the metric is deliberately unfireable and that is documented, mark the')
    console.error('     declaration:')
    console.error('')
    console.error('       // metric-fire-exempt(<rule>): <why it cannot fire, and why that is ok>')
    console.error('')
    console.error(`  4. Grandfather it: \`--update-baseline\`, then fill in the \`reason\` field.`)
    console.error('     An empty reason is a hard error, not a warning.')
  }

  if (stale.length > 0) {
    failed = true
    console.error(`ERROR: ${stale.length} stale entr(ies) in ${BASELINE_REL} — these metrics are`)
    console.error('now provable (or gone), so the baseline must ratchet down to the new floor:')
    for (const e of stale) console.error(`  ${e.metric}  [${e.rule}]`)
    console.error('')
    console.error(`Re-run with \`--update-baseline\` and keep the remaining reasons.`)
  }

  if (failed) process.exit(1)

  console.log(
    `OK: ${metrics.length} metric(s) enumerated, ${baseline.length} baselined with reasons` +
      `${panicAbort ? ', release profile is panic=abort' : ''} (#3349).`,
  )
  process.exit(0)
}

// ─── self-test ────────────────────────────────────────────────────────

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }
  const expect = (name, cond, detail) => (cond ? ok(name) : fail(name, detail))

  // ─ 1. blanking ─
  {
    const src = [
      'fn f() {',
      '    // fg_panics in a line comment',
      '    /* nested /* block */ fg_panics */',
      '    let s = "fg_panics in a string";',
      '    let r = r#"fg_panics in a raw string"#;',
      "    let c = '\\'';",
      '    let life: &\'static str = "x";',
      '    real_fg_panics_token();',
      '}',
    ].join('\n')
    const out = stripNoise(src)
    expect(
      'comments, strings and raw strings are blanked',
      (out.match(/fg_panics/g) ?? []).length === 1,
      JSON.stringify(out),
    )
    expect('blanking preserves length', out.length === src.length, `${out.length} vs ${src.length}`)
    expect(
      'blanking preserves line count',
      out.split('\n').length === src.split('\n').length,
      'line count drifted',
    )
    expect(
      'a lifetime is not mistaken for a char literal',
      out.includes("&'static str"),
      JSON.stringify(out),
    )
  }

  // ─ 2. assertion classification ─
  {
    const mentions = (t) => /\bm\b|\bafter\b|\bbefore\b/.test(t)
    const cls = (macro, args) => isFiringAssertion(macro, args, mentions)
    expect('`assert_eq!(m, 1)` is a firing proof', cls('assert_eq', ['m.load()', '1']), 'not fired')
    expect(
      '`assert_eq!(m, 0)` is NOT a firing proof',
      !cls('assert_eq', ['m.load()', '0']),
      'wrongly fired',
    )
    expect(
      '`assert_eq!(m, 0, "…")` with a message is NOT a firing proof',
      !cls('assert_eq', ['m.load()', '0', '" "']),
      'wrongly fired',
    )
    expect('`assert_ne!(m, 0)` is a firing proof', cls('assert_ne', ['m.load()', '0']), 'not fired')
    expect(
      '`assert_eq!(m, before + 1)` is a firing proof',
      cls('assert_eq', ['m.load()', 'before + 1']),
      'not fired',
    )
    expect('`assert!(m > 0)` is a firing proof', cls('assert', ['m.load() > 0']), 'not fired')
    expect(
      '`assert!(after > before)` is a firing proof',
      cls('assert', ['after > before']),
      'not fired',
    )
    expect('`assert!(m >= 0)` is NOT a firing proof', !cls('assert', ['m.load() >= 0']), 'fired')
    expect('`assert!(m < 5)` is NOT a firing proof', !cls('assert', ['m.load() < 5']), 'fired')
    // The `==` arm of the bare-`assert!` path. Without these two, that arm
    // could be replaced by `return true` and every assertion in this file
    // still passed — the branch would be credited but unpinned.
    expect('`assert!(m == 0)` is NOT a firing proof', !cls('assert', ['m.load() == 0']), 'fired')
    expect('`assert!(m == 1)` is a firing proof', cls('assert', ['m.load() == 1']), 'not fired')
    // The bare-`assert!` path must still require that the expression NAME the
    // metric. Dropping that check reads `assert!(0 < unrelated())` as a proof
    // for EVERY metric in the tree, because the metric-on-the-right
    // normalisation then flips an unrelated `<` into a firing `>`.
    expect(
      '`assert!(0 < unrelated())` does not prove this metric',
      !cls('assert', ['0 < unrelated()']),
      'wrongly fired',
    )
    expect(
      '`assert!(0 < m)` is a firing proof (metric on the right)',
      cls('assert', ['0 < m.load()']),
      'not fired',
    )
    expect(
      '`assert_eq!(after, before)` ("must not bump") is NOT a firing proof',
      !cls('assert_eq', ['after', 'before']),
      'wrongly fired',
    )
    expect(
      'an assertion that never names the metric is not a proof',
      !cls('assert_eq', ['other', '1']),
      'fired',
    )

    // #3384 item 1, at unit level. `yes` says "everything is a ground truth /
    // a proven predicate", which is the loosest context the callers could ever
    // build — so anything still rejected here is rejected STRUCTURALLY, not by
    // luck of what `witnessesIn` happens to admit.
    const yes = { isWitness: () => true, isProvenPredicate: () => true }
    expect(
      '`assert_eq!(metric, actual)` is a firing proof when `actual` is a ground truth',
      isFiringAssertion('assert_eq', ['m.load()', 'actual'], mentions, yes),
      'not fired',
    )
    expect(
      '`assert_eq!(after, before)` stays rejected even under the loosest context',
      !isFiringAssertion('assert_eq', ['after', 'before'], mentions, yes),
      'wrongly fired — both operands derive from the metric',
    )
    expect(
      '`assert_ne!(metric, actual)` is not laundered by a ground truth',
      !isFiringAssertion('assert_ne', ['m.load()', 'actual'], mentions, yes),
      'wrongly fired',
    )
    // `rose` names the metric here (it is an alias of it), so each of these
    // turns ONLY on the predicate context, never on `mentions`.
    const withRose = (t) => /\brose\b/.test(t) || mentions(t)
    const roseCtx = { isProvenPredicate: (t) => t.trim() === 'rose' }
    expect(
      '`assert!(rose)` is a firing proof when `rose` binds a firing comparison',
      isFiringAssertion('assert', ['rose'], withRose, roseCtx),
      'not fired',
    )
    expect(
      '`assert!(!rose)` is NOT a firing proof',
      !isFiringAssertion('assert', ['!rose'], withRose, roseCtx),
      'wrongly fired',
    )
    expect(
      'the default context credits nothing extra (the #3349 behaviour is the floor)',
      !isFiringAssertion('assert_eq', ['m.load()', 'actual'], mentions) &&
        !isFiringAssertion('assert', ['rose'], withRose),
      'a default context credited a non-literal expectation',
    )
  }

  // ─ 3. block heads / panic detection ─
  {
    const src = 'fn f() {\n  if outcome.panicked {\n    m.fg_panics.fetch_add(1, R);\n  }\n}\n'
    const idx = src.indexOf('fetch_add')
    const heads = enclosingBlockHeads(src, idx)
    expect(
      'the enclosing `if …panicked` head is recovered',
      heads.some(isPanicGateHead),
      JSON.stringify(heads),
    )
    const clean = 'fn f() {\n  if outcome.failed {\n    m.fg_errors.fetch_add(1, R);\n  }\n}\n'
    expect(
      'an ordinary `if` head is not a panic branch',
      !enclosingBlockHeads(clean, clean.indexOf('fetch_add')).some(isPanicGateHead),
      'wrongly matched',
    )
    // #3384 item 3: gates spelled otherwise, and the negated gate that #3349
    // wrongly matched.
    for (const head of [
      'if is_panic_outcome(&o)',
      'if o.was_panic',
      'if outcome.panicked',
      'while panicking()',
      'Err(e) if e.is_panic() =>',
      'if let Some(_) = catch_unwind(f).err()',
    ]) {
      expect(`\`${head}\` reads as a panic gate`, isPanicGateHead(head), 'missed')
    }
    for (const head of [
      'if !o.was_panic',
      'if !outcome.panicked',
      'if !e.is_panic()',
      'if outcome.failed',
      'if queue.is_full()',
      'let panicked = e.is_panic();',
    ]) {
      expect(`\`${head}\` does NOT read as a panic gate`, !isPanicGateHead(head), 'wrongly matched')
    }
    // The PRICE of the widening, asserted rather than left to be discovered: a
    // gate whose name merely contains `panic` reads as panic detection. Rule 3
    // would then wrongly call the counter dead — loudly, in CI, with a named
    // rule a human can exempt with a reason. That is the direction this guard
    // errs in on purpose; the alternative (missing `if o.was_panic`) is silent.
    expect(
      '`if o.panic_free` is a KNOWN false positive of the widened gate match',
      isPanicGateHead('if o.panic_free && ready'),
      'behaviour changed — update the Known limits note',
    )
  }

  // ─ 4. profile parsing ─
  expect(
    '`panic = "abort"` under [profile.release] is detected',
    releasePanicsAbort('[profile.release]\nlto = "thin"\npanic = "abort"\n\n[other]\n'),
    'missed',
  )
  expect(
    '`panic = "abort"` under a DIFFERENT profile is not credited to release',
    !releasePanicsAbort('[profile.release]\nlto = "thin"\n\n[profile.bench]\npanic = "abort"\n'),
    'wrongly matched',
  )
  expect(
    '`panic = "abort"` in the LAST section (no trailing header) is still detected',
    releasePanicsAbort('[deps]\nx = 1\n\n[profile.release]\nlto = "thin"\npanic = "abort"\n'),
    'missed — a lazy section body closed at the first line end',
  )

  // ─ 5. test-path classification ─
  expect('`…/tests/foo.rs` is test code', isTestPath('src-tauri/src/materializer/tests/x.rs'), '')
  expect('`x_tests.rs` is test code', isTestPath('src-tauri/src/a/x_tests.rs'), '')
  expect('`x.rs` is production', !isTestPath('src-tauri/src/a/x.rs'), '')

  // ─ 6. end-to-end over synthetic trees, via the real CLI ─
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'metric-provable-selftest-'))
  try {
    runFixtureSelfTest(tmp, expect)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  // ─ 7. the live tree ─
  const live = analyze({ root: ROOT })
  const roots = scanRoots(ROOT)
  expect(
    'the scan roots are exactly the crate sources under src-tauri/ (no scripts/)',
    roots.length > 1 &&
      roots.every((r) => r === 'src-tauri/src' || /^src-tauri\/[^/]+(?:\/[^/]+)?\/src$/.test(r)),
    JSON.stringify(roots),
  )
  // The SCOPE ratchet. `live.metrics.length >= 25` against a live surface of
  // 33 was itself a check that could not fail: adding `handlers` to
  // SKIP_DIRS dropped a whole directory of counters (33 → 32) and every
  // assertion still passed. Pinning the metric-DECLARING files instead is
  // sensitive to any narrowing of the walk, the scan roots or the two
  // enumeration regexes, while surviving the field-level churn the baseline
  // already tracks — deleting `fg_panics` (which #3349 asks for) does not
  // touch this set.
  const METRIC_FILES = Object.freeze([
    'src-tauri/agaric-engine/src/apply/sql_only_fallback.rs',
    'src-tauri/agaric-engine/src/loro/engine/cycle_rejected_metrics.rs',
    'src-tauri/agaric-engine/src/merge/divergence.rs',
    'src-tauri/agaric-sync/src/sync_protocol/snapshot_fallback_metrics.rs',
    'src-tauri/src/materializer/handlers/descendant_fanout_dropped.rs',
    'src-tauri/src/materializer/metrics.rs',
  ])
  const liveFiles = [...new Set(live.metrics.map((m) => m.file))].toSorted()
  expect(
    'the live scan still reaches every metric-declaring file',
    JSON.stringify(liveFiles) === JSON.stringify([...METRIC_FILES]),
    `expected ${JSON.stringify(METRIC_FILES)}, got ${JSON.stringify(liveFiles)}`,
  )
  expect(
    'the live scan covers the metric surface',
    live.metrics.length >= 25,
    `only ${live.metrics.length} metric(s) enumerated`,
  )
  expect(
    'the live scan reads nothing outside src-tauri/ (so it cannot match its own source)',
    live.files.every((f) => f.startsWith('src-tauri/')),
    JSON.stringify(live.files.filter((f) => !f.startsWith('src-tauri/')).slice(0, 5)),
  )
  // The walk's extension filter, pinned separately from the root set: it is
  // the second half of "the guard cannot read its own source", and every
  // assertion here stayed green when the filter was dropped.
  expect(
    'the live scan reads only Rust sources',
    live.files.every((f) => f.endsWith('.rs')),
    JSON.stringify(live.files.filter((f) => !f.endsWith('.rs')).slice(0, 5)),
  )
  // Stated over the scan ROOTS, not over `live.files`. The obvious form —
  // `!live.files.some((f) => f.endsWith('check-metric-provable.mjs'))` —
  // cannot fail: the walk only ever yields `.rs` paths, so no element can end
  // in `.mjs` whatever the roots are, and adding `scripts/` as a root left it
  // green. Asking whether this file lies UNDER a scan root is sensitive to the
  // roots alone, which is the thing being claimed.
  const selfRel = toPosix(path.relative(ROOT, import.meta.filename))
  expect(
    'this guard script is not itself scanned',
    !live.files.includes(selfRel) &&
      !roots.some((r) => selfRel === r || selfRel.startsWith(`${r}/`)),
    `${selfRel} lies under a scan root`,
  )
  expect(
    'the guard source does not enumerate as a metric (no self-match)',
    enumerateStructMetrics(readFileSync(import.meta.filename, 'utf8')).length === 0 &&
      enumerateGlobalMetrics(readFileSync(import.meta.filename, 'utf8')).length === 0,
    'the guard matched itself',
  )
  expect(
    'the live release profile really is panic=abort (rule 3 is armed)',
    live.panicAbort,
    'panic=abort not detected; rule 3 would be inert',
  )
  expect(
    'no two live metrics share an id',
    live.duplicates.length === 0,
    JSON.stringify(live.duplicates),
  )

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

/**
 * Build synthetic repos in `tmp` and run THIS script against them as a real
 * subprocess, asserting the actual exit code. The assertions above drive
 * the pure helpers and never reach `process.exit(1)`, so a regression that
 * dropped the non-zero exit — defanging the gate entirely — would sail
 * through them.
 */
function runFixtureSelfTest(tmp, expect) {
  let n = 0
  const build = ({ metricsFile, extra = {}, cargo, baseline }) => {
    const root = path.join(tmp, `fx${(n += 1)}`)
    mkdirSync(path.join(root, 'src-tauri', 'src', 'materializer'), { recursive: true })
    mkdirSync(path.join(root, 'scripts'), { recursive: true })
    writeFileSync(path.join(root, METRICS_FILE_REL), metricsFile)
    writeFileSync(
      path.join(root, CARGO_TOML_REL),
      cargo ?? '[profile.release]\nlto = "thin"\npanic = "abort"\n',
    )
    for (const [rel, body] of Object.entries(extra)) {
      const full = path.join(root, rel)
      mkdirSync(path.dirname(full), { recursive: true })
      writeFileSync(full, body)
    }
    if (baseline !== undefined) {
      writeFileSync(path.join(root, BASELINE_REL), `${JSON.stringify(baseline, null, 2)}\n`)
    }
    return root
  }
  const run = (root) =>
    spawnSync(process.execPath, [import.meta.filename, '--root', root], { encoding: 'utf8' })

  const header =
    'use std::sync::atomic::AtomicU64;\n\n#[derive(Debug)]\npub struct QueueMetrics {\n'

  // ── a fully provable metric: production emit + a firing test ──
  const goodMetrics = `${header}    pub good: AtomicU64,\n}\n`
  const goodProd = [
    'pub fn bump(m: &QueueMetrics) {',
    '    m.good.fetch_add(1, Ordering::Relaxed);',
    '}',
  ].join('\n')
  const goodTest = [
    '#[test]',
    'fn good_rises() {',
    '    let m = QueueMetrics::default();',
    '    bump(&m);',
    '    assert_eq!(m.good.load(Ordering::Relaxed), 1, "good must rise");',
    '}',
  ].join('\n')

  let root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
    },
    baseline: [],
  })
  let res = run(root)
  expect(
    'CLI exits 0 when every metric has a production emit and a firing test',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // ── rule 1: only "is zero" assertions ──
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': [
        '#[test]',
        'fn good_starts_at_zero() {',
        '    let m = QueueMetrics::default();',
        '    assert_eq!(m.good.load(Ordering::Relaxed), 0, "good should start at zero");',
        '}',
      ].join('\n'),
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'CLI exits 1 on a metric whose only test asserts it is zero [no-firing-test]',
    res.status === 1 && res.stderr.includes('no-firing-test'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── rule 1: a before/after "must not bump" pair is not a proof ──
  //    The live shape of `fg_full_waits` / `bg_full_waits`: the metric is
  //    read twice and asserted UNCHANGED. Nothing here can distinguish a
  //    working counter from a deleted emit site.
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': [
        '#[test]',
        'fn good_does_not_bump_on_the_happy_path() {',
        '    let m = QueueMetrics::default();',
        '    let before = m.good.load(Ordering::Relaxed);',
        '    happy_path(&m);',
        '    let after = m.good.load(Ordering::Relaxed);',
        '    assert_eq!(after, before, "good must not bump here");',
        '}',
      ].join('\n'),
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'a before/after "must not bump" assertion is NOT a firing proof',
    res.status === 1 && res.stderr.includes('no-firing-test'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── rule 1: an assertion MESSAGE naming the metric cannot launder a proof ──
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': [
        '#[test]',
        'fn unrelated() {',
        '    assert_eq!(other_thing(), 1, "good must still be observable");',
        '}',
      ].join('\n'),
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'a non-zero assertion that only NAMES the metric in its message is not a proof',
    res.status === 1 && res.stderr.includes('no-firing-test'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── rule 1: the ONLY proof is alias-based (`assert!(after > before)`) ──
  //    Neither operand names the metric; the credit comes entirely from
  //    following the two local bindings back to their initialisers.
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': [
        '#[test]',
        'fn good_rises() {',
        '    let m = QueueMetrics::default();',
        '    let before = m.good.load(Ordering::Relaxed);',
        '    bump(&m);',
        '    let after = m.good.load(Ordering::Relaxed);',
        '    assert!(after > before, "the counter must advance");',
        '}',
      ].join('\n'),
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'an alias-only proof (`assert!(after > before)`) is credited',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // ── an alias from a DIFFERENT fn must not vouch for this one ──
  //    The reused name is on the HIGH side of the unrelated assertion, so a
  //    whole-file alias scope would credit it.
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': [
        '#[test]',
        'fn reads_the_metric_without_asserting() {',
        '    let m = QueueMetrics::default();',
        '    let seen = m.good.load(Ordering::Relaxed);',
        '    drop(seen);',
        '}',
        '',
        '#[test]',
        'fn unrelated_subsystem() {',
        '    let seen = other_subsystem_total();',
        '    assert!(seen > 0, "unrelated to the metric");',
        '}',
      ].join('\n'),
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'an alias bound in another `fn` does not vouch for this assertion',
    res.status === 1 && res.stderr.includes('no-firing-test'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── only QueueMetrics is the metric struct ──
  //    The decoy struct is declared FIRST so a loosened struct pattern
  //    latches onto it instead of QueueMetrics.
  root = build({
    metricsFile: [
      'use std::sync::atomic::AtomicU64;',
      '',
      'pub struct SomethingElse {',
      '    pub not_a_metric: AtomicU64,',
      '}',
      '',
      '#[derive(Debug)]',
      'pub struct QueueMetrics {',
      '    pub good: AtomicU64,',
      '}',
    ].join('\n'),
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'an atomic field of a struct other than QueueMetrics is not a metric',
    res.status === 0 && res.stdout.includes('1 metric(s)'),
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // ── rule 3 needs EVERY emit gated, not just one ──
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': [
        'pub fn on_panic(m: &QueueMetrics, outcome: Outcome) {',
        '    if outcome.panicked {',
        '        m.good.fetch_add(1, Ordering::Relaxed);',
        '    }',
        '}',
        '',
        'pub fn on_success(m: &QueueMetrics) {',
        '    m.good.fetch_add(1, Ordering::Relaxed);',
        '}',
      ].join('\n'),
      'src-tauri/src/materializer/tests/mod.rs': [
        '#[test]',
        'fn good_rises() {',
        '    let m = QueueMetrics::default();',
        '    on_success(&m);',
        '    assert_eq!(m.good.load(Ordering::Relaxed), 1);',
        '}',
      ].join('\n'),
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'a metric with one panic-gated AND one reachable emit is not unreachable',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // ── a duplicate (metric, rule) baseline key is a hard error ──
  root = build({
    metricsFile: goodMetrics,
    extra: { 'src-tauri/src/materializer/consumer.rs': goodProd },
    baseline: [
      { metric: 'QueueMetrics::good', rule: 'no-firing-test', reason: 'first' },
      { metric: 'QueueMetrics::good', rule: 'no-firing-test', reason: 'second, contradictory' },
    ],
  })
  res = run(root)
  expect(
    'a duplicate (metric, rule) baseline entry is a HARD error (exit 2)',
    res.status === 2 && res.stderr.includes('duplicate'),
    `status=${res.status} err=${res.stderr}`,
  )

  runProofAndEnumerationSelfTest({ build, run, expect, header, goodMetrics, goodProd, goodTest })
  runLimitClosureSelfTest({ build, run, expect, goodMetrics, goodProd, goodTest })

  // ── a config atomic with the same declaration shape but no `count()` is NOT a metric ──
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
      'src-tauri/src/materializer/sampling.rs': [
        'use std::sync::atomic::{AtomicU64, Ordering};',
        'static SAMPLING_RATIO_BITS: AtomicU64 = AtomicU64::new(0);',
        'pub fn ratio() -> f64 {',
        '    f64::from_bits(SAMPLING_RATIO_BITS.load(Ordering::Relaxed))',
        '}',
      ].join('\n'),
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'a process-global config atomic with no `count()` is not enumerated as a metric',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // ── a metric-shaped decoy OUTSIDE the scanned crates is invisible ──
  //    Behavioural companion to the `scanRoots` assertion: if `scripts/` (or
  //    the repo root) ever became a scan root, this guard would start
  //    enumerating its own fixtures and baseline as metrics.
  const decoy = [
    'use std::sync::atomic::{AtomicU64, Ordering};',
    'static DECOY_COUNT: AtomicU64 = AtomicU64::new(0);',
    'pub fn count() -> u64 { DECOY_COUNT.load(Ordering::Relaxed) }',
    'pub struct QueueMetrics {',
    '    pub decoy_field: AtomicU64,',
    '}',
  ].join('\n')
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
      'scripts/decoy.rs': decoy,
      'decoy.rs': decoy,
      'e2e/decoy.rs': decoy,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'a metric-shaped file in scripts/, the repo root or e2e/ is not scanned',
    res.status === 0 && res.stdout.includes('1 metric(s)'),
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // ── layout guard ──
  root = path.join(tmp, 'empty')
  mkdirSync(root, { recursive: true })
  res = run(root)
  expect(
    'CLI exits 2 when the repo layout is missing',
    res.status === 2,
    `status=${res.status} err=${res.stderr}`,
  )
}

/**
 * Fixture cases added by the #3349 adversarial review: what does and does
 * NOT count as a firing proof, the declaration variants the enumerator must
 * not miss, id collisions, and the inline `#[cfg(test)] mod` shapes. Split
 * out of `runFixtureSelfTest` only to keep either function readable.
 *
 * @param {{build: Function, run: Function, expect: Function, header: string, goodMetrics: string, goodProd: string, goodTest: string}} ctx
 */
function runProofAndEnumerationSelfTest(ctx) {
  const { build, run, expect, header, goodMetrics, goodProd, goodTest } = ctx
  let root
  let res
  /** A run that failed with exit 1 and named every one of `needles`. */
  const failsNaming = (r, ...needles) =>
    r.status === 1 && needles.every((n) => r.stderr.includes(n))
  // ── rule 1: a bound firing comparison is NOT a proof, however it is read ──
  // Crediting `let rose = metric > before;` because `rose` is referenced
  // later was tried and reverted: the three shapes below are all "bound and
  // later read" and none of them can fail. See `findFiringAssertions`.
  for (const [label, tail] of [
    ['merely logged', ['    tracing::debug!(rose, "observed");']],
    ['read by a no-op `if`', ['    if rose {', '        println!("nice");', '    }']],
    ['rebound to another name', ['    let _also = rose;']],
    ['never read at all (dead store)', []],
  ]) {
    root = build({
      metricsFile: goodMetrics,
      extra: {
        'src-tauri/src/materializer/consumer.rs': goodProd,
        'src-tauri/src/materializer/tests/mod.rs': [
          '#[test]',
          'fn good_rises_eventually() {',
          '    let m = QueueMetrics::default();',
          '    let before = m.good.load(Ordering::Relaxed);',
          '    bump(&m);',
          '    let rose = m.good.load(Ordering::Relaxed) > before;',
          ...tail,
          '}',
        ].join('\n'),
      },
      baseline: [],
    })
    res = run(root)
    expect(
      `a bound firing comparison ${label} is NOT a proof`,
      res.status === 1 && res.stderr.includes('no-firing-test'),
      `status=${res.status} err=${res.stderr}`,
    )
  }

  // ── rule 1: an assertion in PRODUCTION code is not a firing test ──
  // `findFiringAssertions` scans every file, not only test files, and the one
  // thing keeping a production `assert!` out of the evidence is its
  // test-region check. A file with an inline `#[cfg(test)] mod` has non-empty
  // test regions, so the early return does not cover it: drop the check and
  // the `debug_assert!` below — which cannot fail, it restates the line above
  // it — is credited as the proof that the counter fires. That is exactly the
  // defect this guard exists to find, so it is pinned here rather than left
  // to the reader of `findFiringAssertions`.
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': [
        'pub fn bump(m: &QueueMetrics) {',
        '    m.good.fetch_add(1, Ordering::Relaxed);',
        '    debug_assert!(m.good.load(Ordering::Relaxed) > 0, "counter must be positive");',
        '}',
        '',
        '#[cfg(test)]',
        'mod tests {',
        '    use super::*;',
        '    #[test]',
        '    fn starts_at_zero() {',
        '        let m = QueueMetrics::default();',
        '        assert_eq!(m.good.load(Ordering::Relaxed), 0);',
        '    }',
        '}',
      ].join('\n'),
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'an `assert!` in PRODUCTION code is not a firing test',
    failsNaming(res, 'no-firing-test'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── enumeration: the syntactic variants Rust allows on one declaration ──
  // Visibility, the trailing comma and the type's path qualifier are all
  // optional in Rust. Requiring any of them turned a legal counter into a
  // silent MISS — no rule can flag a metric the enumerator never saw.
  for (const [label, decl] of [
    ['`pub(crate)` visibility', '    pub(crate) sneaky: AtomicU64,'],
    ['no visibility at all', '    sneaky: AtomicU64,'],
    ['no trailing comma (last field)', '    pub sneaky: AtomicU64'],
    ['a path-qualified type', '    pub sneaky: std::sync::atomic::AtomicU64,'],
    ['a non-U64 atomic (AtomicUsize)', '    pub sneaky: AtomicUsize,'],
    ['a non-U64 atomic (AtomicI64)', '    pub sneaky: AtomicI64,'],
  ]) {
    root = build({
      metricsFile: `use std::sync::atomic::AtomicU64;\n\npub struct QueueMetrics {\n${decl}\n}\n`,
      extra: { 'src-tauri/src/materializer/consumer.rs': goodProd },
      baseline: [],
    })
    res = run(root)
    expect(
      `a counter declared with ${label} is still enumerated`,
      res.status === 1 && res.stderr.includes('QueueMetrics::sneaky'),
      `status=${res.status} err=${res.stderr}`,
    )
  }

  // ── two metrics that collide on one id is a HARD error ──
  // Baseline keys are `metric|rule`, so a collision lets ONE reasoned entry
  // silently exempt TWO counters. Two modules with the same basename in
  // different crates is all it takes.
  const collide = [
    'use std::sync::atomic::{AtomicU64, Ordering};',
    'static SHARED_COUNT: AtomicU64 = AtomicU64::new(0);',
    'pub fn record() { SHARED_COUNT.fetch_add(1, Ordering::Relaxed); }',
    'pub fn count() -> u64 { SHARED_COUNT.load(Ordering::Relaxed) }',
  ].join('\n')
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
      'src-tauri/src/materializer/shared_metrics.rs': collide,
      'src-tauri/agaric-engine/src/shared_metrics.rs': collide,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'two metrics enumerating to the same id is a HARD error (exit 2)',
    res.status === 2 && res.stderr.includes('shared_metrics::SHARED_COUNT'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── rule 2: a write inside a `#[cfg(test)] mod` of a PRODUCTION file ──
  // The `tests/` path check alone does not cover this: the repo declares most
  // unit tests as an inline `#[cfg(test)] mod` next to the code they test, so
  // this is the shape that actually decides whether rule 2 can fire.
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': [
        '#[cfg(test)]',
        'mod tests {',
        '    use super::*;',
        '    #[test]',
        '    fn t() {',
        '        let m = QueueMetrics::default();',
        '        m.good.fetch_add(1, Ordering::Relaxed);',
        '        assert!(m.good.load(Ordering::Relaxed) > 0);',
        '    }',
        '}',
      ].join('\n'),
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'an inline `#[cfg(test)] mod` write is not a production emit',
    res.status === 1 && res.stderr.includes('no-production-emit'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── …and a `#[cfg(any(test, feature = "test-util"))]` mod is test code too ──
  // The live tree declares its call spies this way (`projection::CALLS`).
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': [
        '#[cfg(any(test, feature = "test-util"))]',
        'pub mod spy {',
        '    use super::*;',
        '    pub fn poke(m: &QueueMetrics) {',
        '        m.good.fetch_add(1, Ordering::Relaxed);',
        '    }',
        '}',
      ].join('\n'),
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'a `#[cfg(any(test, …))]` module is test code, not a production emit',
    res.status === 1 && res.stderr.includes('no-production-emit'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── …but `#[cfg(not(test))]` is production ──
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': [
        '#[cfg(not(test))]',
        'pub fn bump(m: &QueueMetrics) {',
        '    m.good.fetch_add(1, Ordering::Relaxed);',
        '}',
      ].join('\n'),
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    '`#[cfg(not(test))]` code is a production emit, not test code',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // ── `assert!(m != 5)` does not prove the metric can exceed zero ──
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': [
        '#[test]',
        'fn t() {',
        '    let m = QueueMetrics::default();',
        '    assert!(m.good.load(Ordering::Relaxed) != 5);',
        '}',
      ].join('\n'),
    },
    baseline: [],
  })
  res = run(root)
  expect(
    '`assert!(m != 5)` is NOT a firing proof (only `!= 0` is)',
    res.status === 1 && res.stderr.includes('no-firing-test'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── a bare `count()` proof only counts inside the DEFINING module ──
  // `count()` is unqualified, so crediting it from any file would let one
  // module's firing test vouch for another module's counter.
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': `${goodProd}\npub fn oops() {\n    thing_metrics::record();\n}\n`,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
      'src-tauri/src/materializer/thing_metrics.rs': [
        'use std::sync::atomic::{AtomicU64, Ordering};',
        '',
        'static THING_COUNT: AtomicU64 = AtomicU64::new(0);',
        '',
        'pub fn record() {',
        '    THING_COUNT.fetch_add(1, Ordering::Relaxed);',
        '}',
        '',
        'pub fn count() -> u64 {',
        '    THING_COUNT.load(Ordering::Relaxed)',
        '}',
      ].join('\n'),
      // Names `thing_metrics::count` (so it passes the pre-filter) but the
      // above-zero assertion is on an unrelated `count()`.
      'src-tauri/src/materializer/tests/elsewhere.rs': [
        '#[test]',
        'fn unrelated() {',
        '    let _ = thing_metrics::count;',
        '    assert!(count() > 0);',
        '}',
      ].join('\n'),
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'a bare `count()` assertion in another module does not prove this counter',
    res.status === 1 && res.stderr.includes('thing_metrics::THING_COUNT'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── rule 2: no production emit (only a test pokes the atomic) ──
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/tests/mod.rs': [
        '#[test]',
        'fn good_rises() {',
        '    let m = QueueMetrics::default();',
        '    m.good.fetch_add(1, Ordering::Relaxed);',
        '    assert_eq!(m.good.load(Ordering::Relaxed), 1);',
        '}',
      ].join('\n'),
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'CLI exits 1 when only a test writes the metric [no-production-emit]',
    res.status === 1 && res.stderr.includes('no-production-emit'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── rule 3: panic-gated emit under panic=abort ──
  const panicProd = [
    'pub fn drive(m: &QueueMetrics, outcome: Outcome) {',
    '    if outcome.panicked {',
    '        m.good.fetch_add(1, Ordering::Relaxed);',
    '    }',
    '}',
  ].join('\n')
  const panicTest = [
    '#[test]',
    'fn good_rises() {',
    '    let m = QueueMetrics::default();',
    '    drive(&m, Outcome { panicked: true });',
    '    assert_eq!(m.good.load(Ordering::Relaxed), 1);',
    '}',
  ].join('\n')
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': panicProd,
      'src-tauri/src/materializer/tests/mod.rs': panicTest,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'CLI exits 1 on a panic-gated emit while the release profile aborts [unreachable-under-panic-abort]',
    res.status === 1 && res.stderr.includes('unreachable-under-panic-abort'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── rule 3 is a property of the PROFILE, not the counter ──
  root = build({
    metricsFile: goodMetrics,
    cargo: '[profile.release]\nlto = "thin"\npanic = "unwind"\n',
    extra: {
      'src-tauri/src/materializer/consumer.rs': panicProd,
      'src-tauri/src/materializer/tests/mod.rs': panicTest,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'the same panic-gated emit PASSES once the release profile unwinds',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // ── marker exemption ──
  root = build({
    metricsFile: [
      'use std::sync::atomic::AtomicU64;',
      '',
      '#[derive(Debug)]',
      'pub struct QueueMetrics {',
      '    /// Docs above the marker must not hide it.',
      '    // metric-fire-exempt(no-firing-test): impossible by design; asserted impossible in x_test',
      '    pub good: AtomicU64,',
      '}',
    ].join('\n'),
    extra: { 'src-tauri/src/materializer/consumer.rs': goodProd },
    baseline: [],
  })
  res = run(root)
  expect(
    'a reasoned `metric-fire-exempt` marker below the doc block suppresses its rule',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // ── marker with an EMPTY reason suppresses nothing ──
  root = build({
    metricsFile: [
      'use std::sync::atomic::AtomicU64;',
      '',
      'pub struct QueueMetrics {',
      '    // metric-fire-exempt(no-firing-test):',
      '    pub good: AtomicU64,',
      '}',
    ].join('\n'),
    extra: { 'src-tauri/src/materializer/consumer.rs': goodProd },
    baseline: [],
  })
  res = run(root)
  expect(
    'a `metric-fire-exempt` marker with an empty reason does NOT suppress',
    res.status === 1 && res.stderr.includes('no-firing-test'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── marker is rule-scoped ──
  root = build({
    metricsFile: [
      'use std::sync::atomic::AtomicU64;',
      '',
      'pub struct QueueMetrics {',
      '    // metric-fire-exempt(no-production-emit): wrong rule for this violation',
      '    pub good: AtomicU64,',
      '}',
    ].join('\n'),
    extra: { 'src-tauri/src/materializer/consumer.rs': goodProd },
    baseline: [],
  })
  res = run(root)
  expect(
    'a marker for a DIFFERENT rule does not suppress this one',
    res.status === 1 && res.stderr.includes('no-firing-test'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── baseline: reasoned entry passes, empty reason is a hard error ──
  const bareTree = {
    metricsFile: goodMetrics,
    extra: { 'src-tauri/src/materializer/consumer.rs': goodProd },
  }
  root = build({
    ...bareTree,
    baseline: [{ metric: 'QueueMetrics::good', rule: 'no-firing-test', reason: 'tracked in #1' }],
  })
  res = run(root)
  expect(
    'a baselined violation with a reason passes',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  root = build({
    ...bareTree,
    baseline: [{ metric: 'QueueMetrics::good', rule: 'no-firing-test', reason: '   ' }],
  })
  res = run(root)
  expect(
    'a baseline entry with a blank reason is a HARD error (exit 2)',
    res.status === 2 && res.stderr.includes('reason'),
    `status=${res.status} err=${res.stderr}`,
  )

  root = build({
    ...bareTree,
    baseline: [{ metric: 'QueueMetrics::good', rule: 'no-such-rule', reason: 'x' }],
  })
  res = run(root)
  expect(
    'an unknown rule name in the baseline is a HARD error (exit 2)',
    res.status === 2 && res.stderr.includes('unknown rule'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── baseline ratchets: a stale entry fails ──
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
    },
    baseline: [{ metric: 'QueueMetrics::good', rule: 'no-firing-test', reason: 'stale' }],
  })
  res = run(root)
  expect(
    'a stale baseline entry FAILS (the ratchet only moves down)',
    res.status === 1 && res.stderr.includes('stale'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── a NEW counter with no firing test fails even when its siblings pass ──
  root = build({
    metricsFile: `${header}    pub good: AtomicU64,\n    pub freshly_added: AtomicU64,\n}\n`,
    extra: {
      'src-tauri/src/materializer/consumer.rs': `${goodProd}\npub fn bump2(m: &QueueMetrics) {\n    m.freshly_added.fetch_add(1, Ordering::Relaxed);\n}\n`,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'a newly-added counter with no firing test fails (#3349 acceptance criterion)',
    res.status === 1 &&
      res.stderr.includes('QueueMetrics::freshly_added') &&
      !res.stderr.includes('QueueMetrics::good  ['),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── global-static pattern ──
  const globalMod = [
    'use std::sync::atomic::{AtomicU64, Ordering};',
    '',
    'static THING_COUNT: AtomicU64 = AtomicU64::new(0);',
    '',
    'pub fn record() {',
    '    THING_COUNT.fetch_add(1, Ordering::Relaxed);',
    '}',
    '',
    'pub fn count() -> u64 {',
    '    THING_COUNT.load(Ordering::Relaxed)',
    '}',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    use super::*;',
    '    #[test]',
    '    fn record_increments_count() {',
    '        let before = count();',
    '        record();',
    '        assert!(count() > before);',
    '    }',
    '}',
  ].join('\n')
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
      'src-tauri/src/materializer/thing_metrics.rs': globalMod,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'a global static with a firing test but NO production caller fails [no-production-emit]',
    res.status === 1 &&
      res.stderr.includes('thing_metrics::THING_COUNT') &&
      res.stderr.includes('no-production-emit') &&
      !res.stderr.includes('thing_metrics::THING_COUNT  [no-firing-test]'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── the module's OWN file is never its own external caller ──
  // Rule 2's global-static half is "someone OUTSIDE the module calls the
  // mutator", precisely because the mutator's own body always writes the
  // static and crediting that would make the rule vacuous. The fixture above
  // does not pin that clause: `thing_metrics.rs` never contains the string
  // `thing_metrics`, so the `stripped.includes(modBase)` pre-filter rejects
  // it before the same-file check is reached, and dropping the same-file
  // check left every assertion in this file green. Here the module basename
  // DOES occur in its own body (`record.rs` declares `pub fn record()`), so
  // the same-file check is the only thing standing between this fixture and a
  // vacuous pass.
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
      'src-tauri/src/materializer/record.rs': globalMod,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    "a module's own mutator definition is not a production CALLER of it",
    failsNaming(res, 'record::THING_COUNT', 'no-production-emit'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── a caller that only exists inside a `#[cfg(test)]` block is not one ──
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': [
        goodProd,
        '',
        '#[cfg(test)]',
        'mod tests {',
        '    use super::*;',
        '    #[test]',
        '    fn drives_thing_metrics() {',
        '        thing_metrics::record();',
        '    }',
        '}',
      ].join('\n'),
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
      'src-tauri/src/materializer/thing_metrics.rs': globalMod,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'a mutator call inside a `#[cfg(test)]` block is not a production emit',
    res.status === 1 && res.stderr.includes('no-production-emit'),
    `status=${res.status} err=${res.stderr}`,
  )

  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': `${goodProd}\npub fn oops() {\n    thing_metrics::record();\n}\n`,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
      'src-tauri/src/materializer/thing_metrics.rs': globalMod,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'the same global static passes once production calls its mutator',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // ── a `note_*` mutator counts as a production emit, not just `record*` ──
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': `${goodProd}\npub fn oops() {\n    noted_metrics::note_dropped();\n}\n`,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
      'src-tauri/src/materializer/noted_metrics.rs': [
        'use std::sync::atomic::{AtomicU64, Ordering};',
        '',
        'static NOTED_COUNT: AtomicU64 = AtomicU64::new(0);',
        '',
        'pub fn note_dropped() {',
        '    NOTED_COUNT.fetch_add(1, Ordering::Relaxed);',
        '}',
        '',
        'pub fn count() -> u64 {',
        '    NOTED_COUNT.load(Ordering::Relaxed)',
        '}',
        '',
        '#[cfg(test)]',
        'mod tests {',
        '    use super::*;',
        '    #[test]',
        '    fn note_increments_count() {',
        '        let before = count();',
        '        note_dropped();',
        '        assert!(count() > before);',
        '    }',
        '}',
      ].join('\n'),
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'a `note_*` mutator call is a production emit (not only `record*`)',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // ── a global static declared inside a `mod` block is still enumerated ──
  // The old column-0 anchor excluded the live `#[cfg(any(test, …))]` spies by
  // accident; `cfgTestRegions` now excludes them on purpose, so indentation
  // must no longer hide a real counter.
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
      'src-tauri/src/materializer/nested_metrics.rs': [
        'use std::sync::atomic::{AtomicU64, Ordering};',
        'pub mod inner {',
        '    use std::sync::atomic::AtomicU64;',
        '    pub static NESTED_COUNT: AtomicU64 = AtomicU64::new(0);',
        '}',
        'pub fn count() -> u64 {',
        '    inner::NESTED_COUNT.load(Ordering::Relaxed)',
        '}',
      ].join('\n'),
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'a global static declared inside a `mod` block is still enumerated',
    res.status === 1 && res.stderr.includes('nested_metrics::NESTED_COUNT'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ── every atomic mutator counts as a write, not just `fetch_add` ──
  for (const op of [
    'store(1, Ordering::Relaxed)',
    'fetch_max(1, Ordering::Relaxed)',
    'swap(1, Ordering::Relaxed)',
  ]) {
    root = build({
      metricsFile: goodMetrics,
      extra: {
        'src-tauri/src/materializer/consumer.rs': `pub fn bump(m: &QueueMetrics) {\n    m.good.${op};\n}\n`,
        'src-tauri/src/materializer/tests/mod.rs': goodTest,
      },
      baseline: [],
    })
    res = run(root)
    expect(
      `\`.${op.split('(')[0]}(\` is a production emit`,
      res.status === 0,
      `status=${res.status} out=${res.stdout}${res.stderr}`,
    )
  }

  // ── rule 3 is scoped to struct fields; a global static is not judged by
  //    the writes inside its own module (which are the mutator's body) ──
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': `${goodProd}\npub fn oops() {\n    panicky_metrics::record();\n}\n`,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
      'src-tauri/src/materializer/panicky_metrics.rs': [
        'use std::sync::atomic::{AtomicU64, Ordering};',
        '',
        'static PANICKY_COUNT: AtomicU64 = AtomicU64::new(0);',
        '',
        'pub fn record() {',
        '    if panicked() {',
        '        PANICKY_COUNT.fetch_add(1, Ordering::Relaxed);',
        '    }',
        '}',
        '',
        'pub fn count() -> u64 {',
        '    PANICKY_COUNT.load(Ordering::Relaxed)',
        '}',
        '',
        '#[cfg(test)]',
        'mod tests {',
        '    use super::*;',
        '    #[test]',
        '    fn record_increments_count() {',
        '        let before = count();',
        '        record();',
        '        assert!(count() > before);',
        '    }',
        '}',
      ].join('\n'),
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'rule 3 does not fire on a global static whose own mutator body is panic-gated',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )
}

/**
 * #3384: the limitations #3349 shipped, each closed with a fixture that the
 * old behaviour fails AND a sibling fixture proving the widening still rejects
 * the case it was meant to reject. The pairs are the point: a widening with
 * only positive fixtures cannot tell "now credited" from "now credits
 * everything".
 *
 * @param {{build: Function, run: Function, expect: Function, goodMetrics: string, goodProd: string, goodTest: string}} ctx
 */
function runLimitClosureSelfTest(ctx) {
  const { build, run, expect, goodMetrics, goodProd, goodTest } = ctx
  let root
  let res
  const test = (...lines) =>
    ['#[test]', 'fn t() {', '    let m = QueueMetrics::default();', ...lines, '}'].join('\n')
  const withTest = (body, extra = {}) => ({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': body,
      ...extra,
    },
    baseline: [],
  })
  const SQL_LET = [
    '    let actual: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM op_log")',
    '        .fetch_one(&pool)',
    '        .await',
    '        .unwrap();',
  ]

  // ─── item 1: equality against a runtime binding ────────────────────────
  //
  // The shape that produced two false findings in #3382: the production
  // refresh is driven and the counter is pinned to a live `SELECT COUNT(*)`.
  // #3349 credited only a non-zero LITERAL, so this read as no test at all.
  res = run(
    build(
      withTest(
        test(
          '    bump(&m);',
          ...SQL_LET,
          '    let cached = m.good.load(Ordering::Relaxed);',
          '    assert_eq!(i64::try_from(cached).unwrap(), actual, "must equal the row count");',
        ),
      ),
    ),
  )
  expect(
    '`assert_eq!(metric, <SQL ground truth>)` is a firing proof',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // …and the sibling shapes that must STAY uncredited. Each is
  // `assert_eq!(metric, <binding>)` — textually the same assertion — and none
  // of them can fail once the emit site is deleted.
  for (const [label, lines] of [
    [
      'a projection of the same counter (the live `fifo_status.rs` shape)',
      [
        '    let before = status_of(&m).good_count;',
        '    assert_eq!(before, m.good.load(Ordering::Relaxed), "projection must agree");',
      ],
    ],
    [
      'a constant expectation',
      [
        '    let expected = 0;',
        '    assert_eq!(m.good.load(Ordering::Relaxed), expected, "still zero");',
      ],
    ],
    [
      'a plain function call',
      [
        '    let expected = default_floor();',
        '    assert_eq!(m.good.load(Ordering::Relaxed), expected, "matches the floor");',
      ],
    ],
    // A SQL read is only a ground truth while it is INDEPENDENT of the
    // counter. Here the query is parameterised by an alias of the metric, so
    // both sides of the equality move together and the assertion cannot fail
    // — the same defect as the projection above, wearing `sqlx::` as a
    // disguise. Rejected by `witnessesIn` clause (a); note the binding is
    // deliberately bound from the ALIAS, not from the metric, so the
    // both-sides-name-the-metric rule in `isFiringEquality` does not reach it
    // and clause (a) is the only thing left.
    [
      'a SQL read parameterised by the counter itself',
      [
        '    let seen = m.good.load(Ordering::Relaxed);',
        '    let n: i64 = sqlx::query_scalar("SELECT ?")',
        '        .bind(seen)',
        '        .fetch_one(&pool)',
        '        .await',
        '        .unwrap();',
        '    assert_eq!(m.good.load(Ordering::Relaxed), n, "circular ground truth");',
      ],
    ],
  ]) {
    res = run(build(withTest(test(...lines))))
    expect(
      `\`assert_eq!(metric, …)\` against ${label} is NOT a firing proof`,
      res.status === 1 && res.stderr.includes('no-firing-test'),
      `status=${res.status} err=${res.stderr}`,
    )
  }

  // A local binding is never reached through a `.`, so a closure named `load`
  // must not make the alias match every `.load(` in the function. Live shape:
  // `maintenance.rs` binds `let load = || m.bg_processed.load(..)`, and an
  // unanchored alias then read `assert_eq!(day.load(..), today)` — an
  // assertion about an unrelated atomic — as a proof of the metric.
  res = run(
    build(
      withTest(
        test(
          '    let load = || m.good.load(Ordering::Relaxed);',
          '    let day = AtomicI32::new(0);',
          ...SQL_LET,
          '    assert_eq!(day.load(Ordering::Acquire), actual, "an unrelated atomic");',
        ),
      ),
    ),
  )
  expect(
    'an alias named `load` does not make `other.load(..)` an assertion about the metric',
    res.status === 1 && res.stderr.includes('no-firing-test'),
    `status=${res.status} err=${res.stderr}`,
  )

  // ─── item 1: a bound comparison READ BY AN ASSERTION ───────────────────
  //
  // The counterpart to the four "bound and merely read" fixtures above: the
  // discriminator is not whether `rose` is read, it is whether an `assert!`
  // is what reads it.
  res = run(
    build(
      withTest(
        test(
          '    let before = m.good.load(Ordering::Relaxed);',
          '    bump(&m);',
          '    let rose = m.good.load(Ordering::Relaxed) > before;',
          '    assert!(rose, "the counter must advance");',
        ),
      ),
    ),
  )
  expect(
    'a bound firing comparison READ BY an `assert!` IS a proof',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  for (const [label, lines] of [
    [
      'the NEGATION of one',
      [
        '    let before = m.good.load(Ordering::Relaxed);',
        '    let rose = m.good.load(Ordering::Relaxed) > before;',
        '    assert!(!rose, "must not advance here");',
      ],
    ],
    [
      'a bound comparison that is not a firing one',
      ['    let flat = m.good.load(Ordering::Relaxed) >= 0;', '    assert!(flat, "always true");'],
    ],
  ]) {
    res = run(build(withTest(test(...lines))))
    expect(
      `an \`assert!\` on ${label} is NOT a proof`,
      res.status === 1 && res.stderr.includes('no-firing-test'),
      `status=${res.status} err=${res.stderr}`,
    )
  }

  // ─── item 3: gates spelled otherwise, end to end ───────────────────────
  const gatedBy = (cond) =>
    [
      'pub fn drive(m: &QueueMetrics, o: Outcome) {',
      `    if ${cond} {`,
      '        m.good.fetch_add(1, Ordering::Relaxed);',
      '    }',
      '}',
    ].join('\n')
  const driveTest = test('    drive(&m, o);', '    assert_eq!(m.good.load(Ordering::Relaxed), 1);')
  for (const cond of ['is_panic_outcome(&o)', 'o.was_panic']) {
    root = build({
      metricsFile: goodMetrics,
      extra: {
        'src-tauri/src/materializer/consumer.rs': gatedBy(cond),
        'src-tauri/src/materializer/tests/mod.rs': driveTest,
      },
      baseline: [],
    })
    res = run(root)
    expect(
      `a \`if ${cond}\` gate is recognised as panic detection`,
      res.status === 1 && res.stderr.includes('unreachable-under-panic-abort'),
      `status=${res.status} err=${res.stderr}`,
    )
  }
  // The sibling: a NEGATED gate runs on the ordinary path, so the emit inside
  // it is perfectly reachable in release. #3349 matched this head too.
  root = build({
    metricsFile: goodMetrics,
    extra: {
      'src-tauri/src/materializer/consumer.rs': gatedBy('!o.panicked'),
      'src-tauri/src/materializer/tests/mod.rs': driveTest,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'a NEGATED panic gate leaves the emit reachable',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // ─── item 4: enumeration gaps ──────────────────────────────────────────

  // A counter in a SECOND `…Metrics` struct, in another crate.
  const otherStruct = (name) =>
    [
      'use std::sync::atomic::AtomicU64;',
      `pub struct ${name} {`,
      '    pub pushes: AtomicU64,',
      '}',
    ].join('\n')
  root = build({
    ...withTest(goodTest, {
      'src-tauri/agaric-sync/src/sync_metrics.rs': otherStruct('SyncMetrics'),
    }),
  })
  res = run(root)
  expect(
    'a counter in a second `…Metrics` struct is enumerated',
    res.status === 1 && res.stderr.includes('SyncMetrics::pushes'),
    `status=${res.status} err=${res.stderr}`,
  )
  root = build({
    ...withTest(goodTest, {
      'src-tauri/agaric-sync/src/sync_metrics.rs': otherStruct('SyncCounters'),
    }),
  })
  res = run(root)
  expect(
    'an atomic field of a struct NOT named `…Metrics` is still not a metric',
    res.status === 0 && res.stdout.includes('1 metric(s) enumerated'),
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // `QueueMetrics` moved out of `metrics.rs` behind a re-export shim. The old
  // enumerator read ONLY `metrics.rs`, so the whole struct vanished silently.
  root = build({
    metricsFile: 'pub use crate::materializer::inner::QueueMetrics;\n',
    extra: {
      'src-tauri/src/materializer/inner.rs': goodMetrics,
      'src-tauri/src/materializer/consumer.rs': goodProd,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    '`QueueMetrics` behind a re-export shim is still enumerated',
    res.status === 1 && res.stderr.includes('QueueMetrics::good'),
    `status=${res.status} err=${res.stderr}`,
  )

  // A `#[cfg(test)]` FIELD is a test hook, not a metric — the live
  // `InboundRebuildDebounce::fanout_fires` shape. `cfgTestRegions` cannot see
  // it because a field attribute opens no block.
  const withField = (attr) =>
    [
      'use std::sync::atomic::AtomicU64;',
      'pub struct QueueMetrics {',
      '    pub good: AtomicU64,',
      '    /// Test-only hook.',
      ...(attr ? [`    ${attr}`] : []),
      '    pub spy_hits: AtomicU64,',
      '}',
    ].join('\n')
  root = build({
    metricsFile: withField('#[cfg(test)]'),
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'a `#[cfg(test)]` field is not enumerated as a metric',
    res.status === 0 && res.stdout.includes('1 metric(s) enumerated'),
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )
  root = build({
    metricsFile: withField(null),
    extra: {
      'src-tauri/src/materializer/consumer.rs': goodProd,
      'src-tauri/src/materializer/tests/mod.rs': goodTest,
    },
    baseline: [],
  })
  res = run(root)
  expect(
    'the SAME field without the attribute IS enumerated',
    res.status === 1 && res.stderr.includes('QueueMetrics::spy_hits'),
    `status=${res.status} err=${res.stderr}`,
  )

  // Field TYPES: a type alias and an `Arc` wrapper are counters; `f64` behind
  // an alias and an `AtomicBool` flag are not.
  for (const [label, prelude, decl, enumerated] of [
    ['behind a type alias', 'type Counter = AtomicU64;', '    pub sneaky: Counter,', true],
    ['behind an `Arc`', '', '    pub sneaky: Arc<AtomicUsize>,', true],
    [
      'behind a path-qualified `Arc`',
      '',
      '    pub sneaky: std::sync::Arc<std::sync::atomic::AtomicU64>,',
      true,
    ],
    ['behind a NON-atomic type alias', 'type Ratio = f64;', '    pub sneaky: Ratio,', false],
    ['as an `AtomicBool` flag', '', '    pub sneaky: AtomicBool,', false],
  ]) {
    root = build({
      metricsFile: [
        'use std::sync::atomic::AtomicU64;',
        prelude,
        'pub struct QueueMetrics {',
        decl,
        '}',
      ].join('\n'),
      extra: { 'src-tauri/src/materializer/consumer.rs': goodProd },
      baseline: [],
    })
    res = run(root)
    expect(
      `a counter declared ${label} is ${enumerated ? '' : 'NOT '}enumerated`,
      enumerated
        ? res.status === 1 && res.stderr.includes('QueueMetrics::sneaky')
        : res.status === 0 && res.stdout.includes('0 metric(s) enumerated'),
      `status=${res.status} out=${res.stdout}${res.stderr}`,
    )
  }

  // A global static reported through an accessor that is not `count()`.
  const globalWith = (accessor) =>
    [
      'use std::sync::atomic::{AtomicU64, Ordering};',
      'static THING_COUNT: AtomicU64 = AtomicU64::new(0);',
      'pub fn record() { THING_COUNT.fetch_add(1, Ordering::Relaxed); }',
      `pub fn ${accessor}() -> u64 { THING_COUNT.load(Ordering::Relaxed) }`,
    ].join('\n')
  for (const accessor of ['total', 'snapshot', 'last']) {
    root = build({
      ...withTest(goodTest, {
        'src-tauri/src/materializer/thing_metrics.rs': globalWith(accessor),
      }),
    })
    res = run(root)
    expect(
      `a global static reported through \`fn ${accessor}()\` is enumerated`,
      res.status === 1 && res.stderr.includes('thing_metrics::THING_COUNT'),
      `status=${res.status} err=${res.stderr}`,
    )
  }
  // The sibling that keeps the accessor requirement load-bearing: a
  // process-global CONFIG atomic reported through `fn ratio()` is not a metric.
  root = build({
    ...withTest(goodTest, { 'src-tauri/src/materializer/thing_metrics.rs': globalWith('ratio') }),
  })
  res = run(root)
  expect(
    'a global static reported through `fn ratio()` is still NOT a metric',
    res.status === 0 && res.stdout.includes('1 metric(s) enumerated'),
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // A crate nested one level deeper — `src-tauri/crates/<crate>/src`.
  root = build({
    ...withTest(goodTest, {
      'src-tauri/crates/agaric-nested/src/nested_metrics.rs': globalWith('count'),
      // …but only through a crate `src`: a stray `.rs` in the container is not
      // a scan root, the same way `scripts/` is not.
      'src-tauri/crates/decoy.rs': globalWith('count'),
    }),
  })
  res = run(root)
  expect(
    'a crate at `src-tauri/crates/<crate>/src` is scanned',
    res.status === 1 && res.stderr.includes('nested_metrics::THING_COUNT'),
    `status=${res.status} err=${res.stderr}`,
  )
  expect(
    'a stray `.rs` in the crate container is NOT scanned',
    !res.stderr.includes('decoy::THING_COUNT'),
    `status=${res.status} err=${res.stderr}`,
  )
}
