/**
 * Tauri mock — command dispatch layer.
 *
 * Every mocked command has a handler in `HANDLERS`, keyed by command name. The
 * handler receives the raw IPC args object and returns the mock response (or
 * throws to surface an error to callers). `dispatch()` is the single entry
 * point used by `setupMock()`.
 *
 * Converting the previous switch/case chain to a map makes coverage auditable:
 * `Object.keys(HANDLERS)` is the canonical list of mocked commands and can be
 * diffed against the real backend's command surface in `src/lib/bindings.ts`.
 *
 * ---------------------------------------------------------------------------
 * MODULE LAYOUT (#2931)
 * ---------------------------------------------------------------------------
 *
 * This file is a thin BARREL. The ~140 command handlers that used to live
 * inline in one `HANDLERS_TYPED` object literal now live in per-domain
 * modules under `handlers/` (`handlers/blocks.ts`, `handlers/pages.ts`, …),
 * each exporting a `satisfies Pick<TypedHandlers, …>`-checked slice of the
 * command surface. This file just imports every slice and spreads them into
 * the single `HANDLERS_TYPED` map below — the exported shape (`HANDLERS`,
 * `PLUGIN_HANDLERS`, `dispatch`, …) is unchanged, so no importer needs to
 * change.
 *
 * All shared mutable mock state (`blocks`, `opLog`, `properties`, …) lives in
 * `@/lib/tauri-mock/seed` — the domain modules and this barrel all import
 * that SAME module, so there is exactly one instance of each store (ES
 * module resolution caches `seed.ts`; there is no per-domain duplication).
 * Cross-domain pure helpers and types (`appErrorRejection`, `TypedHandlers`,
 * `PageMetaRow`, …) live in `handlers/shared.ts`, imported the same way.
 *
 * `HANDLERS_TYPED` is deliberately NOT type-annotated: an outer
 * `: Record<string, Handler>` would strip the object literal's "freshness",
 * degrading `satisfies TypedHandlers` to a plain assignability check that
 * would silently ignore excess keys and, via the index signature, mask
 * missing ones. Keeping the merged literal fresh is what lets tsc report a
 * command missing from every domain slice, or a stray/duplicate key, as a
 * type error instead of a silent gap.
 */

import { logger } from '@/lib/logger'
import { attachmentsHandlers } from '@/lib/tauri-mock/handlers/attachments'
import { blocksHandlers } from '@/lib/tauri-mock/handlers/blocks'
import { historyHandlers } from '@/lib/tauri-mock/handlers/history'
import { linksHandlers } from '@/lib/tauri-mock/handlers/links'
import { pagesHandlers } from '@/lib/tauri-mock/handlers/pages'
import { propertiesHandlers } from '@/lib/tauri-mock/handlers/properties'
import { searchHandlers } from '@/lib/tauri-mock/handlers/search'
import {
  clipboardReadText,
  clipboardWriteText,
  type Handler,
  returnNull,
  type TypedHandlers,
} from '@/lib/tauri-mock/handlers/shared'
import { syncHandlers } from '@/lib/tauri-mock/handlers/sync'
import { systemHandlers } from '@/lib/tauri-mock/handlers/system'
import { tagsHandlers } from '@/lib/tauri-mock/handlers/tags'
import { attachmentBytes } from '@/lib/tauri-mock/seed'

// Re-exported for the small set of external consumers that import these
// directly off `handlers.ts` (test-only page-metadata conformance suites) —
// see `handlers/shared.ts` for the implementations. Moving them there did
// not change this file's public surface.
export type { PageMetaRow } from '@/lib/tauri-mock/handlers/shared'
export {
  compareMetaRows,
  encodeNextCursor,
  metaRowMatchesExpr,
  metaRowMatchesFilter,
} from '@/lib/tauri-mock/handlers/shared'

const HANDLERS_TYPED = {
  ...blocksHandlers,
  ...pagesHandlers,
  ...tagsHandlers,
  ...linksHandlers,
  ...historyHandlers,
  ...searchHandlers,
  ...propertiesHandlers,
  ...syncHandlers,
  ...attachmentsHandlers,
  ...systemHandlers,
} satisfies TypedHandlers

/**
 * Handlers for raw-byte-response commands (#2654). These return a
 * `tauri::ipc::Response` on the Rust side, so tauri-specta emits NO `commands.*`
 * binding for them and they cannot be part of the `satisfies TypedHandlers`
 * literal (which is keyed off `typeof commands`). They are still routed by
 * `dispatch()` and appear in `Object.keys(HANDLERS)`, so the mock-drift test
 * allowlists them via `RAW_RESPONSE_COMMANDS`. `read_attachment` returns an
 * ArrayBuffer, matching what `invoke` resolves for a real raw-byte response.
 */
const RAW_RESPONSE_HANDLERS: Record<string, Handler> = {
  read_attachment: (args) => {
    const a = args as Record<string, unknown>
    const bytes = attachmentBytes.get(a['attachmentId'] as string) ?? []
    return new Uint8Array(bytes).buffer
  },
}

export const HANDLERS: Record<string, Handler> = { ...HANDLERS_TYPED, ...RAW_RESPONSE_HANDLERS }

// ---------------------------------------------------------------------------
// Plugin commands (`plugin:<name>|<command>`) — #760
// ---------------------------------------------------------------------------
//
// `mockIPC` routes EVERY invoke through `dispatch`, including the
// `plugin:*`-prefixed commands emitted by the `@tauri-apps/plugin-*` JS
// APIs. The real runtime REJECTS an invoke against an unregistered
// plugin ("plugin <name> not found"), so the mock must not silently
// resolve `null` for them — that response is neither a desktop success
// nor a mobile rejection, and it left the designed degradation branches
// (AutostartRow's rejection→hide, `ensureNotificationPermission`'s
// catch→`false`) unexercised in browser dev / Playwright.
//
// The map below is the explicit allowlist of plugin commands the mock
// DOES model — plugins that are registered unconditionally in
// `src-tauri/src/lib.rs` (or are part of Tauri core) and whose success
// response the browser harness depends on. Everything else
// `plugin:`-prefixed throws from `dispatch`, mirroring the real
// runtime's rejection so callers exercise their catch paths.
//
// Deliberately NOT modeled (the rejection IS the designed behavior):
//   - `plugin:autostart|*` — AutostartRow hides the row on rejection
//     (mobile / browser-dev path; see `src/components/settings/AutostartRow.tsx`).
//   - `plugin:notification|*` — `ensureNotificationPermission` resolves
//     `false` when the plugin is unavailable.
//   - `plugin:updater|*` — `runUpdateCheckInner` logs and bails; a `null`
//     response would instead fake a successful "no update" round-trip.
//   - `plugin:process|*` — `relaunchApp` degrades to
//     `window.location.reload()`, the correct browser-mode analog.

/** Monotonic id for `plugin:event|listen` — the real handler returns an event id. */
let nextEventListenerId = 1

export const PLUGIN_HANDLERS: Record<string, Handler> = {
  // Core event system — `listen()` / `emit()` from `@tauri-apps/api/event`
  // back every frontend event hook; the real runtime always has them.
  //
  // #2683 — DEAD in the actual app / e2e runtime: `setupMock()`
  // (`index.ts`) now calls `mockIPC(cb, { shouldMockEvents: true })`, and
  // `@tauri-apps/api/mocks` intercepts every `plugin:event|*` command
  // (`listen`, `unlisten`, `emit`, AND `emit_to`) before `cb` — and
  // therefore this `dispatch()` map — is ever reached. These four entries
  // only still run when something calls `dispatch()` directly, bypassing
  // `mockIPC` (as `dispatch-plugin-commands.test.ts` does, to unit-test
  // this stub behavior in isolation) — never during `setupMock()`'s normal
  // browser/e2e path. Kept rather than deleted so `dispatch()` still
  // answers sanely if a future caller ever invokes it with
  // `shouldMockEvents` off. The real event bus lives in `index.ts`'s
  // `mockIPC(...)` call.
  'plugin:event|listen': () => nextEventListenerId++,
  'plugin:event|unlisten': returnNull,
  'plugin:event|emit': returnNull,
  'plugin:event|emit_to': returnNull,
  // Core app plugin — `addPluginListener('app', 'back-button', …)` in
  // `useAndroidBackButton` (allowed by `core:app:default` everywhere).
  'plugin:app|register_listener': returnNull,
  'plugin:app|remove_listener': returnNull,
  // Core window plugin — `setWindowTitle` re-stamps the OS title on every
  // space switch.
  'plugin:window|set_title': returnNull,
  // Deep-link is registered on desktop AND mobile; `null` is the real
  // "launched normally, no pending URL" response for `getCurrent()`.
  'plugin:deep-link|get_current': returnNull,
  // Clipboard / opener / shell are registered on desktop AND mobile;
  // copy-link and external-link e2e flows rely on the success path.
  'plugin:clipboard-manager|write_text': clipboardWriteText,
  'plugin:clipboard-manager|read_text': clipboardReadText,
  'plugin:shell|open': returnNull,
  'plugin:opener|open_url': returnNull,
  // Global-shortcut is desktop-only but the browser harness emulates a
  // desktop UA, where registration succeeds — modeling success keeps the
  // Settings quick-capture chord probe (`QuickCaptureRow`) usable in
  // browser dev.
  'plugin:global-shortcut|register': returnNull,
  'plugin:global-shortcut|unregister': returnNull,
  'plugin:global-shortcut|is_registered': () => false,
}

/**
 * Dispatch an IPC command to its handler.
 *
 * Resolution order:
 *  1. `HANDLERS` — the mocked app-command surface (parity-checked against
 *     `src/lib/bindings.ts` by `scripts/check-tauri-mock-parity.mjs`).
 *  2. `PLUGIN_HANDLERS` — explicitly modeled `plugin:*` commands.
 *  3. Any other `plugin:*` command THROWS, mirroring the real runtime's
 *     "plugin <name> not found" rejection for unregistered plugins (#760).
 *  4. Any other unknown command logs a warning via the structured logger
 *     and returns `null` (mock-drift signal, FE-H-13).
 */
export function dispatch(cmd: string, args: unknown): unknown {
  const handler = HANDLERS[cmd] ?? PLUGIN_HANDLERS[cmd]
  if (!handler) {
    if (cmd.startsWith('plugin:')) {
      const pluginName = cmd.slice('plugin:'.length).split('|')[0] ?? cmd
      logger.warn('TauriMock', 'unmodeled plugin command — rejecting like the real runtime', {
        command: cmd,
      })
      throw new Error(`plugin ${pluginName} not found`)
    }
    logger.warn('TauriMock', 'unhandled command', { command: cmd })
    return null
  }
  return handler(args)
}
