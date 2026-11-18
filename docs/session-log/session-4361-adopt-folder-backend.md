# Session 4361 — adopting a folder of notes in place, the backend (#6540 slice B)

#6540 asks whether Agaric can mirror a folder the user already keeps notes in, where it is, instead of refusing any non-empty folder. The maintainer's decisions are on the issue: the folder becomes one space's folder, its files stay where they are, the first pass writes nothing, a preview lists what writes would change and which files are left alone, a page renamed in Agaric renames its file in its own folder (moving it only when the title's namespace changes), a trashed page's file goes to the OS trash, a mass change asks first, and Logseq is import-only. The mirror aims at a folder Obsidian can open.

Pointed at a vault, the mirror as it was would not rewrite the user's files: it lays pages out as `<space>/<title>.md`, so it would write a second copy of every note in a subfolder. Adoption needed a layout with no space folder, each file's path kept, and no write until a page changes.

Built (`src-tauri/src/mirror/adopt.rs`, two commands; no migration, op type or store):

- `preview_mirror_adoption` and `adopt_mirror_folder` take the folder, the space and each imported note's path and page. Each page's state starts from its file's own bytes, its blocks given the page's ids in order, with the page's render at adoption as the splice's base (#6948), so a write keeps a block's own lines until that block changes in Agaric. The preview's diff shows each file as it reads once every block Agaric reads as other text is changed in Agaric.
- The mirror's adopt mode: only that space, paths with no space prefix; each page's pin (its adopted path and title) keeps the file there, renames it in its folder on a rename within the same namespace, and moves it to the path the mirror names otherwise; nothing is written for a page whose buffer is unchanged since adoption, so a page a link to a missing note created gets no file; a note no page took is read only once it changes; a deleted file trashes its page as in a space folder, and many files changed or deleted at once hold reading back, counted across the whole folder; copies of attachments stay off.
- A trashed page's adopted file goes to the OS trash (the `trash` crate, desktop only, as the mirror is), its folders kept. Android has no mirror, so it needs no fallback.
- A Logseq graph (`logseq/config.edn`, or `pages/` and `journals/` at the top, the importer's own test) is refused with "import it instead".
- Turning the mirror off, or choosing another folder, gives an adopted folder back: its marker and states go, so it is never later laid out as a folder of space folders, which would move its files. Choosing it again keeps it adopted.

The two non-blocking notes on #6948: a kept block must now parse at its render's depth, shown red first; and the read-back of a file edited outside Agaric reads every block as Agaric reads it, so the docs sentence about kept lines now says so.

The Settings entry with the preview and its real-backend e2e spec are slice C. The first-run prompt, slice D, waits on the device checklists #6514 and #6515.

## What ran

- `cargo nextest run --workspace -E 'test(/mirror|specta|bindings/)'`.
- Each guard falsified once by one-command mutation (the buffer guard, the pin, the left-alone check, the trash branch, the OS trash, the seeded base, the adopted mass-change count and its paths, both Logseq tests, giving the folder back, the depth check): each reddened its own test.
- `cargo clippy --workspace --all-targets -- -D warnings`, `just gen-sqlx`, `just gen-bindings`, the fuzz lockfile refreshed.
- `npx vitest run src/lib src/components/settings`, `npm run typecheck`.
