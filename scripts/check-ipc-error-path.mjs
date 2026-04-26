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
// HARD-NARROWED to top-level component files (`src/components/*.tsx`)
// for the first activation. Subdirectory components
// (`src/components/agent-access/`, `src/components/journal/`,
// `src/components/block-tree/`, `src/components/ui/`) are intentionally
// out of scope:
//
//   - axe-presence (the sibling MAINT-99 hook) uses the same
//     top-level-only scope, so the two hooks line up cleanly.
//   - Subdirectory components frequently route their tests through
//     the parent component's test file (e.g. ActivityFeed.tsx is
//     covered by AgentAccessSettingsTab.test.tsx, not a sibling file
//     of the same basename). A simple `<basename>.test.tsx` lookup
//     would false-flag these as missing rejection coverage.
//   - Broadening the hook later is a one-line change once those
//     subdirs grow their own `__tests__/` siblings (FOLLOW-UP).
//
// Hooks/stores are also out of scope — this hook only catches direct
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
 * Return the list of top-level `*.tsx` files in `src/components/` (no
 * recursion into subdirectories). Helper modules with `.helpers.tsx`
 * or pure-`.ts` siblings are out of scope (they don't render UI and
 * their IPC calls are tested at the consumer level).
 */
function listTopLevelComponents() {
  return fs
    .readdirSync(COMPONENTS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx'))
    .map((e) => path.join(COMPONENTS_DIR, e.name))
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

for (const componentPath of listTopLevelComponents()) {
  const src = fs.readFileSync(componentPath, 'utf8')
  if (!callsIpc(src)) continue

  const baseName = path.basename(componentPath, '.tsx')
  const testPath = path.join(TESTS_DIR, `${baseName}.test.tsx`)

  if (!fs.existsSync(testPath)) {
    // Top-level component with IPC use but no sibling test file.
    // This is a missing-test concern (out of scope for this hook;
    // axe-presence-style coverage would flag it on the test side).
    // We record it for visibility but don't fail.
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
    checked.push(baseName)
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
  `OK: ${checked.length} top-level component(s) with IPC use have rejection coverage` +
    (skippedNoTest.length > 0
      ? ` (${skippedNoTest.length} missing tests, see verbose output)`
      : ''),
)
