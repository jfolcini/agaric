# Session 4488 — the stale copies the maintainer approved fixing

Three copies the night's work left stale. The maintainer approved both AGENTS.md edits.

- **`.github/AGENTS.md` § Caches:** the real-backend lane's `.debs` were "kept warm … for the same reason" as a key only `main`'s weekly run saved. The lane is no longer weekly. The line now gives the reason `ci.yml`'s `e2e-tauri-apt-cache` comment gives since #7113: a PR's run restores that cache but cannot save it, and its key moves with the runner image.
- **`src/stores/AGENTS.md`:** the list of writes that call `recordGraphStructureChange` at once, to expire hover-prefetched subtrees, now names a page removal (`notifyPagesRemoved`) beside a restore and a page-store write. #7109 put that call back.
- **`docs/BUILD.md`:** the npm prerequisite named `npm@12.2.3` twice, and its by-hand install command would go stale with the next npm bump. It now says `packageManager` pins the exact npm, and the by-hand route is `bash scripts/require-npm.sh --install`, which installs that pin.

**Ran.** `prek run` on the three files.

**Also settled, outside this diff.**
- **#6540 decision 4:** the maintainer kept the rename rule #6974 shipped, and the reason is recorded on #6540. The import titles a note by its path, so an adopted page's computed path is its own file.
- **Stale branches:** of the remote branches, only `claude/6540-adopt-folder-backend` (no PR, an older copy of #6974's work) is stale. The proxy refuses branch deletes, so the maintainer deletes it in the UI.
- **Force-with-lease allow rules:** not added. Adding allow rules to `.claude/settings.json` was refused from this session, so the maintainer adds them.
