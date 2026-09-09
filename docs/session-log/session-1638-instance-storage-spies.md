# Session 1638 — instance storage spies, and the end of the jsdom pins

Session 1636 found eight dead `Storage.prototype` spies and pinned five files
to jsdom to bring them back. The pin worked, but it was a workaround: it fixed
the environment rather than the spy. This session fixes the spy. Twenty-five
spies across nine files are now `vi.spyOn(window.localStorage, …)`, the nine
jsdom pins those files carried are gone, and the per-file comments that
explained the pins went with them.

## Why the instance spy is immune

happy-dom's `Storage` is a `Proxy`. Its `get` trap runs `ClassMethodBinder.bind`,
which reads the descriptor off `Storage.prototype` at that moment, copies it
onto the instance as an own bound property, and caches the name so it never
rebinds. That is what makes a prototype spy first-come: once anything in a file
has read `localStorage.setItem`, the instance owns a bound copy of the real
method and every later prototype spy is talking to a descriptor nobody reads.

An instance spy never touches the prototype. `vi.spyOn(window.localStorage,
'setItem')` goes through the proxy's `defineProperty` trap, which calls
`preventBinding` and then defines the mock straight onto the instance — the
same slot the binder would have written to, and the trap that turns the binder
off for that name. Whether the binder already ran is irrelevant; either way the
own property the `get` trap returns is the mock. So the ordering constraint
disappears, and with it the reason to pin.

Each conversion was proved live the way 1636 proved deadness: against a `cp`
backup, insert `expect(spy).toHaveBeenCalledTimes(99)` right after the action
that should trip it, run `npx vitest run <path>` with no `-t` filter, and read
the number out of "but got N times". The probe has to sit *before* the
`mockRestore()`, which clears the call history — a probe placed after one reads
0 and looks exactly like a dead spy. That cost one wrong reading in
`preferences.test.ts` before the placement was corrected. For the three
`not.toHaveBeenCalled()` spies the inversion proves nothing, since a dead spy
and a correctly-silent one both report zero, so those got a direct
`window.localStorage.setItem` inside the spied window instead and the question
became whether the spy can record anything at all.

## The conversions

`preferences.test.ts`, five spies: 1, 1, 2, 1, 1.
`useLocalStoragePreference.test.tsx`, six: 4, 1, 4, 1, 2, 1.
`keyboard-config.test.ts`, five: 1, 1, 1, 1, 1.
`use-block-collapse.test.ts`, three, all three of them
`not.toHaveBeenCalled()`-shaped or count-shaped and all three proved by a direct
write: 1, 1, 1.
`useTheme.test.ts`, two: 1 for the throwing spy, and 1 for the
`not.toHaveBeenCalled()` in "setting same theme is a no-op", which records the
direct probe write and nothing else — so the hook's same-theme early return is
still what keeps it at zero.
`useExternalImagePolicy.test.ts`, two: 1 and 1.
`useAgendaPreferences.test.ts`, two: 8 and 3.
`useDeepLinkRouter.test.ts`, one: 1, with the swallow-and-warn line visible in
stderr.
`BookmarksSection.test.tsx`, one: 3.

No test failed for real once the throw landed. Every one of these paths was
already exercised under the jsdom pin, so the pin had done its job; this change
only removes the dependency on it.

## `vi.restoreAllMocks()` does not reach an instance spy

This is the part that was not in the brief and mattered most. An instance spy
is restored by `spy.mockRestore()` and by nothing else — `vi.restoreAllMocks()`
leaves it installed. Proved twice in `useExternalImagePolicy.test.ts` by
deleting that file's inline `mockRestore()` and watching six later tests take
the `QuotaExceededError`, once with the `afterEach` in its original order and
once with `vi.restoreAllMocks()` moved ahead of `localStorage.clear()` to rule
out the clear throwing first.

Two files were relying on the net that no longer holds, and both needed a real
fix.

`keyboard-config.test.ts` broke outright. Its five throwing spies all ended in
`vi.restoreAllMocks()` — two inline, three from the module `afterEach` — so the
first one, in "a failed heal write-back is caught, logged, and still returns the
sanitized overrides", leaked a throwing `setItem` into the rest of the file: 62
of 227 tests red. Every spy now captures its handle and restores it in a
`finally`. Green again at 227, and the `finally` also means a failing assertion
inside one of those tests costs one red test instead of sixty-three — the probe
run reddened exactly the five probes and nothing else.

`BookmarksSection.test.tsx` did not break, which is worse. Its spy had no inline
restore at all, and the file passed only because the two a11y tests that follow
never write `localStorage` successfully. A temporary
`window.localStorage.setItem('leak-probe', '1')` at the top of the next test
threw `QuotaExceededError`; with the spy wrapped in a `try`/`finally` it stores
and reads back. That test is now the same shape as the others.

The remaining files restore every spy inline, so their green runs are honest.
They do lose the `afterEach` backstop they had under jsdom: a test that fails
before its inline `mockRestore()` will now cascade. That showed up in the probe
runs as extra red — 26 in `preferences.test.ts`, 18 in
`useLocalStoragePreference.test.tsx` — and vanished with the probes. It is a
diagnostic cost on an already-failing file, not a correctness one, so nothing
was restructured for it; the rule in `src/__tests__/AGENTS.md` is where the next
person hears about it.

## The one file that keeps its prototype spy

`PageBrowser.density-rows.test.tsx` is pinned to jsdom for the #2929 monolith
split, and the brief's plan was to convert its spy so that a later un-pin on
monolith grounds could not silently kill it. Converting it killed it
immediately: the test went red with `expected [] to include
'pageBrowser:scrollOffset:SPACE_TEST'`, and a direct
`window.sessionStorage.removeItem('direct-probe')` next to the spy recorded 0.

jsdom is the exact mirror image of happy-dom here. Its `Storage` is also a
proxy, but the `defineProperty` trap treats a string key as a *storage item*, so
`vi.spyOn` does not replace the method — it writes an entry. The probe that
settles it:
`window.sessionStorage.getItem('removeItem')` came back as the string
`"function(...args) {\n"`, and the method itself was untouched, so the spy
records nothing. Not sessionStorage-specific either; a `window.localStorage`
instance spy in the same file recorded 0 for a direct write on the next line.

So the two forms are complementary rather than one superseding the other:
instance spy under happy-dom, prototype spy under jsdom. That file keeps its
`Storage.prototype` spy, and its header now says the pin is load-bearing for it
and points at the AGENTS.md rule — which is the hazard the brief was pointing
at, recorded rather than removed.

## What the rule says now

`src/__tests__/AGENTS.md`'s three paragraphs are two. The first is the rule:
spy the storage instance, not `Storage.prototype`, and restore it yourself in a
`finally`, with one sentence each for the happy-dom binder that makes the
prototype spy first-come, for `vi.restoreAllMocks()` not reaching an instance
spy, and for the jsdom exception. The second is the unchanged "prove it live"
paragraph, minus the sentence about how the paragraph's own first version came
to be wrong, plus a note that the inverted count must be read before the
`mockRestore()`.

## Verification

Every touched file runs unfiltered and green: 41, 22, 227, 31, 43, 14, 18, 66,
14, and 10 for the density-rows file. `npm run typecheck` clean, `npm run lint`
exit 0. Every probe went against a `cp` backup and was restored with `cmp`
confirming byte identity; `oxfmt --check` over the ten files found one
reflow in `use-block-collapse.test.ts` and it was formatted. `git diff` read in
full: the only surviving `Storage.prototype` occurrences in `src/` are the
density-rows spy and its new comment, plus the two header mentions in
`guarded-storage.test.ts` and `safe-persist-storage.test.ts` that explain why
those files use `vi.stubGlobal` on purpose.
