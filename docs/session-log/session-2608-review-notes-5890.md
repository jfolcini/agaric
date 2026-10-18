# Session 2608 — review note from #5890

`fuzz-artifacts` stops carrying `src-tauri/fuzz/corpus/`: since #5890 the
corpus is its own 90-day `fuzz-corpus` artifact, so every run uploaded it
twice. With one path left, the artifact's root is `src-tauri/fuzz/artifacts/`
rather than its parent, so `file-fuzz-findings.mjs`'s reproducer hint now
downloads it into that directory (`gh run download … -D
src-tauri/fuzz/artifacts`) before `cargo fuzz run` from `src-tauri/fuzz`.

Ran: `file-fuzz-findings.test.mjs` (20), prek on the changed files.
