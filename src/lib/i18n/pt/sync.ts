/**
 * i18n namespace: sync — Portuguese (`pt`).
 *
 * Mirrors `src/lib/i18n/sync.ts` key for key, in the same order.
 */

export const sync: Record<string, string> = {
  'device.thisDevice': 'Este dispositivo',
  'device.unpairConfirmTitle': 'Desparear dispositivo?',
  'device.unpairConfirmDescription':
    'Isso remove o pareamento. Suas notas e o histórico de sincronização permanecem neste dispositivo. Você pode parear novamente depois para retomar a sincronização.',
  'device.unpairConfirmAction': 'Sim, desparear',
  'device.pairedDevice': 'o dispositivo pareado',
  'pairing.cancelFailed': 'Não foi possível cancelar o pareamento',
  'pairing.mutationTimedOut': 'o dispositivo parou de responder',
  'pairing.startFailed': 'Não foi possível iniciar o pareamento: {{message}}',
  'pairing.pairFailed': 'Falha no pareamento: {{message}}',
  'pairing.unpairFailed': 'Não foi possível desparear o dispositivo: {{message}}',
  'pairing.awaitingPeerMessage': 'Aguardando o outro dispositivo…',
  'pairing.waitingDescription':
    'Este dispositivo já preparou a sua parte do pareamento. A confirmação será automática assim que o outro dispositivo se conectar.',
  'pairing.pairSuccessMessage': 'Dispositivo pareado com sucesso',
  'pairing.proofRejectedError': 'A frase secreta não confere. Verifique-a e tente novamente.',
  'pairing.waitTimedOut':
    'Nenhuma resposta do outro dispositivo. Ou o código de pareamento expirou, ou os dois dispositivos não conseguiram se encontrar nesta rede — algumas redes Wi-Fi de visitantes e corporativas bloqueiam a descoberta de que o pareamento precisa. Se o código expirou, reabra o pareamento no outro dispositivo para obter um novo.',
  'pairing.osNetworkBlocked':
    'Este dispositivo pausou o acesso do aplicativo à rede. Mantenha a tela ligada e este aplicativo aberto durante o pareamento.',
  'pairing.qrScannedMessage': 'Código QR escaneado — verifique e toque em Parear',
  'pairing.closeDialogLabel': 'Fechar a caixa de diálogo de pareamento',
  'pairing.dialogTitle': 'Parear dispositivo',
  'pairing.switchToJoinerLink': 'Tem um código do outro dispositivo?',
  'pairing.switchToHostLink': 'Mostrar meu código',
  'pairing.startingMessage': 'Iniciando pareamento...',
  'pairing.qrCodeLabel': 'Código QR para pareamento de dispositivo',
  'pairing.passphraseLabel': 'Frase secreta:',
  'pairing.scanOrEnterInstruction':
    'Escaneie o código QR ou digite a frase secreta no outro dispositivo.',
  'pairing.sessionExpiresIn': 'A sessão expira em',
  'pairing.sessionExpired': 'Sessão expirada',
  'pairing.retryButton': 'Tentar novamente',
  'pairing.orSeparator': 'OU',
  'pairing.typePassphraseButton': 'Digitar frase secreta',
  'pairing.scanQrCodeButton': 'Escanear código QR',
  'pairing.recommendedBadge': 'Recomendado',
  'pairing.entryModeLabel': 'Digite o código',
  'pairing.wordLabel': 'Palavra {{num}} da frase secreta',
  'pairing.entryFormWord': '{{ordinal}} palavra',
  'pairing.ordinal.first': '1ª',
  'pairing.ordinal.second': '2ª',
  'pairing.ordinal.third': '3ª',
  'pairing.ordinal.fourth': '4ª',
  'pairing.loadingScannerMessage': 'Carregando leitor...',
  'pairing.cancelButton': 'Cancelar',
  'pairing.pairButton': 'Parear',
  'pairing.pairedDevicesTitle': 'Dispositivos pareados',
  'pairing.confirmCloseTitle': 'Cancelar pareamento?',
  'pairing.confirmCloseDescription':
    'O pareamento está em andamento. Fechar esta caixa de diálogo cancelará o processo, e o outro dispositivo precisará começar de novo.',
  'pairing.confirmCloseAction': 'Cancelar pareamento',
  'pairing.confirmCloseKeep': 'Continuar pareando',
  'pairing.srCountdownMinutes_one': 'A sessão expira em {{count}} minuto',
  'pairing.srCountdownMinutes_other': 'A sessão expira em {{count}} minutos',
  'pairing.srCountdownSeconds_one': 'A sessão expira em {{count}} segundo',
  'pairing.srCountdownSeconds_other': 'A sessão expira em {{count}} segundos',
  'pairing.copyPassphraseAriaLabel': 'Copiar frase secreta',
  'pairing.passphraseCopied': 'Frase secreta copiada',
  'pairing.passphraseCopyFailed': 'Não foi possível copiar a frase secreta',
  'device.localDeviceIdLabel': 'ID do dispositivo local',
  'device.localAddressLabel': 'Endereço deste dispositivo',
  'device.localAddressDescription':
    'Digite-o como endereço manual no outro dispositivo quando os dois não se encontrarem.',
  'device.localAddressNoNetwork':
    'Sem rede local. Outros dispositivos não conseguem alcançar este até que ele se conecte a uma rede.',
  'device.deviceIdCopied': 'ID do dispositivo copiado',
  'device.copyFailed': 'Não foi possível copiar para a área de transferência',
  'device.copyDeviceIdLabel': 'Copiar ID do dispositivo para a área de transferência',
  'device.pairNewDeviceButton': 'Parear novo dispositivo',
  'device.pairedDevicesTitle': 'Dispositivos pareados',
  'device.syncAllLabel': 'Sincronizar com todos os dispositivos pareados',
  'device.syncAllButton': 'Sincronizar tudo',
  'device.noPairedDevices':
    'Nenhum dispositivo pareado ainda. Use "Parear novo dispositivo" para adicionar um.',
  'device.mdnsDisabledHint':
    'Descoberta automática indisponível: {{reason}}. Pareie um novo dispositivo escaneando o código QR dele; os dispositivos já pareados talvez continuem sincronizando.',
  'device.internetFacingBindHint':
    'A sincronização está escutando em {{address}}, porta UDP {{port}} — fora das faixas de rede privada, então pode estar acessível de fora da sua rede local. Isso é esperado se o seu roteador distribui endereços públicos. Em uma VPS ou outro host público, bloqueie o UDP de entrada para este dispositivo ou desative a sincronização. A porta muda a cada reinicialização.',
  'device.internetFacingBindAck': 'Entendi',
  'device.internetFacingBindAckLabel':
    'Confirmar este endereço de sincronização; o aviso volta se o endereço mudar',
  'device.internetRelayLabel': 'Rede local, com alternativa pela internet',
  'device.internetRelayDescription':
    'Desativado, a menos que você o ative. Quando seus dispositivos não conseguem se alcançar diretamente, como atrás de uma VPN, ou quando um dispositivo pareado está fora desta rede, a sincronização tenta um servidor de conexão na internet mantido pela n0, os criadores da biblioteca de rede iroh. Suas notas continuam criptografadas, então ele não consegue lê-las, mas vê quais dos seus dispositivos estão se comunicando e quantos dados trafegam. Ative isso nos dois dispositivos; a mudança vale a partir da próxima vez que o Agaric for iniciado.',
  'device.internetRelayLoadFailed':
    'Não foi possível carregar a configuração de alternativa pela internet',
  'device.internetRelaySaveFailed':
    'Não foi possível salvar a configuração de alternativa pela internet',
  'device.noAddress': 'Sem endereço',
  'device.editAddressLabel': 'Editar endereço de {{name}}',
  'device.renameDeviceLabel': 'Renomear dispositivo {{name}}',
  'device.syncNowLabel': 'Sincronizar agora com o dispositivo {{name}}',
  'device.syncNowButton': 'Sincronizar agora',
  'device.cancelSyncLabel':
    'Cancelar sincronização: interrompe todas as sincronizações em andamento neste dispositivo',
  'device.cancelSyncButton': 'Cancelar sincronização',
  'device.cancelSyncFailed': 'Não foi possível cancelar a sincronização',
  'device.unpairDeviceLabel': 'Desparear dispositivo {{name}}',
  'device.unpairButton': 'Desparear',
  'device.loadingMessage': 'Carregando informações do dispositivo...',
  'device.syncingMessage': 'Sincronizando com o dispositivo {{name}}...',
  'device.syncingAllMessage': 'Sincronizando com todos os dispositivos pareados...',
  'device.syncProgressOps': 'Sincronizando: {{sent}} mensagens enviadas, {{received}} recebidas',
  'device.syncProgressSending':
    'Enviando anexos: {{filesDone}} de {{filesTotal}} arquivos, {{bytesDone}} de {{bytesTotal}}',
  'device.syncProgressReceiving':
    'Recebendo anexos: {{filesDone}} de {{filesTotal}} arquivos, {{bytesDone}} de {{bytesTotal}}',
  'device.syncProgressBarLabel': 'Transferência de anexos com {{name}}',
  'device.syncErrorMessage': 'Erro de sincronização: {{error}}',
  'device.retryButton': 'Tentar novamente',
  'device.dismissErrorLabel': 'Dispensar erro',
  'device.loadFailed': 'Não foi possível carregar as informações do dispositivo',
  'device.unpairFailed': 'Não foi possível desparear o dispositivo',
  'device.syncTimedOut': 'A sincronização demorou demais — verifique sua conexão e tente novamente',
  'device.syncFailedForList': 'Falha na sincronização com: {{devices}}',
  'device.renameFailed': 'Não foi possível renomear',
  'device.lastSyncedAt': 'Última: {{time}}',
  'device.unpairedByPeerBadge': 'Pareamento perdido',
  'device.unpairedByPeerDescription':
    'O outro dispositivo desfez o pareamento com este. Pareie novamente para retomar a sincronização.',
  'device.unpairedByPeerSince': 'Parou de sincronizar {{time}}',
  'device.resetCount_one': '{{count}} redefinição',
  'device.resetCount_other': '{{count}} redefinições',
  'qrScanner.viewportLabel': 'Área de visualização do leitor de código QR',
  'qrScanner.retryCameraButton': 'Tentar a câmera novamente',
  'qrScanner.scanningMessage': 'Escaneando...',
  'qrScanner.cameraError':
    'Não foi possível acessar a câmera. Verifique as permissões da câmera e tente novamente.',
  'qrScanner.cameraUnavailable':
    'A câmera não está disponível aqui. Use a frase secreta de 4 palavras para parear.',
  'qrScanner.cameraDenied':
    'Permissão da câmera negada. Ative o acesso à câmera para o Agaric nas configurações do dispositivo e tente novamente.',
  'qrScanner.cameraNotFound': 'Nenhuma câmera foi encontrada neste dispositivo.',
  'device.syncComplete': 'Sincronização concluída',
  'device.syncFailed': 'Falha na sincronização',
  'sync.failedForDevice': 'Falha na sincronização com {{name}}',
  'sync.failed': 'Falha na sincronização: {{message}}',
  'sync.localTextKept_one':
    'Outro dispositivo excluiu ou moveu “{{title}}”. Os blocos que você adicionou sob ele aqui e que ainda não tinham sido sincronizados estão na Lixeira.',
  'sync.localTextKept_other':
    'Outro dispositivo excluiu ou moveu {{count}} páginas. Os blocos que você adicionou sob elas aqui e que ainda não tinham sido sincronizados estão na Lixeira.',
  'sync.versionMismatchUpdatePeer':
    '{{peer}} usa uma versão mais antiga do Agaric. Atualize o Agaric em {{peer}} e sincronize novamente.',
  'sync.versionMismatchUpdatePeerUnnamed':
    'O outro dispositivo usa uma versão mais antiga do Agaric. Atualize o Agaric nele e sincronize novamente.',
  'sync.versionMismatchUpdateThisDevice':
    '{{peer}} usa uma versão mais recente do Agaric. Atualize o Agaric neste dispositivo e sincronize novamente.',
  'sync.versionMismatchUpdateThisDeviceUnnamed':
    'O outro dispositivo usa uma versão mais recente do Agaric. Atualize o Agaric neste dispositivo e sincronize novamente.',
  'sync.handshakeUnanswered':
    'Não foi possível iniciar a sincronização com {{peer}}. Se isso se repetir, verifique se os dois dispositivos usam a mesma versão do Agaric.',
  'sync.handshakeUnansweredUnnamed':
    'Não foi possível iniciar a sincronização. Se isso se repetir, verifique se os dois dispositivos usam a mesma versão do Agaric.',
  'sync.waitingForPeer': 'Aguardando {{peer}}, última sincronização {{time}}',
  'sync.waitingForPeerNeverSynced': 'Aguardando {{peer}}',
  'sync.ownHistoryFork':
    '{{peer}} contém alterações que este dispositivo fez e não tem mais, como após restaurar um backup mais antigo aqui, então os dois não podem ser mesclados. Exporte as notas deste dispositivo, configure o Agaric do zero nele, pareie-o novamente e depois importe as notas.',
  'sync.ownHistoryForkUnnamed':
    'O outro dispositivo contém alterações que este dispositivo fez e não tem mais, como após restaurar um backup mais antigo aqui, então os dois não podem ser mesclados. Exporte as notas deste dispositivo, configure o Agaric do zero nele, pareie-o novamente e depois importe as notas.',
  'sync.peerHistoryFork':
    'Este dispositivo contém alterações que {{peer}} fez e não tem mais, como após restaurar um backup mais antigo em {{peer}}, então os dois não podem ser mesclados. Exporte as notas de {{peer}}, configure o Agaric do zero nele, pareie-o novamente e depois importe as notas.',
  'sync.peerHistoryForkUnnamed':
    'Este dispositivo contém alterações que o outro dispositivo fez e não tem mais, como após restaurar nele um backup mais antigo, então os dois não podem ser mesclados. Exporte as notas do outro dispositivo, configure o Agaric do zero nele, pareie-o novamente e depois importe as notas.',
  'sync.retryAction': 'Tentar sincronizar novamente',
  'sync.noPeersTitle': 'Nenhum dispositivo pareado',
  'sync.noPeersBody':
    'A sincronização precisa de pelo menos um dispositivo pareado. Pareie um agora para começar a sincronizar.',
  'sync.noPeersCta': 'Parear um dispositivo',
  'sync.noPeersCancel': 'Cancelar',
  'sync.quarantineTitle_one': '{{count}} alteração de sincronização não pôde ser aplicada',
  'sync.quarantineTitle_other': '{{count}} alterações de sincronização não puderam ser aplicadas',
  'sync.quarantineBody':
    'Essas alterações chegaram de outro dispositivo, mas o Agaric não conseguiu mesclá-las após várias reinicializações e parou de tentar. Elas ficam guardadas neste dispositivo; o conteúdo delas não está nas suas notas. O botão Tentar novamente tenta aplicar uma delas de novo na próxima vez que o Agaric for iniciado.',
  'sync.quarantineListLabel': 'Alterações de sincronização que não puderam ser aplicadas',
  'sync.quarantineRowMeta': 'Vista pela primeira vez {{when}} · {{size}}',
  'sync.quarantineLoadFailed':
    'Não foi possível verificar se há alterações de sincronização que não foram aplicadas',
  'sync.quarantineRetry': 'Tentar novamente',
  'sync.quarantineRetryLabel': 'Tentar novamente a alteração de sincronização de {{space}}',
  'sync.quarantineRetried':
    'Uma nova tentativa será feita na próxima vez que o Agaric for iniciado',
  'sync.quarantineRestartNow': 'Reiniciar agora',
  'sync.quarantineRetryFailed': 'Não foi possível tentar novamente a alteração de sincronização',
  'device.deviceNameLabel': 'Nome do dispositivo',
  'pairing.inProgress': 'Pareamento em andamento...',
  'device.editAddressTitle': 'Endereço do par',
  'device.editAddressPopoverLabel': 'Editar endereço do par',
  'device.addressInputLabel': 'Endereço (host:port)',
  'device.addressHint': 'Formato: host:port (ex.: 192.168.1.100:5000)',
  'device.addressFormatInvalid': 'O formato deve ser host:port (ex.: 192.168.1.100:5000)',
  'device.addressPortInvalid': 'A porta deve estar entre 1 e 65535',
  'device.saveAddressButton': 'Salvar',
  'device.cancelAddressButton': 'Cancelar',
}
