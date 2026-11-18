# Session 4364 — an unpaired device that a running sync brings back

The real-backend lane went red on #6956 (`sync-two-device.e2e.ts`, "unpairing refuses the peer's next sync"): the device list was empty right after the unpair and showed the peer again after a round trip through the Journal.
