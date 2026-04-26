#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Snapshot-redaction check.
//
// Per src-tauri/tests/AGENTS.md:284-313, snapshot tests must redact
// non-deterministic fields (ULIDs, timestamps, hashes, cursors) so the
// snapshots stay stable across runs. Without redaction, every test
// invocation produces a fresh ULID/timestamp/hash and the snapshot
// fails on the next run — or worse, gets accepted and the snapshot
// silently encodes a one-shot value that future runs can't reproduce.
//
// ─── Patterns scanned ──────────────────────────────────────────────
//
// All `*.snap` files under `src/` and `src-tauri/` (excluding
// `node_modules/`, `target/`, `dist/`) are scanned for:
//
//   1. **ULIDs** — 26 chars in Crockford base32 (`0-9 A-H J-K M-N P-T
//      V-Z`, no I/L/O/U). Matches both standalone tokens and quoted
//      string values in YAML.
//   2. **Hashes** — 64-char lowercase hex (blake3 op-log hashes).
//   3. **Timestamps** — full ISO-8601 with time component
//      (`YYYY-MM-DDThh:mm:ss…`). Date-only values (`2026-04-25` in a
//      `start: { date: 2026-04-25 }` GCal payload) are NOT flagged
//      because they're inherent to the test input, not generated.
//   4. **Cursors** — base64url-no-pad strings on `cursor:` /
//      `next_cursor:` / `prev_cursor:` YAML keys, longer than 16
//      chars, that are not the `[CURSOR]` placeholder.
//
// Redaction placeholders (`[ULID]`, `[HASH]`, `[TIMESTAMP]`,
// `[CURSOR]`) and YAML null (`~`) are obviously allowed and
// excluded by the pattern construction itself.
//
// ─── Fixture allowlist (auto-derived) ───────────────────────────────
//
// Insta snapshots that use **deterministic test fixtures** — e.g.
// `const TEST_BID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV"` declared in a
// test module — are stable across runs by construction. Per the Rust
// test doc (§ "For deterministic data, no redaction needed"), they're
// explicitly allowed.
//
// We auto-derive the allowlist by reading every `.rs` file under
// `src-tauri/src/` once and treating any candidate value that appears
// as a substring of the concatenated source as a fixture. Pros vs an
// explicit allowlist:
//
//   - Cannot go stale: the allowlist regenerates from the source on
//     every run.
//   - Cannot be over-broad: a value only matches if some test
//     literal contains it. Random values from `Ulid::new()` or
//     `chrono::Utc::now()` will never match.
//   - 26-char Crockford ULIDs and 64-char hex strings have ~130-bit
//     and ~256-bit entropy respectively — accidental collisions
//     between a generated value and an unrelated source-code string
//     are vanishingly improbable.
//
// ─── Inline allow markers ───────────────────────────────────────────
//
// If a future need arises to encode a *known* generated hash directly
// in a snapshot (e.g. asserting that the hash of a specific fixture
// payload equals a specific blake3 output), add a same-line YAML
// comment of the form:
//
//     hash: deadbeef…  # MAINT-99-allow-hash: known-fixture-payload
//
// Markers supported (all share the `MAINT-99-allow-` prefix): `ulid`,
// `hash`, `timestamp`, `cursor`. The reason after the colon is
// mandatory and should explain *why* the value is stable. Note that
// insta regenerates `.snap` files; comments survive only if the
// snapshot value didn't change. Prefer the redaction pattern wherever
// possible.
//
// ─── Triage on first activation ────────────────────────────────────
//
// First run found 0 violations across 42 .snap files. Every raw ULID
// in a snapshot is one of the four canonical Crockford fixture values
// (`01ARZ3…`, `01BX5Z…RZ`, `01BX5Z…S0`) declared as `const TEST_*` in
// `src-tauri/src/op.rs`; every raw timestamp is the `FIXED_TS` /
// equivalent fixture in op_log.rs / pagination/tests.rs. No real
// blake3 hashes appear unredacted.
//
// Performance: ~50ms cold (read 42 snap files + concat 200+ rs files
// once for the allowlist substring index).
//
// Usage: node scripts/check-snapshot-redaction.mjs
// Exit:  0 = clean, 1 = at least one unredacted value.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Directories to scan for `.snap` files.
const SCAN_ROOTS = ['src', 'src-tauri']

// Directories to skip during the recursive walks (snap-file scan +
// fixture-allowlist build). Patterns mirror the `.gitignore` shape.
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', '.git', 'coverage'])

// ─── helpers ────────────────────────────────────────────────────────

function walk(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, predicate, results)
    } else if (entry.isFile() && predicate(entry.name, full)) {
      results.push(full)
    }
  }
  return results
}

// Build a single concatenated blob of every `.rs` file under
// `src-tauri/src/` for the fixture-allowlist substring index. Reading
// 200+ small files and joining them takes ~30ms; subsequent
// `.includes()` calls are O(N) over the blob but N ≈ 5 MB and we run
// at most ~50 lookups, so total time stays well under the <2s budget.
let RUST_SOURCE_BLOB = null
function getRustSourceBlob() {
  if (RUST_SOURCE_BLOB !== null) return RUST_SOURCE_BLOB
  const rustFiles = walk(path.join(ROOT, 'src-tauri/src'), (n) => n.endsWith('.rs'))
  const parts = []
  for (const f of rustFiles) parts.push(fs.readFileSync(f, 'utf8'))
  RUST_SOURCE_BLOB = parts.join('\n')
  return RUST_SOURCE_BLOB
}

/**
 * True if `value` appears verbatim in any tracked Rust source file
 * (string literal, comment, doc-test, etc.). Used to clear
 * deterministic test-fixture values that are intentionally encoded in
 * a snapshot rather than redacted.
 */
function isFixtureValue(value) {
  return getRustSourceBlob().includes(value)
}

// Inline allow marker — same-line YAML comment, e.g.:
//     hash: deadbeef…  # MAINT-99-allow-hash: known-fixture-payload
const ALLOW_MARKER_RE = /#\s*MAINT-99-allow-(ulid|hash|timestamp|cursor)\s*:/i

function lineHasAllowMarker(line, kind) {
  const m = line.match(ALLOW_MARKER_RE)
  if (m === null) return false
  return m[1].toLowerCase() === kind
}

// ─── pattern definitions ────────────────────────────────────────────
//
// Each pattern: a regex applied per-line, the kind label (for the
// allow-marker), and a human-readable category.

// 26-char Crockford base32 (excludes I, L, O, U — the ULID alphabet).
// Anchored on word boundaries to avoid matching the middle of longer
// alphanumeric strings.
const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g

// 64-char lowercase hex — blake3 op-log hashes.
const HASH_RE = /\b[0-9a-f]{64}\b/g

// Full ISO-8601 timestamp with time component. Allows trailing zone
// offset (`Z`, `+00:00`, `-07:30`) and optional sub-second precision.
// Date-only strings deliberately don't match.
const TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g

// Cursor key with a quoted base64url-ish value (>16 chars, not the
// `[CURSOR]` placeholder). The leading key anchors the match so we
// don't false-fire on unrelated long base64-ish strings.
const CURSOR_RE = /\b(?:next_cursor|prev_cursor|cursor)\s*:\s*"([A-Za-z0-9_-]{17,}=*)"/g

// Redaction placeholders are the obvious-pass case — the regex above
// already excludes them by construction (`[ULID]` is 6 chars, well
// outside the 26-char ULID match), so no separate filter needed.

// ─── main ───────────────────────────────────────────────────────────

const violations = []
let snapFileCount = 0
let totalCandidates = 0

const snapFiles = []
for (const r of SCAN_ROOTS) {
  walk(path.join(ROOT, r), (n) => n.endsWith('.snap'), snapFiles)
}

for (const snap of snapFiles) {
  snapFileCount++
  const src = fs.readFileSync(snap, 'utf8')
  const lines = src.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // ULID candidates.
    for (const m of line.matchAll(ULID_RE)) {
      totalCandidates++
      const value = m[0]
      // The placeholder `[ULID]` is 6 chars, won't match 26-char regex
      // — no extra filter needed.
      if (isFixtureValue(value)) continue
      if (lineHasAllowMarker(line, 'ulid')) continue
      violations.push({
        file: snap,
        line: i + 1,
        kind: 'ULID',
        value,
        snippet: line.trim(),
      })
    }

    // Hash candidates.
    for (const m of line.matchAll(HASH_RE)) {
      totalCandidates++
      const value = m[0]
      if (isFixtureValue(value)) continue
      if (lineHasAllowMarker(line, 'hash')) continue
      violations.push({
        file: snap,
        line: i + 1,
        kind: 'HASH',
        value,
        snippet: line.trim(),
      })
    }

    // Timestamp candidates.
    for (const m of line.matchAll(TIMESTAMP_RE)) {
      totalCandidates++
      const value = m[0]
      if (isFixtureValue(value)) continue
      if (lineHasAllowMarker(line, 'timestamp')) continue
      violations.push({
        file: snap,
        line: i + 1,
        kind: 'TIMESTAMP',
        value,
        snippet: line.trim(),
      })
    }

    // Cursor candidates — we extract the inner base64-ish value via
    // capture group 1, then check it against the fixture allowlist
    // (cursors are rarely fixtures; this mostly serves to pass values
    // explicitly hardcoded in tests).
    for (const m of line.matchAll(CURSOR_RE)) {
      totalCandidates++
      const value = m[1]
      // `[CURSOR]` is 8 chars and contains `[`/`]` which the regex's
      // `[A-Za-z0-9_-]` charset rejects; defensive belt-and-braces:
      if (value === '[CURSOR]') continue
      if (isFixtureValue(value)) continue
      if (lineHasAllowMarker(line, 'cursor')) continue
      violations.push({
        file: snap,
        line: i + 1,
        kind: 'CURSOR',
        value,
        snippet: line.trim(),
      })
    }
  }
}

// ─── report ─────────────────────────────────────────────────────────

if (violations.length > 0) {
  console.error('ERROR: snapshot files contain unredacted non-deterministic values:')
  for (const v of violations) {
    const rel = path.relative(ROOT, v.file)
    console.error(`  ${rel}:${v.line}  [${v.kind}]  ${v.value}`)
    console.error(`    ${v.snippet}`)
  }
  console.error('')
  console.error('Per src-tauri/tests/AGENTS.md:288-317, redact non-deterministic fields:')
  console.error('  insta::assert_yaml_snapshot!(resp, {')
  console.error('      ".id"          => "[ULID]",')
  console.error('      ".created_at"  => "[TIMESTAMP]",')
  console.error('      ".hash"        => "[HASH]",')
  console.error('      ".next_cursor" => "[CURSOR]",')
  console.error('  });')
  console.error('')
  console.error('If the value is genuinely a deterministic fixture (declared as a const')
  console.error('in a `.rs` test module), this hook will auto-allow it on the next run.')
  console.error('For the rare case of a known-fixed generated hash, add an inline marker:')
  console.error('  hash: <value>  # MAINT-99-allow-hash: <reason>')
  process.exit(1)
}

console.log(
  `OK: ${snapFileCount} snapshot file(s) scanned, ${totalCandidates} candidate(s) checked, ` +
    `0 unredacted ULID/hash/timestamp/cursor values.`,
)
