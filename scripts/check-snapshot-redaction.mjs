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
// We auto-derive the allowlist by reading every `.rs` file under every
// workspace member's `src/` once — the member list itself derived from
// `[workspace] members` in `src-tauri/Cargo.toml`, so it cannot drift as
// crates are added or modules move between them (#3465) — and treating any
// candidate value that appears as a substring of the concatenated source as a
// fixture. Pros vs an explicit allowlist:
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
// Hash: deadbeef… # snapshot-allow-hash: known-fixture-payload
//
// Markers supported (all share the `snapshot-allow-` prefix): `ulid`,
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
//        node scripts/check-snapshot-redaction.mjs --self-test
//        node scripts/check-snapshot-redaction.mjs --root <dir>   (self-test)
// Exit:  0 = clean, 1 = at least one unredacted value,
//        2 = the fixture-source roots could not be derived (fail closed),
//            or a self-test assertion failed.
// ─────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ARGV = process.argv.slice(2)

// `--root <dir>` exists so `--self-test` can drive this script against
// synthetic trees as a real subprocess and assert the actual exit code
// (#3465). It defaults to the repo, so every ordinary invocation is
// unchanged.
const ROOT_FLAG = ARGV.indexOf('--root')
const ROOT =
  ROOT_FLAG === -1
    ? path.resolve(import.meta.dirname, '..')
    : path.resolve(ARGV[ROOT_FLAG + 1] ?? '')

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

// Build a single concatenated blob of every `.rs` file under every workspace
// member for the fixture-allowlist substring index. Modules that own snapshot
// tests (e.g. `op.rs` with its `const TEST_TID` fixtures) move between crates
// during the layered split, so the fixture consts must be discoverable
// wherever the module currently lives. Reading a few hundred small files and
// joining them takes ~30ms; subsequent `.includes()` calls are O(N) over the
// blob but N ≈ 5 MB and we run at most ~50 lookups, so total time stays well
// under the <2s budget.
//
// The root list is DERIVED from `[workspace] members` in
// `src-tauri/Cargo.toml`, never hand-maintained (#3465). The hand-maintained
// list covered three of the five crates the #2621 split produced, so whether
// a literal counted as a deliberate fixture depended on which crate the
// snapshot test happened to live in — the same path-keyed drift that has now
// bitten three guards in this tree. Deriving it means a new member crate is
// covered the day it is added to the manifest.
const WORKSPACE_MANIFEST_REL = 'src-tauri/Cargo.toml'

/**
 * Fail-closed exit. The allowlist is the guard's only source of leniency, so
 * a derivation that cannot be trusted must stop the run rather than continue
 * with a partial list: a partial list is exactly the #3465 defect (a crate
 * silently held to different rules), and it is invisible in a green run.
 *
 * @param {string} why
 * @returns {never}
 */
function derivationFailure(why) {
  console.error(`ERROR: cannot derive the Rust fixture-source roots — ${why}.`)
  console.error(`This guard reads \`[workspace] members\` from ${WORKSPACE_MANIFEST_REL}.`)
  console.error('Refusing to run with a partial allowlist (#3465).')
  process.exit(2)
}

/**
 * `<member>/src` for every workspace member, relative to the repo root.
 *
 * @returns {string[]}
 */
function deriveRustSourceRoots() {
  const manifest = path.join(ROOT, WORKSPACE_MANIFEST_REL)
  if (!fs.existsSync(manifest)) derivationFailure(`${WORKSPACE_MANIFEST_REL} does not exist`)
  // Strip `#` comments so a commented-out member is not read as a live one.
  const text = fs
    .readFileSync(manifest, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*$/, ''))
    .join('\n')
  const workspace = /^\s*\[workspace\]\s*$/m.exec(text)
  if (workspace === null) derivationFailure('no [workspace] section')
  // Bounded by the next section header so a `members` key belonging to some
  // other table cannot be mistaken for the workspace's.
  const rest = text.slice(workspace.index + workspace[0].length)
  const nextSection = /^\s*\[/m.exec(rest)
  const section = nextSection === null ? rest : rest.slice(0, nextSection.index)
  const members = /\bmembers\s*=\s*\[([^\]]*)\]/.exec(section)
  if (members === null) derivationFailure('no `members` key in [workspace]')
  const names = [...members[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  if (names.length === 0) derivationFailure('the `members` list is empty')

  const roots = []
  for (const name of names) {
    const rel = name === '.' ? 'src-tauri/src' : `src-tauri/${name}/src`
    // A declared member with no `src/` means the layout moved under the
    // guard's feet — the precise condition that produced #3465. Stop, loudly.
    if (!fs.existsSync(path.join(ROOT, rel))) {
      derivationFailure(`workspace member \`${name}\` has no \`${rel}\``)
    }
    roots.push(rel)
  }
  return roots
}

let RUST_SOURCE_ROOTS = null
function getRustSourceRoots() {
  RUST_SOURCE_ROOTS ??= deriveRustSourceRoots()
  return RUST_SOURCE_ROOTS
}

let RUST_SOURCE_BLOB = null
function getRustSourceBlob() {
  if (RUST_SOURCE_BLOB !== null) return RUST_SOURCE_BLOB
  const parts = []
  for (const root of getRustSourceRoots()) {
    const dir = path.join(ROOT, root)
    for (const f of walk(dir, (n) => n.endsWith('.rs'))) {
      parts.push(fs.readFileSync(f, 'utf8'))
    }
  }
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
// Hash: deadbeef… # snapshot-allow-hash: known-fixture-payload
const ALLOW_MARKER_RE = /#\s*snapshot-allow-(ulid|hash|timestamp|cursor)\s*:/i

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

// Placed before the scan; `runSelfTest` always exits, so the scan below never
// runs in self-test mode.
if (ARGV.includes('--self-test')) runSelfTest()

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
  console.error('  hash: <value>  # snapshot-allow-hash: <reason>')
  process.exit(1)
}

console.log(
  `OK: ${snapFileCount} snapshot file(s) scanned, ${totalCandidates} candidate(s) checked, ` +
    `0 unredacted ULID/hash/timestamp/cursor values.`,
)

// ─── self-test ──────────────────────────────────────────────────────
//
// Every strictness property this guard has is a property of a REAL run, so
// the fixtures below build synthetic repos and spawn this script against them
// with `--root`, asserting the actual exit code. Each closed hole is a PAIR: a
// tree the guard must flag and a tree it must not, because a widening with
// only one of the two cannot tell "now correct" from "now credits everything".

function runSelfTest() {
  const failures = []
  const expect = (name, cond, detail) => {
    if (cond) {
      console.log(`  ok   - ${name}`)
    } else {
      failures.push(name)
      console.error(`  FAIL - ${name}: ${detail}`)
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-redaction-selftest-'))
  let n = 0
  /**
   * @param {{members?: string[], files: Record<string, string>}} spec
   * @returns {string} synthetic repo root
   */
  const build = ({ members = ['.', 'agaric-engine'], files }) => {
    const root = path.join(tmp, `fx${(n += 1)}`)
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(root, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, body)
    }
    if (members !== null) {
      const list = members.map((m) => `"${m}"`).join(', ')
      fs.mkdirSync(path.join(root, 'src-tauri'), { recursive: true })
      fs.writeFileSync(
        path.join(root, 'src-tauri', 'Cargo.toml'),
        `[workspace]\nmembers = [${list}]\n\n[package]\nname = "agaric"\n`,
      )
      // Every declared member needs a `src/` — its absence is itself an
      // asserted failure mode below, so it must be deliberate, not incidental.
      for (const m of members) {
        const rel = m === '.' ? 'src-tauri/src' : `src-tauri/${m}/src`
        fs.mkdirSync(path.join(root, rel), { recursive: true })
      }
    }
    return root
  }
  const run = (root) =>
    spawnSync(process.execPath, [import.meta.filename, '--root', root], { encoding: 'utf8' })

  // A ULID-shaped value used as the non-deterministic sample throughout.
  const ULID = '01HQ8XG5ZK9J2M4N6P8R0TVWXY'
  const snap = (value) =>
    ['---', 'source: src.rs', 'expression: resp', '---', `id: ${value}`, ''].join('\n')

  // ── the crate the allowlist never covered (#3465) ──
  //
  // `agaric-engine` is one of the three members the hand-maintained list
  // missed. Both halves of the pair live there, so together they pin that the
  // crate is now held to EXACTLY the same rule as `src-tauri/src` — neither
  // stricter (half 2 would fail) nor looser (half 1 would fail).
  let root = build({
    files: {
      'src-tauri/agaric-engine/src/snapshots/x.snap': snap(ULID),
      'src-tauri/agaric-engine/src/lib.rs': 'pub fn f() {}\n',
    },
  })
  let res = run(root)
  expect(
    'an unredacted ULID in an agaric-engine snapshot is flagged',
    res.status === 1 && res.stderr.includes(ULID),
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  root = build({
    files: {
      'src-tauri/agaric-engine/src/snapshots/x.snap': snap(ULID),
      'src-tauri/agaric-engine/src/lib.rs': `const TEST_TID: &str = "${ULID}";\n`,
    },
  })
  res = run(root)
  expect(
    'a ULID declared as a fixture const IN agaric-engine is allowlisted (the #3465 fix)',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // The blob is deliberately workspace-wide: a fixture const may live in a
  // different crate from the snapshot that renders it.
  root = build({
    files: {
      'src-tauri/agaric-engine/src/snapshots/x.snap': snap(ULID),
      'src-tauri/src/fixtures.rs': `const TEST_TID: &str = "${ULID}";\n`,
    },
  })
  res = run(root)
  expect(
    'a fixture const in ANOTHER member crate also allowlists the value',
    res.status === 0,
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // ── the derivation fails CLOSED ──
  //
  // A partial allowlist is the #3465 defect itself and is invisible in a green
  // run, so every way the derivation can come up short must stop the run
  // (exit 2) rather than quietly scan fewer roots.
  const failsClosed = (r) => r.status === 2 && r.stderr.includes('cannot derive')

  root = build({
    members: null,
    files: { 'src-tauri/agaric-engine/src/snapshots/x.snap': snap(ULID) },
  })
  res = run(root)
  expect(
    'a missing src-tauri/Cargo.toml exits 2, not 0',
    failsClosed(res),
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  root = build({ files: { 'src-tauri/agaric-engine/src/snapshots/x.snap': snap(ULID) } })
  fs.writeFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "agaric"\n')
  res = run(root)
  expect(
    'a manifest with no [workspace] section exits 2',
    failsClosed(res),
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  root = build({ files: { 'src-tauri/agaric-engine/src/snapshots/x.snap': snap(ULID) } })
  fs.writeFileSync(
    path.join(root, 'src-tauri', 'Cargo.toml'),
    '[workspace]\nmembers = [".", "agaric-engine", "agaric-ghost"]\n',
  )
  res = run(root)
  expect(
    'a declared member with no `src/` exits 2 (the layout moved under the guard)',
    failsClosed(res) && res.stderr.includes('agaric-ghost'),
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  root = build({ files: { 'src-tauri/agaric-engine/src/snapshots/x.snap': snap(ULID) } })
  fs.writeFileSync(
    path.join(root, 'src-tauri', 'Cargo.toml'),
    '[workspace]\n# members = [".", "agaric-engine"]\n',
  )
  res = run(root)
  expect(
    'a COMMENTED-OUT members list is not read as a live one',
    failsClosed(res),
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // A `members` key in a different table must not be mistaken for the
  // workspace's — the section scan is bounded by the next header.
  root = build({ files: { 'src-tauri/agaric-engine/src/snapshots/x.snap': snap(ULID) } })
  fs.writeFileSync(
    path.join(root, 'src-tauri', 'Cargo.toml'),
    '[workspace]\n\n[package.metadata.thing]\nmembers = ["not-a-crate"]\n',
  )
  res = run(root)
  expect(
    "a `members` key in another table is not read as the workspace's",
    failsClosed(res),
    `status=${res.status} out=${res.stdout}${res.stderr}`,
  )

  // ── the LIVE derivation covers every member ──
  //
  // The whole point of #3465: not "three roots" or "five roots" but "exactly
  // the workspace members, whatever they are today".
  const liveRoots = deriveRustSourceRoots()
  const liveMembers = [
    ...fs
      .readFileSync(path.join(ROOT, WORKSPACE_MANIFEST_REL), 'utf8')
      .split('\n')
      .map((l) => l.replace(/#.*$/, ''))
      .join('\n')
      .match(/\bmembers\s*=\s*\[([^\]]*)\]/)[1]
      .matchAll(/"([^"]+)"/g),
  ].map((m) => m[1])
  expect(
    'the live roots are exactly one `src` per workspace member',
    liveRoots.length === liveMembers.length && new Set(liveRoots).size === liveRoots.length,
    `${JSON.stringify(liveRoots)} vs members ${JSON.stringify(liveMembers)}`,
  )
  for (const crate of ['agaric-sync', 'agaric-engine', 'agaric-observability']) {
    expect(
      `the live roots include \`${crate}\` (missing before #3465)`,
      liveRoots.includes(`src-tauri/${crate}/src`),
      JSON.stringify(liveRoots),
    )
  }

  fs.rmSync(tmp, { recursive: true, force: true })

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
  process.exit(0)
}
