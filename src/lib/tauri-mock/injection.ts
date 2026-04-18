/**
 * Error injection — lets E2E tests force any mock command to throw. Kept in a
 * tiny dedicated module so tests and the dispatch layer share the same
 * in-memory map without routing through seed state.
 */

const injectedErrors = new Map<string, string>()

export function injectMockError(command: string, message: string): void {
  injectedErrors.set(command, message)
}

export function clearMockErrors(): void {
  injectedErrors.clear()
}

/** Return the injected error message for `cmd`, or `undefined` if none. */
export function getInjectedError(cmd: string): string | undefined {
  return injectedErrors.get(cmd)
}

/** Whether `cmd` currently has an injected error. */
export function hasInjectedError(cmd: string): boolean {
  return injectedErrors.has(cmd)
}
