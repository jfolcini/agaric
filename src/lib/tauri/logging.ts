import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { setLogBackendSink } from '@/lib/logger-transport'

/** Log a frontend message to the backend's daily-rolling log file. Fire-and-forget. */
export async function logFrontend(
  level: string,
  module: string,
  message: string,
  stack?: string | null,
  context?: string | null,
  data?: string | null,
): Promise<void> {
  unwrap(
    await commands.logFrontend(
      level,
      module,
      message,
      stack ?? null,
      context ?? null,
      data ?? null,
    ),
  )
}

// Wire the IPC log call into the logger's backend-transport seam (#761). This
// import-time side effect replaces the old direct `logger.ts -> tauri.ts`
// import that formed an import cycle; `logger.ts` now depends only on the leaf
// `logger-transport.ts`.
setLogBackendSink(logFrontend)

// `getLogDir`, the op-log compaction wrappers (`getCompactionStatus`,
// `compactOpLog`) and their `CompactionStatus` / `CompactionResult` types
// were removed in #2927 — call `commands.getCompactionStatus()` /
// `commands.compactOpLogCmd(...)` directly and unwrap with the helper from
// `@/lib/app-error`. The types live in `@/lib/bindings`.

// ---------------------------------------------------------------------------
// Link metadata
// ---------------------------------------------------------------------------
