# Session 3282 — Delete #132's search mic

Slice S2 of #5745. The maintainer decided dictation is the OS's voice typing
(Gboard voice, macOS Dictation, Win+H) in every field, with no in-app mic, so
#132's palette mic goes: `useVoiceInput`, its test, the ambient
`speech-recognition.d.ts` types, the button in `CommandPalette`, its describe
in `CommandPalette.mobileSearch.test.tsx`, and the two `searchSheet.voice*`
keys. The mic was gated on `SpeechRecognition`, which Android WebView switches
off, so it almost certainly never rendered in the Android app.

The comments that cited the mic as a reason to keep `<html lang>` accurate now
cite assistive tech alone, which still holds. The `/voice` voice-note recorder
(#5364) records audio, is not dictation, and stays.

Ran: vitest over `src/components/common`, `src/hooks` and the i18n tests,
`npm run typecheck`, `npm run lint`, knip.
