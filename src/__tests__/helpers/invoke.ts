/**
 * Strict-IPC test helpers (#3225).
 *
 * ## Why this exists
 *
 * The generated bindings wrap every command in `typedError`
 * (`src/lib/bindings.ts`), which turns *whatever the invoke promise
 * resolves to* into `{ status: 'ok', data }`. `unwrap`
 * (`src/lib/app-error.ts`) branches only on `status`. So a test-time
 * `invoke` mock that resolves `undefined` for an unrecognised command is
 * indistinguishable, at the call site, from a command that genuinely
 * succeeded with no payload.
 *
 * That made a MISSING mock the quietest possible failure. #3217 is the
 * worked example: a hover-intent prefetch fired an unstubbed
 * `load_page_subtree`, consumed the positional `mockRejectedValueOnce`
 * queued for `delete_block`, and the *failed*-delete test went on to
 * exercise a **successful** delete — success toast and all — failing much
 * later on an unrelated `waitFor` timeout.
 *
 * ## The constraint
 *
 * A command whose Rust signature returns `()` legitimately produces no
 * payload, so `undefined` cannot itself be the signal. The *fallback* has
 * to be the thing that objects: the distinction is "no mock was
 * registered for this command" versus "this command returned nothing".
 * An explicit `mockResolvedValue(undefined)` / `mockResolvedValueOnce(undefined)`
 * / a handler in {@link mockInvokeCommands} replaces the fallback and is
 * therefore always honoured.
 *
 * ## The mechanism
 *
 * `src/test-setup.ts` installs {@link strictInvokeFallback} as the base
 * implementation of the shared `invoke` mock. An unstubbed command
 * (a) rejects, so the call site sees a failure rather than a phantom
 * success, and (b) is recorded, so a global `afterEach` fails the test
 * naming the command even when application code swallows the rejection
 * (a `.catch` that logs, an error boundary, a fire-and-forget effect).
 *
 * The record lives on `globalThis` rather than in this module's scope so
 * that a test file calling `vi.resetModules()` — which hands out a fresh
 * copy of this module — still reports into the same list the setup file's
 * `afterEach` reads.
 */

const RECORD_KEY = '__agaricUnstubbedInvokes__'

interface StrictInvokeGlobal {
  [RECORD_KEY]?: string[]
}

function record(): string[] {
  const scope = globalThis as StrictInvokeGlobal
  const existing = scope[RECORD_KEY]
  if (existing) return existing
  const created: string[] = []
  scope[RECORD_KEY] = created
  return created
}

/** The message an unstubbed command rejects with. Exported for assertions. */
export function unstubbedInvokeMessage(command: string): string {
  return (
    `no mock registered for command "${command}" — the test called it but never stubbed it. ` +
    `Stub it explicitly (mockInvokeCommands({ ${command}: … }), or ` +
    `vi.mocked(invoke).mockResolvedValue(…)); a command that legitimately ` +
    `returns nothing still needs an explicit stub resolving undefined.`
  )
}

/**
 * Base implementation of the shared `invoke` mock: records the command and
 * rejects. Never resolves — a resolved value is what made the silence
 * possible in the first place.
 */
export function strictInvokeFallback(command: string): Promise<never> {
  record().push(command)
  return Promise.reject(new Error(unstubbedInvokeMessage(command)))
}

/** Drain the recorded unstubbed commands (deduped, in first-call order). */
export function takeUnstubbedInvokes(): string[] {
  const seen = record()
  const unique = [...new Set(seen)]
  seen.length = 0
  return unique
}

/**
 * Dispatcher tail for suites that render page rows.
 *
 * `DensityRow` prefetches a page subtree once the pointer has dwelt on a row
 * for `PAGE_PREFETCH_DWELL_MS` (120ms) — see `@/lib/prefetch-page-subtree`.
 * `userEvent` interactions cross that threshold as an ordinary side effect on
 * a loaded machine, so `load_page_subtree` is a genuine IPC call in suites
 * that never mention it. It is incidental to their assertions but must still
 * be MODELLED rather than silently absorbed: that call stealing a positional
 * mock slot, and then falling through to a fallback resolving `undefined`, is
 * exactly what #3217 was.
 *
 * Everything else still goes to {@link strictInvokeFallback}.
 */
export function pageRowInvokeFallback(command: string): Promise<unknown> {
  if (command === 'load_page_subtree') {
    return Promise.resolve({ blocks: [], truncated: false, total: 0 })
  }
  return strictInvokeFallback(command)
}

/** Handler for one command: receives the command's argument object. */
export type InvokeHandler = (args: Record<string, unknown>) => unknown

/**
 * Install a **command-keyed** `invoke` implementation.
 *
 * Two hazards go away at once:
 *
 *  - **Positional theft.** `mockResolvedValueOnce` / `mockRejectedValueOnce`
 *    form a FIFO queue consumed in call order regardless of which command
 *    each call is for, so any speculative prefetch (hover-intent, warm-up)
 *    that fires mid-test steals the slot meant for the command under test
 *    (#3217). Keying on the command name removes the ordering assumption.
 *  - **Silent fallthrough.** A command with no handler here hits
 *    {@link strictInvokeFallback} and fails the test by name instead of
 *    resolving `undefined`.
 *
 * A handler returning `undefined` is honoured as "this command resolves
 * with no payload" — that is the legitimate `()`-returning case, and it is
 * distinguishable from the no-handler case precisely because the handler
 * exists.
 *
 * ```ts
 * mockInvokeCommands({
 *   list_pages_with_metadata: () => ({ items: [page], has_more: false }),
 *   delete_block: () => Promise.reject(new Error('Delete failed')),
 *   record_page_visit: () => undefined, // returns () in Rust
 * })
 * ```
 */
export function mockInvokeCommands(
  handlers: Readonly<Record<string, InvokeHandler>>,
  options: {
    /**
     * What an unlisted command does. Defaults to {@link strictInvokeFallback};
     * pass {@link pageRowInvokeFallback} in suites that render page rows.
     * Anything passed here must still FAIL on a genuinely unknown command —
     * a fallback that resolves is the bug this helper exists to remove.
     */
    fallback?: (command: string) => Promise<unknown>
  } = {},
): (command: string, args?: unknown) => Promise<unknown> {
  const fallback = options.fallback ?? strictInvokeFallback
  // `args` is typed `unknown` rather than `Record<string, unknown>` because
  // Tauri's `InvokeArgs` also admits array/buffer payloads; handlers receive
  // the object form, which is what every command in this app sends.
  return (command: string, args?: unknown) => {
    const handler = Object.hasOwn(handlers, command) ? handlers[command] : undefined
    if (!handler) return fallback(command)
    // A handler that throws synchronously should behave like a rejected
    // IPC call, not like a broken mock.
    try {
      return Promise.resolve(handler((args ?? {}) as Record<string, unknown>))
    } catch (err) {
      return Promise.reject(err)
    }
  }
}
