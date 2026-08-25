/**
 * Cross-test `*Once` leak guard (#4211, following #4040 and #3217).
 *
 * ## The hazard
 *
 * `vi.clearAllMocks()` clears a mock's *call state* and nothing else. Read
 * `@vitest/spy`'s `mockClear` (v4.1.10): it empties `calls`, `contexts`,
 * `instances`, `invocationCallOrder`, `results` and `settledResults`, and
 * never touches `config.onceMockImplementations`. So a value queued with
 * `mockReturnValueOnce` / `mockResolvedValueOnce` / `mockRejectedValueOnce` /
 * `mockImplementationOnce` that the queuing test's code path does not end up
 * consuming SURVIVES `clearAllMocks()` and is handed to whichever LATER test
 * in the same file next calls that mock — ahead of the base implementation,
 * and ahead of that later test's own queued values.
 *
 * That is not hypothetical:
 *
 *  - **#4040** — an unconsumed `mockReturnValueOnce(new Promise(…))` (a
 *    deferred the queuing test resolves by hand) leaked into three unrelated
 *    tests, each of which hung on a promise nobody would ever resolve until
 *    `waitFor` gave up at ~8s. The failures pointed at innocent assertions in
 *    innocent describe blocks, and every one of them passed in isolation.
 *  - **#3217** — a speculative hover-prefetch `invoke` stole the positional
 *    `mockRejectedValueOnce` queued for `delete_block`, so the *failed*-delete
 *    test silently exercised a **successful** delete, toast and all.
 *
 * The cost of this class is not mainly the lost time. It is that the failure
 * **lies about its cause**: the test that breaks is not the test that is
 * wrong, so the investigation starts in the wrong file.
 *
 * ## What this guard asserts
 *
 * Exactly one thing: **a once-value queued by one test must not be consumed by
 * a different test.** When that happens the test that trips over it fails with
 * a message naming the `*Once` line and the test that queued it — turning the
 * misattributed failure into an attributed one.
 *
 * ### Why not "fail any test that leaves residue behind"
 *
 * That was the first design, and it is wrong: it flags code that is already
 * correct. `BlockPropertyEditor.test.tsx` — the file #4040 was fixed in —
 * deliberately queues a once-value its render never consumes, precisely to
 * prove that the `mockReset()` in its `beforeEach` drains it. The residue is
 * real at `afterEach` time and gone before the next test runs, so an
 * afterEach-residue check fails #4040's own regression test. Measured on the
 * full suite, that design produced 2 failures and BOTH were of this shape.
 *
 * Residue is only a *defect* when it actually crosses a test boundary. A
 * latent trap (residue a later `mockReset` drains, or residue in a file's last
 * test) is harmless, and a guard that cannot tell the two apart trains people
 * to add suppressions. This one only fires on the real thing — which also
 * means it fires the moment a production change turns a latent trap into a
 * live one, reporting it against the right line instead of an innocent
 * `waitFor`.
 *
 * ## What it deliberately does NOT catch
 *
 * The #3217 shape — an incidental call (a hover prefetch, a query refetch)
 * *stealing* a positional slot on the multiplexed `invoke` mock within a
 * single test — is not a cross-test leak: the value was consumed, just by the
 * wrong caller in the same test. That case is covered from the other side by
 * the strict-IPC guard in `src/test-setup.ts`, because the intended call then
 * falls through to `strictInvokeFallback` and is reported by name. The two
 * guards are complementary: this one catches "queued here, used in another
 * test", the strict-IPC one catches "used by something nobody stubbed".
 *
 * ## How it works
 *
 * `@vitest/spy` keeps the queue in a module-private `MOCK_CONFIGS` WeakMap and
 * exports neither it nor `REGISTERED_MOCKS`, so the queue cannot be read and
 * mocks cannot be enumerated. Both problems are solved where a once-value is
 * queued:
 *
 *  - `vi.fn` and `vi.spyOn` are wrapped so every mock created after this
 *    module loads is instrumented. (`vi.mock` factories run at the mocked
 *    module's first import, which is after setup files, so the shared `invoke`
 *    mock is covered too.)
 *  - Each mock's `mockImplementationOnce` is replaced. All four `*Once`
 *    helpers funnel through it — `mockReturnValueOnce` and friends are defined
 *    as `mock.mockImplementationOnce(…)` in the spy source — so one wrapper
 *    catches every queuing form.
 *  - The wrapper stamps each queued implementation with the test that queued
 *    it, then queues a shim that compares that stamp against the running test
 *    before delegating. A mismatch is recorded, not thrown: like the strict-IPC
 *    guard above it, throwing from inside a mock is unreliable because plenty
 *    of call sites `.catch` into a logger, a toast, or an error boundary. The
 *    `afterEach` in `src/test-setup.ts` does the throwing.
 *
 * The shim adds a comparison and a delegating call and changes no value, no
 * `this`, and no timing, so **enabling this guard cannot itself alter a test
 * outcome**. That is a deliberate property: a mock-hygiene guard that perturbs
 * mock behaviour would be self-defeating.
 */

import { expect, vi } from 'vitest'

/**
 * Identity of the currently running test.
 *
 * `expect.getState().currentTestName` is `undefined` at module scope and
 * inside `beforeAll`, and is already the upcoming test's full name inside
 * `beforeEach` (verified against vitest 4.1.10). Both facts are load-bearing:
 * the first lets suite-level setup queue once-values without being blamed, the
 * second lets a `beforeEach` queue a value the test body then consumes.
 *
 * `tick` disambiguates two tests that share a name — the name alone would let
 * a leak between them slip through.
 */
let tick = 0

function currentTestName(): string | undefined {
  try {
    return expect.getState().currentTestName
  } catch {
    return undefined
  }
}

/** Bump the test identity. Called from the first `beforeEach` in test-setup. */
export function beginOnceResidueTest(): void {
  tick += 1
}

/**
 * Best-effort `path:line:col` of the caller that queued a once-value.
 *
 * Anything inside this module or inside `node_modules` is a delegating frame:
 * the `mockReturnValueOnce`-style helpers call inward to
 * `mockImplementationOnce`, and vitest bundles the spy implementation into a
 * `@vitest/runner` chunk rather than shipping it at a stable `@vitest/spy`
 * path — matching on the package name alone missed it and reported the
 * bundle's own line. The first frame outside both is the test's own line.
 */
function callSite(): string {
  const stack = new Error('once-site').stack
  if (!stack) return 'unknown location'
  for (const line of stack.split('\n').slice(1)) {
    // Match this module by its full path, not by the bare string
    // "once-residue": the guard's own test file is named
    // `once-residue-guard.test.ts`, and a substring match swallowed every
    // frame in it, reporting "unknown location" for the one file that checks
    // this function works.
    if (line.includes('helpers/once-residue')) continue
    if (line.includes('node_modules')) continue
    const m = /\(?((?:\/|file:)[^\s()]+:\d+:\d+)\)?\s*$/.exec(line.trim())
    if (m?.[1]) return m[1].replace(/^file:\/\//, '').replace(`${process.cwd()}/`, '')
  }
  return 'unknown location'
}

/** One observed cross-test consumption. */
export interface OnceLeak {
  /** Source location of the `*Once` call that queued the value. */
  site: string
  /** Full name of the test that queued it. */
  queuedIn: string
  /** Full name of the test that consumed it. */
  consumedIn: string
  /** Mock name, when one was set via `.mockName()`. */
  mockName: string
}

const leaks: OnceLeak[] = []

type AnyFn = (...args: never[]) => unknown

interface InstrumentedMock {
  mockImplementationOnce: (impl: AnyFn) => unknown
  mockReset: () => unknown
  mockRestore: () => unknown
  getMockName?: () => string
}

const INSTRUMENTED = Symbol('agaric.onceResidue.instrumented')

function nameOf(mock: InstrumentedMock): string {
  try {
    const name = mock.getMockName?.()
    return !name || name === 'vi.fn()' ? 'an unnamed vi.fn()' : name
  } catch {
    return 'an unnamed vi.fn()'
  }
}

/**
 * Replace `mockImplementationOnce` — the funnel every `*Once` helper calls —
 * with a stamping wrapper.
 */
function instrument(mock: InstrumentedMock): void {
  const tagged = mock as InstrumentedMock & { [INSTRUMENTED]?: true }
  if (tagged[INSTRUMENTED]) return
  tagged[INSTRUMENTED] = true

  const originalOnce = mock.mockImplementationOnce.bind(mock)

  mock.mockImplementationOnce = (impl: AnyFn) => {
    const queuedIn = currentTestName()
    const queuedTick = tick
    const site = callSite()

    return originalOnce(function stampedOnce(this: unknown, ...args: never[]) {
      // `queuedIn === undefined` means module scope or `beforeAll`: a
      // suite-level stub is *meant* to be consumed by a test, so it can never
      // be a leak.
      if (queuedIn !== undefined && tick !== queuedTick) {
        leaks.push({
          site,
          queuedIn,
          consumedIn: currentTestName() ?? '(outside a test)',
          mockName: nameOf(mock),
        })
      }
      return (impl as (this: unknown, ...a: never[]) => unknown).apply(this, args)
    } as AnyFn)
  }
}

function isInstrumentable(value: unknown): value is InstrumentedMock {
  return (
    typeof value === 'function' &&
    typeof (value as { mockImplementationOnce?: unknown }).mockImplementationOnce === 'function' &&
    typeof (value as { mockReset?: unknown }).mockReset === 'function'
  )
}

/**
 * Wrap `vi.fn` and `vi.spyOn` so every mock created from here on is
 * instrumented. Idempotent.
 */
export function installOnceResidueTracking(): void {
  const target = vi as unknown as Record<string, unknown> & { __agaricOnceTracked?: true }
  if (target.__agaricOnceTracked) return
  target.__agaricOnceTracked = true

  for (const name of ['fn', 'spyOn'] as const) {
    const original = target[name] as ((...args: unknown[]) => unknown) | undefined
    if (typeof original !== 'function') continue
    target[name] = (...args: unknown[]) => {
      const result = original(...args)
      if (isInstrumentable(result)) instrument(result)
      return result
    }
  }
}

/** Drain the recorded cross-test consumptions. */
export function takeOnceLeaks(): OnceLeak[] {
  return leaks.splice(0, leaks.length)
}

/** The failure message. Exported so the guard's own tests can assert on it. */
export function onceLeakMessage(found: readonly OnceLeak[]): string {
  const detail = found
    .map(
      (l) =>
        `  - a value queued on ${l.mockName} at ${l.site}\n` +
        `    by "${l.queuedIn}"\n` +
        `    was consumed by "${l.consumedIn}"`,
    )
    .join('\n')
  return (
    `This test consumed ${found.length} \`*Once\` mock ` +
    `${found.length === 1 ? 'value' : 'values'} that an EARLIER test queued and never used:\n` +
    `${detail}\n` +
    'Unconsumed once-values are not drained by `vi.clearAllMocks()` (#4211): they survive ' +
    'into later tests and are handed to them ahead of both the base implementation and ' +
    'their own queued values. This is #4040 (a leaked deferred promise hung three ' +
    'unrelated tests at ~8s each) and #3217 (a leaked rejection inverted a delete test ' +
    'into asserting success).\n' +
    'Fix the test named above as the QUEUING one — this test is the victim, not the cause:\n' +
    '  - stubbing a call that no longer happens -> drop the stale `*Once`;\n' +
    '  - queued more values than the path consumes -> queue only what is called;\n' +
    '  - positional stub on the shared `invoke` mock -> use `mockInvokeCommands` ' +
    '(src/__tests__/helpers/invoke.ts), which keys on the command name so an incidental ' +
    'call cannot steal the slot;\n' +
    '  - the queue is meant to be left dirty -> `mockReset()` the mock in `beforeEach` ' +
    '(re-seeding its default), as `BlockPropertyEditor.test.tsx` does.'
  )
}
