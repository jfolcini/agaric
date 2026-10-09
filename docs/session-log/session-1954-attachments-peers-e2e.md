# Session 1954 — e2e: attachment rename, /attach refusals, peer management (#5365)

Mock-lane scenarios from #5365, each asserting state re-read from the mock
backend after leaving and returning.

- `e2e/attachments.spec.ts`: renaming an attachment survives reopening and
  History lists one `rename_attachment`; `/attach` attaches an allowed file
  (name, type, size re-queried) and refuses a disallowed type and a file over
  the 50 MiB cap with their toasts, leaving no row.
- `e2e/sync-pairing-flows.spec.ts`: the empty peer-management `test.skip` is
  now three tests: unpair, rename and manual address each persist.
- `src/lib/tauri-mock/handlers/sync.ts`: `list_peer_refs` returns copies, not
  the live stored rows that `update_peer_name` / `set_peer_address` mutate in
  place (the React Compiler kept rendering the old object). Mock only; the
  real IPC returns fresh objects.

Verified: each test red with its code broken (rename not sent, bytes dropped,
type check always passing, refusal not stopping the upload, delete not sent,
empty name, wrong port), restored and `cmp`-checked; 47/48 under
`--repeat-each=3` at load ~60 (the one stall re-ran 9/9); typecheck, oxlint,
oxfmt clean.
