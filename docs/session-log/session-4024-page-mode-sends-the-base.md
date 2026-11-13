# Session 4024 — page mode's save of a block sends the base text

`Refs #6533` (the second follow-up the maintainer decided on 2026-11-13).

Page mode's per-block save passes the text it last knew the block held (`saved.markdown`) as
`base_text`, so `edit_block` replays what was typed on the text a peer left, as it does for block
mode since the rebase PR. A block edited elsewhere while it holds an unsaved edit is not patched in
the document; before this its next save wrote the local text over the peer's.

Decisions and traps:

- After a rebased save page mode records its own text as saved, not the merged one. The next
  reload then sees a row that differs from it under an untouched node and patches the peer's edit
  into the document; a key typed before that reload is rebased again from the same text.
- The writes that fold a task marker, a `key:: value` line or a tag out of the text
  (`page-tasks.ts`, `page-properties.ts`, `page-tags.ts`) send no base, as block mode's blur
  branches send none.
- `FakeBackend.edit` rebases through the mock's `rebasedOnto`, so the unit tests assert what the
  backend holds, not the call.
- One existing assertion pinned the behaviour this changes: `remote-patch.test.ts` "keeps the local
  text of a block edited here and not saved yet" expected the backend to hold `alpha!` after a peer
  wrote `alpha from a peer`; it now expects `alpha from a peer!`. `e2e/page-mode.spec.ts` "typing
  saves after a pause" expected `baseText: null` and now expects the block's text.
- `page-mode-parity.test.ts` is unchanged: the base changes no op either mode writes when nothing
  was edited elsewhere.

Ran: the page-mode vitest directory, typecheck, lint, and `e2e/page-mode.spec.ts`. With the base
removed from `run`'s edit, the new unit test, the edited `remote-patch` test and the new e2e test
go red on the stored text (`alpha!` for `Peer: alpha!`), and the call-shape assertion with them.
