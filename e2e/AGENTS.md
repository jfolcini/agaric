# Playwright e2e patterns

> E2E against a browser-served build with the JS tauri mock — not the Tauri runtime. Cross-cutting test conventions: [`src/__tests__/AGENTS.md`](../src/__tests__/AGENTS.md). Specs that need the real Rust backend live in `e2e-tauri/` (WebdriverIO + tauri-driver, [`wdio.conf.ts`](../wdio.conf.ts)).

## Configuration

Authoritative values are in [`playwright.config.ts`](../playwright.config.ts).

- Test dir `e2e/`, Chromium only, base URL `http://localhost:5173`.
- Web server: `npm run build:e2e && npm run preview:e2e` — a static production build served by `vite preview`. `VITE_E2E=1` keeps the tauri mock in the bundle (`src/main.tsx` gates the import on it); a plain prod build tree-shakes it out.

```sh
npm run test:e2e                              # whole suite
npx playwright test e2e/pages-view.spec.ts    # one spec
npx playwright test -g 'edits a block'        # one test by title
npm run test:e2e:ui                           # Playwright UI mode
npm run typecheck:e2e                         # tsc for this directory only
```

### Type-checking

`e2e/**/*.ts` belongs to [`tsconfig.e2e.json`](../tsconfig.e2e.json), referenced from `tsconfig.json`, so `tsc -b` (prek hook, CI typecheck, `npm run build`) covers it at `src/` strictness. `tsconfig.wdio.json` covers `e2e-tauri/`, not this directory. A new sibling TypeScript directory must be claimed by a project — verify with `npx tsc -p <cfg> --listFiles | grep -c "/<dir>/"`, since the editor type-checks files that no gate does.

### Kill any stale server on :5173 first

`reuseExistingServer` is on locally, so Playwright attaches to whatever already listens on :5173 — a leftover `npm run dev` or an older `vite preview` means the run tests the wrong bundle.

## Mock backend

`src/lib/tauri-mock/` is an in-memory backend that activates when `window.__TAURI_INTERNALS__` is absent (`src/lib/tauri-mock.ts` is a re-export shim). It seeds fixed pages and blocks, exports `SEED_IDS` and `resetMock()`, and resets on page reload — `page.reload()` is how specs verify persistence.

## The mock is a contract, not a convenience

`src/lib/tauri-mock/` is a hand-maintained second implementation of the Rust backend and drifts silently, so a Playwright green proves nothing about backend parity. The conformance harness does:

- **Every state-mutating handler must be pinned by a fixture** in `conformance/fixtures/`: ops replayed against a backend-authored `expected`, asserted by both `src-tauri/tests/command_integration/conformance.rs` and `src/lib/tauri-mock/__tests__/conformance.test.ts`.
- [`conformance-coverage.test.ts`](../src/lib/tauri-mock/__tests__/conformance-coverage.test.ts) is the ratchet: a new mutating command fails the suite unless it gains a fixture or a `NO_FIXTURE_ALLOWLIST` waiver with a written reason (stale or read-only waivers also fail).
- Workflow: write the fixture (seed + ops + optional `scenarios` tags) without `expected`, then:

  ```sh
  cd src-tauri && CONFORMANCE_UPDATE=1 cargo nextest run -E 'test(conformance_fixtures_match_backend)'
  npx vitest run src/lib/tauri-mock
  ```

  Red `conformance.test.ts` means the mock diverges: fix `src/lib/tauri-mock/handlers.ts`, never the backend. A divergence unsafe to mirror becomes a `.skip` with a `// DRIFT(#763)` comment plus an issue.
- Real IPC round-trips: `e2e-tauri/` (`.github/workflows/e2e-tauri-weekly.yml`) and `src-tauri/tests/commands/`.
- Assert on re-queried settled state, not on which mock call fired — a `setProperty`-was-called assertion once passed while the tag vanished in the real backend.

## Patterns

Import `test` / `expect` and helpers from `./helpers`, not `@playwright/test`:

```ts
import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

test.beforeEach(async ({ page }) => { await waitForBoot(page) })   // goto('/') + wait for the shell

test('edits a block', async ({ page }) => {
  await openPage(page, 'Getting Started')
  await (await focusBlock(page, 0)).fill('Hello, world!')
  await expect(page.getByText('Hello, world!')).toBeVisible()
})
```

- No page objects: flat tests, shared behaviour in `e2e/helpers.ts`.
- Select with `data-testid` / `data-slot`, not CSS classes.
- `installIpcRecorder` / `getInvokeCalls` / `clearInvokeCalls` assert on IPC traffic.
- `fullyParallel` is on; a spec whose tests share global state sets `test.describe.configure({ mode: 'serial' })`.

## Portal-scoped helpers — critical for stable e2e

Radix portals mount to `document.body`; under parallel runs a vanilla `getByRole('dialog')` resolves to two elements or a stale subtree. Always use the `active*` helpers from `e2e/helpers.ts`, which scope to the newest portal via `.last()`:

| Helper | What it scopes |
|---|---|
| `activeDialog(page)` | `[data-slot="dialog-content"]` |
| `activeAlertDialog(page)` | `[data-slot="alert-dialog-content"]` |
| `activeSheet(page)` | `[data-slot="sheet-content"]` |
| `activePopover(page)` | `[data-slot="popover-content"]` |
| `activeMenu(page)` | `[role="menu"]` (block-context menu) |
| `activeRoleDialog(page)` | generic `[role="dialog"]` when no `data-slot` exists (e.g. `TemplatePicker`) |
| `activeSuggestionPopup(page)` | `[data-testid="suggestion-popup"]` (TipTap) |
| `activeSuggestionList(page)` | `[data-testid="suggestion-list"]` (its `role="listbox"` child) |

Check `e2e/helpers.ts` for the current set — it evolves.

## Undo / redo e2e helpers

Ctrl+Z depends on focus:

- `blurEditors(page)` — Escape out of `contentEditable` first, or Ctrl+Z hits ProseMirror's undo instead of `useUndoShortcuts`.
- `reopenPage(page, title)` — navigate away and back to force a `BlockTree` re-fetch, proving the undo persisted.
- Wait for the `"Undone"` / `"Redone"` toast before asserting.

## Console errors are asserted automatically

The `test` fixture from `./helpers` collects console + `pageerror` output and fails the spec in a global `afterEach` on anything not in its shared ignore list — so don't write a "no console errors" test or a hand-rolled `page.on('console', …)` listener. A spec that deliberately provokes an error asserts on `getConsoleErrors(page)` then calls `clearConsoleErrors(page)`; a benign error shared across specs goes in the ignore list in `e2e/helpers.ts`. Reference: `error-scenarios.spec.ts`.

## Horizontal-overflow assertion and the `data-overflow-clip` escape hatch

`expectNoHorizontalOverflow(page, target?, label?)` (`e2e/helpers.ts`) asserts a surface — a dialog/sheet locator, or the document when `target` is omitted — doesn't bleed past its right edge. `mobile-overflow.spec.ts` runs it across the app's views at phone widths; call it directly for a surface that renders differently on mobile.

It flags any descendant whose `getBoundingClientRect().right` exceeds the target's, judging `position: absolute` children against their CSS containing block (`position`, `transform`, Tailwind v4's `translate`/`scale`/`rotate` longhands, `filter`, `contain`, `content-visibility`, …) rather than their DOM parent. `container-type` is deliberately excluded; `fixed`/`sticky` descendants are skipped. Every entry has a paired fixture in `horizontal-overflow-helper.spec.ts` — add one when you change the list.

`data-overflow-clip="intentional"` marks a container whose `overflow-x: hidden|clip` is deliberate (fixed-width panel, thumbnail); its descendants are excluded like `overflow-x: auto|scroll` regions. The walk checks computed style, so the attribute alone does nothing. Never put it on `target` itself, and a `position: static` marker doesn't cover an absolutely-positioned descendant.

## Header label selection

`<FeaturePageHeader>` renders an `<h1>` with the same text as the App-shell `<header>`'s `data-testid="header-label"` span, so `header > getByText` hits both and trips strict mode. Use `page.getByTestId('header-label')` (reference: `editor-lifecycle.spec.ts`).
