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
// Originally added after FEAT-3 Phase 2 shipped `list_spaces` +
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
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BINDINGS = path.join(ROOT, 'src/lib/bindings.ts')
const HANDLERS = path.join(ROOT, 'src/lib/tauri-mock/handlers.ts')

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
  // Google Calendar integration (FEAT-5) — OAuth + remote API; covered
  // by GoogleCalendarSettingsTab.test.tsx with explicit per-call mocks.
  'disconnect_gcal',
  'force_gcal_resync',
  'get_gcal_status',
  'set_gcal_privacy_mode',
  'set_gcal_window_days',
  // MCP server (FEAT-4) — Unix-domain-socket lifecycle; covered by
  // AgentAccessSettingsTab.test.tsx with explicit per-call mocks.
  'get_mcp_rw_socket_path',
  'get_mcp_rw_status',
  'get_mcp_socket_path',
  'get_mcp_status',
  'mcp_disconnect_all',
  'mcp_rw_disconnect_all',
  'mcp_rw_set_enabled',
  'mcp_set_enabled',
  // Trash detail-count aggregator — used by the Trash header badge
  // only; per-page tests pass through a manual count fixture.
  'trash_descendant_counts',
  // FEAT-12: quick-capture is wired through the global-shortcut
  // plugin (OS-level keybinding) and the QuickCaptureDialog, both
  // mocked at the per-component level (QuickCaptureDialog.test.tsx,
  // SettingsView.test.tsx). No Playwright surface yet.
  'quick_capture_block',
])

const bindingsSrc = fs.readFileSync(BINDINGS, 'utf8')
const handlersSrc = fs.readFileSync(HANDLERS, 'utf8')

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

// ─── 2. Parse handlers.ts → set of mocked command names ─────────────
//
// Locate the `export const HANDLERS … = { … }` literal first, then
// pick out top-level keys. This avoids false positives from object
// literals INSIDE a handler body (e.g. the `block_type:` key inside
// the row object that `create_block` returns). Top-level keys are
// indented at exactly 2 spaces in this file's style.
const handlersBlockMatch = handlersSrc.match(/export const HANDLERS:[^{]*=\s*\{([\s\S]*?)\n\}\s*\n/)
if (!handlersBlockMatch) {
  console.error(`ERROR: could not locate HANDLERS object literal in ${HANDLERS}`)
  process.exit(2)
}
const mocked = new Set()
for (const m of handlersBlockMatch[1].matchAll(/^ {2}([a-z][a-z0-9_]*):\s/gm)) {
  mocked.add(m[1])
}
if (mocked.size === 0) {
  console.error(
    `ERROR: parsed 0 handler keys from ${HANDLERS} — top-level indent assumption broken?`,
  )
  process.exit(2)
}

// ─── 3. Compute missing / extra ─────────────────────────────────────
const missingAll = [...expected].filter((c) => !mocked.has(c)).sort()
const missingNew = missingAll.filter((c) => !KNOWN_UNMOCKED.has(c))
const allowlistStale = [...KNOWN_UNMOCKED].filter((c) => !missingAll.includes(c)).sort()
const extra = [...mocked].filter((c) => !expected.has(c)).sort()

let exitCode = 0

if (missingNew.length > 0) {
  console.error('ERROR: new IPC commands have no tauri-mock handler:')
  for (const cmd of missingNew) console.error(`  - ${cmd}`)
  console.error('')
  console.error(
    'Add a handler in src/lib/tauri-mock/handlers.ts for each, or extend the mock seed in seed.ts.',
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
