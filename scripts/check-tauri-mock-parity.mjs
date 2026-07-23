#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Tauri mock parity check.
//
// Verifies that every IPC command emitted from `src/lib/bindings.ts`
// (the auto-generated tauri-specta surface) has a corresponding
// handler in the in-browser tauri mock at `src/lib/tauri-mock/handlers.ts`.
//
// Why this exists: per-component vitest tests mock `invoke` explicitly,
// so the central tauri-mock can drift out of sync with the backend's
// command set without anyone noticing — until a Playwright run blows
// up on a "no handler" warning. This script catches the gap at the
// moment `bindings.ts` is regenerated, not weeks later in CI.
//
// Originally added after Phase 2 shipped `list_spaces` +
// `create_page_in_space` to the backend without any mock entries; the
// resulting silent `null` responses broke 11 Playwright tests across
// 7 spec files in the 0.1.0 release run.
//
// Usage: `node scripts/check-tauri-mock-parity.mjs`
// Exit code 0 = parity, 1 = missing handler(s), 2 = parser failure.
// Stale handlers (mocked but no longer in bindings.ts) are surfaced as
// warnings without failing the run.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const BINDINGS = path.join(ROOT, 'src/lib/bindings.ts')
const HANDLERS_DOMAIN_DIR = path.join(ROOT, 'src/lib/tauri-mock/handlers')

// ─── Known parity gaps ──────────────────────────────────────────────
// IPC commands intentionally NOT mocked. Each is a backend feature
// whose user-facing UI is either covered by per-component vitest
// suites with explicit `invoke` mocks, or exercises an OS-level
// integration (Unix socket, OAuth flow) that can't run inside the
// in-browser Playwright environment to begin with.
//
// Every entry here is a TODO: when an in-browser e2e flow needs to
// exercise the corresponding feature, add a real handler in
// `handlers.ts` and remove the entry from this list. The list should
// only ever shrink, never grow — adding a new IPC command without a
// handler means that command will silently return `null` to the UI.
const KNOWN_UNMOCKED = new Set([
  // (Empty — added mock handlers for the previous 15 entries
  // (5 GCal + 4 MCP RO + 4 MCP RW + trash_descendant_counts + quick_capture_block)
  // covering Google Calendar, MCP RO/RW, trash descendant counts, and
  // quick-capture. Re-introduce entries here only with a comment that
  // explains why an in-browser mock is impossible.)
])

const bindingsSrc = fs.readFileSync(BINDINGS, 'utf8')

// ─── 1. Parse bindings.ts → set of expected IPC command names ───────
//
// Every wrapper line emits `__TAURI_INVOKE("command_name", …)`. The
// matcher is intentionally narrow: literal double-quoted snake_case
// arg, no template literals, no concatenation. Anything else is a
// generated-code drift signal and should be reviewed by hand.
const expected = new Set()
for (const m of bindingsSrc.matchAll(/__TAURI_INVOKE\("([a-z][a-z0-9_]*)"/g)) {
  expected.add(m[1])
}
if (expected.size === 0) {
  console.error(
    `ERROR: parsed 0 IPC commands from ${BINDINGS} — parser is broken or file is empty.`,
  )
  process.exit(2)
}

// ─── 2. Parse the per-domain handler modules → set of mocked command names ──
//
// (#2931) `HANDLERS_TYPED` in `handlers.ts` used to be one inline object
// literal; it is now composed by spreading per-domain slices imported from
// `src/lib/tauri-mock/handlers/*.ts` (`blocks.ts`, `pages.ts`, …), each of
// the form `export const xHandlers = { … } satisfies Pick<TypedHandlers, …>`.
// `handlers.ts` itself no longer contains any command keys — only the
// `...xHandlers` spreads — so this script scans every domain module instead
// (everything in the `handlers/` dir except the non-command `shared.ts`
// helper/state module) and unions their top-level keys. This avoids false
// positives from object literals INSIDE a handler body (e.g. the
// `block_type:` key inside the row object that `create_block` returns) —
// top-level keys are indented at exactly 2 spaces in this file's style.
//
// (#2241) Each slice's trailing `satisfies Pick<TypedHandlers, …>` (and the
// barrel's `satisfies TypedHandlers` on the merged map) gives compile-time
// type linkage to `bindings.ts` (excess / missing / wrong-shape → tsc
// error), which this name-only script complements by also guarding the
// KNOWN_UNMOCKED allowlist and generated-code parse drift.
const domainFiles = fs
  .readdirSync(HANDLERS_DOMAIN_DIR)
  .filter((f) => f.endsWith('.ts') && f !== 'shared.ts')
if (domainFiles.length === 0) {
  console.error(`ERROR: found 0 domain handler modules in ${HANDLERS_DOMAIN_DIR}`)
  process.exit(2)
}
const mocked = new Set()
for (const file of domainFiles) {
  const src = fs.readFileSync(path.join(HANDLERS_DOMAIN_DIR, file), 'utf8')
  const blockMatch = src.match(
    /export const \w+Handlers\s*=\s*\{([\s\S]*?)\n\}\s*satisfies\s+Pick<\s*\n\s*TypedHandlers/,
  )
  if (!blockMatch) {
    console.error(
      `ERROR: could not locate a "…Handlers = { … } satisfies Pick<TypedHandlers" literal in ${file}`,
    )
    process.exit(2)
  }
  for (const m of blockMatch[1].matchAll(/^ {2}([a-z][a-z0-9_]*):\s/gm)) {
    mocked.add(m[1])
  }
}
if (mocked.size === 0) {
  console.error(
    `ERROR: parsed 0 handler keys from ${HANDLERS_DOMAIN_DIR}/*.ts — top-level indent assumption broken?`,
  )
  process.exit(2)
}

// ─── 3. Compute missing / extra ─────────────────────────────────────
const missingAll = [...expected].filter((c) => !mocked.has(c)).toSorted()
const missingNew = missingAll.filter((c) => !KNOWN_UNMOCKED.has(c))
const allowlistStale = [...KNOWN_UNMOCKED].filter((c) => !missingAll.includes(c)).toSorted()
const extra = [...mocked].filter((c) => !expected.has(c)).toSorted()

let exitCode = 0

if (missingNew.length > 0) {
  console.error('ERROR: new IPC commands have no tauri-mock handler:')
  for (const cmd of missingNew) console.error(`  - ${cmd}`)
  console.error('')
  console.error(
    'Add a handler in the appropriate src/lib/tauri-mock/handlers/*.ts domain module for each, or extend the mock seed in seed.ts.',
  )
  console.error(
    'Without these, in-browser e2e flows hit `[tauri-mock] Unhandled command` and silently get `null`.',
  )
  console.error(
    'If the feature genuinely cannot be exercised in Playwright (e.g. OS-level sockets, OAuth),',
  )
  console.error(
    'add the command to the KNOWN_UNMOCKED set at the top of this script with a comment explaining why.',
  )
  exitCode = 1
}

if (allowlistStale.length > 0) {
  console.warn(
    'WARN: KNOWN_UNMOCKED contains entries that are no longer in bindings.ts (clean up the allowlist):',
  )
  for (const cmd of allowlistStale) console.warn(`  - ${cmd}`)
}

if (extra.length > 0) {
  console.warn('WARN: tauri-mock has handlers for commands no longer referenced in bindings.ts:')
  for (const cmd of extra) console.warn(`  - ${cmd}`)
  console.warn('Safe to remove unless they back deprecated test paths.')
}

if (exitCode === 0) {
  const allowlisted = missingAll.length
  console.log(
    `OK: ${expected.size - allowlisted}/${expected.size} IPC commands mocked, ${allowlisted} on the KNOWN_UNMOCKED allowlist.`,
  )
}

process.exit(exitCode)
