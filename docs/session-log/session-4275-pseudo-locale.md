# Session 4275 — an `en-XA` pseudo-locale that shows overflow and hardcoded English

The ask, a follow-up to session 4244's catalogs: make layout overflow and strings that bypass `t()` visible without waiting for a German or French user to report them.

## What shipped

- **`en-XA`** (the private-use region Android's developer pseudo-locale uses) is registered in `LOCALES` as a variant of `en`, exported as `PSEUDO_LOCALE`. Since `en` is bundled, `loadLocale` loads nothing before it, and dates follow `en` through `lookupDateLocale`'s base fallback. A device set to Android's pseudo-locale resolves to it through `resolveLocale('system')`, which is intended.
- **The catalog is generated** when its lazy chunk loads (`src/lib/i18n/en-XA/index.ts`), from the English bundle i18next already holds, so nobody downloads it unless they pick it. `pseudoLocalize` accents every letter with a look-alike (`q̃` is combining, Unicode has no precomposed one), pads by 40% of the text outside placeholders and tags with spaced ` ~` units so sentences still wrap, and wraps the value in `⟦…⟧`. `{{placeholders}}` and inline tags stay byte for byte, so interpolation and `Trans` keep working.
- **`ENGLISH_IN_EVERY_LOCALE`** moved from `locale-catalogs.test.ts` into `src/lib/i18n/english-in-every-locale.ts`, because the generator copies those values unchanged (`aria-keyshortcuts` tokens, `parse-date.ts` examples). `translator-context.test.ts` lists the module in `NOT_A_NAMESPACE`.
- **Settings.** The language select lists the pseudo-locale only in debug mode, or while it is the stored choice, so the select still shows the current value after debug mode is turned off.
- **`docs/TRANSLATING.md`** has a section on checking a layout with it: text without markers is hardcoded, a missing `⟧` is truncation, a broken layout is a string that will overflow in German or French. The language names in the picker stay unmarked on purpose. README and the comparisons keep counting five languages: this is a testing aid, not a language.

## Decisions and traps

- A variant skips `locale-catalogs.test.ts`' completeness check, so `pseudo-locale.test.ts` pins that the generated catalog carries every English key; nothing else would catch a dropped namespace.
- `locales.test.ts`' date-fns test asserted each tag dated in its own tag. A variant dates like its base, so it now asserts `tag.split('-')[0]`.
- `CompactionCard` splits translated labels on `:`, so its labels show `⟦…` with no closing marker. That reads as truncation, but it is the code showing part of the string: left as is.
- The scratchpad is per session, not per agent: a reviewer's `falsify.sh` was overwritten by another agent's and ran in the wrong tree once. Falsification scripts need unique names.

## What ran

- Red first: on an identity stub, the generator, `resolveLocale` and Settings tests failed with the predicted assertions. With `en-XA` registered on the stub, `locale-catalogs.test.ts` reported 4057 values identical to English.
- Falsified in one shell command each (backup, `trap` restore, `cmp`): growth 0.4 → 0.2, placeholders and tags not kept (`locale-catalogs` reported 830 values whose placeholders or tags differ), the `ENGLISH_IN_EVERY_LOCALE` exemption removed, `boot.*` keys dropped, a non-decomposable accent, `q` unaccented, the uppercase branch removed, each of the three Settings filter clauses removed, the date-fns base fallback removed, the marker wrap dropped, and both regexes loosened. Each reddened the test predicted. The reviewer re-ran its own set.
- `e2e/pseudo-locale.spec.ts` (debug mode on, pick the pseudo-locale, a marked and accented label with `lang="en-XA"`, back to English) and `e2e/language-preference.spec.ts`: 6 passed. Removing the markers from the generator, or the debug clause from the select, reddened the new spec.
- Targeted vitest over `src/lib/i18n`, `src/components/settings`, `useLanguage`, `date-utils`, `date-locale`, `preferences` and `slash-command-descriptions`: green, with one skip (the completeness check for variants). `npm run typecheck`, `npm run lint`, `npx knip`, `oxfmt --check` and typos: clean. The production build emits `en-XA` as its own lazy chunk.
- Not run: `just e2e-related` selects the whole mock lane (`set-locale.ts` has no area tag), so CI's run is the check.
