/**
 * i18n namespace: sync
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const sync: Record<string, string> = {
  'device.thisDevice': 'This device',
  'device.unpairConfirmTitle': 'Unpair device?',
  'device.unpairConfirmDescription':
    'This removes the pairing. Your notes and sync history remain on this device. You can pair again later to resume syncing.',
  'device.unpairConfirmAction': 'Yes, unpair',
  'device.pairedDevice': 'the paired device',
  'pairing.cancelFailed': 'Failed to cancel pairing',
  // #3715 — a queued pairing mutation that never answered (wedged daemon,
  // stuck mDNS stack). Interpolated into `pairing.startFailed` /
  // `pairing.pairFailed` by the dialog's existing error banner, so it reads as
  // the tail of a sentence rather than as a standalone one.
  'pairing.mutationTimedOut': 'the device stopped responding',
  'pairing.startFailed': 'Failed to start pairing: {{message}}',
  'pairing.pairFailed': 'Pairing failed: {{message}}',
  'pairing.unpairFailed': 'Failed to unpair device: {{message}}',
  'pairing.cameraError': 'Camera error: {{error}}',
  // #3463 (review): `confirm_pairing` arms a local proof only — it does not
  // validate the passphrase against the peer, so this device cannot claim
  // the pairing succeeded. Deliberately not "Device paired successfully".
  // #3469: this text now labels the inline WAITING state (not a toast) —
  // the dialog stays open until the outcome is actually known.
  'pairing.awaitingPeerMessage': 'Waiting for the other device…',
  // #3469 — supporting copy under the waiting-state title, explaining WHY
  // this device can't confirm success yet.
  'pairing.waitingDescription':
    'This device armed its side of the pairing handshake. It will confirm automatically once the other device connects.',
  // #3469 — fired only once the peer actually appears in peer_refs
  // (TOFU-pin on first authenticated connection). This is the one place
  // allowed to claim success, because it is the first moment this device
  // actually knows the passphrase matched.
  'pairing.pairSuccessMessage': 'Device paired successfully',
  // #3469 — the responder's wire-level rejection ("pairing passphrase proof
  // required") surfaced back into the dialog that caused it, with a path
  // back to retype (the entry form re-renders once this error is set).
  'pairing.proofRejectedError': 'The passphrase did not match. Check it and try again.',
  // #3469 — the pending-marker TTL elapsed with no peer appearing and no
  // rejection observed. Bounds the wait instead of hanging indefinitely.
  'pairing.waitTimedOut': 'No response from the other device. The pairing code may have expired.',
  // #3852 \u2014 the OS is dropping this app's packets (Android 15+'s per-uid
  // background firewall fires the moment the screen sleeps, even with the app
  // top-of-stack). This is the ONLY wording for that banner: the daemon sends
  // the key `pairing.osNetworkBlocked` (`BLOCKED_REASON_KEY` in
  // `android_network_block.rs`) and the frontend translates it, so the sentence
  // is localisable instead of being English from Rust. Renaming this key
  // reddens `useOsNetworkBlock.test.ts`, which pins the same literal.
  // It names the only action the user can take.
  'pairing.osNetworkBlocked':
    'This device paused the app\u2019s network access. Keep the screen on and this app open while pairing.',
  'pairing.qrScannedMessage': 'QR code scanned \u2014 verify and tap Pair',
  'pairing.closeDialogLabel': 'Close pairing dialog',
  'pairing.dialogTitle': 'Pair Device',
  // #3463 — the dialog opens directly on the host path (this device's own
  // code); these two strings label the affordance that switches roles.
  // Choosing "have a code" is what declares the joiner role, replacing the
  // old upfront chooser question.
  'pairing.switchToJoinerLink': 'Have a code from the other device?',
  'pairing.switchToHostLink': 'Show my code instead',
  'pairing.startingMessage': 'Starting pairing...',
  'pairing.qrCodeLabel': 'QR code for device pairing',
  'pairing.passphraseLabel': 'Passphrase:',
  'pairing.scanOrEnterInstruction': 'Scan the QR code or enter the passphrase on the other device.',
  'pairing.sessionExpiresIn': 'Session expires in',
  'pairing.sessionExpired': 'Session expired',
  'pairing.retryButton': 'Retry',
  'pairing.orSeparator': 'OR',
  'pairing.typePassphraseButton': 'Type Passphrase',
  'pairing.scanQrCodeButton': 'Scan QR Code',
  'pairing.recommendedBadge': 'Recommended',
  'pairing.wordPlaceholder': '{{ordinal}} word',
  'pairing.wordLabel': 'Passphrase word {{num}}',
  'pairing.entryFormWord': '{{ordinal}} word',
  'pairing.ordinal.first': '1st',
  'pairing.ordinal.second': '2nd',
  'pairing.ordinal.third': '3rd',
  'pairing.ordinal.fourth': '4th',
  'pairing.loadingScannerMessage': 'Loading scanner...',
  'pairing.cancelButton': 'Cancel',
  'pairing.pairButton': 'Pair',
  'pairing.pairedDevicesTitle': 'Paired Devices',
  'pairing.noPairedDevices': 'No paired devices yet.',
  'pairing.cameraDeniedFallback': 'Camera access denied \u2014 switched to manual entry',
  'pairing.confirmCloseTitle': 'Cancel pairing?',
  'pairing.confirmCloseDescription':
    'Pairing is in progress. Closing this dialog will cancel the handshake and the other device will need to start over.',
  'pairing.confirmCloseAction': 'Cancel pairing',
  'pairing.confirmCloseKeep': 'Keep pairing',
  'pairing.srCountdownMinutes_one': 'Session expires in {{count}} minute',
  'pairing.srCountdownMinutes_other': 'Session expires in {{count}} minutes',
  'pairing.srCountdownSeconds_one': 'Session expires in {{count}} second',
  'pairing.srCountdownSeconds_other': 'Session expires in {{count}} seconds',
  'pairing.copyPassphraseAriaLabel': 'Copy passphrase',
  'pairing.passphraseCopied': 'Passphrase copied',
  'pairing.passphraseCopyFailed': 'Failed to copy passphrase',
  'device.title': 'Device Management',
  'device.localDeviceIdLabel': 'Local Device ID',
  'device.deviceIdCopied': 'Device ID copied',
  'device.copyFailed': 'Failed to copy to clipboard',
  'device.copyDeviceIdLabel': 'Copy device ID to clipboard',
  'device.pairNewDeviceButton': 'Pair New Device',
  'device.pairedDevicesTitle': 'Paired Devices',
  'device.syncAllLabel': 'Sync with all paired devices',
  'device.syncAllButton': 'Sync All',
  'device.noPairedDevices': 'No paired devices. Click "Pair New Device" to get started.',
  // Shown once mDNS init has failed — the state in which a first-ever pair is
  // impossible, since the mDNS TXT record is the only pre-session carrier of a
  // peer's endpoint_id. It must not offer a manual address as the way out: an
  // unpaired peer has no row, so there is no address field, and the setting is
  // only reachable once a pair has already succeeded. See
  // sync_daemon::discovery::resolve_peer_address.
  //
  // Two reasons this stays hedged rather than reassuring:
  //  - `useMdnsStatus.disabled` is STICKY (only ever set true, no success event
  //    clears it), so this can outlive a transient failure a later init
  //    recovered from.
  //  - a paired row can carry a NULL endpoint_id: `bind_endpoint_id` is
  //    best-effort at both sites and `server.rs`'s already_bound_elsewhere
  //    branch skips it deliberately, after which resolve_peer_address returns
  //    None and try_sync_with_peer bails without an event.
  // So "may" is load-bearing — do not promote it to "can".
  'device.mdnsDisabledHint':
    'Automatic discovery unavailable: {{reason}}. Pairing a new device needs discovery working; devices you have already paired may still sync.',
  // #3864. Deliberately states only what the app can actually observe — the
  // address is outside the private ranges — and stops short of asserting the
  // device IS exposed, which it cannot know: a router handing out public
  // space to a home LAN and a VPS look identical from in here. The action is
  // conditional for the same reason. No plural forms: every interpolation is
  // a single address / single port.
  'device.internetFacingBindHint':
    'Sync is listening on {{address}}, UDP port {{port}} — outside the private network ranges, so it may be reachable from beyond your local network. That is expected if your router hands out public addresses. On a VPS or other public host, block inbound UDP to this device or turn sync off. The port changes on every restart.',
  'device.internetFacingBindAck': 'Got it',
  'device.internetFacingBindAckLabel':
    'Acknowledge this sync address; the notice returns if the address changes',
  'device.noAddress': 'No address',
  'device.editAddressLabel': 'Edit address for {{name}}',
  'device.renameDeviceLabel': 'Rename device {{name}}',
  'device.syncNowLabel': 'Sync now with device {{name}}',
  'device.syncNowButton': 'Sync Now',
  'device.unpairDeviceLabel': 'Unpair device {{name}}',
  'device.unpairButton': 'Unpair',
  'device.loadingMessage': 'Loading device information...',
  'device.syncingMessage': 'Syncing with device {{id}}...',
  'device.syncingAllMessage': 'Syncing with all paired devices...',
  'device.syncErrorMessage': 'Sync error: {{error}}',
  'device.retryButton': 'Retry',
  'device.dismissErrorLabel': 'Dismiss error',
  'device.loadFailed': 'Failed to load device info',
  'device.unpairFailed': 'Failed to unpair device',
  'device.syncTimedOut': 'Sync took too long — check your connection and try again',
  'device.syncFailedForList': 'Sync failed for: {{devices}}',
  'device.renameFailed': 'Failed to rename',
  'device.lastSyncedAt': 'Last: {{time}}',
  // #4297 — the other device unpaired, and unpairing sends nothing over the
  // wire, so the only evidence is that every dial we make is now refused.
  // These three replace the `device.lastSyncedAt` line on such a row: that
  // relative time keeps counting from the last *successful* session, so a
  // pairing that died a week ago reads as recently synced.
  'device.unpairedByPeerBadge': 'Pairing lost',
  'device.unpairedByPeerDescription':
    'The other device unpaired from this one. Pair again to resume syncing.',
  // Deliberately the moment we FOUND OUT rather than the last successful sync:
  // it is the one timestamp on this row that is not misleading.
  'device.unpairedByPeerSince': 'Stopped syncing {{time}}',
  'device.resetCount_one': '{{count}} reset',
  'device.resetCount_other': '{{count}} resets',
  'qrScanner.viewportLabel': 'QR code scanner viewport',
  'qrScanner.cameraPreview': 'Camera preview',
  'qrScanner.retryCameraButton': 'Retry Camera',
  'qrScanner.scanQrCodeButton': 'Scan QR Code',
  'qrScanner.scanningMessage': 'Scanning...',
  'qrScanner.cameraError': 'Camera access failed. Check camera permissions and try again.',
  'qrScanner.cameraUnavailable':
    'Camera is not available here. Use the 4-word passphrase to pair instead.',
  'qrScanner.cameraDenied':
    'Camera permission denied. Enable camera access for Agaric in your device settings, then retry.',
  'qrScanner.cameraNotFound': 'No camera was found on this device.',
  'device.syncComplete': 'Sync complete',
  'device.syncFailed': 'Sync failed',
  'sync.failedForDevice': 'Sync failed for device {{deviceId}}...',
  // #4305 — driven by `SyncEvent::Complete.changed_blocks`, the count of blocks
  // a session actually changed. It replaced `sync.opsReceived`, which was fed
  // `ops_received`: the number of protocol messages, one per registered space,
  // sent whether or not that space had a delta. On the reporting user's
  // two-space pair that read "Synced 2 changes from device" every 60 s forever,
  // with no edits on either device. A count in a sentence has to be a count of
  // the thing the sentence names.
  //
  // `_one` / `_other` only: `count` is never 0 here — a zero-change sync raises
  // no toast at all (see `useSyncEvents`), which is the point of #4305.
  'sync.changesApplied_one': 'Synced {{count}} change from device',
  'sync.changesApplied_other': 'Synced {{count}} changes from device',
  // #4305 — the whole-space snapshot catch-up reimports an entire space, so it
  // has no meaningful block count to report. Rather than invent one (the old
  // code's failure) or stay silent (which would hide a whole-space reimport),
  // it says the true thing it can say and claims no number.
  'sync.changesAppliedUnknownCount': 'Synced changes from device',
  'sync.failed': 'Sync failed: {{message}}',
  'sync.retryAction': 'Retry sync',
  'sync.backOnline': 'Back online. Syncing\u2026',
  'sync.noPeersTitle': 'No devices paired',
  'sync.noPeersBody': 'Sync requires at least one paired device. Open sync settings to pair one.',
  'sync.noPeersCta': 'Open sync settings',
  'sync.noPeersCancel': 'Cancel',
  'device.deviceNameLabel': 'Device name',
  'pairing.inProgress': 'Pairing in progress...',
  'device.editAddressTitle': 'Peer address',
  'device.editAddressPopoverLabel': 'Edit peer address',
  'device.addressInputLabel': 'Address (host:port)',
  'device.addressHint': 'Format: host:port (e.g., 192.168.1.100:5000)',
  'device.addressFormatInvalid': 'Format must be host:port (e.g., 192.168.1.100:5000)',
  'device.addressPortInvalid': 'Port must be between 1 and 65535',
  'device.saveAddressButton': 'Save',
  'device.cancelAddressButton': 'Cancel',
}
