# Session 3990 — sync says why: a device that is away, and two versions that cannot sync

`Refs #6523` (two of four items; a forked history and an engine/SQL disagreement stay open).

- A paired device that is simply away reads "Waiting for <device>, last synced <when>", with a grey
  dot and no toast. Away is a dial timeout with no mDNS announcement and no recent pull from that
  peer, coded `peer_away`.
- An engine-format mismatch is explained on both devices and names the one to update. The device
  that was dialled answers the handshake with a fixed refusal sentence worded for the dialler,
  which maps it back to `engine_format_mismatch` with `peer_is_older`. An older peer that closes
  right after the handshake, having synced before, is coded `handshake_unanswered`.

Decisions and traps:

- `peer_away` repeats on every attempt. Since #6601 a withheld repeat reads as an unanswered
  failure in the frontend, so reporting once per streak would turn the status red again within a
  minute. It has its own log text: repeats are suppressed by matching text, and sharing the timeout
  text would swallow the first real timeout once the peer is back.
- A peer still pulling from us as initiator is not away.
- The dialler no longer adds a generic "Sync failed" after the version explanation; it used the
  same toast id and store field and overwrote it.
- A device that refuses on version stops there: it does not bind the peer or record its name.
- Existing Rust assertions changed on purpose: the refusal is now a frame, not a closed stream, and
  two connection-failure tests state that mDNS still announces the peer, because a silent peer now
  counts as away.
- A negative toast check passes before a toast can render. Add a later control toast and assert
  the exact list.

Gaps, raised with the maintainer:

- Pressing Sync while an away peer is in backoff still says "Sync failed for device".
- The status card's "Last synced" counts this session only, so it can show "--" beside the
  waiting line's real time.
- A build already shipped shows the new refusal sentence inside its own "Sync failed" wrapper.

Ran: the `agaric-sync` package and the app's sync tests, clippy over the workspace, the hooks,
stores, layout, agenda and peers vitest suites, typecheck, and the fourteen sync Playwright specs.
Both whole e2e lanes were left to CI.
