# Playwright e2e patterns

> E2E tests against the Vite dev server (not the Tauri runtime). Root [`src/__tests__/AGENTS.md`](../src/__tests__/AGENTS.md) covers cross-cutting conventions. This file covers what's specific to `e2e/*.spec.ts`.

## Configuration

The authoritative values live in [`playwright.config.ts`](../playwright.config.ts) — read it rather than trusting numbers copied here (the repo's no-counts rule: counts drift).

- **Test dir:** `e2e/` (the `.spec.ts` files in this folder).
- **Browser:** Chromium only.
- **Base URL:** `http://localhost:5173`.
- **Dev server:** auto-started via `npm run dev`; reused if already running (not in CI — `reuseExistingServer: !CI`).
- **Retries:** retried both in CI and locally (`retries`); the local pre-push umbrella is the real gate, so mirroring CI's retry keeps a one-off overlay-timing hiccup from rejecting a green tree.
- **Workers:** capped per shard (`workers`); CI shards the playwright job, so effective CI parallelism is `shards × workers`. Local has no sharding, so the cap keeps the single shared Vite dev server responsive.
- **Tracing:** on first retry.
- **Global expect timeout:** set in `playwright.config.ts`'s `expect.timeout` (absorbs overlay-mount jitter under load; no per-assertion overrides needed).

## Mock backend

E2E runs against the Vite dev server, not the Tauri runtime. `src/lib/tauri-mock.ts` auto-activates when `window.__TAURI_INTERNALS__` is absent and provides an in-memory store with seed data. State resets on page reload — tests use `page.reload()` to verify isolation.

Coverage includes `list_page_links` (scans seed data for `[[ULID]]` links), `import_markdown` (heading parsing + block splitting), template seed data with variable blocks. Exports `SEED_IDS` for deterministic references and `resetMock()` for cleanup.

## Patterns

```ts
test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('header').getByText('Journal')).toBeVisible()
})

test('creates a block via the input form', async ({ page }) => {
  const input = page.getByPlaceholder('Write something...')
  await input.fill('Hello, world!')
  await input.press('Enter')
  await expect(page.getByText('Hello, world!')).toBeVisible()
})
```

No page objects — tests are flat and direct. Use `data-testid` selectors (not CSS classes) for stable targeting.

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
- **`reopenPage(page)`** — navigate away and back to force a `BlockTree` re-fetch from the mock backend, confirming the undo actually persisted (not just visual).
- Wait for `"Undone"` / `"Redone"` toast text to confirm the action fired before asserting on block count.

## Console error check

```ts
test('no console errors on load', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
  await page.goto('/')
  const realErrors = errors.filter(e => !e.includes('favicon'))
  expect(realErrors).toEqual([])
})
```

## Header label selection — don't use the generic `header > getByText` pattern

A page-level `<FeaturePageHeader>` renders an `<h1>` with the same text as the App-shell `<header>`'s `data-testid="header-label"` span. The generic locator hits both, triggering strict-mode violations on slow runners. **Use `page.getByTestId('header-label')`** to target the App-shell header label unambiguously. The `editor-lifecycle.spec.ts` `navigates between sidebar views` test is the reference.
