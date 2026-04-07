/**
 * Structured logging utility for the frontend.
 *
 * Thin wrapper around console.* with level filtering and structured format.
 * In dev mode, all levels are logged. In production, only warn and error.
 *
 * Format: [ISO-timestamp] [LEVEL] [module] message {optional JSON data}
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let minLevel: LogLevel = import.meta.env.DEV ? 'debug' : 'warn'

export function setLogLevel(level: LogLevel) {
  minLevel = level
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[minLevel]
}

function formatMessage(
  level: LogLevel,
  module: string,
  message: string,
  data?: Record<string, unknown>,
): string {
  const ts = new Date().toISOString()
  const base = `[${ts}] [${level.toUpperCase()}] [${module}] ${message}`
  return data ? `${base} ${JSON.stringify(data)}` : base
}

export const logger = {
  debug(module: string, message: string, data?: Record<string, unknown>) {
    if (shouldLog('debug')) console.debug(formatMessage('debug', module, message, data))
  },
  info(module: string, message: string, data?: Record<string, unknown>) {
    if (shouldLog('info')) console.info(formatMessage('info', module, message, data))
  },
  warn(module: string, message: string, data?: Record<string, unknown>) {
    if (shouldLog('warn')) console.warn(formatMessage('warn', module, message, data))
  },
  error(module: string, message: string, data?: Record<string, unknown>) {
    if (shouldLog('error')) console.error(formatMessage('error', module, message, data))
  },
}
