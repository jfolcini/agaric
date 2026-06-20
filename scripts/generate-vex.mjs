#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Generate an OpenVEX 0.2.0 JSON document for the current
// release from `src-tauri/deny.toml`'s `[advisories].ignore` array.
//
// Why this exists: every release ships per-platform SBOMs (SPDX-JSON +
// CycloneDX-JSON) attested under SLSA build provenance. External
// scanners running against the SBOMs flag CVEs that affect transitive
// deps — even when Agaric's call patterns make the vulnerable code
// path unreachable. We already have prose rationale for those
// non-affecting advisories in `src-tauri/deny.toml [advisories].ignore`;
// this script converts that rationale into a machine-readable
// OpenVEX 0.2.0 statement set so scanners can suppress the noise
// automatically.
//
// Source of truth: `src-tauri/deny.toml` (never written by this script).
// Schema: https://openvex.dev/ns/v0.2.0
// Spec:   https://github.com/openvex/spec/blob/main/openvex-specification-v0.2.0.md
//
// Usage:
//   node scripts/generate-vex.mjs                       # → stdout
//   node scripts/generate-vex.mjs --output FILE         # → FILE
//   node scripts/generate-vex.mjs --version 0.1.32      # override pkg version
//
// Zero external deps — uses an inline regex parser over the
// `[advisories].ignore = [ { id = "...", reason = "..." }, ... ]`
// array. Same approach as `scripts/sync-audit-from-deny.mjs`; if
// deny.toml's schema ever changes, the assertions below fail loudly.
// ─────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const DENY_PATH = resolve(REPO_ROOT, 'src-tauri/deny.toml')
const PKG_PATH = resolve(REPO_ROOT, 'package.json')

const OPENVEX_CONTEXT = 'https://openvex.dev/ns/v0.2.0'
const AUTHOR = 'Agaric maintainers <jfolcini86@gmail.com>'

// Rationale-substring → OpenVEX (status, justification) mapping.
// Tested case-insensitively. First match wins. An entry that matches
// nothing falls through to `under_investigation` and prints a warning
// To stderr — does not fail the build (spec).
const STATUS_MAP = [
  // Transitive / binding-only dependencies — vulnerable code is reachable
  // in principle but not from Agaric's call graph because the dep ships
  // only as a binding/glue layer or is gated behind a feature we don't
  // enable.
  {
    match: /transitive dep/i,
    status: 'not_affected',
    justification: 'vulnerable_code_not_in_execute_path',
  },
  {
    match: /transitive unmaintained/i,
    status: 'not_affected',
    justification: 'vulnerable_code_not_in_execute_path',
  },
  {
    match: /binding/i,
    status: 'not_affected',
    justification: 'vulnerable_code_not_in_execute_path',
  },
  // Explicit "this code path is never invoked" rationale.
  {
    match: /code path is in/i,
    status: 'not_affected',
    justification: 'vulnerable_code_not_in_execute_path',
  },
  {
    match: /never invoked/i,
    status: 'not_affected',
    justification: 'vulnerable_code_not_in_execute_path',
  },
  {
    match: /never reaches/i,
    status: 'not_affected',
    justification: 'vulnerable_code_not_in_execute_path',
  },
  {
    match: /not exercised/i,
    status: 'not_affected',
    justification: 'vulnerable_code_not_in_execute_path',
  },
  // RNG-specific carve-outs — Agaric uses OsRng, the deprecated thread_rng
  // path that triggers the advisory is not exercised by our code.
  {
    match: /uses OsRng/i,
    status: 'not_affected',
    justification: 'vulnerable_code_not_in_execute_path',
  },
  {
    match: /deprecated thread_rng path/i,
    status: 'not_affected',
    justification: 'vulnerable_code_not_in_execute_path',
  },
]

/**
 * Parse the `[advisories].ignore = [ ... ]` array from deny.toml.
 * Walks only the lines between `ignore = [` and the matching closing
 * `]`. Skips blank lines and `#`-prefixed comment lines. Returns an
 * array of `{ id, reason }` records in source order.
 */
function parseIgnoreEntries(denyTomlText) {
  const lines = denyTomlText.split('\n')
  let inArray = false
  const entries = []
  // Matches `{ id = "RUSTSEC-XXXX-YYYY", reason = "free text" }`.
  // The reason field allows any character except an unescaped `"` (we
  // don't currently emit `\"` in deny.toml; if that ever changes the
  // assertion in main() flags it).
  const entryRegex = /\{\s*id\s*=\s*"(?<id>[^"]+)"\s*,\s*reason\s*=\s*"(?<reason>[^"]*)"\s*\}/

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!inArray) {
      // Trigger on the *exact* `ignore = [` opener inside [advisories].
      // The parser is naive about which section it's in, but deny.toml
      // only has one `ignore = [` array (under [advisories]). If a
      // second array with the same name is ever added, this matcher
      // would need a [advisories] header check; for now the simpler
      // form is fine and matches sync-audit-from-deny.mjs.
      if (/^ignore\s*=\s*\[/.test(line)) {
        inArray = true
      }
      continue
    }
    if (line === ']') {
      break
    }
    if (line === '' || line.startsWith('#')) {
      continue
    }
    const match = line.match(entryRegex)
    if (!match?.groups) {
      // A non-comment, non-blank line that isn't a recognised entry
      // is a hard error — better to fail loudly than silently drop a
      // waived advisory from the VEX document.
      throw new Error(`Unrecognised entry in deny.toml [advisories].ignore: ${rawLine}`)
    }
    entries.push({ id: match.groups.id, reason: match.groups.reason })
  }

  if (entries.length === 0) {
    throw new Error('deny.toml [advisories].ignore parsed to 0 entries')
  }
  return entries
}

/** Map a `reason` string to an OpenVEX `(status, justification)`. */
function classify(reason) {
  for (const rule of STATUS_MAP) {
    if (rule.match.test(reason)) {
      return { status: rule.status, justification: rule.justification }
    }
  }
  return { status: 'under_investigation' }
}

/** Build the OpenVEX 0.2.0 document for `version`. */
function buildDocument(entries, version) {
  const productId = `pkg:cargo/agaric@${version}`
  const statements = entries.map(({ id, reason }) => {
    const { status, justification } = classify(reason)
    if (status === 'under_investigation') {
      process.stderr.write(
        `warning: ${id} reason text did not match any rule, emitting status=under_investigation (reason="${reason}")\n`,
      )
    }
    const statement = {
      vulnerability: {
        name: id,
        '@id': `https://rustsec.org/advisories/${id}.html`,
      },
      products: [{ '@id': productId }],
      status,
    }
    // OpenVEX requires `justification` for `not_affected`; `fixed`
    // statements omit it (the fix itself is the justification);
    // `under_investigation` is a transitional state with no
    // justification yet. The mapping table never emits `affected`.
    if (justification) {
      statement.justification = justification
    }
    return statement
  })

  return {
    '@context': OPENVEX_CONTEXT,
    '@id': `https://openvex.dev/docs/agaric-${version}`,
    author: AUTHOR,
    timestamp: new Date().toISOString(),
    version: 1,
    statements,
  }
}

function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('package.json is missing a string `version` field')
  }
  return pkg.version
}

function parseArgs(argv) {
  const args = { output: null, version: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--output' || arg === '-o') {
      args.output = argv[++i]
      if (!args.output) throw new Error('--output requires a path argument')
    } else if (arg === '--version' || arg === '-v') {
      args.version = argv[++i]
      if (!args.version) throw new Error('--version requires a value')
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/generate-vex.mjs [--output FILE] [--version SEMVER]\n',
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = args.version ?? readPackageVersion()
  const denyText = readFileSync(DENY_PATH, 'utf8')
  const entries = parseIgnoreEntries(denyText)
  const doc = buildDocument(entries, version)

  // Sanity check: round-trip through JSON to catch any non-serialisable
  // values, then verify every statement carries the required fields.
  const roundTripped = JSON.parse(JSON.stringify(doc))
  for (const stmt of roundTripped.statements) {
    if (!stmt.vulnerability?.name?.startsWith('RUSTSEC-')) {
      throw new Error(
        `statement has malformed vulnerability.name: ${JSON.stringify(stmt.vulnerability)}`,
      )
    }
    if (stmt.status === 'fixed') {
      // fixed needs no justification
      continue
    }
    if (!stmt.justification && stmt.status !== 'under_investigation') {
      throw new Error(
        `statement for ${stmt.vulnerability.name} has status=${stmt.status} but no justification`,
      )
    }
  }

  const serialised = `${JSON.stringify(doc, null, 2)}\n`
  if (args.output) {
    writeFileSync(args.output, serialised)
    process.stderr.write(
      `wrote ${args.output} (${doc.statements.length} statements, version=${version})\n`,
    )
  } else {
    process.stdout.write(serialised)
  }
}

main()
