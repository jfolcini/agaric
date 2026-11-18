# Session 4264 — adopting a folder of notes in place, the backend (#6540 slice 1)

#6540 asks whether Agaric can mirror a folder the user already keeps notes in, where it is, instead of refusing any non-empty folder. The maintainer's decisions are recorded on the issue: the folder becomes one space's folder, files stay where they are, a page renamed in Agaric moves its file to the path the mirror names, the first pass writes nothing, and a preview lists what a later write would change and which files are left alone.

What the code showed first: pointed at a vault, today's mirror would not rewrite the user's files. It lays pages out as `<space>/<title>.md`, so it would write a second copy of every note in a subfolder. Adoption therefore needed a layout with no space folder, each file's existing path kept, and no write until a page changes.

Built (`src-tauri/src/mirror/adopt.rs`, two commands, no migration, op type or store):

- `preview_mirror_adoption` and `adopt_mirror_folder` take the folder, the space and each imported note's path and page. Adopting seeds each page's state from its file's bytes, with the file's blocks given the page's block ids in order, so the existing splice keeps every line a later write does not change. The adoption (the space, plus the `.md` files no page took with their hashes) lives in one `app_settings` row.
- The mirror task gains an adopt mode: only that space, paths with no space prefix, a file pinned to its path while its page keeps the adopted title, nothing written for a page that still renders as it did at adoption (a page a link to a missing note created gets no file), a left-alone note read only once it changes, and a deleted file's page trashed as in a space folder. Copies of attachments stay off there.
- Turning the mirror off gives an adopted folder back: its marker and states go, so it is never later taken for a folder of space folders, whose layout would move its files.

Two existing mirror behaviours the tests found would damage an adopted vault, both changed for every mirror:

- The splice rewrote front matter whose keys were in another order: it compared them as an ordered list. They now compare in any order.
- A renamed page's file was written whole at its new path, in Agaric's form. The splice now runs against the last text wherever it was, so the file keeps its own lines.

The UI (Settings → Data, with the preview) and its real-backend e2e spec are slice 2. The first-run prompt waits on the device checklists #6514 and #6515.

## What ran

- `cargo nextest run --workspace -E 'test(/mirror|specta|bindings/)'`.
- Each guard falsified once by one-command mutation (the adopted-unchanged guard, the path pin, the left-alone check, the trash branch, the rename splice, the front-matter sort, giving the folder back): each reddened the predicted assertion.
- `cargo clippy --workspace --all-targets -- -D warnings`, `just gen-sqlx`, `just gen-bindings`.
- `npx vitest run src/lib/tauri-mock`, `npm run typecheck`.
