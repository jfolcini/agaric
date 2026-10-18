# Session 2632 — page mode's refused commands each have a test that the refusal leaves the backend and the page as they were

The rejection-path gaps #5743's audit listed for page mode, as tests only; no
production code changed.

- **Dates:** a refused scheduled date, drawer clear of the due date, Ctrl+Shift+D
  date link (`create_page_in_space`), and `/until` repeat end each show their
  toast and leave the backend and the chip or metadata row unchanged.
- **Properties:** a refused delete from an emptied chip and from the drawer keep
  the chip, the row and the backend value.
- **Page open:** `get_batch_properties` or `list_attachments_batch` refused
  shows `error.loadBlocksFailed` and mounts no editor. A refused reload keeps
  the document and its save state, so the next keystroke writes only its own
  block and the next reload brings the peer's edit in. That failure is only
  logged; whether it should toast is a product question left open.
- **Typed tags:** the audit expected an `add_tag` rejection, but the tag commit
  never calls it: it looks names up with `list_all_tags_in_space` and writes
  `#[id]` through `edit_block`. Each of those refused leaves the text as typed.
  The "#name typed and left" test gains its `axe` check.
- **Queries and embeds:** the open path asserts `onBlocked` is not called.
- **Property test:** `expectTagsHeld` checks every tag name the commit receives
  comes back as that name's `#[id]`; the old "no tag written as text" check
  stayed green when the commit dropped the name.

Each test was shown red at its assertion by breaking the code it covers. The
reviewer replaced a call-count assertion with a flush, deleted a vacuous
backend check, and folded the tag helper's special case for `Work`, which the
mock's name dedup made dead.

Ran: `vitest run src/editor/page-mode` (260), the full vitest suite,
`npm run typecheck`, `npm run lint`. Under full-suite load
`SearchPanel.test.tsx` failed on an unstubbed `load_page_subtree` and the
property test hit its 20 s timeout; both pass alone and neither is touched
here (#5908).
