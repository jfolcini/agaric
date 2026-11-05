# Session 3396 — Markdown mirror, outbound

#5363 slice 1 (#6277 H1): with a folder chosen in Settings → Data, Agaric writes each live page to `<folder>/<space>/<title>.md` and keeps the files current. Desktop only, off by default. Built on the 2026-11-04 plan answers: a marker file names the mirroring device, a 2-second tick plus full passes, per-page state files plus one `mirror.folder` setting, and polling. The amendments of the same day apply too: the state holds `{ text, line_ids }` shadows, and anchors go only on addressed blocks.

Decisions worth knowing later:

- **Dirty set.** It comes from this device's own `op_log` rows by `seq`, from the pages named by `SyncEvent::Complete`, and from the pages linking to a renamed page. There is no hook in `commit_and_dispatch`. A peer's ops are never read from `op_log`, because their timestamps can be older than any watermark. A sync that changed nothing (`changed_blocks == Some(0)`) does not rescan.
- **Rename order.** A rename removes the old file, and only if it still equals the newest shadow, before writing the new one. Otherwise a case-only rename on a case-insensitive file system would delete the file it had just written.
- **Never overwrite.** A file that matches neither the newest shadow nor the render is never overwritten or removed. It is listed as diverged and retried every tick, so restoring it clears the listing.
- **Pausing.** A missing folder or marker, or a marker naming another device, pauses the mirror. The marker is checked again before each page write, so a drive unplugged mid-pass leaves nothing on the system disk.
- **Anchors.** `file_anchors` in `markdown.rs` writes `^ID` only on a block in A3's `addressed_blocks` (#6306), which the file read (`PageRead::File`) loads. Any other block is written the way a block copy writes it: it gets an anchor only when its text would otherwise read back as something else, such as an open fence or a trailing `^word`. Without its anchors, the file reads back as the buffer does, under the same line ids.
- **Paths** are ported from `export-graph.ts` into `mirror/paths.rs`. Collisions are folded with `normalize_tag_name`, and colliding names are disambiguated in id order. The ZIP keeps its TS copy; the maintainer was asked about this (Q-paths).

The widened Document proptest found that a page property holding `\r` makes Edit as Markdown refuse every save of that page. Filed as #6325; the generator leaves `\r` out of front-matter values until it is fixed.

What ran:
- `cargo nextest run -p agaric --lib` over `mirror::`, `commands::pages::markdown` and `ts_bindings_up_to_date`: 136 passed.
- `cargo clippy --workspace --all-targets -- -D warnings`; `SQLX_OFFLINE=true cargo check --workspace --all-targets`.
- The settings and tauri-mock vitests: 1986 passed.
- `npm run typecheck` and `npm run lint`.
- Playwright `e2e/mirror-settings.spec.ts`.

Every mirror test was shown red by breaking the code it covers. `e2e-tauri/mirror-outbound.e2e.ts` was not run here, because there is no tauri-driver; CI's real-backend lane is its first run. Not verified: the native folder dialog, macOS and Windows file systems, and a mobile build.
