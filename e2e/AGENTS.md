# Playwright e2e patterns

> E2E against a browser-served build of the app with the JS tauri mock — not the Tauri runtime. Root [`src/__tests__/AGENTS.md`](../src/__tests__/AGENTS.md) covers cross-cutting conventions. This file covers what's specific to `e2e/*.spec.ts`. Specs that need the *real* Rust backend live in `e2e-tauri/` (WebdriverIO + tauri-driver, see [`wdio.conf.ts`](../wdio.conf.ts)).

## Configuration

The authoritative values live in [`playwright.config.ts`](../playwright.config.ts) — read it rather than trusting numbers copied here. The shape:

- **Test dir:** `e2e/`. **Browser:** Chromium only. **Base URL:** `http://localhost:5173`.
- **Web server:** `npm run build:e2e && npm run preview:e2e` — a *static production build* served by `vite preview`, not `vite dev`. `VITE_E2E=1` is what keeps the tauri mock in the bundle (`src/main.tsx` gates the mock import on it); a plain prod build tree-shakes the mock out. Moving off the HMR dev server was the #1458 fix for CI shard cascades.
- **Retries:** enabled locally as well as in CI (CI is lower — it amplified cascades). The local pre-push umbrella is the real gate, so mirroring a retry keeps a one-off overlay-timing hiccup from rejecting a green tree.
- **Workers:** capped per shard. CI shards the playwright job, so effective CI parallelism is `shards × workers`; locally there is no sharding, and the cap keeps the single shared preview server responsive.
- **Timeouts:** a per-test ceiling, a CI-only `globalTimeout` set *below* the CI job cap so the reporter still uploads before the runner kills the job, and `expect.timeout` sized to absorb overlay-mount jitter (no per-assertion overrides needed). Navigation and action bounds are set too — against a static build a `goto` resolves in well under a second, so a long bound only ever fires on a genuinely wedged server.
- **Tracing:** on first retry.

### ⚠️ Kill any stale server on :5173 first

`reuseExistingServer` is on locally, so Playwright will happily attach to **whatever** is already listening on :5173 instead of building your code. A leftover `npm run dev` from another worktree, or a `vite preview` of an older build, means the whole run tests the wrong bundle — producing false failures (or, worse, false greens) that look like spec flake. Kill the port before running e2e locally.

## Mock backend

`src/lib/tauri-mock/` provides an in-memory backend that activates when `window.__TAURI_INTERNALS__` is absent (`src/lib/tauri-mock.ts` is a thin re-export shim kept for older import paths). It seeds a small fixed set of pages and blocks, exports `SEED_IDS` for deterministic references and `resetMock()` for cleanup, and resets on page reload — so `page.reload()` is how specs verify persistence and isolation.

## The mock is a contract, not a convenience

`src/lib/tauri-mock/` is a hand-maintained **second implementation** of the Rust backend. It silently drifts (create_block page_id, purge_block cascade, reserved-key property routing, and the tag-space bug all shipped past a mock that looked fine), so treat it as a contract that must be proven equivalent to the real backend — not a rendering shim.

- **Every state-mutating handler must be pinned by a conformance fixture.** The #763 harness (`conformance/fixtures/*.json`) replays op sequences against a backend-authored `expected`, asserted from BOTH sides: `src-tauri/src/command_integration_tests/conformance.rs` (real backend) and `src/lib/tauri-mock/__tests__/conformance.test.ts` (mock). [`conformance-coverage.test.ts`](../src/lib/tauri-mock/__tests__/conformance-coverage.test.ts) (#3083) is the ratchet: a new mutating command fails the suite unless it gains a fixture or a `NO_FIXTURE_ALLOWLIST` waiver with a written reason. An `allowlist stays honest` self-check fails on stale, read-only, or now-covered waivers, so the escape hatch can't rot.
- **Conformance workflow.** Add a fixture to `conformance/fixtures/` (seed + ops + optional `scenarios` string tags). NEVER hand-write `expected` — the backend authors it: `CONFORMANCE_UPDATE=1 cargo nextest run -E 'test(conformance_fixtures_match_backend)'` (from `src-tauri/`) writes the backend-derived snapshot back into the JSON. Then run `npx vitest run src/lib/tauri-mock` — a red `conformance.test.ts` means the mock diverges; fix `handlers.ts` (never change the backend to match the mock; a subtle, unsafe-to-mirror divergence is left as a `// DRIFT(#763)` skip + issue).
- **A Playwright green does not prove backend parity.** These specs run against the **mock**, so they cannot catch a mock↔backend divergence on their own — that is the conformance harness's job. Real round-trips over live Tauri IPC are covered by the `e2e-tauri/*.e2e.ts` WebdriverIO harness (#155, driven by `.github/workflows/e2e-tauri-weekly.yml`) and at the command-inner boundary in `src-tauri/src/commands/tests/`.
- **The tag-space failure.** The mock modeled a **retired** schema (`block_properties(key='space')`); a UI test asserted `setProperty` was called and passed, while the tag vanished in the real backend. A conformance fixture that re-queries the settled tag state is what catches this class.

## Patterns

Specs import `test` / `expect` and the shared helpers from `./helpers`, not from `@playwright/test` directly:

```ts
import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)   // goto('/') + wait for the shell to be interactive
})

test('edits a block', async ({ page }) => {
  await openPage(page, 'Getting Started')
  const editor = await focusBlock(page, 0)
  await editor.fill('Hello, world!')
  await expect(page.getByText('Hello, world!')).toBeVisible()
})
```

No page objects — tests are flat and direct, with shared behavior factored into `e2e/helpers.ts`. Target with `data-testid` / `data-slot` selectors, not CSS classes. `installIpcRecorder` / `getInvokeCalls` / `clearInvokeCalls` are available when a spec needs to assert on the IPC traffic a UI action produced.

Specs whose tests share global state (op-log, pairing mock, kebab popover chains) annotate the suite with `test.describe.configure({ mode: 'serial' })` — `fullyParallel` is on otherwise.

## Portal-scoped helpers — critical for stable e2e

Radix portals mount overlays to `document.body`, outside the React tree. Parallel test runs and overlapping mount/unmount cycles make vanilla `getByRole('dialog')` queries flake: they resolve to two elements (strict-mode violation) or hit a stale subtree first. **Always use the `active*` helpers from `e2e/helpers.ts`** — they scope to the most-recently-opened portal via `.last()`:

| Helper | What it scopes |
|---|---|
| `activeDialog(page)` | `[data-slot="dialog-content"]` (Radix Dialog) |
| `activeAlertDialog(page)` | `[data-slot="alert-dialog-content"]` (Radix AlertDialog) |
| `activeSheet(page)` | `[data-slot="sheet-content"]` (Radix Sheet) |
| `activePopover(page)` | `[data-slot="popover-content"]` (Radix Popover) |
| `activeMenu(page)` | `[role="menu"]` (custom block-context menu) |
| `activeRoleDialog(page)` | generic `[role="dialog"]` — use when a tighter `data-slot` match isn't available (e.g. `TemplatePicker`) |
| `activeSuggestionPopup(page)` | `[data-testid="suggestion-popup"]` (TipTap suggestion container) |
| `activeSuggestionList(page)` | `[data-testid="suggestion-list"]` (the `role="listbox"` child) |

```ts
import { activeDialog, expect, test } from './helpers'

await page.getByRole('button', { name: 'Settings' }).click()
await expect(activeDialog(page).getByRole('button', { name: 'Apply' })).toBeVisible()
```

Verify the exact set + names against `e2e/helpers.ts` before relying on this list — the helpers evolve.

## Undo / redo e2e helpers

Ctrl+Z behaves differently depending on focus, so two helpers are required:

- **`blurEditors(page)`** — press Escape to leave `contentEditable` focus. Without this, Ctrl+Z triggers ProseMirror's in-editor undo instead of the page-level `useUndoShortcuts` handler.
- **`reopenPage(page, title)`** — navigate away and back to force a `BlockTree` re-fetch from the mock backend, confirming the undo actually persisted rather than just repainted.
- Wait for the `"Undone"` / `"Redone"` toast text to confirm the action fired before asserting on block count.

## Console errors are asserted automatically

The `test` fixture exported from `./helpers` registers a console + `pageerror` watcher in a global `beforeEach` and asserts it in a global `afterEach`, filtering known-benign noise through one shared pattern list. **Any unexpected console error fails the spec** — you do not write a "no console errors" test, and you must not hand-roll a `page.on('console', …)` listener.

A spec that *deliberately* provokes an error clears the buffer instead of suppressing the check:

```ts
import { clearConsoleErrors, getConsoleErrors, test } from './helpers'

// …trigger the expected failure…
expect(getConsoleErrors(page).some((e) => e.includes('…'))).toBe(true)
clearConsoleErrors(page)   // otherwise the global afterEach fails the test
```

If a genuinely benign error is unavoidable across specs, add it to the ignore-pattern list in `e2e/helpers.ts` rather than clearing it per test. `error-scenarios.spec.ts` is the reference.

## Header label selection — don't use the generic `header > getByText` pattern

A page-level `<FeaturePageHeader>` renders an `<h1>` with the same text as the App-shell `<header>`'s `data-testid="header-label"` span. The generic locator hits both, triggering strict-mode violations on slow runners. **Use `page.getByTestId('header-label')`** to target the App-shell header label unambiguously. The `editor-lifecycle.spec.ts` `navigates between sidebar views` test is the reference.
