# Session 1595 — switching language twice mid-chunk-load (#4812)

## What broke

Pick **Español**, change your mind, pick **English** again before the Spanish
catalog chunk settles, and the app stays Spanish under a Settings select
reading "English" — permanently. The stored preference is already `en`, so
`resolvedLocale` never changes again and nothing re-fires to correct it.

## Two fixes, because either alone leaves the bug

`useLanguage`'s effect guarded on `i18n.language`, which is one switch BEHIND
while a chunk is in flight: the second run reads `'en'` — still true, the
switch has not landed — and returns, so `setLocale('en')` never runs at all.
It now guards on the locale it last REQUESTED.

That alone is not enough. `en` is bundled beside `set-locale.ts` while every
other locale is a chunk, so once both calls are made the Spanish load reliably
resolves LAST and calls `changeLanguage('es')` after the English one.
`setLocale` records the latest requested locale and drops a load that settles
after a newer request.

## The harness was the work

#4812 was filed rather than fixed on #4810 because the obvious test passes with
or without the fix: `loadLocale` memoizes per module graph, so by the time a
vitest run reaches the hook the `es` chunk is cached, settles inside the same
`act()`, and the two picks never interleave.

`useLanguage-switch-race.test.ts` is its own file for exactly that reason. Its
`vi.mock('@/lib/i18n/es')` factory awaits a promise the test releases by hand,
so the settle order is the test's: request `es` (hangs), request `en` (lands,
`en` is bundled), then release `es` late.

Two assertions carry the weight that a naive version would miss. `i18n.language`
never leaves `'en'`, so it cannot by itself tell "switched back" from "never
switched" — the `changeLanguage` call is asserted for that half. And a
`waitFor` on `hasResourceBundle('es')` pins that the abandoned load really did
settle; without it the end-state assertions would pass before the race had
happened at all.

## Falsification

Each half reverted alone, against a `cp` backup, restored and `cmp`-verified:

- hook guard only → `expected "bound changeLanguage" to be called 1 times, but got 0 times`
- supersede check only → `expected 'es' to be 'en'`
- both → red

Neither half is a free rider, so this is not the half-covered-pair shape. The
first mutant was additionally re-run with the two call assertions stubbed out,
to confirm the durable end-state assertion reddens on its own rather than
riding on the ordering pin.
