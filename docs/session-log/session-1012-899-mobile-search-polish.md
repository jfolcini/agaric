# Session 1012 — #899: mobile-search polish batch (6 features)

All behind touch/mobile gating; desktop search unchanged. (Consolidated #131–#137.)

1. **Recent searches in empty state** (#131) — `src/lib/recent-searches.ts` (per-space
   localStorage `recent_searches:<spaceId>`, cap 8, dedup, MRU); rendered in the mobile
   palette empty state, recorded on escalate, tap-to-rerun.
2. **Voice input** (#132) — `src/hooks/useVoiceInput.ts` + `src/types/speech-recognition.d.ts`;
   mic button gated on `isMobile && Web-Speech-supported` (hidden when absent); transcript →
   query.
3. **Pull-to-dismiss** (#133) — `src/hooks/usePullToDismiss.ts`; wired to the SearchSheet
   grab handle only (scroll body untouched).
4. **Long-press scope-pin** (#135) — `src/hooks/useLongPress.ts` +
   `src/lib/pinned-search-scope.ts` (`pinned_search_scope`); pins the default scope, long-press
   again un-pins; overrides the trigger default.
5. **Scope chip** (#136) — in the SearchSheet input; shows the active scope, tap/× re-scopes.
6. **Haptics** (#137) — `src/lib/haptics.ts` (`navigator.vibrate?`, feature-detected no-op);
   fired on voice start, scope pin, sheet dismiss.

Tests: unit for each lib/hook + SearchSheet/SearchSheetTrigger/CommandPalette (mocked
SpeechRecognition / vibrate / localStorage / IPC), axe passes retained. **265 tests pass;
`tsc -b` clean.**

Wants a device eyeball (per the user, shipping without on-device QA): pull-to-dismiss feel
(80px threshold / spring-back), haptic pulse strength, voice mic-permission + accuracy, and
long-press-vs-tap on a scope segment.

Closes #899.
