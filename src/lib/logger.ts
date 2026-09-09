/**
 * Structured logging utility for the frontend.
 *
 * Thin wrapper around console.* with level filtering and structured format.
 * In dev mode, all levels are logged. In production, only warn and error.
 *
 * For warn/error levels, also fires a fire-and-forget IPC call to the Rust
 * backend's daily-rolling log file via the registered backend sink (see
 * `logger-transport.ts`). `tauri.ts` registers its `logFrontend` IPC call as
 * that sink at init; the indirection keeps this module from importing
 * `tauri.ts` (which imports the logger), breaking the old import cycle (#761).
 * Includes JS stack traces and optional cause chains for debugging.
 *
 * Format: [ISO-timestamp] [LEVEL] [module] message {optional JSON data}
 */

import { getLogBackendSink } from '@/lib/logger-transport'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let minLevel: LogLevel = import.meta.env.DEV ? 'debug' : 'warn'

export function setLogLevel(level: LogLevel) {
  minLevel = level
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[minLevel]
}

function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data)
  } catch {
    return '[unserializable]'
  }
}

function formatMessage(
  level: LogLevel,
  module: string,
  message: string,
  data?: Record<string, unknown>,
): string {
  const ts = new Date().toISOString()
  const base = `[${ts}] [${level.toUpperCase()}] [${module}] ${message}`
  return data ? `${base} ${safeStringify(data)}` : base
}

// ── Cause extraction ─────────────────────────────────────────────────────

interface CauseInfo {
  message: string
  stack?: string
}

/**
 * Extract a single cause entry from an unknown value.
 */
function extractSingleCause(cause: unknown): CauseInfo {
  if (cause instanceof Error) {
    return cause.stack ? { message: cause.message, stack: cause.stack } : { message: cause.message }
  }
  // Not just `'message' in cause`: a `message` that is itself an object
  // stringifies to `[object Object]`, the loss the fallback below prevents.
  if (
    cause &&
    typeof cause === 'object' &&
    typeof (cause as { message?: unknown }).message === 'string'
  ) {
    return { message: (cause as { message: string }).message }
  }
  // Every primitive has a `String()` form worth logging (a symbol only via
  // `String`, never a template — `${sym}` throws), so they are spelled out
  // positively: TypeScript cannot subtract `object` from `unknown`, and the
  // one case left over is the one that matters — an object with no `message`
  // logs as `[object Object]`, hiding the shape this chain exists to show.
  if (
    typeof cause === 'string' ||
    typeof cause === 'number' ||
    typeof cause === 'boolean' ||
    typeof cause === 'bigint' ||
    typeof cause === 'symbol' ||
    typeof cause === 'function'
  ) {
    return { message: String(cause) }
  }
  return { message: safeStringify(cause) }
}

/**
 * Extract a chain of cause entries, recursing up to `maxDepth` levels
 * through Error `.cause` properties.
 */
function extractCauseChain(cause: unknown, maxDepth = 3): CauseInfo[] {
  const chain: CauseInfo[] = []
  let current: unknown = cause
  for (let i = 0; i < maxDepth && current != null; i++) {
    chain.push(extractSingleCause(current))
    // Follow the .cause chain if present
    current = current instanceof Error ? current.cause : undefined
  }
  return chain
}

// ── Rate limiting ────────────────────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 5
const RATE_WINDOW_MS = 60_000
// Opportunistic eviction threshold: when the map grows beyond this, sweep
// expired entries in one pass. Amortized cost is bounded; under realistic
// workloads the map stabilizes well below this ceiling.
const RATE_LIMIT_MAP_SWEEP_THRESHOLD = 1000

/**
 * Check whether a log entry with the given module+message key is rate-limited.
 * Returns `true` when the entry should be suppressed.
 */
function isRateLimited(module: string, message: string): boolean {
  const key = `${module}:${message}`
  const now = Date.now()
  const entry = rateLimitMap.get(key)

  if (!entry || now >= entry.resetAt) {
    // Opportunistic sweep of expired entries — avoids unbounded growth for
    // Long-running sessions that churn `module:message` keys.
    if (rateLimitMap.size > RATE_LIMIT_MAP_SWEEP_THRESHOLD) {
      for (const [k, v] of rateLimitMap) {
        if (now >= v.resetAt) rateLimitMap.delete(k)
      }
    }
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return false
  }

  entry.count++

  if (entry.count === RATE_LIMIT + 1) {
    // Log a suppression notice on the exact transition
    const suppressMsg = `[rate-limit] suppressing further "${module}:${message}" entries for ${Math.ceil((entry.resetAt - now) / 1000)}s`
    console.warn(suppressMsg)
  }

  return entry.count > RATE_LIMIT
}

/**
 * Reset the rate-limit map. Exported for testing only.
 * @internal
 */
export function _resetRateLimits() {
  rateLimitMap.clear()
}

// ── IPC bridge ───────────────────────────────────────────────────────────

/**
 * Fire-and-forget IPC bridge to the Rust backend log.
 * Only called for warn/error levels. Gracefully falls back to console-only
 * when Tauri IPC is unavailable (browser dev mode, tests).
 */
function bridgeToBackend(
  level: string,
  module: string,
  message: string,
  stack?: string,
  context?: string,
  data?: Record<string, unknown>,
) {
  try {
    const sink = getLogBackendSink()
    if (sink && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      const serializedData = data ? safeStringify(data) : undefined
      // Fire-and-forget: logging to backend should not block or crash the app.
      // NOTE: Intentional sole exception to the "no silent catch" rule (AGENTS.md).
      // Logging the error here would recurse through the same IPC bridge.
      sink(level, module, message, stack, context, serializedData).catch(() => {})
    }
  } catch {
    // IPC unavailable — console-only fallback
  }
}

// ── Logger ───────────────────────────────────────────────────────────────

// `this: void` on every method: this is a namespace object, not a class, so a bare
// `logger.warn` reference detaches safely (`useIpcCommand` picks a level that way).
export const logger = {
  debug(this: void, module: string, message: string, data?: Record<string, unknown>) {
    // oxlint-disable-next-line eslint/no-console -- logger primitive — wraps console for app-wide structured logging
    if (shouldLog('debug')) console.debug(formatMessage('debug', module, message, data))
  },

  info(this: void, module: string, message: string, data?: Record<string, unknown>) {
    // oxlint-disable-next-line eslint/no-console -- logger primitive — wraps console for app-wide structured logging
    if (shouldLog('info')) console.info(formatMessage('info', module, message, data))
  },

  warn(
    this: void,
    module: string,
    message: string,
    data?: Record<string, unknown>,
    cause?: unknown,
  ) {
    if (!shouldLog('warn')) return
    if (isRateLimited(module, message)) return

    // Capture stack trace at call site
    const stack = cause instanceof Error && cause.stack ? cause.stack : new Error().stack
    const causeChain = cause != null ? extractCauseChain(cause) : []

    // Build console output
    const formatted = formatMessage('warn', module, message, data)
    if (causeChain.length > 0) {
      const causeStr = causeChain.map((c, i) => `  cause[${i}]: ${c.message}`).join('\n')
      console.warn(`${formatted}\n${causeStr}`)
    } else {
      console.warn(formatted)
    }

    // IPC bridge — fire and forget
    const context = causeChain.length > 0 ? JSON.stringify(causeChain) : undefined
    bridgeToBackend('warn', module, message, stack, context, data)
  },

  error(
    this: void,
    module: string,
    message: string,
    data?: Record<string, unknown>,
    cause?: unknown,
  ) {
    if (!shouldLog('error')) return
    if (isRateLimited(module, message)) return

    // Capture stack trace at call site
    const stack = cause instanceof Error && cause.stack ? cause.stack : new Error().stack
    const causeChain = cause != null ? extractCauseChain(cause) : []

    // Build console output
    const formatted = formatMessage('error', module, message, data)
    if (causeChain.length > 0) {
      const causeStr = causeChain.map((c, i) => `  cause[${i}]: ${c.message}`).join('\n')
      console.error(`${formatted}\n${causeStr}`)
    } else {
      console.error(formatted)
    }

    // IPC bridge — fire and forget
    const context = causeChain.length > 0 ? JSON.stringify(causeChain) : undefined
    bridgeToBackend('error', module, message, stack, context, data)
  },
}
