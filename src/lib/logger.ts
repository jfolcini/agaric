/**
 * Structured logging utility for the frontend.
 *
 * Thin wrapper around console.* with level filtering and structured format.
 * In dev mode, all levels are logged. In production, only warn and error.
 *
 * For warn/error levels, also fires a fire-and-forget IPC call to the Rust
 * backend's daily-rolling log file via `logFrontend()`. Includes JS stack
 * traces and optional cause chains for debugging.
 *
 * Format: [ISO-timestamp] [LEVEL] [module] message {optional JSON data}
 */

import { logFrontend } from './tauri'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let minLevel: LogLevel = import.meta.env.DEV ? 'debug' : 'warn'

export function setLogLevel(level: LogLevel) {
  minLevel = level
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[minLevel]
}

function safeStringify(data: Record<string, unknown>): string {
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
function extractSingleCause(cause: unknown): CauseInfo | null {
  if (cause instanceof Error) {
    return cause.stack ? { message: cause.message, stack: cause.stack } : { message: cause.message }
  }
  if (cause && typeof cause === 'object' && 'message' in cause) {
    return { message: String((cause as { message: unknown }).message) }
  }
  return cause != null ? { message: String(cause) } : null
}

/**
 * Extract a chain of cause entries, recursing up to `maxDepth` levels
 * through Error `.cause` properties.
 */
function extractCauseChain(cause: unknown, maxDepth = 3): CauseInfo[] {
  const chain: CauseInfo[] = []
  let current: unknown = cause
  for (let i = 0; i < maxDepth && current != null; i++) {
    const info = extractSingleCause(current)
    if (!info) break
    chain.push(info)
    // Follow the .cause chain if present
    current = current instanceof Error ? current.cause : undefined
  }
  return chain
}

// ── Rate limiting ────────────────────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 5
const RATE_WINDOW_MS = 60_000

/**
 * Check whether a log entry with the given module+message key is rate-limited.
 * Returns `true` when the entry should be suppressed.
 */
function isRateLimited(module: string, message: string): boolean {
  const key = `${module}:${message}`
  const now = Date.now()
  const entry = rateLimitMap.get(key)

  if (!entry || now >= entry.resetAt) {
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
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      const serializedData = data ? safeStringify(data) : undefined
      // Fire-and-forget: logging to backend should not block or crash the app
      logFrontend(level, module, message, stack, context, serializedData).catch(() => {})
    }
  } catch {
    // IPC unavailable — console-only fallback
  }
}

// ── Logger ───────────────────────────────────────────────────────────────

export const logger = {
  debug(module: string, message: string, data?: Record<string, unknown>) {
    if (shouldLog('debug')) console.debug(formatMessage('debug', module, message, data))
  },

  info(module: string, message: string, data?: Record<string, unknown>) {
    if (shouldLog('info')) console.info(formatMessage('info', module, message, data))
  },

  warn(module: string, message: string, data?: Record<string, unknown>, cause?: unknown) {
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

  error(module: string, message: string, data?: Record<string, unknown>, cause?: unknown) {
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
