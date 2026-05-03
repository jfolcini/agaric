# PEND-01 — Rename `MDNS_SERVICE_NAME` from `BlockNotes` to `Agaric`

**Status:** ✅ DONE (this session, by sed). Recorded here for completeness; no further work.

## Problem

`MDNS_SERVICE_NAME` was hardcoded to `"BlockNotes"` — a placeholder name from an earlier project iteration. The mDNS service *type* was already `_agaric._tcp.local.`, so the wire-visible discovery name was `BlockNotes_<device_id>._agaric._tcp.local.` — internally inconsistent and stale.

## Why a sed was safe

- The user confirmed **no devices are currently paired** at the time of this session.
- The change is wire-visible, so a device upgraded after another would otherwise fail to discover its peer over mDNS — but with zero paired devices today, there is nothing to break.
- All occurrences (8 total: 4 in `src-tauri/src/sync_net/websocket.rs`, 4 in `src-tauri/src/sync_net/tests.rs`) were the literal string `BlockNotes`. No mixed-case or partial-string variants existed elsewhere in the repo.

## Change applied

```bash
sed -i 's/BlockNotes/Agaric/g' \
  src-tauri/src/sync_net/websocket.rs \
  src-tauri/src/sync_net/tests.rs
```

After the rename:

- `MDNS_SERVICE_NAME = "Agaric"` (was `"BlockNotes"`)
- mDNS instance fullname format: `Agaric_<device_id>._agaric._tcp.local.`
- Tests now assert `MDNS_SERVICE_NAME == "Agaric"`

## Cost / Impact / Risk

| | |
| --- | --- |
| Cost | trivial (one sed, ~30 seconds incl. verification) |
| Impact | low — internal naming consistency only, no user-visible behavior change |
| Risk | low — confirmed zero paired devices; if any peer pairing existed it would be broken until both sides upgraded |

## Verification

- `grep -n "BlockNotes" src-tauri/src/` returns no matches.
- `cargo nextest run` should pass (the test in `sync_net/tests.rs:1356-1357` now asserts the new value).

## Follow-up

None. This entry stays in `pending/` only as documentation that the change happened intentionally and what to do if you ever pair devices and then have to rename the constant again (introduce a one-release accept-both-names compat window).
