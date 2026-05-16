<!-- markdownlint-disable MD060 -->
# Sync

Agaric syncs across your own devices over local WiFi. **No cloud, no accounts, no third-party servers.** Edits converge automatically via CRDT — there is no conflict dialog because there are no merge conflicts to resolve.

## What you can do

- **Pair a new device** via QR code (scan with the new device's camera) or by typing a 4-word passphrase.
- **See your paired devices** in Settings → Sync & Devices (the **DeviceManagement** tab).
- **Manually trigger a sync** from the sidebar's Sync button.
- **Cancel an in-flight sync** while it's running.
- **Unpair** a device (with confirmation).
- **Rename a device** so it's recognisable in your list.
- **Set a manual address** for a peer when mDNS discovery is unavailable (e.g. across subnets).

## Pairing flow

1. On the **first device**: Settings → Sync & Devices → *Pair new device*. The **PairingDialog** opens with a QR code and a 4-word passphrase. The session lasts 5 minutes (the countdown pauses while you're typing on the other side).
2. On the **second device**: same path. Choose *Scan QR code* (camera) or *Enter passphrase* (4 word boxes).
3. On scan / entry, both devices exchange certificates and add each other to their peer lists. The peer's TLS certificate hash is pinned on first contact (TOFU) — subsequent connections verify the same hash.
4. The first sync runs immediately. Large vaults use **snapshot catch-up** (see below) so you don't wait for thousands of small operations.

If the camera isn't available (no permission, headless device), you can also upload a screenshot of the QR code.

If you click the Sync button before any device is paired, the **NoPeersDialog** appears with a direct path into the pairing flow.

## What the user sees

- **Sidebar Sync button** with a status dot:
  - Grey: idle.
  - Spinning + blue: syncing now.
  - Red: last attempt failed (toast offers *Retry*).
  - Strikethrough WiFi: offline.
- **Tooltip** on the Sync button: state plus *"Last synced N ago"*.
- **Per-peer progress** while a sync is running (operations sent / received, then attachment-file transfer with byte progress).
- **Retry toast** per peer on failure — partial failures don't blow up the whole batch.
- **Re-auth banner** (**GcalReauthBanner**) at the top of the page editor when a connected Google Calendar OAuth token has expired (sync to GCal pauses until you re-auth).

## How sync runs

- **Discovery**: mDNS announces and discovers peers on the local network. On Android, Agaric holds a multicast lock so mDNS keeps working when the screen is off.
- **Automatic triggers**: edits queue a debounced sync; the daemon also runs a periodic resync tick. Both back off exponentially on failure, per peer, with jitter so two devices don't lock-step.
- **Offline / foreground awareness**: a device that goes offline stops trying immediately; a device that backgrounds skips its resync ticks until foreground. Coming back online retries immediately.
- **Wire**: TLS over WebSocket. CRDT operations and snapshots flow over the same connection.

## Snapshot catch-up

When a peer is so far behind that the log has been compacted past its frontier (typical on a fresh device, or after a long absence), the responder sends a full snapshot instead of replaying the log. Snapshots stream in 5 MB binary frames and apply atomically — your local data is wiped and restored in one transaction, so a snapshot apply can never half-fail. The first sync of a fresh device on a large vault might take a moment; subsequent syncs are incremental.

## Per-peer settings

In **DeviceManagement** you can per-peer:

- **Rename** the device (the name shows up in tooltips, sync progress, the activity feed).
- **Set a manual address** (`host:port`) for peers that mDNS can't see.
- **View status** (last sync, last error, certificate fingerprint).
- **Unpair** — confirmation required (non-reversible without re-pairing).

## What's not synced

- **Local-only state**: keyboard customisations, sidebar width, recent tabs, last-opened view per space, theme preference, draft autosave entries that never persisted.
- **Link preview cache** (each device fetches independently).
- **MCP / agent activity feed** (per device).

## Pitfalls to know

- **Both devices must be on the same local network.** Agaric does not relay over the internet. For across-network sync, set a manual `host:port` on a reachable address (e.g. VPN-routed).
- **First-launch firewall prompt** (especially on macOS): allow incoming connections so peers can reach Agaric.
- **mDNS on Android needs multicast — built in.** Some routers disable multicast; if your other devices can see each other on the network but Agaric can't, that's the likely cause.
- **TOFU on first pair.** If you re-install Agaric on a peer, its certificate hash changes — you'll need to unpair and re-pair.
- **Pairing session is 5 minutes.** If the timer expires, restart from the first device.
- **The Sync button does the minimum.** It triggers what's already due; if you've just edited something, the auto-sync may have already fired by the time you click.
- **Unpaired by mistake?** Pair again from either device. The new pairing replaces the previous certificate hash via TOFU.
