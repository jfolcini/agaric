/**
 * i18n namespace: sync — French (`fr`).
 *
 * Mirrors `src/lib/i18n/sync.ts` key for key, in the same order.
 */

export const sync: Record<string, string> = {
  'device.thisDevice': 'Cet appareil',
  'device.unpairConfirmTitle': 'Dissocier l’appareil\u00A0?',
  'device.unpairConfirmDescription':
    'L’association sera supprimée. Vos notes et l’historique de synchronisation restent sur cet appareil. Vous pourrez l’associer à nouveau plus tard pour reprendre la synchronisation.',
  'device.unpairConfirmAction': 'Oui, dissocier',
  'device.pairedDevice': 'l’appareil associé',
  'pairing.cancelFailed': 'Impossible d’annuler l’association',
  'pairing.mutationTimedOut': 'l’appareil ne répond plus',
  'pairing.startFailed': 'Impossible de lancer l’association\u00A0: {{message}}',
  'pairing.pairFailed': 'Échec de l’association\u00A0: {{message}}',
  'pairing.unpairFailed': 'Impossible de dissocier l’appareil\u00A0: {{message}}',
  'pairing.awaitingPeerMessage': 'En attente de l’autre appareil…',
  'pairing.waitingDescription':
    'Cet appareil a préparé sa part de l’association. La confirmation se fera automatiquement dès que l’autre appareil se connectera.',
  'pairing.pairSuccessMessage': 'Appareil associé avec succès',
  'pairing.proofRejectedError': 'La phrase secrète ne correspond pas. Vérifiez-la et réessayez.',
  'pairing.waitTimedOut':
    'Aucune réponse de l’autre appareil. Soit le code d’association a expiré, soit les deux appareils n’ont pas pu se trouver sur ce réseau — certains réseaux Wi-Fi invités ou d’entreprise bloquent la détection dont l’association a besoin. Si le code a expiré, rouvrez l’association sur l’autre appareil pour en obtenir un nouveau.',
  'pairing.osNetworkBlocked':
    'Cet appareil a suspendu l’accès réseau de l’application. Gardez l’écran allumé et cette application ouverte pendant l’association.',
  'pairing.qrScannedMessage': 'Code QR scanné — vérifiez et appuyez sur Associer',
  'pairing.closeDialogLabel': 'Fermer la boîte de dialogue d’association',
  'pairing.dialogTitle': 'Associer un appareil',
  'pairing.switchToJoinerLink': 'Vous avez un code de l’autre appareil\u00A0?',
  'pairing.switchToHostLink': 'Afficher plutôt mon code',
  'pairing.startingMessage': 'Lancement de l’association...',
  'pairing.qrCodeLabel': 'Code QR pour associer un appareil',
  'pairing.passphraseLabel': 'Phrase secrète\u00A0:',
  'pairing.scanOrEnterInstruction':
    'Scannez le code QR ou saisissez la phrase secrète sur l’autre appareil.',
  'pairing.sessionExpiresIn': 'La session expire dans',
  'pairing.sessionExpired': 'Session expirée',
  'pairing.retryButton': 'Réessayer',
  'pairing.orSeparator': 'OU',
  'pairing.typePassphraseButton': 'Saisir la phrase secrète',
  'pairing.scanQrCodeButton': 'Scanner le code QR',
  'pairing.recommendedBadge': 'Recommandé',
  'pairing.entryModeLabel': 'Saisir le code',
  'pairing.wordLabel': 'Mot {{num}} de la phrase secrète',
  'pairing.entryFormWord': '{{ordinal}} mot',
  'pairing.ordinal.first': '1er',
  'pairing.ordinal.second': '2e',
  'pairing.ordinal.third': '3e',
  'pairing.ordinal.fourth': '4e',
  'pairing.loadingScannerMessage': 'Chargement du scanner...',
  'pairing.cancelButton': 'Annuler',
  'pairing.pairButton': 'Associer',
  'pairing.pairedDevicesTitle': 'Appareils associés',
  'pairing.confirmCloseTitle': 'Annuler l’association\u00A0?',
  'pairing.confirmCloseDescription':
    'L’association est en cours. Fermer cette boîte de dialogue annulera l’échange et l’autre appareil devra tout recommencer.',
  'pairing.confirmCloseAction': 'Annuler l’association',
  'pairing.confirmCloseKeep': 'Poursuivre l’association',
  'pairing.srCountdownMinutes_one': 'La session expire dans {{count}} minute',
  'pairing.srCountdownMinutes_other': 'La session expire dans {{count}} minutes',
  'pairing.srCountdownSeconds_one': 'La session expire dans {{count}} seconde',
  'pairing.srCountdownSeconds_other': 'La session expire dans {{count}} secondes',
  'pairing.copyPassphraseAriaLabel': 'Copier la phrase secrète',
  'pairing.passphraseCopied': 'Phrase secrète copiée',
  'pairing.passphraseCopyFailed': 'Impossible de copier la phrase secrète',
  'device.localDeviceIdLabel': 'ID de l’appareil local',
  'device.localAddressLabel': 'Adresse de cet appareil',
  'device.localAddressDescription':
    'Saisissez-la comme adresse manuelle sur l’autre appareil lorsque les deux ne se trouvent pas.',
  'device.localAddressNoNetwork':
    'Aucun réseau local. Les autres appareils ne peuvent pas joindre celui-ci tant qu’il n’est pas connecté à un réseau.',
  'device.deviceIdCopied': 'ID de l’appareil copié',
  'device.copyFailed': 'Impossible de copier dans le presse-papiers',
  'device.copyDeviceIdLabel': 'Copier l’ID de l’appareil dans le presse-papiers',
  'device.pairNewDeviceButton': 'Associer un nouvel appareil',
  'device.pairedDevicesTitle': 'Appareils associés',
  'device.syncAllLabel': 'Synchroniser avec tous les appareils associés',
  'device.syncAllButton': 'Tout synchroniser',
  'device.noPairedDevices':
    'Aucun appareil associé pour l’instant. Utilisez "Associer un nouvel appareil" pour en ajouter un.',
  'device.mdnsDisabledHint':
    'Détection automatique indisponible\u00A0: {{reason}}. Associez un nouvel appareil en scannant son code QR\u00A0; les appareils déjà associés pourraient encore se synchroniser.',
  'device.internetFacingBindHint':
    'La synchronisation écoute sur {{address}}, port UDP {{port}} — en dehors des plages de réseau privé, elle pourrait donc être accessible depuis l’extérieur de votre réseau local. C’est normal si votre routeur attribue des adresses publiques. Sur un VPS ou un autre hôte public, bloquez le trafic UDP entrant vers cet appareil ou désactivez la synchronisation. Le port change à chaque redémarrage.',
  'device.internetFacingBindAck': 'Compris',
  'device.internetFacingBindAckLabel':
    'Prendre acte de cette adresse de synchronisation\u00A0; l’avertissement réapparaîtra si l’adresse change',
  'device.internetRelayLabel': 'Réseau local, avec secours par Internet',
  'device.internetRelayDescription':
    'Désactivé sauf si vous l’activez. Lorsque vos appareils ne peuvent pas se joindre directement, par exemple derrière un VPN, ou qu’un appareil associé est hors de ce réseau, la synchronisation essaie un serveur de connexion sur Internet géré par n0, les créateurs de la bibliothèque réseau iroh. Vos notes restent chiffrées et il ne peut donc pas les lire, mais il voit lesquels de vos appareils communiquent et la quantité de données échangées. Activez cette option sur les deux appareils\u00A0; elle prend effet au prochain démarrage d’Agaric.',
  'device.internetRelayLoadFailed': 'Impossible de charger le paramètre de secours par Internet',
  'device.internetRelaySaveFailed': 'Impossible d’enregistrer le paramètre de secours par Internet',
  'device.noAddress': 'Aucune adresse',
  'device.editAddressLabel': 'Modifier l’adresse de {{name}}',
  'device.renameDeviceLabel': 'Renommer l’appareil {{name}}',
  'device.syncNowLabel': 'Synchroniser maintenant avec l’appareil {{name}}',
  'device.syncNowButton': 'Synchroniser maintenant',
  'device.cancelSyncLabel':
    'Annuler la synchronisation\u00A0: arrête toutes les synchronisations en cours sur cet appareil',
  'device.cancelSyncButton': 'Annuler la synchronisation',
  'device.cancelSyncFailed': 'Impossible d’annuler la synchronisation',
  'device.unpairDeviceLabel': 'Dissocier l’appareil {{name}}',
  'device.unpairButton': 'Dissocier',
  'device.loadingMessage': 'Chargement des informations de l’appareil...',
  'device.syncingMessage': 'Synchronisation avec l’appareil {{name}}...',
  'device.syncingAllMessage': 'Synchronisation avec tous les appareils associés...',
  'device.syncProgressOps': 'Synchronisation\u00A0: {{sent}} messages envoyés, {{received}} reçus',
  'device.syncProgressSending':
    'Envoi des pièces jointes\u00A0: {{filesDone}} fichiers sur {{filesTotal}}, {{bytesDone}} sur {{bytesTotal}}',
  'device.syncProgressReceiving':
    'Réception des pièces jointes\u00A0: {{filesDone}} fichiers sur {{filesTotal}}, {{bytesDone}} sur {{bytesTotal}}',
  'device.syncProgressBarLabel': 'Transfert de pièces jointes avec {{name}}',
  'device.syncErrorMessage': 'Erreur de synchronisation\u00A0: {{error}}',
  'device.retryButton': 'Réessayer',
  'device.dismissErrorLabel': 'Ignorer l’erreur',
  'device.loadFailed': 'Impossible de charger les informations de l’appareil',
  'device.unpairFailed': 'Impossible de dissocier l’appareil',
  'device.syncTimedOut':
    'La synchronisation a pris trop de temps — vérifiez votre connexion et réessayez',
  'device.syncFailedForList': 'Échec de la synchronisation pour\u00A0: {{devices}}',
  'device.renameFailed': 'Impossible de renommer',
  'device.lastSyncedAt': 'Dernière synchro\u00A0: {{time}}',
  'device.unpairedByPeerBadge': 'Association perdue',
  'device.unpairedByPeerDescription':
    'L’autre appareil s’est dissocié de celui-ci. Associez-les à nouveau pour reprendre la synchronisation.',
  'device.unpairedByPeerSince': 'Synchronisation arrêtée {{time}}',
  'device.resetCount_one': '{{count}} réinitialisation',
  'device.resetCount_other': '{{count}} réinitialisations',
  'qrScanner.viewportLabel': 'Zone de scan du code QR',
  'qrScanner.retryCameraButton': 'Réessayer la caméra',
  'qrScanner.scanningMessage': 'Scan en cours...',
  'qrScanner.cameraError':
    'Impossible d’accéder à la caméra. Vérifiez les autorisations de la caméra et réessayez.',
  'qrScanner.cameraUnavailable':
    'La caméra n’est pas disponible ici. Utilisez plutôt la phrase secrète de 4 mots pour l’association.',
  'qrScanner.cameraDenied':
    'Accès à la caméra refusé. Autorisez Agaric à accéder à la caméra dans les paramètres de votre appareil, puis réessayez.',
  'qrScanner.cameraNotFound': 'Aucune caméra n’a été trouvée sur cet appareil.',
  'device.syncComplete': 'Synchronisation terminée',
  'device.syncFailed': 'Échec de la synchronisation',
  'sync.failedForDevice': 'Échec de la synchronisation avec l’appareil {{deviceId}}...',
  'sync.changesApplied_one': '{{count}} modification synchronisée depuis l’appareil',
  'sync.changesApplied_other': '{{count}} modifications synchronisées depuis l’appareil',
  'sync.changesAppliedUnknownCount': 'Modifications synchronisées depuis l’appareil',
  'sync.failed': 'Échec de la synchronisation\u00A0: {{message}}',
  'sync.localTextKept':
    'Un autre appareil a supprimé ou déplacé “{{title}}”. Les blocs que vous y aviez ajoutés sur cet appareil et qui n’étaient pas encore synchronisés se trouvent dans la corbeille.',
  'sync.versionMismatchUpdatePeer':
    '{{peer}} utilise une version plus ancienne d’Agaric. Mettez à jour Agaric sur {{peer}}, puis relancez la synchronisation.',
  'sync.versionMismatchUpdatePeerUnnamed':
    'L’autre appareil utilise une version plus ancienne d’Agaric. Mettez à jour Agaric sur cet autre appareil, puis relancez la synchronisation.',
  'sync.versionMismatchUpdateThisDevice':
    '{{peer}} utilise une version plus récente d’Agaric. Mettez à jour Agaric sur cet appareil, puis relancez la synchronisation.',
  'sync.versionMismatchUpdateThisDeviceUnnamed':
    'L’autre appareil utilise une version plus récente d’Agaric. Mettez à jour Agaric sur cet appareil, puis relancez la synchronisation.',
  'sync.handshakeUnanswered':
    'La synchronisation avec {{peer}} n’a pas pu démarrer. Si le problème se répète, vérifiez que les deux appareils utilisent la même version d’Agaric.',
  'sync.handshakeUnansweredUnnamed':
    'La synchronisation n’a pas pu démarrer. Si le problème se répète, vérifiez que les deux appareils utilisent la même version d’Agaric.',
  'sync.waitingForPeer': 'En attente de {{peer}}, dernière synchronisation {{time}}',
  'sync.waitingForPeerNeverSynced': 'En attente de {{peer}}',
  'sync.ownHistoryFork':
    '{{peer}} contient des modifications faites par cet appareil et qu’il n’a plus, comme après la restauration d’une ancienne sauvegarde ici, si bien que les deux ne peuvent pas fusionner. Exportez les notes de cet appareil, configurez Agaric à neuf sur celui-ci, associez-le à nouveau, puis importez-les.',
  'sync.ownHistoryForkUnnamed':
    'L’autre appareil contient des modifications faites par cet appareil et qu’il n’a plus, comme après la restauration d’une ancienne sauvegarde ici, si bien que les deux ne peuvent pas fusionner. Exportez les notes de cet appareil, configurez Agaric à neuf sur celui-ci, associez-le à nouveau, puis importez-les.',
  'sync.retryAction': 'Relancer la synchronisation',
  'sync.backOnline': 'De nouveau en ligne. Synchronisation…',
  'sync.noPeersTitle': 'Aucun appareil associé',
  'sync.noPeersBody':
    'La synchronisation nécessite au moins un appareil associé. Associez-en un maintenant pour commencer à synchroniser.',
  'sync.noPeersCta': 'Associer un appareil',
  'sync.noPeersCancel': 'Annuler',
  'sync.quarantineTitle_one': '{{count}} modification synchronisée n’a pas pu être appliquée',
  'sync.quarantineTitle_other':
    '{{count}} modifications synchronisées n’ont pas pu être appliquées',
  'sync.quarantineBody':
    'Ces modifications proviennent d’un autre appareil, mais Agaric n’a pas pu les fusionner après plusieurs redémarrages et a cessé de réessayer. Elles sont conservées sur cet appareil\u00A0; leur contenu ne figure pas dans vos notes. "Réessayer" retente l’une d’elles au prochain démarrage d’Agaric.',
  'sync.quarantineListLabel': 'Modifications synchronisées qui n’ont pas pu être appliquées',
  'sync.quarantineRowMeta': 'Reçue pour la première fois {{when}} · {{size}}',
  'sync.quarantineLoadFailed':
    'Impossible de vérifier les modifications synchronisées qui n’ont pas pu être appliquées',
  'sync.quarantineRetry': 'Réessayer',
  'sync.quarantineRetryLabel': 'Réessayer la modification synchronisée de {{space}}',
  'sync.quarantineRetried': 'Nouvelle tentative au prochain démarrage d’Agaric',
  'sync.quarantineRestartNow': 'Redémarrer maintenant',
  'sync.quarantineRetryFailed': 'Impossible de réessayer la modification synchronisée',
  'device.deviceNameLabel': 'Nom de l’appareil',
  'pairing.inProgress': 'Association en cours...',
  'device.editAddressTitle': 'Adresse du pair',
  'device.editAddressPopoverLabel': 'Modifier l’adresse du pair',
  'device.addressInputLabel': 'Adresse (hôte:port)',
  'device.addressHint': 'Format\u00A0: hôte:port (par ex. 192.168.1.100:5000)',
  'device.addressFormatInvalid': 'Le format doit être hôte:port (par ex. 192.168.1.100:5000)',
  'device.addressPortInvalid': 'Le port doit être compris entre 1 et 65535',
  'device.saveAddressButton': 'Enregistrer',
  'device.cancelAddressButton': 'Annuler',
}
