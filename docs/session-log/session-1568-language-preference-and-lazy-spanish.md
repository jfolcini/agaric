# Session 1568 — A language preference, and Spanish as a chunk nobody downloads

Phase 1 of #4555, in the shape the issue's 2026-09-02 rationalization comment left it: ship the switch and the catalog machinery, and translate namespaces one PR at a time afterwards. The language is one device-scoped entry in the existing typed preference registry (`agaric-language`, default `'system'`, validated against an allowlist in the new leaf module `src/lib/i18n/locales.ts`). No migration, no op type, no store, nothing on the sync wire — a language belongs to the person reading the screen, not to the notes, so a phone and a laptop may legitimately run different ones against the same data. `resolveLocale` matches `navigator.languages` on the primary subtag only, so `es-419`, `es-MX` and `es` all land on the one neutral Spanish catalog.

English stays statically bundled because it is `fallbackLng`, and a fallback that has to load is a fallback that can fail. Everything else is a dynamic `import()`, the same trick and the same justification as the emoji dataset. `npm run build` puts the Spanish catalog in its own chunk — `dist/assets/es-elV8DSsx.js`, 8,670 bytes raw and 2,968 bytes at `gzip -9` — and that filename appears in none of the 83 `modulepreload` entries `dist/index.html` emits, so an English user fetches none of it. The `date-fns` Spanish locale registers itself from inside that same chunk rather than from `date-locale.ts`, which keeps Spanish calendar vocabulary out of the startup payload and makes UI language and date language arrive together. `node scripts/check-bundle-budget.mjs` is green on every tracked chunk; `index` reads 243,492 B gzip against a 302,082 B budget. `e2e/language-preference.spec.ts` covers the one thing vitest structurally cannot, since vitest resolves `@/lib/i18n/es` straight from source: that the chunk is actually deliverable from a real build. Deleting `dist/assets/es-*.js` and re-running reddens both tests on the Spanish label never appearing — and shows the production failure path doing exactly what it claims, logging and leaving the UI in English.

`setLocale` awaits the catalog *before* `changeLanguage`, and that ordering is the whole of "no restart" — without it the UI paints fully English between the two calls. Replacing the `await` with a fire-and-forget call reddens `locales.test.ts` on `hasResourceBundle('es', …)` and `AppearanceTab.test.tsx` on the label that never becomes `Idioma`; the `useLanguage` hook test does **not** catch it, because its `waitFor` lets the stray load settle first, so its comment claiming to pin the ordering was wrong and now says which suite actually does. A chunk that will not load logs and leaves the current language in place, and the rejection is evicted rather than memoized so picking the language again is a real retry — that second half arrived as a test that could not fail (a memoized rejection rejects too, so asserting a second rejection passed either way), and the mock now fails once and then succeeds, so deleting the eviction reddens it on a retry that never recovers. `MonthlyView`'s `dayHeaders` memo (named in the issue comment, from the closed #4575) resolved `getDateLocale()` inside a memo keyed on `[weekStartsOn]` — a dependency the linter cannot see — so a language switch left an English weekday row over a Spanish month; the locale is now resolved during render. That fix shipped with no test, so one was added that changes the language on an already-mounted tree: reverting the memo makes it read `Mon` where `lun` is expected.

The Spanish shipped here is the `errors` namespace, a complete 39-key mirror of `src/lib/i18n/errors.ts`, plus the 3 keys the language control needs for its own copy. Everything else falls back to English, silently and correctly, which is why the new `es-catalog.test.ts` asserts a subset property rather than parity: every key `es` defines must exist in `en`, must carry the same `{{…}}` placeholder multiset, must follow the key convention, and must not be a byte copy of its English source. Two long-standing assertions were rewritten rather than deleted — `expect(i18n.language).toBe('en')` pinned the app to one locale instead of pinning anything worth pinning, and the key-convention regex allowed only `_one|_other`, the two plural categories English can produce, which a legal Spanish `_many` key would have failed. Deviation from the issue worth naming: the 13 English namespace files stay put rather than moving to `src/lib/i18n/en/`, since the move existed to serve a parity guard the rationalization comment dropped.

Shipped: Phase 1 of #4555.

## Review round 1 — four notes, three taken, one filed

Approved with no blocking defect. Three folded in, one deliberately not.

**`defaultValue` was `'system'`, which ships a wrong UI to Spanish-OS users.**
The strongest note, and it is user-facing rather than stylistic: a device set to
`es` resolves `'system'` to `es` for someone who never opened Settings, giving
`<html lang="es">` over a UI that is 42 of 3,056 keys translated — the exact
mis-announcement `applyDocumentLang` was written to prevent — and
`SpeechRecognition.lang = 'es'` in `useVoiceInput` to someone dictating English.
The help string explaining the gap only reaches people who opened the tab. Now
`'en'`, with the reason and the flip condition recorded on the preference and
pinned by a test that names the coverage figure, so the next person to widen the
catalogs finds the test rather than rediscovering the argument.

**`setLocale`'s failure comment was inverted.** It claimed "the Settings select
visibly staying where it was is the feedback"; the select is bound to the STORED
preference, which `setLanguage` wrote before `setLocale` ran, so a failed load
leaves it reading Español over an English UI with no feedback at all. Corrected
to say there is none, and when that becomes worth fixing.

**`useLanguage` returned two things nothing reads.** `setLanguage` was
`useCallback((p) => setValue(p), [setValue])` — i.e. `setValue` — and
`resolvedLocale` had no consumer outside its own test. Both gone.

**The switch-back race is filed as #4812, not fixed here.** Picking Español then
English before the chunk settles leaves a Spanish UI under a Select reading
"English", permanently. The note proposes guarding on the requested locale
rather than `i18n.language`, which is right but only half: `en` is bundled while
`es` is a chunk, so once both calls are made the stale Spanish load reliably
resolves LAST and wins — closing it also needs a supersede check inside
`setLocale`.

Both changes are small and I wrote them. They are not in this PR because I could
not make a test fail without them. By the time a vitest run reaches this hook the
`es` chunk is cached, so it settles inside the same `act()` and the two clicks
never interleave; the test I wrote passed against both mutants, which makes it
worth nothing. Shipping an unfalsified fix on an approved PR, for a note the
reviewer marked non-blocking, is the wrong trade — so the reasoning is in #4812
and in the `useLanguage` docblock, and closing it starts with a harness that can
hold the chunk open.

## The lazy chunk cost every other test file, under coverage only

`validate / vitest` cancelled four times on this PR at 19m45s+ against its
`timeout-minutes: 20`, while a healthy run is ~14m10s (#4806 14m07s, #4807
14m23s). A cancelled lane surfaces as `validate-all: failure` with nothing
naming the clock, so the first three re-runs were spent on the assumption that
it was runner variance.

It was not. Measured on `src/components/agenda` — a subset with nothing to do
with i18n — at `--maxWorkers=2`:

| | without `--coverage` | with `--coverage` |
|---|---|---|
| baseline (`main` + #4550) | 19.03s | 23.86s |
| this branch, loader in `index.ts` | 19.75s (+3.8%, noise) | 27.59s (**+15.6%**) |
| this branch, loader split out | — | **23.76s** (baseline) |

The mechanism is the dynamic `import('@/lib/i18n/es')`. It lived in
`src/lib/i18n/index.ts`, which **206 files** import — and whose own docblock
already refuses an edge to `@/lib/preferences` on exactly this ground: what that
module imports, almost every consumer imports. A lazy chunk boundary is the same
hazard in a different currency, and instrumenting it 206 times is what the
coverage-only penalty is. Without coverage the cost is invisible, which is why
the local suite never showed it.

So `setLocale` and `loadLocale` move to `src/lib/i18n/set-locale.ts`, leaving
`index.ts` with `i18n`, `t` and the bundled catalogs. Two production callers
import the new module (`src/main.tsx`, `useLanguage`) plus two test files —
which is the whole point: the chunk boundary is now in the graphs that want it.

The i18n tests themselves were never the cost (2.48s for all 234). Guessing from
the diff would have blamed them; the subset measurement is what found the real
shape. The timeout headroom is a separate, still-live concern — filed as #4818
before this cause was known, and worth keeping on its own merits.
