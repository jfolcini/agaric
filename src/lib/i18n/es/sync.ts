/**
 * i18n namespace: sync — Spanish (`es`).
 *
 * Mirrors `src/lib/i18n/sync.ts` key for key, in the same order.
 */

export const sync: Record<string, string> = {
  'device.thisDevice': 'Este dispositivo',
  'device.unpairConfirmTitle': '¿Desemparejar el dispositivo?',
  'device.unpairConfirmDescription':
    'Se eliminará el emparejamiento. Tus notas y el historial de sincronización se conservan en este dispositivo. Puedes volver a emparejarlo más tarde para reanudar la sincronización.',
  'device.unpairConfirmAction': 'Sí, desemparejar',
  'device.pairedDevice': 'el dispositivo emparejado',
  'pairing.cancelFailed': 'No se ha podido cancelar el emparejamiento',
  'pairing.mutationTimedOut': 'el dispositivo ha dejado de responder',
  'pairing.startFailed': 'No se ha podido iniciar el emparejamiento: {{message}}',
  'pairing.pairFailed': 'El emparejamiento ha fallado: {{message}}',
  'pairing.unpairFailed': 'No se ha podido desemparejar el dispositivo: {{message}}',
  'pairing.awaitingPeerMessage': 'Esperando al otro dispositivo…',
  'pairing.waitingDescription':
    'Este dispositivo ha preparado su parte del protocolo de emparejamiento. Se confirmará automáticamente cuando se conecte el otro dispositivo.',
  'pairing.pairSuccessMessage': 'Dispositivo emparejado correctamente',
  'pairing.proofRejectedError':
    'La frase de contraseña no coincide. Revísala e inténtalo de nuevo.',
  'pairing.waitTimedOut':
    'No hay respuesta del otro dispositivo. O bien el código de emparejamiento ha caducado, o bien los dos dispositivos no se han podido encontrar en esta red — algunas redes wifi de invitados y corporativas bloquean la detección que necesita el emparejamiento. Si el código ha caducado, vuelve a abrir el emparejamiento en el otro dispositivo para obtener uno nuevo.',
  'pairing.osNetworkBlocked':
    'Este dispositivo ha pausado el acceso a la red de la aplicación. Mantén la pantalla encendida y esta aplicación abierta durante el emparejamiento.',
  'pairing.qrScannedMessage': 'Código QR escaneado — verifica y toca Emparejar',
  'pairing.closeDialogLabel': 'Cerrar el diálogo de emparejamiento',
  'pairing.dialogTitle': 'Emparejar dispositivo',
  'pairing.switchToJoinerLink': '¿Tienes un código del otro dispositivo?',
  'pairing.switchToHostLink': 'Mostrar mi código',
  'pairing.startingMessage': 'Iniciando el emparejamiento...',
  'pairing.qrCodeLabel': 'Código QR para emparejar dispositivos',
  'pairing.passphraseLabel': 'Frase de contraseña:',
  'pairing.scanOrEnterInstruction':
    'Escanea el código QR o introduce la frase de contraseña en el otro dispositivo.',
  'pairing.sessionExpiresIn': 'La sesión caduca en',
  'pairing.sessionExpired': 'La sesión ha caducado',
  'pairing.retryButton': 'Reintentar',
  'pairing.orSeparator': 'O',
  'pairing.typePassphraseButton': 'Escribir frase de contraseña',
  'pairing.scanQrCodeButton': 'Escanear código QR',
  'pairing.recommendedBadge': 'Recomendado',
  'pairing.entryModeLabel': 'Introduce el código',
  'pairing.wordLabel': 'Palabra {{num}} de la frase de contraseña',
  'pairing.entryFormWord': '{{ordinal}} palabra',
  'pairing.ordinal.first': '1.ª',
  'pairing.ordinal.second': '2.ª',
  'pairing.ordinal.third': '3.ª',
  'pairing.ordinal.fourth': '4.ª',
  'pairing.loadingScannerMessage': 'Cargando el escáner...',
  'pairing.cancelButton': 'Cancelar',
  'pairing.pairButton': 'Emparejar',
  'pairing.pairedDevicesTitle': 'Dispositivos emparejados',
  'pairing.confirmCloseTitle': '¿Cancelar el emparejamiento?',
  'pairing.confirmCloseDescription':
    'Hay un emparejamiento en curso. Si cierras este diálogo, se cancelará el proceso y el otro dispositivo tendrá que empezar de nuevo.',
  'pairing.confirmCloseAction': 'Cancelar emparejamiento',
  'pairing.confirmCloseKeep': 'Seguir emparejando',
  'pairing.srCountdownMinutes_one': 'La sesión caduca en {{count}} minuto',
  'pairing.srCountdownMinutes_other': 'La sesión caduca en {{count}} minutos',
  'pairing.srCountdownSeconds_one': 'La sesión caduca en {{count}} segundo',
  'pairing.srCountdownSeconds_other': 'La sesión caduca en {{count}} segundos',
  'pairing.copyPassphraseAriaLabel': 'Copiar la frase de contraseña',
  'pairing.passphraseCopied': 'Frase de contraseña copiada',
  'pairing.passphraseCopyFailed': 'No se ha podido copiar la frase de contraseña',
  'device.localDeviceIdLabel': 'ID del dispositivo local',
  'device.localAddressLabel': 'Dirección de este dispositivo',
  'device.localAddressDescription':
    'Introdúcela como dirección manual en el otro dispositivo cuando los dos no se encuentren.',
  'device.localAddressNoNetwork':
    'No hay red local. Los demás dispositivos no pueden conectar con este hasta que se una a una red.',
  'device.deviceIdCopied': 'ID del dispositivo copiado',
  'device.copyFailed': 'No se ha podido copiar al portapapeles',
  'device.copyDeviceIdLabel': 'Copiar el ID del dispositivo al portapapeles',
  'device.pairNewDeviceButton': 'Emparejar dispositivo nuevo',
  'device.pairedDevicesTitle': 'Dispositivos emparejados',
  'device.syncAllLabel': 'Sincronizar con todos los dispositivos emparejados',
  'device.syncAllButton': 'Sincronizar todo',
  'device.noPairedDevices':
    'Aún no hay dispositivos emparejados. Usa "Emparejar dispositivo nuevo" para añadir uno.',
  'device.mdnsDisabledHint':
    'La detección automática no está disponible: {{reason}}. Empareja un dispositivo nuevo escaneando su código QR; puede que los dispositivos que ya has emparejado sigan sincronizándose.',
  'device.internetFacingBindHint':
    'La sincronización escucha en {{address}}, puerto UDP {{port}} — fuera de los rangos de red privada, así que puede ser accesible desde fuera de tu red local. Es lo esperado si tu router asigna direcciones públicas. En un VPS u otro servidor público, bloquea el tráfico UDP entrante a este dispositivo o desactiva la sincronización. El puerto cambia cada vez que se reinicia.',
  'device.internetFacingBindAck': 'Entendido',
  'device.internetFacingBindAckLabel':
    'Confirmar esta dirección de sincronización; el aviso volverá si la dirección cambia',
  'device.internetRelayLabel': 'Red local, con alternativa por internet',
  'device.internetRelayDescription':
    'Desactivado salvo que lo actives. Cuando tus dispositivos no pueden conectarse directamente, por ejemplo detrás de una VPN, o un dispositivo emparejado está fuera de esta red, la sincronización intenta usar un servidor de conexión en internet gestionado por n0, los creadores de la biblioteca de red iroh. Tus notas siguen cifradas, así que no puede leerlas, pero ve qué dispositivos tuyos se comunican y cuántos datos se transfieren. Actívalo en ambos dispositivos; surte efecto la próxima vez que se inicie Agaric.',
  'device.internetRelayLoadFailed':
    'No se ha podido cargar la configuración de la alternativa por internet',
  'device.internetRelaySaveFailed':
    'No se ha podido guardar la configuración de la alternativa por internet',
  'device.noAddress': 'Sin dirección',
  'device.editAddressLabel': 'Editar la dirección de {{name}}',
  'device.renameDeviceLabel': 'Renombrar el dispositivo {{name}}',
  'device.syncNowLabel': 'Sincronizar ahora con el dispositivo {{name}}',
  'device.syncNowButton': 'Sincronizar ahora',
  'device.cancelSyncLabel':
    'Cancelar la sincronización: detiene todas las sincronizaciones en curso en este dispositivo',
  'device.cancelSyncButton': 'Cancelar sincronización',
  'device.cancelSyncFailed': 'No se ha podido cancelar la sincronización',
  'device.unpairDeviceLabel': 'Desemparejar el dispositivo {{name}}',
  'device.unpairButton': 'Desemparejar',
  'device.loadingMessage': 'Cargando la información del dispositivo...',
  'device.syncingMessage': 'Sincronizando con el dispositivo {{name}}...',
  'device.syncingAllMessage': 'Sincronizando con todos los dispositivos emparejados...',
  'device.syncProgressOps': 'Sincronizando: {{sent}} mensajes enviados, {{received}} recibidos',
  'device.syncProgressSending':
    'Enviando adjuntos: {{filesDone}} de {{filesTotal}} archivos, {{bytesDone}} de {{bytesTotal}}',
  'device.syncProgressReceiving':
    'Recibiendo adjuntos: {{filesDone}} de {{filesTotal}} archivos, {{bytesDone}} de {{bytesTotal}}',
  'device.syncProgressBarLabel': 'Transferencia de adjuntos con {{name}}',
  'device.syncErrorMessage': 'Error de sincronización: {{error}}',
  'device.retryButton': 'Reintentar',
  'device.dismissErrorLabel': 'Descartar el error',
  'device.loadFailed': 'No se ha podido cargar la información del dispositivo',
  'device.unpairFailed': 'No se ha podido desemparejar el dispositivo',
  'device.syncTimedOut':
    'La sincronización ha tardado demasiado — revisa tu conexión e inténtalo de nuevo',
  'device.syncFailedForList': 'La sincronización ha fallado con: {{devices}}',
  'device.renameFailed': 'No se ha podido renombrar',
  'device.lastSyncedAt': 'Última: {{time}}',
  'device.unpairedByPeerBadge': 'Emparejamiento perdido',
  'device.unpairedByPeerDescription':
    'El otro dispositivo se ha desemparejado de este. Vuelve a emparejarlos para reanudar la sincronización.',
  'device.unpairedByPeerSince': 'Dejó de sincronizarse {{time}}',
  'device.resetCount_one': '{{count}} restablecimiento',
  'device.resetCount_other': '{{count}} restablecimientos',
  'qrScanner.viewportLabel': 'Visor del escáner de códigos QR',
  'qrScanner.retryCameraButton': 'Reintentar con la cámara',
  'qrScanner.scanningMessage': 'Escaneando...',
  'qrScanner.cameraError':
    'No se ha podido acceder a la cámara. Revisa los permisos de la cámara e inténtalo de nuevo.',
  'qrScanner.cameraUnavailable':
    'La cámara no está disponible aquí. Usa la frase de contraseña de 4 palabras para emparejar.',
  'qrScanner.cameraDenied':
    'Se ha denegado el permiso de la cámara. Permite el acceso a la cámara para Agaric en la configuración del dispositivo y vuelve a intentarlo.',
  'qrScanner.cameraNotFound': 'No se ha encontrado ninguna cámara en este dispositivo.',
  'device.syncComplete': 'Sincronización completada',
  'device.syncFailed': 'La sincronización ha fallado',
  'sync.failedForDevice': 'La sincronización ha fallado con el dispositivo {{deviceId}}...',
  'sync.changesApplied_one': 'Se ha sincronizado {{count}} cambio desde el dispositivo',
  'sync.changesApplied_other': 'Se han sincronizado {{count}} cambios desde el dispositivo',
  'sync.changesAppliedUnknownCount': 'Se han sincronizado cambios desde el dispositivo',
  'sync.failed': 'La sincronización ha fallado: {{message}}',
  'sync.localTextKept':
    'Otro dispositivo ha eliminado o movido “{{title}}”. Los bloques que le añadiste en este dispositivo y que aún no se habían sincronizado están en la papelera.',
  'sync.versionMismatchUpdatePeer':
    '{{peer}} usa una versión anterior de Agaric. Actualiza Agaric en {{peer}} y vuelve a sincronizar.',
  'sync.versionMismatchUpdatePeerUnnamed':
    'El otro dispositivo usa una versión anterior de Agaric. Actualiza Agaric en él y vuelve a sincronizar.',
  'sync.versionMismatchUpdateThisDevice':
    '{{peer}} usa una versión más reciente de Agaric. Actualiza Agaric en este dispositivo y vuelve a sincronizar.',
  'sync.versionMismatchUpdateThisDeviceUnnamed':
    'El otro dispositivo usa una versión más reciente de Agaric. Actualiza Agaric en este dispositivo y vuelve a sincronizar.',
  'sync.handshakeUnanswered':
    'No se ha podido iniciar la sincronización con {{peer}}. Si se repite, comprueba que ambos dispositivos usan la misma versión de Agaric.',
  'sync.handshakeUnansweredUnnamed':
    'No se ha podido iniciar la sincronización. Si se repite, comprueba que ambos dispositivos usan la misma versión de Agaric.',
  'sync.waitingForPeer': 'Esperando a {{peer}}, última sincronización {{time}}',
  'sync.waitingForPeerNeverSynced': 'Esperando a {{peer}}',
  'sync.ownHistoryFork':
    '{{peer}} tiene cambios que hizo este dispositivo y que ya no tiene, como ocurre tras restaurar aquí una copia de seguridad antigua, así que no se pueden fusionar. Exporta las notas de este dispositivo, vuelve a configurar Agaric desde cero en él, emparéjalo de nuevo y luego impórtalas.',
  'sync.ownHistoryForkUnnamed':
    'El otro dispositivo tiene cambios que hizo este dispositivo y que ya no tiene, como ocurre tras restaurar aquí una copia de seguridad antigua, así que no se pueden fusionar. Exporta las notas de este dispositivo, vuelve a configurar Agaric desde cero en él, emparéjalo de nuevo y luego impórtalas.',
  'sync.retryAction': 'Reintentar la sincronización',
  'sync.backOnline': 'De nuevo en línea. Sincronizando…',
  'sync.noPeersTitle': 'No hay dispositivos emparejados',
  'sync.noPeersBody':
    'La sincronización necesita al menos un dispositivo emparejado. Empareja uno ahora para empezar a sincronizar.',
  'sync.noPeersCta': 'Emparejar un dispositivo',
  'sync.noPeersCancel': 'Cancelar',
  'sync.quarantineTitle_one': 'No se ha podido aplicar {{count}} cambio de sincronización',
  'sync.quarantineTitle_other': 'No se han podido aplicar {{count}} cambios de sincronización',
  'sync.quarantineBody':
    'Estos cambios llegaron desde otro dispositivo, pero Agaric no ha podido fusionarlos tras varios reinicios y ha dejado de reintentarlo. Se conservan en este dispositivo; su contenido no está en tus notas. Reintentar vuelve a probar uno la próxima vez que se inicie Agaric.',
  'sync.quarantineListLabel': 'Cambios de sincronización que no se han podido aplicar',
  'sync.quarantineRowMeta': 'Detectado por primera vez {{when}} · {{size}}',
  'sync.quarantineLoadFailed':
    'No se ha podido comprobar si hay cambios de sincronización que no se aplicaron',
  'sync.quarantineRetry': 'Reintentar',
  'sync.quarantineRetryLabel': 'Reintentar el cambio de sincronización de {{space}}',
  'sync.quarantineRetried': 'Se volverá a intentar la próxima vez que se inicie Agaric',
  'sync.quarantineRestartNow': 'Reiniciar ahora',
  'sync.quarantineRetryFailed': 'No se ha podido reintentar el cambio de sincronización',
  'device.deviceNameLabel': 'Nombre del dispositivo',
  'pairing.inProgress': 'Emparejamiento en curso...',
  'device.editAddressTitle': 'Dirección del dispositivo',
  'device.editAddressPopoverLabel': 'Editar la dirección del dispositivo',
  'device.addressInputLabel': 'Dirección (host:port)',
  'device.addressHint': 'Formato: host:port (p. ej., 192.168.1.100:5000)',
  'device.addressFormatInvalid': 'El formato debe ser host:port (p. ej., 192.168.1.100:5000)',
  'device.addressPortInvalid': 'El puerto debe estar entre 1 y 65535',
  'device.saveAddressButton': 'Guardar',
  'device.cancelAddressButton': 'Cancelar',
}
