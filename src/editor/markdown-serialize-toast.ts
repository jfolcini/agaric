/**
 * Toast wrapper around the markdown serializer's `onUnknownNode` callback.
 *
 * The serializer (`./markdown-serialize`) is dependency-free: it accepts an
 * optional `(type: string) => void` callback when it encounters a node it
 * does not know how to render. This file packages up the production wiring
 * (i18n + sonner + structured logger + per-session toast dedup) so call
 * sites can opt in by passing `notifyUnknownNodeTypeToast` to
 * `serialize(doc, notifyUnknownNodeTypeToast)`.
 *
 * Extracted from `markdown-serialize.ts` so the serializer's
 * "Zero external dependencies" header is accurate. The toast layer lives at
 * the call site now.
 */

import { notify } from '@/lib/notify'

import { t } from '../lib/i18n'
import { logger } from '../lib/logger'

/**
 * Module-scoped set of node types we've already toasted about this session.
 *
 * The serializer can be called many times per second on a typical doc; if
 * 100 unknown nodes appear we don't want to spam 100 toasts. This Set
 * rate-limits to one toast per `type` per session (process lifetime).
 *
 * `logger.warn` is still emitted on every occurrence — only the user-facing
 * toast is rate-limited.
 */
const toastedUnknownTypes = new Set<string>()

/** @internal — for tests only */
export function __resetSerializerToastsForTests(): void {
  toastedUnknownTypes.clear()
}

/**
 * Default `onUnknownNode` callback for `serialize(doc, …)` in production.
 *
 * Logs every occurrence and surfaces a (rate-limited) user-facing notify.
 */
export function notifyUnknownNodeTypeToast(type: string): void {
  logger.warn('serializer', `unknown node type: "${type}" — stripped`, { type })
  if (toastedUnknownTypes.has(type)) return
  toastedUnknownTypes.add(type)
  // The serializer is browser-only; sonner is mocked under vitest via the
  // global `vi.mock('sonner')` in `src/test-setup.ts`. A direct import is
  // safe and matches the rest of the codebase.
  try {
    notify.warning(t('editor.unknownNodeType', { type }))
  } catch (err) {
    // Defensive: if the toast layer is unavailable for any reason we still
    // want the serializer to succeed. The `logger.warn` already records the
    // dropped content for diagnostics.
    logger.warn('serializer', 'failed to surface unknown-node toast', { type }, err)
  }
}
