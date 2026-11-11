# Session 3798 — Read aloud follow-ups and mutation sweep (#5745)

Review notes from #6484, plus the #5745 box "Mutation-test the speech module and the Read aloud text builder and control".

- **Stale engine replies.** The mutation run on `read-aloud.ts` turned up three ways a reply meant for an old reading reached a new one:
  - a speak still queued for a reading stopped while it waited on the last `stop_speaking`;
  - a replaced reading's late `Stopped`;
  - a replaced reading's late rejection.

  Each could end the reading that replaced it. `speakNative` is now one async function that checks the reading is still active after each await, and each case has a test shown red against its break.
- **Reviewer notes fixed:**
  - A rejected `speak_text` logged `[object Object]`, because `unwrap` throws the `AppError` object; it now logs the engine's message.
  - `SpeechPlugin.kt` left a pending utterance behind when `engine.speak` threw, so a later `stop` settled an already-rejected invoke; it now drops the entry.
- **Mutation, frontend.**
  - `stryker.modules.mjs` now runs `read-aloud-native.test.ts` against `read-aloud`, which had run only the webview tests.
  - The engine flag is a boolean, so no string tag is left with no reader.
  - Left: `read-aloud`'s toast counter, and the eight `spoken-text` survivors, all already recorded in `mutation-accepted.tsv` (#6437, #6439).
- **Mutation, Rust.** Run as `cargo mutants --no-config --workspace --file src/commands/speech.rs --exclude-re 'android::' --in-place`, with nextest filtered to the speech tests.
  - The first run missed the three `#[tauri::command]` wrappers. New tests drive them through `tauri::test::mock_app()` with a managed `SpeechState`.
  - The re-run caught all 10 viable mutants. The other 8 replace a function body with `Default::default()` for a type that has none, so they do not compile.
  - The `android::` module only compiles for Android, so nothing on Linux can mutate it.
- **Trap.** A disk-full build counts as "unviable" in `cargo mutants`. A run that has more unviable mutants than it should needs `df` checked before its numbers are believed.
