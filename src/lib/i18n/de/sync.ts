/**
 * i18n namespace: sync — German (`de`).
 *
 * Mirrors `src/lib/i18n/sync.ts` key for key, in the same order.
 */

export const sync: Record<string, string> = {
  'device.thisDevice': 'Dieses Gerät',
  'device.unpairConfirmTitle': 'Gerät entkoppeln?',
  'device.unpairConfirmDescription':
    'Dadurch wird die Kopplung entfernt. Deine Notizen und der Synchronisierungsverlauf bleiben auf diesem Gerät. Du kannst später erneut koppeln, um die Synchronisierung fortzusetzen.',
  'device.unpairConfirmAction': 'Ja, entkoppeln',
  'device.pairedDevice': 'das gekoppelte Gerät',
  'pairing.cancelFailed': 'Die Kopplung konnte nicht abgebrochen werden',
  'pairing.mutationTimedOut': 'das Gerät reagiert nicht mehr',
  'pairing.startFailed': 'Die Kopplung konnte nicht gestartet werden: {{message}}',
  'pairing.pairFailed': 'Kopplung fehlgeschlagen: {{message}}',
  'pairing.unpairFailed': 'Das Gerät konnte nicht entkoppelt werden: {{message}}',
  'pairing.awaitingPeerMessage': 'Warte auf das andere Gerät…',
  'pairing.waitingDescription':
    'Dieses Gerät hat seine Seite des Kopplungs-Handshakes vorbereitet. Es bestätigt die Kopplung automatisch, sobald sich das andere Gerät verbindet.',
  'pairing.pairSuccessMessage': 'Gerät erfolgreich gekoppelt',
  'pairing.proofRejectedError':
    'Die Passphrase stimmte nicht überein. Prüfe sie und versuche es erneut.',
  'pairing.waitTimedOut':
    'Keine Antwort vom anderen Gerät. Entweder ist der Kopplungscode abgelaufen, oder die beiden Geräte konnten sich in diesem Netzwerk nicht finden – manche Gast- und Firmen-WLANs blockieren die Erkennung, die für die Kopplung nötig ist. Falls der Code abgelaufen ist, öffne die Kopplung auf dem anderen Gerät erneut, um einen neuen zu erhalten.',
  'pairing.osNetworkBlocked':
    'Dieses Gerät hat den Netzwerkzugriff der App pausiert. Lass den Bildschirm an und diese App geöffnet, während du koppelst.',
  'pairing.qrScannedMessage': 'QR-Code gescannt – prüfe und tippe auf Koppeln',
  'pairing.closeDialogLabel': 'Kopplungsdialog schließen',
  'pairing.dialogTitle': 'Gerät koppeln',
  'pairing.switchToJoinerLink': 'Hast du einen Code vom anderen Gerät?',
  'pairing.switchToHostLink': 'Stattdessen meinen Code anzeigen',
  'pairing.startingMessage': 'Kopplung wird gestartet...',
  'pairing.qrCodeLabel': 'QR-Code zur Gerätekopplung',
  'pairing.passphraseLabel': 'Passphrase:',
  'pairing.scanOrEnterInstruction':
    'Scanne den QR-Code oder gib die Passphrase auf dem anderen Gerät ein.',
  'pairing.sessionExpiresIn': 'Sitzung läuft ab in',
  'pairing.sessionExpired': 'Sitzung abgelaufen',
  'pairing.retryButton': 'Erneut versuchen',
  'pairing.orSeparator': 'ODER',
  'pairing.typePassphraseButton': 'Passphrase eingeben',
  'pairing.scanQrCodeButton': 'QR-Code scannen',
  'pairing.recommendedBadge': 'Empfohlen',
  'pairing.entryModeLabel': 'Code eingeben',
  'pairing.wordLabel': 'Wort {{num}} der Passphrase',
  'pairing.entryFormWord': '{{ordinal}} Wort',
  'pairing.ordinal.first': '1.',
  'pairing.ordinal.second': '2.',
  'pairing.ordinal.third': '3.',
  'pairing.ordinal.fourth': '4.',
  'pairing.loadingScannerMessage': 'Scanner wird geladen...',
  'pairing.cancelButton': 'Abbrechen',
  'pairing.pairButton': 'Koppeln',
  'pairing.pairedDevicesTitle': 'Gekoppelte Geräte',
  'pairing.confirmCloseTitle': 'Kopplung abbrechen?',
  'pairing.confirmCloseDescription':
    'Die Kopplung läuft. Wenn du diesen Dialog schließt, wird der Handshake abgebrochen und das andere Gerät muss von vorn beginnen.',
  'pairing.confirmCloseAction': 'Kopplung abbrechen',
  'pairing.confirmCloseKeep': 'Weiter koppeln',
  'pairing.srCountdownMinutes_one': 'Sitzung läuft in {{count}} Minute ab',
  'pairing.srCountdownMinutes_other': 'Sitzung läuft in {{count}} Minuten ab',
  'pairing.srCountdownSeconds_one': 'Sitzung läuft in {{count}} Sekunde ab',
  'pairing.srCountdownSeconds_other': 'Sitzung läuft in {{count}} Sekunden ab',
  'pairing.copyPassphraseAriaLabel': 'Passphrase kopieren',
  'pairing.passphraseCopied': 'Passphrase kopiert',
  'pairing.passphraseCopyFailed': 'Die Passphrase konnte nicht kopiert werden',
  'device.localDeviceIdLabel': 'Lokale Geräte-ID',
  'device.localAddressLabel': 'Adresse dieses Geräts',
  'device.localAddressDescription':
    'Gib sie auf dem anderen Gerät als manuelle Adresse ein, wenn sich die beiden nicht finden.',
  'device.localAddressNoNetwork':
    'Kein lokales Netzwerk. Andere Geräte können dieses erst erreichen, wenn es mit einem Netzwerk verbunden ist.',
  'device.deviceIdCopied': 'Geräte-ID kopiert',
  'device.copyFailed': 'Kopieren in die Zwischenablage fehlgeschlagen',
  'device.copyDeviceIdLabel': 'Geräte-ID in die Zwischenablage kopieren',
  'device.pairNewDeviceButton': 'Neues Gerät koppeln',
  'device.pairedDevicesTitle': 'Gekoppelte Geräte',
  'device.syncAllLabel': 'Mit allen gekoppelten Geräten synchronisieren',
  'device.syncAllButton': 'Alle synchronisieren',
  'device.noPairedDevices':
    'Noch keine gekoppelten Geräte. Verwende "Neues Gerät koppeln", um eins hinzuzufügen.',
  'device.mdnsDisabledHint':
    'Automatische Erkennung nicht verfügbar: {{reason}}. Kopple ein neues Gerät, indem du seinen QR-Code scannst; bereits gekoppelte Geräte können möglicherweise weiterhin synchronisieren.',
  'device.internetFacingBindHint':
    'Die Synchronisierung lauscht auf {{address}}, UDP-Port {{port}} – außerhalb der privaten Netzwerkbereiche, daher ist sie möglicherweise auch von außerhalb deines lokalen Netzwerks erreichbar. Das ist zu erwarten, wenn dein Router öffentliche Adressen vergibt. Blockiere auf einem VPS oder einem anderen öffentlichen Host eingehenden UDP-Verkehr zu diesem Gerät oder schalte die Synchronisierung aus. Der Port ändert sich bei jedem Neustart.',
  'device.internetFacingBindAck': 'Verstanden',
  'device.internetFacingBindAckLabel':
    'Diese Synchronisierungsadresse bestätigen; der Hinweis erscheint wieder, wenn sich die Adresse ändert',
  'device.internetRelayLabel': 'Lokales Netzwerk, mit Ausweichverbindung über das Internet',
  'device.internetRelayDescription':
    'Aus, solange du es nicht einschaltest. Wenn deine Geräte einander nicht direkt erreichen können, etwa hinter einem VPN, oder ein gekoppeltes Gerät nicht in diesem Netzwerk ist, weicht die Synchronisierung auf einen Verbindungsserver im Internet aus, der von n0 betrieben wird, den Entwicklern der Netzwerkbibliothek iroh. Deine Notizen bleiben verschlüsselt, sodass er sie nicht lesen kann, aber er sieht, welche deiner Geräte miteinander kommunizieren und wie viele Daten übertragen werden. Schalte dies auf beiden Geräten ein; es wird beim nächsten Start von Agaric wirksam.',
  'device.internetRelayLoadFailed':
    'Die Einstellung für die Ausweichverbindung über das Internet konnte nicht geladen werden',
  'device.internetRelaySaveFailed':
    'Die Einstellung für die Ausweichverbindung über das Internet konnte nicht gespeichert werden',
  'device.noAddress': 'Keine Adresse',
  'device.editAddressLabel': 'Adresse für {{name}} bearbeiten',
  'device.renameDeviceLabel': 'Gerät {{name}} umbenennen',
  'device.syncNowLabel': 'Jetzt mit Gerät {{name}} synchronisieren',
  'device.syncNowButton': 'Jetzt synchronisieren',
  'device.cancelSyncLabel':
    'Synchronisierung abbrechen: beendet jede auf diesem Gerät laufende Synchronisierung',
  'device.cancelSyncButton': 'Synchronisierung abbrechen',
  'device.cancelSyncFailed': 'Die Synchronisierung konnte nicht abgebrochen werden',
  'device.unpairDeviceLabel': 'Gerät {{name}} entkoppeln',
  'device.unpairButton': 'Entkoppeln',
  'device.loadingMessage': 'Geräteinformationen werden geladen...',
  'device.syncingMessage': 'Synchronisiere mit Gerät {{name}}...',
  'device.syncingAllMessage': 'Synchronisiere mit allen gekoppelten Geräten...',
  'device.syncProgressOps':
    'Synchronisierung: {{sent}} Nachrichten gesendet, {{received}} empfangen',
  'device.syncProgressSending':
    'Anhänge werden gesendet: {{filesDone}} von {{filesTotal}} Dateien, {{bytesDone}} von {{bytesTotal}}',
  'device.syncProgressReceiving':
    'Anhänge werden empfangen: {{filesDone}} von {{filesTotal}} Dateien, {{bytesDone}} von {{bytesTotal}}',
  'device.syncProgressBarLabel': 'Anhangsübertragung mit {{name}}',
  'device.syncErrorMessage': 'Synchronisierungsfehler: {{error}}',
  'device.retryButton': 'Erneut versuchen',
  'device.dismissErrorLabel': 'Fehler ausblenden',
  'device.loadFailed': 'Die Geräteinformationen konnten nicht geladen werden',
  'device.unpairFailed': 'Das Gerät konnte nicht entkoppelt werden',
  'device.syncTimedOut':
    'Die Synchronisierung hat zu lange gedauert – prüfe deine Verbindung und versuche es erneut',
  'device.syncFailedForList': 'Synchronisierung fehlgeschlagen für: {{devices}}',
  'device.renameFailed': 'Umbenennen fehlgeschlagen',
  'device.lastSyncedAt': 'Zuletzt: {{time}}',
  'device.unpairedByPeerBadge': 'Kopplung verloren',
  'device.unpairedByPeerDescription':
    'Das andere Gerät hat die Kopplung mit diesem aufgehoben. Kopple erneut, um die Synchronisierung fortzusetzen.',
  'device.unpairedByPeerSince': 'Synchronisierung {{time}} gestoppt',
  'device.resetCount_one': '{{count}} Zurücksetzung',
  'device.resetCount_other': '{{count}} Zurücksetzungen',
  'qrScanner.viewportLabel': 'Sichtbereich des QR-Code-Scanners',
  'qrScanner.retryCameraButton': 'Kamera erneut versuchen',
  'qrScanner.scanningMessage': 'Wird gescannt...',
  'qrScanner.cameraError':
    'Kamerazugriff fehlgeschlagen. Prüfe die Kameraberechtigungen und versuche es erneut.',
  'qrScanner.cameraUnavailable':
    'Hier ist keine Kamera verfügbar. Verwende stattdessen die Passphrase aus 4 Wörtern zum Koppeln.',
  'qrScanner.cameraDenied':
    'Kameraberechtigung verweigert. Erlaube Agaric den Kamerazugriff in den Geräteeinstellungen und versuche es dann erneut.',
  'qrScanner.cameraNotFound': 'Auf diesem Gerät wurde keine Kamera gefunden.',
  'device.syncComplete': 'Synchronisierung abgeschlossen',
  'device.syncFailed': 'Synchronisierung fehlgeschlagen',
  'sync.failedForDevice': 'Synchronisierung fehlgeschlagen für Gerät {{deviceId}}...',
  'sync.changesApplied_one': '{{count}} Änderung vom Gerät synchronisiert',
  'sync.changesApplied_other': '{{count}} Änderungen vom Gerät synchronisiert',
  'sync.changesAppliedUnknownCount': 'Änderungen vom Gerät synchronisiert',
  'sync.failed': 'Synchronisierung fehlgeschlagen: {{message}}',
  'sync.localTextKept':
    'Ein anderes Gerät hat “{{title}}” gelöscht oder verschoben. Die Blöcke, die du hier darunter hinzugefügt hast und die noch nicht synchronisiert waren, liegen im Papierkorb.',
  'sync.versionMismatchUpdatePeer':
    '{{peer}} verwendet eine ältere Version von Agaric. Aktualisiere Agaric auf {{peer}} und synchronisiere dann erneut.',
  'sync.versionMismatchUpdatePeerUnnamed':
    'Das andere Gerät verwendet eine ältere Version von Agaric. Aktualisiere Agaric dort und synchronisiere dann erneut.',
  'sync.versionMismatchUpdateThisDevice':
    '{{peer}} verwendet eine neuere Version von Agaric. Aktualisiere Agaric auf diesem Gerät und synchronisiere dann erneut.',
  'sync.versionMismatchUpdateThisDeviceUnnamed':
    'Das andere Gerät verwendet eine neuere Version von Agaric. Aktualisiere Agaric auf diesem Gerät und synchronisiere dann erneut.',
  'sync.handshakeUnanswered':
    'Die Synchronisierung mit {{peer}} konnte nicht starten. Falls das wiederholt passiert, prüfe, ob auf beiden Geräten dieselbe Version von Agaric läuft.',
  'sync.handshakeUnansweredUnnamed':
    'Die Synchronisierung konnte nicht starten. Falls das wiederholt passiert, prüfe, ob auf beiden Geräten dieselbe Version von Agaric läuft.',
  'sync.waitingForPeer': 'Warte auf {{peer}}, zuletzt synchronisiert {{time}}',
  'sync.waitingForPeerNeverSynced': 'Warte auf {{peer}}',
  'sync.ownHistoryFork':
    '{{peer}} enthält Änderungen, die dieses Gerät gemacht hat und nicht mehr besitzt, etwa nachdem hier ein älteres Backup wiederhergestellt wurde. Daher lassen sich die beiden nicht zusammenführen. Exportiere die Notizen von diesem Gerät, richte Agaric darauf neu ein, kopple es erneut und importiere sie dann.',
  'sync.ownHistoryForkUnnamed':
    'Das andere Gerät enthält Änderungen, die dieses Gerät gemacht hat und nicht mehr besitzt, etwa nachdem hier ein älteres Backup wiederhergestellt wurde. Daher lassen sich die beiden nicht zusammenführen. Exportiere die Notizen von diesem Gerät, richte Agaric darauf neu ein, kopple es erneut und importiere sie dann.',
  'sync.retryAction': 'Synchronisierung wiederholen',
  'sync.backOnline': 'Wieder online. Synchronisiere…',
  'sync.noPeersTitle': 'Keine Geräte gekoppelt',
  'sync.noPeersBody':
    'Für die Synchronisierung ist mindestens ein gekoppeltes Gerät nötig. Kopple jetzt eins, um mit der Synchronisierung zu beginnen.',
  'sync.noPeersCta': 'Gerät koppeln',
  'sync.noPeersCancel': 'Abbrechen',
  'sync.quarantineTitle_one': '{{count}} Synchronisierungsänderung konnte nicht übernommen werden',
  'sync.quarantineTitle_other':
    '{{count}} Synchronisierungsänderungen konnten nicht übernommen werden',
  'sync.quarantineBody':
    'Diese Änderungen kamen von einem anderen Gerät, aber Agaric konnte sie nach mehreren Neustarts nicht zusammenführen und hat die Versuche eingestellt. Sie bleiben auf diesem Gerät gespeichert; ihr Inhalt ist nicht in deinen Notizen. Mit "Erneut versuchen" wird eine davon beim nächsten Start von Agaric noch einmal versucht.',
  'sync.quarantineListLabel': 'Synchronisierungsänderungen, die nicht übernommen werden konnten',
  'sync.quarantineRowMeta': 'Erstmals empfangen {{when}} · {{size}}',
  'sync.quarantineLoadFailed':
    'Nicht übernommene Synchronisierungsänderungen konnten nicht geprüft werden',
  'sync.quarantineRetry': 'Erneut versuchen',
  'sync.quarantineRetryLabel': 'Synchronisierungsänderung für {{space}} erneut versuchen',
  'sync.quarantineRetried': 'Wird beim nächsten Start von Agaric erneut versucht',
  'sync.quarantineRestartNow': 'Jetzt neu starten',
  'sync.quarantineRetryFailed': 'Die Synchronisierungsänderung konnte nicht erneut versucht werden',
  'device.deviceNameLabel': 'Gerätename',
  'pairing.inProgress': 'Kopplung läuft...',
  'device.editAddressTitle': 'Adresse der Gegenstelle',
  'device.editAddressPopoverLabel': 'Adresse der Gegenstelle bearbeiten',
  'device.addressInputLabel': 'Adresse (host:port)',
  'device.addressHint': 'Format: host:port (z. B. 192.168.1.100:5000)',
  'device.addressFormatInvalid': 'Das Format muss host:port sein (z. B. 192.168.1.100:5000)',
  'device.addressPortInvalid': 'Der Port muss zwischen 1 und 65535 liegen',
  'device.saveAddressButton': 'Speichern',
  'device.cancelAddressButton': 'Abbrechen',
}
