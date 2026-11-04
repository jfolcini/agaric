# Session 3291 — The spoken-text builder for Read aloud

Slice S4 of #5745: `src/lib/speech/spoken-text.ts` turns blocks into the
utterances *Read aloud* will speak, with no UI yet (S6 waits on the
maintainer's `speechSynthesis` check on macOS and Windows).

It walks `parse(content)` and reads what the static renderer shows: text with
marks dropped, links by label, page links and tags by title, block refs by
resolved text, image alt text, tables row by row, ordered-list numbers. A
missing link, tag or block speaks "missing page / tag / block", never the id
prefix the chip shows (Q4); the miss is detected the same way the renderers
detect it. Code blocks, Mermaid, math, embeds and query blocks are named and
skipped. Property lines are stripped; the task state is spoken as its word.

A block longer than `MAX_UTTERANCE_CHARS` (4000, Android's
`getMaxSpeechInputLength`) splits at a sentence, else a word, else a hard cut
that never splits a surrogate pair. The limit counts UTF-16 code units, as
Android's `CharSequence.length()` does, so the Rust `speech_speak` check (S5)
counts `encode_utf16()` too.

Review removed a callout-label extra (it imported `CALLOUT_TYPES` from a
component, which `lib-layering` forbids), a `RangeError` guard nobody calls,
and optional resolvers no caller leaves out. The module is enrolled in
`stryker.modules.mjs`. Not spoken: a numbered block's `list_style` ordinal,
which lives outside the content; S6 must pass it in if wanted.

Ran: vitest over `src/lib/speech` and the i18n suites, `npm run typecheck`,
`npm run lint`, `prek run --hook-stage manual --all-files`, mutation
(`spoken-text`: 93.10%, 5 survivors, all equivalent), and falsifications of
the missing-tag and surrogate paths.
