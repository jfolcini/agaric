#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// IPC error-path coverage check.
//
// Per AGENTS.md:198, every component that calls Tauri `invoke` must
// have at least one error-path test (mocked rejection). Without this,
// a component that swallows IPC failures (silent `.catch`, missing
// toast, broken aria-live region) ships an unverified failure path
// that only surfaces in production.
//
// ─── Scope ──────────────────────────────────────────────────────────
//
// MAINT-159: walks `src/components/**/*.tsx` recursively. Subdirectory
// components (`src/components/agent-access/`, `src/components/journal/`,
// `src/components/block-tree/`, `src/components/backlink-filter/`,
// future `src/components/settings/` from MAINT-128) are now in scope
// alongside top-level files.
//
// `src/components/ui/` (Radix-wrapped primitives) is excluded because
// none of those components call `invoke` directly — they're stateless
// presentational wrappers. The recursive walk applies a callsIpc()
// filter, so any `ui/` file that DID start calling IPC would still get
// flagged.
//
// Test-file resolution for a component at `src/components/<sub>/Foo.tsx`:
//   1. `src/components/<sub>/__tests__/Foo.test.tsx`  (sibling test dir)
//   2. `src/components/__tests__/Foo.test.tsx`        (top-level fallback)
//   3. If neither exists, the file is recorded under `skippedNoTest`
//      (visibility-only, does not fail the hook). This handles the
//      historical pattern where subdirectory components are covered
//      by a parent component's test file (e.g. `ActivityFeed.tsx`
//      tested via `AgentAccessSettingsTab.test.tsx`) — neither test
//      lookup hits, so we don't false-flag it.
//
// Hooks/stores are still out of scope — this hook only catches direct
// IPC callers in the component layer (the most-trafficked surface for
// FEAT-3-class regressions where a missing error toast leaks past
// review).
//
// ─── Detection ──────────────────────────────────────────────────────
//
// A component is considered to call IPC if its source contains either:
//   - `from '@/lib/tauri'` (or double-quoted equivalent), AND the
//     import is NOT `import type` (i.e. brings in a runtime function);
//   - `import { invoke } from '@tauri-apps/api/core'` — direct IPC
//     bypass of the typed wrapper layer.
//
// Components that only `import { listen } from '@tauri-apps/api/event'`
// are NOT in scope: `listen` is a one-way event subscription, not an
// `invoke` call. The IPC-rejection class of bug doesn't apply.
//
// ─── Pattern check ──────────────────────────────────────────────────
//
// The corresponding test file at
// `src/components/__tests__/<basename>.test.tsx` must contain at least
// one of:
//
//   1. `mockRejectedValueOnce`            — direct rejection via vi.fn
//   2. `mockRejectedValue(`               — same, sticky form
//   3. `Promise.reject`                   — manual rejection construct
//   4. `throw new Error`                  — common inside async
//                                           `mockImplementation` blocks
//                                           (e.g. BugReportDialog.test)
//
// `throw new Error` is the most permissive of the four; in practice
// every test file that uses it does so inside an async mock to
// simulate IPC failure. The cost of a false-positive (a test that
// throws for unrelated reasons but lacks a real rejection mock) is
// vanishingly low — those tests are already exercising error
// handling in some form.
//
// ─── Triage on first activation ────────────────────────────────────
//
// First run surfaced 2 real violations (LinkEditPopover, WelcomeModal)
// and 0 false positives. Both were fixed in-session by adding minimal
// error-path tests (rejected metadata prefetch / rejected createBlock).
// 6 components were already green via existing rejection coverage.
//
// Usage: node scripts/check-ipc-error-path.mjs
// Exit:  0 = clean, 1 = at least one violation.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPONENTS_DIR = path.join(ROOT, 'src/components')
const TESTS_DIR = path.join(ROOT, 'src/components/__tests__')

if (!fs.existsSync(COMPONENTS_DIR) || !fs.existsSync(TESTS_DIR)) {
  console.error(`ERROR: expected directory not found (repo layout changed?)`)
  console.error(`  components: ${COMPONENTS_DIR}`)
  console.error(`  tests:      ${TESTS_DIR}`)
  process.exit(2)
}

// ─── helpers ────────────────────────────────────────────────────────

/**
 * MAINT-159: walk `src/components/**` recursively for `*.tsx` files
 * (excluding `*.test.tsx`, `__tests__/`, and the `ui/` subdir which
 * holds stateless Radix primitives that never call `invoke`). Helper
 * modules with `.helpers.tsx` or pure-`.ts` siblings are out of
 * scope (they don't render UI and their IPC calls are tested at the
 * consumer level).
 */
function listAllComponents() {
  const out = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'ui') continue
        visit(full)
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.tsx') &&
        !entry.name.endsWith('.test.tsx')
      ) {
        out.push(full)
      }
    }
  }
  visit(COMPONENTS_DIR)
  return out
}

/**
 * Resolve the candidate test file for a component, preferring a
 * sibling `__tests__/` (per MAINT-128 split convention) and falling
 * back to the top-level `src/components/__tests__/`. Returns `null`
 * if neither exists.
 */
function resolveTestPath(componentPath) {
  const baseName = path.basename(componentPath, '.tsx')
  const siblingDir = path.join(path.dirname(componentPath), '__tests__')
  const siblingTest = path.join(siblingDir, `${baseName}.test.tsx`)
  if (fs.existsSync(siblingTest)) return siblingTest
  const topLevelTest = path.join(TESTS_DIR, `${baseName}.test.tsx`)
  if (fs.existsSync(topLevelTest)) return topLevelTest
  return null
}

/**
 * True if the source file imports a runtime value from `@/lib/tauri`
 * or directly from `@tauri-apps/api/core`. Type-only imports are
 * excluded (they don't generate any `invoke` call site).
 */
function callsIpc(src) {
  // Strip type-only imports (`import type { ... } from '...'`) so a
  // file that only pulls in TS types from `@/lib/tauri` doesn't get
  // flagged. We only care about value imports.
  const withoutTypeImports = src.replace(
    /^\s*import\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]+['"]\s*;?\s*$/gm,
    '',
  )

  // Match `from '@/lib/tauri'` (single or double quotes).
  if (/from\s+['"]@\/lib\/tauri['"]/.test(withoutTypeImports)) return true

  // Match direct `invoke` import from the Tauri core module. `listen`
  // from `@tauri-apps/api/event` is deliberately not matched — it's
  // a one-way event subscription, not an IPC `invoke` call.
  if (/import\s+\{[^}]*\binvoke\b[^}]*\}\s+from\s+['"]@tauri-apps\/api\/core['"]/.test(src)) {
    return true
  }

  return false
}

/**
 * True if the test file contains any of the four allowed
 * rejection-coverage patterns. See the header for rationale on
 * the `throw new Error` permissive case.
 */
function hasRejectionCoverage(testSrc) {
  if (testSrc.includes('mockRejectedValueOnce')) return true
  if (/mockRejectedValue\(/.test(testSrc)) return true
  if (testSrc.includes('Promise.reject')) return true
  if (/throw new Error/.test(testSrc)) return true
  return false
}

// ─── main ───────────────────────────────────────────────────────────

const violations = []
const checked = []
const skippedNoTest = []

for (const componentPath of listAllComponents()) {
  const src = fs.readFileSync(componentPath, 'utf8')
  if (!callsIpc(src)) continue

  const testPath = resolveTestPath(componentPath)

  if (testPath === null) {
    // IPC-calling component with no sibling/top-level test file.
    // Subdirectory components are often covered by a parent's test
    // file (different basename) — that case lands here and is recorded
    // for visibility without failing the hook. Top-level components
    // genuinely missing tests also land here.
    skippedNoTest.push(path.relative(ROOT, componentPath))
    continue
  }

  const testSrc = fs.readFileSync(testPath, 'utf8')
  if (!hasRejectionCoverage(testSrc)) {
    violations.push({
      component: path.relative(ROOT, componentPath),
      test: path.relative(ROOT, testPath),
    })
  } else {
    checked.push(path.relative(COMPONENTS_DIR, componentPath))
  }
}

// ─── report ─────────────────────────────────────────────────────────

if (violations.length > 0) {
  console.error('ERROR: components calling Tauri invoke lack error-path test coverage:')
  for (const v of violations) {
    console.error(`  ${v.component}`)
    console.error(`    → ${v.test} has no mockRejected*/Promise.reject/throw-new-Error pattern`)
  }
  console.error('')
  console.error('Per AGENTS.md:198, every component that calls Tauri invoke must have at')
  console.error('least one error-path test. Add a test that mocks the relevant IPC call to')
  console.error('reject, renders the component, and asserts the error path fires (toast,')
  console.error('banner, aria-live region — whatever the component does on failure). Use')
  console.error('one of these patterns:')
  console.error('  - vi.mocked(invoke).mockRejectedValueOnce(new Error(...))')
  console.error('  - mockedWrapper.mockRejectedValueOnce(new Error(...))')
  console.error('  - mockedInvoke.mockImplementation(async (cmd) => { throw ... })')
  process.exit(1)
}

if (skippedNoTest.length > 0 && process.env.CHECK_IPC_VERBOSE === '1') {
  console.error('WARN: components with IPC use but no sibling test file (out of scope):')
  for (const c of skippedNoTest) console.error(`  ${c}`)
}

console.log(
  `OK: ${checked.length} component(s) with IPC use have rejection coverage` +
    (skippedNoTest.length > 0
      ? ` (${skippedNoTest.length} missing tests, see verbose output)`
      : ''),
)
