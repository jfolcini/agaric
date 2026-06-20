#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Tauri bindings ↔ wrapper parity check.
//
// Verifies that every IPC command emitted from `src/lib/bindings.ts`
// (the auto-generated tauri-specta surface) has a corresponding
// ergonomics wrapper in the hand-written `src/lib/tauri.ts` layer,
// or sits on an explicit allowlist.
//
// Why this exists: `bindings.ts` regenerates automatically when a
// Rust command signature changes (and the `ts_bindings_up_to_date`
// pre-commit hook catches drift in `bindings.ts` itself). But
// `tauri.ts` is hand-edited, so a renamed Rust parameter can land
// with the wrapper still using the old name → runtime error in
// production. This script catches the gap at commit time.
//
// Symmetric to `check-tauri-mock-parity.mjs`, which catches the
// complementary drift class (bindings.ts ↔ `src/lib/tauri-mock/handlers.ts`).
//
// Usage: `node scripts/check-tauri-bindings-parity.mjs`
// Exit code 0 = parity, 1 = missing wrapper(s), 2 = parser failure.
// Stale allowlist entries and orphan wrappers (in tauri.ts but not
// bindings.ts) are surfaced as warnings without failing the run.
//
// Phase 1 (this script): command-name parity only.
// Phase 2 (deferred): per-command parameter-name parity.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const BINDINGS = path.join(ROOT, 'src/lib/bindings.ts')
const TAURI = path.join(ROOT, 'src/lib/tauri.ts')

// ─── Known unwrapped commands ───────────────────────────────────────
// Commands intentionally consumed directly via `commands.*` rather
// than through an ergonomic `tauri.ts` wrapper. Snapshot pinned by
// running this script against the unmodified codebase at the time
// Landed (101 bindings vs 96 wrappers, leaving 15 unwrapped).
//
// Two flavours of entry below:
//   (a) status / setter surfaces consumed directly because the
//       wrapping layer adds no ergonomics value (no parameter
//       coercion, no shape transformation, no JSDoc lift) — MCP
//       and GCal control surfaces fall here.
//   (b) renamed-wrapper bindings: the wrapper exists in `tauri.ts`
//       but under a different name (e.g. `compactOpLogCmd` → wrapper
//       `compactOpLog`, `listAttachmentsBatch` → wrapper
//       `getBatchAttachments`). Name-only parity flags these as
//       missing; allowlist them with a pointer to the actual wrapper.
//
// Every entry here is a deliberate choice. Adding a new IPC command
// without a wrapper means callers must pull it directly from
// `commands.*` and unwrap by hand — fine for narrow status calls,
// not fine for the general case.
const KNOWN_UNWRAPPED = new Set([
  // (a) MCP read-only status + control — no ergonomics layer needed.
  'getMcpStatus',
  'getMcpSocketPath',
  'mcpSetEnabled',
  'mcpDisconnectAll',
  // (a) MCP activity-ring read surface (#695) — status/diagnostics
  // consumer reads `commands.getMcpRecentActivity` directly.
  'getMcpRecentActivity',
  // (a) MCP read-write status + control — same rationale as RO.
  'getMcpRwStatus',
  'getMcpRwSocketPath',
  'mcpRwSetEnabled',
  'mcpRwDisconnectAll',
  // (a) GCal status + control surface — direct `commands.*` consumers.
  'getGcalStatus',
  'forceGcalResync',
  'disconnectGcal',
  'setGcalWindowDays',
  'setGcalPrivacyMode',
  'beginGcalOauth',
  // (b) wrapped under a different name in tauri.ts — see the wrapper
  // body for the corresponding `commands.*` call.
  'compactOpLogCmd', // wrapped as `compactOpLog`
  'listAttachmentsBatch', // wrapped as `getBatchAttachments`
])

const bindingsSrc = fs.readFileSync(BINDINGS, 'utf8')
const tauriSrc = fs.readFileSync(TAURI, 'utf8')

// ─── 1. Parse bindings.ts → set of command names ────────────────────
//
// Match the keys of the auto-generated `commands = { … }` object.
// tauri-specta emits each command as `<camelName>: (args) => …`,
// indented under the object literal. Anchor on leading whitespace +
// camelCase identifier + colon + open paren.
const commands = new Set()
for (const m of bindingsSrc.matchAll(/^\s+([a-zA-Z][a-zA-Z0-9]*):\s*\(/gm)) {
  commands.add(m[1])
}
if (commands.size === 0) {
  console.error(`ERROR: parsed 0 commands from ${BINDINGS} — parser is broken or file is empty.`)
  process.exit(2)
}

// ─── 2. Parse tauri.ts → set of exported wrapper names ──────────────
//
// Top-level `export function` / `export async function` declarations.
// Skips arrow-function exports and re-exports, which are not the
// pattern used in `tauri.ts`.
const wrappers = new Set()
for (const m of tauriSrc.matchAll(
  /^export\s+(?:async\s+)?function\s+([a-zA-Z][a-zA-Z0-9]*)\s*\(/gm,
)) {
  wrappers.add(m[1])
}
if (wrappers.size === 0) {
  console.error(
    `ERROR: parsed 0 exported function wrappers from ${TAURI} — parser is broken or file is empty.`,
  )
  process.exit(2)
}

// ─── 3. Compute three diff sets ─────────────────────────────────────
const missingNew = [...commands]
  .filter((c) => !wrappers.has(c) && !KNOWN_UNWRAPPED.has(c))
  .toSorted()
const allowlistStale = [...KNOWN_UNWRAPPED].filter((c) => !commands.has(c)).toSorted()
const extra = [...wrappers].filter((c) => !commands.has(c)).toSorted()

let exitCode = 0

if (missingNew.length > 0) {
  console.error(
    'ERROR: commands in bindings.ts have no wrapper in tauri.ts and are not allowlisted:',
  )
  for (const cmd of missingNew) {
    console.error(
      `  - ${cmd}: add a wrapper to src/lib/tauri.ts, or add to KNOWN_UNWRAPPED in this script with a justifying comment`,
    )
  }
  console.error('')
  console.error(
    'A new IPC command without a wrapper means callers have to import `commands` and unwrap by hand,',
  )
  console.error(
    'losing the throw-on-error / parameter-coercion / JSDoc lift the wrapper layer provides.',
  )
  console.error(
    'If the command is genuinely better consumed directly (status/setter surface, no ergonomics value),',
  )
  console.error(
    'add it to KNOWN_UNWRAPPED at the top of this script with a one-line comment explaining why.',
  )
  exitCode = 1
}

if (allowlistStale.length > 0) {
  console.warn(
    'WARN: KNOWN_UNWRAPPED contains entries that are no longer in bindings.ts (clean up the allowlist):',
  )
  for (const cmd of allowlistStale) console.warn(`  - ${cmd}`)
}

if (extra.length > 0) {
  console.warn(
    'WARN: tauri.ts has wrappers for names not in bindings.ts (likely Tauri-plugin shims or renamed wrappers):',
  )
  for (const cmd of extra) console.warn(`  - ${cmd}`)
}

if (exitCode === 0) {
  const allowlisted = [...KNOWN_UNWRAPPED].filter((c) => commands.has(c)).length
  const wrapped = commands.size - allowlisted
  console.log(
    `OK: ${wrapped}/${commands.size} commands wrapped, ${allowlisted} on the KNOWN_UNWRAPPED allowlist.`,
  )
}

process.exit(exitCode)
