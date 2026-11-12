# Session 3955 — bookmarks as a synced page property

`Refs #6544` (eighth checkbox). Design note and the maintainer's decisions are in the issue's
comments.

A bookmark was an id in a per-device localStorage list. It is now the property `bookmark` on the
page block; its number is the page's place in the sidebar, so bookmarks and their order sync.
`useStarredPages` keeps its return shape and reads one TanStack query per space
(`query_by_property`, then `get_batch_properties`). A drop writes one property, the midpoint
between the new neighbours, and renumbers the space's bookmarks only when no number fits. The old
list is migrated once after the spaces load and its key removed when every id has landed or been
dropped; a throw keeps the key for the next boot.

Decisions and traps:

- `query_by_property` returns live pages only, so a trashed page leaves the list and has to be read
  again when it is restored. The bookmark queries subscribe to `invalidateNameCaches`, which every
  restore path already fires; `invalidateDerivedCaches` reaches them through it. The subscription
  is at module level because the phone sidebar unmounts when its drawer closes.
- `bookmark` is internal in both `INTERNAL_PROPERTY_KEYS` copies, and the Edit-as-Markdown buffer
  drops it as it drops `template`: a buffer that showed an app-kept key would refuse every save.
  Export still writes it; import reads it back as text, so the number reader accepts a numeric
  `value_text`.
- The test fake `bookmarkInvokeHandlers` keeps trashed pages in its list, unlike the backend. A
  test that depends on the backend's filtering uses the mock's `dispatch`.

Known limits, left as they are:

- A star clicked before the list has loaded, or after a failed read, is numbered 1 instead of
  highest plus one.
- A re-read that started before a write and answers after it shows the old list until the next
  invalidation; the stored state is right.
- The migration drops an id on any validation refusal, because the backend has no code for "the
  page is in the trash". A space with a user-declared `bookmark` definition of another type would
  lose that device's list.
- A page that already carries a user's own `bookmark` property shows as bookmarked.

Checks run: the whole vitest suite, typecheck, lint, the manual-stage hooks, the Playwright specs
`bookmarked-pages`, `pages-view` and `page-link-drag`; in Rust the targeted nextest filters for the
two touched tests and clippy over the workspace. Each new behaviour was shown red by breaking the
code it covers. The full Rust suite and `e2e-tauri` ran in CI only.
