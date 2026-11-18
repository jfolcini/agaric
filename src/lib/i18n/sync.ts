/**
 * i18n namespace: sync
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const sync: Record<string, string> = {
  // Translators: History entries: shown in place of a device name for a change made on this device.
  'device.thisDevice': 'This device',

  // Translators: Unpair confirmation dialog (Settings › Sync & devices, and the Pair device
  // dialog): title, body and confirm button. "Unpair" = stop syncing with a paired device.
  'device.unpairConfirmTitle': 'Unpair device?',
  'device.unpairConfirmDescription':
    'This removes the pairing. Your notes and sync history remain on this device. You can pair again later to resume syncing.',
  'device.unpairConfirmAction': 'Yes, unpair',
  // Translators: Fallback name passed to that dialog as {{deviceName}} when the device has no name;
  // the English dialog text does not show it. Lowercase, used mid-sentence.
  'device.pairedDevice': 'the paired device',

  // Translators: Toast when stopping a pairing fails ("pairing" = linking two of your devices so
  // they sync).
  'pairing.cancelFailed': 'Failed to cancel pairing',

  // Translators: Errors in the banner of the Pair device dialog; {{message}} = the reason, often a
  // technical English message, or mutationTimedOut (inserted as {{message}}, so lowercase, no final
  // period).
  // #3715 — a queued pairing mutation that never answered (wedged daemon,
  // stuck mDNS stack). Interpolated into `pairing.startFailed` /
  // `pairing.pairFailed` by the dialog's existing error banner, so it reads as
  // the tail of a sentence rather than as a standalone one.
  'pairing.mutationTimedOut': 'the device stopped responding',
  'pairing.startFailed': 'Failed to start pairing: {{message}}',
  'pairing.pairFailed': 'Pairing failed: {{message}}',
  'pairing.unpairFailed': 'Failed to unpair device: {{message}}',

  // Translators: Pair device dialog, after typing the other device's code and pressing Pair: the
  // waiting state's heading and the explanation under it.
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

  // Translators: Toast once the other device has confirmed the pairing.
  // #3469 — fired only once the peer actually appears in peer_refs
  // (TOFU-pin on first authenticated connection). This is the one place
  // allowed to claim success, because it is the first moment this device
  // actually knows the passphrase matched.
  'pairing.pairSuccessMessage': 'Device paired successfully',

  // Translators: Errors shown in the banner of the Pair device dialog. "Passphrase" / "code" = the
  // four words that link the two devices.
  // #3469 — the responder's wire-level rejection ("pairing passphrase proof
  // required") surfaced back into the dialog that caused it, with a path
  // back to retype (the entry form re-renders once this error is set).
  'pairing.proofRejectedError': 'The passphrase did not match. Check it and try again.',
  // #3469 — the pending-marker TTL elapsed with no peer appearing and no
  // rejection observed. Bounds the wait instead of hanging indefinitely.
  // #3952 — this string used to assert a single cause ("the code may have
  // expired"), which is a diagnosis this code path cannot make. The timeout
  // fires after PAIRING_TIMEOUT_SECONDS whether the code expired OR the two
  // devices never discovered each other, and the second case is the common
  // one on a multicast-hostile network (AP client isolation, guest WiFi,
  // separate subnets). `MdnsDisabled` does NOT cover that: it fires only when
  // the mDNS socket cannot be created, and on those networks the socket binds
  // fine and the packets are simply dropped — so no hint is shown at all.
  // A user told the code expired retries with a fresh code, which fails
  // identically, for ever. Naming both causes is what makes the second one
  // actionable. The transport gap itself is #4037. #3504: the host's code
  // is armed when its dialog opens and the joiner's wait starts at confirm,
  // so the host's window always closes first; a fresh code comes from the
  // host, not from retyping here.
  'pairing.waitTimedOut':
    'No response from the other device. Either the pairing code expired, or the two devices could not find each other on this network — some guest and corporate WiFi networks block the discovery pairing needs. If the code expired, reopen pairing on the other device to get a fresh one.',
  // #3852 \u2014 the OS is dropping this app's packets (Android 15+'s per-uid
  // background firewall fires the moment the screen sleeps, even with the app
  // top-of-stack). This is the ONLY wording for that banner: the daemon sends
  // the key `pairing.osNetworkBlocked` (`BLOCKED_REASON_KEY` in
  // `android_network_block.rs`) and the frontend translates it, so the sentence
  // is localisable instead of being English from Rust. Renaming this key
  // reddens `useOsNetworkBlock.test.ts`, which pins the same literal.
  // It names the only action the user can take.
  // Translators: Android only: an alert in the dialog while the system blocks the app's network
  // access.
  'pairing.osNetworkBlocked':
    'This device paused the app\u2019s network access. Keep the screen on and this app open while pairing.',

  // Translators: Toast after the camera read the other device's QR code; "Pair" = the Pair button,
  // use the same word.
  'pairing.qrScannedMessage': 'QR code scanned \u2014 verify and tap Pair',

  // Translators: Pair device dialog (Settings › Sync & devices › Pair new device): screen-reader
  // label of its close button, and its title. "Pair" = link two of your devices so they sync
  // (verb).
  'pairing.closeDialogLabel': 'Close pairing dialog',
  'pairing.dialogTitle': 'Pair device',

  // Translators: Link-style buttons of the Pair device dialog: switch to typing the code shown on
  // the other device, or back to showing this device's code.
  // #3463 — the dialog opens directly on the host path (this device's own
  // code); these two strings label the affordance that switches roles.
  // Choosing "have a code" is what declares the joiner role, replacing the
  // old upfront chooser question.
  'pairing.switchToJoinerLink': 'Have a code from the other device?',
  'pairing.switchToHostLink': 'Show my code instead',

  // Translators: Loading text of the Pair device dialog (also read to screen readers).
  'pairing.startingMessage': 'Starting pairing...',

  // Translators: Pair device dialog, this device's code: screen-reader name of the QR code image;
  // the label above the four-word passphrase (keep the colon); an instruction; the countdown label,
  // followed by the time left, e.g. "Session expires in 4:59"; the expiry notice; and the button
  // that starts a new pairing session after an error or expiry.
  'pairing.qrCodeLabel': 'QR code for device pairing',
  'pairing.passphraseLabel': 'Passphrase:',
  'pairing.scanOrEnterInstruction': 'Scan the QR code or enter the passphrase on the other device.',
  'pairing.sessionExpiresIn': 'Session expires in',
  'pairing.sessionExpired': 'Session expired',
  'pairing.retryButton': 'Retry',

  // Translators: Pair device dialog, typing the other device's code. orSeparator: one short word
  // centred on a divider line (all capitals in English). Then two tabs choosing how to enter the
  // code, the "Recommended" chip on the scan tab, and the tabs' screen-reader label.
  'pairing.orSeparator': 'OR',
  'pairing.typePassphraseButton': 'Type passphrase',
  'pairing.scanQrCodeButton': 'Scan QR code',
  'pairing.recommendedBadge': 'Recommended',
  'pairing.entryModeLabel': 'Enter the code',

  // Translators: The four boxes for the passphrase words. wordLabel: screen-reader label of a box,
  // {{num}} = 1 to 4. entryFormWord: visible label above a box, {{ordinal}} = one of the ordinals
  // below. Ordinals: very short (1st … 4th).
  'pairing.wordLabel': 'Passphrase word {{num}}',
  'pairing.entryFormWord': '{{ordinal}} word',
  'pairing.ordinal.first': '1st',
  'pairing.ordinal.second': '2nd',
  'pairing.ordinal.third': '3rd',
  'pairing.ordinal.fourth': '4th',

  // Translators: Pair device dialog: text while the camera scanner loads, then the buttons at the
  // bottom of the code entry ("Cancel" stops pairing; "Pair" = verb).
  'pairing.loadingScannerMessage': 'Loading scanner...',
  'pairing.cancelButton': 'Cancel',
  'pairing.pairButton': 'Pair',

  // Translators: Heading of the list of paired devices at the bottom of the Pair device dialog.
  'pairing.pairedDevicesTitle': 'Paired devices',

  // Translators: Confirmation when closing the Pair device dialog during a pairing: title, body,
  // confirm button (stops the pairing) and the button that keeps pairing (closes only this
  // question).
  'pairing.confirmCloseTitle': 'Cancel pairing?',
  'pairing.confirmCloseDescription':
    'Pairing is in progress. Closing this dialog will cancel the handshake and the other device will need to start over.',
  'pairing.confirmCloseAction': 'Cancel pairing',
  'pairing.confirmCloseKeep': 'Keep pairing',

  // Translators: Screen-reader announcements of the time left before the pairing code expires;
  // {{count}} = minutes or seconds.
  'pairing.srCountdownMinutes_one': 'Session expires in {{count}} minute',
  'pairing.srCountdownMinutes_other': 'Session expires in {{count}} minutes',
  'pairing.srCountdownSeconds_one': 'Session expires in {{count}} second',
  'pairing.srCountdownSeconds_other': 'Session expires in {{count}} seconds',

  // Translators: Copy button beside the passphrase in the Pair device dialog: screen-reader label,
  // and the toasts after copying.
  'pairing.copyPassphraseAriaLabel': 'Copy passphrase',
  'pairing.passphraseCopied': 'Passphrase copied',
  'pairing.passphraseCopyFailed': 'Failed to copy passphrase',

  // Translators: Settings › Sync & devices: label of the row showing this device's unique ID (a
  // long code).
  'device.localDeviceIdLabel': 'Local device ID',
  // Translators: Row showing this device's network address (IP and port): label, the description
  // under it, and the description used instead when the device is not on a network.
  'device.localAddressLabel': "This device's address",
  'device.localAddressDescription':
    "Enter it as the other device's manual address when the two do not find each other.",
  'device.localAddressNoNetwork':
    'No local network. Other devices cannot reach this one until it joins a network.',

  // Translators: Copy button beside the device ID: toast after copying, toast when copying fails,
  // and the button's tooltip and screen-reader label.
  'device.deviceIdCopied': 'Device ID copied',
  'device.copyFailed': 'Failed to copy to clipboard',
  'device.copyDeviceIdLabel': 'Copy device ID to clipboard',

  // Translators: Settings › Sync & devices: the button that opens the Pair device dialog; the
  // heading of the device list (followed by the count, e.g. "Paired devices (2)"); the button that
  // syncs with every device (screen-reader label and text, shown with two or more devices); and the
  // empty state, which quotes the first button.
  'device.pairNewDeviceButton': 'Pair new device',
  'device.pairedDevicesTitle': 'Paired devices',
  'device.syncAllLabel': 'Sync with all paired devices',
  'device.syncAllButton': 'Sync all',
  'device.noPairedDevices': 'No paired devices yet. Use "Pair new device" to add one.',

  // Translators: Warning in Settings › Sync & devices. "Automatic discovery" = finding your devices
  // on the local network; {{reason}} = a technical error text, often in English.
  // Shown once mDNS init has failed. It points at the QR because the v2 payload
  // carries the peer's endpoint_id and ip:port (#4037), so a first-ever pair
  // needs no multicast.
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
    'Automatic discovery unavailable: {{reason}}. Pair a new device by scanning its QR code; devices you have already paired may still sync.',

  // Translators: Warning in Settings › Sync & devices: {{address}} = an IP address, {{port}} = a
  // port number; UDP is a network protocol name; "VPS" = a rented server on the internet. Then the
  // button that dismisses the warning and its screen-reader label.
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

  // Translators: On/off switch in Settings › Sync & devices: label and description; n0, iroh and
  // Agaric are names, keep them. Then the toasts when the setting cannot be loaded or saved.
  // #4549 — the opt-in internet fallback. The description carries the whole
  // cost of the choice, because the setting IS that choice: what the relay
  // can and cannot see, that both devices need it, and that it takes effect
  // at the next launch (the endpoint binds once per daemon; there is no
  // restart command), whose server it is and that it is opt-in (#6564). The
  // word "relay" is deliberately absent — "connection server" says what it
  // does to someone who has never heard of one.
  'device.internetRelayLabel': 'Local network, with an internet fallback',
  'device.internetRelayDescription':
    "Off unless you turn it on. When your devices can't reach each other directly, such as behind a VPN, or a paired device is away from this network, sync tries a connection server on the internet run by n0, the makers of the iroh networking library. Your notes stay encrypted so it can't read them, but it sees which of your devices are talking and how much data moves. Turn this on for both devices; it takes effect the next time Agaric starts.",
  'device.internetRelayLoadFailed': 'Failed to load the internet fallback setting',
  'device.internetRelaySaveFailed': 'Failed to save the internet fallback setting',

  // Translators: One paired device's row in Settings › Sync & devices. noAddress: shown in place of
  // its network address when unknown. Buttons and their tooltips / screen-reader labels: edit the
  // address, rename, sync now, cancel a sync while one runs (cancelSyncFailed = toast), and unpair
  // (= stop syncing with it; also in the Pair device dialog's list). {{name}} = the device name.
  'device.noAddress': 'No address',
  'device.editAddressLabel': 'Edit address for {{name}}',
  'device.renameDeviceLabel': 'Rename device {{name}}',
  'device.syncNowLabel': 'Sync now with device {{name}}',
  'device.syncNowButton': 'Sync now',
  'device.cancelSyncLabel': 'Cancel sync: stops every sync running on this device',
  'device.cancelSyncButton': 'Cancel sync',
  'device.cancelSyncFailed': 'Failed to cancel the sync',
  'device.unpairDeviceLabel': 'Unpair device {{name}}',
  'device.unpairButton': 'Unpair',

  // Translators: Screen-reader announcements in Settings › Sync & devices; {{name}} = a device
  // name.
  'device.loadingMessage': 'Loading device information...',
  'device.syncingMessage': 'Syncing with device {{name}}...',
  'device.syncingAllMessage': 'Syncing with all paired devices...',

  // Translators: Progress line under a device's row while it syncs. Ops: {{sent}} and {{received}}
  // = numbers of sync messages. Sending / Receiving: {{filesDone}} of {{filesTotal}} = file counts,
  // {{bytesDone}} of {{bytesTotal}} = sizes such as "1.2 MB". BarLabel: screen-reader label of the
  // progress bar; {{name}} = the device name.
  // `ops_*` count sync messages, one per space, not changes (#4305).
  'device.syncProgressOps': 'Syncing: {{sent}} messages sent, {{received}} received',
  'device.syncProgressSending':
    'Sending attachments: {{filesDone}} of {{filesTotal}} files, {{bytesDone}} of {{bytesTotal}}',
  'device.syncProgressReceiving':
    'Receiving attachments: {{filesDone}} of {{filesTotal}} files, {{bytesDone}} of {{bytesTotal}}',
  'device.syncProgressBarLabel': 'Attachment transfer with {{name}}',

  // Translators: Error banner at the top of Settings › Sync & devices. syncErrorMessage: read to
  // screen readers, {{error}} = the error text. Then the Retry and dismiss buttons, and the error
  // messages; {{devices}} = device names separated by commas.
  'device.syncErrorMessage': 'Sync error: {{error}}',
  'device.retryButton': 'Retry',
  'device.dismissErrorLabel': 'Dismiss error',
  'device.loadFailed': 'Failed to load device info',
  'device.unpairFailed': 'Failed to unpair device',
  'device.syncTimedOut': 'Sync took too long — check your connection and try again',
  'device.syncFailedForList': 'Sync failed for: {{devices}}',
  'device.renameFailed': 'Failed to rename',

  // Translators: Status line on a paired device's row (Settings and the Pair device dialog);
  // {{time}} = how long ago, e.g. "5 min ago", or "Never".
  'device.lastSyncedAt': 'Last: {{time}}',

  // Translators: Shown on a device's row when that device unpaired from this one: chip (short),
  // explanation, and since when; {{time}} = how long ago, e.g. "3 days ago".
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

  // Translators: Chip on a device's row: how many times syncing with it had to start over from
  // scratch ({{count}}). Short.
  'device.resetCount_one': '{{count}} reset',
  'device.resetCount_other': '{{count}} resets',

  // Translators: Camera view of the Pair device dialog's scan tab: screen-reader name of the camera
  // area, the button that tries the camera again, the status text while scanning, and the camera
  // error messages.
  'qrScanner.viewportLabel': 'QR code scanner viewport',
  'qrScanner.retryCameraButton': 'Retry camera',
  'qrScanner.scanningMessage': 'Scanning...',
  'qrScanner.cameraError': 'Camera access failed. Check camera permissions and try again.',
  'qrScanner.cameraUnavailable':
    'Camera is not available here. Use the 4-word passphrase to pair instead.',
  'qrScanner.cameraDenied':
    'Camera permission denied. Enable camera access for Agaric in your device settings, then retry.',
  'qrScanner.cameraNotFound': 'No camera was found on this device.',

  // Translators: Toasts after a sync started from the Sidebar's Sync button or run automatically;
  // "Sync failed" is also an error in Settings › Sync & devices. failedForDevice: {{deviceId}} =
  // the first 12 characters of the device's ID; "..." shows it is cut off.
  'device.syncComplete': 'Sync complete',
  'device.syncFailed': 'Sync failed',
  'sync.failedForDevice': 'Sync failed for device {{deviceId}}...',

  // Translators: Toast after a sync brought in changes from another device; {{count}} = changed
  // blocks (always 1 or more). The last string is used when the number is unknown.
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

  // Translators: Toast, and the tooltip of the Sidebar's Sync button; {{message}} = the reason: one
  // of the sync error sentences below, or a technical error text.
  'sync.failed': 'Sync failed: {{message}}',

  // Translators: Warning toast that stays until closed; {{title}} = a page title; "Trash" = the
  // Trash view.
  'sync.localTextKept':
    'Another device deleted or moved “{{title}}”. The blocks you added under it here that had not synced yet are in the Trash.',

  // Translators: Sync errors: shown after "Sync failed: " in a toast, and alone in the sync status
  // card of Settings › Sync & devices. {{peer}} = the other device's name; the "Unnamed" variants
  // are used when it has none. "Agaric" = the app's name.
  // #5728 — the peer runs another engine format (`SyncErrorCode`); updating the
  // older device fixes it, and `peer_is_older` says which one that is (#6523).
  // The unnamed form is for a peer this device has no name for.
  'sync.versionMismatchUpdatePeer':
    '{{peer}} runs an older version of Agaric. Update Agaric on {{peer}}, then sync again.',
  'sync.versionMismatchUpdatePeerUnnamed':
    'The other device runs an older version of Agaric. Update Agaric on it, then sync again.',
  'sync.versionMismatchUpdateThisDevice':
    '{{peer}} runs a newer version of Agaric. Update Agaric on this device, then sync again.',
  'sync.versionMismatchUpdateThisDeviceUnnamed':
    'The other device runs a newer version of Agaric. Update Agaric on this device, then sync again.',

  // Translators: Sync errors (as above): the other device did not answer when the sync started;
  // {{peer}} = its name.
  // #6523 — a peer that synced before ended the session without answering;
  // an older build ends a version mismatch that way, and so does a peer on the
  // same version that drops out, so the sentence only suggests the check.
  'sync.handshakeUnanswered':
    'Sync with {{peer}} could not start. If this repeats, check that both devices run the same version of Agaric.',
  'sync.handshakeUnansweredUnnamed':
    'Sync could not start. If this repeats, check that both devices run the same version of Agaric.',

  // Translators: Status line in the tooltip of the Sidebar's Sync button and in the sync status
  // card when a paired device cannot be reached; {{peer}} = its name, {{time}} = how long ago, e.g.
  // "5 min ago".
  // #6523 — a paired device that is away: no announcement, no answer.
  'sync.waitingForPeer': 'Waiting for {{peer}}, last synced {{time}}',
  'sync.waitingForPeerNeverSynced': 'Waiting for {{peer}}',

  // Translators: Sync error (as above): the two devices cannot merge; {{peer}} = the other device's
  // name. "Set Agaric up fresh" = start the app again with an empty database.
  // #6523 — the peer holds more of this device's own changes than this device
  // does (an older database was restored here), which no sync can merge.
  'sync.ownHistoryFork':
    '{{peer}} holds changes this device made and no longer has, as after restoring an older backup here, so the two cannot merge. Export the notes from this device, set Agaric up fresh on it, pair it again, then import them.',
  'sync.ownHistoryForkUnnamed':
    'The other device holds changes this device made and no longer has, as after restoring an older backup here, so the two cannot merge. Export the notes from this device, set Agaric up fresh on it, pair it again, then import them.',

  // Translators: Button inside the toast "Sync failed for device …": try that sync again.
  'sync.retryAction': 'Retry sync',
  // Translators: Toast when the network connection comes back and a sync starts.
  'sync.backOnline': 'Back online. Syncing\u2026',

  // Translators: Dialog shown when the Sidebar's Sync button is pressed with no paired device:
  // title (also the Sync button's tooltip), body, and the buttons (open the Pair device dialog;
  // cancel).
  'sync.noPeersTitle': 'No devices paired',
  'sync.noPeersBody': 'Sync needs at least one paired device. Pair one now to start syncing.',
  'sync.noPeersCta': 'Pair a device',
  'sync.noPeersCancel': 'Cancel',

  // Translators: Warning card at the top of Settings › Sync & devices listing changes from another
  // device that could not be merged: title ({{count}} = changes), body, the list's screen-reader
  // label, and a line per change ({{when}} = how long ago, e.g. "2 days ago"; {{size}} = a size
  // such as "12 KB"). Then the error when the check fails, the Retry button and its screen-reader
  // label ({{space}} = a space name, a separate workspace of notes), the toast after Retry with its
  // "Restart now" button (restarts the app), and the toast when Retry fails.
  // #6057 — deltas the boot replay gave up on (`loro_sync_quarantine`). The
  // bytes are kept, so the copy says "not applied", never "lost".
  'sync.quarantineTitle_one': '{{count}} sync change could not be applied',
  'sync.quarantineTitle_other': '{{count}} sync changes could not be applied',
  'sync.quarantineBody':
    'These changes arrived from another device, but Agaric could not merge them after several restarts and has stopped retrying. They are kept on this device; their content is not in your notes. Retry tries one again the next time Agaric starts.',
  'sync.quarantineListLabel': 'Sync changes that could not be applied',
  'sync.quarantineRowMeta': 'First seen {{when}} · {{size}}',
  'sync.quarantineLoadFailed': 'Could not check for sync changes that failed to apply',
  'sync.quarantineRetry': 'Retry',
  'sync.quarantineRetryLabel': 'Retry the sync change for {{space}}',
  'sync.quarantineRetried': 'Will try again the next time Agaric starts',
  'sync.quarantineRestartNow': 'Restart now',
  'sync.quarantineRetryFailed': 'Could not retry the sync change',

  // Translators: Screen-reader label of the name box in the Rename device dialog.
  'device.deviceNameLabel': 'Device name',

  // Translators: Screen-reader announcement in the Pair device dialog while pairing runs.
  'pairing.inProgress': 'Pairing in progress...',

  // Translators: Popover from the pencil button beside a device's address: title, its screen-reader
  // label, the address box's screen-reader label, a hint, error messages, and the buttons. Keep
  // "host:port" and the example address as written.
  'device.editAddressTitle': 'Peer address',
  'device.editAddressPopoverLabel': 'Edit peer address',
  'device.addressInputLabel': 'Address (host:port)',
  'device.addressHint': 'Format: host:port (e.g., 192.168.1.100:5000)',
  'device.addressFormatInvalid': 'Format must be host:port (e.g., 192.168.1.100:5000)',
  'device.addressPortInvalid': 'Port must be between 1 and 65535',
  'device.saveAddressButton': 'Save',
  'device.cancelAddressButton': 'Cancel',
}
