# Session 1634 — the jsdom pin behind `Storage.prototype` spies

Five test files opt into jsdom with a top-of-file `// @vitest-environment jsdom`
and give the same reason: `vi.spyOn(Storage.prototype, 'setItem')` does not
intercept `localStorage` under happy-dom, because happy-dom's Storage bypasses
the prototype method. Four of them say "pin until refactored" in so many words.
happy-dom is the repo default and the faster environment, so the brief was to
find out whether the reason still holds on happy-dom 20.12.0 and to un-pin the
files where it does not.

The claim as written is false, and a probe run in the happy-dom environment
confirms it: `Object.getPrototypeOf(localStorage) === Storage.prototype` is
true, and a spy installed on that prototype records the call and its arguments.
But the pin turns out to be earning its keep anyway, for a reason nobody had
written down.

## What happy-dom actually does

`Storage`'s constructor returns a `Proxy` over itself, and its `get` trap calls
`ClassMethodBinder.bind(property)` before returning. That helper takes the
descriptor off `Storage.prototype` **at that moment**, copies it onto the
instance as an own property bound to the instance, and records the name in a
cache it consults on entry so it never rebinds. Both files are small enough to
read end to end: `node_modules/happy-dom/lib/storage/Storage.js` and
`lib/utilities/ClassMethodBinder.js`.

So the interception is not impossible, it is first-come. A `Storage.prototype`
spy installed before anything has touched `localStorage.setItem` in that file is
the descriptor that gets copied onto the instance, and it sees every later call.
Any spy installed after the first touch is invisible: the instance already owns
a bound copy of the real method, and nothing consults the prototype again for
the life of the window. jsdom's Storage is a proxy whose traps forward to the
prototype on every access, which is why the same code passes there.

A file gets a fresh happy-dom window, so the first spy in a file works and every
later one silently does not. That is what makes this worth a comment rather than
a shrug: a `toHaveBeenCalled` assertion behind a dead spy fails loudly, but the
`not.toHaveBeenCalled` and `mockImplementation(() => { throw … })` shapes that
these files are full of degrade to vacuous green.

## What moved and what stayed

`src/hooks/__tests__/useEmojiRecents.test.tsx` is un-pinned and now runs on
happy-dom. It never spied on `Storage.prototype` at all — the comment was
inherited from `useLocalStoragePreference.test.tsx`, whose rationale it cited,
and never applied to it. Its 13 tests pass on happy-dom.

The other four stay pinned, each with the failure that was actually observed
when the pin came off, and each comment rewritten to state the binder mechanism
instead of the retired claim:

`src/lib/__tests__/preferences.test.ts`, `src/lib/__tests__/keyboard-config.test.ts`
and `src/hooks/__tests__/useLocalStoragePreference.test.tsx` fail five tests
apiece. In every one of the fifteen, a `getItem`/`setItem`/`removeItem` spy with
a throwing implementation is installed after an earlier test has already touched
that method, so the throw never reaches the code under test and the
swallow-and-warn path is never exercised — the tests fail on the missing warning
or the missing fallback.

`src/components/block-tree/__tests__/use-block-collapse.test.ts` fails one:
"persists collapsed IDs to the page-scoped localStorage key" reports `Number of
calls: 0`. That one is worth naming because it looks like a happy-dom bug at
first read and is not. The test passes in isolation, and passes with every other
test in the file except one — the immediately preceding "keeps expandBlock
stable" case, which installs the file's first `setItem` spy and thereby freezes
the binding. The dependency is on ordering, not on the environment's storage
being broken.

None of the five files had an assertion changed. Making the later spies work
would mean spying on the `localStorage` instance instead of the prototype, which
is a rewrite of the tests to fit the environment — the signal that the pin is
still buying something.

## Proving the un-pinned file is not vacuously green

Green under happy-dom is exactly what a dead spy also produces, so
`useEmojiRecents` needed the same treatment as a spy. It has no spy to prove
live; what it has instead is a durable, re-queried effect — it pushes an emoji
through the hook, then reads `EMOJI_FREQUENCY_KEY` back out of `localStorage`
and asserts the count in the parsed payload. Inverting that assertion to `99`,
against a `cp` backup, reddens with `expected 1 to be 99`: a real count parsed
out of a real stored payload, not the `undefined` that a storage path which
never ran would produce. Restored and `cmp`-checked.

The four pinned files needed no such proof — the evidence for them is the
failure list above, which is what a live-and-then-dead spy looks like.

## Verification

All five files pass: 334 tests. `npm run typecheck` is clean. `git diff` is five
comment blocks and this log; the temporary probe test written to establish the
binder mechanism was deleted, and every file mutated for a falsification was
restored from a `cp` backup and confirmed with `cmp`.

`src/__tests__/AGENTS.md` still carries the retired one-line claim in its
Environment paragraph. Its correction is in flight in #4891 and was left alone
here.
