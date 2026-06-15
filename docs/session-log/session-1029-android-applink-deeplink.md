# Session 1029 — Android App-Link deep-link routing (#741)

Follows the gcal removal (session 1028 / PR #1228). Removing the Google Calendar
OAuth feature dropped the *original* driver for #741 ("hard-blocks #134 Android
OAuth"), but left the underlying routing bug standing — and actually simplified
the fix by removing the "design the OAuth callback route in the same pass"
sub-task. Issue #741 was re-scoped on GitHub before implementing.

## The bug

`tauri.conf.json` registers the Android deep-link config as `host: agaric.app`,
`pathPrefix: ["/o/"]` — so Android **App Links** arrive as
`https://agaric.app/o/<route>`. But `parse_deep_link` (`src-tauri/src/deeplink/
mod.rs`) accepted *only* `scheme == "agaric"` and returned
`DeepLinkError::WrongScheme("https")` for everything else, which `dispatch_url`
warn-logs and drops. Net: **every Android App Link silently no-opped**, and the
`agaric://` custom scheme is registered desktop-only — so mobile had no working
deep links at all. Matters for OS-notification taps (FEAT-11 / #138), share-sheet
and automation links.

## Shipped — PR (branch `fix/741-android-applink-deeplink`)

`parse_deep_link` now normalizes **two** URL shapes into the same `(route host,
identifier)` before the existing block/page/settings match:

- `agaric://<host>/<id>` — custom scheme (desktop), unchanged behaviour.
- `https://agaric.app/o/<host>/<id>` — Android App Link. The `https` arm
  rejects any authority other than `agaric.app` (`UnknownHost`) so the router
  never hijacks ordinary web URLs the OS hands us, requires the `/o/` path
  prefix (matching the registered `pathPrefix`), and skips empty path segments
  so a trailing/doubled slash can't shift the mapping.

Added `APP_LINK_HOST` (`"agaric.app"`) and `APP_LINK_PREFIX` (`"o"`) constants
keyed to the `tauri.conf.json` mobile config. **No config change** — the config
was already correct; only the router was broken. Updated the module doc and the
`DeepLinkError` doc comments to describe both shapes.

Tests: 12 new cases (App-Link happy paths for all three routes, ULID
upper-casing, case-insensitive route host + authority, trailing/doubled-slash
tolerance, query-string ignore, and rejections for foreign authority, wrong path
prefix, unknown route host, missing identifier, empty path, invalid ULID). The
pre-existing `rejects_wrong_scheme` test used `https://example.com/...` expecting
`WrongScheme("https")` — repointed to `ftp://…` since `https` is now a valid
scheme (a foreign https *authority* is covered by a new `UnknownHost` test
instead). Full deeplink suite: 37 passed.

## Notes

- The fix is Rust-only; the issue's `javascript` label is misleading — the FE
  `useDeepLinkRouter` only listens to the typed `deeplink:*` events and is
  untouched.
- Branched off `origin/main` (not the gcal branch): the deeplink module and
  `tauri.conf.json` are disjoint from PR #1228's diff, so no chain/conflict. The
  stale OAuth wording in the module doc was rewritten to describe navigation
  routing, phrased so it's accurate regardless of #1228's merge state.
