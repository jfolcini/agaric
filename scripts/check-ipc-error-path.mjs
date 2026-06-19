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
//   3. If neither exists, the component is a VIOLATION (#1270) — an
//      IPC-calling component with no test file at all is exactly the
//      most-at-risk case (a brand-new component that swallows IPC
//      failures with zero coverage). Previously this case landed in a
//      silent `skippedNoTest` bucket that did NOT fail the hook and was
//      hidden unless `CHECK_IPC_VERBOSE=1` was set, inverting the
//      guard's intent: the severe case sailed through while only the
//      milder "test exists but is incomplete" case was caught.
//
//      The legitimate "covered by a parent component's test file"
//      pattern (e.g. a subdirectory component exercised through its
//      parent's test, different basename → neither lookup hits) is
//      still supported, but ONLY via an explicit `NO_TEST_ALLOWLIST`
//      entry with a justification (see below). A bare missing test
//      file is no longer silently excused.
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
//        node scripts/check-ipc-error-path.mjs --self-test
// Exit:  0 = clean, 1 = at least one violation, 2 = repo layout / self-test
//        failure.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPONENTS_DIR = path.join(ROOT, 'src/components')
const TESTS_DIR = path.join(ROOT, 'src/components/__tests__')

// ─── No-test allowlist (#1270) ──────────────────────────────────────
//
// An IPC-calling component with NO resolvable test file is a violation
// (see the header). The ONLY sanctioned exception is a component whose
// IPC error path is genuinely exercised through a DIFFERENT test file
// (a parent component's test, a different basename → neither sibling
// nor top-level lookup hits). Each such case must be listed here with
// a justification so the gap is explicit and reviewable rather than
// silently swallowed.
//
// Keys are paths relative to the repo root (POSIX separators). The
// value is a human justification — keep it specific (which test file
// covers the rejection, which IPC call). An entry whose component no
// longer calls IPC, or no longer exists, is itself flagged as stale so
// the allowlist can't rot into a permanent free pass.
//
// This is INTENTIONALLY empty: the five components that previously sat
// in the silent skip bucket (ActivityFeed, HistoryRestoreDialog,
// HistoryRevertDialog, TagsModeBody, AutostartRow) were given real
// error-path tests in the #1270 PR rather than allowlisted.
const NO_TEST_ALLOWLIST = Object.freeze({
  // 'src/components/<sub>/Foo.tsx': 'Rejection of bar() exercised via Baz.test.tsx',
  'src/components/PageBrowser/add-filter/editors.tsx':
    'Internal editor sub-components of AddFilterPopover, only ever mounted through it. The single IPC call (listAllPagesInSpace in LinkTargetEditor) and its picker are driven via AddFilterPopover.test.tsx (relational-facets suite, #1478). Pure extraction in #1648 — no new IPC surface, the parent suite is the integration point.',
})

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
function listAllComponents(componentsDir = COMPONENTS_DIR) {
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
  visit(componentsDir)
  return out
}

/**
 * Resolve the candidate test file for a component, preferring a
 * sibling `__tests__/` (per MAINT-128 split convention) and falling
 * back to the top-level `src/components/__tests__/`. Returns `null`
 * if neither exists.
 */
function resolveTestPath(componentPath, testsDir = TESTS_DIR) {
  const baseName = path.basename(componentPath, '.tsx')
  const siblingDir = path.join(path.dirname(componentPath), '__tests__')
  const siblingTest = path.join(siblingDir, `${baseName}.test.tsx`)
  if (fs.existsSync(siblingTest)) return siblingTest
  const topLevelTest = path.join(testsDir, `${baseName}.test.tsx`)
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

// ─── analysis ───────────────────────────────────────────────────────

/**
 * Analyze IPC-calling components under `componentsDir` against the
 * given test dirs/allowlist. Pure(-ish) over the filesystem so the
 * self-test can drive it against a synthetic fixture tree without
 * touching the real repo. Returns `{ violations, missingTest,
 * staleAllowlist, checked }`.
 *
 * - `violations`    — test file exists but lacks a rejection pattern.
 * - `missingTest`   — IPC component with NO test file and NOT
 *                     allowlisted (#1270: the case that used to pass
 *                     silently; now a hard failure).
 * - `staleAllowlist` — allowlist entry whose component no longer calls
 *                     IPC (or no longer exists) — a dead free pass.
 * - `checked`       — components with valid rejection coverage.
 */
function analyze({ root, componentsDir, testsDir, allowlist }) {
  const violations = []
  const missingTest = []
  const checked = []
  const seenAllowlistKeys = new Set()

  for (const componentPath of listAllComponents(componentsDir)) {
    const src = fs.readFileSync(componentPath, 'utf8')
    if (!callsIpc(src)) continue

    const rel = toPosix(path.relative(root, componentPath))
    const testPath = resolveTestPath(componentPath, testsDir)

    if (testPath === null) {
      if (Object.hasOwn(allowlist, rel)) {
        // Explicitly excused: covered through a different test file.
        seenAllowlistKeys.add(rel)
        continue
      }
      // #1270: IPC-calling component with no test file at all and no
      // allowlist entry — the most-at-risk case. Hard failure.
      missingTest.push(rel)
      continue
    }

    const testSrc = fs.readFileSync(testPath, 'utf8')
    if (!hasRejectionCoverage(testSrc)) {
      violations.push({ component: rel, test: toPosix(path.relative(root, testPath)) })
    } else {
      checked.push(toPosix(path.relative(componentsDir, componentPath)))
    }
  }

  // Any allowlist key we never matched (component gone or no longer
  // calls IPC) is a stale free pass — flag it so the list self-prunes.
  const staleAllowlist = Object.keys(allowlist).filter((k) => !seenAllowlistKeys.has(k))

  return { violations, missingTest, staleAllowlist, checked }
}

function toPosix(p) {
  return p.split(path.sep).join('/')
}

// ─── main ───────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  runGuard()
}

function runGuard() {
  const { violations, missingTest, staleAllowlist, checked } = analyze({
    root: ROOT,
    componentsDir: COMPONENTS_DIR,
    testsDir: TESTS_DIR,
    allowlist: NO_TEST_ALLOWLIST,
  })

  let failed = false

  if (violations.length > 0) {
    failed = true
    console.error('ERROR: components calling Tauri invoke lack error-path test coverage:')
    for (const v of violations) {
      console.error(`  ${v.component}`)
      console.error(`    → ${v.test} has no mockRejected*/Promise.reject/throw-new-Error pattern`)
    }
  }

  if (missingTest.length > 0) {
    failed = true
    console.error('ERROR: components calling Tauri invoke have NO error-path test file (#1270):')
    for (const c of missingTest) console.error(`  ${c}`)
    console.error('')
    console.error('A brand-new IPC-calling component with zero tests is the highest-risk case:')
    console.error('it can swallow IPC failures (silent .catch, missing toast) entirely unseen.')
    console.error('Add a sibling/top-level test that mocks the IPC call to reject and asserts the')
    console.error('error path fires. If the rejection is genuinely covered through a DIFFERENT')
    console.error('test file (a parent component), add an explicit NO_TEST_ALLOWLIST entry with a')
    console.error('justification in scripts/check-ipc-error-path.mjs — do not leave it untested.')
  }

  if (staleAllowlist.length > 0) {
    failed = true
    console.error('ERROR: stale NO_TEST_ALLOWLIST entries (component gone / no longer calls IPC):')
    for (const k of staleAllowlist) console.error(`  ${k}`)
    console.error('Remove these entries from scripts/check-ipc-error-path.mjs.')
  }

  if (violations.length > 0) {
    console.error('')
    console.error('Per AGENTS.md:198, every component that calls Tauri invoke must have at')
    console.error('least one error-path test. Add a test that mocks the relevant IPC call to')
    console.error('reject, renders the component, and asserts the error path fires (toast,')
    console.error('banner, aria-live region — whatever the component does on failure). Use')
    console.error('one of these patterns:')
    console.error('  - vi.mocked(invoke).mockRejectedValueOnce(new Error(...))')
    console.error('  - mockedWrapper.mockRejectedValueOnce(new Error(...))')
    console.error('  - mockedInvoke.mockImplementation(async (cmd) => { throw ... })')
  }

  if (failed) process.exit(1)

  const allowlisted = Object.keys(NO_TEST_ALLOWLIST).length
  console.log(
    `OK: ${checked.length} component(s) with IPC use have rejection coverage` +
      (allowlisted > 0 ? ` (${allowlisted} covered via allowlisted parent test)` : ''),
  )
}

// ─── self-test ──────────────────────────────────────────────────────
//
// Drives analyze() against a synthetic component tree in a temp dir so
// we can assert the exit behavior #1270 demands: a no-test IPC
// component FAILS; a covered one PASSES; an allowlisted one PASSES; a
// stale allowlist entry FAILS.
function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-guard-selftest-'))
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  try {
    const componentsDir = path.join(tmp, 'src/components')
    const testsDir = path.join(componentsDir, '__tests__')
    fs.mkdirSync(testsDir, { recursive: true })
    fs.mkdirSync(path.join(componentsDir, 'sub'), { recursive: true })
    fs.mkdirSync(path.join(componentsDir, 'sub', '__tests__'), { recursive: true })

    const IPC_SRC = "import { foo } from '@/lib/tauri'\nexport const C = () => foo()\n"
    const NO_IPC_SRC = 'export const C = () => null\n'
    const COVERED_TEST = "it('rejects', () => { foo.mockRejectedValueOnce(new Error('x')) })\n"
    const NO_REJECT_TEST = "it('renders', () => { render(<C />) })\n"

    // 1. IPC component, no test file, not allowlisted → missingTest.
    fs.writeFileSync(path.join(componentsDir, 'NoTest.tsx'), IPC_SRC)
    // 2. IPC component with a covered top-level test → checked.
    fs.writeFileSync(path.join(componentsDir, 'Covered.tsx'), IPC_SRC)
    fs.writeFileSync(path.join(testsDir, 'Covered.test.tsx'), COVERED_TEST)
    // 3. IPC component with a test lacking a rejection → violation.
    fs.writeFileSync(path.join(componentsDir, 'Incomplete.tsx'), IPC_SRC)
    fs.writeFileSync(path.join(testsDir, 'Incomplete.test.tsx'), NO_REJECT_TEST)
    // 4. Non-IPC component, no test → ignored entirely.
    fs.writeFileSync(path.join(componentsDir, 'Plain.tsx'), NO_IPC_SRC)
    // 5. IPC component, no test, but allowlisted → excused.
    fs.writeFileSync(path.join(componentsDir, 'sub', 'Allowed.tsx'), IPC_SRC)

    const allowlist = { 'src/components/sub/Allowed.tsx': 'covered via Parent.test.tsx' }

    const r = analyze({ root: tmp, componentsDir, testsDir, allowlist })

    if (r.missingTest.includes('src/components/NoTest.tsx')) ok('no-test IPC component is flagged')
    else fail('no-test IPC component is flagged', `missingTest=${JSON.stringify(r.missingTest)}`)

    if (r.checked.includes('Covered.tsx')) ok('covered IPC component passes')
    else fail('covered IPC component passes', `checked=${JSON.stringify(r.checked)}`)

    if (r.violations.some((v) => v.component === 'src/components/Incomplete.tsx'))
      ok('incomplete test is a violation')
    else fail('incomplete test is a violation', `violations=${JSON.stringify(r.violations)}`)

    if (!r.missingTest.includes('src/components/Plain.tsx')) ok('non-IPC component is ignored')
    else fail('non-IPC component is ignored', 'Plain.tsx was flagged')

    if (!r.missingTest.includes('src/components/sub/Allowed.tsx'))
      ok('allowlisted component passes')
    else fail('allowlisted component passes', 'Allowed.tsx was flagged despite allowlist')

    if (r.staleAllowlist.length === 0) ok('matched allowlist entry is not stale')
    else fail('matched allowlist entry is not stale', JSON.stringify(r.staleAllowlist))

    // 6. Stale allowlist entry (component absent) → flagged.
    const r2 = analyze({
      root: tmp,
      componentsDir,
      testsDir,
      allowlist: { 'src/components/Ghost.tsx': 'no longer exists' },
    })
    if (r2.staleAllowlist.includes('src/components/Ghost.tsx'))
      ok('stale allowlist entry is flagged')
    else fail('stale allowlist entry is flagged', JSON.stringify(r2.staleAllowlist))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}
