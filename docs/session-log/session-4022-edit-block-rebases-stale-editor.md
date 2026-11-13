# Session 4022 — `edit_block` rebases a stale editor's text onto the current text

`Refs #6533` (the last open item: a dirty editor's commit no longer overwrites a peer's edit to the
other end of the same block).

`edit_block` takes `base_text`, the text the editor started from. When the block's current text
differs from that base, `agaric_engine::edit_rebase::rebase_edit` replays the editor's single
prefix/suffix splice on the current text; overlapping splices fall back to the text sent, as
before. The op carries the rebased text, so payload, hash and replay are unchanged. The idle
commit and the plain-edit leaf of the blur flush send the editor's `storedMarkdown` as the base;
every other caller sends none. The mock has a code-point twin, pinned by a backend-authored
fixture.

Decisions and traps:

- Two insertions at the same point both survive, the peer's first. That is the issue's own
  example. An edit the block already holds is written once: the idle commit and the blur that
  re-sends its text, landing in the other order, would otherwise write the text twice.
- Splices count code points, so two edits of one grapheme (a letter and its combining mark, an
  emoji and its skin-tone modifier) are apart and both kept, giving a cluster neither side typed.
- The editor's baseline moves only when a commit answers, so a blur overtaking an idle commit
  would rebase from a stale base and write that commit's text twice. The page store sends no base
  while another edit of the block is unanswered.
- After a rebased commit the store adopts the merged text and the editor keeps its own until the
  block is left (a reload re-feeds it only with text the store does not hold yet); each later
  commit rebases again from the editor's text.
- The current text is the SQL row read in the transaction. `import_and_project` imports into the
  engine before it takes the writer lock, so a commit that wins the lock in that gap is not
  rebased and behaves as before this change. Closing it means reading the engine's text instead;
  raised with the maintainer.
- Not covered: page mode, *Edit as Markdown*, a draft flushed at blur or recovered at boot, an
  Enter that splits the block mid-text, a slash command or *Turn into* that rewrites it, and the
  blur branches that split or fold a task marker, property line or tag. They send no base, so
  they still write the editor's text over a peer's edit.
- The positional `baseText` in the generated binding changed every `edit_block` payload. A
  hundred call-shape assertions in existing tests were updated to the new shape, editor commits
  asserting their real base; none was removed or weakened.
- The real-backend case has to land a pull under a dirty editor: it types faster than the commit
  debounce and clicks Sync from script, because a pointer press blurs and saves first.
- `CONFORMANCE_UPDATE=1` dirties four fixtures committed in non-canonical form (key order,
  compacted arrays). They hold no drift; restore them.
- The mock counts code points and the backend cuts bytes on char boundaries. A property test
  holds `rebase_edit` to a `char`-counted twin of the mock's algorithm, and the fixture gained the
  case where UTF-16 units would decide otherwise: `😀😁`, the peer deletes the first, the editor
  types between them. Counted in units the deletion reaches past the insertion and nothing is
  merged; the mock written with `split('')` goes red on it (`😀x😁` for `x😁`).
- `main` gained a caller while the branch waited (`renameSavedView`); it sends no base.

Ran, on the tree that merges `main`: clippy over the workspace with all targets, the
`SQLX_OFFLINE` check, the workspace nextest, the doc-tests, full vitest, typecheck, lint, and the
Playwright specs that touch `edit_block` (`reload-keeps-editor`, `page-mode`, `page-source-edit`,
`history-keyboard-controls`, `pdf-annotation-1452`, `unlinked-references`). `just e2e-related`
selects both whole lanes, which are CI's; `e2e-tauri/sync-two-device.e2e.ts` was run on the real
backend by the builder, shown red with the rebase removed, and not again here.
