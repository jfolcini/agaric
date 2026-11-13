# Session 3988 — `edit_block` rebases a stale editor's text onto the current text

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
  example.
- The editor's baseline moves only when a commit answers, so a blur overtaking an idle commit
  would rebase from a stale base and write that commit's text twice. The page store sends no base
  while another edit of the block is unanswered.
- After a rebased commit the editor keeps its own text until it is left or reloaded while clean;
  the store adopts the echo, and each later commit rebases again.
- The current text is the SQL row read in the transaction. `import_and_project` imports into the
  engine before it takes the writer lock, so a commit that wins the lock in that gap is not
  rebased and behaves as before this change. Closing it means reading the engine's text instead;
  raised with the maintainer.
- Not covered: page mode, *Edit as Markdown*, a draft flushed at blur or recovered at boot, and
  the blur branches that split or fold a task marker, property line or tag. They send no base.
- The positional `baseText` in the generated binding changed every `edit_block` payload. A
  hundred call-shape assertions in existing tests were updated to the new shape, editor commits
  asserting their real base; none was removed or weakened.
- The real-backend case has to land a pull under a dirty editor: it types faster than the commit
  debounce and clicks Sync from script, because a pointer press blurs and saves first.
- `CONFORMANCE_UPDATE=1` dirties four fixtures committed in non-canonical form (key order,
  compacted arrays). They hold no drift; restore them.

Ran: the edit, rebase, conformance and bindings Rust tests, clippy over the workspace, full
vitest, both typechecks, the `@editor` and `@sync` Playwright specs, and
`e2e-tauri/sync-two-device.e2e.ts` on the real backend, shown red with the rebase removed.
