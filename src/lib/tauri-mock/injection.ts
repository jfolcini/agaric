/**
 * Error and latency injection — lets E2E tests force any mock command to throw
 * or answer late. Kept in a tiny dedicated module so tests and the dispatch
 * layer share the same in-memory state without routing through seed state.
 *
 * #2251 — an injection can be either:
 *   - a plain `string`: thrown as `new Error(message)` (a non-IPC-shaped
 *     failure, exercising the generic error paths), or
 *   - a structured `AppError`: thrown as the raw `{ kind, message, code? }`
 *     wire object, exactly like a real Tauri command rejection, so specs can
 *     drive kind/code-discriminated paths (e.g. the SearchPanel inline
 *     `InvalidRegex` alert). The `AppError` type pins `kind` and `code` to
 *     the specta-generated unions — a typo'd injection fails type-checking.
 */

import type { AppError } from '@/lib/bindings'

const injectedErrors = new Map<string, string | AppError>()

export function injectMockError(command: string, error: string | AppError): void {
  injectedErrors.set(command, error)
}

export function clearMockErrors(): void {
  injectedErrors.clear()
}

/** Return the injected error for `cmd`, or `undefined` if none. */
export function getInjectedError(cmd: string): string | AppError | undefined {
  return injectedErrors.get(cmd)
}

let latencyMs = 0

/**
 * Answer every mock command `ms` later, as a real backend round trip does, so a
 * spec can race a handler that awaits an IPC and then moves the editor (#6559).
 * `0`, the default, answers synchronously, as the mock always has.
 */
export function setMockLatency(ms: number): void {
  latencyMs = ms
}

export function getMockLatency(): number {
  return latencyMs
}
