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

import type { invoke } from '@tauri-apps/api/core'
import type { MockedFunction } from 'vitest'

import { asPageWithMetadataRow, makeBlockRow, withOps } from '@/__tests__/fixtures'
import type { BlockRow, commands, OpRef } from '@/lib/bindings'

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
    // Annotated, not merely shaped right: an untyped literal here is the exact
    // drift this module exists to type.
    const empty: CommandReturns['load_page_subtree'] = { blocks: [], truncated: false, total: 0 }
    return Promise.resolve(empty)
  }
  return strictInvokeFallback(command)
}

/**
 * #4668 — the command → raw-invoke-return map, derived from the GENERATED
 * bindings so it cannot drift from the Rust surface.
 *
 * `commands.foo()` returns `typedError<T, AppError>(__TAURI_INVOKE(...))`, so
 * the value `invoke` itself resolves is the `T` — the `data` arm, before
 * `typedError` wraps it. That `T` is what a stub here must produce.
 *
 * The generated object is camelCase-keyed and `invoke` is called with the
 * snake_case IPC name, so the key is converted at the type level. A digit is
 * its own `Lowercase`, which keeps `mcpRwSetEnabled` → `mcp_rw_set_enabled`
 * right rather than splitting on the digits.
 */
type CamelToSnake<S extends string> = S extends `${infer C}${infer R}`
  ? C extends Lowercase<C>
    ? `${C}${CamelToSnake<R>}`
    : `_${Lowercase<C>}${CamelToSnake<R>}`
  : S

type GeneratedCommands = typeof commands

/** The `data` arm of a generated command's `Result`, i.e. what `invoke` resolves. */
type InvokeReturn<K extends keyof GeneratedCommands> = GeneratedCommands[K] extends (
  ...args: never[]
) => Promise<infer R>
  ? Extract<R, { status: 'ok' }> extends { data: infer D }
    ? D
    : never
  : never

/** Every IPC name the app can invoke, mapped to the value it resolves with. */
export type CommandReturns = {
  [K in keyof GeneratedCommands as CamelToSnake<K & string>]: InvokeReturn<K>
}

/**
 * A handler for one command, constrained to that command's real return type.
 *
 * `undefined` stays allowed for every command: the doc above explains that a
 * `()`-returning Rust command legitimately resolves with no payload, and the
 * no-handler case is distinguished by the handler's EXISTENCE rather than by
 * its value. That is a deliberate, narrow hole — it lets a stub under-return,
 * but not return the wrong SHAPE, which is the drift #4668 is about.
 */
export type TypedInvokeHandler<K extends keyof CommandReturns> = (
  args: Record<string, unknown>,
) => CommandReturns[K] | Promise<CommandReturns[K]> | undefined

/** The handler map `mockInvokeCommands` accepts. */
export type TypedInvokeHandlers = {
  [K in keyof CommandReturns]?: TypedInvokeHandler<K>
}

/** Handler for one command: receives the command's argument object. */
type InvokeHandler = (args: Record<string, unknown>) => unknown

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
 *   list_pages_with_metadata: () => ({ items: [page], next_cursor: null, has_more: false, total_count: null }),
 *   delete_block: () => Promise.reject(new Error('Delete failed')),
 *   cancel_sync: () => undefined, // returns () in Rust
 * })
 * ```
 */
export function mockInvokeCommands(
  handlers: Readonly<TypedInvokeHandlers>,
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
    const handler = Object.hasOwn(handlers, command)
      ? (handlers as Readonly<Record<string, InvokeHandler>>)[command]
      : undefined
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

/**
 * Install a test's command-keyed `invoke` handlers. Anything the code under
 * test fires that is not listed hits {@link strictInvokeFallback} and fails by
 * name instead of stealing a positional slot (#3217).
 *
 * The caller passes its own `vi.mocked(invoke)` for the reason
 * {@link stubPageRowInvoke} spells out: a VALUE import of
 * `@tauri-apps/api/core` in this module deadlocks the suite.
 */
export function stubInvoke(
  mockedInvoke: MockedFunction<typeof invoke>,
  handlers: Readonly<TypedInvokeHandlers>,
): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(handlers))
}

/** A `move_block` response: `WithOps<MoveResponse>`, `op_refs` included. */
export function moveResp(
  blockId: string,
  newParentId: string | null,
  newPosition: number,
): CommandReturns['move_block'] {
  return withOps({ block_id: blockId, new_parent_id: newParentId, new_position: newPosition })
}

/** The `edit_block` echo: the row the backend just wrote, `WithOps`-wrapped. */
export function echoEditBlock(args: Record<string, unknown>): CommandReturns['edit_block'] {
  return withOps(
    makeBlockRow({ id: args['blockId'] as string, content: args['toText'] as string, position: 0 }),
  )
}

/**
 * What a successful `delete_block` answers: `WithOps<DeleteResponse>`, whose
 * `deleted_at` is epoch-ms (migration 0080) and which carries the cascade's
 * `affected_page_ids`. The literals this replaced spelled `deleted_at` as an
 * ISO string and omitted both that array and `op_refs`.
 */
export function deleteResp(blockId: string, opRefs: OpRef[] = []): CommandReturns['delete_block'] {
  return {
    op_refs: opRefs,
    block_id: blockId,
    deleted_at: 1_735_689_600_000,
    descendants_affected: 1,
    affected_page_ids: [],
  }
}

/**
 * A promise the test settles by hand, so one command's response can be parked
 * while the flow's OTHER commands (an interleaved edit, the reconciling load)
 * keep answering — which a positional `…Once` queue cannot model (#3217).
 */
export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The `list_pages_with_metadata` envelope, as `invoke` resolves it. */
export type PageListEnvelope = CommandReturns['list_pages_with_metadata']

/**
 * The `list_pages_with_metadata` envelope for a set of pages.
 *
 * #4668 — the PageBrowser suites used to hand the command `BlockRow`s. It
 * returns `PageWithMetadataRow`, which specta renames to camelCase and which
 * carries four metadata columns (`lastModifiedAt`, `inboundLinkCount`,
 * `childBlockCount`, `flags`) no `BlockRow` has.
 */
export function pageList(
  items: BlockRow[],
  rest: Partial<PageListEnvelope> = {},
): PageListEnvelope {
  return {
    items: items.map(asPageWithMetadataRow),
    next_cursor: null,
    has_more: false,
    total_count: null,
    ...rest,
  }
}

/**
 * Install a COMMAND-KEYED `invoke` implementation for one page-row test.
 *
 * #3217 / #3225 — the positional `mockResolvedValueOnce` this replaced was
 * consumed in call order regardless of command, so any speculative fetch could
 * take the slot meant for the page query, and a re-fetch after the queue
 * drained fell through to a fallback resolving `undefined`.
 *
 * The caller passes its own `vi.mocked(invoke)`, and the two imports this file
 * needs to name it are `import type`. A VALUE import of `@tauri-apps/api/core`
 * here deadlocks every test in the suite: `test-setup.ts` imports this module,
 * and its `vi.mock('@tauri-apps/api/core', …)` factory is async so it can
 * `await import` this module back — so a static import of the mocked module
 * closes a cycle neither side can settle, and vitest hangs before it collects.
 */
export function stubPageRowInvoke(
  mockedInvoke: MockedFunction<typeof invoke>,
  handlers: Readonly<TypedInvokeHandlers> = {},
): void {
  mockedInvoke.mockImplementation(
    mockInvokeCommands(
      {
        resolve_page_by_alias: () => null,
        ...handlers,
      },
      { fallback: pageRowInvokeFallback },
    ),
  )
}
