# Session 1628 — type-aware `unbound-method` to zero

`oxlint --type-aware` has never run against this tree. Turning it on with every
rule at `"error"` needs each of its eight rules cleared first, one PR each.
This one is `typescript/unbound-method`: 138 sites.

The rule fires on a method referenced without its receiver, because a later
call through that reference loses `this`. It is a type-level judgement, not a
dataflow one — it asks what the *declared* type says, so a function that never
touches `this` is still flagged when it was written as a method.

## Nearly all of it was one declaration

109 of the 138 were `logger.warn` / `logger.error` / `logger.info` /
`logger.debug`, spread over about fifty test files as
`expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(…)`,
`const mockedLoggerWarn = vi.mocked(logger.warn)`, and
`vi.mocked(logger.error).mockClear()`.

None of those had a per-site fix. Hoisting the reference into a local is
flagged on the line that hoists it; `vi.mocked(logger).warn` is the same member
read; `.bind()` breaks the identity the assertions compare against. The report
was not about the call sites at all — `logger` is a namespace object written
with method shorthand, so TypeScript types its four entries as methods, and the
module contains no `this` anywhere. The fix is one `this: void` per method in
`src/lib/logger.ts`, which is a type annotation and emits nothing.

Same shape, two sites: `EditorEventDispatch.on` is declared with method
shorthand next to two `readonly` properties, and is implemented as a
`useCallback` arrow. `this: void` there too.

## The one production reference that was actually detaching

`useIpcCommand` picks a log level with
`const log = opts.logLevel === 'warn' ? logger.warn : logger.error`, then calls
`log(…)`. That is the exact hazard the rule describes, and it has been correct
this whole time only because the logger happens to have no `this` — nothing in
the types said so, so nothing would have caught a logger rewritten as a class.
It now type-checks as safe rather than being safe by accident.

## The rest, by shape

Twelve sites were save-monkey-patch-restore against a DOM prototype —
`Element.prototype.getBoundingClientRect`, `HTMLElement.prototype.scrollIntoView`,
`HTMLInputElement.prototype.click`, `Storage.prototype.setItem`,
`URL.createObjectURL`. `vi.spyOn` + `mockRestore()` says the same thing without
the detached capture, and in three of them replaced a hand-rolled
`Object.defineProperty` pair with one line.

`BlockTree.scale-envelope`'s layout-read counter shrank the most: a bare
`vi.spyOn` already counts calls and still runs the real implementation, so the
patched wrapper, the manual tally and the restore all collapsed into
`spy.mock.calls.length`.

`node-view-mobile-freeze` extracts `NodeView.prototype.ignoreMutation` and
`MarkView.prototype.ignoreMutation` on purpose, to invoke tiptap's real
defaults against a hand-built `this` — nine `.call(self, …)` sites. The
extraction is now a `this`-typed wrapper function that does the `.call`
internally, so all nine call sites are untouched and read exactly as before.

The remainder were one-offs: `Object.getOwnPropertyDescriptor(…)?.set` (kept,
the descriptor is now held and the setter reached through it), a fake editor
handed `editor.chain` / `editor.can` detached (bound to the editor — production
passes working ones), `expect(x.method).toBeTypeOf('function')` (`typeof x`
never detaches anything), and two `expect(el.scrollIntoView)` assertions that
now name the spy the test installed a line earlier.

No `oxlint-disable` was needed anywhere.

## One real defect in a test file

`useFocusedRowEffect.test.tsx` stubbed `Element.prototype.scrollIntoView` with
a bare `vi.fn()` assignment in `beforeEach` and called `vi.restoreAllMocks()`
in `afterEach`. A raw prototype assignment is not a mock, so the restore was a
no-op and the stub outlived the file for the rest of the worker. As a spy it is
actually restored.

## Verification

`npx oxlint --type-aware` reports zero `typescript(unbound-method)`, and the
per-rule counts for the other seven rules are unchanged from before the change
— nothing was traded away. `npm run typecheck` is clean and every touched file
passes under vitest, as do the untouched logger-asserting suites the
declaration change reached.

Two rewrites could have gone vacuous, so both were falsified against `cp`
backups and `cmp`-checked after restoring. The layout-read counter asserts
`toBe(0)`, which passes just as well if the spy counts nothing: adding one
`getBoundingClientRect()` call inside the counted window reddens it with
"expected 1 to be +0". The `Storage.prototype.setItem` conversion was checked
the other way — `src/__tests__/AGENTS.md` warns that `Storage.prototype` spies
do not intercept `localStorage` under happy-dom, which would make both
"write throws" tests vacuous; asserting the spy was called shows it is reached,
so the throw path is real and the conversion preserved it.
