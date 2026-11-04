# Session 3319 — speech_status: which engine Read aloud speaks with

Slice S5 of #5745. `commands::speech::speech_status` reports `Webview` on
macOS and Windows, whose webviews speak through `speechSynthesis`
(maintainer, 2026-11-04), and `Unsupported` everywhere else. The answer comes
from `cfg`, so Linux keeps shipping nothing speech-specific without UA
sniffing, and Android stays `Unsupported` until its `TextToSpeech` plugin (S7)
lands.

The plan also had `speech_speak` / `speech_stop` behind a `SpeechEngine`
trait with a no-engine implementation and a fake. Review cut all of it: no
target has a backend engine yet, so the trait had one impl, the fake only
tested itself, and the speak command could only ever validate and then fail.
S7 adds speak, stop, their 4000-UTF-16-unit limit (the same unit
`spoken-text.ts` splits by) and whatever seam its engine needs, together with
the code that uses them.

`speech_status` is listed in `NON_NOTE_WRITES` (`local-write-watch.ts`), whose
verb classifier would otherwise treat it as a note write and refetch the Pages
list, and in the instrumentation hook's allowlist as a constant. It changes no
state, so it carries a conformance waiver rather than a fixture.

Ran: `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt
--check`, the bindings regeneration, vitest over `src/lib/tauri-mock` and
`local-write-watch`, `npm run typecheck`. The disk allowance ran out twice
during review; this worktree's `target` was deleted and rebuilt without debug
info.
