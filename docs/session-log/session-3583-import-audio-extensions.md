# Session 3583 — every attachment extension imports

This checks #6032's question of whether the MIME allow-list drops Evernote audio, Office and zip resources. The allow-list already takes audio, zip and tar (#6203), and Office and video stay out by decision. One gap was left: an import ingests a file by the type its name guesses (`guess_attachment_mime`), and that guess knew no `.aac`, `.oga`, `.opus`, `.webm` or `.markdown`, all of which the app takes as attachments. Such a file was guessed `application/octet-stream` and skipped with a warning; Obsidian records audio as `.webm`.

- Fix: `guess_attachment_mime` maps those extensions. A test in `commands/attachments.rs` walks `ATTACHMENT_EXTENSIONS` and asserts each guess is allowed, so the two lists cannot drift apart.
- Not added: `.amr` (Evernote Android voice notes), which no browser plays; it is still skipped with a warning.
- Ran: the new test, red against origin/main (`.oga` guesses application/octet-stream) and green with the fix; clippy over the workspace and the offline check. nextest could not be installed locally, so the test ran under `cargo test`.
